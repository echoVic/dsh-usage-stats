/**
 * Unit tests for the price resolver: official-page parsing, user-table
 * normalization, peak/off-peak classification, and the cache → fetch → bundled
 * fallback ladder. No test touches the real network or the real DSH home.
 */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { isPeakAt } from '../lib/aggregate.js';
import {
  PEAK_WINDOWS_UTC,
  fetchOfficialPricing,
  normalizePriceEntry,
  officialPriceMap,
  parseOfficialPricing,
  parseServicePricing,
  resolvePricing,
} from '../lib/pricing.js';

const OFFICIAL_CN = `<html><body><table>
<tr><td colspan="3">MODEL PRICING</td><td>deepseek-flash</td><td>deepseek-v4-pro</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE HIT)</td><td>OFF-PEAK</td><td>0.02元</td><td>0.15元</td></tr>
<tr><td>PEAK</td><td>0.04元</td><td>0.3元</td></tr>
<tr><td rowspan="2">1M INPUT TOKENS<br>(CACHE MISS)</td><td>OFF-PEAK</td><td>1元</td><td>4.5元</td></tr>
<tr><td>PEAK</td><td>2元</td><td>9元</td></tr>
<tr><td rowspan="2">1M OUTPUT TOKENS</td><td>OFF-PEAK</td><td>4元</td><td>13.5元</td></tr>
<tr><td>PEAK</td><td>8元</td><td>27元</td></tr>
</table></body></html>`;

const OFFICIAL_USD = OFFICIAL_CN
  .replace(/0\.02元/g, '$0.003').replace(/0\.15元/g, '$0.022')
  .replace(/0\.04元/g, '$0.006').replace(/0\.3元/g, '$0.044')
  .replace(/1元/g, '$0.15').replace(/4\.5元/g, '$0.66')
  .replace(/2元/g, '$0.3').replace(/9元/g, '$1.32')
  .replace(/4元/g, '$0.6').replace(/13\.5元/g, '$1.98')
  .replace(/8元/g, '$1.2').replace(/27元/g, '$3.96');

const SERVICE_TABLE_CN = `<table><thead><tr><th>API</th><th>计费单位</th><th>价格</th></tr></thead><tbody>
<tr><td>Search</td><td>每 1,000 次成功请求</td><td>5元</td></tr>
<tr><td>Fetch</td><td>每 1,000 次成功请求</td><td>5元</td></tr>
</tbody></table>`;
const SERVICE_TABLE_USD = `<table><thead><tr><th>API</th><th>Unit</th><th>Price</th></tr></thead><tbody>
<tr><td>Search</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr>
<tr><td>Fetch</td><td>Per 1,000 successful requests</td><td>$0.75</td></tr>
</tbody></table>`;
const OFFICIAL_CN_WITH_SERVICES = OFFICIAL_CN.replace('</body>', `${SERVICE_TABLE_CN}</body>`);
const OFFICIAL_USD_WITH_SERVICES = OFFICIAL_USD.replace('</body>', `${SERVICE_TABLE_USD}</body>`);

const PEAK_TIME = Date.UTC(2027, 0, 4, 2, 0, 0); // Monday 02:00 UTC

/** Build a fetch stub returning one HTML body. */
function fetchHtml(html) {
  return async () => ({ ok: true, status: 200, async text() { return html; } });
}

/** Create one scratch directory for the resolver's files. */
function scratch() {
  const directory = mkdtempSync(join(tmpdir(), 'dsh-usage-pricing-'));
  mkdirSync(join(directory, 'usage-stats'), { recursive: true });
  return {
    directory,
    paths: {
      userFile: join(directory, 'usage-stats', 'prices.json'),
      cacheFile: join(directory, 'usage-stats', 'prices.cache.json'),
      bundledFile: join(directory, 'official-prices.json'),
    },
    cleanup() {
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

test('parses the official CNY and USD tables with peak/off-peak tiers', () => {
  const cny = parseOfficialPricing(OFFICIAL_CN_WITH_SERVICES);
  assert.equal(cny.currency, 'CNY');
  assert.deepEqual(cny.models['deepseek-flash'].peak, { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 });
  assert.deepEqual(cny.models['deepseek-flash'].offPeak, { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 });
  assert.deepEqual(cny.models['deepseek-v4-pro'].offPeak, { input: 4.5, cacheRead: 0.15, cacheWrite: 4.5, output: 13.5 });

  assert.deepEqual(cny.services, { currency: 'CNY', unit: 1000, search: 5, fetch: 5 });
  const usd = parseOfficialPricing(OFFICIAL_USD_WITH_SERVICES);
  assert.equal(usd.currency, 'USD');
  assert.deepEqual(usd.services, { currency: 'USD', unit: 1000, search: 0.75, fetch: 0.75 });
  assert.deepEqual(usd.models['deepseek-flash'].peak, { input: 0.3, cacheRead: 0.006, cacheWrite: 0.3, output: 1.2 });
  assert.deepEqual(usd.models['deepseek-v4-pro'].offPeak, { input: 0.66, cacheRead: 0.022, cacheWrite: 0.66, output: 1.98 });
});

test('parses the Search/Fetch per-1,000-request prices', () => {
  assert.deepEqual(parseServicePricing(SERVICE_TABLE_CN), { currency: 'CNY', unit: 1000, search: 5, fetch: 5 });
  assert.deepEqual(parseServicePricing(SERVICE_TABLE_USD), { currency: 'USD', unit: 1000, search: 0.75, fetch: 0.75 });
  assert.equal(parseServicePricing('<table><tr><td>Search</td></tr></table>'), undefined);
});

test('rejects a page without the pricing table', () => {
  assert.throws(() => parseOfficialPricing('<html><body>nothing here</body></html>'), /pricing table/i);
});

test('normalizes flat and tiered entries plus aliases', () => {
  const flat = normalizePriceEntry({ input: 1, cacheRead: 0.1, output: 2 });
  assert.deepEqual(flat.peak, { input: 1, cacheRead: 0.1, cacheWrite: 0, output: 2 });
  assert.deepEqual(flat.offPeak, flat.peak);

  const tiered = normalizePriceEntry({
    peak: { cacheMiss: 2, cacheHit: 0.04, output: 8 },
    offPeak: { cacheMiss: 1, cacheHit: 0.02, output: 4 },
  });
  assert.deepEqual(tiered.peak, { input: 2, cacheRead: 0.04, cacheWrite: 2, output: 8 });
  assert.deepEqual(tiered.offPeak, { input: 1, cacheRead: 0.02, cacheWrite: 1, output: 4 });

  const map = officialPriceMap(parseOfficialPricing(OFFICIAL_CN).models);
  assert.deepEqual(Object.keys(map).sort(), ['deepseek-official/deepseek-flash', 'deepseek-official/deepseek-v4-pro']);
});

test('classifies official peak hours in UTC', () => {
  assert.deepEqual(PEAK_WINDOWS_UTC, [[1, 4], [6, 10]]);
  assert.equal(isPeakAt(PEAK_TIME), true, 'Monday 02:00 UTC is a peak window');
  assert.equal(isPeakAt(Date.UTC(2027, 0, 4, 5, 0)), false, '05:00 UTC is between windows');
  assert.equal(isPeakAt(Date.UTC(2027, 0, 4, 9, 30)), true, '09:30 UTC is a peak window');
  assert.equal(isPeakAt(Date.UTC(2027, 0, 9, 2, 0)), false, 'Saturday is off-peak');
});

test('resolution ladder: fetch, cache, bundled, manual override', async () => {
  const scratchDir = scratch();
  try {
    // 1. Live fetch.
    const auto = await resolvePricing({
      ...scratchDir.paths,
      fetchImpl: fetchHtml(OFFICIAL_CN_WITH_SERVICES),
      envCurrency: 'CNY',
    });
    assert.equal(auto.configured, true);
    assert.equal(auto.currency, 'CNY');
    assert.equal(auto.source.kind, 'auto');
    assert.equal(auto.source.url, 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing');
    assert.deepEqual(auto.prices['deepseek-official/deepseek-flash'].peak.input, 2);
    assert.equal(auto.services.search.pricePerThousand, 5);
    assert.equal(auto.services.search.billed, true, 'harness search goes through the billed Search API');
    assert.equal(auto.services.fetch.pricePerThousand, 5);
    assert.equal(auto.services.fetch.billed, false, 'the shipped fetch provider is a local HTTP fetch');
    assert.equal(auto.servicesConfigured, true);
    assert.ok(existsSync(scratchDir.paths.cacheFile), 'the fetched table is cached');

    // 2. Fresh cache, no fetch (fetchImpl throws).
    const offline = await resolvePricing({
      ...scratchDir.paths,
      fetchImpl: async () => { throw new Error('offline'); },
      envCurrency: 'CNY',
    });
    assert.equal(offline.source.kind, 'cache');
    assert.equal(offline.configured, true);

    // 3. Forced refresh fails, stale cache still wins over the bundle.
    const fallback = await resolvePricing({
      ...scratchDir.paths,
      force: true,
      fetchImpl: async () => { throw new Error('offline'); },
      envCurrency: 'CNY',
    });
    assert.equal(fallback.source.kind, 'cache');
    assert.ok(fallback.warnings.some((warning) => /refresh failed/.test(warning)));

    // 4. No cache: the bundled snapshot is the last resort.
    rmSync(scratchDir.paths.cacheFile, { force: true });
    writeFileSync(scratchDir.paths.bundledFile, JSON.stringify({
      fetchedAt: PEAK_TIME,
      sources: { CNY: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing' },
      tables: { CNY: parseOfficialPricing(OFFICIAL_CN).models },
    }));
    const bundled = await resolvePricing({
      ...scratchDir.paths,
      fetchImpl: async () => { throw new Error('offline'); },
      envCurrency: 'CNY',
    });
    assert.equal(bundled.source.kind, 'bundled');
    assert.equal(bundled.configured, true);
    assert.ok(bundled.warnings.some((warning) => /refresh failed/.test(warning)));

    // 5. The user table overrides official entries and sets the budget.
    writeFileSync(scratchDir.paths.userFile, JSON.stringify({
      budget: { monthly: 100 },
      prices: { 'deepseek-official/deepseek-flash': { input: 9, output: 9 } },
      services: { search: { pricePerThousand: 3 }, fetch: { pricePerThousand: 1, billed: true } },
    }));
    const mixed = await resolvePricing({ ...scratchDir.paths, fetchImpl: fetchHtml(OFFICIAL_CN_WITH_SERVICES), envCurrency: 'CNY' });
    assert.equal(mixed.source.kind, 'mixed');
    assert.deepEqual(mixed.prices['deepseek-official/deepseek-flash'].peak, { input: 9, cacheRead: 0, cacheWrite: 0, output: 9 });
    assert.deepEqual(mixed.prices['deepseek-official/deepseek-v4-pro'].peak, { input: 9, cacheRead: 0.3, cacheWrite: 9, output: 27 });
    assert.equal(mixed.budgetMonthly, 100);
    assert.equal(mixed.services.search.pricePerThousand, 3, 'manual service prices override the official ones');
    assert.equal(mixed.services.fetch.pricePerThousand, 1);
    assert.equal(mixed.services.fetch.billed, true, 'a billable Fetch provider can be opted in');

    // 6. Auto disabled: manual only.
    const manualOnly = await resolvePricing({ ...scratchDir.paths, envAuto: false });
    assert.equal(manualOnly.source.kind, 'manual');
    assert.equal(manualOnly.configured, true);

    // 7. Malformed user table: visible error, no crash.
    writeFileSync(scratchDir.paths.userFile, '{ not json');
    const malformed = await resolvePricing({ ...scratchDir.paths, envAuto: false });
    assert.equal(malformed.configured, false);
    assert.match(malformed.error, /JSON/i);
    assert.ok(malformed.warnings.some((warning) => /price table unreadable/.test(warning)));
  } finally {
    scratchDir.cleanup();
  }
});

test('fetchOfficialPricing reports unreachable pages', async () => {
  await assert.rejects(
    fetchOfficialPricing({ currency: 'USD', fetchImpl: async () => ({ ok: false, status: 503 }) }),
    /responded 503/,
  );
  const saved = readFileSync(new URL('../lib/pricing.js', import.meta.url), 'utf8');
  assert.match(saved, /OFFICIAL_PRICING_URLS/);
});

test('backs off from repeated refresh failures and serves the stale cache', async () => {
  const scratchDir = scratch();
  try {
    const models = parseOfficialPricing(OFFICIAL_USD).models;
    writeFileSync(scratchDir.paths.cacheFile, JSON.stringify({
      schemaVersion: 1,
      currency: 'USD',
      fetchedAt: Date.now() - 48 * 3600_000,
      sourceUrl: 'https://api-docs.deepseek.com/quick_start/pricing',
      models,
    }));
    let calls = 0;
    const failing = async () => {
      calls += 1;
      throw new Error('offline');
    };
    const first = await resolvePricing({ ...scratchDir.paths, force: true, fetchImpl: failing, envCurrency: 'USD' });
    assert.equal(first.source.kind, 'cache');
    assert.equal(calls, 1);
    assert.ok(first.warnings.some((warning) => /refresh failed/.test(warning)));

    // The negative cache keeps an offline machine from re-fetching on every request.
    const second = await resolvePricing({ ...scratchDir.paths, fetchImpl: failing, envCurrency: 'USD' });
    assert.equal(calls, 1, 'a recent failure backs off; the fetch is not retried');
    assert.equal(second.source.kind, 'cache');
    assert.ok(second.warnings.some((warning) => /backoff/.test(warning)));
    assert.equal(second.configured, true);
  } finally {
    scratchDir.cleanup();
  }
});

test('background mode answers from the stale cache and refreshes for the next report', async () => {
  const scratchDir = scratch();
  try {
    // Clear any refresh-failure backoff left by earlier tests with one good fetch.
    await resolvePricing({ ...scratchDir.paths, force: true, fetchImpl: fetchHtml(OFFICIAL_CN_WITH_SERVICES), envCurrency: 'CNY' });
    const oldModels = parseOfficialPricing(OFFICIAL_CN_WITH_SERVICES).models;
    writeFileSync(scratchDir.paths.cacheFile, JSON.stringify({
      schemaVersion: 1,
      currency: 'CNY',
      fetchedAt: Date.now() - 48 * 3600_000,
      sourceUrl: 'https://api-docs.deepseek.com/zh-cn/quick_start/pricing',
      models: oldModels,
      services: parseServicePricing(SERVICE_TABLE_CN),
    }));
    const slowFetch = async () => {
      await new Promise((resolve) => setTimeout(resolve, 250));
      return { ok: true, status: 200, async text() { return OFFICIAL_CN_WITH_SERVICES; } };
    };
    const startedAt = performance.now();
    const fast = await resolvePricing({
      ...scratchDir.paths,
      background: true,
      fetchImpl: slowFetch,
      envCurrency: 'CNY',
    });
    const elapsed = performance.now() - startedAt;
    assert.ok(elapsed < 150, `a stale cache answers without waiting for the docs fetch (${Math.round(elapsed)}ms)`);
    assert.equal(fast.source.kind, 'cache');
    assert.equal(fast.source.pendingRefresh, true);
    assert.equal(fast.configured, true);

    // The queued refresh lands in the cache file shortly after.
    for (let attempt = 0; attempt < 20; attempt += 1) {
      const cached = JSON.parse(readFileSync(scratchDir.paths.cacheFile, 'utf8'));
      if (cached.fetchedAt > Date.now() - 5000) break;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const cached = JSON.parse(readFileSync(scratchDir.paths.cacheFile, 'utf8'));
    assert.ok(cached.fetchedAt > Date.now() - 5000, 'the background refresh updated the disk cache');

    const after = await resolvePricing({ ...scratchDir.paths, background: true, fetchImpl: slowFetch, envCurrency: 'CNY' });
    assert.equal(after.source.kind, 'cache');
    assert.equal(after.source.pendingRefresh, false, 'a fresh cache needs no background refresh');
  } finally {
    scratchDir.cleanup();
  }
});
