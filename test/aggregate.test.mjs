/**
 * Unit tests for the stateless folds in `lib/aggregate.js`.
 *
 * Expected values intentionally mirror the shipped projections (`tokenUsage`
 * from dsh-token-meter; the model-time/tool-time rules from dsh-session-stats)
 * plus the v2 additions: per-turn segmentation, ranges, trend buckets, tool
 * ranking, turn health and the inherited-fork-prefix mode.
 */
import assert from 'node:assert/strict';
import test from 'node:test';

import { analyzeSession, summarize } from '../lib/aggregate.js';

const DAY_MS = 86400000;
const HOUR_MS = 3600000;
const NOW = 1_800_000_000_000;

let seq = 0;

/**
 * Build one synthetic session event.
 * @param type - event type.
 * @param data - event payload.
 * @param time - event timestamp.
 * @returns the event envelope.
 */
function event(type, data, time) {
  seq += 1;
  return { type, seq, time, data };
}

/**
 * Header with sensible defaults.
 * @param overrides - header fields.
 * @returns a session header.
 */
function header(overrides = {}) {
  return { id: 'session-a', version: 4, createdAt: NOW - DAY_MS, cwd: '/work/project-alpha', isSeeded: false, ...overrides };
}

/**
 * An assistant message event with provider usage.
 * @param turn - turn number.
 * @param step - step number.
 * @param usage - provider usage.
 * @param time - event time.
 * @param route - provider/model.
 * @returns the event.
 */
function assistantMessage(turn, step, usage, time, route = { provider: 'deepseek-official', model: 'deepseek-flash' }) {
  return event('assistant/message', {
    turn,
    step,
    message: { role: 'assistant', source: { kind: 'model', ...route } },
    stream: [],
    ...(usage === undefined ? {} : { usage }),
  }, time);
}

/**
 * One complete turn: start → assistant → end, no tools.
 * @param turn - turn number.
 * @param start - start time.
 * @param messageTime - assistant message time.
 * @param end - end time.
 * @param usage - usage record.
 * @param reason - turn/end reason.
 * @returns the events.
 */
function simpleTurn(turn, start, messageTime, end, usage, reason = { kind: 'completed' }) {
  return [
    event('turn/start', { turn }, start),
    event('step/start', { turn, step: 1 }, start + 100),
    assistantMessage(turn, 1, usage, messageTime),
    event('step/end', { turn, step: 1 }, messageTime + 10),
    event('turn/end', { turn, reason }, end),
  ];
}

test('splits a turn into model / tool / human / other without overlap', () => {
  seq = 0;
  const events = [
    event('turn/start', { turn: 1 }, 2000),
    event('user/message', { message: { role: 'user', content: [] } }, 2050),
    event('step/start', { turn: 1, step: 1 }, 2100),
    assistantMessage(1, 1, { inputTokens: 100, outputTokens: 50, cacheReadTokens: 20, cacheWriteTokens: 5 }, 3000),
    event('step/end', { turn: 1, step: 1 }, 3010),
    event('tool/call', { turn: 1, step: 2, callId: 'call-1', name: 'bash', arguments: '{}' }, 3020),
    event('approval/asked', { id: 'a1', toolName: 'bash', callId: 'call-1', reason: 'run' }, 3100),
    event('approval/decided', { id: 'a1', outcome: 'allowed-once' }, 9100),
    event('tool/result', {
      turn: 1,
      step: 2,
      message: { role: 'tool', source: { kind: 'tool', callId: 'call-1' }, toolCallId: 'call-1', content: [] },
    }, 10000),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 11000),
  ];

  const session = analyzeSession(header(), events, { live: false, inheritedEventCount: 0 });
  const report = summarize([session], { now: NOW, range: 'all' });
  const { totals } = report;

  assert.equal(report.sessions.length, 1);
  assert.equal(session.turns.length, 1);
  assert.equal(session.turns[0].endKind, 'completed');
  assert.equal(session.turns[0].modelMs, 900);
  // 3020 → 10000 = 6980ms, minus the 6000ms approval wait = 980ms execution.
  assert.equal(session.turns[0].toolExecMs, 980);
  assert.equal(session.turns[0].humanWaitMs, 6000);
  assert.equal(totals.runTimeMs, 9000);
  assert.equal(totals.modelMs, 900);
  assert.equal(totals.toolMs, 980);
  assert.equal(totals.humanWaitMs, 6000);
  assert.equal(totals.otherMs, 1120);
  assert.equal(totals.modelMs + totals.toolMs + totals.humanWaitMs + totals.otherMs, totals.runTimeMs);
  assert.deepEqual(totals.tokens, { input: 100, output: 50, cacheRead: 20, cacheWrite: 5, prompt: 125, total: 175 });
  assert.equal(totals.cacheHitRate, 20 / 125);
  assert.deepEqual(report.tools, [{ name: 'bash', calls: 1, ms: 980, errors: 0 }]);
  assert.deepEqual(report.turnEnds, {
    completed: 1, aborted: 0, interrupted: 0, error: 0, maxTokens: 0, blocked: 0, forked: 0, other: 0, open: 0,
  });
});

test('human-answer tools count as human wait, not tool execution', () => {
  seq = 0;
  const events = [
    event('turn/start', { turn: 1 }, 1000),
    event('tool/call', { turn: 1, step: 1, callId: 'q1', name: 'ask_user_question', arguments: '{}' }, 2000),
    event('tool/result', {
      turn: 1,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'q1' }, toolCallId: 'q1', content: [] },
    }, 32000),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 33000),
  ];
  const session = analyzeSession(header(), events, { live: false });
  const report = summarize([session], { now: NOW });

  assert.equal(report.totals.toolMs, 0);
  assert.equal(report.totals.humanWaitMs, 30000);
  assert.equal(report.tools.length, 0, 'a pure human wait is not a tool-cost row');
});

test('token samples replace a re-reported attempt and add a retried one', () => {
  seq = 0;
  const usageChunk = (usage) => ({ type: 'chunk', time: 2500, chunk: { type: 'usage', usage } });
  const session = analyzeSession(header(), [
    event('turn/start', { turn: 1 }, 2000),
    event('step/start', { turn: 1, step: 1 }, 2100),
    event('assistant/attempt', { turn: 1, step: 1, stream: [usageChunk({ inputTokens: 100, outputTokens: 10 })] }, 2500),
    event('llm/retry-started', { turn: 1, step: 1, retry: 1 }, 2600),
    event('assistant/attempt', { turn: 1, step: 1, stream: [usageChunk({ inputTokens: 120, outputTokens: 20 })] }, 2800),
    assistantMessage(1, 1, { inputTokens: 130, outputTokens: 30 }, 3000),
    event('step/end', { turn: 1, step: 1 }, 3010),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 4000),
  ]);
  assert.deepEqual(session.turns[0].tokens, { input: 230, output: 40, cacheRead: 0, cacheWrite: 0 });

  seq = 0;
  const duplicate = analyzeSession(header(), [
    event('turn/start', { turn: 2 }, 100),
    assistantMessage(2, 1, { inputTokens: 10, outputTokens: 2 }, 110),
    assistantMessage(2, 1, { inputTokens: 10, outputTokens: 2 }, 120),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 130),
  ]);
  assert.deepEqual(duplicate.turns[0].tokens, { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 });
});

test('counts retries, turn endings and error tool results', () => {
  seq = 0;
  const events = [
    ...simpleTurn(1, 1000, 1500, 2000, { inputTokens: 1, outputTokens: 1 }, { kind: 'aborted', reason: { kind: 'user' } }),
    ...simpleTurn(2, 3000, 3500, 4000, undefined, { kind: 'error', error: { message: 'boom', code: 'E' } }),
    event('turn/start', { turn: 3 }, 5000),
    event('llm/retry', { retryId: 'r1', turn: 3, step: 1, retry: 1 }, 5100),
    event('tool/call', { turn: 3, step: 1, callId: 'c1', name: 'read', arguments: '{}' }, 5200),
    event('tool/result', {
      turn: 3,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [], isError: true },
      error: { name: 'FsError', code: 'ENOENT' },
    }, 5600),
    event('turn/end', { turn: 3, reason: { kind: 'max-tokens' } }, 6000),
  ];
  const session = analyzeSession(header(), events, { live: false });
  const report = summarize([session], { now: NOW });

  assert.equal(report.totals.retries, 1);
  assert.equal(report.turnEnds.aborted, 1);
  assert.equal(report.turnEnds.error, 1);
  assert.equal(report.turnEnds.maxTokens, 1);
  assert.deepEqual(report.tools, [{ name: 'read', calls: 1, ms: 400, errors: 1 }]);
});

test('an open turn counts to the report time when live, to its last event when persisted', () => {
  seq = 0;
  const openTurn = () => [
    event('turn/start', { turn: 1 }, NOW - 5000),
    event('user/message', { message: { role: 'user', content: [] } }, NOW - 4000),
  ];
  const live = summarize([analyzeSession(header(), openTurn(), { live: true })], { now: NOW });
  assert.equal(live.totals.runTimeMs, 5000);
  assert.equal(live.turnEnds.open, 1);

  const persisted = summarize([analyzeSession(header(), openTurn(), { live: false })], { now: NOW });
  assert.equal(persisted.totals.runTimeMs, 1000, 'a crashed tail counts only to its last recorded event');
});

test('excludes a fork inherited prefix by default and reports it separately', () => {
  seq = 0;
  const events = [
    // Inherited prefix (the first five events): a completed turn copied from the parent.
    ...simpleTurn(1, 1000, 1500, 2000, { inputTokens: 1000, outputTokens: 500 }),
    // Own activity.
    ...simpleTurn(2, 3000, 3500, 4000, { inputTokens: 10, outputTokens: 5 }),
  ];
  const inheritedEventCount = 5;
  const fork = analyzeSession(header({ id: 'fork', isSeeded: true }), events, { live: false, inheritedEventCount });
  assert.equal(fork.turns[0].inherited, true);
  assert.equal(fork.turns[1].inherited, false);

  const own = summarize([fork], { now: NOW, range: 'all', includeInherited: false });
  assert.equal(own.totals.tokens.total, 15);
  assert.equal(own.totals.sessions, 1);
  assert.equal(own.totals.inherited.tokens, 1500);
  assert.equal(own.totals.inherited.turns, 1);
  assert.equal(own.sessions[0].inherited.tokens, 1500);

  const withInherited = summarize([fork], { now: NOW, range: 'all', includeInherited: true });
  assert.equal(withInherited.totals.tokens.total, 1515);
  assert.equal(withInherited.totals.turns, 2);
  assert.equal(withInherited.totals.inherited.tokens, 1500, 'the annotation still says how much came from the parent');
});

test('a non-seeded resumed session folds its whole log (the prefix is its own history)', () => {
  seq = 0;
  const events = [
    ...simpleTurn(1, 1000, 1500, 2000, { inputTokens: 100, outputTokens: 50 }),
    event('session/end-seed', {}, 2001),
    ...simpleTurn(2, 3000, 3500, 4000, { inputTokens: 10, outputTokens: 5 }),
  ];
  const session = analyzeSession(header({ isSeeded: false }), events, { live: false, inheritedEventCount: 5 });
  const report = summarize([session], { now: NOW, range: 'all' });
  assert.equal(report.totals.tokens.total, 165);
  assert.equal(report.totals.inherited.tokens, 0);
});

test('filters turns by range and clips a boundary turn', () => {
  seq = 0;
  const events = [
    ...simpleTurn(1, NOW - 10 * DAY_MS, NOW - 10 * DAY_MS + 500, NOW - 10 * DAY_MS + 1000, { inputTokens: 1000, outputTokens: 1000 }),
    ...simpleTurn(2, NOW - 2 * DAY_MS, NOW - 2 * DAY_MS + 500, NOW - 2 * DAY_MS + 1000, { inputTokens: 10, outputTokens: 5 }),
    // Straddles the 7-day boundary: 10s long, only its last 5s are in range.
    ...simpleTurn(3, NOW - 7 * DAY_MS - 5000, NOW - 7 * DAY_MS - 4000, NOW - 7 * DAY_MS + 5000, { inputTokens: 2, outputTokens: 1 }),
  ];
  const session = analyzeSession(header(), events, { live: false });
  const report = summarize([session], {
    now: NOW,
    range: '7d',
    from: NOW - 7 * DAY_MS,
    to: NOW,
    trendUnit: 'day',
    trendCount: 7,
    offsetMinutes: 0,
  });

  assert.equal(report.sessions.length, 1);
  assert.equal(report.totals.turns, 2, 'the 10-day-old turn is outside the window');
  assert.equal(report.totals.runTimeMs, 1000 + 5000);
  assert.equal(report.totals.tokens.total, 15 + 3, 'tokens of an overlapping turn are counted whole');
  assert.equal(report.totals.steps, 2);
});

test('builds a padded local day trend with a session count per bucket', () => {
  seq = 0;
  const offsetMinutes = 480; // UTC+8
  const dayStart = (daysAgo) => {
    const localNow = NOW + offsetMinutes * 60000;
    const startLocal = Math.floor(localNow / DAY_MS) * DAY_MS;
    return startLocal - daysAgo * DAY_MS - offsetMinutes * 60000;
  };
  const sessions = [
    analyzeSession(header({ id: 'a' }), simpleTurn(1, dayStart(0) + 1000, dayStart(0) + 2000, dayStart(0) + 3000, { inputTokens: 10, outputTokens: 1 }), { live: false }),
    analyzeSession(header({ id: 'b' }), simpleTurn(1, dayStart(2) + 1000, dayStart(2) + 2000, dayStart(2) + 3000, { inputTokens: 20, outputTokens: 2 }), { live: false }),
    analyzeSession(header({ id: 'c' }), simpleTurn(1, dayStart(2) + 4000, dayStart(2) + 5000, dayStart(2) + 6000, { inputTokens: 5, outputTokens: 1 }), { live: false }),
  ];
  const report = summarize(sessions, {
    now: NOW,
    range: '7d',
    from: NOW - 7 * DAY_MS,
    to: NOW,
    offsetMinutes,
    trendUnit: 'day',
    trendCount: 7,
  });

  assert.equal(report.trend.buckets.length, 7);
  assert.equal(report.trend.buckets[6].tokens, 11);
  assert.equal(report.trend.buckets[6].sessions, 1);
  assert.equal(report.trend.buckets[4].tokens, 28);
  assert.equal(report.trend.buckets[4].sessions, 2);
  assert.equal(report.trend.buckets[5].tokens, 0);
  assert.equal(report.trend.buckets[4].start, dayStart(2));
});

test('builds 24 hourly buckets for the 1d range', () => {
  seq = 0;
  const session = analyzeSession(header(), simpleTurn(1, NOW - 2 * HOUR_MS, NOW - 2 * HOUR_MS + 500, NOW - 2 * HOUR_MS + 1000, { inputTokens: 7, outputTokens: 3 }), { live: false });
  const report = summarize([session], {
    now: NOW,
    range: '1d',
    from: NOW - DAY_MS,
    to: NOW,
    offsetMinutes: 0,
    trendUnit: 'hour',
    trendCount: 24,
  });
  assert.equal(report.trend.unit, 'hour');
  assert.equal(report.trend.buckets.length, 24);
  assert.equal(report.trend.buckets[21].tokens, 10);
});

test('aggregates tools and models across turns and sessions', () => {
  seq = 0;
  const sessionA = analyzeSession(header({ id: 'a', cwd: '/work/alpha' }), [
    ...simpleTurn(1, 1000, 1500, 2000, { inputTokens: 10, outputTokens: 1 }),
    event('turn/start', { turn: 2 }, 3000),
    event('tool/call', { turn: 2, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, 3100),
    event('tool/result', { turn: 2, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [] } }, 4100),
    event('tool/call', { turn: 2, step: 1, callId: 'c2', name: 'bash', arguments: '{}' }, 4200),
    event('tool/result', { turn: 2, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2', content: [], isError: true } }, 5200),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 5300),
  ], { live: false });
  const sessionB = analyzeSession(header({ id: 'b', cwd: '/work/beta' }), [
    ...simpleTurn(1, 1000, 1500, 2000, { inputTokens: 20, outputTokens: 2 }, { kind: 'completed' }),
    event('turn/start', { turn: 2 }, 2500),
    event('step/start', { turn: 2, step: 1 }, 2600),
    assistantMessage(2, 1, undefined, 2700, { provider: 'other', model: 'm2' }),
    event('step/end', { turn: 2, step: 1 }, 2710),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 2800),
  ], { live: false });

  const report = summarize([sessionA, sessionB], { now: NOW, range: 'all' });
  assert.deepEqual(report.tools, [{ name: 'bash', calls: 2, ms: 2000, errors: 1 }]);
  assert.deepEqual(
    report.models.map((model) => ({ provider: model.provider, model: model.model, calls: model.calls })),
    [
      { provider: 'deepseek-official', model: 'deepseek-flash', calls: 2 },
      { provider: 'other', model: 'm2', calls: 1 },
    ],
  );
  assert.deepEqual(
    report.sessions[0].models.map((model) => ({ provider: model.provider, model: model.model, calls: model.calls })),
    [{ provider: 'deepseek-official', model: 'deepseek-flash', calls: 1 }],
  );
  assert.equal(report.totals.sessions, 2);
  assert.equal(report.totals.steps, 3);
});

test('all-time includes empty conversations; a finite range does not', () => {
  seq = 0;
  const empty = analyzeSession(header({ id: 'empty', createdAt: NOW - 30 * DAY_MS }), [], { live: false });
  const active = analyzeSession(header({ id: 'active' }), simpleTurn(1, NOW - 1000, NOW - 500, NOW - 100, { inputTokens: 1, outputTokens: 1 }), { live: false });

  const all = summarize([empty, active], { now: NOW, range: 'all' });
  assert.equal(all.totals.sessions, 2);

  const week = summarize([empty, active], {
    now: NOW,
    range: '7d',
    from: NOW - 7 * DAY_MS,
    to: NOW,
    offsetMinutes: 0,
    trendUnit: 'day',
    trendCount: 7,
  });
  assert.equal(week.totals.sessions, 1);
  assert.equal(week.sessions[0].id, 'active');
});

test('parallel tool calls do not overdraw the runtime split', () => {
  seq = 0;
  const events = [
    event('turn/start', { turn: 1 }, 1000),
    event('step/start', { turn: 1, step: 1 }, 1100),
    assistantMessage(1, 1, { inputTokens: 1, outputTokens: 1 }, 2000),
    event('tool/call', { turn: 1, step: 1, callId: 'a', name: 'web_fetch', arguments: '{}' }, 2100),
    event('tool/call', { turn: 1, step: 1, callId: 'b', name: 'web_search', arguments: '{}' }, 2200),
    event('tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'a' }, toolCallId: 'a', content: [] } }, 5100),
    event('tool/result', { turn: 1, step: 1, message: { role: 'tool', source: { kind: 'tool', callId: 'b' }, toolCallId: 'b', content: [] } }, 4200),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 6000),
  ];
  const report = summarize([analyzeSession(header(), events, { live: false })], { now: NOW, range: 'all' });

  // Wall time 5000ms: 900ms model + 3000ms tool union + 1100ms other. The two
  // calls overlap, so summing their durations (3000 + 2000) would overdraw.
  assert.equal(report.totals.modelMs, 900);
  assert.equal(report.totals.toolMs, 3000);
  assert.equal(report.totals.humanWaitMs, 0);
  assert.equal(report.totals.otherMs, 1100);
  assert.equal(report.totals.modelMs + report.totals.toolMs + report.totals.humanWaitMs + report.totals.otherMs, report.totals.runTimeMs);
});

test('summarize of an empty corpus reports zeroed, nullable totals', () => {
  const report = summarize([], { now: NOW, range: 'all' });
  assert.equal(report.totals.sessions, 0);
  assert.equal(report.totals.runTimeMs, 0);
  assert.equal(report.totals.tokens.total, 0);
  assert.equal(report.totals.cacheHitRate, null);
  assert.equal(report.totals.firstActivityAt, null);
  assert.equal(report.totals.lastActivityAt, null);
  assert.equal(report.trend.unit, 'day');
  assert.deepEqual(report.sessions, []);
});

test('attributes token buckets to the request route', () => {
  seq = 0;
  const usageChunk = (usage) => ({ type: 'chunk', time: 1300, chunk: { type: 'usage', usage } });
  const events = [
    event('turn/start', { turn: 1 }, 1000),
    event('request/header', { header: { config: { provider: 'p', model: 'm1' } }, reason: 'initial' }, 1100),
    event('step/start', { turn: 1, step: 1 }, 1200),
    event('assistant/attempt', { turn: 1, step: 1, stream: [usageChunk({ inputTokens: 100, outputTokens: 10 })] }, 1300),
    event('llm/retry-started', { turn: 1, step: 1, retry: 1 }, 1400),
    event('assistant/attempt', { turn: 1, step: 1, stream: [usageChunk({ inputTokens: 120, outputTokens: 12 })] }, 1500),
    assistantMessage(1, 1, { inputTokens: 150, outputTokens: 15 }, 1600, { provider: 'p', model: 'm1' }),
    event('step/end', { turn: 1, step: 1 }, 1610),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, 2000),
    event('turn/start', { turn: 2 }, 3000),
    event('request/header', { header: { config: { provider: 'p', model: 'm2' } }, reason: 'initial' }, 3100),
    event('step/start', { turn: 2, step: 1 }, 3200),
    assistantMessage(2, 1, { inputTokens: 50, outputTokens: 5 }, 3300, { provider: 'p', model: 'm2' }),
    event('step/end', { turn: 2, step: 1 }, 3310),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, 4000),
  ];
  const session = analyzeSession(header(), events, { live: false });
  const modelOf = (route) => Object.values(session.turns[0].models).find((entry) => entry.model === route);
  const m1 = modelOf('m1');
  // attempt #1 (retried) stays counted; attempt #2 is replaced by the message.
  assert.deepEqual(m1.tokens, { input: 250, output: 25, cacheRead: 0, cacheWrite: 0 });
  assert.equal(m1.calls, 1);

  const report = summarize([session], { now: NOW, range: 'all' });
  const flash = report.models.find((model) => model.model === 'm1');
  assert.deepEqual(flash.tokens, {
    input: 250, output: 25, cacheRead: 0, cacheWrite: 0, prompt: 250, total: 275,
  });
  assert.equal(flash.calls, 1);
  const second = report.models.find((model) => model.model === 'm2');
  assert.equal(second.tokens.total, 55);
});

test('computes cost from the user price table and keeps unpriced models explicit', () => {
  seq = 0;
  const events = [
    ...simpleTurn(1, NOW - 2 * HOUR_MS, NOW - 2 * HOUR_MS + 500, NOW - 2 * HOUR_MS + 1000, { inputTokens: 100, outputTokens: 10 }),
  ];
  const pricy = analyzeSession(header({ id: 'priced' }), events, { live: false });
  const unpricedEvents = [
    event('turn/start', { turn: 1 }, NOW - HOUR_MS),
    event('step/start', { turn: 1, step: 1 }, NOW - HOUR_MS + 100),
    assistantMessage(1, 1, { inputTokens: 50, outputTokens: 5 }, NOW - HOUR_MS + 500, { provider: 'other', model: 'x' }),
    event('step/end', { turn: 1, step: 1 }, NOW - HOUR_MS + 600),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, NOW - HOUR_MS + 1000),
  ];
  const unpriced = analyzeSession(header({ id: 'unpriced' }), unpricedEvents, { live: false });

  const pricePerMillion = { input: 1_000_000, output: 2_000_000, cacheRead: 0, cacheWrite: 0 };
  const report = summarize([pricy, unpriced], {
    now: NOW,
    range: 'all',
    pricing: {
      configured: true,
      currency: 'CNY',
      budgetMonthly: 100,
      prices: { 'deepseek-official/*': pricePerMillion },
    },
  });

  assert.equal(report.totals.cost, 120, '100 input × 1 + 10 output × 2');
  assert.equal(report.totals.monthCost, 120);
  assert.equal(report.costing.configured, true);
  assert.equal(report.costing.currency, 'CNY');
  assert.deepEqual(report.costing.unpricedModels, ['other/x']);
  assert.equal(report.costing.budgetRatio, 1.2);

  const pricedModel = report.models.find((model) => model.model === 'deepseek-flash');
  assert.equal(pricedModel.cost, 120);
  const unpricedModel = report.models.find((model) => model.model === 'x');
  assert.equal(unpricedModel.cost, null);

  const pricedRow = report.sessions.find((row) => row.id === 'priced');
  const unpricedRow = report.sessions.find((row) => row.id === 'unpriced');
  assert.equal(pricedRow.cost, 120);
  assert.equal(unpricedRow.cost, null, 'a row with no priced tokens reports no cost');
  assert.equal(unpricedRow.unpriced, true);
  assert.equal(report.trend.buckets[report.trend.buckets.length - 1].cost, 120);

  const wildcard = summarize([pricy, unpriced], {
    now: NOW,
    range: 'all',
    pricing: { configured: true, currency: 'CNY', prices: { '*/*': pricePerMillion } },
  });
  assert.equal(wildcard.totals.cost, 120 + 60, 'the wildcard entry prices every route');

  const unconfigured = summarize([pricy], { now: NOW, range: 'all' });
  assert.equal(unconfigured.totals.cost, null);
  assert.equal(unconfigured.costing.configured, false);
  assert.equal(unconfigured.models[0].cost, null);
});

test('month-to-date cost is range-independent and feeds the budget', () => {
  seq = 0;
  const today = analyzeSession(header({ id: 'today' }), simpleTurn(
    1, NOW - 2 * HOUR_MS, NOW - 2 * HOUR_MS + 500, NOW - 2 * HOUR_MS + 1000,
    { inputTokens: 100, outputTokens: 10 },
  ), { live: false });
  const earlier = analyzeSession(header({ id: 'earlier' }), simpleTurn(
    1, NOW - 5 * DAY_MS, NOW - 5 * DAY_MS + 500, NOW - 5 * DAY_MS + 1000,
    { inputTokens: 50, outputTokens: 5 },
  ), { live: false });

  const pricing = {
    configured: true,
    currency: 'USD',
    budgetMonthly: 50,
    prices: { 'deepseek-official/*': { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 } },
  };
  const report = summarize([today, earlier], {
    now: NOW,
    range: '1d',
    from: NOW - DAY_MS,
    to: NOW,
    offsetMinutes: 0,
    trendUnit: 'hour',
    trendCount: 24,
    pricing,
  });

  assert.equal(report.totals.cost, 100, 'only the current-day turn is inside the range');
  assert.equal(report.totals.monthCost, 150, 'both turns are inside the current month');
  assert.equal(report.totals.monthTokens, 110 + 55);
  assert.equal(report.costing.budgetMonthly, 50);
  assert.equal(report.costing.budgetRatio, 3);
});

test('reports per-session tools and turn endings for the detail drawer', () => {
  seq = 0;
  const events = [
    ...simpleTurn(1, 1000, 1500, 2000, { inputTokens: 1, outputTokens: 1 }, { kind: 'completed' }),
    ...simpleTurn(2, 3000, 3500, 4000, undefined, { kind: 'error', error: { message: 'boom', code: 'E' } }),
    event('turn/start', { turn: 3 }, 5000),
    event('tool/call', { turn: 3, step: 1, callId: 'c1', name: 'bash', arguments: '{}' }, 5100),
    event('tool/result', {
      turn: 3,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c1' }, toolCallId: 'c1', content: [] },
    }, 5600),
    event('tool/call', { turn: 3, step: 1, callId: 'c2', name: 'read', arguments: '{}' }, 5700),
    event('tool/result', {
      turn: 3,
      step: 1,
      message: { role: 'tool', source: { kind: 'tool', callId: 'c2' }, toolCallId: 'c2', content: [], isError: true },
    }, 5800),
    event('turn/end', { turn: 3, reason: { kind: 'completed' } }, 6000),
  ];
  const report = summarize([analyzeSession(header(), events, { live: false })], { now: NOW, range: 'all' });
  const row = report.sessions[0];

  assert.deepEqual(row.tools, [
    { name: 'bash', calls: 1, ms: 500, errors: 0 },
    { name: 'read', calls: 1, ms: 100, errors: 1 },
  ]);
  assert.equal(row.turnEnds.completed, 2);
  assert.equal(row.turnEnds.error, 1);
  assert.equal(report.turnEnds.completed, 2);
  assert.equal(report.turnEnds.error, 1);
});

test('splits tokens into official peak and off-peak billing tiers', () => {
  seq = 0;
  const peak = Date.UTC(2027, 0, 4, 2, 0, 0); // Monday 02:00 UTC — peak
  const off = Date.UTC(2027, 0, 4, 5, 0, 0); // Monday 05:00 UTC — off-peak
  const events = [
    event('turn/start', { turn: 1 }, peak),
    event('step/start', { turn: 1, step: 1 }, peak + 100),
    assistantMessage(1, 1, { inputTokens: 1_000_000, outputTokens: 0 }, peak + 300),
    event('step/end', { turn: 1, step: 1 }, peak + 400),
    event('turn/end', { turn: 1, reason: { kind: 'completed' } }, peak + 500),
    event('turn/start', { turn: 2 }, off),
    event('step/start', { turn: 2, step: 1 }, off + 100),
    assistantMessage(2, 1, { inputTokens: 1_000_000, outputTokens: 0 }, off + 300),
    event('step/end', { turn: 2, step: 1 }, off + 400),
    event('turn/end', { turn: 2, reason: { kind: 'completed' } }, off + 500),
  ];
  const session = analyzeSession(header(), events, { live: false });
  const entry = Object.values(session.turns[0].models)[0];
  assert.deepEqual(entry.peakTokens, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(entry.offPeakTokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(entry.tokens, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });
  const second = Object.values(session.turns[1].models)[0];
  assert.deepEqual(second.peakTokens, { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
  assert.deepEqual(second.offPeakTokens, { input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 });

  const report = summarize([session], {
    now: peak,
    range: 'all',
    pricing: {
      configured: true,
      currency: 'CNY',
      prices: {
        'deepseek-official/deepseek-flash': {
          peak: { input: 2, output: 8 },
          offPeak: { input: 1, output: 4 },
        },
      },
    },
  });
  // 1M peak prompt at ¥2 + 1M off-peak prompt at ¥1.
  assert.equal(report.totals.cost, 3);
  assert.equal(report.models[0].cost, 3);
  assert.equal(report.totals.monthCost, 3);
});
