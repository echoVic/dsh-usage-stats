/**
 * Pure folds over durable Session event logs.
 *
 * v2 aggregates per Turn — the unit every later filter needs (date range,
 * daily trend, per-tool ranking, turn health) — and splits a turn's wall time
 * into non-overlapping segments:
 *
 *   turn runtime = model time + tool execution time + human wait + other
 *
 * - `modelMs` mirrors `@deepseek-ai/dsh-session-stats`'s `sessionStats` unit:
 *   `step/start` → `assistant/message`, and a cancelled step contributes no
 *   model time.
 * - `toolExecMs` pairs `tool/call` → `tool/result` by call id and subtracts the
 *   approval wait and the whole duration of human-answer tools
 *   (`ask_user_question`) — waiting for a human is not tool execution.
 * - `humanWaitMs` is `approval/asked` → `approval/decided` (the audit pair the
 *   approval service appends), plus the duration of `ask_user_question` calls.
 * - `otherMs` is the remainder (queueing, retry backoff, gaps); it is derived,
 *   never stored, so the four segments always sum to the turn runtime.
 *
 * Token buckets mirror `@deepseek-ai/dsh-token-meter`'s `tokenUsage` unit: every
 * settled attempt contributes its last usage sample, a same-turn/same-step
 * settlement replaces the previous sample, and `llm/retry-started` closes the
 * replacement slot so a retried attempt adds its own consumption. `inputTokens`
 * is the uncached prompt bucket.
 *
 * Everything here is plain JSON-in/JSON-out with no Harness imports: the Host
 * half is installed as a linked package outside the profile, where
 * `@deepseek-ai/*` specifiers do not resolve.
 */

const HOUR_MS = 3600000;
const DAY_MS = 86400000;

/** Turn-end kinds reported by the agent loop, normalized to one vocabulary. */
const TURN_END_KINDS = ['completed', 'aborted', 'interrupted', 'error', 'maxTokens', 'blocked', 'forked', 'other', 'open'];

/** Tools whose duration is a human-answer wait, not tool execution. */
const HUMAN_ANSWER_TOOLS = new Set(['ask_user_question']);

/** Zeroed token buckets (internal accumulator shape). */
function emptyTokenBuckets() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

/** Zeroed reportable token object. */
function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, prompt: 0, total: 0 };
}

/** Zeroed turn-end histogram. */
function emptyTurnEnds() {
  const value = {};
  for (const kind of TURN_END_KINDS) value[kind] = 0;
  return value;
}

/**
 * Non-negative safe integer check.
 * @param value - candidate.
 * @returns whether `value` is a usable count.
 */
function isCount(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/**
 * The usage sample of one settled attempt: the durable `assistant/message`
 * usage, or the last raw `usage` chunk embedded in the attempt stream.
 * @param event - `assistant/message` or `assistant/attempt` event.
 * @returns the usage record, or undefined.
 */
function usageSampleOf(event) {
  const data = event !== null && typeof event === 'object' ? event.data : undefined;
  if (data === null || typeof data !== 'object') return undefined;
  if (event.type === 'assistant/message' && data.usage !== undefined && data.usage !== null) {
    return data.usage;
  }
  const stream = data.stream;
  if (!Array.isArray(stream)) return undefined;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record === null || typeof record !== 'object') continue;
    if (record.type === 'chunk' && record.chunk !== null && typeof record.chunk === 'object' && record.chunk.type === 'usage') {
      return record.chunk.usage;
    }
  }
  return undefined;
}

/**
 * Normalize one provider usage record into the projection's buckets.
 * @param usage - provider-reported usage.
 * @returns disjoint buckets.
 */
function bucketsFrom(usage) {
  const record = usage !== null && typeof usage === 'object' ? usage : {};
  return {
    input: isCount(record.inputTokens) ? record.inputTokens : 0,
    output: isCount(record.outputTokens) ? record.outputTokens : 0,
    cacheRead: isCount(record.cacheReadTokens) ? record.cacheReadTokens : 0,
    cacheWrite: isCount(record.cacheWriteTokens) ? record.cacheWriteTokens : 0,
  };
}

/**
 * @param left - buckets.
 * @param right - buckets.
 * @returns whether every bucket matches.
 */
function sameBuckets(left, right) {
  return left.input === right.input
    && left.output === right.output
    && left.cacheRead === right.cacheRead
    && left.cacheWrite === right.cacheWrite;
}

/**
 * Trailing path segment, for showing a workspace by its directory name.
 * @param path - directory path.
 * @returns final segment, or empty string.
 */
function basenameOf(path) {
  if (typeof path !== 'string' || path.length === 0) return '';
  const parts = path.split(/[\\/]/).filter((part) => part.length > 0);
  return parts.length === 0 ? path : parts[parts.length - 1];
}

/**
 * Normalize one turn/end reason to the report vocabulary.
 * @param reason - `turn/end` reason.
 * @returns the kind.
 */
function endKindOf(reason) {
  const kind = reason !== null && typeof reason === 'object' ? reason.kind : undefined;
  switch (kind) {
    case 'completed': return 'completed';
    case 'aborted': return 'aborted';
    case 'interrupted': return 'interrupted';
    case 'error': return 'error';
    case 'max-tokens': return 'maxTokens';
    case 'blocked': return 'blocked';
    case 'forked': return 'forked';
    default: return 'other';
  }
}

/**
 * A fresh turn accumulator.
 * @param turn - turn number.
 * @param seq - the turn/start seq (used for the inherited-prefix decision).
 * @param start - wall-clock start.
 * @param inherited - whether the turn began inside the inherited prefix.
 * @returns the mutable accumulator.
 */
function newTurn(turn, seq, start, inherited) {
  return {
    turn,
    seq,
    inherited,
    start,
    end: null,
    endKind: null,
    modelMs: 0,
    toolExecMs: 0,
    humanWaitMs: 0,
    steps: 0,
    toolCalls: 0,
    userMessages: 0,
    assistantMessages: 0,
    retries: 0,
    tokens: emptyTokenBuckets(),
    tools: {},
    models: {},
    lastUsage: null,
    // Wall-clock intervals, used to split turn time without double counting
    // parallel tool calls or an approval wait that sits inside a tool call.
    modelIntervals: [],
    toolIntervals: [],
    humanIntervals: [],
  };
}

/** Bucket keys shared by the token accounting. */
const TOKEN_BUCKETS = ['input', 'output', 'cacheRead', 'cacheWrite'];

/** Model-route key used when the log never named one. */
const UNKNOWN_ROUTE_KEY = '\u0000unknown';

/**
 * Key of one provider/model route.
 * @param route - `{ provider, model }` or null.
 * @returns the route key.
 */
function routeKeyOf(route) {
  return route !== null && route !== undefined
    && typeof route.provider === 'string' && route.provider.length > 0
    && typeof route.model === 'string' && route.model.length > 0
    ? `${route.provider}\u0000${route.model}`
    : UNKNOWN_ROUTE_KEY;
}

/**
 * The assistant message's provider/model route, when it names one.
 * @param message - assembled assistant message.
 * @returns the route or undefined.
 */
function routeOfMessage(message) {
  const source = message !== null && typeof message === 'object' ? message.source : undefined;
  if (source === null || typeof source !== 'object') return undefined;
  if (typeof source.provider !== 'string' || source.provider.length === 0) return undefined;
  if (typeof source.model !== 'string' || source.model.length === 0) return undefined;
  return { provider: source.provider, model: source.model };
}

/**
 * Lazily create one route entry on a turn.
 * @param turn - the turn accumulator.
 * @param route - the route, or null for an unnamed request.
 * @returns the mutable entry.
 */
function modelEntryOf(turn, route) {
  const key = routeKeyOf(route);
  const known = turn.models[key];
  if (known !== undefined) return known;
  const entry = key === UNKNOWN_ROUTE_KEY
    ? { provider: null, model: null, calls: 0, tokens: emptyTokenBuckets() }
    : { provider: route.provider, model: route.model, calls: 0, tokens: emptyTokenBuckets() };
  turn.models[key] = entry;
  return entry;
}

/**
 * Add or subtract one bucket set.
 * @param target - bucket accumulator.
 * @param buckets - buckets to add.
 * @param sign - +1 add, -1 subtract.
 */
function addTokenBuckets(target, buckets, sign) {
  target.input += sign * buckets.input;
  target.output += sign * buckets.output;
  target.cacheRead += sign * buckets.cacheRead;
  target.cacheWrite += sign * buckets.cacheWrite;
}

/**
 * Replace-or-add one usage sample inside its turn, keeping per-route token
 * totals consistent with the replacement semantics of the whole-session fold.
 * @param turn - the open turn accumulator.
 * @param event - assistant settlement event.
 * @param currentRoute - the route of the in-flight request (`request/header`).
 */
function foldUsageSample(turn, event, currentRoute) {
  const data = event.data !== null && typeof event.data === 'object' ? event.data : {};
  if (event.type === 'llm/retry-started') {
    if (turn.lastUsage !== null && turn.lastUsage.turn === data.turn && turn.lastUsage.step === data.step) {
      turn.lastUsage = null;
    }
    return;
  }
  const sample = usageSampleOf(event);
  if (sample === undefined) return;
  const previous = turn.lastUsage !== null && turn.lastUsage.turn === data.turn && turn.lastUsage.step === data.step
    ? turn.lastUsage
    : undefined;
  const next = bucketsFrom(sample);
  if (previous !== undefined && sameBuckets(previous.buckets, next)) return;
  if (previous !== undefined) addTokenBuckets(previous.entry.tokens, previous.buckets, -1);
  const route = event.type === 'assistant/message' ? routeOfMessage(data.message) ?? currentRoute : currentRoute;
  const entry = modelEntryOf(turn, route ?? null);
  addTokenBuckets(entry.tokens, next, 1);
  turn.tokens.input += next.input - (previous === undefined ? 0 : previous.buckets.input);
  turn.tokens.output += next.output - (previous === undefined ? 0 : previous.buckets.output);
  turn.tokens.cacheRead += next.cacheRead - (previous === undefined ? 0 : previous.buckets.cacheRead);
  turn.tokens.cacheWrite += next.cacheWrite - (previous === undefined ? 0 : previous.buckets.cacheWrite);
  turn.lastUsage = { turn: data.turn, step: data.step, buckets: next, entry };
}

/**
 * Count one assembled assistant message against its route.
 * @param turn - the turn accumulator.
 * @param message - assembled assistant message.
 */
function foldModelRoute(turn, message) {
  const route = routeOfMessage(message);
  if (route === undefined) return;
  modelEntryOf(turn, route).calls += 1;
}

/**
 * Add one tool interval to the turn's tool table, separating human wait.
 * @param turn - the turn accumulator.
 * @param call - pending call record.
 * @param endTime - the interval end.
 * @param isError - whether the result was an error.
 */
function closeToolCall(turn, call, endTime, isError) {
  const start = typeof call.start === 'number' && Number.isFinite(call.start) ? call.start : endTime;
  const duration = Math.max(0, endTime - start);
  const approvalWait = Math.max(0, Math.min(duration, call.approvalWaitMs));
  const humanTool = HUMAN_ANSWER_TOOLS.has(call.name) ? duration : 0;
  const human = Math.max(approvalWait, humanTool);
  const exec = Math.max(0, duration - human);
  turn.toolExecMs += exec;
  turn.humanWaitMs += human;
  turn.toolIntervals.push([start, endTime]);
  if (humanTool > 0) turn.humanIntervals.push([start, endTime]);
  // A pure human-answer tool is a wait, not tool cost: it never enters the
  // cost ranking, so the ranking cannot be topped by "waiting for the user".
  if (HUMAN_ANSWER_TOOLS.has(call.name)) return;
  const known = turn.tools[call.name];
  if (known === undefined) {
    turn.tools[call.name] = { calls: 1, ms: exec, errors: isError ? 1 : 0 };
  } else {
    known.calls += 1;
    known.ms += exec;
    if (isError) known.errors += 1;
  }
}

/**
 * Fold one complete Session log into per-turn records plus session metadata.
 *
 * @param header - the Session's immutable header.
 * @param events - the complete raw event log (inherited seed prefix included).
 * @param options - `{ live, inheritedEventCount }`: the persisted/log-relative
 *   inherited prefix length marks copied events when (and only when) the header
 *   says the session is seeded, i.e. a fork of another conversation.
 * @returns plain JSON session analysis: metadata, turns, and inherited boundary.
 */
export function analyzeSession(header, events, options = {}) {
  const sessionHeader = header !== null && typeof header === 'object' ? header : {};
  const list = Array.isArray(events) ? events : [];
  const isSeeded = sessionHeader.isSeeded === true;
  const inheritedBoundary = isSeeded && isCount(options.inheritedEventCount) ? options.inheritedEventCount : 0;

  const turns = [];
  let current = null;
  let title;
  let lastEventAt = 0;
  const pendingCalls = new Map();
  const pendingApprovals = new Map();
  let openStep = null;
  // Route of the in-flight request, taken from `request/header`; an attempt
  // event's stream carries usage but no provider/model, so this is the only
  // way to attribute retried/interrupted attempts to their model.
  let currentRoute = null;

  /**
   * Close every call still open in one turn at the given boundary.
   * @param turn - the turn accumulator.
   * @param endTime - the boundary.
   * @param isError - whether these are errors.
   */
  const closeCalls = (turn, endTime, isError) => {
    for (const [callId, call] of pendingCalls) {
      if (call.record !== turn) continue;
      pendingCalls.delete(callId);
      closeToolCall(turn, call, endTime, isError);
    }
  };

  /**
   * Close every asked-but-undecided approval of one turn at the boundary; a
   * cancelled turn's wait is still human time.
   * @param turn - the turn accumulator.
   * @param endTime - the boundary.
   */
  const closeApprovals = (turn, endTime) => {
    for (const [id, pending] of pendingApprovals) {
      if (pending.record !== turn) continue;
      pendingApprovals.delete(id);
      turn.humanWaitMs += Math.max(0, endTime - pending.start);
      turn.humanIntervals.push([pending.start, endTime]);
    }
  };

  for (const event of list) {
    if (event === null || typeof event !== 'object') continue;
    const time = typeof event.time === 'number' && Number.isFinite(event.time) && event.time > 0 ? event.time : 0;
    if (time > lastEventAt) lastEventAt = time;
    const data = event.data !== null && typeof event.data === 'object' ? event.data : {};

    switch (event.type) {
      case 'session/title': {
        if (typeof data.title === 'string' && data.title.trim().length > 0) title = data.title.trim();
        break;
      }
      case 'turn/start': {
        // A malformed log with an unterminated turn would otherwise hide the
        // older turn's numbers; close it as an open record first.
        if (current !== null) {
          closeCalls(current, time, false);
          closeApprovals(current, time);
          current.endKind = current.endKind === null ? 'open' : current.endKind;
          turns.push(current);
        }
        const inherited = typeof event.seq === 'number' && event.seq < inheritedBoundary;
        current = newTurn(isCount(data.turn) ? data.turn : turns.length, typeof event.seq === 'number' ? event.seq : 0, time, inherited);
        openStep = null;
        break;
      }
      case 'turn/end': {
        if (current === null || current.turn !== data.turn) break;
        current.end = time;
        current.endKind = endKindOf(data.reason);
        closeCalls(current, time, false);
        closeApprovals(current, time);
        turns.push(current);
        current = null;
        openStep = null;
        pendingCalls.clear();
        pendingApprovals.clear();
        break;
      }
      case 'step/start': {
        openStep = { turn: data.turn, step: data.step, start: time };
        break;
      }
      case 'step/end': {
        if (current !== null && current.turn === data.turn) current.steps += 1;
        openStep = null;
        break;
      }
      case 'user/message': {
        if (current !== null) current.userMessages += 1;
        break;
      }
      case 'request/header': {
        const config = data.header !== null && typeof data.header === 'object' ? data.header.config : undefined;
        const provider = config !== null && typeof config === 'object' ? config.provider : undefined;
        const model = config !== null && typeof config === 'object' ? config.model : undefined;
        currentRoute = typeof provider === 'string' && provider.length > 0 && typeof model === 'string' && model.length > 0
          ? { provider, model }
          : null;
        break;
      }
      case 'assistant/message': {
        if (current !== null) {
          current.assistantMessages += 1;
          if (openStep !== null && openStep.turn === data.turn && openStep.step === data.step) {
            current.modelMs += Math.max(0, time - openStep.start);
            current.modelIntervals.push([openStep.start, time]);
            openStep = null;
          }
          foldUsageSample(current, event, currentRoute);
          foldModelRoute(current, data.message);
        }
        break;
      }
      case 'assistant/attempt': {
        if (current !== null) foldUsageSample(current, event, currentRoute);
        break;
      }
      case 'llm/retry-started': {
        if (current !== null) foldUsageSample(current, event, currentRoute);
        break;
      }
      case 'llm/retry': {
        if (current !== null) current.retries += 1;
        break;
      }
      case 'tool/call': {
        if (current === null) break;
        current.toolCalls += 1;
        if (typeof data.callId === 'string' && data.callId.length > 0) {
          pendingCalls.set(data.callId, {
            record: current,
            start: time,
            name: typeof data.name === 'string' && data.name.length > 0 ? data.name : 'unknown',
            approvalWaitMs: 0,
          });
        }
        break;
      }
      case 'tool/result': {
        const callId = data.message !== null && typeof data.message === 'object' && data.message.source !== null && typeof data.message.source === 'object'
          ? data.message.source.callId
          : undefined;
        const pending = typeof callId === 'string' ? pendingCalls.get(callId) : undefined;
        if (pending === undefined) break;
        pendingCalls.delete(callId);
        const isError = data.error !== undefined || (data.message !== null && typeof data.message === 'object' && data.message.isError === true);
        closeToolCall(pending.record, pending, time, isError);
        break;
      }
      case 'approval/asked': {
        if (current === null) break;
        if (typeof data.id !== 'string' || data.id.length === 0) break;
        pendingApprovals.set(data.id, {
          record: current,
          start: time,
          callId: typeof data.callId === 'string' ? data.callId : undefined,
          name: typeof data.toolName === 'string' ? data.toolName : 'unknown',
        });
        break;
      }
      case 'approval/decided': {
        if (typeof data.id !== 'string') break;
        const pending = pendingApprovals.get(data.id);
        if (pending === undefined) break;
        pendingApprovals.delete(data.id);
        const wait = Math.max(0, time - pending.start);
        pending.record.humanIntervals.push([pending.start, time]);
        if (pending.callId !== undefined && pendingCalls.has(pending.callId)) {
          pendingCalls.get(pending.callId).approvalWaitMs += wait;
        } else {
          pending.record.humanWaitMs += wait;
        }
        break;
      }
      default:
        break;
    }
  }

  if (current !== null) {
    // A live Session's last turn has no `turn/end` yet.
    current.endKind = 'open';
    closeCalls(current, lastEventAt, false);
    closeApprovals(current, lastEventAt);
    turns.push(current);
  }

  const createdAt = typeof sessionHeader.createdAt === 'number' && Number.isFinite(sessionHeader.createdAt)
    ? sessionHeader.createdAt
    : 0;
  return {
    id: typeof sessionHeader.id === 'string' ? sessionHeader.id : '',
    title: title === undefined ? null : title,
    createdAt,
    lastActiveAt: lastEventAt > 0 ? lastEventAt : createdAt,
    lastEventAt,
    live: options.live === true,
    parentSession: typeof sessionHeader.parentSession === 'string' ? sessionHeader.parentSession : null,
    origin: typeof sessionHeader.origin === 'string' ? sessionHeader.origin : null,
    delegationDepth: isCount(sessionHeader.delegationDepth) ? sessionHeader.delegationDepth : null,
    isSeeded,
    cwd: typeof sessionHeader.cwd === 'string' ? sessionHeader.cwd : null,
    workspace: basenameOf(typeof sessionHeader.cwd === 'string' ? sessionHeader.cwd : ''),
    agentPreset: typeof sessionHeader.agentPreset === 'string' ? sessionHeader.agentPreset : null,
    eventCount: list.length,
    inheritedEventCount: inheritedBoundary,
    turns,
  };
}

/**
 * Total tokens of one turn.
 * @param turn - turn accumulator.
 * @returns the sum of the four buckets.
 */
function turnTokenTotal(turn) {
  return turn.tokens.input + turn.tokens.output + turn.tokens.cacheRead + turn.tokens.cacheWrite;
}

/**
 * Run time of one turn at report time.
 * @param turn - turn accumulator.
 * @param session - analyzed session row.
 * @param now - report time.
 * @returns milliseconds (never negative).
 */
function turnRuntime(turn, session, now) {
  if (turn.end !== null && Number.isFinite(turn.end)) return Math.max(0, turn.end - turn.start);
  const boundary = session.live === true ? Math.max(turn.start, now) : Math.max(turn.start, session.lastEventAt);
  return Math.max(0, boundary - turn.start);
}

/**
 * Merge overlapping/adjacent [start, end] intervals.
 * @param intervals - interval list.
 * @returns sorted, disjoint intervals.
 */
function mergeIntervals(intervals) {
  const sorted = [];
  for (const interval of Array.isArray(intervals) ? intervals : []) {
    if (!Array.isArray(interval) || interval.length < 2) continue;
    const start = Number(interval[0]);
    const end = Number(interval[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) continue;
    sorted.push([start, end]);
  }
  sorted.sort((left, right) => left[0] - right[0] || left[1] - right[1]);
  const merged = [];
  for (const interval of sorted) {
    const previous = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (previous !== undefined && interval[0] <= previous[1]) {
      if (interval[1] > previous[1]) previous[1] = interval[1];
    } else {
      merged.push([interval[0], interval[1]]);
    }
  }
  return merged;
}

/**
 * Clip and merge intervals to one window.
 * @param intervals - interval list.
 * @param from - window start.
 * @param to - window end.
 * @returns sorted, disjoint intervals inside the window.
 */
function clipIntervals(intervals, from, to) {
  const clipped = [];
  for (const interval of mergeIntervals(intervals)) {
    const start = Math.max(interval[0], from);
    const end = Math.min(interval[1], to);
    if (end > start) clipped.push([start, end]);
  }
  return clipped;
}

/**
 * Total length of already-merged intervals.
 * @param merged - sorted, disjoint intervals.
 * @returns milliseconds.
 */
function lengthOf(merged) {
  let total = 0;
  for (const interval of merged) total += interval[1] - interval[0];
  return total;
}

/**
 * Overlap length between two already-merged interval lists.
 * @param left - first list.
 * @param right - second list.
 * @returns milliseconds.
 */
function overlapLength(left, right) {
  let total = 0;
  let leftIndex = 0;
  let rightIndex = 0;
  while (leftIndex < left.length && rightIndex < right.length) {
    const leftInterval = left[leftIndex];
    const rightInterval = right[rightIndex];
    const start = Math.max(leftInterval[0], rightInterval[0]);
    const end = Math.min(leftInterval[1], rightInterval[1]);
    if (end > start) total += end - start;
    if (leftInterval[1] <= rightInterval[1]) leftIndex += 1;
    else rightIndex += 1;
  }
  return total;
}

/**
 * Split one turn's wall time inside [from, to] into non-overlapping segments.
 *
 * Parallel tool calls overlap each other, and an approval wait sits inside the
 * tool interval that requested it; summing per-call durations would therefore
 * exceed the window. This uses interval unions instead, so the four segments
 * always sum to the clipped turn runtime.
 *
 * @param turn - turn accumulator with interval lists.
 * @param runtime - clipped turn runtime (ms).
 * @param from - window start.
 * @param to - window end.
 * @returns `{ modelMs, toolMs, humanMs, otherMs }`.
 */
function splitTurnTime(turn, runtime, from, to) {
  const human = clipIntervals(turn.humanIntervals, from, to);
  const tool = clipIntervals(turn.toolIntervals, from, to);
  const model = clipIntervals(turn.modelIntervals, from, to);
  let humanMs = lengthOf(human);
  let toolMs = Math.max(0, lengthOf(tool) - overlapLength(tool, human));
  const mask = mergeIntervals(human.concat(tool));
  let modelMs = Math.max(0, lengthOf(model) - overlapLength(model, mask));
  let total = modelMs + toolMs + humanMs;
  if (total > runtime && total > 0) {
    // Defensive only: timestamps outside their own turn boundary (a malformed
    // log) would otherwise overdraw the runtime.
    const scale = runtime / total;
    modelMs = Math.round(modelMs * scale);
    toolMs = Math.round(toolMs * scale);
    humanMs = Math.max(0, runtime - modelMs - toolMs);
    total = modelMs + toolMs + humanMs;
  }
  return { modelMs, toolMs, humanMs, otherMs: Math.max(0, runtime - total) };
}

/**
 * Normalize one optional price value (per 1M tokens).
 * @param value - candidate.
 * @returns the price, 0 when absent/invalid.
 */
function priceValue(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Resolve one route's price from the user table.
 *
 * Precedence: `provider/model`, `provider/*`, `*&#47;*`, `*`. A missing entry
 * means "unpriced": the model still reports tokens, but no cost.
 *
 * @param pricing - normalized pricing block (`configured`, `prices`).
 * @param provider - provider id.
 * @param model - model id.
 * @returns `{ input, output, cacheRead, cacheWrite }` or undefined.
 */
function priceFor(pricing, provider, model) {
  const table = pricing.prices;
  if (table === null || typeof table !== 'object') return undefined;
  if (typeof provider !== 'string' || typeof model !== 'string') return undefined;
  for (const key of [`${provider}/${model}`, `${provider}/*`, '*/*', '*']) {
    const entry = table[key];
    if (entry === null || typeof entry !== 'object') continue;
    return {
      input: priceValue(entry.input),
      output: priceValue(entry.output),
      cacheRead: priceValue(entry.cacheRead),
      cacheWrite: priceValue(entry.cacheWrite),
    };
  }
  return undefined;
}

/**
 * Cost of one bucket set under one price.
 * @param buckets - token buckets.
 * @param price - resolved price per 1M tokens.
 * @returns currency amount.
 */
function costOf(buckets, price) {
  return (buckets.input * price.input
    + buckets.output * price.output
    + buckets.cacheRead * price.cacheRead
    + buckets.cacheWrite * price.cacheWrite) / 1e6;
}

/**
 * Start of the local calendar month containing one timestamp.
 * @param now - report time.
 * @param offsetMinutes - local offset east of UTC.
 * @returns epoch ms of the month start.
 */
function monthStartOf(now, offsetMinutes) {
  const local = new Date(now + offsetMinutes * 60000);
  return Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), 1) - offsetMinutes * 60000;
}

/**
 * Aggregate every session analysis into the panel's report.
 *
 * @param sessions - analyzed session rows.
 * @param options - range and presentation options:
 *   `now`, `from`/`to` (epoch ms; omit for all time), `range` label,
 *   `includeInherited`, `offsetMinutes`, `trendUnit`, `trendCount`, and
 *   `pricing` (`{ configured, currency, prices, budgetMonthly }`).
 * @returns the report payload (without transport metadata).
 */
export function summarize(sessions, options = {}) {
  const now = Number.isFinite(options.now) ? options.now : Date.now();
  const from = Number.isFinite(options.from) ? options.from : -Infinity;
  const to = Number.isFinite(options.to) ? options.to : Infinity;
  const includeInherited = options.includeInherited === true;
  const offsetMinutes = Number.isFinite(options.offsetMinutes) ? Math.max(-840, Math.min(840, Math.trunc(options.offsetMinutes))) : 0;
  const rangeAll = from === -Infinity && to === Infinity;
  const trendUnit = options.trendUnit === 'hour' ? 'hour' : 'day';
  const unitMs = trendUnit === 'hour' ? HOUR_MS : DAY_MS;
  const trendCount = isCount(options.trendCount) && options.trendCount > 0 ? options.trendCount : 14;

  const rawPricing = options.pricing !== null && typeof options.pricing === 'object' ? options.pricing : {};
  const pricing = {
    configured: rawPricing.configured === true,
    currency: typeof rawPricing.currency === 'string' && rawPricing.currency.length > 0 ? rawPricing.currency : null,
    prices: rawPricing.prices !== null && typeof rawPricing.prices === 'object' ? rawPricing.prices : null,
    budgetMonthly: typeof rawPricing.budgetMonthly === 'number' && Number.isFinite(rawPricing.budgetMonthly) && rawPricing.budgetMonthly >= 0
      ? rawPricing.budgetMonthly
      : null,
  };
  const priceCache = new Map();
  const resolvePrice = (provider, model) => {
    const key = `${provider}\u0000${model}`;
    if (priceCache.has(key)) return priceCache.get(key);
    const resolved = pricing.configured ? priceFor(pricing, provider, model) : undefined;
    const value = resolved === undefined ? null : resolved;
    priceCache.set(key, value);
    return value;
  };
  const priceOfBuckets = (entry) => {
    const price = resolvePrice(entry.provider, entry.model);
    return price === null ? null : costOf(entry.tokens, price);
  };
  const unpricedModels = new Set();
  const budgetMonthStart = monthStartOf(now, offsetMinutes);

  const trendBuckets = [];
  const trendIndex = new Map();
  const currentBucket = Math.floor((now + offsetMinutes * 60000) / unitMs);
  for (let index = trendCount - 1; index >= 0; index -= 1) {
    const slot = currentBucket - index;
    const bucket = {
      start: slot * unitMs - offsetMinutes * 60000,
      tokens: 0,
      runTimeMs: 0,
      steps: 0,
      toolCalls: 0,
      cost: 0,
      sessionIds: new Set(),
    };
    trendIndex.set(slot, bucket);
    trendBuckets.push(bucket);
  }

  const totals = {
    sessions: 0,
    liveSessions: 0,
    subagentSessions: 0,
    runTimeMs: 0,
    modelMs: 0,
    toolMs: 0,
    humanWaitMs: 0,
    otherMs: 0,
    turns: 0,
    steps: 0,
    toolCalls: 0,
    retries: 0,
    userMessages: 0,
    assistantMessages: 0,
    tokens: emptyTokens(),
    cacheHitRate: null,
    cost: pricing.configured ? 0 : null,
    monthTokens: 0,
    monthCost: pricing.configured ? 0 : null,
    inherited: { tokens: 0, runTimeMs: 0, turns: 0, steps: 0 },
    firstActivityAt: null,
    lastActivityAt: null,
  };
  const toolAgg = new Map();
  const modelAgg = new Map();
  const turnEnds = emptyTurnEnds();
  const rows = [];

  for (const session of sessions) {
    if (session === null || typeof session !== 'object') continue;
    const row = {
      id: session.id,
      title: session.title,
      createdAt: session.createdAt,
      lastActiveAt: session.lastActiveAt,
      live: session.live,
      parentSession: session.parentSession,
      origin: session.origin,
      delegationDepth: session.delegationDepth,
      isSeeded: session.isSeeded,
      cwd: session.cwd,
      workspace: session.workspace,
      agentPreset: session.agentPreset,
      eventCount: session.eventCount,
      runTimeMs: 0,
      modelMs: 0,
      toolMs: 0,
      humanWaitMs: 0,
      otherMs: 0,
      turns: 0,
      steps: 0,
      toolCalls: 0,
      retries: 0,
      userMessages: 0,
      assistantMessages: 0,
      tokens: emptyTokens(),
      cacheHitRate: null,
      cost: null,
      unpriced: false,
      models: [],
      tools: [],
      turnEnds: emptyTurnEnds(),
      inherited: { tokens: 0, runTimeMs: 0, turns: 0, steps: 0 },
    };
    const rowTools = new Map();
    const rowModels = new Map();
    let selected = 0;

    for (const turn of Array.isArray(session.turns) ? session.turns : []) {
      if (turn === null || typeof turn !== 'object') continue;
      const runtime = turnRuntime(turn, session, now);
      const endTime = turn.end !== null && Number.isFinite(turn.end) ? turn.end : turn.start + runtime;
      const overlaps = endTime >= from && turn.start <= to;
      const inheritedTurn = turn.inherited === true;
      const includedTurn = !inheritedTurn || includeInherited;

      // The excluded inherited prefix is still annotated: the row says how much
      // of a fork came from its parent even when it is not part of the totals.
      if (!includedTurn) {
        if (overlaps) {
          const inheritedClipped = Math.max(0, Math.min(endTime, to) - Math.max(turn.start, from));
          row.inherited.tokens += turnTokenTotal(turn);
          row.inherited.runTimeMs += inheritedClipped;
          row.inherited.turns += 1;
          row.inherited.steps += turn.steps;
        }
        continue;
      }

      // Month-to-date is independent of the selected range (it feeds the
      // budget), but it follows the inherited-prefix policy.
      if (includedTurn) {
        let turnCost = null;
        let turnUnpriced = false;
        if (pricing.configured) {
          for (const entry of Object.values(turn.models)) {
            if (entry === null || typeof entry !== 'object') continue;
            const total = turnTokenTotal(entry);
            if (total <= 0) continue;
            const cost = priceOfBuckets(entry);
            if (cost === null) {
              turnUnpriced = true;
              unpricedModels.add(`${entry.provider}/${entry.model}`);
            } else {
              turnCost = (turnCost === null ? 0 : turnCost) + cost;
            }
          }
        }
        if (endTime >= budgetMonthStart) {
          totals.monthTokens += turnTokenTotal(turn);
          if (turnCost !== null) totals.monthCost = (totals.monthCost ?? 0) + turnCost;
        }
        if (!overlaps) continue;

        const clipped = Math.max(0, Math.min(endTime, to) - Math.max(turn.start, from));
        const ratio = runtime > 0 ? Math.min(1, clipped / runtime) : (clipped > 0 ? 1 : 0);
        if (inheritedTurn) {
          row.inherited.tokens += turnTokenTotal(turn);
          row.inherited.runTimeMs += clipped;
          row.inherited.turns += 1;
          row.inherited.steps += turn.steps;
        }
        selected += 1;
        const split = splitTurnTime(turn, clipped, from, to);
        row.runTimeMs += clipped;
        row.modelMs += split.modelMs;
        row.toolMs += split.toolMs;
        row.humanWaitMs += split.humanMs;
        row.otherMs += split.otherMs;
        row.turns += 1;
        row.steps += turn.steps;
        row.toolCalls += turn.toolCalls;
        row.retries += turn.retries;
        row.userMessages += turn.userMessages;
        row.assistantMessages += turn.assistantMessages;
        row.tokens.input += turn.tokens.input;
        row.tokens.output += turn.tokens.output;
        row.tokens.cacheRead += turn.tokens.cacheRead;
        row.tokens.cacheWrite += turn.tokens.cacheWrite;
        if (turnCost !== null) row.cost = (row.cost === null ? 0 : row.cost) + turnCost;
        if (turnUnpriced) row.unpriced = true;

        const endKind = turn.endKind !== null && Object.hasOwn(row.turnEnds, turn.endKind) ? turn.endKind : 'other';
        row.turnEnds[endKind] += 1;
        turnEnds[endKind] += 1;

        for (const [name, stats] of Object.entries(turn.tools)) {
          if (stats === null || typeof stats !== 'object') continue;
          const known = rowTools.get(name);
          if (known === undefined) {
            rowTools.set(name, { name, calls: stats.calls, ms: stats.ms * ratio, errors: stats.errors });
          } else {
            known.calls += stats.calls;
            known.ms += stats.ms * ratio;
            known.errors += stats.errors;
          }
        }
        for (const [key, entry] of Object.entries(turn.models)) {
          if (entry === null || typeof entry !== 'object') continue;
          let known = rowModels.get(key);
          if (known === undefined) {
            known = { provider: entry.provider, model: entry.model, calls: 0, tokens: emptyTokenBuckets(), cost: pricing.configured ? 0 : null, unpriced: false };
            rowModels.set(key, known);
          }
          known.calls += entry.calls;
          for (const bucket of TOKEN_BUCKETS) known.tokens[bucket] += entry.tokens[bucket];
        }

        const bucket = trendIndex.get(Math.floor((endTime + offsetMinutes * 60000) / unitMs));
        if (bucket !== undefined) {
          bucket.tokens += turnTokenTotal(turn);
          bucket.runTimeMs += clipped;
          bucket.steps += turn.steps;
          bucket.toolCalls += turn.toolCalls;
          if (turnCost !== null) bucket.cost += turnCost;
          bucket.sessionIds.add(session.id);
        }
      }
    }

    // A session with no turns at all is still a conversation: show it under
    // "all time" so an empty/new conversation is not silently hidden.
    if (rangeAll && (session.turns ?? []).length === 0) selected = 1;
    if (selected === 0 && !rangeAll) continue;

    const prompt = row.tokens.input + row.tokens.cacheRead + row.tokens.cacheWrite;
    row.tokens.prompt = prompt;
    row.tokens.total = prompt + row.tokens.output;
    row.cacheHitRate = prompt > 0 ? row.tokens.cacheRead / prompt : null;
    row.models = [...rowModels.values()].map((entry) => {
      const cost = pricing.configured ? priceOfBuckets(entry) : null;
      if (cost === null && pricing.configured) {
        row.unpriced = true;
        unpricedModels.add(`${entry.provider}/${entry.model}`);
      }
      const entryPrompt = entry.tokens.input + entry.tokens.cacheRead + entry.tokens.cacheWrite;
      return {
        provider: entry.provider,
        model: entry.model,
        calls: entry.calls,
        tokens: {
          ...entry.tokens,
          prompt: entryPrompt,
          total: entryPrompt + entry.tokens.output,
        },
        cacheHitRate: entryPrompt > 0 ? entry.tokens.cacheRead / entryPrompt : null,
        cost,
      };
    }).sort((left, right) => right.tokens.total - left.tokens.total || right.calls - left.calls);
    row.tools = [...rowTools.values()].sort((left, right) => right.ms - left.ms || right.calls - left.calls);

    totals.sessions += 1;
    if (row.live === true) totals.liveSessions += 1;
    if (row.origin === 'subagent') totals.subagentSessions += 1;
    totals.runTimeMs += row.runTimeMs;
    totals.modelMs += row.modelMs;
    totals.toolMs += row.toolMs;
    totals.humanWaitMs += row.humanWaitMs;
    totals.otherMs += row.otherMs;
    totals.turns += row.turns;
    totals.steps += row.steps;
    totals.toolCalls += row.toolCalls;
    totals.retries += row.retries;
    totals.userMessages += row.userMessages;
    totals.assistantMessages += row.assistantMessages;
    totals.tokens.input += row.tokens.input;
    totals.tokens.output += row.tokens.output;
    totals.tokens.cacheRead += row.tokens.cacheRead;
    totals.tokens.cacheWrite += row.tokens.cacheWrite;
    if (row.cost !== null) totals.cost += row.cost;
    totals.inherited.tokens += row.inherited.tokens;
    totals.inherited.runTimeMs += row.inherited.runTimeMs;
    totals.inherited.turns += row.inherited.turns;
    totals.inherited.steps += row.inherited.steps;
    if (totals.firstActivityAt === null || row.createdAt < totals.firstActivityAt) totals.firstActivityAt = row.createdAt;
    if (totals.lastActivityAt === null || row.lastActiveAt > totals.lastActivityAt) totals.lastActivityAt = row.lastActiveAt;

    for (const stats of rowTools.values()) {
      const known = toolAgg.get(stats.name);
      if (known === undefined) toolAgg.set(stats.name, { ...stats });
      else {
        known.calls += stats.calls;
        known.ms += stats.ms;
        known.errors += stats.errors;
      }
    }
    for (const entry of row.models) {
      const key = `${entry.provider}\u0000${entry.model}`;
      let known = modelAgg.get(key);
      if (known === undefined) {
        known = {
          provider: entry.provider,
          model: entry.model,
          calls: 0,
          tokens: emptyTokenBuckets(),
          cost: null,
          unpriced: false,
        };
        modelAgg.set(key, known);
      }
      known.calls += entry.calls;
      for (const bucket of TOKEN_BUCKETS) known.tokens[bucket] += entry.tokens[bucket];
      if (entry.cost === null && pricing.configured) known.unpriced = true;
      else if (entry.cost !== null) known.cost = (known.cost === null ? 0 : known.cost) + entry.cost;
    }
    rows.push(row);
  }

  const prompt = totals.tokens.input + totals.tokens.cacheRead + totals.tokens.cacheWrite;
  totals.tokens.prompt = prompt;
  totals.tokens.total = prompt + totals.tokens.output;
  totals.cacheHitRate = prompt > 0 ? totals.tokens.cacheRead / prompt : null;

  rows.sort((left, right) => right.lastActiveAt - left.lastActiveAt);
  const tools = [...toolAgg.values()].sort((left, right) => right.ms - left.ms || right.calls - left.calls);
  const models = [...modelAgg.values()].map((entry) => {
    if (entry.unpriced) unpricedModels.add(`${entry.provider}/${entry.model}`);
    const entryPrompt = entry.tokens.input + entry.tokens.cacheRead + entry.tokens.cacheWrite;
    return {
      provider: entry.provider,
      model: entry.model,
      calls: entry.calls,
      tokens: {
        ...entry.tokens,
        prompt: entryPrompt,
        total: entryPrompt + entry.tokens.output,
      },
      cacheHitRate: entryPrompt > 0 ? entry.tokens.cacheRead / entryPrompt : null,
      cost: entry.unpriced ? null : entry.cost,
    };
  }).sort((left, right) => right.tokens.total - left.tokens.total || right.calls - left.calls);

  const budgetMonthly = pricing.budgetMonthly;
  return {
    range: typeof options.range === 'string' ? options.range : 'all',
    includeInherited,
    offsetMinutes,
    totals,
    sessions: rows,
    trend: {
      unit: trendUnit,
      buckets: trendBuckets.map((bucket) => ({
        start: bucket.start,
        tokens: bucket.tokens,
        runTimeMs: bucket.runTimeMs,
        steps: bucket.steps,
        toolCalls: bucket.toolCalls,
        cost: pricing.configured ? bucket.cost : null,
        sessions: bucket.sessionIds.size,
      })),
    },
    tools,
    models,
    turnEnds,
    costing: {
      configured: pricing.configured,
      currency: pricing.currency,
      budgetMonthly,
      monthTokens: totals.monthTokens,
      monthCost: totals.monthCost,
      budgetRatio: budgetMonthly !== null && budgetMonthly > 0 && totals.monthCost !== null ? totals.monthCost / budgetMonthly : null,
      unpricedModels: [...unpricedModels].filter((name) => name.length > 0).sort(),
    },
  };
}
