/**
 * Price resolution for the usage panel.
 *
 * The Harness session log carries token counts, not money. Cost therefore comes
 * from a price table with two possible sources:
 *
 * 1. the **official DeepSeek pricing page**, fetched from api-docs.deepseek.com
 *    (USD page for `USD`, the zh-cn page for `CNY`), parsed out of its HTML
 *    table and cached on disk for a configurable TTL;
 * 2. the **user table** at `$DSH_HOME/usage-stats/prices.json` (or
 *    `DSH_USAGE_STATS_PRICES`), whose entries override the official ones.
 *
 * The official page publishes **two tiers**: PEAK and OFF-PEAK (off-peak is half
 * the peak price). Peak hours are Beijing-time weekdays 09:00–12:00 and
 * 14:00–18:00, i.e. 01:00–04:00 and 06:00–10:00 UTC on weekdays. `isPeakAt()`
 * classifies a usage sample by that calendar; Chinese statutory holidays are
 * not modeled (documented approximation).
 *
 * A bundled snapshot (`official-prices.json`) keeps cost working offline or when
 * the docs page is unreachable. Parsing is deliberately defensive: an unknown
 * page shape throws, and the loader falls back to the cached/bundled table
 * instead of breaking the panel.
 */
import { readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { PEAK_WINDOWS_UTC, PEAK_WEEKDAYS, isPeakAt } from './aggregate.js';

export { PEAK_WINDOWS_UTC, PEAK_WEEKDAYS, isPeakAt };

/** Official pricing pages per supported currency. */
export const OFFICIAL_PRICING_URLS = Object.freeze({
  CNY: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
  USD: 'https://api-docs.deepseek.com/quick_start/pricing',
});

/** Currencies the bundled snapshot carries. */
export const SUPPORTED_CURRENCIES = Object.freeze(['CNY', 'USD']);

/** Default auto-refresh window for the cached official table. */
export const DEFAULT_TTL_HOURS = 24;

/** Upper bound on one official-page fetch. */
const FETCH_TIMEOUT_MS = 8000;

/** After a failed refresh, skip retries for this long so an offline machine stays fast. */
const REFRESH_BACKOFF_MS = 5 * 60000;

/** In-process failure timestamps per currency (a fetch failure must not repeat on every request). */
const refreshFailures = new Map();

/** In-flight background refreshes per currency, so concurrent reports share one fetch. */
const backgroundRefreshes = new Map();

/**
 * Decode the few HTML entities the pricing table uses.
 * @param text - raw cell text.
 * @returns decoded text.
 */
function decodeEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);/gi, (_, value) => String.fromCodePoint(Number(value)));
}

/**
 * Plain text of one HTML fragment (drops tags, superscripts and links).
 * @param html - fragment.
 * @returns normalized text.
 */
function cellText(html) {
  return decodeEntities(
    html
      .replace(/<sup\b[\s\S]*?<\/sup>/gi, '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

/**
 * Parse one money cell.
 * @param text - cell text, e.g. `$0.15`, `1元`, `0.022`.
 * @returns `{ amount, currency }` or undefined.
 */
function parseMoney(text) {
  const match = /([$¥￥]|元)?\s*([0-9]+(?:\.[0-9]+)?)/.exec(text);
  if (match === null) return undefined;
  const amount = Number.parseFloat(match[2]);
  if (!Number.isFinite(amount)) return undefined;
  const symbol = match[1];
  const currency = symbol === '$' ? 'USD' : symbol === '元' || symbol === '¥' || symbol === '￥' ? 'CNY' : undefined;
  return { amount, currency };
}

/**
 * Normalize one bucket record to the four billing buckets.
 * @param raw - `{ input, cacheRead, cacheWrite, output }` with aliases.
 * @returns normalized buckets (missing values are 0).
 */
function normalizeBuckets(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const count = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  return {
    input: count(source.input ?? source.cacheMiss ?? source.cache_miss),
    cacheRead: count(source.cacheRead ?? source.cacheHit ?? source.cache_hit),
    cacheWrite: count(source.cacheWrite ?? source.cacheMiss ?? source.cache_miss),
    output: count(source.output ?? source.outputTokens),
  };
}

/**
 * Normalize one explicit price entry into peak/off-peak tiers.
 * A flat entry means the same price in both tiers.
 * @param raw - flat or `{ peak, offPeak }` entry.
 * @returns `{ peak, offPeak }` buckets.
 */
export function normalizePriceEntry(raw) {
  const source = raw !== null && typeof raw === 'object' ? raw : {};
  const flat = normalizeBuckets(source);
  const peak = source.peak !== null && typeof source.peak === 'object' ? normalizeBuckets(source.peak) : flat;
  const offPeak = source.offPeak !== null && typeof source.offPeak === 'object' ? normalizeBuckets(source.offPeak) : flat;
  return { peak, offPeak };
}

/**
 * Parse the official pricing page's model table.
 *
 * @param html - page HTML.
 * @returns `{ currency, models }`: per model id, `{ peak, offPeak }` where each
 *   tier is `{ input, cacheRead, cacheWrite, output }` per 1M tokens.
 * @throws when the page no longer carries the expected table.
 */
export function parseOfficialPricing(html) {
  const text = typeof html === 'string' ? html : '';
  const tables = [...text.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((match) => match[0]);
  const table = tables.find((candidate) => /PRICING|价格/i.test(candidate) && /CACHE\s+HIT|缓存命中/i.test(candidate));
  if (table === undefined) throw new Error('official pricing table not found on the page');

  const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  if (rows.length === 0) throw new Error('official pricing table has no rows');
  const cellsOf = (row) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => cellText(match[1]));

  // Header row: a label cell followed by one cell per model column.
  const header = cellsOf(rows[0]).slice(1).filter((cell) => /^[a-z0-9][a-z0-9._-]*$/i.test(cell));
  if (header.length === 0) throw new Error('official pricing table has no model columns');
  const modelIds = header;

  const models = {};
  for (const id of modelIds) models[id] = { peak: { cacheHit: undefined, cacheMiss: undefined, output: undefined }, offPeak: { cacheHit: undefined, cacheMiss: undefined, output: undefined } };
  let currency;

  // The category label (CACHE HIT / CACHE MISS / OUTPUT) is a rowspan cell in
  // the first row of each pair; the following PEAK row inherits it.
  let lastGroup;
  for (const row of rows) {
    const cells = cellsOf(row);
    if (cells.length === 0) continue;
    const joined = cells.join(' ').toUpperCase();
    let group;
    if (/CACHE\s*HIT|缓存命中/.test(joined)) group = 'cacheHit';
    else if (/CACHE\s*MISS|缓存未命中/.test(joined)) group = 'cacheMiss';
    else if (/(^|\b)OUTPUT\b|输出/.test(joined)) group = 'output';
    if (group !== undefined) lastGroup = group;
    const offPeak = /OFF-PEAK|空闲/.test(joined);
    const peak = !offPeak && /(^|\b)PEAK\b|高峰/.test(joined);
    if (!offPeak && !peak) continue;
    const category = group ?? lastGroup;
    if (category === undefined) continue;
    const values = cells.slice(-modelIds.length).map(parseMoney);
    if (values.some((value) => value === undefined)) continue;
    for (let index = 0; index < modelIds.length; index += 1) {
      const value = values[index];
      if (value.currency !== undefined) currency ??= value.currency;
      models[modelIds[index]][offPeak ? 'offPeak' : 'peak'][category] = value.amount;
    }
  }

  const result = {};
  for (const id of modelIds) {
    const entry = models[id];
    const complete = ['cacheHit', 'cacheMiss', 'output'].every((key) => typeof entry.peak[key] === 'number' && typeof entry.offPeak[key] === 'number');
    if (!complete) continue;
    const toBuckets = (tier) => normalizeBuckets({ input: tier.cacheMiss, cacheRead: tier.cacheHit, cacheWrite: tier.cacheMiss, output: tier.output });
    result[id] = { peak: toBuckets(entry.peak), offPeak: toBuckets(entry.offPeak) };
  }
  if (Object.keys(result).length === 0) throw new Error('official pricing table contained no complete model rows');
  const resolvedCurrency = currency ?? (html.includes('元') ? 'CNY' : 'USD');
  const services = parseServicePricing(html);
  return {
    currency: resolvedCurrency,
    models: result,
    ...(services === undefined ? {} : { services: { ...services, currency: services.currency ?? resolvedCurrency } }),
  };
}

/**
 * Parse the official Search/Fetch service-price table.
 * @param html - page HTML.
 * @returns `{ currency, unit, search, fetch }` (price per `unit` requests) or undefined.
 */
export function parseServicePricing(html) {
  const text = typeof html === 'string' ? html : '';
  const tables = [...text.matchAll(/<table\b[\s\S]*?<\/table>/gi)].map((match) => match[0]);
  const table = tables.find((candidate) => /Search/i.test(candidate) && /Fetch/i.test(candidate) && /1,?000/.test(candidate));
  if (table === undefined) return undefined;
  const rows = [...table.matchAll(/<tr\b[\s\S]*?<\/tr>/gi)].map((match) => match[0]);
  const cellsOf = (row) => [...row.matchAll(/<t[dh]\b[^>]*>([\s\S]*?)<\/t[dh]>/gi)].map((match) => cellText(match[1]));
  let currency;
  const services = {};
  for (const row of rows) {
    const cells = cellsOf(row);
    if (cells.length < 2) continue;
    const kind = cells[0].trim().toLowerCase();
    if (kind !== 'search' && kind !== 'fetch') continue;
    if (!/1,?000/.test(cells.join(' '))) continue;
    const money = parseMoney(cells[cells.length - 1]);
    if (money === undefined) continue;
    if (money.currency !== undefined) currency ??= money.currency;
    services[kind] = money.amount;
  }
  if (typeof services.search !== 'number' || typeof services.fetch !== 'number') return undefined;
  return { currency: currency ?? (html.includes('元') ? 'CNY' : 'USD'), unit: 1000, search: services.search, fetch: services.fetch };
}

/**
 * Convert a parsed official table into the panel's provider-qualified price map.
 * @param models - parsed per-model tiers.
 * @param provider - harness provider id the entries apply to.
 * @returns price map keyed `provider/model`.
 */
export function officialPriceMap(models, provider = 'deepseek-official') {
  const map = {};
  for (const [id, tiers] of Object.entries(models)) {
    map[`${provider}/${id}`] = normalizePriceEntry(tiers);
  }
  return map;
}

/**
 * Fetch and parse one official pricing page.
 * @param options - `{ currency, fetchImpl, timeoutMs }`.
 * @returns `{ currency, models, sourceUrl, fetchedAt }`.
 */
export async function fetchOfficialPricing(options = {}) {
  const currency = options.currency === 'USD' ? 'USD' : 'CNY';
  const url = typeof options.url === 'string' && options.url.length > 0 ? options.url : OFFICIAL_PRICING_URLS[currency];
  const fetchImpl = typeof options.fetchImpl === 'function' ? options.fetchImpl : globalThis.fetch;
  if (typeof fetchImpl !== 'function') throw new Error('global fetch is unavailable in this runtime');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Number.isFinite(options.timeoutMs) ? options.timeoutMs : FETCH_TIMEOUT_MS);
  try {
    const response = await fetchImpl(url, {
      headers: { 'user-agent': 'dsh-usage-stats (+https://github.com/echoVic/dsh-usage-stats)' },
      signal: controller.signal,
    });
    if (response === null || typeof response !== 'object' || response.ok === false) {
      throw new Error(`official pricing page responded ${response?.status ?? 'unexpected'}`);
    }
    const html = typeof response.text === 'function' ? await response.text() : '';
    const parsed = parseOfficialPricing(html);
    return { ...parsed, sourceUrl: url, fetchedAt: Date.now() };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read one JSON file, returning undefined when missing/unreadable.
 * @param path - file path.
 * @returns parsed JSON or undefined.
 */
async function readJson(path) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch {
    return undefined;
  }
}

/**
 * Read one JSON file, reporting parse errors separately from a missing file.
 * @param path - file path.
 * @returns `{ value, error, missing }`.
 */
async function readJsonWithError(path) {
  try {
    return { value: JSON.parse(await readFile(path, 'utf8')), error: null, missing: false };
  } catch (error) {
    const missing = error !== null && typeof error === 'object' && error.code === 'ENOENT';
    return { value: undefined, error: missing ? null : error instanceof Error ? error.message : String(error), missing };
  }
}

/**
 * Write one JSON file atomically enough for a cache.
 * @param path - target path.
 * @param value - JSON value.
 */
async function writeJson(path, value) {
  const temporary = join(dirname(path), `.${Date.now()}-${Math.random().toString(36).slice(2, 8)}.tmp`);
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`);
  await rename(temporary, path);
}

/**
 * Read the bundled offline snapshot for one currency.
 * @param bundledPath - snapshot file path.
 * @param currency - CNY or USD.
 * @returns `{ models, fetchedAt, sourceUrl }` or undefined.
 */
async function bundledTable(bundledPath, currency) {
  const snapshot = await readJson(bundledPath);
  if (snapshot === null || typeof snapshot !== 'object') return undefined;
  const table = snapshot.tables?.[currency];
  if (table === null || typeof table !== 'object') return undefined;
  // schemaVersion 2 wraps `{ models, services }`; the first snapshot stored the
  // model map directly.
  const models = table.models !== null && typeof table.models === 'object' ? table.models : table;
  const services = table.services !== null && typeof table.services === 'object' ? table.services : undefined;
  if (models === null || typeof models !== 'object' || Object.keys(models).length === 0) return undefined;
  return {
    models,
    services,
    fetchedAt: typeof snapshot.fetchedAt === 'number' ? snapshot.fetchedAt : null,
    sourceUrl: snapshot.sources?.[currency] ?? OFFICIAL_PRICING_URLS[currency],
  };
}

/**
 * Resolve the official price table for one currency: cache → fetch → bundle.
 * @param options - `{ currency, cacheFile, bundledFile, ttlMs, force, fetchImpl, url }`.
 * @returns `{ models, fetchedAt, sourceUrl, kind, warning }`.
 */
/**
 * Re-fetch the official table in the background and refresh the disk cache.
 * Never awaited by a report; failures only set the per-currency backoff.
 * @param options - loader options.
 * @param currency - CNY or USD.
 */
function queueBackgroundRefresh(options, currency) {
  if (backgroundRefreshes.has(currency)) return;
  const task = fetchOfficialPricing({ currency, fetchImpl: options.fetchImpl, url: options.url })
    .then(async (fetched) => {
      try {
        await writeJson(options.cacheFile, {
          schemaVersion: 1,
          currency,
          fetchedAt: fetched.fetchedAt,
          sourceUrl: fetched.sourceUrl,
          models: fetched.models,
          services: fetched.services,
        });
      } catch {
        // A read-only cache directory only costs the next fetch.
      }
      refreshFailures.delete(currency);
    })
    .catch(() => {
      refreshFailures.set(currency, Date.now());
    })
    .finally(() => {
      backgroundRefreshes.delete(currency);
    });
  backgroundRefreshes.set(currency, task);
}

/**
 * Resolve an immediately available table (stale cache, then bundled snapshot).
 * @param options - loader options.
 * @param currency - CNY or USD.
 * @param cached - the parsed cache file.
 * @param warning - warning to attach.
 * @returns the fallback record or undefined.
 */
async function immediateTable(options, currency, cached, warning) {
  if (cached !== null && typeof cached === 'object' && cached.currency === currency && typeof cached.models === 'object' && Object.keys(cached.models).length > 0) {
    return {
      models: cached.models,
      services: cached.services !== null && typeof cached.services === 'object' ? cached.services : undefined,
      fetchedAt: cached.fetchedAt ?? null,
      sourceUrl: cached.sourceUrl ?? OFFICIAL_PRICING_URLS[currency],
      kind: 'cache',
      warning,
      pendingRefresh: options.pendingRefresh === true,
    };
  }
  const bundled = await bundledTable(options.bundledFile, currency);
  if (bundled === undefined) return undefined;
  return {
    models: bundled.models,
    services: bundled.services,
    fetchedAt: bundled.fetchedAt,
    sourceUrl: bundled.sourceUrl,
    kind: 'bundled',
    warning,
    pendingRefresh: options.pendingRefresh === true,
  };
}

async function loadOfficialTable(options) {
  const currency = options.currency === 'USD' ? 'USD' : 'CNY';
  const cached = await readJson(options.cacheFile);
  const cacheFresh = cached !== null && typeof cached === 'object'
    && cached.currency === currency
    && typeof cached.fetchedAt === 'number'
    && typeof cached.models === 'object'
    && Object.keys(cached.models).length > 0
    && (options.force !== true)
    && Date.now() - cached.fetchedAt < options.ttlMs;
  if (cacheFresh) {
    return {
      models: cached.models,
      services: cached.services !== null && typeof cached.services === 'object' ? cached.services : undefined,
      fetchedAt: cached.fetchedAt,
      sourceUrl: cached.sourceUrl ?? OFFICIAL_PRICING_URLS[currency],
      kind: 'cache',
      warning: null,
    };
  }

  /** Use the stale cache, then the bundled snapshot; throw when neither exists. */
  const fallback = async (reason) => {
    if (cached !== null && typeof cached === 'object' && cached.currency === currency && typeof cached.models === 'object' && Object.keys(cached.models).length > 0) {
      return {
        models: cached.models,
        services: cached.services !== null && typeof cached.services === 'object' ? cached.services : undefined,
        fetchedAt: cached.fetchedAt ?? null,
        sourceUrl: cached.sourceUrl ?? OFFICIAL_PRICING_URLS[currency],
        kind: 'cache',
        warning: `refresh failed: ${reason}`,
      };
    }
    const bundled = await bundledTable(options.bundledFile, currency);
    if (bundled !== undefined) {
      return { models: bundled.models, services: bundled.services, fetchedAt: bundled.fetchedAt, sourceUrl: bundled.sourceUrl, kind: 'bundled', warning: `refresh failed: ${reason}` };
    }
    throw new Error(reason);
  };

  // Stale-while-revalidate: answer from the stale cache (or the bundled
  // snapshot) right away and refresh for the next report, so a docs fetch never
  // blocks the panel.
  if (options.background === true && options.force !== true) {
    const failedAt = refreshFailures.get(currency) ?? 0;
    const backedOff = Date.now() - failedAt < REFRESH_BACKOFF_MS;
    const immediate = await immediateTable(options, currency, cached, null);
    if (immediate !== undefined) {
      if (!backedOff) queueBackgroundRefresh(options, currency);
      return { ...immediate, pendingRefresh: !backedOff };
    }
  }

  // Do not hammer an unreachable docs page on every request.
  const failedAt = refreshFailures.get(currency) ?? 0;
  if (options.force !== true && Date.now() - failedAt < REFRESH_BACKOFF_MS) {
    return fallback('refresh backoff (recent failure)');
  }

  try {
    const fetched = await fetchOfficialPricing({ currency, fetchImpl: options.fetchImpl, url: options.url });
    try {
      await writeJson(options.cacheFile, {
        schemaVersion: 1,
        currency,
        fetchedAt: fetched.fetchedAt,
        sourceUrl: fetched.sourceUrl,
        models: fetched.models,
        services: fetched.services,
      });
    } catch {
      // A read-only cache directory only costs the next fetch.
    }
    refreshFailures.delete(currency);
    return { models: fetched.models, services: fetched.services, fetchedAt: fetched.fetchedAt, sourceUrl: fetched.sourceUrl, kind: 'auto', warning: null };
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    refreshFailures.set(currency, Date.now());
    return fallback(reason);
  }
}

/**
 * Resolve the complete pricing block for one report.
 *
 * @param options - paths plus request controls:
 *   `{ userFile, cacheFile, bundledFile, force, fetchImpl, envAuto }`.
 * @returns normalized pricing block consumed by summarize() plus provenance.
 */
export async function resolvePricing(options = {}) {
  const warnings = [];
  const userRead = await readJsonWithError(options.userFile);
  if (userRead.error !== null) warnings.push(`price table unreadable: ${userRead.error}`);
  const user = userRead.value;
  const document = user !== null && typeof user === 'object' ? user : {};
  const autoConfig = document.auto;
  const autoEnabled = options.envAuto === false
    ? false
    : autoConfig === false
      ? false
      : !(autoConfig !== null && typeof autoConfig === 'object' && autoConfig.enabled === false);
  const envCurrency = options.envCurrency;
  const autoObject = autoConfig !== null && typeof autoConfig === 'object' ? autoConfig : {};
  const manualCurrency = typeof document.currency === 'string' && document.currency.trim().length > 0 ? document.currency.trim().toUpperCase() : undefined;
  const preferredCurrency = [manualCurrency, typeof autoObject.currency === 'string' ? autoObject.currency.toUpperCase() : undefined, envCurrency, 'CNY']
    .find((value) => value === 'CNY' || value === 'USD') ?? 'CNY';
  const ttlHours = typeof autoObject.ttlHours === 'number' && Number.isFinite(autoObject.ttlHours) && autoObject.ttlHours > 0
    ? autoObject.ttlHours
    : DEFAULT_TTL_HOURS;
  const manualPrices = {};
  if (document.prices !== null && typeof document.prices === 'object' && !Array.isArray(document.prices)) {
    for (const [key, entry] of Object.entries(document.prices)) {
      if (entry !== null && typeof entry === 'object') manualPrices[key] = normalizePriceEntry(entry);
    }
  }
  const budgetMonthly = document.budget !== null && typeof document.budget === 'object'
    && typeof document.budget.monthly === 'number' && Number.isFinite(document.budget.monthly) && document.budget.monthly >= 0
    ? document.budget.monthly
    : null;

  let official = null;
  let officialError = null;
  if (autoEnabled) {
    try {
      official = await loadOfficialTable({
        currency: preferredCurrency,
        cacheFile: options.cacheFile,
        bundledFile: options.bundledFile,
        ttlMs: ttlHours * 3600000,
        force: options.force === true,
        background: options.background === true,
        fetchImpl: options.fetchImpl,
        url: typeof autoObject.url === 'string' && autoObject.url.length > 0 ? autoObject.url : undefined,
      });
      if (official.warning !== null) warnings.push(official.warning);
    } catch (error) {
      officialError = error instanceof Error ? error.message : String(error);
      warnings.push(`official price refresh failed: ${officialError}`);
    }
  }

  const provider = typeof autoObject.provider === 'string' && autoObject.provider.length > 0 ? autoObject.provider : 'deepseek-official';
  const prices = {
    ...(official !== null ? officialPriceMap(official.models, provider) : {}),
    ...manualPrices,
  };

  // Service prices are per 1,000 successful requests. `search` is billed by the
  // DeepSeek Search API this harness calls; `fetch` defaults to unbilled because
  // the shipped web_fetch provider performs a local HTTP fetch, not a Fetch API
  // request — a composition that bills Fetch can opt in through the user file.
  const manualServices = document.services !== null && typeof document.services === 'object' && !Array.isArray(document.services)
    ? document.services
    : {};
  const serviceEntry = (kind, officialPrice, defaultBilled) => {
    const manual = manualServices[kind];
    const object = manual !== null && typeof manual === 'object' ? manual : {};
    const manualPrice = typeof manual === 'number' && Number.isFinite(manual) && manual >= 0 ? manual : undefined;
    const pricePerThousand = typeof manualPrice === 'number'
      ? manualPrice
      : typeof object.pricePerThousand === 'number' && Number.isFinite(object.pricePerThousand) && object.pricePerThousand >= 0
        ? object.pricePerThousand
        : typeof officialPrice === 'number' && Number.isFinite(officialPrice)
          ? officialPrice
          : null;
    const billed = typeof object.billed === 'boolean' ? object.billed : defaultBilled;
    return { pricePerThousand, billed, currency: preferredCurrency };
  };
  const officialServices = official !== null && official.services !== null && typeof official.services === 'object' ? official.services : {};
  const services = {
    search: serviceEntry('search', officialServices.search, true),
    fetch: serviceEntry('fetch', officialServices.fetch, false),
  };
  const servicesConfigured = (typeof services.search.pricePerThousand === 'number' && services.search.billed)
    || (typeof services.fetch.pricePerThousand === 'number' && services.fetch.billed);
  const configured = Object.keys(prices).length > 0 || servicesConfigured;
  const manualCount = Object.keys(manualPrices).length;
  const kind = official !== null && manualCount > 0
    ? 'mixed'
    : official !== null
      ? official.kind
      : manualCount > 0
        ? 'manual'
        : 'none';
  return {
    configured,
    currency: preferredCurrency,
    budgetMonthly,
    prices,
    services,
    servicesConfigured,
    peakWindows: PEAK_WINDOWS_UTC,
    weekdays: PEAK_WEEKDAYS,
    source: {
      kind,
      url: official?.sourceUrl ?? null,
      fetchedAt: official?.fetchedAt ?? null,
      pendingRefresh: official?.pendingRefresh === true,
      ttlHours,
      provider,
      userFile: options.userFile,
      cacheFile: options.cacheFile,
    },
    warnings,
    error: !configured ? (officialError ?? userRead.error) : null,
  };
}
