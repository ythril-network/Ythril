/**
 * A slow collector must degrade one graph, not blind the whole target.
 *
 * ## Why this exists
 *
 * The canary measured `/metrics` exceeding its 10 s Prometheus timeout during an embedding run, twice, with
 * `up=0` for both windows. The consequence is out of proportion to the cause: a slow scrape does not lose the
 * slow collector's series, it drops **every** series from that target — HTTP latency, event-loop lag, embed
 * throughput, including the ones that would explain the outage. Their words, and they are right:
 *
 *     "A missing series is a gap in one graph; a failed scrape drops every series from that target."
 *
 * So the guarantee under test is not "collection is fast". It is: **the scrape returns inside its budget, says
 * so when it had to give something up, and names what.**
 *
 * ## What each test is defending against, and how it fails if the guard is gone
 *
 *  1. **The scrape returns inside the budget.** Without the race, this test blocks for the collector's full
 *     sleep and the deadline assertion fails. This is the whole point of the change.
 *  2. **The abandoned collector's series are DROPPED, not left stale.** Stale numbers presented as current are
 *     indistinguishable from a healthy flat line — an operator reads "storage steady" off a collector that has
 *     not answered in an hour. Remove the `abandon()` call and this fails.
 *  3. **The timeout is counted against the collector's own name.** This is the half that also does the
 *     diagnosis: the counter names the slow collector without anyone having to catch a scrape mid-ingest.
 *  4. **`ythril_metrics_scrape_degraded` is 1 for the scrape it describes**, not the one after. Set it from
 *     `endScrape()` instead of from the timeout and this fails — it would always be one scrape behind.
 *  5. **A clean scrape reports 0**, so the flag is usable in an alert rather than latching forever.
 *  6. **A collector that THROWS keeps its previous values.** This is the no-behaviour-change guard: an error is
 *     "momentarily unavailable" (MongoDB not ready at boot, the normal case), a timeout is "unknown". Only the
 *     second may drop data. Make the wrapper abandon on error too and this fails.
 *  7. **`METRICS_SCRAPE_BUDGET_MS=0` restores the old all-or-nothing behaviour**, because an escape hatch that
 *     does not work is worse than none.
 *  8. **A malformed budget falls back to the default rather than to 0.** A typo in a deployment env var must not
 *     silently switch the guard off.
 *  9. **No async collector bypasses the wrapper.** The gate. One that awaits outside the budget re-creates the
 *     original bug silently: the scrape just gets slow again with nothing naming the cause.
 *
 * Each scenario imports a **fresh** registry via a cache-busting query string, because the budget is read from
 * the environment once at module load — which is correct for a server and inconvenient for a test.
 *
 * Run: node --test testing/standalone/scrape-budget.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Gauge } from 'prom-client';

const REGISTRY = '../../server/dist/metrics/registry.js';
const SOURCE = 'server/src/metrics/registry.js'.replace('/dist/', '/src/');

let bust = 0;
/** Load a fresh registry module with a chosen budget. */
async function loadRegistry(budgetMs) {
  if (budgetMs === null) delete process.env.METRICS_SCRAPE_BUDGET_MS;
  else process.env.METRICS_SCRAPE_BUDGET_MS = String(budgetMs);
  return import(`${REGISTRY}?budget=${budgetMs}-${bust++}`);
}

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/**
 * Register a collector that takes `workMs` and reports one value.
 * `mode: 'throw'` makes it fail instead, which must NOT drop its values.
 */
function slowCollector(mod, { name, workMs, mode = 'ok' }) {
  const gauge = new Gauge({
    name: `test_slow_${name}`,
    help: 'test collector',
    labelNames: ['space'],
    registers: [mod.register],
    async collect() {
      await mod.withCollectBudget(name, async () => {
        await sleep(workMs);
        if (mode === 'throw') throw new Error('collector failed');
        this.set({ space: 'alpha' }, 42);
      }, () => this.reset());
    },
  });
  return gauge;
}

/** One full scrape through the same begin/end window the route uses. */
async function scrape(mod) {
  mod.beginScrape();
  try {
    return await mod.register.metrics();
  } finally {
    mod.endScrape();
  }
}

const valueOf = (text, series) => {
  const line = text.split('\n').find(l => l.startsWith(series + ' '));
  return line ? Number(line.slice(series.length + 1)) : null;
};

describe('the scrape budget', () => {
  it('1. returns inside the budget even when a collector runs long past it', async () => {
    const mod = await loadRegistry(120);
    slowCollector(mod, { name: 'media_job_phase', workMs: 3000 });

    const started = performance.now();
    const text = await scrape(mod);
    const elapsed = performance.now() - started;

    // Generous headroom over the 120 ms budget — the assertion that matters is "not the 3000 ms sleep".
    assert.ok(elapsed < 1500, `scrape took ${Math.round(elapsed)}ms; the budget was 120ms`);
    // And it is a real scrape, not an error page: unrelated series are still served.
    assert.match(text, /ythril_metrics_scrape_degraded/);
  });

  it('2. drops the abandoned collector\'s series rather than serving stale values', async () => {
    const mod = await loadRegistry(2000);
    const g = slowCollector(mod, { name: 'storage_used_bytes', workMs: 10 });

    // First scrape is comfortably inside the budget, so the value lands.
    const first = await scrape(mod);
    assert.equal(valueOf(first, 'test_slow_storage_used_bytes{space="alpha"}'), 42);

    // Now the same collector cannot finish. Its previous value must NOT be re-served.
    g.remove({ space: 'alpha' });
    const mod2 = await loadRegistry(100);
    const g2 = slowCollector(mod2, { name: 'storage_used_bytes', workMs: 10 });
    await scrape(mod2);                       // populate
    g2.collect = async function () {          // then make it slow
      await mod2.withCollectBudget('storage_used_bytes', async () => {
        await sleep(3000);
        this.set({ space: 'alpha' }, 99);
      }, () => this.reset());
    };
    const second = await scrape(mod2);
    assert.equal(
      valueOf(second, 'test_slow_storage_used_bytes{space="alpha"}'), null,
      'a timed-out collector served its previous value — an operator cannot tell that from a healthy flat line',
    );
  });

  it('3. counts the timeout against the collector\'s own name', async () => {
    const mod = await loadRegistry(100);
    slowCollector(mod, { name: 'media_jobs_pending', workMs: 3000 });
    const text = await scrape(mod);

    assert.equal(
      valueOf(text, 'ythril_metrics_collect_timeouts_total{collector="media_jobs_pending"}'), 1,
      'the timeout counter is what names the slow collector without catching a scrape mid-ingest',
    );
    // Every other collector must still read 0 — a counter that blames everything blames nothing.
    assert.equal(valueOf(text, 'ythril_metrics_collect_timeouts_total{collector="media_job_phase"}'), 0);
  });

  it('4. reports degraded=1 on the scrape it describes, not the next one', async () => {
    const mod = await loadRegistry(100);
    slowCollector(mod, { name: 'edges_total', workMs: 3000 });
    const text = await scrape(mod);
    assert.equal(
      valueOf(text, 'ythril_metrics_scrape_degraded'), 1,
      'set from endScrape() this would be 0 here and 1 next time — an alert one scrape behind',
    );
  });

  it('5. reports degraded=0 for a clean scrape, so the flag does not latch', async () => {
    const mod = await loadRegistry(2000);
    slowCollector(mod, { name: 'entities_total', workMs: 5 });
    const first = await scrape(mod);
    assert.equal(valueOf(first, 'ythril_metrics_scrape_degraded'), 0);

    // And it clears after a degraded one rather than staying stuck at 1.
    const mod2 = await loadRegistry(80);
    slowCollector(mod2, { name: 'entities_total', workMs: 3000 });
    assert.equal(valueOf(await scrape(mod2), 'ythril_metrics_scrape_degraded'), 1);
    // Same module, but now nothing is slow: a second window must reset the flag.
    mod2.register.removeSingleMetric('test_slow_entities_total');
    slowCollector(mod2, { name: 'entities_total', workMs: 5 });
    assert.equal(
      valueOf(await scrape(mod2), 'ythril_metrics_scrape_degraded'), 0,
      'degraded latched at 1 — an operator would see a permanent alert and start ignoring it',
    );
  });

  it('6. keeps previous values when a collector THROWS, because that is not the same as unknown', async () => {
    const mod = await loadRegistry(2000);
    const g = slowCollector(mod, { name: 'chrono_entries_total', workMs: 5 });
    assert.equal(valueOf(await scrape(mod), 'test_slow_chrono_entries_total{space="alpha"}'), 42);

    g.collect = async function () {
      await mod.withCollectBudget('chrono_entries_total', async () => {
        throw new Error('MongoDB not ready');
      }, () => this.reset());
    };
    const text = await scrape(mod);
    assert.equal(
      valueOf(text, 'test_slow_chrono_entries_total{space="alpha"}'), 42,
      'an error dropped the values; MongoDB briefly unavailable at boot is the normal case and pre-dates this change',
    );
    assert.equal(
      valueOf(text, 'ythril_metrics_scrape_degraded'), 0,
      'an error is not a budget failure and must not raise the degraded flag',
    );
  });

  it('7. honours METRICS_SCRAPE_BUDGET_MS=0 as "no budget", restoring all-or-nothing', async () => {
    const mod = await loadRegistry(0);
    slowCollector(mod, { name: 'facts_total', workMs: 250 });

    const started = performance.now();
    const text = await scrape(mod);
    const elapsed = performance.now() - started;

    assert.ok(elapsed >= 200, `budget 0 should not interrupt anything, but the scrape returned in ${Math.round(elapsed)}ms`);
    assert.equal(valueOf(text, 'test_slow_facts_total{space="alpha"}'), 42, 'the collector must complete');
    assert.equal(valueOf(text, 'ythril_metrics_collect_timeouts_total{collector="facts_total"}'), 0);
  });

  it('8. falls back to the default when the budget is malformed, rather than to no budget', async () => {
    // set-claim: malformed INPUTS -- the ways an operator can typo an env var. Each is a shape of wrong
    // that must resolve to the default rather than to no budget at all.
    // Asserted as a CHOICE, not an effect. The first version of this test set a malformed budget and checked
    // that a fast collector still completed — which is true whether the fallback is 8000 or 0, so a mutation
    // turning it into 0 (silently disabling the guard on a typo'd env var) passed the test. The parsed value is
    // the only thing that distinguishes the two.
    for (const bad of ['not-a-number', '-1', 'NaN', '']) {
      const mod = await loadRegistry(bad);
      assert.equal(
        mod.scrapeBudgetMs(), mod.DEFAULT_SCRAPE_BUDGET_MS,
        `METRICS_SCRAPE_BUDGET_MS='${bad}' resolved to ${mod.scrapeBudgetMs()}; a typo must not disable the guard`,
      );
    }
    // And the escape hatch must still be reachable deliberately, or the fallback has swallowed it.
    assert.equal((await loadRegistry(0)).scrapeBudgetMs(), 0);
    assert.equal((await loadRegistry(250)).scrapeBudgetMs(), 250);
  });
});

describe('the gate: no async collector may bypass the budget', () => {
  it('9. every async collect() in registry.ts goes through withCollectBudget', () => {
    const src = readFileSync(SOURCE.replace('.js', '.ts'), 'utf8');

    // Strip comments first, anchored to line starts so a `/*` inside a string literal cannot eat live code —
    // and so this gate cannot fire on the comment block that explains it.
    const code = src
      .split(/\r?\n/)
      .filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l))
      .join('\n');

    const asyncCollectors = [...code.matchAll(/async collect\(\)\s*\{([\s\S]*?)\n {2}\},/g)];
    assert.ok(
      asyncCollectors.length >= 9,
      `expected at least 9 async collectors, found ${asyncCollectors.length} — if this dropped, the ` +
      'enumeration broke, not the code',
    );

    const bypassing = asyncCollectors
      .filter(m => !m[1].includes('withCollectBudget'))
      .map(m => m[1].split('\n').find(l => l.trim())?.trim() ?? '(empty)');

    assert.deepEqual(
      bypassing, [],
      'an async collector awaits outside the scrape budget. That re-creates the up=0 the canary reported, and ' +
      'silently: the scrape simply gets slow again with nothing naming the cause.',
    );
  });

  it('every name passed to withCollectBudget is in TIMED_COLLECTORS', async () => {
    const mod = await loadRegistry(null);
    const src = readFileSync(SOURCE.replace('.js', '.ts'), 'utf8');
    const used = [...src.matchAll(/withCollectBudget\('([a-z_]+)'/g)].map(m => m[1]);

    assert.ok(used.length >= 9, `found only ${used.length} withCollectBudget call sites`);
    const unlisted = used.filter(n => !mod.TIMED_COLLECTORS.includes(n));
    assert.deepEqual(
      unlisted, [],
      'a collector times out under a name that is never pre-declared at 0, so its series is absent until the ' +
      'first timeout — invisible in exactly the case this exists to make visible',
    );
  });
});
