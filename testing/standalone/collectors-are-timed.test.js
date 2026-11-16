/**
 * Every async metric collector must be timed AND bounded — because an untimed one is the one that will own the
 * ten seconds, and an unbounded one will blind the whole target while doing it.
 *
 * ## The failure this exists for
 *
 * A canary operator measured `/metrics` hitting its 10-second Prometheus timeout during an embedding run, with
 * `up=0` for two windows. They also took the measurement that **eliminates** the obvious explanation, from the
 * same scrape: event-loop lag mean 0.01006 s, p99 0.01025 s, stddev 0.00012 s. Flat 10 ms. So the handler was
 * awaiting, not hogging — and the candidates are the gauges that gather at scrape time, each walking every
 * space, several of them querying the collection the embedding worker writes to continuously.
 *
 * We cannot reproduce their load, so the instance has to report it.
 *
 * ## Why this file changed shape
 *
 * It used to assert the **mechanism**: `collectTimer(` on the first line of each collector, and a `done()` count
 * that matched. Both were hand-rolled per collector, and the timer stop sat *after* the try/catch rather than in
 * a `finally` — so an early `return` would have silently skipped it.
 *
 * `withCollectBudget()` now owns both, plus the scrape budget. That makes the guarantee structural instead of
 * remembered, so this gate asserts the guarantee:
 *
 *   1. every async collector routes through the wrapper;
 *   2. the wrapper starts its timer before anything can await;
 *   3. the wrapper stops it in a `finally`, so no path escapes measurement.
 *
 * The old assertions would now FAIL against strictly better code, which is the signature of a gate pinned to an
 * implementation. Re-pointed rather than appeased.
 *
 * Run: node --test testing/standalone/collectors-are-timed.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { enclosingBlockAround } from './_structural-window.mjs';
import { metricSources } from './_metric-sources.mjs';

const ROOT = process.cwd();
const sources = metricSources();
const SRC = 'the metric modules';
const src = sources.map(s => s.text).join('\n');

/**
 * Collectors that gather nothing and so are exempt from the budget wrapper, with the reason.
 *
 * These two report on the scrape itself and wait for the budgeted collectors to settle. Routing them through the
 * wrapper would make them wait on themselves.
 */
const REPORTING_COLLECTORS = ['ythril_metrics_collect_timeouts_total', 'ythril_metrics_scrape_degraded'];

/** `{ line, metric, body }` for every async collector in the registry, reporting ones excluded. */
function collectors() {
  const found = [];
  for (const { file, text } of sources) {
    const lines = text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!/^\s*async collect\(\)\s*\{/.test(lines[i])) continue;

      let metric = null;
      for (let j = i; j >= 0 && j > i - 14; j--) {
        const m = lines[j].match(/name: '(ythril_[a-z_]+)'/);
        if (m) { metric = m[1]; break; }
      }
      if (metric !== null && REPORTING_COLLECTORS.includes(metric)) continue;

      // Body runs to the closing brace at the collector's own indent.
      const indent = lines[i].match(/^\s*/)[0];
      let end = i + 1;
      while (end < lines.length && !new RegExp(`^${indent}\\},?$`).test(lines[end])) end++;
      found.push({ file, line: i + 1, metric, body: lines.slice(i, end + 1).join('\n') });
    }
  }
  return found;
}

describe('every async metric collector is timed and bounded', () => {
  it('found the collectors — the pattern still matches', () => {
    const all = collectors();
    // The floor matters as much as the check: if the pattern stopped matching, an empty offender list would pass
    // while verifying nothing.
    assert.ok(all.length >= 8, `only found ${all.length} async collectors in ${SRC}`);
    assert.ok(all.every(c => c.metric !== null), 'a collector has no metric name above it');
  });

  it('every reporting collector named exempt actually exists', () => {
    // An exemption for something that is gone is an exemption that will one day cover something else. The old
    // version of this gate had no exemptions and the new metrics would have silently widened its scope.
    for (const name of REPORTING_COLLECTORS) {
      assert.match(src, new RegExp(`name: '${name}'`), `${name} is exempted here but not in the registry`);
    }
  });

  it('each one routes through withCollectBudget, which times it and bounds it', () => {
    const loose = collectors()
      .filter(c => !c.body.includes('withCollectBudget('))
      .map(c => `${c.file}:${c.line} (${c.metric})`);
    assert.deepEqual(loose, [], 'these gather at scrape time outside the budget wrapper, so they are neither '
      + `timed nor bounded — a slow scrape cannot name them and cannot survive them:\n  ${loose.join('\n  ')}\n\n`
      + "Wrap the body: `await withCollectBudget('<name>', async () => { ... }, () => this.reset());`");
  });

  it('the wrapper starts its timer before it can await', () => {
    // A timer started after the first await measures the wrong thing, and measuring the wrong thing is worse
    // here than not measuring.
    const m = src.match(/export async function withCollectBudget\([\s\S]*?\n\) *: *Promise<void> *\{([\s\S]*?)\n\}/);
    assert.ok(m, 'withCollectBudget not found — this gate needs re-pointing, not deleting');
    const body = m[1];

    const firstTimer = body.indexOf('collectDuration.startTimer(');
    const firstAwait = body.indexOf('await ');
    assert.ok(firstTimer >= 0, 'withCollectBudget no longer starts a timer');
    assert.ok(
      firstAwait === -1 || firstTimer < firstAwait,
      'withCollectBudget awaits before it starts timing, so every collector under-reports its own duration',
    );
  });

  it('the wrapper stops its timer in a finally, so no path escapes measurement', () => {
    const m = src.match(/export async function withCollectBudget\([\s\S]*?\n\) *: *Promise<void> *\{([\s\S]*?)\n\}/);
    const body = m[1];

    // Strip comments line-first, so this cannot pass on the prose that explains it — and cannot be "fixed" by
    // deleting that prose.
    const code = body.split('\n').filter(l => !/^\s*(\/\/|\*|\/\*)/.test(l)).join('\n');

    // The wrapper has two finally blocks — the inner one clears the expiry timer, the outer one stops the clock.
    // Anchor on the LAST, because a non-greedy match finds the inner one and then stops at the outer finally's
    // own opening brace, capturing a region that never contains the stop. (It did exactly that on first run.)
    const lastFinally = code.lastIndexOf('finally {');
    assert.ok(lastFinally >= 0, 'the timer stop is not in a finally — an early return would skip it, which is the '
      + 'exact hole the previous per-collector `done()` had');
    assert.match(
      code.slice(lastFinally), /done\(\);/,
      'the last finally does not stop the timer; a started timer that never stops observes nothing, so the '
      + 'histogram stays empty and reads as a collector that is instantly fast',
    );
    assert.equal(
      (code.match(/\bdone\(\);/g) ?? []).length, 1,
      'more than one done() call: if one of them is outside the finally, that is the path that escapes measurement',
    );
  });

  it('the histogram can describe a scrape that timed out', () => {
    // Prometheus times out at 10 s by default. A top bucket at or below that cannot express the failure, so the
    // graph would show everything in `+Inf` and say nothing about how bad it got.
    // A WINDOW, converted: the subject is the histogram's own definition object, bounded by the brace that
    // closes it. At 400 characters a definition that gained a label or a help string would push `buckets`
    // out of range, and the anchor assertion would then report the histogram as MISSING.
    const at = src.indexOf("name: 'ythril_metrics_collect_duration_seconds'");
    assert.ok(at > -1, 'the collector-duration histogram is missing');
    const def = enclosingBlockAround(src, at, 'the collector-duration histogram');
    const m = /buckets: \[([^\]]+)\]/.exec(def);
    assert.ok(m, 'the collector-duration histogram has no buckets');
    const buckets = m[1].split(',').map(s => Number(s.trim()));
    assert.ok(Math.max(...buckets) > 10, `top bucket is ${Math.max(...buckets)}s — it must exceed the 10s timeout`);
    assert.ok(Math.min(...buckets) <= 0.05, 'needs a fast bucket too: a healthy collector is ~25 ms');
  });

  it('is documented, like every other metric family', () => {
    const docs = readFileSync(join(ROOT, 'docs/integration-guide/11-setup-api.md'), 'utf8');
    assert.match(docs, /ythril_metrics_collect_duration_seconds/);
    // The budget is operator-facing configuration: an undocumented knob is one nobody can turn.
    assert.match(docs, /METRICS_SCRAPE_BUDGET_MS/,
      'the scrape budget env var is not documented, so an operator whose scrape_timeout differs cannot adjust it');
  });
});
