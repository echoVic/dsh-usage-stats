/**
 * Route-level tests for the Host half: `apply` registration, request handling,
 * range/inherited query parameters, the corpus cache, per-session failure
 * isolation, and the model-facing tool.
 *
 * The fake context mirrors just the part of the Cordis/Host surface this plugin
 * touches (`ctx.get`, `ctx.effect`, `ctx.connection.fetch.register`), so these
 * tests exercise the real handler, the real scan and the real folds.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { apply, RANGE_DAYS, ROUTE } from '../lib/index.js';

const URL_ROOT = 'http://127.0.0.1:50878';
// Deterministic price resolution: a scratch DSH_HOME, no automatic fetch unless
// a test explicitly enables it, and a user table path that does not exist.
const TEST_HOME = mkdtempSync(join(tmpdir(), 'dsh-usage-home-'));
mkdirSync(join(TEST_HOME, 'usage-stats'), { recursive: true });
process.env.DSH_HOME = TEST_HOME;
process.env.DSH_USAGE_STATS_AUTO_PRICING = '0';
const MISSING_PRICES = join(TEST_HOME, 'usage-stats', 'prices.json');
process.env.DSH_USAGE_STATS_PRICES = MISSING_PRICES;

/** A minimal official-pricing table fixture (CNY column set, same shape as the live page). */
const OFFICIAL_HTML = `<html><body><table>
<tr><td colspan="3">MODEL PRICING</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>PEAK</td><td>0.04元</td><td>0.3元</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>1元</td><td>4.5元</td></tr>
<tr><td>PEAK</td><td>2元</td><td>9元</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>4元</td><td>13.5元</td></tr>
<tr><td>PEAK</td><td>8元</td><td>27元</td></tr>
</table></body></html>`;

/** A turn at a known UTC peak instant (Monday 02:00 UTC). */
const PEAK_TIME = Date.UTC(2027, 0, 4, 2, 0, 0);

const DAY_MS = 86400000;
const NOW = Date.now();

let seq = 0;

/**
 * One event envelope with a monotonic seq.
 * @param type - event type.
 * @param data - payload.
 * @param time - timestamp.
 * @returns the event.
 */
function event(type, data, time) {
  seq += 1;
  return { type, seq, time, data };
}

/**
 * A complete simple turn.
 * @param turn - turn number.
 * @param start - start time.
 * @param messageTime - assistant message time.
 * @param end - end time.
 * @param usage - provider usage.
 * @returns the events.
 */
function simpleTurn(turn, start, messageTime, end, usage) {
  return [
    event('turn/start', { turn }, start),
    event('step/start', { turn, step: 1 }, start + 100),
    event('assistant/message', {
      turn,
      step: 1,
      message: { role: 'assistant', source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      stream: [],
      ...(usage === undefined ? {} : { usage }),
    }, messageTime),
    event('step/end', { turn, step: 1 }, messageTime + 10),
    event('turn/end', { turn, reason: { kind: 'completed' } }, end),
  ];
}

/**
 * Build a fake Host context and mutable corpus state.
 * @returns the fake context plus instrumentation.
 */
function fakeContext() {
  seq = 0;
  const registered = [];
  const tools = [];
  const calls = { listSessions: 0, readSession: 0, persistenceList: 0 };
  const state = {
    records: [],
    failReadsFor: new Set(),
    revision: 'rev-1',
  };

  function addLive(header, events, inheritedEventCount = 0) {
    state.records.push({ header, live: true, events, inheritedEventCount });
  }

  function addPersisted(header, events, inheritedEventCount = 0) {
    state.records.push({ header, live: false, events, inheritedEventCount });
  }

  const sessionQuery = {
    async listSessions() {
      calls.listSessions += 1;
      return state.records.map((record) => ({ header: record.header, live: record.live === true, persisted: record.live !== true }));
    },
    async readSession(id) {
      calls.readSession += 1;
      if (state.failReadsFor.has(id)) throw new Error('corrupt session log');
      const record = state.records.find((entry) => entry.header.id === id);
      if (record === undefined) throw new Error(`unexpected read ${id}`);
      return { session: record.header, inheritedEventCount: record.inheritedEventCount ?? 0, events: record.events };
    },
  };

  const sessions = {
    get(id) {
      const record = state.records.find((entry) => entry.live === true && entry.header.id === id);
      if (record === undefined) return undefined;
      return {
        header: record.header,
        inheritedEventCount: record.inheritedEventCount ?? 0,
        snapshotEvents: () => record.events,
      };
    },
  };

  const persistence = {
    async list() {
      calls.persistenceList += 1;
      return state.records
        .filter((record) => record.live !== true)
        .map((record) => ({ header: { id: record.header.id }, revision: state.revision }));
    },
  };

  const ctx = {
    effects: [],
    get(name) {
      if (name === 'sessionQuery') return sessionQuery;
      if (name === 'sessions') return sessions;
      if (name === 'sessionPersistence') return persistence;
      if (name === 'tools') {
        return { register: (definition) => { tools.push(definition); return () => {}; } };
      }
      return undefined;
    },
    effect(callback, label) {
      const disposer = callback();
      ctx.effects.push({ label, disposer });
      return disposer;
    },
    connection: {
      fetch: {
        register(route) {
          registered.push(route);
          return () => {};
        },
      },
    },
  };

  return { ctx, registered, tools, calls, state, addLive, addPersisted };
}

/** Headers used by the fixtures. */
const HEADER_A = { id: 's1', version: 4, createdAt: NOW - DAY_MS, cwd: '/w/alpha', isSeeded: false };
const HEADER_B = { id: 's2', version: 4, createdAt: NOW - 10 * DAY_MS, cwd: '/w/beta', isSeeded: false };

test('apply registers one authenticated GET route and one tool on the plugin fiber', () => {
  const { ctx, registered, tools, calls } = fakeContext();
  apply(ctx);
  assert.equal(registered.length, 1);
  assert.equal(registered[0].path, ROUTE);
  assert.deepEqual(registered[0].methods, ['GET']);
  assert.equal(registered[0].requestBody, 'buffered');
  assert.equal(typeof registered[0].fetch, 'function');
  assert.equal(tools.length, 1);
  assert.equal(tools[0].name, 'conversation_usage');
  assert.equal(ctx.effects.length, 2);
  assert.equal(calls.listSessions, 0);
});

test('serves a v4 report with runtime split, trend, tools, turn health and cost metadata', async () => {
  const { ctx, registered, addLive } = fakeContext();
  const events = [
    ...simpleTurn(1, NOW - 5000, NOW - 3000, NOW - 2000, { inputTokens: 100, outputTokens: 20, cacheReadTokens: 30 }),
    event('turn/start', { turn: 2 }, NOW - 1000),
    event('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, NOW - 900),
    event('approval/asked', { id: 'a1', toolName: 'bash', callId: 'c1' }, NOW - 800),
    event('approval/decided', { id: 'a1', outcome: 'allowed-once' }, NOW - 300),
    event('tool/result', { turn: 2, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [] } }, NOW - 200),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, NOW - 100),
  ];
  addLive(HEADER_A, events);
  apply(ctx);

  const response = await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`));
  assert.equal(response.status, 200);
  const payload = await response.json();

  assert.equal(payload.ok, true);
  assert.equal(payload.version, 4);
  assert.equal(payload.range, 'all');
  assert.equal(payload.includeInherited, false);
  assert.equal(payload.scope.listed, 1);
  assert.equal(payload.totals.sessions, 1);
  assert.equal(payload.totals.liveSessions, 1);
  assert.equal(payload.totals.turns, 2);
  assert.equal(payload.totals.tokens.total, 150);
  assert.equal(payload.totals.cacheHitRate, 30 / 130);
  // Turn 1: 3000ms wall = 1900ms model (step start → message) + 1100ms other.
  // Turn 2: 900ms wall; the 700ms tool interval holds a 500ms approval wait,
  // so the split is 200ms tool exec + 500ms human wait + 200ms other.
  assert.equal(payload.totals.modelMs, 1900);
  assert.equal(payload.totals.humanWaitMs, 500);
  assert.equal(payload.totals.toolMs, 200);
  assert.equal(payload.totals.runTimeMs, payload.totals.modelMs + payload.totals.toolMs + payload.totals.humanWaitMs + payload.totals.otherMs);
  assert.deepEqual(payload.tools, [{ name: 'bash', calls: 1, ms: 200, errors: 0 }]);
  assert.equal(payload.turnEnds.completed, 2);
  assert.equal(payload.pricing.configured, false, 'no price file means an explicit unconfigured block');
  assert.equal(payload.costing.configured, false);
  assert.equal(payload.costing.currency, 'CNY');
  assert.equal(payload.totals.cost, null);
  assert.equal(payload.models.length, 1);
  assert.equal(payload.models[0].model, 'deepseek-flash');
  assert.equal(payload.models[0].tokens.total, 150);
  assert.equal(payload.models[0].cost, null);
  assert.equal(payload.sessions[0].cost, null);
  assert.ok(Array.isArray(payload.sessions[0].tools));
  assert.equal(payload.sessions[0].turnEnds.completed, 2);
  assert.equal(payload.trend.unit, 'day');
  assert.equal(payload.trend.buckets.length, 14);
  assert.equal(payload.trend.buckets[13].tokens, 150);
  assert.equal(payload.sessions[0].workspace, 'alpha');
  assert.deepEqual(payload.errors, []);
  assert.equal(payload.partial, false);
});

test('range filters turns without rescanning the corpus', async () => {
  const { ctx, registered, addLive, addPersisted, calls } = fakeContext();
  addLive(HEADER_A, simpleTurn(1, NOW - 5 * 60000, NOW - 4 * 60000, NOW - 3 * 60000, { inputTokens: 100, outputTokens: 20 }));
  addPersisted(HEADER_B, simpleTurn(1, NOW - 10 * DAY_MS, NOW - 10 * DAY_MS + 500, NOW - 10 * DAY_MS + 1000, { inputTokens: 900, outputTokens: 100 }));
  apply(ctx);

  const all = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
  assert.equal(all.totals.sessions, 2);
  assert.equal(all.totals.tokens.total, 1120);
  assert.equal(calls.listSessions, 1);

  const week = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?range=7d`))).json();
  assert.equal(week.range, '7d');
  assert.equal(week.totals.sessions, 1);
  assert.equal(week.totals.tokens.total, 120);
  assert.equal(calls.listSessions, 1, 'switching the range serves the cached corpus');
  assert.equal(calls.readSession, 1);

  const today = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?range=1d&offset=480`))).json();
  assert.equal(today.range, '1d');
  assert.equal(today.offsetMinutes, 480);
  assert.equal(today.trend.unit, 'hour');
  assert.equal(today.trend.buckets.length, 24);
  assert.equal(today.totals.tokens.total, 120);
});

test('the inherited-prefix mode switches figures without rescanning', async () => {
  const { ctx, registered, addPersisted, calls } = fakeContext();
  const forkHeader = { id: 'fork', version: 4, createdAt: NOW - 2 * DAY_MS, cwd: '/w/alpha', isSeeded: true };
  const events = [
    ...simpleTurn(1, NOW - 2 * DAY_MS, NOW - 2 * DAY_MS + 500, NOW - 2 * DAY_MS + 1000, { inputTokens: 1000, outputTokens: 500 }),
    ...simpleTurn(2, NOW - 60000, NOW - 30000, NOW - 10000, { inputTokens: 10, outputTokens: 5 }),
  ];
  addPersisted(forkHeader, events, 5);
  apply(ctx);

  const own = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
  assert.equal(own.includeInherited, false);
  assert.equal(own.totals.tokens.total, 15);
  assert.equal(own.totals.inherited.tokens, 1500);
  assert.equal(own.sessions[0].inherited.tokens, 1500);
  assert.equal(calls.listSessions, 1);

  const withInherited = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?inherited=1`))).json();
  assert.equal(withInherited.includeInherited, true);
  assert.equal(withInherited.totals.tokens.total, 1515);
  assert.equal(withInherited.totals.inherited.tokens, 1500);
  assert.equal(calls.listSessions, 1);
  assert.equal(calls.readSession, 1);
});

test('reads the user price table and reports cost plus budget', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-prices-live-'));
  const pricesFile = join(directory, 'prices.json');
  writeFileSync(pricesFile, JSON.stringify({
    _note: 'test prices, per 1M tokens',
    currency: 'CNY',
    budget: { monthly: 100 },
    prices: { 'deepseek-official/*': { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 } },
  }));
  const previous = process.env.DSH_USAGE_STATS_PRICES;
  process.env.DSH_USAGE_STATS_PRICES = pricesFile;
  try {
    const { ctx, registered, addPersisted } = fakeContext();
    addPersisted(HEADER_B, simpleTurn(1, NOW - 1000, NOW - 500, NOW - 100, { inputTokens: 100, outputTokens: 10 }));
    apply(ctx);

    const payload = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
    assert.equal(payload.pricing.configured, true);
    assert.equal(payload.pricing.currency, 'CNY');
    assert.equal(payload.pricing.source.kind, 'manual');
    assert.equal(payload.pricing.source.userFile, pricesFile);
    assert.equal(payload.pricing.budgetMonthly, 100);
    assert.equal(payload.costing.configured, true);
    assert.equal(payload.totals.cost, 120);
    assert.equal(payload.totals.monthCost, 120, 'the only turn is inside the current month');
    assert.equal(payload.models[0].cost, 120);
    assert.equal(payload.sessions[0].cost, 120);
    assert.equal(payload.trend.buckets[payload.trend.buckets.length - 1].cost, 120);
    assert.equal(payload.costing.budgetRatio, 1.2);
  } finally {
    process.env.DSH_USAGE_STATS_PRICES = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('a malformed user price table degrades to unconfigured with an error message', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-prices-bad-'));
  const pricesFile = join(directory, 'prices.json');
  writeFileSync(pricesFile, '{ not json');
  const previous = process.env.DSH_USAGE_STATS_PRICES;
  process.env.DSH_USAGE_STATS_PRICES = pricesFile;
  try {
    const { ctx, registered, addPersisted } = fakeContext();
    addPersisted(HEADER_B, simpleTurn(1, NOW - 1000, NOW - 500, NOW - 100, { inputTokens: 1, outputTokens: 1 }));
    apply(ctx);
    const payload = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
    assert.equal(payload.ok, true);
    assert.equal(payload.pricing.configured, false);
    assert.match(payload.pricing.error, /JSON/i);
    assert.ok(payload.pricing.warnings.some((warning) => /price table unreadable/.test(warning)));
    assert.equal(payload.totals.cost, null);
  } finally {
    process.env.DSH_USAGE_STATS_PRICES = previous;
    rmSync(directory, { recursive: true, force: true });
  }
});

test('auto-fetches the official price table and applies the peak tier', async () => {
  const cacheFile = join(TEST_HOME, 'usage-stats', 'prices.cache.json');
  rmSync(cacheFile, { force: true });
  const originalFetch = globalThis.fetch;
  process.env.DSH_USAGE_STATS_AUTO_PRICING = '1';
  process.env.DSH_USAGE_STATS_CURRENCY = 'CNY';
  globalThis.fetch = async () => ({ ok: true, status: 200, async text() { return OFFICIAL_HTML; } });
  try {
    const { ctx, registered, addPersisted } = fakeContext();
    addPersisted(HEADER_B, simpleTurn(
      1,
      PEAK_TIME,
      PEAK_TIME + 500,
      PEAK_TIME + 1000,
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ));
    apply(ctx);

    const payload = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
    assert.equal(payload.version, 4);
    assert.equal(payload.pricing.configured, true);
    assert.equal(payload.pricing.source.kind, 'auto');
    assert.equal(payload.pricing.currency, 'CNY');
    assert.equal(payload.pricing.source.url, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing');
    // The turn sits in a Monday 02:00 UTC peak window: flash peak ¥2 input + ¥8 output.
    assert.equal(payload.totals.cost, 10);
    assert.equal(payload.models[0].cost, 10);
    assert.ok(existsSync(cacheFile), 'the official table is cached for the TTL window');

    globalThis.fetch = async () => {
      throw new Error('offline');
    };
    const cached = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
    assert.equal(cached.pricing.source.kind, 'cache');
    assert.equal(cached.totals.cost, 10);
    assert.ok(cached.pricing.warnings.some((warning) => /refresh failed/.test(warning)));
  } finally {
    globalThis.fetch = originalFetch;
    process.env.DSH_USAGE_STATS_AUTO_PRICING = '0';
    delete process.env.DSH_USAGE_STATS_CURRENCY;
    rmSync(cacheFile, { force: true });
  }
});

test('falls back to the bundled official snapshot when the live page is unreachable', async () => {
  const cacheFile = join(TEST_HOME, 'usage-stats', 'prices.cache.json');
  rmSync(cacheFile, { force: true });
  const originalFetch = globalThis.fetch;
  process.env.DSH_USAGE_STATS_AUTO_PRICING = '1';
  globalThis.fetch = async () => {
    throw new Error('offline');
  };
  try {
    const { ctx, registered, addPersisted } = fakeContext();
    addPersisted(HEADER_B, simpleTurn(
      1,
      PEAK_TIME,
      PEAK_TIME + 500,
      PEAK_TIME + 1000,
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
    ));
    apply(ctx);
    const payload = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
    assert.equal(payload.pricing.configured, true);
    assert.equal(payload.pricing.source.kind, 'bundled');
    assert.ok(payload.pricing.warnings.some((warning) => /refresh failed/.test(warning)));
    assert.ok(typeof payload.totals.cost === 'number' && payload.totals.cost > 0);
  } finally {
    globalThis.fetch = originalFetch;
    process.env.DSH_USAGE_STATS_AUTO_PRICING = '0';
  }
});

test('serves a scan from the TTL cache, and skips unchanged persisted logs when forced', async () => {
  const { ctx, registered, addPersisted, calls } = fakeContext();
  addPersisted(HEADER_B, simpleTurn(1, NOW - 1000, NOW - 500, NOW - 100, { inputTokens: 5, outputTokens: 1 }));
  apply(ctx);
  const route = registered[0];

  const first = await (await route.fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
  assert.equal(first.cached, false);
  assert.equal(calls.readSession, 1);

  const second = await (await route.fetch(new Request(`${URL_ROOT}${ROUTE}`))).json();
  assert.equal(second.cached, true);
  assert.equal(calls.listSessions, 1, 'the cached request must not rescan');
  assert.equal(calls.readSession, 1);

  const third = await (await route.fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
  assert.equal(third.cached, false);
  assert.equal(calls.listSessions, 2);
  assert.equal(calls.readSession, 1, 'the unchanged persisted session reuses its per-session analysis');
  assert.equal(third.totals.tokens.total, 6);
});

test('a changed persistence revision folds the session again', async () => {
  const { ctx, registered, addPersisted, calls, state } = fakeContext();
  addPersisted(HEADER_B, simpleTurn(1, NOW - 1000, NOW - 500, NOW - 100, { inputTokens: 5, outputTokens: 1 }));
  apply(ctx);
  const route = registered[0];

  await route.fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`));
  assert.equal(calls.readSession, 1);

  state.revision = 'rev-2';
  const record = state.records.find((entry) => entry.header.id === 's2');
  record.events = [
    ...record.events,
    ...simpleTurn(2, NOW - 90000, NOW - 80000, NOW - 70000, { inputTokens: 40, outputTokens: 10 }),
  ];
  const payload = await (await route.fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();
  assert.equal(calls.readSession, 2);
  assert.equal(payload.totals.tokens.input, 45);
  assert.equal(payload.totals.tokens.output, 11);
});

test('isolates one unreadable session as an error row instead of failing the request', async () => {
  const { ctx, registered, addLive, addPersisted, state } = fakeContext();
  addLive(HEADER_A, simpleTurn(1, NOW - 1000, NOW - 500, NOW - 100, { inputTokens: 1, outputTokens: 1 }));
  addPersisted(HEADER_B, simpleTurn(1, NOW - 1000, NOW - 500, NOW - 100, { inputTokens: 1, outputTokens: 1 }));
  addPersisted({ id: 's3', version: 4, createdAt: NOW - 1000, isSeeded: false }, []);
  state.failReadsFor = new Set(['s3']);
  apply(ctx);
  const payload = await (await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`))).json();

  assert.equal(payload.ok, true);
  assert.equal(payload.partial, true);
  assert.equal(payload.errors.length, 1);
  assert.equal(payload.errors[0].sessionId, 's3');
  assert.match(payload.errors[0].message, /corrupt session log/);
  assert.equal(payload.totals.sessions, 2);
});

test('reports a missing sessionQuery service as a 503', async () => {
  const { ctx, registered } = fakeContext();
  const withoutQuery = {
    connection: ctx.connection,
    effect: ctx.effect,
    get: (name) => (name === 'sessionQuery' ? undefined : ctx.get(name)),
  };
  apply(withoutQuery);
  const response = await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}?force=1`));
  assert.equal(response.status, 503);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.match(payload.error, /session query service is unavailable/);
});

test('refuses a non-GET request without touching the corpus', async () => {
  const { ctx, registered, calls } = fakeContext();
  apply(ctx);
  const response = await registered[0].fetch(new Request(`${URL_ROOT}${ROUTE}`, { method: 'POST' }));
  assert.equal(response.status, 405);
  const payload = await response.json();
  assert.equal(payload.ok, false);
  assert.equal(calls.listSessions, 0);
});

test('a profile without a browser surface still registers the tool and no route', () => {
  const effects = [];
  const tools = [];
  apply({
    get: (name) => (name === 'tools' ? { register: (definition) => { tools.push(definition); return () => {}; } } : undefined),
    effect: (callback) => { effects.push(callback()); },
    connection: undefined,
  });
  assert.equal(tools.length, 1);
  assert.equal(effects.length, 1);
});

test('the agent tool honours range/top and bounds its text', async () => {
  const { ctx, tools, addLive, addPersisted } = fakeContext();
  addLive(HEADER_A, simpleTurn(1, NOW - 5 * 60000, NOW - 4 * 60000, NOW - 3 * 60000, { inputTokens: 100, outputTokens: 20 }));
  addPersisted(HEADER_B, simpleTurn(1, NOW - 10 * DAY_MS, NOW - 10 * DAY_MS + 500, NOW - 10 * DAY_MS + 1000, { inputTokens: 900, outputTokens: 100 }));
  apply(ctx);
  assert.equal(tools.length, 1);
  const tool = tools[0];

  assert.equal(tool.parameters.type, 'object');
  assert.deepEqual(tool.parameters.properties.range.enum, Object.keys(RANGE_DAYS));
  assert.equal(tool.parameters.additionalProperties, false);
  assert.deepEqual(tool.output.schema, { type: 'object', additionalProperties: true });

  const all = await tool.execute({ top: 1, refresh: true });
  assert.equal(all.range, 'all');
  assert.equal(all.totals.sessions, 2);
  assert.equal(all.totals.tokens.total, 1120);
  assert.equal(all.sessions.length, 1);
  assert.equal(all.omitted, 1);
  assert.deepEqual(all.tools, []);
  assert.equal(typeof all.totals.humanWaitMs, 'number');

  const week = await tool.execute({ top: 20, range: '7d' });
  assert.equal(week.range, '7d');
  assert.equal(week.totals.sessions, 1);
  assert.equal(week.sessions.length, 1);
  assert.equal(week.omitted, 0);

  const blocks = tool.output.render({}, all);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].type, 'text');
  assert.match(blocks[0].text, /Conversation usage \(all\)/);
  assert.match(blocks[0].text, /Runtime split/);
  assert.match(blocks[0].text, /1 more conversation\(s\) omitted/);
});
