/**
 * The storage gauge must never walk the disk during a scrape.
 *
 * ## The measurement that produced this
 *
 * The canary answered the `/metrics` timeout question with numbers, and they name one collector:
 *
 * | collector | mean seconds |
 * |---|---|
 * | `storage_used_bytes` | **22.150** |
 * | every MongoDB-backed collector | 8.57 – 8.61 |
 *
 * And the count that makes it a cause rather than a correlation: of **20 scrapes, 10 failed** with
 * `scrape_duration_seconds` pinned at exactly `10.0012 s`, and of the 19 collections the histogram recorded,
 * `storage_used_bytes` exceeded 10 s **exactly 10 times**. The other eight collectors exceeded 10 s 7 times
 * between them, so they are not the determinant. Its distribution was bimodal — 6 of 19 under 50 ms, 9 over 15 s
 * — which is a cold-versus-warm filesystem cache, not "slow". Their four small instances completed every
 * collector in 0.005–0.041 s.
 *
 * Cause, from source: `measureUsage()` recursively `stat`s the whole files tree. It was the only collector doing
 * filesystem I/O rather than a MongoDB count.
 *
 * ## What makes this the interesting kind of bug
 *
 * **The cache already existed, and the collector was the one caller that opted out of it.** `measureUsage()`
 * takes a `maxAgeMs`, and the comment above the cache in `quota.ts` listed `metrics` among the callers that
 * deliberately re-measure. That line was the bug. Worse, the argument against exactness was *already written* in
 * `registry.ts` for the brain totals — "the exactness that buys does not survive contact with what a gauge IS" —
 * and #606 acted on it there, for the collectors costing milliseconds, while leaving the one costing seconds.
 *
 * ## What each test defends
 *
 *  1. The collector reads the cache and never calls the walking function. Asserted as a **choice** in source,
 *     because the effect — "the scrape was fast" — is true on a small test tree whatever the code does. That is
 *     the same trap that made the scrape-budget fallback test vacuous until it asserted the parsed value.
 *  2. A cold cache yields **no storage series at all**, not a zero. A zero would claim "empty".
 *  3. A cold scrape kicks a background refresh, so the second scrape has the value.
 *  4. The refresh is **coalesced** — nine scrapes must not start nine 22-second walks on a filesystem that is
 *     already the bottleneck. On the canary's degraded RAID1 mid-rebuild that would be actively harmful.
 *  5. The age is exposed. A cached value with no visible age is the failure mode #676 rejected: numbers that
 *     look current and are not.
 *  6. All four brain collections are pre-declared, now that all four are instrumented.
 *
 * Run: node --test testing/standalone/storage-collector-does-not-walk.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { COLLECTION_SUFFIX } from '../../server/dist/config/types-knowledge.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const REGISTRY_SRC = join(ROOT, 'server/src/metrics/registry.ts');
const QUOTA_SRC = join(ROOT, 'server/src/quota/quota.ts');

let reg, quota;
before(async () => {
  reg = await import('../../server/dist/metrics/registry.js');
  quota = await import('../../server/dist/quota/quota.js');
});

const valueOf = (text, series) => {
  const line = text.split('\n').find(l => l.startsWith(series + ' '));
  return line ? Number(line.slice(series.length + 1)) : null;
};

async function scrape() {
  reg.beginScrape();
  try {
    return await reg.register.metrics();
  } finally {
    reg.endScrape();
  }
}

describe('the storage collector', () => {
  it('1. reads the cache and never calls the function that walks the disk', () => {
    const src = readFileSync(REGISTRY_SRC, 'utf8');

    // Strip comments line-first, so this cannot pass on the prose explaining it, and cannot be "fixed" by
    // deleting that prose.
    const code = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    const block = code.match(
      /name: 'ythril_storage_used_bytes'[\s\S]*?\n {2}\},\n\}\);/,
    );
    assert.ok(block, 'could not find the storage_used_bytes collector — re-point this gate, do not delete it');

    assert.match(block[0], /peekUsage\(\)/,
      'the collector no longer reads the cache; if it went back to measuring, the canary loses half its scrapes');
    assert.doesNotMatch(block[0], /\bmeasureUsage\s*\(/,
      'the collector calls measureUsage(), which recursively stats the whole files tree — 22.150 s mean on the '
      + 'canary instance and the sole cause of 10 failed scrapes out of 20');
    assert.doesNotMatch(block[0], /await\s+refreshUsageInBackground/,
      'the background refresh is awaited, which re-introduces the disk walk into the scrape it was moved out of');
  });

  it('and the whole registry has no other disk-walking collector', () => {
    const src = readFileSync(REGISTRY_SRC, 'utf8');
    const code = src.split(/\r?\n/).filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');
    assert.doesNotMatch(code, /\bmeasureUsage\s*\(/,
      'measureUsage() is reachable from the metrics registry again — it walks the files tree and no scrape may');
  });

  it('2. reports no storage series at all before anything has been measured', async () => {
    quota.invalidateUsageCache();
    assert.equal(quota.peekUsage(), null, 'peekUsage must not invent a measurement');

    reg.storageUsedBytes.reset();
    const text = await scrape();
    assert.equal(
      valueOf(text, 'ythril_storage_used_bytes{area="total"}'), null,
      'a cold instance reported a storage number it had never measured; 0 would read as "empty"',
    );
  });

  it('3. a cold scrape kicks a background refresh, so the next scrape has the value', async () => {
    quota.invalidateUsageCache();
    reg.storageUsedBytes.reset();
    await scrape();

    // The walk is real but tiny here — wait for the coalesced promise rather than guessing at a delay.
    for (let i = 0; i < 200 && quota.usageRefreshInFlight(); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    assert.notEqual(quota.peekUsage(), null, 'the cold scrape did not start a measurement, so it never arrives');

    const text = await scrape();
    assert.equal(
      typeof valueOf(text, 'ythril_storage_used_bytes{area="total"}'), 'number',
      'the second scrape still has no value, so the refresh never reached the gauge',
    );
  });

  it('4. coalesces refreshes — 9 calls must produce exactly 1 walk', async () => {
    // Counted, not flag-checked. The first version of this test asserted `usageRefreshInFlight()` before and
    // after the nine calls, which is true either way — nine unguarded calls each leave *a* promise in the slot —
    // so the mutation that deleted the guard passed it. The number of completed walks is the only observable
    // that tells one guarded refresh from nine unguarded ones.
    quota.invalidateUsageCache();
    const before = quota.usageMeasurementCount();

    for (let i = 0; i < 9; i++) quota.refreshUsageInBackground();

    for (let i = 0; i < 300 && quota.usageRefreshInFlight(); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    // Let any un-coalesced stragglers land before counting, or an unguarded run could still be in flight and
    // the test would under-count its way to a pass.
    await new Promise(r => setTimeout(r, 60));

    assert.equal(
      quota.usageMeasurementCount() - before, 1,
      `9 calls produced ${quota.usageMeasurementCount() - before} walks. On a store where one walk is 22 s, a `
      + '15-second scrape interval would stack them on the filesystem that is already the bottleneck — and on the '
      + "canary's degraded RAID1 mid-rebuild that is actively harmful.",
    );
    assert.equal(quota.usageRefreshInFlight(), false, 'the walk never cleared its in-flight guard — it would '
      + 'block every future refresh for the life of the process');
  });

  it('and the coalescing guard is cleared in a finally, not on the success path', () => {
    const src = readFileSync(QUOTA_SRC, 'utf8');
    const fn = src.match(/export function refreshUsageInBackground\(\)[\s\S]*?\n\}/);
    assert.ok(fn, 'refreshUsageInBackground not found');
    assert.match(fn[0], /\.finally\(/,
      'the in-flight guard is not cleared in a finally, so one failed measurement wedges the refresh forever and '
      + 'the gauge silently freezes at its last value');
  });

  it('5. exposes how stale the numbers are', async () => {
    quota.invalidateUsageCache();
    quota.refreshUsageInBackground();
    for (let i = 0; i < 200 && quota.usageRefreshInFlight(); i++) {
      await new Promise(r => setTimeout(r, 10));
    }
    // POISON the gauge, do not reset it. Two traps here, both hit in sequence:
    //   1. a prom-client gauge retains its last value, and test 3 already scraped — so with no preparation at all,
    //      a mutation that stops setting the age still reads a plausible number left behind;
    //   2. `reset()` on an UNLABELLED gauge re-initialises it to 0 rather than removing it, so resetting made it
    //      strictly worse — it guaranteed a value inside the plausible range.
    // A sentinel outside the assertion window is the only preparation that fails when nothing writes.
    reg.storageUsageAgeSeconds.set(999_999);

    const text = await scrape();
    const age = valueOf(text, 'ythril_storage_usage_age_seconds');
    assert.equal(typeof age, 'number', 'the age gauge is absent, so a cached value looks current with no way to '
      + 'tell — which is the exact failure the abandoned-collector decision rejected');
    assert.ok(age >= 0 && age < 120, `age ${age}s is not plausible for a measurement taken just now`);
  });
});

describe('lost-update detection covers every brain record type', () => {
  it('6. all four collections are pre-declared at zero', async () => {
    // set-claim: the two outcomes a lost-update series is pre-declared for. `refused` is deliberately not
    // here -- it means a write was STOPPED, which is the opposite of the pair this case is about.
    const text = await reg.register.metrics();
    // From `COLLECTION_SUFFIX`, which is what the registry's pre-declaration loops -- the two cannot
    // disagree, and a fifth record type is pre-declared and checked without either being edited.
    for (const collection of Object.values(COLLECTION_SUFFIX)) {
      for (const outcome of ['clean', 'collision']) {
        assert.notEqual(
          valueOf(text, `ythril_brain_write_seq_total{collection="${collection}",outcome="${outcome}"}`), null,
          `${collection}/${outcome} is absent. The canary saw only collection="facts" and reasonably guessed `
          + 'the labels were lazy; they were not, the other three were simply never instrumented.',
        );
      }
    }
  });

  it('and every pre-declared collection is actually instrumented somewhere', () => {
    // The half that matters. Pre-declaring a collection nobody counts is WORSE than omitting it: a permanent 0
    // reads as "no collisions here" when the truth is "not measured". That is the exact confusion pre-declaring
    // exists to prevent, so the two must move together.
    const files = {
      facts: 'server/src/brain/fact.ts',
      entities: 'server/src/brain/entities.ts',
      edges: 'server/src/brain/edges.ts',
      chrono: 'server/src/brain/chrono.ts',
    };
    for (const [collection, file] of Object.entries(files)) {
      const src = readFileSync(join(ROOT, file), 'utf8');
      assert.match(src, /brainWriteSeqTotal/,
        `${collection} is pre-declared in the registry but ${file} never counts a write`);
      assert.match(src, /returnDocument:\s*'before'/,
        `${file} increments the counter without reading the pre-write document, so it cannot detect a collision `
        + 'and would report every write as clean');
      assert.match(src, new RegExp(`collection:\\s*'${collection}'`),
        `${file} does not label its writes as collection="${collection}"`);
    }
  });
});
