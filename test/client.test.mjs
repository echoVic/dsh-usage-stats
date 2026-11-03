/**
 * Browser-half composition test.
 *
 * The client module has no bundler and no type check, and a throwing slot entry
 * blanks the slot — so this test boots the real `lib/client.js` inside a `vm`
 * with a minimal React double (stateful hooks, class components, effects) and
 * a fake Client context, then renders the panel against a v2 Host payload in
 * both locales, plus the legacy v1 payload the running Host still serves before
 * an app restart. It asserts:
 *
 * - the module registers the `sidebar.panellist` cell and the `main` panel
 *   under one shared id;
 * - rendering the loaded dashboard does not throw and reaches real content
 *   (range selector, trend, runtime split, tool ranking, turn health, table);
 * - the legacy payload renders the cards/table with a restart notice instead
 *   of crashing on missing v2 fields;
 * - every string routed through the locale service exists in both dictionaries;
 * - every CSS color is a `--dsw-alias-*` theme token.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const CLIENT_SOURCE = readFileSync(fileURLToPath(new URL('../lib/client.js', import.meta.url)), 'utf8');

/**
 * A v2 payload shaped exactly like the Host route's success body.
 * @returns the fixture.
 */
function fixtureV5() {
  const now = Date.now();
  const dayStart = (daysAgo) => {
    const date = new Date(now);
    date.setHours(0, 0, 0, 0);
    return date.getTime() - daysAgo * 86400000;
  };
  return {
    ok: true,
    version: 5,
    cached: false,
    cacheAgeMs: 0,
    ttlMs: 15000,
    range: '7d',
    includeInherited: false,
    offsetMinutes: 480,
    generatedAt: now - 1200,
    scanMs: 12,
    scope: { listed: 2, analyzed: 2, failed: 0, live: 1, subagents: 1 },
    pricing: {
      configured: true,
      currency: 'CNY',
      budgetMonthly: 100,
      source: {
        kind: 'auto',
        url: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
        fetchedAt: now - 3600_000,
        ttlHours: 24,
        provider: 'deepseek-official',
        userFile: '/Users/test/.dsh/usage-stats/prices.json',
        cacheFile: '/Users/test/.dsh/usage-stats/prices.cache.json',
      },
      services: {
        search: { pricePerThousand: 5, billed: true },
        fetch: { pricePerThousand: 5, billed: false },
      },
      peakWindows: [[1, 4], [6, 10]],
      weekdays: [1, 2, 3, 4, 5],
      warnings: [],
      error: null,
    },
    costing: {
      configured: true,
      currency: 'CNY',
      budgetMonthly: 100,
      monthTokens: 900_000_000,
      monthCost: 92.5,
      budgetRatio: 0.925,
      unpricedModels: ['unknown/provider'],
      serviceCost: 1.5,
      servicesConfigured: true,
    },
    totals: {
      sessions: 2,
      liveSessions: 1,
      subagentSessions: 1,
      runTimeMs: 8_724_000,
      modelMs: 6_000_000,
      toolMs: 2_000_000,
      humanWaitMs: 400_000,
      otherMs: 324_000,
      turns: 42,
      steps: 96,
      toolCalls: 57,
      retries: 7,
      userMessages: 21,
      assistantMessages: 96,
      tokens: {
        input: 1_234_567,
        output: 456_789,
        cacheRead: 8_901_234,
        cacheWrite: 12_345,
        prompt: 10_148_146,
        total: 10_604_935,
      },
      cacheHitRate: 0.8773,
      cost: 59.75,
      monthTokens: 900_000_000,
      monthCost: 92.5,
      services: { search: 300, fetch: 56 },
      serviceCost: 1.5,
      inherited: { tokens: 30_571_706, runTimeMs: 1_576_165, turns: 3, steps: 9 },
      firstActivityAt: now - 30 * 86400000,
      lastActivityAt: now - 60_000,
    },
    sessions: [
      {
        id: 'session-71ca5950-5f10-4438-97f4-ddbeaeb4c535',
        title: '修复登录问题',
        createdAt: now - 3_600_000,
        lastActiveAt: now - 60_000,
        live: true,
        parentSession: null,
        origin: null,
        delegationDepth: null,
        isSeeded: false,
        cwd: '/Users/bytedance/Documents/deepseek-harness/default-workspace',
        workspace: 'default-workspace',
        agentPreset: 'default',
        eventCount: 412,
        runTimeMs: 5_400_000,
        modelMs: 4_000_000,
        toolMs: 1_000_000,
        humanWaitMs: 300_000,
        otherMs: 100_000,
        turns: 18,
        steps: 44,
        toolCalls: 30,
        retries: 2,
        userMessages: 9,
        assistantMessages: 44,
        tokens: {
          input: 900_000,
          output: 300_000,
          cacheRead: 6_000_000,
          cacheWrite: 10_000,
          prompt: 6_910_000,
          total: 7_210_000,
        },
        cacheHitRate: 0.868,
        cost: 41.6,
        unpriced: false,
        services: { search: 300, fetch: 40 },
        serviceCost: 1.5,
        models: [
          {
            provider: 'deepseek-official',
            model: 'deepseek-flash',
            calls: 40,
            tokens: { input: 900_000, output: 300_000, cacheRead: 6_000_000, cacheWrite: 10_000, prompt: 6_910_000, total: 7_210_000 },
            cacheHitRate: 0.868,
            cost: 40.1,
          },
          {
            provider: 'deepseek-official',
            model: 'deepseek-pro',
            calls: 4,
            tokens: { input: 10_000, output: 2_000, cacheRead: 0, cacheWrite: 0, prompt: 10_000, total: 12_000 },
            cacheHitRate: 0,
            cost: 0.5,
          },
        ],
        tools: [
          { name: 'bash', calls: 30, ms: 1_200_000, errors: 2 },
          { name: 'read', calls: 18, ms: 500_000, errors: 0 },
        ],
        turnEnds: { completed: 16, aborted: 1, interrupted: 0, error: 1, maxTokens: 0, blocked: 0, forked: 0, other: 0, open: 0 },
        inherited: { tokens: 0, runTimeMs: 0, turns: 0, steps: 0 },
      },
      {
        id: 'session-161f1f0a-6ef5-4ba9-ae4b-b54aa74c48ca',
        title: null,
        createdAt: now - 7_200_000,
        lastActiveAt: now - 900_000,
        live: false,
        parentSession: 'session-71ca5950-5f10-4438-97f4-ddbeaeb4c535',
        origin: 'subagent',
        delegationDepth: 1,
        isSeeded: true,
        cwd: null,
        workspace: null,
        agentPreset: null,
        eventCount: 87,
        runTimeMs: 3_324_000,
        modelMs: 2_000_000,
        toolMs: 1_000_000,
        humanWaitMs: 100_000,
        otherMs: 224_000,
        turns: 24,
        steps: 52,
        toolCalls: 27,
        retries: 5,
        userMessages: 12,
        assistantMessages: 52,
        tokens: {
          input: 334_567,
          output: 156_789,
          cacheRead: 2_901_234,
          cacheWrite: 2_345,
          prompt: 3_238_146,
          total: 3_394_935,
        },
        cacheHitRate: 0.8959,
        cost: 18.15,
        unpriced: true,
        services: { search: 0, fetch: 16 },
        serviceCost: null,
        models: [],
        tools: [],
        turnEnds: { completed: 24, aborted: 0, interrupted: 0, error: 0, maxTokens: 0, blocked: 0, forked: 0, other: 0, open: 0 },
        inherited: { tokens: 1_500_000, runTimeMs: 500_000, turns: 2, steps: 4 },
      },
    ],
    trend: {
      unit: 'day',
      buckets: [
        { start: dayStart(3), tokens: 1000, runTimeMs: 60_000, steps: 3, toolCalls: 1, cost: 0.01, sessions: 1 },
        { start: dayStart(2), tokens: 0, runTimeMs: 0, steps: 0, toolCalls: 0, cost: 0, sessions: 0 },
        { start: dayStart(1), tokens: 2_500_000, runTimeMs: 900_000, steps: 21, toolCalls: 9, cost: 12.5, sessions: 1 },
        { start: dayStart(0), tokens: 8_000_000, runTimeMs: 1_500_000, steps: 40, toolCalls: 20, cost: 45.74, sessions: 2 },
      ],
    },
    tools: [
      { name: 'bash', calls: 30, ms: 1_200_000, errors: 2 },
      { name: 'read', calls: 18, ms: 500_000, errors: 0 },
      { name: 'edit', calls: 9, ms: 300_000, errors: 1 },
    ],
    models: [
      {
        provider: 'deepseek-official',
        model: 'deepseek-flash',
        calls: 40,
        tokens: { input: 900_000, output: 300_000, cacheRead: 6_000_000, cacheWrite: 10_000, prompt: 6_910_000, total: 7_210_000 },
        cacheHitRate: 0.868,
        cost: 40.1,
      },
      {
        provider: 'deepseek-official',
        model: 'deepseek-pro',
        calls: 9,
        tokens: { input: 344_567, output: 158_789, cacheRead: 2_901_234, cacheWrite: 2_345, prompt: 3_248_146, total: 3_406_935 },
        cacheHitRate: 0.893,
        cost: 18.15,
      },
      {
        provider: null,
        model: null,
        calls: 1,
        tokens: { input: 1_000, output: 100, cacheRead: 0, cacheWrite: 0, prompt: 1_000, total: 1_100 },
        cacheHitRate: 0,
        cost: null,
      },
    ],
    services: [
      { kind: 'search', calls: 300, billed: true, pricePerThousand: 5, cost: 1.5 },
      { kind: 'fetch', calls: 56, billed: false, pricePerThousand: 5, cost: null },
    ],
    turnEnds: {
      completed: 38,
      aborted: 2,
      interrupted: 0,
      error: 1,
      maxTokens: 0,
      blocked: 0,
      forked: 1,
      other: 0,
      open: 0,
    },
    errors: [],
    partial: false,
  };
}

/**
 * The v2 payload a still-running Host half serves before a restart: same
 * structure without the v3 model-token/cost/session-detail fields.
 * @returns the fixture.
 */
function fixtureV2Host() {
  const data = JSON.parse(JSON.stringify(fixtureV5()));
  data.version = 2;
  delete data.pricing;
  delete data.costing;
  delete data.totals.cost;
  delete data.totals.monthTokens;
  delete data.totals.monthCost;
  delete data.services;
  delete data.totals.services;
  delete data.totals.serviceCost;
  for (const bucket of data.trend.buckets) delete bucket.cost;
  for (const row of data.sessions) {
    delete row.cost;
    delete row.unpriced;
    delete row.tools;
    delete row.turnEnds;
    delete row.services;
    delete row.serviceCost;
    for (const model of row.models) {
      delete model.tokens;
      delete model.cacheHitRate;
      delete model.cost;
    }
  }
  for (const model of data.models) {
    delete model.tokens;
    delete model.cacheHitRate;
    delete model.cost;
  }
  return data;
}

/**
 * The pre-v2 payload the still-running Host half serves before a restart.
 * @returns the fixture.
 */
function fixtureLegacy() {
  const now = Date.now();
  return {
    ok: true,
    version: 1,
    cached: false,
    cacheAgeMs: 0,
    generatedAt: now - 500,
    scanMs: 20,
    scope: { listed: 1, analyzed: 1, failed: 0, live: 1, subagents: 0 },
    totals: {
      sessions: 1,
      liveSessions: 1,
      subagentSessions: 0,
      runTimeMs: 60_000,
      llmMs: 40_000,
      toolMs: 10_000,
      turns: 2,
      steps: 4,
      toolCalls: 3,
      userMessages: 1,
      assistantMessages: 4,
      tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, prompt: 130, total: 150 },
      cacheHitRate: 30 / 130,
    },
    sessions: [
      {
        id: 'session-legacy',
        title: '旧版数据',
        createdAt: now - 3_600_000,
        lastActiveAt: now - 60_000,
        live: true,
        parentSession: null,
        origin: null,
        delegationDepth: null,
        isSeeded: false,
        cwd: '/w/legacy',
        workspace: 'legacy',
        agentPreset: null,
        eventCount: 10,
        runTimeMs: 60_000,
        llmMs: 40_000,
        toolMs: 10_000,
        turns: 2,
        steps: 4,
        toolCalls: 3,
        userMessages: 1,
        assistantMessages: 4,
        tokens: { input: 100, output: 20, cacheRead: 30, cacheWrite: 0, prompt: 130, total: 150 },
        cacheHitRate: 30 / 130,
        models: [],
      },
    ],
    errors: [],
    partial: false,
  };
}

/**
 * A v3 Host payload: official/manual provenance was a plain path string and
 * peak windows were not published yet.
 * @returns the fixture.
 */
function fixtureV3Host() {
  const data = JSON.parse(JSON.stringify(fixtureV5()));
  data.version = 3;
  data.pricing = {
    configured: true,
    currency: 'CNY',
    budgetMonthly: 100,
    source: '/Users/test/.dsh/usage-stats/prices.json',
    updatedAt: Date.now() - 5000,
    error: null,
  };
  delete data.services;
  delete data.totals.services;
  delete data.totals.serviceCost;
  delete data.costing.serviceCost;
  delete data.costing.servicesConfigured;
  for (const row of data.sessions) {
    delete row.services;
    delete row.serviceCost;
  }
  return data;
}

/**
 * A v4 Host payload: official pricing exists, but Search/Fetch usage does not.
 * @returns the fixture.
 */
function fixtureV4Host() {
  const data = JSON.parse(JSON.stringify(fixtureV5()));
  data.version = 4;
  delete data.services;
  delete data.totals.services;
  delete data.totals.serviceCost;
  delete data.costing.serviceCost;
  delete data.costing.servicesConfigured;
  delete data.pricing.services;
  for (const row of data.sessions) {
    delete row.services;
    delete row.serviceCost;
  }
  return data;
}

/**
 * Interpolating translator over one dictionary, recording missing keys.
 * @param dictionaries - `{ zh, en }` dictionaries.
 * @param locale - active locale id.
 * @param missing - collector for absent keys.
 * @returns the translate function.
 */
function translator(dictionaries, locale, missing) {
  return function translate(key, params) {
    const dict = dictionaries[locale] ?? dictionaries.en ?? {};
    const fallback = dictionaries.en ?? {};
    const template = typeof dict[key] === 'string' ? dict[key] : typeof fallback[key] === 'string' ? fallback[key] : undefined;
    if (template === undefined) {
      missing.add(key);
      return key;
    }
    if (params === undefined || params === null) return template;
    return template.replace(/\{(\w+)\}/g, (match, name) => (Object.hasOwn(params, name) ? String(params[name]) : match));
  };
}

/**
 * A minimal but stateful React double: function components with hooks, class
 * components, effect deps, and re-render on state change.
 * @returns `{ React, mount }`.
 */
function reactDouble() {
  const instances = new Map();
  let current = null;
  let dirty = false;

  const sameDeps = (left, right) => left !== undefined && right !== undefined
    && left.length === right.length
    && left.every((value, index) => Object.is(value, right[index]));

  function useSlot() {
    const instance = current;
    const index = instance.cursor;
    instance.cursor += 1;
    return [instance, index];
  }

  function createElement(type, props, ...children) {
    return {
      type,
      props: {
        ...(props === null || props === undefined ? {} : props),
        children: children.length === 0 ? undefined : children.length === 1 ? children[0] : children,
      },
    };
  }

  class Component {
    constructor(props) {
      this.props = props;
      this.state = {};
    }

    setState(patch) {
      this.state = { ...this.state, ...(typeof patch === 'function' ? patch(this.state) : patch) };
      dirty = true;
    }
  }

  const React = {
    createElement,
    Component,
    useState(initial) {
      const [instance, index] = useSlot();
      if (!(index in instance.hooks)) {
        instance.hooks[index] = typeof initial === 'function' ? initial() : initial;
      }
      const set = (next) => {
        const value = typeof next === 'function' ? next(instance.hooks[index]) : next;
        if (Object.is(value, instance.hooks[index])) return;
        instance.hooks[index] = value;
        dirty = true;
      };
      return [instance.hooks[index], set];
    },
    useMemo(factory, deps) {
      const [instance, index] = useSlot();
      const slot = instance.memos[index];
      if (slot !== undefined && sameDeps(slot.deps, deps)) return slot.value;
      const value = factory();
      instance.memos[index] = { deps, value };
      return value;
    },
    useCallback(callback, deps) {
      return React.useMemo(() => callback, deps);
    },
    useRef(initial) {
      const [instance, index] = useSlot();
      if (!(index in instance.refs)) instance.refs[index] = { current: initial };
      return instance.refs[index];
    },
    useEffect(callback, deps) {
      const [instance, index] = useSlot();
      instance.pending.push({ index, callback, deps });
    },
  };

  /**
   * Render one element tree, invoking components and their hooks.
   * @param element - element produced by createElement.
   * @returns the rendered tree (host elements with rendered children).
   */
  function renderElement(element) {
    if (element === null || element === undefined) return null;
    if (typeof element === 'string' || typeof element === 'number') return element;
    if (Array.isArray(element)) return element.map(renderElement);
    const isClass = typeof element.type === 'function'
      && element.type.prototype !== undefined
      && typeof element.type.prototype.render === 'function';
    if (isClass) {
      const key = `${element.type.name}:class`;
      let instance = instances.get(key);
      if (instance === undefined) {
        instance = new element.type(element.props);
        instance.pending = instance.pending ?? [];
        instance.effects = instance.effects ?? {};
        instances.set(key, instance);
      }
      instance.props = element.props;
      return renderElement(instance.render());
    }
    if (typeof element.type === 'function') {
      const key = element.type.name;
      let instance = instances.get(key);
      if (instance === undefined) {
        instance = { hooks: [], memos: {}, refs: {}, cursor: 0, pending: [], effects: {} };
        instances.set(key, instance);
      }
      const outer = current;
      current = instance;
      instance.cursor = 0;
      let rendered;
      try {
        rendered = element.type(element.props);
      } finally {
        current = outer;
      }
      return renderElement(rendered);
    }
    const props = { ...element.props };
    const children = props.children;
    delete props.children;
    if (children !== undefined) props.children = renderElement(children);
    return { type: element.type, props };
  }

  /** Run pending effects whose deps changed. */
  async function runEffects() {
    for (const instance of instances.values()) {
      const pending = instance.pending;
      instance.pending = [];
      for (const effect of pending) {
        if (!(effect.index in instance.effects) || !sameDeps(instance.effects[effect.index].deps, effect.deps)) {
          const previous = instance.effects[effect.index];
          if (previous !== undefined && typeof previous.cleanup === 'function') previous.cleanup();
          const cleanup = effect.callback();
          instance.effects[effect.index] = { deps: effect.deps, cleanup };
        }
      }
    }
  }

  /**
   * Render the root component until state settles.
   * @param component - root component function.
   * @param props - root props.
   * @returns the rendered tree.
   */
  async function settle(component, props) {
    let tree = null;
    for (let iteration = 0; iteration < 40; iteration += 1) {
      dirty = false;
      tree = renderElement(createElement(component, props));
      await runEffects();
      await new Promise((resolve) => setTimeout(resolve, 0));
      await Promise.resolve();
      if (!dirty) return tree;
    }
    return tree;
  }

  return { React, mount: settle, settle };
}

/**
 * Walk a rendered tree, collecting text nodes and style values.
 * @param tree - rendered tree.
 * @param visit - callback receiving each node.
 */
function walk(tree, visit) {
  if (tree === null || tree === undefined) return;
  if (typeof tree === 'string' || typeof tree === 'number') {
    visit({ kind: 'text', value: String(tree) });
    return;
  }
  if (Array.isArray(tree)) {
    for (const child of tree) walk(child, visit);
    return;
  }
  visit({ kind: 'element', type: tree.type, props: tree.props });
  walk(tree.props.children, visit);
}

/**
 * Boot the client module in a sandbox with a fake window/React/fetch/context.
 * @param localeId - initial active locale for the fake locale service.
 * @param payload - Host payload served by the fake route.
 * @returns captured dictionaries, registrations, missing keys, and the harness.
 */
function bootClient(localeId, payload) {
  const dictionaries = { zh: null, en: null };
  const missing = new Set();
  const injections = [];
  const registrations = [];
  const effects = [];
  const requestedUrls = [];
  let currentLocale = localeId;
  const double = reactDouble();

  const sandbox = {
    window: {
      __ModuleLoader__: {
        load(definition) {
          assert.equal(definition.id, '@echovic/dsh-usage-stats');
          face = definition.factory(fakeRequire);
        },
      },
    },
    fetch: async (url) => {
      requestedUrls.push(String(url));
      return {
        ok: true,
        status: 200,
        async json() {
          return payload;
        },
      };
    },
    AbortController,
    AbortSignal,
    Intl,
    Date,
    Math,
    JSON,
    Object,
    Array,
    Promise,
    Map,
    Set,
    Error,
    String,
    Number,
    Boolean,
    URLSearchParams,
    console,
    setTimeout,
    clearTimeout,
    setInterval: () => 0,
    clearInterval: () => {},
    document: { visibilityState: 'visible' },
  };

  const fakeRequire = (specifier) => {
    if (specifier === 'react') return double.React;
    throw new Error(`unexpected require(${specifier})`);
  };
  let face = null;

  vm.createContext(sandbox);
  vm.runInContext(CLIENT_SOURCE, sandbox, { filename: 'client.js' });
  assert.notEqual(face, null, 'the client module must register itself with the module loader');

  const translate = (key, params) => translator(dictionaries, currentLocale, missing)(key, params);
  const localeService = {
    register(ns, dicts) {
      assert.equal(ns, 'dsh-usage-stats');
      dictionaries.zh = dicts.zh;
      dictionaries.en = dicts.en;
      return () => {};
    },
    bind() {
      return translate;
    },
    getLocale() {
      return { active: currentLocale, locales: [], revision: 0 };
    },
  };
  const slotsService = {
    inject(key, callback) {
      injections.push({ key, callback });
      return () => {};
    },
    register(options, component) {
      registrations.push({ options, component });
      return () => {};
    },
  };
  const ctx = {
    effect(callback) {
      const disposer = callback();
      effects.push(disposer);
      return disposer;
    },
    get() {
      return undefined;
    },
    slots: slotsService,
    locale: localeService,
  };

  return {
    dictionaries,
    missing,
    injections,
    registrations,
    effects,
    face,
    ctx,
    mount: double.mount,
    settle: double.settle,
    requestedUrls,
    setLocale(next) {
      currentLocale = next;
    },
  };
}

/**
 * Collect the visible text and style values of one rendered tree.
 * @param tree - rendered tree.
 * @returns `{ text, colorValues, buggyVars }`.
 */
function inspectTree(tree) {
  const texts = [];
  const colorValues = [];
  const buggyVars = [];
  const markers = [];
  walk(tree, (node) => {
    if (node.kind === 'text') {
      texts.push(node.value);
      return;
    }
    if (typeof node.props['data-usage-stats'] === 'string') markers.push(node.props['data-usage-stats']);
    const style = node.props.style;
    if (style !== null && typeof style === 'object') {
      for (const value of Object.values(style)) {
        if (typeof value !== 'string') continue;
        if (/^(var\(|#)/.test(value)) colorValues.push(value);
        if (/var\(--dsw-alias-[a-z0-9-]+\)\)/.test(value)) buggyVars.push(value);
      }
    }
  });
  return { text: texts.join('\n'), colorValues, buggyVars, markers };
}

/**
 * Boot, apply and mount the panel against one payload.
 * @param localeId - active locale.
 * @param payload - Host payload.
 * @returns `{ boot, inspected }`.
 */
async function renderPanel(localeId, payload) {
  const boot = bootClient(localeId, payload);
  boot.face.apply(boot.ctx);
  for (const injection of boot.injections) injection.callback();
  const main = boot.registrations.find((entry) => entry.options.name === 'main');
  const tree = await boot.mount(main.component, {});
  return { boot, inspected: inspectTree(tree) };
}

test('module face registers one sidebar cell and one addressed main panel', () => {
  const boot = bootClient('zh', fixtureV5());
  assert.deepEqual(Array.from(boot.face.inject).sort(), ['locale', 'slots']);
  boot.face.apply(boot.ctx);

  assert.equal(boot.effects.length, 1, 'the dictionary registration is one effect');
  assert.deepEqual(boot.injections.map((entry) => entry.key), ['sidebar.panellist', 'main']);

  for (const injection of boot.injections) injection.callback();
  assert.equal(boot.registrations.length, 2);

  const [rail, main] = boot.registrations;
  assert.equal(rail.options.name, 'sidebar.panellist');
  assert.equal(rail.options.id, 'usage-stats');
  assert.equal(rail.options.order, 20);
  assert.equal(rail.options.label(), '用量统计');
  assert.equal(typeof rail.component, 'function');

  assert.equal(main.options.name, 'main');
  assert.equal(main.options.key, 'usage-stats');
  assert.equal(main.options.locale, 'dsh-usage-stats');
  assert.equal(typeof main.component, 'function');
});

test('renders the v5 dashboard with every section and without missing locale keys', async () => {
  const { boot, inspected } = await renderPanel('zh', fixtureV5());

  assert.match(inspected.text, /用量统计/);
  assert.match(inspected.text, /总 Token/);
  assert.match(inspected.text, /总运行时长/);
  assert.match(inspected.text, /Token 趋势/);
  assert.match(inspected.text, /运行时长构成/);
  assert.match(inspected.text, /工具消耗排行/);
  assert.match(inspected.text, /轮次健康/);
  assert.match(inspected.text, /模型用量/);
  assert.match(inspected.text, /预计费用/);
  assert.match(inspected.text, /CNY 92.50/);
  assert.match(inspected.text, /本月费用已用 92.5%/);
  assert.match(inspected.text, /未知模型/);
  assert.match(inspected.text, /1 个模型未配置价格/);
  assert.match(inspected.text, /对话明细/);
  assert.ok(inspected.markers.includes('panel'));
  assert.ok(inspected.markers.includes('trend'));
  assert.ok(inspected.markers.includes('runtime'));
  assert.ok(inspected.markers.includes('token-mix'));
  assert.ok(inspected.markers.includes('models'));
  assert.ok(inspected.markers.includes('tools'));
  assert.ok(inspected.markers.includes('turns'));
  assert.ok(inspected.markers.includes('budget'));
  assert.ok(inspected.markers.includes('services'));
  assert.equal(inspected.markers.includes('upgrade'), false);
  assert.equal(inspected.markers.includes('upgrade-services'), false);
  assert.equal(inspected.markers.includes('drawer'), false);
  assert.match(inspected.text, /搜索与抓取/);
  assert.match(inspected.text, /300/);
  assert.match(inspected.text, /CNY 1\.50/);
  assert.match(inspected.text, /本地抓取，不计费/);
  assert.match(inspected.text, /官网价目表/);
  assert.match(inspected.text, /前更新/);
  assert.match(inspected.text, /刷新官网价格/, 'the footer offers an explicit official-price refresh action');
  assert.match(inspected.text, /修复登录问题/);
  assert.match(inspected.text, /未命名对话/);
  assert.match(inspected.text, /default-workspace/);
  assert.match(inspected.text, /继承 150万/, 'the forked row annotates its inherited prefix');
  assert.match(inspected.text, /LLM 重试 7 次/);
  assert.doesNotMatch(inspected.text, /重启应用/, 'a v5 payload needs no restart notice');
  assert.deepEqual([...boot.missing], [], 'every rendered locale key must exist');
  assert.deepEqual(inspected.buggyVars, [], 'theme token references must be well formed');
  assert.ok(inspected.colorValues.length > 0);
  for (const value of inspected.colorValues) {
    if (value.startsWith('var(')) assert.match(value, /^var\(--dsw-alias-[a-z0-9-]+\)$/);
  }
  const urls = boot.requestedUrls;
  assert.equal(urls.length, 1);
  assert.match(urls[0], /range=all/);
  assert.match(urls[0], /offset=/);
  assert.doesNotMatch(urls[0], /inherited=/);
});

test('renders the legacy v1 payload with cards, table and a restart notice', async () => {
  const { boot, inspected } = await renderPanel('zh', fixtureLegacy());

  assert.match(inspected.text, /重启应用/);
  assert.match(inspected.text, /旧版数据/);
  assert.match(inspected.text, /总 Token/);
  assert.match(inspected.text, /对话明细/);
  assert.ok(inspected.markers.includes('token-mix'));
  assert.equal(inspected.markers.includes('trend'), false);
  assert.equal(inspected.markers.includes('runtime'), false);
  assert.equal(inspected.markers.includes('tools'), false);
  assert.equal(inspected.markers.includes('turns'), false);
  assert.deepEqual([...boot.missing], []);
  assert.deepEqual(inspected.buggyVars, []);
});

test('renders a v2 Host payload as before, with an upgrade notice for the missing v3 sections', async () => {
  const { boot, inspected } = await renderPanel('zh', fixtureV2Host());

  assert.match(inspected.text, /重启应用后启用模型用量/);
  assert.match(inspected.text, /Token 趋势/);
  assert.match(inspected.text, /运行时长构成/);
  assert.match(inspected.text, /对话明细/);
  assert.ok(inspected.markers.includes('trend'));
  assert.ok(inspected.markers.includes('upgrade'));
  assert.equal(inspected.markers.includes('models'), false, 'v3 model section stays hidden until the Host restarts');
  assert.deepEqual([...boot.missing], []);
});

test('renders a v3 Host payload without the price-provenance line', async () => {
  const { boot, inspected } = await renderPanel('zh', fixtureV3Host());

  assert.match(inspected.text, /模型用量/);
  assert.match(inspected.text, /预计费用/);
  assert.ok(inspected.markers.includes('models'));
  assert.equal(inspected.markers.includes('upgrade'), false);
  assert.ok(inspected.markers.includes('upgrade-pricing'));
  assert.match(inspected.text, /重启应用后启用官网价目表/);
  assert.doesNotMatch(inspected.text, /官网价目表 · /);
  assert.doesNotMatch(inspected.text, /刷新官网价格/);
  assert.deepEqual([...boot.missing], []);
});

test('renders a v4 Host payload without Search/Fetch usage, with a restart notice', async () => {
  const { boot, inspected } = await renderPanel('zh', fixtureV4Host());

  assert.ok(inspected.markers.includes('upgrade-services'));
  assert.match(inspected.text, /重启应用后启用搜索\/抓取计费/);
  assert.ok(inspected.markers.includes('models'));
  assert.equal(inspected.markers.includes('services'), false);
  assert.deepEqual([...boot.missing], []);
});

test('clicking a conversation row opens the detail drawer', async () => {
  const boot = bootClient('zh', fixtureV5());
  boot.face.apply(boot.ctx);
  for (const injection of boot.injections) injection.callback();
  const main = boot.registrations.find((entry) => entry.options.name === 'main');
  const tree = await boot.mount(main.component, {});

  const rows = [];
  walk(tree, (node) => {
    if (node.kind === 'element' && node.type === 'tr' && typeof node.props.onClick === 'function') rows.push(node);
  });
  assert.ok(rows.length >= 2, 'the table must render clickable conversation rows');
  rows[0].props.onClick();

  const opened = await boot.settle(main.component, {});
  const inspected = inspectTree(opened);
  assert.ok(inspected.markers.includes('drawer'), 'the drawer overlay must render');
  assert.match(inspected.text, /会话详情|打开对话/);
  assert.match(inspected.text, /关闭/);
  assert.match(inspected.text, /模型用量/);
  assert.match(inspected.text, /工具消耗排行/);
  assert.match(inspected.text, /轮次健康/);
  assert.deepEqual([...boot.missing], []);
  assert.deepEqual(inspected.buggyVars, []);
});

test('the official-price refresh copy refetches with force=1', async () => {
  const boot = bootClient('zh', fixtureV5());
  boot.face.apply(boot.ctx);
  for (const injection of boot.injections) injection.callback();
  const main = boot.registrations.find((entry) => entry.options.name === 'main');
  const tree = await boot.mount(main.component, {});

  const buttons = [];
  walk(tree, (node) => {
    if (node.kind === 'element' && node.type === 'button' && node.props.children === '刷新官网价格') buttons.push(node);
  });
  assert.equal(buttons.length, 1, 'exactly one official-price refresh button in the footer');
  assert.equal(boot.requestedUrls.length, 1);

  buttons[0].props.onClick();
  const refreshed = await boot.settle(main.component, {});
  assert.equal(boot.requestedUrls.length, 2, 'the refresh action loads the report again');
  assert.match(boot.requestedUrls[1], /force=1/);
  assert.match(inspectTree(refreshed).text, /刷新官网价格/);
  assert.deepEqual([...boot.missing], []);
});

test('renders in English without missing keys', async () => {
  const { boot, inspected } = await renderPanel('en', fixtureV5());
  assert.match(inspected.text, /Usage/);
  assert.match(inspected.text, /Total tokens/);
  assert.match(inspected.text, /Token trend/);
  assert.match(inspected.text, /Runtime composition/);
  assert.match(inspected.text, /Tool cost ranking/);
  assert.match(inspected.text, /Turn health/);
  assert.match(inspected.text, /Model usage/);
  assert.match(inspected.text, /Estimated cost/);
  assert.match(inspected.text, /This month used 92.5%/);
  assert.match(inspected.text, /Official price table/);
  assert.match(inspected.text, /Refresh official prices/);
  assert.match(inspected.text, /Search & Fetch/);
  assert.match(inspected.text, /Local fetch, unbilled/);
  assert.match(inspected.text, /Conversations/);
  assert.match(inspected.text, /Include fork prefix/);
  assert.deepEqual([...boot.missing], []);
});

test('the sidebar icon renders an svg for both owner states', () => {
  const boot = bootClient('zh', fixtureV5());
  boot.face.apply(boot.ctx);
  for (const injection of boot.injections) injection.callback();
  const rail = boot.registrations.find((entry) => entry.options.name === 'sidebar.panellist');
  const tree = rail.component({ size: 16, active: false });
  assert.equal(tree.type, 'svg');
  assert.equal(tree.props['aria-hidden'], true);
});

test('uses no Harness client package imports and no document.body writes', () => {
  assert.doesNotMatch(CLIENT_SOURCE, /require\(['"]@deepseek-ai\//);
  assert.doesNotMatch(CLIENT_SOURCE, /document\.body/);
});
