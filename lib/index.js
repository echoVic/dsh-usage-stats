/**
 * Conversation usage statistics — Host half.
 *
 * The panel needs numbers across EVERY conversation, live or persisted, with
 * date-range filtering and per-turn detail, so the fold cannot ride any single
 * Session's projection. This half enumerates the logical session corpus through
 * `ctx.sessionQuery`, folds each durable log with `lib/aggregate.js`, caches the
 * raw per-session analysis, and serves one authenticated route inside the
 * `connection` service's browser fence:
 *
 *     GET /api/usage-stats.summary?range=all|30d|7d|1d&inherited=1&offset=<min>&force=1
 *
 * Reads are cached and single-flighted. A persisted session is re-read only
 * when its `sessionPersistence` revision changes, so filtering by date range or
 * toggling the inherited-prefix mode never re-reads the corpus; only the
 * in-memory report assembly repeats.
 *
 * Deliberately import-free apart from the local fold module (no
 * `@deepseek-ai/*` specifier resolves from a linked package outside the
 * profile). Every optional service is looked up defensively, and the handler
 * never throws: a broken read becomes a per-session error row, so one corrupt
 * log cannot blank the whole panel.
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { analyzeSession, summarize } from './aggregate.js';
import { resolvePricing } from './pricing.js';

/** Exact route the browser half calls; the browser-relative form drops the leading slash. */
export const ROUTE = '/api/usage-stats.summary';

/** Payload contract revision (v5 adds Search/Fetch service usage and billing). */
const PAYLOAD_VERSION = 5;

/** Range labels accepted by the route, mapped to their window in days (`null` = all time). */
export const RANGE_DAYS = Object.freeze({ all: null, '30d': 30, '7d': 7, '1d': 1 });

const DAY_MS = 86400000;
const HOUR_MS = 3600000;

/** How long one completed corpus scan is served without re-reading session logs. */
const CACHE_TTL_MS = (() => {
  const raw = Number(process.env.DSH_USAGE_STATS_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : 15000;
})();

/** How many session logs are read at once. */
const READ_CONCURRENCY = 4;

/** Bound the per-session aggregate cache so a long-lived Host cannot grow without limit. */
const SESSION_CACHE_LIMIT = 512;

/** Trend bucket shape for one requested range. */
const TREND_SHAPES = Object.freeze({
  all: { unit: 'day', count: 14 },
  '30d': { unit: 'day', count: 30 },
  '7d': { unit: 'day', count: 7 },
  '1d': { unit: 'hour', count: 24 },
});

/**
 * Look up one optional Host service without letting a missing service throw.
 * @param ctx - Host plugin context.
 * @param name - service key.
 * @returns the service, or undefined.
 */
function optional(ctx, name) {
  try {
    return ctx !== null && ctx !== undefined && typeof ctx.get === 'function' ? ctx.get(name) : undefined;
  } catch {
    return undefined;
  }
}

/**
 * A readable failure message from an arbitrary thrown value.
 * @param error - thrown value.
 * @returns one line.
 */
function describeError(error) {
  if (error !== null && error !== undefined && typeof error === 'object' && typeof error.message === 'string' && error.message.length > 0) {
    return error.message;
  }
  return String(error);
}

/**
 * Run `operation` over every item with a fixed number of parallel workers.
 * @param items - input list.
 * @param limit - maximum concurrent operations.
 * @param operation - async worker.
 * @returns results in input order.
 */
async function mapLimit(items, limit, operation) {
  const results = new Array(items.length);
  let next = 0;
  const workers = new Array(Math.min(limit, items.length)).fill(null).map(async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      results[index] = await operation(items[index], index);
    }
  });
  await Promise.all(workers);
  return results;
}

/**
 * Create one cache/single-flight holder for a scan. Owned by `apply`, so a
 * plugin reload starts from a clean cache.
 * @returns the scan state used by the route handler.
 */
export function createState() {
  return {
    cache: null,
    inflight: null,
    sessions: new Map(),
  };
}

/**
 * Remember one analyzed session, evicting the oldest entry when the cache is full.
 * @param state - scan state.
 * @param id - session id.
 * @param entry - cached row keyed by persistence revision.
 */
function rememberSession(state, id, entry) {
  state.sessions.set(id, entry);
  while (state.sessions.size > SESSION_CACHE_LIMIT) {
    const oldest = state.sessions.keys().next();
    if (oldest.done === true) break;
    state.sessions.delete(oldest.value);
  }
}

/**
 * Fold the complete logical session corpus into raw per-session analyses.
 * Range and inherited-prefix choices are presentation concerns and are NOT
 * applied here, so the cache survives those switches.
 *
 * @param ctx - Host plugin context carrying optional services.
 * @param state - scan state (aggregate caches live here).
 * @returns `{ rows, startedAt, scanMs, scope, errors }`.
 */
async function scan(ctx, state) {
  const startedAt = Date.now();
  const sessionQuery = optional(ctx, 'sessionQuery');
  if (sessionQuery === undefined || sessionQuery === null || typeof sessionQuery.listSessions !== 'function') {
    throw new Error('the session query service is unavailable in this composition');
  }

  const records = await sessionQuery.listSessions();
  const sessionsService = optional(ctx, 'sessions');
  const persistence = optional(ctx, 'sessionPersistence');

  // Persisted revisions let a repeat scan skip logs that did not change. Live
  // sessions always fold from memory: their persisted revision may trail the
  // in-memory log.
  const revisions = new Map();
  if (persistence !== undefined && persistence !== null && typeof persistence.list === 'function') {
    try {
      const snapshots = await persistence.list();
      for (const snapshot of Array.isArray(snapshots) ? snapshots : []) {
        const id = snapshot !== null && typeof snapshot === 'object' && snapshot.header !== undefined && snapshot.header !== null
          ? snapshot.header.id
          : undefined;
        if (typeof id === 'string') revisions.set(id, String(snapshot.revision));
      }
    } catch {
      // No revision cache is a performance loss, not a correctness problem.
      revisions.clear();
    }
  }

  const errors = [];
  const analyzed = await mapLimit(records, READ_CONCURRENCY, async (record) => {
    const header = record !== null && typeof record === 'object' && record.header !== null && typeof record.header === 'object'
      ? record.header
      : {};
    const id = typeof header.id === 'string' ? header.id : '';
    if (id.length === 0) {
      errors.push({ sessionId: null, message: 'a session record carried no id' });
      return null;
    }
    const live = record.live === true;
    const revision = revisions.get(id);

    const cached = state.sessions.get(id);
    if (!live && cached !== undefined && revision !== undefined && cached.revision === revision) {
      return cached.row;
    }

    try {
      let sessionHeader = header;
      let events;
      let inheritedEventCount = 0;
      const liveSession = live && sessionsService !== undefined && sessionsService !== null && typeof sessionsService.get === 'function'
        ? sessionsService.get(id)
        : undefined;
      if (liveSession !== undefined && liveSession !== null && typeof liveSession.snapshotEvents === 'function') {
        sessionHeader = liveSession.header;
        events = liveSession.snapshotEvents();
        if (typeof liveSession.inheritedEventCount === 'number') inheritedEventCount = liveSession.inheritedEventCount;
      } else {
        const log = await sessionQuery.readSession(id);
        sessionHeader = log !== null && typeof log === 'object' && log.session !== undefined && log.session !== null ? log.session : header;
        events = log !== null && typeof log === 'object' ? log.events : undefined;
        if (log !== null && typeof log === 'object' && typeof log.inheritedEventCount === 'number') inheritedEventCount = log.inheritedEventCount;
      }
      const row = analyzeSession(sessionHeader, events, { live, inheritedEventCount });
      if (!live && revision !== undefined) rememberSession(state, id, { revision, row });
      return row;
    } catch (error) {
      errors.push({ sessionId: id, message: describeError(error) });
      return null;
    }
  });

  const rows = analyzed.filter((row) => row !== null);
  return {
    rows,
    startedAt,
    scanMs: Date.now() - startedAt,
    scope: {
      listed: Array.isArray(records) ? records.length : 0,
      analyzed: rows.length,
      failed: errors.length,
      live: rows.filter((row) => row.live === true).length,
      subagents: rows.filter((row) => row.origin === 'subagent').length,
    },
    errors,
  };
}

/**
 * Serve the corpus from cache, a shared in-flight scan, or a fresh scan.
 * @param ctx - Host plugin context.
 * @param state - scan state.
 * @param force - bypass the TTL cache.
 * @returns `{ corpus, cached, cacheAgeMs }`.
 */
async function readCorpus(ctx, state, force) {
  const now = Date.now();
  if (!force && state.cache !== null && now - state.cache.at < CACHE_TTL_MS) {
    return { corpus: state.cache.corpus, cached: true, cacheAgeMs: now - state.cache.at };
  }
  if (state.inflight !== null) {
    return { corpus: await state.inflight, cached: false, cacheAgeMs: 0 };
  }
  const inflight = scan(ctx, state)
    .then((corpus) => {
      state.cache = { at: Date.now(), corpus };
      return corpus;
    })
    .finally(() => {
      state.inflight = null;
    });
  state.inflight = inflight;
  return { corpus: await inflight, cached: false, cacheAgeMs: 0 };
}

/**
 * Normalize the report request's query parameters.
 * @param url - request URL.
 * @param now - request time.
 * @returns summarize() options plus the echoable range label.
 */
function reportOptions(url, now) {
  const rawRange = String(url.searchParams.get('range') ?? 'all').toLowerCase();
  const range = Object.hasOwn(RANGE_DAYS, rawRange) ? rawRange : 'all';
  const days = RANGE_DAYS[range];
  const inheritedRaw = String(url.searchParams.get('inherited') ?? '').toLowerCase();
  const offsetRaw = Number(url.searchParams.get('offset'));
  const offsetMinutes = Number.isFinite(offsetRaw) ? Math.max(-840, Math.min(840, Math.trunc(offsetRaw))) : 0;
  const trend = TREND_SHAPES[range];
  return {
    now,
    range,
    from: days === null ? -Infinity : now - days * DAY_MS,
    to: Infinity,
    includeInherited: ['1', 'true', 'yes'].includes(inheritedRaw),
    offsetMinutes,
    trendUnit: trend.unit,
    trendCount: trend.count,
  };
}

/**
 * Assemble the full panel payload from one corpus and one request's options.
 * @param corpus - scan() result.
 * @param options - reportOptions() result.
 * @param served - cache metadata `{ cached, cacheAgeMs }`.
 * @returns the response body.
 */
async function reportBody(corpus, options, served) {
  const pricing = await loadPricing(served.force === true);
  const report = summarize(corpus.rows, { ...options, pricing });
  return {
    ok: true,
    version: PAYLOAD_VERSION,
    cached: served.cached,
    cacheAgeMs: served.cacheAgeMs,
    ttlMs: CACHE_TTL_MS,
    generatedAt: corpus.startedAt,
    scanMs: corpus.scanMs,
    range: report.range,
    includeInherited: report.includeInherited,
    offsetMinutes: report.offsetMinutes,
    scope: corpus.scope,
    pricing: {
      configured: pricing.configured,
      currency: pricing.currency,
      budgetMonthly: pricing.budgetMonthly,
      source: pricing.source,
      services: pricing.services,
      peakWindows: pricing.peakWindows,
      weekdays: pricing.weekdays,
      warnings: pricing.warnings,
      error: pricing.error,
    },
    costing: report.costing,
    totals: report.totals,
    sessions: report.sessions,
    trend: report.trend,
    tools: report.tools,
    models: report.models,
    services: report.services,
    turnEnds: report.turnEnds,
    errors: corpus.errors,
    partial: corpus.errors.length > 0,
  };
}

/**
 * Build the route handler. Exported so the test suite can drive it against a
 * fake Host context without a running Loader.
 *
 * @param ctx - Host plugin context.
 * @param state - scan state, shared across requests.
 * @returns the Fetch handler for the summary route.
 */
export function createHandler(ctx, state) {
  return async function handleSummary(request) {
    try {
      if (request === null || request === undefined || request.method !== 'GET') {
        return Response.json({ ok: false, error: 'only GET is supported' }, { status: 405 });
      }
      const url = new URL(request.url);
      const force = ['1', 'true', 'yes'].includes(String(url.searchParams.get('force') ?? '').toLowerCase());
      const { corpus, cached, cacheAgeMs } = await readCorpus(ctx, state, force);
      const body = await reportBody(corpus, reportOptions(url, Date.now()), { cached, cacheAgeMs, force });
      return Response.json(body);
    } catch (error) {
      return Response.json({ ok: false, error: describeError(error) }, { status: 503 });
    }
  };
}

// ─── price resolution ───────────────────────────────────────────────────────

/** Directory this Host module lives in (the package root is its parent). */
const PLUGIN_DIR = dirname(fileURLToPath(import.meta.url));

/** Bundled snapshot of the official pricing page, used when the live page is unreachable. */
const BUNDLED_PRICES = join(PLUGIN_DIR, '..', 'official-prices.json');

/** Price paths live beside the profile's session data: `$DSH_HOME/usage-stats/`. */
function pricePaths() {
  const home = typeof process.env.DSH_HOME === 'string' && process.env.DSH_HOME.length > 0
    ? process.env.DSH_HOME
    : join(homedir(), '.dsh');
  const directory = join(home, 'usage-stats');
  const userOverride = typeof process.env.DSH_USAGE_STATS_PRICES === 'string' ? process.env.DSH_USAGE_STATS_PRICES.trim() : '';
  return {
    userFile: userOverride.length > 0 ? userOverride : join(directory, 'prices.json'),
    cacheFile: join(directory, 'prices.cache.json'),
    bundledFile: BUNDLED_PRICES,
  };
}

/**
 * Resolve the price table for one report.
 *
 * By default this fetches the official DeepSeek pricing page (cached for 24 h and
 * falling back to a bundled snapshot), and overlays the user's own table from
 * `$DSH_HOME/usage-stats/prices.json`. `force` refreshes the official table now.
 * A failure never breaks the report: the loader returns provenance and warnings.
 *
 * @param force - refresh the cached/bundled official table.
 * @returns normalized pricing block plus provenance.
 */
async function loadPricing(force) {
  const paths = pricePaths();
  const autoDisabled = process.env.DSH_USAGE_STATS_AUTO_PRICING === '0';
  const envCurrency = typeof process.env.DSH_USAGE_STATS_CURRENCY === 'string' && process.env.DSH_USAGE_STATS_CURRENCY.length > 0
    ? process.env.DSH_USAGE_STATS_CURRENCY
    : undefined;
  return resolvePricing({
    ...paths,
    force: force === true,
    envAuto: autoDisabled ? false : undefined,
    envCurrency,
  });
}

// ─── model-facing tool ──────────────────────────────────────────────────────

/** Model-facing tool that reads the same figures the panel renders. */
const TOOL_NAME = 'conversation_usage';

/** Maximum conversation rows one tool call may list. */
const TOOL_TOP_LIMIT = 20;

/** Tool tools table is bounded to the top few rows. */
const TOOL_TOOLS_LIMIT = 6;

/** Tool turn-health histogram is bounded to the nonzero buckets. */
function compactTurnEnds(turnEnds) {
  const compact = {};
  for (const [kind, count] of Object.entries(turnEnds ?? {})) {
    if (typeof count === 'number' && count > 0) compact[kind] = count;
  }
  return compact;
}

/**
 * Compact count for the model-facing tool text.
 * @param value - count.
 * @returns display string.
 */
function compactCount(value) {
  const count = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`;
  if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
  if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
  return String(Math.round(count));
}

/**
 * Compact duration for the model-facing tool text.
 * @param ms - milliseconds.
 * @returns display string.
 */
function compactDuration(ms) {
  const total = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
  const seconds = Math.round(total / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, '0')}s`;
  return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, '0')}m`;
}

/**
 * Render one tool result as readable text.
 * @param value - the tool's JSON value.
 * @returns one text content block.
 */
function renderToolText(value) {
  const totals = value !== null && typeof value === 'object' && value.totals !== null && typeof value.totals === 'object' ? value.totals : {};
  const tokens = totals.tokens !== null && typeof totals.tokens === 'object' ? totals.tokens : {};
  const rows = value !== null && typeof value === 'object' && Array.isArray(value.sessions) ? value.sessions : [];
  const tools = value !== null && typeof value === 'object' && Array.isArray(value.tools) ? value.tools : [];
  const lines = [
    `Conversation usage (${String(value?.range ?? 'all')}): ${String(totals.sessions ?? 0)} conversations, ${String(tokens.total ?? 0)} tokens, ${compactDuration(totals.runTimeMs)} runtime, ${String(totals.steps ?? 0)} steps, ${String(totals.toolCalls ?? 0)} tool calls, ${String(totals.retries ?? 0)} LLM retries.`,
    `Runtime split — model ${compactDuration(totals.modelMs)}, tools ${compactDuration(totals.toolMs)}, human wait ${compactDuration(totals.humanWaitMs)}, other ${compactDuration(totals.otherMs)}.`,
    `Tokens — uncached input ${String(tokens.input ?? 0)}, cache read ${String(tokens.cacheRead ?? 0)}, cache write ${String(tokens.cacheWrite ?? 0)}, output ${String(tokens.output ?? 0)}.`,
  ];
  const inheritedTokens = totals.inherited !== null && typeof totals.inherited === 'object' ? totals.inherited.tokens : 0;
  if (typeof inheritedTokens === 'number' && inheritedTokens > 0) {
    lines.push(value?.includeInherited === true
      ? `Inherited fork prefix included: ${String(inheritedTokens)} tokens.`
      : `Excluded inherited fork prefix: ${String(inheritedTokens)} tokens (set inherited=true to include).`);
  }
  const endKinds = compactTurnEnds(value?.turnEnds);
  if (Object.keys(endKinds).length > 0) {
    lines.push(`Turn endings — ${Object.entries(endKinds).map(([kind, count]) => `${kind} ${count}`).join(', ')}.`);
  }
  const costing = value !== null && typeof value === 'object' && value.costing !== null && typeof value.costing === 'object' ? value.costing : null;
  if (costing !== null && costing.configured === true) {
    const currency = typeof costing.currency === 'string' ? costing.currency : '';
    const rangeCost = typeof totals.cost === 'number' ? totals.cost.toFixed(2) : '?';
    const monthCost = typeof costing.monthCost === 'number' ? costing.monthCost.toFixed(2) : '?';
    const budget = typeof costing.budgetMonthly === 'number'
      ? ` / budget ${costing.budgetMonthly.toFixed(2)}${typeof costing.budgetRatio === 'number' ? ` (${(costing.budgetRatio * 100).toFixed(0)}%)` : ''}`
      : '';
    lines.push(`Estimated cost — ${rangeCost} ${currency} in range; ${monthCost} ${currency} this month${budget}.`);
    const priceSource = value !== null && typeof value === 'object' && value.pricing !== null && typeof value.pricing === 'object' ? value.pricing.source : null;
    if (priceSource !== null && typeof priceSource === 'object') {
      const kind = typeof priceSource.kind === 'string' ? priceSource.kind : 'unknown';
      const origin = typeof priceSource.url === 'string' ? priceSource.url : 'user table';
      const age = typeof priceSource.fetchedAt === 'number' ? `, fetched ${compactDuration(Date.now() - priceSource.fetchedAt)} ago` : '';
      lines.push(`Prices: ${kind} (${origin}${age}); peak/off-peak tiers are applied per usage sample.`);
    }
    if (Array.isArray(costing.unpricedModels) && costing.unpricedModels.length > 0) {
      lines.push(`No price configured for: ${costing.unpricedModels.join(', ')}.`);
    }
  } else {
    lines.push('Estimated cost — no price table configured.');
  }
  const serviceRows = value !== null && typeof value === 'object' && Array.isArray(value.services) ? value.services : [];
  const billableServices = serviceRows.filter((service) => service !== null && typeof service === 'object' && service.calls > 0);
  if (billableServices.length > 0) {
    const parts = billableServices.map((service) => {
      const price = typeof service.pricePerThousand === 'number' ? `${service.pricePerThousand} ${costing?.currency ?? ''}/1k` : 'no price';
      const cost = typeof service.cost === 'number' ? `, ${service.cost.toFixed(2)} ${costing?.currency ?? ''}` : service.billed === false ? ', local/unbilled' : '';
      return `${service.kind}: ${service.calls} requests (${price}${cost})`;
    });
    lines.push(`Services — ${parts.join('; ')}.`);
  }
  const modelRows = value !== null && typeof value === 'object' && Array.isArray(value.models) ? value.models : [];
  if (modelRows.length > 0) {
    lines.push('Model usage:');
    for (const model of modelRows) {
      const label = model.provider === null ? 'unknown' : `${model.provider}/${model.model}`;
      const cost = typeof model.cost === 'number' ? `, ${model.cost.toFixed(2)} ${costing?.currency ?? ''}` : '';
      lines.push(`- ${label}: ${compactCount(model.tokens?.total)} tokens, ${String(model.calls)} calls${cost}`);
    }
  }
  if (rows.length > 0) {
    lines.push('Highest-consumption conversations:');
    for (const row of rows) {
      const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : row.id;
      const tags = [row.live === true ? 'live' : null, row.origin === 'subagent' ? 'subagent' : null].filter((tag) => tag !== null);
      lines.push(`- ${title}${tags.length > 0 ? ` [${tags.join(', ')}]` : ''}: ${compactCount(row.tokens?.total)} tokens, ${compactDuration(row.runTimeMs)}, ${String(row.steps ?? 0)} steps, ${String(row.toolCalls ?? 0)} tool calls`);
    }
  }
  if (tools.length > 0) {
    lines.push('Costliest tools:');
    for (const tool of tools) {
      lines.push(`- ${tool.name}: ${tool.calls} calls, ${compactDuration(tool.ms)} total, ${tool.errors ?? 0} errors`);
    }
  }
  if (typeof value === 'object' && value !== null && Number.isInteger(value.omitted) && value.omitted > 0) {
    lines.push(`${value.omitted} more conversation(s) omitted; raise \`top\` (max ${TOOL_TOP_LIMIT}) to list more.`);
  }
  if (typeof value === 'object' && value !== null && Array.isArray(value.errors) && value.errors.length > 0) {
    lines.push(`${value.errors.length} conversation log(s) could not be read.`);
  }
  return [{ type: 'text', text: lines.join('\n') }];
}

/**
 * Register the model-facing tool when the composition has a tool registry.
 *
 * The tool is the agent-facing caller of the same scan the panel uses, so the
 * two surfaces cannot disagree. Its result is deliberately bounded: totals,
 * the top conversations by token consumption, and the costliest tools.
 *
 * @param ctx - Host plugin context.
 * @param state - scan state shared with the panel route.
 */
function registerTool(ctx, state) {
  const tools = optional(ctx, 'tools');
  if (tools === undefined || tools === null || typeof tools.register !== 'function') return;

  ctx.effect(() => tools.register({
    name: TOOL_NAME,
    description: 'Read aggregate usage statistics across all conversations: runtime split (model, tools, human wait), token consumption per model, estimated cost and budget, turns and their endings, tool cost and LLM retries, plus the highest-consuming conversations. Read-only; figures are folded from durable session logs and a short-lived cache may serve them unless `refresh` is set.',
    parameters: {
      type: 'object',
      properties: {
        top: {
          type: 'integer',
          description: 'How many conversations to list, ranked by total tokens. Defaults to 5, maximum 20.',
        },
        range: {
          type: 'string',
          enum: ['all', '30d', '7d', '1d'],
          description: 'Time window: all time (default), last 30 days, 7 days, or today.',
        },
        inherited: {
          type: 'boolean',
          description: 'Include a forked conversation\'s inherited prefix in its figures. Defaults to false (actual consumption only).',
        },
        refresh: {
          type: 'boolean',
          description: 'Re-read the session logs instead of serving the short-lived cached scan.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render: (args, value) => renderToolText(value),
    },
    async execute(args) {
      const requested = args !== null && typeof args === 'object' && Number.isFinite(args.top) ? Math.trunc(args.top) : 5;
      const top = Math.min(TOOL_TOP_LIMIT, Math.max(1, requested));
      const force = args !== null && typeof args === 'object' && args.refresh === true;
      const range = args !== null && typeof args === 'object' && typeof args.range === 'string' && Object.hasOwn(RANGE_DAYS, args.range)
        ? args.range
        : 'all';
      const includeInherited = args !== null && typeof args === 'object' && args.inherited === true;
      const { corpus, cached, cacheAgeMs } = await readCorpus(ctx, state, force);
      const options = reportOptions(new URL(`http://localhost${ROUTE}?range=${range}&inherited=${includeInherited ? '1' : '0'}`), Date.now());
      const pricing = await loadPricing(force);
      const report = summarize(corpus.rows, { ...options, pricing });
      const listed = report.sessions.slice(0, top).map((row) => ({
        id: row.id,
        title: row.title,
        workspace: row.workspace,
        live: row.live,
        origin: row.origin,
        lastActiveAt: row.lastActiveAt,
        runTimeMs: row.runTimeMs,
        turns: row.turns,
        steps: row.steps,
        toolCalls: row.toolCalls,
        tokens: row.tokens,
      }));
      return {
        generatedAt: corpus.startedAt,
        cached,
        cacheAgeMs,
        range: report.range,
        includeInherited,
        totals: report.totals,
        costing: report.costing,
        pricing: {
          configured: pricing.configured,
          currency: pricing.currency,
          source: pricing.source,
          warnings: pricing.warnings,
          error: pricing.error,
        },
        models: report.models.slice(0, 5).map((model) => ({
          provider: model.provider,
          model: model.model,
          calls: model.calls,
          tokens: model.tokens,
          cost: model.cost,
        })),
        sessions: listed,
        tools: report.tools.slice(0, TOOL_TOOLS_LIMIT),
        services: report.services,
        turnEnds: compactTurnEnds(report.turnEnds),
        omitted: report.sessions.length - listed.length,
        errors: corpus.errors.slice(0, 5),
      };
    },
  }), 'dsh-usage-stats: conversation_usage tool');
}

/**
 * Host plugin body: one authenticated Fetch route for the panel and one
 * read-only tool for the agent, both owned by the plugin fiber.
 * @param ctx - Host plugin context.
 */
export function apply(ctx) {
  const state = createState();
  const connection = ctx !== null && ctx !== undefined ? ctx.connection : undefined;
  if (connection !== undefined && connection !== null && connection.fetch !== undefined && typeof connection.fetch.register === 'function') {
    const handler = createHandler(ctx, state);
    ctx.effect(
      () => connection.fetch.register({
        path: ROUTE,
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: handler,
      }),
      'dsh-usage-stats: summary route',
    );
  }
  // A profile with no browser surface still benefits from the tool; a profile
  // with neither service simply registers nothing.
  registerTool(ctx, state);
}

/** Services this plugin waits for before `apply` runs. */
export const inject = ['connection'];
