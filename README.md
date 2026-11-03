# @echovic/dsh-usage-stats

Conversation usage statistics for the DeepSeek Harness Web shell — a central
panel (and a matching agent tool) that answers *how much did my conversations
cost, where did the time go, and what is trending.*

```
┌ 用量统计 ───────────────────────────────────────────────────────────────────┐
│ 所有对话的运行时长、Token 与工具调用，直接折叠自持久会话日志                 │
│ [全部|30天|7天|今天]  [刷新]  [自动刷新]  [计入分支继承]      更新于 20:12   │
│                                                                             │
│  总 Token   总运行时长     对话数        步骤 / 工具调用                    │
│  7.25亿     14 小时 06 分   41           3,176 / 4,055                      │
│                                                                             │
│  Token 趋势 ▁▂▃█▆▃   (按日/按小时，柱上悬停看区间明细)                      │
│  运行时长构成 ████████ 模型 · 工具 · 等待你 · 其他                          │
│  Token 构成 ███████████░░░░░ 缓存命中率 99.3%                               │
│  工具消耗排行  bash 2912 次 / 3.4h …     轮次健康 完成 123 · 报错 5 · 重试 9 │
│  对话明细  [搜索…]  每个对话的时长、步骤、Token、占比，点击打开对话         │
└─────────────────────────────────────────────────────────────────────────────┘
```

## What it measures

Every figure is folded from the durable Session event log — the only source of
truth — and deliberately mirrors the accounting the Harness itself shows, so
the panel cannot disagree with a conversation's own usage pill:

| Figure | Definition |
|---|---|
| Token buckets | `assistant/message` / `assistant/attempt` usage, with a same-turn/same-step sample *replacing* the earlier one and `llm/retry-started` closing the replacement slot, so retried attempts add their own consumption. `inputTokens` is the uncached prompt bucket (the `tokenUsage` projection's convention); cache read/write are separate buckets. |
| Total tokens | uncached input + cache read + cache write + output |
| Cache hit rate | cache read ÷ prompt-side total |
| Runtime | wall-clock `turn/start` → `turn/end` spans, clipped to the selected range; an in-flight live turn counts up to now |
| Model time | `step/start` → `assistant/message` (a cancelled step contributes none) |
| Tool time | `tool/call` → matching `tool/result` by call id, as an **interval union** so parallel calls are not double counted |
| Human wait | `approval/asked` → `approval/decided` plus the whole duration of `ask_user_question` calls; approval waits that sit inside a tool interval are moved from tool time to human time |
| Other | the remainder after the three segments — queueing, retry backoff, gaps |
| Steps / turns | one per `step/end`; turns counted per `turn/start` |
| Tool ranking | per call id: execution time (minus human wait), calls, error results |
| Turn health | `turn/end.reason` histogram plus `llm/retry` count |
| Trend | turns bucketed by end time into local days (`all`/`30d`/`7d`) or hours (`1d`) |

The four runtime segments never overlap and always sum to the runtime: the fold
keeps each interval list and the report takes interval unions, because tools
run in parallel and an approval wait sits inside the tool call that asked for
it.

**Forked conversations**: a fork's inherited prefix was consumed in the parent,
so it is excluded from every total by default (the row still shows it as
`继承 X`, and the "计入分支继承" switch includes it). A *resumed* (not seeded)
session folds its whole log — that prefix is its own history.

There is no pricing/cost estimate: the Harness log does not carry prices, and a
hard-coded price table would be wrong the moment a provider changes.

## Architecture

```
package.json          dsh.bundle.patch + dsh.client { platform: web }
cordis.patch.yml      inserts the one Loader row ("usage-stats")
lib/aggregate.js      pure folds: events → per-turn records → range report
lib/index.js          Host half: scans the corpus, serves the route, registers the tool
lib/client.js         browser half: sidebar rail icon + central "main" panel
test/                 aggregate, route and browser-composition tests
```

**Host half** (`lib/index.js`):

- enumerates the logical corpus with `ctx.sessionQuery.listSessions()`;
- folds live sessions from memory (`ctx.sessions.get(id).snapshotEvents()`),
  persisted sessions through `sessionQuery.readSession(id)`;
- reuses a persisted session's per-turn analysis until its
  `sessionPersistence` revision changes, and serves the whole corpus from a
  short-lived TTL cache (15 s; `DSH_USAGE_STATS_TTL_MS` overrides it) with
  single-flight behind it. Range/inherited switches re-assemble the report
  from the cached corpus without re-reading logs;
- registers `GET /api/usage-stats.summary` through
  `ctx.connection.fetch.register`, inside the connection service's browser
  authentication fence — a same-origin `fetch` from the page is already
  authorised;
- registers the `conversation_usage` agent tool on the same corpus, so the
  panel and the agent read identical numbers.

Failure isolation: one unreadable/corrupt session becomes an entry in `errors`
and a warning row in the panel; the rest of the corpus still renders.

**Browser half** (`lib/client.js`):

- two slot registrations under one id (`usage-stats`):
  `sidebar.panellist` (the rail icon) and `main` (the central panel the sidebar
  addresses by that id);
- range control, auto refresh, inherited-prefix switch, token trend, four-way
  runtime split, tool ranking, turn health, sortable/searchable per-conversation
  table; clicking a conversation opens it through
  `ctx.get('uiWorkspace').openSession`;
- plain JS, no bundler; only `react` is required — no
  `@deepseek-ai/dsh-client-*` module import, which would blank the slot on
  drift;
- styles are inline and use only `--dsw-alias-*` theme tokens;
- all visible text goes through the Client locale service (zh + en);
- if the running Host half still serves the v1 payload (it needs an app
  restart to load new Host code), the panel renders the v1 cards/table with a
  restart notice instead of crashing on missing v2 fields.

## Route contract

```
GET /api/usage-stats.summary
    ?range=all|30d|7d|1d        (default all)
    &inherited=1                (include a fork's inherited prefix; default off)
    &offset=<minutes east UTC>  (local day/hour buckets; default 0)
    &force=1                    (bypass the corpus TTL cache)
→ 200 { ok, version: 2, cached, cacheAgeMs, ttlMs, generatedAt, scanMs,
        range, includeInherited, offsetMinutes,
        scope: { listed, analyzed, failed, live, subagents },
        totals: { sessions, liveSessions, subagentSessions,
                  runTimeMs, modelMs, toolMs, humanWaitMs, otherMs,
                  turns, steps, toolCalls, retries, userMessages,
                  assistantMessages,
                  tokens { input, output, cacheRead, cacheWrite, prompt, total },
                  cacheHitRate,
                  inherited { tokens, runTimeMs, turns, steps },
                  firstActivityAt, lastActivityAt },
        sessions: [ { id, title, createdAt, lastActiveAt, live, parentSession,
                      origin, delegationDepth, isSeeded, cwd, workspace,
                      agentPreset, eventCount, runTimeMs, modelMs, toolMs,
                      humanWaitMs, otherMs, turns, steps, toolCalls, retries,
                      userMessages, assistantMessages, tokens, cacheHitRate,
                      models, inherited } ],
        trend: { unit: 'day'|'hour', buckets: [ { start, tokens, runTimeMs,
                  steps, toolCalls, sessions } ] },
        tools: [ { name, calls, ms, errors } ],
        models: [ { provider, model, calls } ],
        turnEnds: { completed, aborted, interrupted, error, maxTokens,
                    blocked, forked, other, open },
        errors: [ { sessionId, message } ], partial }
→ 405 non-GET · 503 { ok: false, error }     (e.g. no sessionQuery service)
```

## Agent tool

`conversation_usage` takes
`{ top?: 1–20 (default 5), range?: 'all'|'30d'|'7d'|'1d', inherited?: boolean, refresh?: boolean }`
and returns the totals (with the runtime split and turn health), the
highest-consumption conversations and the costliest tools, with the omitted
count made explicit. Read-only.

## Install

```js
plugin_manager({ action: "install_bundle", target: "@echovic/dsh-usage-stats@0.2.0" })
// or, with the desktop app fully quit:
// dsh plugin --profile desktop add @echovic/dsh-usage-stats@0.2.0
```

The browser half hot-reloads on save. **A change to the Host half
(`lib/index.js`, `lib/aggregate.js`) needs one application restart**, because
Host modules are not hot-replaced; until then the panel shows the restart
notice and the v1 layout. The same restart is what activates a newly installed
Host version.

## Test

```sh
cd <checkout>
npm test
```

- `test/aggregate.test.mjs` — the folds against synthetic event logs: the
  four-way split (including parallel tools and approval-inside-tool), token
  replacement/retry semantics, turn endings, open turns, range clipping, local
  day/hour trend buckets, tool/model aggregation, and the inherited-prefix
  mode;
- `test/route.test.mjs` — `apply()` registration, the Fetch handler, range/
  inherited parameters, the corpus TTL cache, revision-aware per-session reuse,
  failure isolation and the agent tool;
- `test/client.test.mjs` — boots the real browser module in a `vm` with a
  stateful React double, renders the full v2 dashboard in zh and en (and the
  legacy v1 payload with its restart notice), asserting both slot
  registrations, complete locale dictionaries and theme-token-only colors.

## Known limits

- Token totals only count usage the provider reported in the log; sessions from
  providers that omit usage contribute zeros.
- Runtime is turn wall time — it includes human waits and queueing; the split
  separates the human part explicitly.
- `tools[].ms` is summed per-call execution time (workload), so parallel tool
  calls may sum past the wall-clock tool segment.
- The panel is a snapshot; a live conversation's last flush may trail by up to
  the cache window unless Refresh is pressed.
- Local day/hour buckets need the browser's timezone offset; a page that cannot
  report one gets UTC buckets.


## Published package

- repository: https://github.com/echoVic/dsh-usage-stats (tags: v0.2.0)
- npm: https://www.npmjs.com/package/@echovic/dsh-usage-stats
- install from npm: `plugin_manager({ action: "install_bundle", target: "@echovic/dsh-usage-stats@0.2.0" })`
- install from git: `plugin_manager({ action: "install_bundle", target: "github:owner/repo#v0.2.0" })`
  (any https git URL works too; the repository root must be this package)
- the bundle ships the Host half, the Web client half, the Loader patch, both
  locale files and the icon; there are no runtime dependencies and no build
  step.
- the Host half runs with the application's local permissions, so read a
  third-party bundle before installing it.
