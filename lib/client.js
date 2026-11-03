/**
 * Conversation usage statistics — browser half.
 *
 * A full central panel, addressed by the same id as its sidebar rail icon:
 *
 *   sidebar.panellist (list)  → the "usage-stats" icon
 *   main             (keyed)  → the panel addressed by that id
 *
 * The Host half folds the durable Session logs and serves one JSON report on
 * `api/usage-stats.summary` inside the connection service's browser fence, so a
 * same-origin `fetch` is already authorised. v2 adds range filtering, a token
 * trend, the four-way runtime split, a tool-cost ranking and turn health; the
 * panel degrades to the v1 layout with a restart notice when the running Host
 * half still serves the older payload.
 *
 * Deliberate constraints (per the Harness plugin practices):
 *   - plain JS, no bundler; the lazy factory's id equals the package name;
 *   - only `react` is required — never a `@deepseek-ai/dsh-client-*` package,
 *     which changes without notice and would blank this entry on drift;
 *   - inline styles reference only `--dsw-alias-*` theme tokens;
 *   - all visible text goes through the Client locale service (zh + en);
 *   - every service lookup is optional and the panel is wrapped in an error
 *     boundary, because a throwing slot entry blanks the slot.
 */
window.__ModuleLoader__.load({
  id: '@echovic/dsh-usage-stats',
  factory(require) {
    const React = require('react');
    const h = React.createElement;
    const { useCallback, useEffect, useMemo, useRef, useState } = React;

    /** One id binds the sidebar rail cell to the central panel it addresses. */
    const PANEL_ID = 'usage-stats';
    /** Locale namespace for every visible string in this plugin. */
    const NS = 'dsh-usage-stats';
    /** Browser-relative form of the route the Host half registers. */
    const ROUTE = 'api/usage-stats.summary';
    /** Payload contract this half renders fully; older payloads fall back. */
    const PAYLOAD_VERSION = 4;
    /** Auto-refresh cadence. */
    const AUTO_REFRESH_MS = 30000;
    /** Selectable time windows, mirrored by the Host half's `range` parameter. */
    const RANGES = ['all', '30d', '7d', '1d'];

    // ─── locale ────────────────────────────────────────────────────────────

    const DICT = {
      zh: {
        panel: '用量统计',
        subtitle: '所有对话的运行时长、Token 与工具调用，直接折叠自持久会话日志',
        refresh: '刷新',
        refreshing: '刷新中…',
        autoRefresh: '自动刷新',
        updated: '更新于 {time}',
        cached: '来自 {age}前的缓存',
        'range.label': '时间范围',
        'range.all': '全部',
        'range.30d': '30 天',
        'range.7d': '7 天',
        'range.1d': '今天',
        'inherited.toggle': '计入分支继承',
        'inherited.excluded': '已排除分支继承 {tokens} tokens',
        'inherited.included': '已含分支继承 {tokens} tokens',
        'card.tokens': '总 Token',
        'card.tokens.hint': '提示侧 {prompt} · 输出 {output}',
        'card.runtime': '总运行时长',
        'card.runtime.hint': '模型 {llm} · 工具 {tool}',
        'card.runtime.hint2': '模型 {model} · 工具 {tool} · 等待你 {human}',
        'card.sessions': '对话数',
        'card.sessions.hint': '活跃 {live} · 子代理 {subagents}',
        'card.activity': '步骤 / 工具调用',
        'card.activity.hint': '{steps} 步 · {tools} 次工具 · {turns} 轮',
        'trend.title': 'Token 趋势',
        'trend.daily': '按日',
        'trend.hourly': '按小时',
        'trend.empty': '所选区间内没有活动',
        'trend.bucketHint': '{label} · {tokens} tokens · 运行 {runtime} · {sessions} 个对话',
        'runtime.title': '运行时长构成',
        'runtime.model': '模型',
        'runtime.tool': '工具执行',
        'runtime.human': '等待你',
        'runtime.other': '其他',
        'runtime.note': '四段互不重叠，总和等于运行时长；审批等待从工具耗时中拆出，单独计时。',
        'tokens.title': 'Token 构成',
        'tokens.input': '未缓存输入',
        'tokens.cacheRead': '缓存读',
        'tokens.cacheWrite': '缓存写',
        'tokens.output': '输出',
        'tokens.cacheHit': '缓存命中率 {percent}',
        'tokens.empty': '还没有可统计的 Token',
        'tools.title': '工具消耗排行',
        'tools.empty': '所选区间内没有工具调用',
        'tools.name': '工具',
        'tools.calls': '调用',
        'tools.total': '总耗时',
        'tools.avg': '平均',
        'tools.errors': '失败率',
        'tools.share': '耗时占比',
        'turn.title': '轮次健康',
        'turn.completed': '完成',
        'turn.aborted': '中断',
        'turn.interrupted': '被打断',
        'turn.error': '报错',
        'turn.maxTokens': '超限',
        'turn.blocked': '阻塞',
        'turn.forked': '分叉',
        'turn.other': '其他',
        'turn.open': '进行中',
        'turn.retries': 'LLM 重试 {count} 次',
        'turn.empty': '所选区间内没有轮次',
        'table.title': '对话明细',
        'table.count': '{shown} / {total} 个对话',
        search: '搜索标题、ID、工作区…',
        'sort.tokens': '按 Token 排序',
        'sort.runtime': '按运行时长排序',
        'sort.activity': '按最近活动排序',
        'sort.title': '按标题排序',
        'column.session': '对话',
        'column.workspace': '工作区',
        'column.activity': '最近活动',
        'column.runtime': '运行时长',
        'column.steps': '步骤',
        'column.tokens': 'Token',
        'column.share': '占比',
        'row.live': '活跃',
        'row.subagent': '子代理',
        'row.fork': '分支',
        'row.seeded': '种子',
        'row.untitled': '未命名对话',
        'row.open': '打开对话',
        'row.moreModels': '+{count}',
        'row.inherited': '继承 {tokens}',
        'table.empty': '没有匹配的对话',
        'empty.title': '还没有可统计的对话',
        'empty.body': '发一条消息后再回来看看——统计会从会话日志里折叠出来。',
        'error.title': '无法读取统计数据',
        'error.retry': '重试',
        'error.partial': '{count} 个对话读取失败',
        'notice.dismiss': '关闭',
        'notice.openUnavailable': '当前页面没有提供会话导航，无法打开该对话。',
        'notice.openFailed': '打开对话失败：{message}',
        'notice.version': '插件前后端版本不一致，请重启应用一次。',
        'restart.title': '数据格式已升级，重启应用后启用新统计',
        'restart.body': '当前仍在运行旧版 Host 半边（v{version}）。重启应用后会出现时间范围筛选、Token 趋势、运行时长四段拆解、工具排行与轮次健康；已有的卡片与明细不受影响。',
        crash: '用量统计渲染失败：{message}',
        loading: '正在读取会话日志…',
        'footer.note': '运行时长按轮次起止累计并拆成模型/工具/等待/其他；Token 按提供方上报用量桶汇总；区间按轮次结束时间归属；分支继承默认不计入总消耗。',
        'models.title': '模型用量',
        'models.empty': '没有模型调用',
        'models.model': '模型',
        'models.calls': '调用',
        'models.input': '未缓存输入',
        'models.cacheRead': '缓存读',
        'models.output': '输出',
        'models.hit': '缓存命中',
        'models.cost': '费用',
        'models.share': 'Token 占比',
        'models.unknown': '未知模型',
        'models.note': '费用按价目表（每 100 万 tokens）估算；未配置价格的模型只统计 Token。',
        'cost.card': '预计费用',
        'cost.unconfigured': '配置价目表后显示费用',
        'cost.unconfiguredHint': '在 {path} 填写每 100 万 tokens 的价格',
        'cost.monthHint': '区间 {rangeCost} · 本月 {monthCost}',
        'cost.budgetHint': '本月 {percent} / 预算 {currency}{limit}',
        'cost.alertWarn': '本月费用已用 {percent}：{spent} / {limit} {currency}',
        'cost.alertOver': '本月费用已超出预算：{spent} / {limit} {currency}',
        'cost.unpriced': '{count} 个模型未配置价格（费用为部分统计）',
        'cost.sourceAuto': '官网价目表 · {currency} · {age}前更新',
        'cost.sourceCache': '官网价目表缓存 · {currency} · {age}前更新',
        'cost.sourceBundled': '内置官网价目表快照 · {currency}',
        'cost.sourceMixed': '官网价目表 + 手动覆盖 · {currency}',
        'cost.sourceManual': '手动价目表 · {currency}',
        'cost.peakNote': '按官网分时计价：高峰时段（北京时间工作日 9:00-12:00、14:00-18:00）用高峰价，其余时段用空闲价。',
        'cost.refreshHint': '点「刷新」会重新拉取官网价目表',
        'cost.refreshPrice': '刷新官网价格',
        'cost.refreshPriceHint': '重新拉取 api-docs.deepseek.com 的价目表（高峰/空闲分档），并更新价格来源与时间',
        'detail.title': '会话详情',
        'detail.open': '打开对话',
        'detail.close': '关闭',
        'detail.workspace': '工作区',
        'detail.created': '创建于 {time}',
        'detail.lastActive': '最近活动 {time}',
        'detail.retries': 'LLM 重试 {count} 次',
        'detail.noTools': '该区间内没有工具调用',
        'upgradePricing.title': '重启应用后启用官网价目表自动拉取',
        'upgradePricing.body': '当前 Host 半边仍是 v{version}。重启应用后会从官网自动拉取价目表（CNY/USD、高峰/空闲分时价），并显示价格来源与刷新时间。',
        'upgrade.title': '重启应用后启用模型用量、费用与单会话详情',
        'upgrade.body': '当前 Host 半边仍是 v{version}。重启应用后会出现按模型 Token/费用、月度预算告警和单会话详情抽屉；现有的趋势、构成与明细不受影响。',
        'duration.underSecond': '<1 秒',
        'duration.seconds': '{seconds} 秒',
        'duration.minutes': '{minutes} 分 {seconds} 秒',
        'duration.hours': '{hours} 小时 {minutes} 分',
        percent: '{value}%',
        count: '共 {count}',
        'ago.now': '刚刚',
        'ago.minutes': '{n} 分钟前',
        'ago.hours': '{n} 小时前',
        'ago.days': '{n} 天前',
        'ago.date': '{date}',
      },
      en: {
        panel: 'Usage',
        subtitle: 'Runtime, tokens and tool calls across every conversation, folded from the durable session logs',
        refresh: 'Refresh',
        refreshing: 'Refreshing…',
        autoRefresh: 'Auto refresh',
        updated: 'Updated {time}',
        cached: 'Cached, {age} old',
        'range.label': 'Time range',
        'range.all': 'All time',
        'range.30d': '30 days',
        'range.7d': '7 days',
        'range.1d': 'Today',
        'inherited.toggle': 'Include fork prefix',
        'inherited.excluded': 'Excluded inherited fork prefix: {tokens} tokens',
        'inherited.included': 'Inherited fork prefix included: {tokens} tokens',
        'card.tokens': 'Total tokens',
        'card.tokens.hint': 'Prompt {prompt} · output {output}',
        'card.runtime': 'Total runtime',
        'card.runtime.hint': 'Model {llm} · tools {tool}',
        'card.runtime.hint2': 'Model {model} · tools {tool} · waiting {human}',
        'card.sessions': 'Conversations',
        'card.sessions.hint': 'Live {live} · subagents {subagents}',
        'card.activity': 'Steps / tool calls',
        'card.activity.hint': '{steps} steps · {tools} tool calls · {turns} turns',
        'trend.title': 'Token trend',
        'trend.daily': 'Daily',
        'trend.hourly': 'Hourly',
        'trend.empty': 'No activity in the selected range',
        'trend.bucketHint': '{label} · {tokens} tokens · {runtime} runtime · {sessions} conversations',
        'runtime.title': 'Runtime composition',
        'runtime.model': 'Model',
        'runtime.tool': 'Tool execution',
        'runtime.human': 'Waiting for you',
        'runtime.other': 'Other',
        'runtime.note': 'The four segments do not overlap and sum to the runtime; approval waits are timed separately instead of counting as tool execution.',
        'tokens.title': 'Token mix',
        'tokens.input': 'Uncached input',
        'tokens.cacheRead': 'Cache read',
        'tokens.cacheWrite': 'Cache write',
        'tokens.output': 'Output',
        'tokens.cacheHit': 'Cache hit {percent}',
        'tokens.empty': 'No tokens recorded yet',
        'tools.title': 'Tool cost ranking',
        'tools.empty': 'No tool calls in the selected range',
        'tools.name': 'Tool',
        'tools.calls': 'Calls',
        'tools.total': 'Total',
        'tools.avg': 'Average',
        'tools.errors': 'Errors',
        'tools.share': 'Share of tool time',
        'turn.title': 'Turn health',
        'turn.completed': 'Completed',
        'turn.aborted': 'Aborted',
        'turn.interrupted': 'Interrupted',
        'turn.error': 'Errors',
        'turn.maxTokens': 'Max tokens',
        'turn.blocked': 'Blocked',
        'turn.forked': 'Forked',
        'turn.other': 'Other',
        'turn.open': 'In flight',
        'turn.retries': '{count} LLM retries',
        'turn.empty': 'No turns in the selected range',
        'table.title': 'Conversations',
        'table.count': '{shown} / {total} conversations',
        search: 'Search title, id or workspace…',
        'sort.tokens': 'Sort by tokens',
        'sort.runtime': 'Sort by runtime',
        'sort.activity': 'Sort by recent activity',
        'sort.title': 'Sort by title',
        'column.session': 'Conversation',
        'column.workspace': 'Workspace',
        'column.activity': 'Last active',
        'column.runtime': 'Runtime',
        'column.steps': 'Steps',
        'column.tokens': 'Tokens',
        'column.share': 'Share',
        'row.live': 'Live',
        'row.subagent': 'Subagent',
        'row.fork': 'Fork',
        'row.seeded': 'Seeded',
        'row.untitled': 'Untitled conversation',
        'row.open': 'Open conversation',
        'row.moreModels': '+{count}',
        'row.inherited': 'inherited {tokens}',
        'table.empty': 'No matching conversations',
        'empty.title': 'Nothing to measure yet',
        'empty.body': 'Send a message and come back — the figures are folded from the session logs.',
        'error.title': 'Could not read usage statistics',
        'error.retry': 'Retry',
        'error.partial': '{count} conversations could not be read',
        'notice.dismiss': 'Dismiss',
        'notice.openUnavailable': 'This page exposes no session navigation, so the conversation cannot be opened.',
        'notice.openFailed': 'Failed to open the conversation: {message}',
        'notice.version': 'The plugin halves are out of sync. Restart the application once.',
        'restart.title': 'The data format was upgraded — restart to enable the new statistics',
        'restart.body': 'The running Host half is still on v{version}. Restarting the app enables the time-range filter, the token trend, the four-way runtime split, the tool ranking and turn health. The existing cards and table keep working meanwhile.',
        crash: 'Usage panel failed to render: {message}',
        loading: 'Reading session logs…',
        'footer.note': 'Runtime is clipped to the selected range and split into model / tool / waiting / other; tokens use provider-reported usage buckets; ranges attribute a turn by its end time; a fork inherited prefix is excluded from totals by default.',
        'models.title': 'Model usage',
        'models.empty': 'No model calls in the selected range',
        'models.model': 'Model',
        'models.calls': 'Calls',
        'models.input': 'Uncached input',
        'models.cacheRead': 'Cache read',
        'models.output': 'Output',
        'models.hit': 'Cache hit',
        'models.cost': 'Cost',
        'models.share': 'Token share',
        'models.unknown': 'Unknown model',
        'models.note': 'Cost is estimated from the price table (per 1M tokens); unpriced models contribute tokens only.',
        'cost.card': 'Estimated cost',
        'cost.unconfigured': 'Configure a price table to show cost',
        'cost.unconfiguredHint': 'Fill prices per 1M tokens in {path}',
        'cost.monthHint': 'range {rangeCost} · month {monthCost}',
        'cost.budgetHint': 'month {percent} of budget {currency}{limit}',
        'cost.alertWarn': 'This month used {percent} of the budget: {spent} / {limit} {currency}',
        'cost.alertOver': 'This month is over budget: {spent} / {limit} {currency}',
        'cost.unpriced': '{count} unpriced model(s) — cost is partial',
        'cost.sourceAuto': 'Official price table · {currency} · updated {age} ago',
        'cost.sourceCache': 'Official price table cache · {currency} · updated {age} ago',
        'cost.sourceBundled': 'Bundled official snapshot · {currency}',
        'cost.sourceMixed': 'Official table + manual overrides · {currency}',
        'cost.sourceManual': 'Manual price table · {currency}',
        'cost.peakNote': 'Official time-of-day billing: peak rate during Beijing-time weekday 09:00-12:00 and 14:00-18:00, off-peak rate otherwise.',
        'cost.refreshHint': 'Refresh re-fetches the official price table',
        'cost.refreshPrice': 'Refresh official prices',
        'cost.refreshPriceHint': 'Re-fetch the price table from api-docs.deepseek.com (peak/off-peak tiers) and update the source and timestamp',
        'detail.title': 'Conversation detail',
        'detail.open': 'Open conversation',
        'detail.close': 'Close',
        'detail.workspace': 'Workspace',
        'detail.created': 'Created {time}',
        'detail.lastActive': 'Last active {time}',
        'detail.retries': '{count} LLM retries',
        'detail.noTools': 'No tool calls in the selected range',
        'upgradePricing.title': 'Restart to enable the official price table',
        'upgradePricing.body': 'The running Host half is still on v{version}. Restarting the app fetches the official price table automatically (CNY/USD, peak/off-peak tiers) and shows its source and refresh time.',
        'upgrade.title': 'Restart to enable model usage, cost and conversation detail',
        'upgrade.body': 'The running Host half is still on v{version}. Restarting the app enables per-model tokens and cost, the monthly budget alert and the conversation detail drawer. The existing trend, runtime split and table keep working meanwhile.',
        'duration.underSecond': '<1s',
        'duration.seconds': '{seconds}s',
        'duration.minutes': '{minutes}m {seconds}s',
        'duration.hours': '{hours}h {minutes}m',
        percent: '{value}%',
        count: '{count} total',
        'ago.now': 'just now',
        'ago.minutes': '{n}m ago',
        'ago.hours': '{n}h ago',
        'ago.days': '{n}d ago',
        'ago.date': '{date}',
      },
    };

    // ─── formatting ────────────────────────────────────────────────────────

    const TOKEN = (name) => `var(${name})`;

    /** Fallback translator used only if the slot supplies none. */
    function fallbackT(key, params) {
      if (params === undefined || params === null) return key;
      return `${key}(${Object.entries(params).map(([name, value]) => `${name}=${String(value)}`).join(',')})`;
    }

    /**
     * A best-effort Intl tag for the active Harness locale.
     * @param localeId - active locale id.
     * @returns an Intl locale tag.
     */
    function intlTagOf(localeId) {
      const id = typeof localeId === 'string' ? localeId : '';
      if (id.toLowerCase().startsWith('zh')) return 'zh-CN';
      if (id.toLowerCase().startsWith('en')) return 'en-US';
      return id.length > 0 ? id : 'en-US';
    }

    /**
     * Compact count: 1.2万 / 3.4M style via Intl, with a plain fallback.
     * @param value - count.
     * @param localeId - active locale id.
     * @returns display string.
     */
    function formatCompact(value, localeId) {
      const count = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      try {
        return new Intl.NumberFormat(intlTagOf(localeId), {
          notation: 'compact',
          compactDisplay: 'short',
          maximumFractionDigits: 1,
        }).format(count);
      } catch {
        if (count >= 1e9) return `${(count / 1e9).toFixed(1)}B`;
        if (count >= 1e6) return `${(count / 1e6).toFixed(1)}M`;
        if (count >= 1e3) return `${(count / 1e3).toFixed(1)}K`;
        return String(Math.round(count));
      }
    }

    /**
     * Exact count with locale grouping.
     * @param value - count.
     * @param localeId - active locale id.
     * @returns display string.
     */
    function formatExact(value, localeId) {
      const count = typeof value === 'number' && Number.isFinite(value) ? value : 0;
      try {
        return new Intl.NumberFormat(intlTagOf(localeId)).format(count);
      } catch {
        return String(Math.round(count));
      }
    }

    /**
     * Human duration at one meaningful granularity.
     * @param ms - milliseconds.
     * @param t - translator.
     * @returns display string.
     */
    function formatDuration(ms, t) {
      const total = typeof ms === 'number' && Number.isFinite(ms) && ms > 0 ? ms : 0;
      if (total < 1000) return t('duration.underSecond');
      const seconds = Math.round(total / 1000);
      if (seconds < 60) return t('duration.seconds', { seconds });
      const minutes = Math.floor(seconds / 60);
      if (minutes < 60) return t('duration.minutes', { minutes, seconds: seconds % 60 });
      return t('duration.hours', { hours: Math.floor(minutes / 60), minutes: minutes % 60 });
    }

    /**
     * Relative "last active" text; older than a month falls back to a date.
     * @param at - epoch milliseconds.
     * @param now - current epoch milliseconds.
     * @param t - translator.
     * @param localeId - active locale id.
     * @returns display string.
     */
    function formatRelative(at, now, t, localeId) {
      if (typeof at !== 'number' || !Number.isFinite(at) || at <= 0) return '';
      const delta = now - at;
      if (delta < 0) return t('ago.now');
      const minutes = Math.floor(delta / 60000);
      if (minutes < 1) return t('ago.now');
      if (minutes < 60) return t('ago.minutes', { n: minutes });
      const hours = Math.floor(minutes / 60);
      if (hours < 24) return t('ago.hours', { n: hours });
      const days = Math.floor(hours / 24);
      if (days < 31) return t('ago.days', { n: days });
      try {
        return t('ago.date', { date: new Date(at).toLocaleDateString(intlTagOf(localeId)) });
      } catch {
        return t('ago.days', { n: days });
      }
    }

    /**
     * Percentage text with at most one decimal.
     * @param ratio - 0..1 ratio or null.
     * @param t - translator.
     * @returns display string.
     */
    function formatPercent(ratio, t) {
      if (typeof ratio !== 'number' || !Number.isFinite(ratio)) return '—';
      const value = Math.round(Math.max(0, Math.min(1, ratio)) * 1000) / 10;
      return t('percent', { value: value.toFixed(value % 1 === 0 ? 0 : 1) });
    }

    /**
     * A short, stable session label for the id fallback line.
     * @param id - session id.
     * @returns at most 10 characters.
     */
    function shortId(id) {
      if (typeof id !== 'string' || id.length === 0) return '';
      const tail = id.includes('-') ? id.slice(id.lastIndexOf('-') + 1) : id;
      return tail.length > 10 ? tail.slice(0, 10) : tail;
    }

    /**
     * Axis label of one trend bucket.
     * @param start - bucket start epoch ms.
     * @param unit - 'day' | 'hour'.
     * @param localeId - active locale id.
     * @returns display label.
     */
    function formatBucketLabel(start, unit, localeId) {
      const date = new Date(start);
      if (unit === 'hour') return `${String(date.getHours()).padStart(2, '0')}:00`;
      try {
        return date.toLocaleDateString(intlTagOf(localeId), { month: 'numeric', day: 'numeric' });
      } catch {
        return `${date.getMonth() + 1}/${date.getDate()}`;
      }
    }

    // ─── styles (theme tokens only) ────────────────────────────────────────

    const S = {
      root: {
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        minWidth: 0,
        minHeight: 0,
        overflow: 'hidden',
        background: TOKEN('--dsw-alias-bg-base'),
        color: TOKEN('--dsw-alias-label-primary'),
        fontSize: 13,
      },
      scroll: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        overflowX: 'hidden',
        padding: '18px 24px 28px',
        display: 'flex',
        flexDirection: 'column',
        gap: 16,
        maxWidth: 1180,
        width: '100%',
        margin: '0 auto',
        boxSizing: 'border-box',
      },
      header: { display: 'flex', flexDirection: 'column', gap: 8, flex: '0 0 auto' },
      titleRow: { display: 'flex', alignItems: 'baseline', gap: 10, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 18, fontWeight: 600, letterSpacing: 0.2 },
      subtitle: { margin: 0, fontSize: 12.5, color: TOKEN('--dsw-alias-label-secondary') },
      actions: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      segments: {
        display: 'inline-flex',
        padding: 2,
        gap: 2,
        borderRadius: 8,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: TOKEN('--dsw-alias-bg-layer-1'),
      },
      segment: {
        padding: '4px 10px',
        fontSize: 11.5,
        borderRadius: 6,
        border: 'none',
        background: 'transparent',
        color: TOKEN('--dsw-alias-label-secondary'),
        cursor: 'pointer',
      },
      segmentActive: {
        background: TOKEN('--dsw-alias-brand-primary'),
        color: '#fff',
      },
      updated: { fontSize: 11.5, color: TOKEN('--dsw-alias-label-secondary') },
      button: {
        padding: '6px 13px',
        fontSize: 12,
        borderRadius: 8,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: TOKEN('--dsw-alias-bg-layer-1'),
        color: 'inherit',
        cursor: 'pointer',
      },
      buttonDisabled: { opacity: 0.55, cursor: 'default' },
      cardGrid: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
        gap: 12,
      },
      card: {
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        padding: '13px 15px',
        borderRadius: 12,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: TOKEN('--dsw-alias-bg-layer-1'),
        minWidth: 0,
      },
      cardLabel: { fontSize: 11.5, color: TOKEN('--dsw-alias-label-secondary'), display: 'flex', alignItems: 'center', gap: 6 },
      cardValue: { fontSize: 21, fontWeight: 600, lineHeight: 1.2, fontVariantNumeric: 'tabular-nums' },
      cardHint: {
        fontSize: 11.5,
        color: TOKEN('--dsw-alias-label-secondary'),
        fontVariantNumeric: 'tabular-nums',
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      section: {
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
        padding: '14px 16px',
        borderRadius: 12,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: TOKEN('--dsw-alias-bg-layer-1'),
        minWidth: 0,
      },
      sectionHead: { display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' },
      sectionTitle: { fontSize: 13, fontWeight: 600, margin: 0 },
      sectionHint: { fontSize: 11.5, color: TOKEN('--dsw-alias-label-secondary') },
      duo: {
        display: 'grid',
        gridTemplateColumns: 'repeat(auto-fit, minmax(330px, 1fr))',
        gap: 12,
        alignItems: 'start',
      },
      bar: {
        display: 'flex',
        height: 12,
        borderRadius: 999,
        overflow: 'hidden',
        background: TOKEN('--dsw-alias-bg-layer-2'),
      },
      barSegment: { height: '100%', minWidth: 2 },
      legend: { display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 11.5, color: TOKEN('--dsw-alias-label-secondary') },
      legendItem: { display: 'flex', alignItems: 'center', gap: 6 },
      dot: { width: 8, height: 8, borderRadius: 999, flex: '0 0 auto' },
      legendValue: { color: TOKEN('--dsw-alias-label-primary'), fontVariantNumeric: 'tabular-nums' },
      controls: { display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' },
      input: {
        flex: '1 1 220px',
        minWidth: 150,
        padding: '6px 10px',
        fontSize: 12,
        borderRadius: 8,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: TOKEN('--dsw-alias-bg-layer-2'),
        color: 'inherit',
        outline: 'none',
      },
      switch: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 7,
        fontSize: 11.5,
        color: TOKEN('--dsw-alias-label-secondary'),
        cursor: 'pointer',
        userSelect: 'none',
        padding: 0,
        border: 'none',
        background: 'transparent',
      },
      switchTrack: {
        width: 26,
        height: 15,
        borderRadius: 999,
        background: TOKEN('--dsw-alias-bg-layer-2'),
        border: `1px solid ${TOKEN('--dsw-alias-border-l2')}`,
        display: 'inline-flex',
        alignItems: 'center',
        padding: 1,
        boxSizing: 'border-box',
        transition: 'background 120ms ease',
      },
      switchKnob: {
        width: 11,
        height: 11,
        borderRadius: 999,
        background: TOKEN('--dsw-alias-label-secondary'),
        transition: 'transform 120ms ease, background 120ms ease',
      },
      trend: { display: 'flex', alignItems: 'flex-end', gap: 3, height: 84, paddingTop: 4 },
      trendSlot: {
        flex: '1 1 0',
        minWidth: 3,
        height: '100%',
        display: 'flex',
        alignItems: 'flex-end',
        borderRadius: 3,
        background: 'transparent',
      },
      trendBar: {
        width: '100%',
        minHeight: 2,
        borderRadius: 3,
        background: TOKEN('--dsw-alias-brand-primary'),
        opacity: 0.9,
        transition: 'opacity 120ms ease',
      },
      trendAxis: {
        display: 'flex',
        gap: 3,
        fontSize: 10,
        color: TOKEN('--dsw-alias-label-secondary'),
        fontVariantNumeric: 'tabular-nums',
      },
      trendTick: { flex: '1 1 0', minWidth: 3, textAlign: 'center', overflow: 'hidden', whiteSpace: 'nowrap' },
      tableWrap: {
        overflowX: 'auto',
        borderTop: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        marginTop: 2,
      },
      table: { width: '100%', borderCollapse: 'collapse', minWidth: 760 },
      th: {
        textAlign: 'left',
        fontSize: 11,
        fontWeight: 550,
        color: TOKEN('--dsw-alias-label-secondary'),
        padding: '9px 8px',
        whiteSpace: 'nowrap',
        borderBottom: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
      },
      thButton: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        cursor: 'pointer',
        whiteSpace: 'nowrap',
      },
      td: {
        padding: '9px 8px',
        fontSize: 12,
        borderBottom: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        verticalAlign: 'middle',
      },
      row: { cursor: 'pointer' },
      titleButton: {
        padding: 0,
        border: 'none',
        background: 'transparent',
        color: 'inherit',
        font: 'inherit',
        fontWeight: 550,
        textAlign: 'left',
        cursor: 'pointer',
        maxWidth: 360,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
        display: 'block',
      },
      titleId: { fontSize: 10.5, color: TOKEN('--dsw-alias-label-secondary') },
      badges: { display: 'inline-flex', gap: 5, alignItems: 'center', marginLeft: 6, verticalAlign: 'middle' },
      badge: {
        fontSize: 9.5,
        padding: '0 5px',
        lineHeight: '15px',
        borderRadius: 999,
        border: `1px solid ${TOKEN('--dsw-alias-border-l2')}`,
        color: TOKEN('--dsw-alias-label-secondary'),
        whiteSpace: 'nowrap',
        fontWeight: 500,
      },
      num: { fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' },
      muted: { fontSize: 11, color: TOKEN('--dsw-alias-label-secondary') },
      numMuted: { fontVariantNumeric: 'tabular-nums', color: TOKEN('--dsw-alias-label-secondary'), whiteSpace: 'nowrap' },
      shareCell: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 130 },
      shareTrack: {
        flex: '1 1 60px',
        height: 5,
        borderRadius: 999,
        background: TOKEN('--dsw-alias-bg-layer-2'),
        overflow: 'hidden',
        minWidth: 40,
      },
      shareFill: { height: '100%', background: TOKEN('--dsw-alias-brand-primary'), borderRadius: 999 },
      shareText: {
        fontSize: 11,
        color: TOKEN('--dsw-alias-label-secondary'),
        fontVariantNumeric: 'tabular-nums',
        minWidth: 34,
        textAlign: 'right',
      },
      footer: {
        display: 'flex',
        alignItems: 'center',
        gap: 12,
        flexWrap: 'wrap',
        fontSize: 11,
        color: TOKEN('--dsw-alias-label-secondary'),
        padding: '2px 2px 0',
      },
      notice: {
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        padding: '8px 12px',
        fontSize: 12,
        borderRadius: 10,
        border: `1px solid ${TOKEN('--dsw-alias-state-warn-primary')}`,
      },
      errorBox: {
        margin: '34px auto',
        maxWidth: 520,
        padding: '18px 20px',
        borderRadius: 12,
        border: `1px solid ${TOKEN('--dsw-alias-state-error-primary')}`,
        background: TOKEN('--dsw-alias-bg-layer-1'),
        display: 'flex',
        flexDirection: 'column',
        gap: 10,
      },
      errorTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
      emptyBox: {
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        gap: 8,
        padding: '46px 20px',
        textAlign: 'center',
        border: `1px dashed ${TOKEN('--dsw-alias-border-l1')}`,
        borderRadius: 12,
      },
      emptyTitle: { fontSize: 14, fontWeight: 600, margin: 0 },
      emptyBody: { fontSize: 12, color: TOKEN('--dsw-alias-label-secondary'), margin: 0, maxWidth: 420, lineHeight: 1.6 },
      linkButton: {
        padding: '3px 8px',
        fontSize: 11,
        borderRadius: 7,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      skeletonLine: { height: 10, borderRadius: 6, background: TOKEN('--dsw-alias-bg-layer-2') },
      chips: { display: 'flex', gap: 8, flexWrap: 'wrap' },
      chip: {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 6,
        padding: '2px 9px',
        fontSize: 11.5,
        borderRadius: 999,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        color: TOKEN('--dsw-alias-label-secondary'),
      },
      overlay: {
        position: 'fixed',
        inset: 0,
        zIndex: 60,
        display: 'flex',
        justifyContent: 'flex-end',
        background: 'color-mix(in srgb, #000 42%, transparent)',
      },
      drawer: {
        width: 'min(600px, 94vw)',
        height: '100%',
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        background: TOKEN('--dsw-alias-bg-overlay'),
        borderLeft: `1px solid ${TOKEN('--dsw-alias-border-l2')}`,
        boxShadow: '0 18px 48px rgb(0 0 0 / 32%)',
      },
      drawerHead: {
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '16px 18px 10px',
        borderBottom: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
      },
      drawerTitleBlock: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 0, flex: '1 1 auto' },
      drawerTitle: {
        margin: 0,
        fontSize: 15,
        fontWeight: 600,
        overflow: 'hidden',
        textOverflow: 'ellipsis',
        whiteSpace: 'nowrap',
      },
      drawerMeta: { fontSize: 11.5, color: TOKEN('--dsw-alias-label-secondary'), display: 'flex', gap: 10, flexWrap: 'wrap' },
      drawerBody: {
        flex: '1 1 auto',
        minHeight: 0,
        overflowY: 'auto',
        padding: '14px 18px 18px',
        display: 'flex',
        flexDirection: 'column',
        gap: 12,
      },
      drawerFooter: {
        display: 'flex',
        justifyContent: 'flex-end',
        gap: 8,
        padding: '12px 18px',
        borderTop: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
      },
      primaryButton: {
        padding: '7px 16px',
        fontSize: 12.5,
        fontWeight: 550,
        borderRadius: 8,
        border: '1px solid transparent',
        background: TOKEN('--dsw-alias-brand-primary'),
        color: '#fff',
        cursor: 'pointer',
      },
      iconButton: {
        padding: '2px 8px',
        fontSize: 16,
        lineHeight: '20px',
        borderRadius: 6,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
      },
      miniGrid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 8 },
      miniCard: {
        display: 'flex',
        flexDirection: 'column',
        gap: 3,
        padding: '9px 11px',
        borderRadius: 10,
        border: `1px solid ${TOKEN('--dsw-alias-border-l1')}`,
        background: TOKEN('--dsw-alias-bg-layer-1'),
      },
      miniLabel: { fontSize: 11, color: TOKEN('--dsw-alias-label-secondary') },
      miniValue: { fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' },
    };

    // Table columns: sortable keys are the ones a click can reorder.
    const COLUMNS = [
      { id: 'session', label: 'column.session', width: '30%', sort: 'title', align: 'left' },
      { id: 'workspace', label: 'column.workspace', width: '13%', sort: null, align: 'left' },
      { id: 'activity', label: 'column.activity', width: '12%', sort: 'activity', align: 'left' },
      { id: 'runtime', label: 'column.runtime', width: '12%', sort: 'runtime', align: 'right' },
      { id: 'steps', label: 'column.steps', width: '8%', sort: 'steps', align: 'right' },
      { id: 'tokens', label: 'column.tokens', width: '13%', sort: 'tokens', align: 'right' },
      { id: 'share', label: 'column.share', width: '12%', sort: null, align: 'right' },
    ];

    const SORT_LABELS = {
      tokens: 'sort.tokens',
      runtime: 'sort.runtime',
      activity: 'sort.activity',
      title: 'sort.title',
    };

    const TOKEN_SEGMENTS = [
      { key: 'input', label: 'tokens.input', color: TOKEN('--dsw-alias-brand-primary') },
      { key: 'cacheRead', label: 'tokens.cacheRead', color: TOKEN('--dsw-alias-state-success-primary') },
      { key: 'cacheWrite', label: 'tokens.cacheWrite', color: TOKEN('--dsw-alias-state-warn-primary') },
      { key: 'output', label: 'tokens.output', color: TOKEN('--dsw-alias-label-secondary') },
    ];

    const RUNTIME_SEGMENTS = [
      { key: 'model', label: 'runtime.model', color: TOKEN('--dsw-alias-brand-primary') },
      { key: 'tool', label: 'runtime.tool', color: TOKEN('--dsw-alias-state-success-primary') },
      { key: 'human', label: 'runtime.human', color: TOKEN('--dsw-alias-state-warn-primary') },
      { key: 'other', label: 'runtime.other', color: TOKEN('--dsw-alias-label-secondary') },
    ];

    const TURN_KINDS = [
      { key: 'completed', color: TOKEN('--dsw-alias-state-success-primary') },
      { key: 'aborted', color: TOKEN('--dsw-alias-state-warn-primary') },
      { key: 'interrupted', color: TOKEN('--dsw-alias-state-warn-primary') },
      { key: 'error', color: TOKEN('--dsw-alias-state-error-primary') },
      { key: 'maxTokens', color: TOKEN('--dsw-alias-state-warn-primary') },
      { key: 'blocked', color: TOKEN('--dsw-alias-state-idle-primary') },
      { key: 'forked', color: TOKEN('--dsw-alias-label-secondary') },
      { key: 'other', color: TOKEN('--dsw-alias-label-secondary') },
      { key: 'open', color: TOKEN('--dsw-alias-state-idle-primary') },
    ];

    // ─── components ────────────────────────────────────────────────────────

    /** Sidebar rail icon. Owner props: `{ size, active }`. */
    function InsightsIcon(props) {
      const size = props !== undefined && props !== null && Number.isFinite(props.size) ? props.size : 16;
      return h(
        'svg',
        {
          width: size,
          height: size,
          viewBox: '0 0 16 16',
          fill: 'none',
          stroke: 'currentColor',
          strokeWidth: 1.4,
          strokeLinecap: 'round',
          strokeLinejoin: 'round',
          'aria-hidden': true,
          style: { display: 'block' },
        },
        h('rect', { key: 'a', x: 1.9, y: 8.2, width: 2.9, height: 5.6, rx: 1 }),
        h('rect', { key: 'b', x: 6.55, y: 5.4, width: 2.9, height: 8.4, rx: 1 }),
        h('rect', { key: 'c', x: 11.2, y: 2.2, width: 2.9, height: 11.6, rx: 1 }),
      );
    }

    /** Keeps a render failure inside this panel instead of blanking the slot. */
    class PanelBoundary extends React.Component {
      constructor(props) {
        super(props);
        this.state = { error: null };
      }

      static getDerivedStateFromError(error) {
        return { error };
      }

      render() {
        if (this.state.error !== null) {
          const reason = this.state.error !== undefined && this.state.error !== null && this.state.error.message !== undefined
            ? String(this.state.error.message)
            : String(this.state.error);
          return h('div', { style: S.errorBox, role: 'alert' }, h('p', { style: S.errorTitle }, this.props.t('crash', { message: reason })));
        }
        return this.props.children;
      }
    }

    /** One headline figure. */
    function StatCard(props) {
      return h(
        'div',
        { style: S.card },
        h('div', { style: S.cardLabel }, props.label),
        h('div', { style: S.cardValue }, props.value),
        h('div', { style: S.cardHint, title: props.hintTitle ?? props.hint }, props.hint),
      );
    }

    /**
     * A generic zero-overlap segmented bar.
     * @param props - `{ segments: [{ key, label, value, color }], total }`.
     * @returns the bar element.
     */
    function SegmentedBar(props) {
      const { segments, total } = props;
      return h(
        'div',
        { style: S.bar, role: 'img', 'aria-label': props.ariaLabel ?? '' },
        segments.map((segment) => {
          const value = Number.isFinite(segment.value) ? segment.value : 0;
          if (value <= 0 || total <= 0) return null;
          return h('div', {
            key: segment.key,
            style: { ...S.barSegment, width: `${(value / total) * 100}%`, background: segment.color },
            title: `${segment.label}: ${props.formatValue === undefined ? value : props.formatValue(value)}`,
          });
        }),
      );
    }

    /** Stacked token composition bar plus a legend with exact numbers. */
    function TokenMix(props) {
      const { tokens, localeId, t, cacheHitRate } = props;
      const total = tokens !== null && tokens !== undefined && Number.isFinite(tokens.total) ? tokens.total : 0;
      const caption = total > 0 ? t('tokens.cacheHit', { percent: formatPercent(cacheHitRate, t) }) : t('tokens.empty');
      return h(
        'section',
        { style: S.section, 'data-usage-stats': 'token-mix' },
        h(
          'div',
          { style: S.sectionHead },
          h('h2', { style: S.sectionTitle }, t('tokens.title')),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: S.sectionHint }, caption),
        ),
        h(SegmentedBar, {
          segments: TOKEN_SEGMENTS.map((segment) => ({
            ...segment,
            label: t(segment.label),
            value: tokens !== null && tokens !== undefined && Number.isFinite(tokens[segment.key]) ? tokens[segment.key] : 0,
          })),
          total,
          formatValue: (value) => formatExact(value, localeId),
          ariaLabel: t('tokens.title'),
        }),
        h(
          'div',
          { style: S.legend },
          TOKEN_SEGMENTS.map((segment) => {
            const value = tokens !== null && tokens !== undefined && Number.isFinite(tokens[segment.key]) ? tokens[segment.key] : 0;
            return h(
              'span',
              { key: segment.key, style: S.legendItem },
              h('span', { style: { ...S.dot, background: segment.color } }),
              h('span', null, t(segment.label)),
              h('span', { style: S.legendValue }, formatCompact(value, localeId)),
            );
          }),
        ),
      );
    }

    /**
     * Token trend over the selected window, one bar per bucket.
     * @param props - `{ trend, t, localeId }`.
     * @returns the section.
     */
    function TrendChart(props) {
      const { trend, t, localeId } = props;
      const buckets = trend !== null && trend !== undefined && Array.isArray(trend.buckets) ? trend.buckets : [];
      const unit = trend !== null && trend !== undefined && trend.unit === 'hour' ? 'hour' : 'day';
      const total = buckets.reduce((sum, bucket) => sum + (Number.isFinite(bucket.tokens) ? bucket.tokens : 0), 0);
      const max = buckets.reduce((top, bucket) => Math.max(top, Number.isFinite(bucket.tokens) ? bucket.tokens : 0), 0);
      const title = `${t('trend.title')} · ${unit === 'hour' ? t('trend.hourly') : t('trend.daily')}`;

      if (buckets.length === 0 || total === 0) {
        return h(
          'section',
          { style: S.section, 'data-usage-stats': 'trend' },
          h('div', { style: S.sectionHead }, h('h2', { style: S.sectionTitle }, title)),
          h('div', { style: S.sectionHint }, t('trend.empty')),
        );
      }

      const tickEvery = Math.max(1, Math.ceil(buckets.length / 7));
      const bars = buckets.map((bucket, index) => {
        const label = formatBucketLabel(bucket.start, unit, localeId);
        const tokens = Number.isFinite(bucket.tokens) ? bucket.tokens : 0;
        const ratio = max > 0 ? tokens / max : 0;
        const hint = t('trend.bucketHint', {
          label,
          tokens: formatCompact(tokens, localeId),
          runtime: formatDuration(bucket.runTimeMs, t),
          sessions: bucket.sessions ?? 0,
        });
        return h(
          'div',
          { key: `${bucket.start}-${index}`, style: S.trendSlot, title: hint },
          tokens > 0
            ? h('div', { style: { ...S.trendBar, height: `${Math.max(3, ratio * 100)}%` } })
            : null,
        );
      });
      const axis = buckets.map((bucket, index) => h(
        'span',
        { key: `${bucket.start}-${index}`, style: S.trendTick },
        index % tickEvery === 0 ? formatBucketLabel(bucket.start, unit, localeId) : '',
      ));

      return h(
        'section',
        { style: S.section, 'data-usage-stats': 'trend' },
        h(
          'div',
          { style: S.sectionHead },
          h('h2', { style: S.sectionTitle }, title),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: S.sectionHint }, `${formatCompact(total, localeId)} tokens`),
        ),
        h('div', { style: S.trend }, bars),
        h('div', { style: S.trendAxis }, axis),
      );
    }

    /**
     * The four-way runtime split: model / tool execution / human wait / other.
     * @param props - `{ totals, t }`.
     * @returns the section.
     */
    function RuntimeBreakdown(props) {
      const { totals, t } = props;
      const modelMs = Number.isFinite(totals.modelMs) ? totals.modelMs : Number.isFinite(totals.llmMs) ? totals.llmMs : 0;
      const toolMs = Number.isFinite(totals.toolMs) ? totals.toolMs : 0;
      const humanMs = Number.isFinite(totals.humanWaitMs) ? totals.humanWaitMs : 0;
      const otherMs = Number.isFinite(totals.otherMs) ? totals.otherMs : 0;
      const values = { model: modelMs, tool: toolMs, human: humanMs, other: otherMs };
      const total = modelMs + toolMs + humanMs + otherMs;
      return h(
        'section',
        { style: S.section, 'data-usage-stats': 'runtime' },
        h(
          'div',
          { style: S.sectionHead },
          h('h2', { style: S.sectionTitle }, t('runtime.title')),
          h('span', { style: { flex: '1 1 auto' } }),
          h('span', { style: S.sectionHint }, formatDuration(total, t)),
        ),
        h(SegmentedBar, {
          segments: RUNTIME_SEGMENTS.map((segment) => ({
            ...segment,
            label: t(segment.label),
            value: values[segment.key],
          })),
          total,
          formatValue: (value) => formatDuration(value, t),
          ariaLabel: t('runtime.title'),
        }),
        h(
          'div',
          { style: S.legend },
          RUNTIME_SEGMENTS.map((segment) => h(
            'span',
            { key: segment.key, style: S.legendItem },
            h('span', { style: { ...S.dot, background: segment.color } }),
            h('span', null, t(segment.label)),
            h('span', { style: S.legendValue }, formatDuration(values[segment.key], t)),
            total > 0 ? h('span', null, formatPercent(values[segment.key] / total, t)) : null,
          )),
        ),
        h('div', { style: S.sectionHint }, t('runtime.note')),
      );
    }

    /**
     * Tool cost ranking table.
     * @param props - `{ tools, t, localeId }`.
     * @returns the section.
     */
    function ToolRanking(props) {
      const { tools, t, localeId } = props;
      const list = Array.isArray(tools) ? tools.slice(0, 8) : [];
      const totalMs = list.reduce((sum, tool) => sum + (Number.isFinite(tool.ms) ? tool.ms : 0), 0);
      const header = h('div', { style: S.sectionHead }, h('h2', { style: S.sectionTitle }, t('tools.title')));
      if (list.length === 0) {
        return h('section', { style: S.section, 'data-usage-stats': 'tools' }, header, h('div', { style: S.sectionHint }, t('tools.empty')));
      }
      return h(
        'section',
        { style: S.section, 'data-usage-stats': 'tools' },
        header,
        h(
          'div',
          { style: S.tableWrap },
          h(
            'table',
            { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, t('tools.name')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('tools.calls')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('tools.total')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('tools.avg')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('tools.errors')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('tools.share')),
            )),
            h('tbody', null, list.map((tool) => {
              const calls = Number.isFinite(tool.calls) ? tool.calls : 0;
              const errors = Number.isFinite(tool.errors) ? tool.errors : 0;
              const share = totalMs > 0 ? (tool.ms ?? 0) / totalMs : 0;
              return h(
                'tr',
                { key: tool.name, title: t('tools.share') },
                h('td', { style: S.td }, h('span', { style: S.num }, tool.name)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatExact(calls, localeId)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatDuration(tool.ms, t)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatDuration(calls > 0 ? (tool.ms ?? 0) / calls : 0, t)),
                h('td', { style: { ...S.td, textAlign: 'right' } }, calls > 0
                  ? h('span', { style: { ...S.numMuted, color: errors > 0 ? TOKEN('--dsw-alias-state-error-primary') : TOKEN('--dsw-alias-label-secondary') } }, formatPercent(errors / calls, t))
                  : '—'),
                h('td', { style: { ...S.td, textAlign: 'right' } }, h('div', { style: { ...S.shareCell, justifyContent: 'flex-end' } },
                  h('div', { style: S.shareTrack }, h('div', { style: { ...S.shareFill, width: `${Math.min(100, share * 100).toFixed(1)}%` } })),
                  h('span', { style: S.shareText }, formatPercent(share, t)),
                )),
              );
            })),
          ),
        ),
      );
    }

    /**
     * Per-model usage table: tokens per bucket, calls, cache hit and (when a
     * price table is configured) estimated cost, ranked by token volume.
     * @param props - `{ models, t, localeId, currency, configured, totalTokens }`.
     * @returns the section.
     */
    function ModelRanking(props) {
      const { models, t, localeId, currency, configured, totalTokens } = props;
      const list = Array.isArray(models) ? models.slice(0, 10) : [];
      const header = h(
        'div',
        { style: S.sectionHead },
        h('h2', { style: S.sectionTitle }, t('models.title')),
        h('span', { style: { flex: '1 1 auto' } }),
        h('span', { style: S.sectionHint }, configured ? t('models.note') : t('cost.unconfiguredHint', { path: '~/.dsh/usage-stats/prices.json' })),
      );
      if (list.length === 0) {
        return h('section', { style: S.section, 'data-usage-stats': 'models' }, header, h('div', { style: S.sectionHint }, t('models.empty')));
      }
      const shareTotal = typeof totalTokens === 'number' && totalTokens > 0
        ? totalTokens
        : list.reduce((sum, model) => sum + (model.tokens?.total ?? 0), 0);
      return h(
        'section',
        { style: S.section, 'data-usage-stats': 'models' },
        header,
        h(
          'div',
          { style: S.tableWrap },
          h(
            'table',
            { style: S.table },
            h('thead', null, h('tr', null,
              h('th', { style: S.th }, t('models.model')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('models.calls')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('models.input')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('models.cacheRead')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('models.output')),
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('models.hit')),
              configured ? h('th', { style: { ...S.th, textAlign: 'right' } }, t('models.cost')) : null,
              h('th', { style: { ...S.th, textAlign: 'right' } }, t('models.share')),
            )),
            h('tbody', null, list.map((model) => {
              const tokens = model.tokens ?? {};
              const total = Number.isFinite(tokens.total) ? tokens.total : 0;
              const share = shareTotal > 0 ? Math.min(1, total / shareTotal) : 0;
              const label = model.provider === null || model.provider === undefined
                ? t('models.unknown')
                : `${model.provider}/${model.model}`;
              const costText = configured ? formatCost(model.cost, currency) : null;
              return h(
                'tr',
                { key: label, title: label },
                h('td', { style: S.td }, h('span', { style: S.num }, label)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatExact(model.calls ?? 0, localeId)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatCompact(tokens.input ?? 0, localeId)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatCompact(tokens.cacheRead ?? 0, localeId)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatCompact(tokens.output ?? 0, localeId)),
                h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, formatPercent(model.cacheHitRate, t)),
                configured
                  ? h('td', { style: { ...S.td, ...S.num, textAlign: 'right' } }, costText)
                  : null,
                h('td', { style: { ...S.td, textAlign: 'right' } }, h('div', { style: { ...S.shareCell, justifyContent: 'flex-end' } },
                  h('div', { style: S.shareTrack }, h('div', { style: { ...S.shareFill, width: `${(share * 100).toFixed(1)}%` } })),
                  h('span', { style: S.shareText }, formatPercent(share, t)),
                )),
              );
            })),
          ),
        ),
      );
    }

    /**
     * Turn health: how turns ended, plus LLM retries.
     * @param props - `{ turnEnds, retries, t }`.
     * @returns the section.
     */
    function TurnHealth(props) {
      const { turnEnds, retries, t } = props;
      const histogram = turnEnds !== null && turnEnds !== undefined && typeof turnEnds === 'object' ? turnEnds : {};
      const total = TURN_KINDS.reduce((sum, kind) => sum + (Number.isFinite(histogram[kind.key]) ? histogram[kind.key] : 0), 0);
      const header = h('div', { style: S.sectionHead }, h('h2', { style: S.sectionTitle }, t('turn.title')));
      if (total === 0) {
        return h('section', { style: S.section, 'data-usage-stats': 'turns' }, header, h('div', { style: S.sectionHint }, t('turn.empty')));
      }
      return h(
        'section',
        { style: S.section, 'data-usage-stats': 'turns' },
        header,
        h(SegmentedBar, {
          segments: TURN_KINDS.map((kind) => ({
            key: kind.key,
            label: t(`turn.${kind.key}`),
            value: Number.isFinite(histogram[kind.key]) ? histogram[kind.key] : 0,
            color: kind.color,
          })),
          total,
          ariaLabel: t('turn.title'),
        }),
        h(
          'div',
          { style: S.chips },
          TURN_KINDS.filter((kind) => Number.isFinite(histogram[kind.key]) && histogram[kind.key] > 0).map((kind) => h(
            'span',
            { key: kind.key, style: S.chip },
            h('span', { style: { ...S.dot, background: kind.color } }),
            h('span', null, t(`turn.${kind.key}`)),
            h('span', { style: { ...S.legendValue, fontSize: 11.5 } }, String(histogram[kind.key])),
          )),
          Number.isFinite(retries) && retries > 0
            ? h('span', { key: 'retries', style: S.chip }, t('turn.retries', { count: retries }))
            : null,
        ),
      );
    }

    /**
     * One session row.
     */
    function SessionRow(props) {
      const { row, now, localeId, t, grandTotal, onOpen, hovered, onHover, includeInherited, showCost, currency } = props;
      const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : t('row.untitled');
      const tokens = row.tokens !== null && row.tokens !== undefined ? row.tokens : {};
      const total = Number.isFinite(tokens.total) ? tokens.total : 0;
      const share = grandTotal > 0 ? Math.max(0, Math.min(1, total / grandTotal)) : 0;
      const exactTitle = [
        row.title !== null && row.title !== undefined ? row.title : row.id,
        t('row.open'),
      ].join(' — ');

      const badges = [];
      if (row.live === true) {
        badges.push(h('span', { key: 'live', style: { ...S.badge, color: TOKEN('--dsw-alias-state-success-primary'), borderColor: TOKEN('--dsw-alias-state-success-primary') } }, t('row.live')));
      }
      if (row.origin === 'subagent') badges.push(h('span', { key: 'sub', style: S.badge }, t('row.subagent')));
      if (row.parentSession !== null && row.parentSession !== undefined) badges.push(h('span', { key: 'fork', style: S.badge }, t('row.fork')));
      else if (row.isSeeded === true) badges.push(h('span', { key: 'seed', style: S.badge }, t('row.seeded')));

      const topModels = Array.isArray(row.models) ? row.models.slice(0, 1) : [];
      const modelLabel = topModels.length > 0 ? `${topModels[0].provider}/${topModels[0].model}` : '';
      const moreModels = Array.isArray(row.models) && row.models.length > 1 ? row.models.length - 1 : 0;
      const inheritedTokens = row.inherited !== null && row.inherited !== undefined && Number.isFinite(row.inherited.tokens) ? row.inherited.tokens : 0;
      const subline = [
        shortId(row.id),
        modelLabel,
        moreModels > 0 ? t('row.moreModels', { count: moreModels }) : '',
        showCost === true && Number.isFinite(row.cost) ? formatCost(row.cost, currency) : '',
        inheritedTokens > 0 && includeInherited !== true ? t('row.inherited', { tokens: formatCompact(inheritedTokens, localeId) }) : '',
      ].filter((part) => part.length > 0).join(' · ');

      const cells = [
        h(
          'td',
          { key: 'session', style: { ...S.td, maxWidth: 380 } },
          h(
            'button',
            {
              type: 'button',
              style: S.titleButton,
              title: exactTitle,
              onClick: (event) => {
                event.stopPropagation();
                onOpen(row.id);
              },
            },
            title,
          ),
          h('span', { style: S.badges }, badges),
          h('div', { style: S.titleId }, subline),
        ),
        h('td', { key: 'workspace', style: S.td }, h('span', { style: S.numMuted, title: row.cwd ?? '' }, row.workspace ?? '')),
        h('td', { key: 'activity', style: { ...S.td, ...S.numMuted } }, formatRelative(row.lastActiveAt, now, t, localeId)),
        h('td', { key: 'runtime', style: { ...S.td, ...S.num, textAlign: 'right' } }, formatDuration(row.runTimeMs, t)),
        h('td', { key: 'steps', style: { ...S.td, ...S.num, textAlign: 'right' } }, String(row.steps ?? 0)),
        h(
          'td',
          { key: 'tokens', style: { ...S.td, textAlign: 'right' } },
          h('div', { style: S.num, title: `↑${formatExact(tokens.input ?? 0, localeId)} / ↘${formatExact(tokens.output ?? 0, localeId)}` }, formatCompact(total, localeId)),
          h('div', { style: S.numMuted }, `↑${formatCompact(tokens.input ?? 0, localeId)} ↓${formatCompact(tokens.output ?? 0, localeId)}`),
        ),
        h(
          'td',
          { key: 'share', style: { ...S.td, textAlign: 'right' } },
          h(
            'div',
            { style: { ...S.shareCell, justifyContent: 'flex-end' } },
            h('div', { style: S.shareTrack }, h('div', { style: { ...S.shareFill, width: `${(share * 100).toFixed(1)}%` } })),
            h('span', { style: S.shareText }, formatPercent(share, t)),
          ),
        ),
      ];

      return h(
        'tr',
        {
          style: hovered ? { ...S.row, background: TOKEN('--dsw-alias-bg-layer-2') } : S.row,
          onClick: () => onOpen(row.id),
          onMouseEnter: () => onHover(row.id),
          onMouseLeave: () => onHover(null),
        },
        cells,
      );
    }

    /** The conversation table: header sorting, row hover, token share bars. */
    function SessionTable(props) {
      const { rows, totalCount, grandTotal, now, localeId, t, sort, onSort, onOpen, includeInherited, showCost, currency } = props;
      const [hovered, setHovered] = useState(null);

      const head = COLUMNS.map((column) => {
        const active = column.sort !== null && sort.key === column.sort;
        const arrow = active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : '';
        const content = active
          ? h('span', { style: { color: TOKEN('--dsw-alias-label-primary') } }, t(column.label) + arrow)
          : t(column.label);
        return h(
          'th',
          { key: column.id, style: { ...S.th, width: column.width, textAlign: column.align } },
          column.sort === null
            ? content
            : h(
                'button',
                {
                  type: 'button',
                  style: S.thButton,
                  onClick: () => onSort(column.sort),
                  'aria-label': t(SORT_LABELS[column.sort] ?? 'sort.activity'),
                  title: t(SORT_LABELS[column.sort] ?? 'sort.activity'),
                },
                content,
              ),
        );
      });

      const body = rows.map((row) => h(SessionRow, {
        key: row.id,
        row,
        now,
        localeId,
        t,
        grandTotal,
        onOpen,
        includeInherited,
        showCost,
        currency,
        hovered: hovered === row.id,
        onHover: setHovered,
      }));

      return h(
        'div',
        { style: S.tableWrap },
        h(
          'table',
          { style: S.table },
          h('thead', null, h('tr', null, head)),
          h('tbody', null, body),
        ),
        rows.length === 0
          ? h('div', { style: { padding: '22px 10px', fontSize: 12, color: TOKEN('--dsw-alias-label-secondary'), textAlign: 'center' } }, t('table.empty'))
          : null,
        h('div', { style: { ...S.muted, padding: '8px 2px 0' } }, t('table.count', { shown: rows.length, total: totalCount })),
      );
    }

    /**
     * Slide-over conversation detail: per-session runtime split, token mix,
     * model usage, tool ranking and turn health, with an action to open the
     * conversation itself.
     * @param props - `{ row, t, localeId, currency, configured, now, onClose, onOpenConversation }`.
     * @returns the overlay element.
     */
    function SessionDrawer(props) {
      const { row, t, localeId, currency, configured, now, onClose, onOpenConversation } = props;
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') return undefined;
        const onKeyDown = (event) => {
          if (event.key === 'Escape') onClose();
        };
        document.addEventListener('keydown', onKeyDown);
        return () => document.removeEventListener('keydown', onKeyDown);
      }, [onClose]);

      const title = typeof row.title === 'string' && row.title.length > 0 ? row.title : t('row.untitled');
      const tokens = row.tokens ?? {};
      const badges = [];
      if (row.live === true) {
        badges.push(h('span', { key: 'live', style: { ...S.badge, color: TOKEN('--dsw-alias-state-success-primary'), borderColor: TOKEN('--dsw-alias-state-success-primary') } }, t('row.live')));
      }
      if (row.origin === 'subagent') badges.push(h('span', { key: 'sub', style: S.badge }, t('row.subagent')));
      if (row.parentSession !== null && row.parentSession !== undefined) badges.push(h('span', { key: 'fork', style: S.badge }, t('row.fork')));
      else if (row.isSeeded === true) badges.push(h('span', { key: 'seed', style: S.badge }, t('row.seeded')));
      const costText = configured && Number.isFinite(row.cost) ? formatCost(row.cost, currency) : null;
      const meta = [
        typeof row.workspace === 'string' && row.workspace.length > 0 ? row.workspace : '',
        t('detail.lastActive', { time: formatRelative(row.lastActiveAt, now, t, localeId) }),
        t('detail.created', { time: new Date(row.createdAt).toLocaleDateString(intlTagOf(localeId)) }),
      ].filter((part) => part.length > 0);
      const detailRows = [
        { key: 'created', value: new Date(row.createdAt).toLocaleString(intlTagOf(localeId)) },
      ];

      const body = [];
      body.push(h(
        'div',
        { key: 'mini', style: S.miniGrid },
        h('div', { style: S.miniCard }, h('span', { style: S.miniLabel }, t('card.tokens')), h('span', { style: S.miniValue }, formatCompact(tokens.total ?? 0, localeId))),
        h('div', { style: S.miniCard }, h('span', { style: S.miniLabel }, t('card.runtime')), h('span', { style: S.miniValue }, formatDuration(row.runTimeMs ?? 0, t))),
        h('div', { style: S.miniCard }, h('span', { style: S.miniLabel }, t('card.activity')), h('span', { style: S.miniValue }, `${row.steps ?? 0} / ${row.toolCalls ?? 0}`)),
        configured
          ? h('div', { style: S.miniCard }, h('span', { style: S.miniLabel }, t('cost.card')), h('span', { style: S.miniValue }, costText ?? '—'))
          : null,
      ));
      body.push(h(RuntimeBreakdown, { key: 'runtime', totals: row, t }));
      body.push(h(TokenMix, { key: 'tokens', tokens: row.tokens, localeId, t, cacheHitRate: row.cacheHitRate }));
      if (Array.isArray(row.models) && row.models.length > 0) {
        body.push(h(ModelRanking, {
          key: 'models',
          models: row.models,
          t,
          localeId,
          currency,
          configured,
          totalTokens: tokens.total ?? 0,
        }));
      }
      if (Array.isArray(row.tools) && row.tools.length > 0) {
        body.push(h(ToolRanking, { key: 'tools', tools: row.tools, t, localeId }));
      } else if (row.tools !== undefined) {
        body.push(h('section', { key: 'tools-empty', style: S.section, 'data-usage-stats': 'tools' },
          h('div', { style: S.sectionHead }, h('h2', { style: S.sectionTitle }, t('tools.title'))),
          h('div', { style: S.sectionHint }, t('detail.noTools'))));
      }
      if (row.turnEnds !== null && row.turnEnds !== undefined && typeof row.turnEnds === 'object') {
        body.push(h(TurnHealth, { key: 'turns', turnEnds: row.turnEnds, retries: row.retries ?? 0, t }));
      }

      return h(
        'div',
        {
          style: S.overlay,
          role: 'dialog',
          'aria-modal': true,
          'aria-label': t('detail.title'),
          'data-usage-stats': 'drawer',
          onClick: onClose,
        },
        h(
          'div',
          { style: S.drawer, onClick: (event) => event.stopPropagation() },
          h(
            'div',
            { style: S.drawerHead },
            h(
              'div',
              { style: S.drawerTitleBlock },
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 } },
                h('h2', { style: { ...S.drawerTitle, flex: '0 1 auto' }, title }, title),
                h('span', { style: S.badges }, badges),
              ),
              h('div', { style: S.drawerMeta }, meta.map((part, index) => h('span', { key: `${index}-${part}` }, part))),
            ),
            h('button', {
              type: 'button',
              style: S.iconButton,
              title: t('detail.close'),
              'aria-label': t('detail.close'),
              onClick: onClose,
            }, '×'),
          ),
          h('div', { style: S.drawerBody }, body),
          h(
            'div',
            { style: S.drawerFooter },
            h('button', { type: 'button', style: S.button, onClick: onClose }, t('detail.close')),
            h('button', {
              type: 'button',
              style: S.primaryButton,
              onClick: () => onOpenConversation(row.id),
            }, t('detail.open')),
          ),
        ),
      );
    }

    /** Payload version, treating a missing version as the oldest contract. */
    function payloadVersionOf(data) {
      return data !== null && data !== undefined && typeof data.version === 'number' ? data.version : 1;
    }

    /** True when the payload predates the v2 report (ranges/trend/tools). */
    function isLegacyPayload(data) {
      return payloadVersionOf(data) < 2;
    }

    /** True when the payload carries v3 features (model tokens, cost, session detail). */
    function hasDetailPayload(data) {
      return payloadVersionOf(data) >= 3;
    }

    /** True when the payload carries v4 price provenance (auto-fetched official table). */
    function hasPricingPayload(data) {
      return payloadVersionOf(data) >= PAYLOAD_VERSION;
    }

    /**
     * Whether the price table involves the official page (so a refresh can update it).
     * @param pricingInfo - payload `pricing` block.
     * @returns true for auto/cache/bundled/mixed sources.
     */
    function hasOfficialPricing(pricingInfo) {
      const source = pricingInfo !== null && typeof pricingInfo === 'object' ? pricingInfo.source : null;
      const kind = source !== null && typeof source === 'object' && typeof source.kind === 'string' ? source.kind : '';
      return kind === 'auto' || kind === 'cache' || kind === 'bundled' || kind === 'mixed';
    }

    /**
     * Human label for the resolved price-table source.
     * @param pricingInfo - payload `pricing` block.
     * @param t - translator.
     * @param localeId - active locale id.
     * @returns display label.
     */
    function pricingSourceLabel(pricingInfo, t, localeId) {
      const source = pricingInfo !== null && typeof pricingInfo === 'object' ? pricingInfo.source : null;
      const kind = source !== null && typeof source === 'object' && typeof source.kind === 'string' ? source.kind : 'manual';
      const currency = typeof pricingInfo?.currency === 'string' ? pricingInfo.currency : '';
      const fetchedAt = source !== null && typeof source === 'object' && typeof source.fetchedAt === 'number' ? source.fetchedAt : null;
      const age = fetchedAt === null ? '' : formatDuration(Date.now() - fetchedAt, t);
      switch (kind) {
        case 'auto': return t('cost.sourceAuto', { currency, age });
        case 'cache': return t('cost.sourceCache', { currency, age });
        case 'bundled': return t('cost.sourceBundled', { currency, age });
        case 'mixed': return t('cost.sourceMixed', { currency });
        default: return t('cost.sourceManual', { currency });
      }
    }

    /**
     * Format a currency amount with just enough precision.
     * @param amount - amount in the configured currency.
     * @param currency - currency code.
     * @returns display string.
     */
    function formatCost(amount, currency) {
      if (typeof amount !== 'number' || !Number.isFinite(amount)) return '—';
      const magnitude = Math.abs(amount);
      const digits = magnitude >= 100 ? 0 : magnitude >= 1 ? 2 : magnitude >= 0.01 ? 4 : 6;
      const code = typeof currency === 'string' && currency.length > 0 ? `${currency} ` : '';
      return `${code}${amount.toFixed(digits)}`;
    }

    /**
     * The whole page. `shell` is a getter for the live Client context so the
     * panel can navigate to a conversation without owning the slot context.
     */
    function UsagePanel(props) {
      const { t, shell, localeId } = props;
      const [data, setData] = useState(null);
      const [loading, setLoading] = useState(true);
      const [error, setError] = useState(null);
      const [query, setQuery] = useState('');
      const [sort, setSort] = useState({ key: 'activity', dir: 'desc' });
      const [auto, setAuto] = useState(false);
      const [range, setRange] = useState('all');
      const [includeInherited, setIncludeInherited] = useState(false);
      const [notice, setNotice] = useState(null);
      const [detailId, setDetailId] = useState(null);
      const [now, setNow] = useState(() => Date.now());
      const requestRef = useRef(0);

      const load = useCallback((force, override) => {
        const options = override !== undefined && override !== null
          ? override
          : { range: 'all', inherited: false };
        const requestId = requestRef.current + 1;
        requestRef.current = requestId;
        setLoading(true);
        const controller = new AbortController();
        const params = new URLSearchParams();
        params.set('range', options.range);
        if (options.inherited === true) params.set('inherited', '1');
        try {
          params.set('offset', String(-new Date().getTimezoneOffset()));
        } catch {
          /* no timezone support: the Host defaults to UTC buckets */
        }
        if (force === true) params.set('force', '1');
        const url = `${ROUTE}?${params.toString()}`;
        fetch(url, { method: 'GET', headers: { accept: 'application/json' }, signal: controller.signal })
          .then(async (response) => {
            const payload = await response.json().catch(() => null);
            if (!response.ok) {
              const reason = payload !== null && payload !== undefined && typeof payload.error === 'string' ? payload.error : `HTTP ${String(response.status)}`;
              throw new Error(reason);
            }
            if (payload === null || typeof payload !== 'object' || payload.ok !== true) {
              throw new Error(payload !== null && payload !== undefined && typeof payload.error === 'string' ? payload.error : 'the usage route returned no payload');
            }
            if (requestRef.current !== requestId) return;
            setData(payload);
            setError(null);
            setNow(Date.now());
          })
          .catch((cause) => {
            if (cause !== null && cause !== undefined && cause.name === 'AbortError') return;
            if (requestRef.current !== requestId) return;
            setError(cause);
          })
          .finally(() => {
            if (requestRef.current === requestId) setLoading(false);
          });
        return () => controller.abort();
      }, []);

      // Options of the latest successful render, so one-shot refreshes use them.
      const optionsRef = useRef({ range: 'all', inherited: false });
      optionsRef.current = { range, inherited: includeInherited };

      useEffect(() => {
        const abort = load(false, { range: 'all', inherited: false });
        return abort;
      }, [load]);

      useEffect(() => {
        if (!auto) return undefined;
        const timer = setInterval(() => {
          if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return;
          load(true, optionsRef.current);
        }, AUTO_REFRESH_MS);
        return () => clearInterval(timer);
      }, [auto, load]);

      const changeRange = useCallback((next) => {
        setRange(next);
        load(false, { range: next, inherited: includeInherited });
      }, [includeInherited, load]);

      const toggleInherited = useCallback(() => {
        const next = !includeInherited;
        setIncludeInherited(next);
        load(false, { range, inherited: next });
      }, [includeInherited, range, load]);

      const onSort = useCallback((key) => {
        setSort((current) => current.key === key
          ? { key, dir: current.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'title' ? 'asc' : 'desc' });
      }, []);

      const openConversation = useCallback((sessionId) => {
        const context = shell();
        const uiWorkspace = context !== null && context !== undefined && typeof context.get === 'function'
          ? context.get('uiWorkspace')
          : undefined;
        if (uiWorkspace === undefined || uiWorkspace === null || typeof uiWorkspace.openSession !== 'function') {
          setNotice(t('notice.openUnavailable'));
          return;
        }
        try {
          uiWorkspace.openSession(sessionId);
        } catch (cause) {
          const reason = cause !== null && cause !== undefined && cause.message !== undefined ? String(cause.message) : String(cause);
          setNotice(t('notice.openFailed', { message: reason }));
        }
      }, [shell, t]);

      const legacy = isLegacyPayload(data);
      const sessions = data !== null && data !== undefined && Array.isArray(data.sessions) ? data.sessions : [];
      const totals = data !== null && data !== undefined && data.totals !== null && typeof data.totals === 'object' ? data.totals : null;
      const tokens = totals !== null && totals.tokens !== null && typeof totals.tokens === 'object' ? totals.tokens : null;
      const failed = data !== null && data !== undefined && Array.isArray(data.errors) ? data.errors.length : 0;
      const inheritedTokens = totals !== null && totals.inherited !== null && typeof totals.inherited === 'object' && Number.isFinite(totals.inherited.tokens)
        ? totals.inherited.tokens
        : 0;
      const detailed = hasDetailPayload(data);
      const pricingInfo = data !== null && data !== undefined && data.pricing !== null && typeof data.pricing === 'object' ? data.pricing : null;
      const costing = data !== null && data !== undefined && data.costing !== null && typeof data.costing === 'object' ? data.costing : null;
      const pricingConfigured = detailed && pricingInfo !== null && pricingInfo.configured === true;
      const currency = pricingInfo !== null && typeof pricingInfo.currency === 'string'
        ? pricingInfo.currency
        : costing !== null && typeof costing.currency === 'string' ? costing.currency : null;
      const budgetMonthly = costing !== null && typeof costing.budgetMonthly === 'number' ? costing.budgetMonthly : null;
      const budgetRatio = costing !== null && typeof costing.budgetRatio === 'number' ? costing.budgetRatio : null;
      const unpricedModels = costing !== null && Array.isArray(costing.unpricedModels) ? costing.unpricedModels : [];
      const officialPricing = pricingConfigured && hasPricingPayload(data) && hasOfficialPricing(pricingInfo);
      const detailRow = detailId === null ? null : sessions.find((row) => row.id === detailId) ?? null;

      const visible = useMemo(() => {
        const needle = query.trim().toLowerCase();
        const filtered = needle.length === 0
          ? sessions
          : sessions.filter((row) => {
              const haystack = [row.title, row.id, row.workspace, row.cwd, row.agentPreset]
                .filter((part) => typeof part === 'string')
                .join('\u0000')
                .toLowerCase();
              return haystack.includes(needle);
            });
        const sorted = [...filtered];
        const direction = sort.dir === 'asc' ? 1 : -1;
        sorted.sort((left, right) => {
          let delta = 0;
          switch (sort.key) {
            case 'tokens': delta = (left.tokens?.total ?? 0) - (right.tokens?.total ?? 0); break;
            case 'runtime': delta = (left.runTimeMs ?? 0) - (right.runTimeMs ?? 0); break;
            case 'steps': delta = (left.steps ?? 0) - (right.steps ?? 0); break;
            case 'title': {
              const leftTitle = typeof left.title === 'string' && left.title.length > 0 ? left.title : left.id;
              const rightTitle = typeof right.title === 'string' && right.title.length > 0 ? right.title : right.id;
              delta = String(leftTitle).localeCompare(String(rightTitle));
              break;
            }
            case 'activity':
            default: delta = (left.lastActiveAt ?? 0) - (right.lastActiveAt ?? 0); break;
          }
          if (delta === 0) delta = (left.lastActiveAt ?? 0) - (right.lastActiveAt ?? 0);
          return delta * direction;
        });
        return sorted;
      }, [sessions, query, sort]);

      const updatedText = data !== null && data !== undefined && Number.isFinite(data.generatedAt)
        ? t('updated', { time: new Date(data.generatedAt).toLocaleTimeString(intlTagOf(localeId()), { hour: '2-digit', minute: '2-digit', second: '2-digit' }) })
        : '';

      const rangeControl = legacy
        ? null
        : h(
            'div',
            { style: S.segments, role: 'group', 'aria-label': t('range.label') },
            RANGES.map((value) => h(
              'button',
              {
                key: value,
                type: 'button',
                style: value === range ? { ...S.segment, ...S.segmentActive } : S.segment,
                'aria-pressed': value === range,
                onClick: () => changeRange(value),
              },
              t(`range.${value}`),
            )),
          );

      const inheritedToggle = legacy
        ? null
        : h(
            'button',
            {
              type: 'button',
              style: S.switch,
              role: 'switch',
              'aria-checked': includeInherited,
              title: includeInherited
                ? t('inherited.included', { tokens: formatCompact(inheritedTokens, localeId()) })
                : t('inherited.excluded', { tokens: formatCompact(inheritedTokens, localeId()) }),
              onClick: toggleInherited,
            },
            h('span', {
              style: {
                ...S.switchTrack,
                background: includeInherited ? TOKEN('--dsw-alias-brand-primary') : TOKEN('--dsw-alias-bg-layer-2'),
                borderColor: includeInherited ? TOKEN('--dsw-alias-brand-primary') : TOKEN('--dsw-alias-border-l2'),
              },
            }, h('span', {
              style: {
                ...S.switchKnob,
                transform: includeInherited ? 'translateX(11px)' : 'translateX(0)',
                background: includeInherited ? '#fff' : TOKEN('--dsw-alias-label-secondary'),
              },
            })),
            h('span', null, t('inherited.toggle')),
          );

      const header = h(
        'header',
        { style: S.header },
        h(
          'div',
          { style: S.titleRow },
          h('h1', { style: S.title }, t('panel')),
          h('p', { style: S.subtitle }, t('subtitle')),
        ),
        h(
          'div',
          { style: S.actions },
          rangeControl,
          h('button', {
            type: 'button',
            style: loading ? { ...S.button, ...S.buttonDisabled } : S.button,
            disabled: loading,
            title: officialPricing ? `${t('refresh')} · ${t('cost.refreshHint')}` : undefined,
            onClick: () => load(true, optionsRef.current),
          }, loading ? t('refreshing') : t('refresh')),
          h(
            'button',
            {
              type: 'button',
              style: S.switch,
              role: 'switch',
              'aria-checked': auto,
              onClick: () => setAuto((value) => !value),
            },
            h('span', {
              style: {
                ...S.switchTrack,
                background: auto ? TOKEN('--dsw-alias-brand-primary') : TOKEN('--dsw-alias-bg-layer-2'),
                borderColor: auto ? TOKEN('--dsw-alias-brand-primary') : TOKEN('--dsw-alias-border-l2'),
              },
            }, h('span', {
              style: {
                ...S.switchKnob,
                transform: auto ? 'translateX(11px)' : 'translateX(0)',
                background: auto ? '#fff' : TOKEN('--dsw-alias-label-secondary'),
              },
            })),
            h('span', null, t('autoRefresh')),
          ),
          inheritedToggle,
          h('span', { style: S.updated }, [
            updatedText,
            data !== null && data !== undefined && data.cached === true && Number.isFinite(data.cacheAgeMs)
              ? ` · ${t('cached', { age: formatDuration(data.cacheAgeMs, t) })}`
              : '',
          ].filter((part) => part.length > 0).join('')),
        ),
      );

      if (error !== null) {
        return h(
          'div',
          { style: S.root },
          h(
            'div',
            { style: S.scroll },
            header,
            h(
              'div',
              { style: S.errorBox, role: 'alert' },
              h('p', { style: S.errorTitle }, t('error.title')),
              h('div', { style: S.subtitle }, String(error.message ?? error)),
              h('div', null, h('button', { type: 'button', style: S.button, onClick: () => load(true, optionsRef.current) }, t('error.retry'))),
            ),
          ),
        );
      }

      const legacyModelMs = totals !== null && Number.isFinite(totals.llmMs) ? totals.llmMs : 0;
      const cards = h(
        'div',
        { style: S.cardGrid },
        h(StatCard, {
          label: t('card.tokens'),
          value: loading && data === null ? '—' : formatCompact(tokens?.total ?? 0, localeId()),
          hint: t('card.tokens.hint', {
            prompt: formatCompact(tokens?.prompt ?? 0, localeId()),
            output: formatCompact(tokens?.output ?? 0, localeId()),
          }),
        }),
        h(StatCard, {
          label: t('card.runtime'),
          value: loading && data === null ? '—' : formatDuration(totals?.runTimeMs ?? 0, t),
          hint: legacy
            ? t('card.runtime.hint', {
                llm: formatDuration(legacyModelMs, t),
                tool: formatDuration(totals?.toolMs ?? 0, t),
              })
            : t('card.runtime.hint2', {
                model: formatDuration(totals?.modelMs ?? legacyModelMs, t),
                tool: formatDuration(totals?.toolMs ?? 0, t),
                human: formatDuration(totals?.humanWaitMs ?? 0, t),
              }),
        }),
        h(StatCard, {
          label: t('card.sessions'),
          value: loading && data === null ? '—' : String(totals?.sessions ?? 0),
          hint: t('card.sessions.hint', {
            live: totals?.liveSessions ?? 0,
            subagents: totals?.subagentSessions ?? 0,
          }),
        }),
        h(StatCard, {
          label: t('card.activity'),
          value: loading && data === null ? '—' : `${formatCompact(totals?.steps ?? 0, localeId())} / ${formatCompact(totals?.toolCalls ?? 0, localeId())}`,
          hint: t('card.activity.hint', {
            steps: totals?.steps ?? 0,
            tools: totals?.toolCalls ?? 0,
            turns: totals?.turns ?? 0,
          }),
        }),
        detailed
          ? h(StatCard, {
              label: t('cost.card'),
              value: loading && data === null ? '—' : pricingConfigured ? formatCost(costing?.monthCost, currency) : '—',
              hint: pricingConfigured
                ? budgetMonthly !== null && budgetMonthly > 0
                  ? t('cost.budgetHint', {
                      percent: formatPercent(budgetRatio ?? 0, t),
                      currency: currency ?? '',
                      limit: budgetMonthly.toFixed(2),
                    })
                  : t('cost.monthHint', {
                      rangeCost: formatCost(totals?.cost, currency),
                      monthCost: formatCost(costing?.monthCost, currency),
                    })
                : t('cost.unconfiguredHint', { path: pricingInfo?.source ?? '~/.dsh/usage-stats/prices.json' }),
              hintTitle: pricingInfo !== null && pricingInfo.source !== null && typeof pricingInfo.source === 'object' && typeof pricingInfo.source.url === 'string'
                ? pricingInfo.source.url
                : pricingInfo !== null && typeof pricingInfo.source === 'string' ? pricingInfo.source : undefined,
            })
          : null,
      );

      if (data === null) {
        return h(
          'div',
          { style: S.root },
          h(
            'div',
            { style: S.scroll },
            header,
            cards,
            h(
              'section',
              { style: S.section },
              h('div', { style: S.sectionHint }, t('loading')),
              h('div', { style: { ...S.skeletonLine, width: '82%' } }),
              h('div', { style: { ...S.skeletonLine, width: '64%' } }),
              h('div', { style: { ...S.skeletonLine, width: '73%' } }),
            ),
          ),
        );
      }

      if (sessions.length === 0) {
        return h(
          'div',
          { style: S.root },
          h(
            'div',
            { style: S.scroll },
            header,
            h(
              'div',
              { style: S.emptyBox },
              h('p', { style: S.emptyTitle }, t('empty.title')),
              h('p', { style: S.emptyBody }, t('empty.body')),
            ),
          ),
        );
      }

      const notices = [];
      if (notice !== null) {
        notices.push(h(
          'div',
          { key: 'notice', style: S.notice, role: 'status' },
          h('span', { style: { flex: '1 1 auto' } }, notice),
          h('button', { type: 'button', style: S.linkButton, onClick: () => setNotice(null) }, t('notice.dismiss')),
        ));
      }
      if (legacy) {
        notices.push(h(
          'div',
          { key: 'restart', style: { ...S.notice, flexDirection: 'column', alignItems: 'flex-start', gap: 4 }, role: 'status', 'data-usage-stats': 'restart' },
          h('strong', { style: { fontSize: 12 } }, t('restart.title')),
          h('span', { style: S.sectionHint }, t('restart.body', { version: data.version ?? 1 })),
        ));
      }
      if (!legacy && !detailed) {
        notices.push(h(
          'div',
          { key: 'upgrade', style: { ...S.notice, flexDirection: 'column', alignItems: 'flex-start', gap: 4 }, role: 'status', 'data-usage-stats': 'upgrade' },
          h('strong', { style: { fontSize: 12 } }, t('upgrade.title')),
          h('span', { style: S.sectionHint }, t('upgrade.body', { version: data.version ?? 2 })),
        ));
      } else if (detailed && !hasPricingPayload(data)) {
        notices.push(h(
          'div',
          { key: 'upgrade-pricing', style: { ...S.notice, flexDirection: 'column', alignItems: 'flex-start', gap: 4 }, role: 'status', 'data-usage-stats': 'upgrade-pricing' },
          h('strong', { style: { fontSize: 12 } }, t('upgradePricing.title')),
          h('span', { style: S.sectionHint }, t('upgradePricing.body', { version: data.version ?? 3 })),
        ));
      }
      if (pricingConfigured && budgetRatio !== null && budgetRatio >= 0.8) {
        const over = budgetRatio >= 1;
        notices.push(h(
          'div',
          {
            key: 'budget',
            style: { ...S.notice, borderColor: over ? TOKEN('--dsw-alias-state-error-primary') : TOKEN('--dsw-alias-state-warn-primary') },
            role: 'status',
            'data-usage-stats': 'budget',
          },
          h('span', { style: { flex: '1 1 auto' } }, t(over ? 'cost.alertOver' : 'cost.alertWarn', {
            percent: formatPercent(budgetRatio, t),
            spent: formatCost(costing?.monthCost, ''),
            limit: budgetMonthly !== null ? budgetMonthly.toFixed(2) : '—',
            currency: currency ?? '',
          })),
        ));
      }
      if (failed > 0) {
        const details = Array.isArray(data.errors) ? data.errors.map((entry) => `${entry.sessionId ?? '?'}: ${entry.message}`).join('\n') : '';
        notices.push(h(
          'div',
          { key: 'partial', style: S.notice, role: 'status', title: details },
          h('span', { style: { flex: '1 1 auto' } }, t('error.partial', { count: failed })),
        ));
      }

      const v2Sections = legacy
        ? [h(TokenMix, { key: 'tokens', tokens, localeId: localeId(), t, cacheHitRate: totals?.cacheHitRate ?? null })]
        : [
            h(TrendChart, { key: 'trend', trend: data.trend, t, localeId: localeId() }),
            h(RuntimeBreakdown, { key: 'runtime', totals, t }),
            h(TokenMix, { key: 'tokens', tokens, localeId: localeId(), t, cacheHitRate: totals?.cacheHitRate ?? null }),
            detailed
              ? h(ModelRanking, {
                  key: 'models',
                  models: data.models,
                  t,
                  localeId: localeId(),
                  currency,
                  configured: pricingConfigured,
                  totalTokens: tokens?.total ?? 0,
                })
              : null,
            h('div', { key: 'duo', style: S.duo },
              h(ToolRanking, { tools: data.tools, t, localeId: localeId() }),
              h(TurnHealth, { turnEnds: data.turnEnds, retries: totals?.retries ?? 0, t }),
            ),
          ].filter((section) => section !== null);

      return h(
        'div',
        { style: S.root, 'data-usage-stats': 'panel' },
        h(
          'div',
          { style: S.scroll },
          header,
          notices,
          cards,
          v2Sections,
          h(
            'section',
            { style: S.section },
            h(
              'div',
              { style: S.sectionHead },
              h('h2', { style: S.sectionTitle }, t('table.title')),
              h('span', { style: { flex: '1 1 auto' } }),
              h('input', {
                type: 'search',
                style: S.input,
                value: query,
                placeholder: t('search'),
                'aria-label': t('search'),
                onChange: (event) => setQuery(event.target.value),
              }),
            ),
            h(SessionTable, {
              rows: visible,
              totalCount: sessions.length,
              grandTotal: tokens !== null && tokens !== undefined && Number.isFinite(tokens.total) ? tokens.total : 0,
              now,
              localeId: localeId(),
              t,
              sort,
              onSort,
              onOpen: (id) => setDetailId(id),
              includeInherited,
              showCost: pricingConfigured,
              currency,
            }),
          ),
          h(
            'footer',
            { style: S.footer },
            h('span', null, t('footer.note')),
            h('span', { style: { flex: '1 1 auto' } }),
            !legacy && inheritedTokens > 0
              ? h('span', null, includeInherited
                  ? t('inherited.included', { tokens: formatCompact(inheritedTokens, localeId()) })
                  : t('inherited.excluded', { tokens: formatCompact(inheritedTokens, localeId()) }))
              : null,
            pricingConfigured && unpricedModels.length > 0
              ? h('span', { title: unpricedModels.join(', ') }, t('cost.unpriced', { count: unpricedModels.length }))
              : null,
            pricingConfigured && hasPricingPayload(data)
              ? h('span', { style: { display: 'inline-flex', alignItems: 'center', gap: 6 }, title: t('cost.peakNote') },
                  h('span', null, pricingSourceLabel(pricingInfo, t, localeId())),
                  officialPricing
                    ? h('button', {
                        type: 'button',
                        style: S.linkButton,
                        title: t('cost.refreshPriceHint'),
                        onClick: () => load(true, optionsRef.current),
                      }, t('cost.refreshPrice'))
                    : null,
                )
              : null,
            Array.isArray(data.errors) && data.errors.length > 0
              ? h('span', null, t('error.partial', { count: data.errors.length }))
              : null,
            h('span', null, t('count', { count: totals?.sessions ?? 0 })),
          ),
        ),
        detailRow === null ? null : h(SessionDrawer, {
          row: detailRow,
          t,
          localeId: localeId(),
          currency,
          configured: pricingConfigured,
          now,
          onClose: () => setDetailId(null),
          onOpenConversation: openConversation,
        }),
      );
    }

    // ─── module face ───────────────────────────────────────────────────────

    /** Live Client context, captured once by `apply`. */
    let shell = null;

    /** Active locale id getter, captured once by `apply` (for Intl formatting). */
    let activeLocale = () => 'en';

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        shell = ctx;
        activeLocale = () => {
          try {
            const snapshot = ctx.locale.getLocale();
            return snapshot !== null && snapshot !== undefined && typeof snapshot.active === 'string' && snapshot.active.length > 0
              ? snapshot.active
              : 'en';
          } catch {
            return 'en';
          }
        };

        ctx.effect(
          () => ctx.locale.register(NS, DICT),
          'dsh-usage-stats: dictionaries',
        );
        // A thunk label is re-read on every projection, so the rail entry
        // follows the active locale without re-registering.
        const t = ctx.locale.bind(NS);

        // Each list id addresses the matching `main` panel: same string, twice.
        ctx.slots.inject('sidebar.panellist', () =>
          ctx.slots.register(
            { name: 'sidebar.panellist', id: PANEL_ID, order: 20, label: () => t('panel'), locale: NS },
            InsightsIcon,
          ),
        );

        ctx.slots.inject('main', () =>
          ctx.slots.register({ name: 'main', key: PANEL_ID, locale: NS }, (props) => {
            const translator = props !== undefined && props !== null && typeof props.t === 'function' ? props.t : t;
            return h(
              PanelBoundary,
              { t: translator },
              h(UsagePanel, { t: translator, shell: () => shell, localeId: activeLocale }),
            );
          }),
        );
      },
    };
  },
});
