/**
 * A config reload that FAILED leaves something an operator can alert on (`Q-43`).
 *
 * ## What was reported, and it aimed one function away
 *
 * The canary operator, 2026-09-23T0835Z: an edit to `config.json` "sat on disk, out of effect, until the
 * next restart", and the only evidence anywhere was one line in a pod log nobody was tailing. They
 * attributed it to `POST /api/admin/reload-config` answering `200 {"ok": true}` over a refused file.
 *
 * **That endpoint is correct.** `reloadConfig` throws on invalid JSON, the route catches it and answers
 * `500` with the message. The half that is silent is the WATCHER: `startConfigWatcher` runs the same
 * `applyConfigFromDisk` on a promise chain ending in `.catch(err => log.error(...))`, so a reload that
 * fails because the file changed on disk produces a log line and nothing else — no status to anybody, no
 * metric, no audit entry.
 *
 * ## Why a gauge and not only a counter
 *
 * The watcher claims the file's mtime BEFORE reloading, deliberately, so broken bytes are not retried
 * every tick. That means a failed watched reload is **never retried on its own** — the running config
 * stays older than the file until something else writes it or the instance restarts.
 *
 * So the state is what an operator needs to alert on, not the event: a counter that incremented an hour
 * ago says it happened, and a gauge says it is STILL true. The canary named exactly that distinction —
 * *"the distinction that matters to us is transient versus permanent"* — for the reranker, and it is the
 * same one here. Both, because the counter is the history and the gauge is the condition.
 *
 * Run: node --test testing/standalone/a-failed-config-reload-is-visible.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let register, configReloadFailedTotal, configReloadPending;

before(async () => {
  ({ register, configReloadFailedTotal, configReloadPending } =
    await import('../../server/dist/metrics/registry.js'));
});

describe('ythril_config_reload_failed_total', () => {
  it('exists at zero before anything has failed', async () => {
    // Absent and zero render identically on a graph and mean opposite things. A scrape from a healthy
    // instance has to say 0 rather than say nothing.
    const metrics = await register.metrics();
    assert.match(metrics, /ythril_config_reload_failed_total 0/,
      'the counter must be pre-declared, or a dashboard cannot tell "never failed" from "not wired up"');
  });

  it('counts up when a reload fails', async () => {
    configReloadFailedTotal.inc();
    assert.match(await register.metrics(), /ythril_config_reload_failed_total 1/);
  });
});

describe('ythril_config_reload_pending', () => {
  it('exists at zero, and is the CONDITION rather than the event', async () => {
    configReloadPending.set(0);
    assert.match(await register.metrics(), /ythril_config_reload_pending 0/);
  });

  it('goes to 1 while the running config is older than the file, and clears on a good reload', async () => {
    configReloadPending.set(1);
    assert.match(await register.metrics(), /ythril_config_reload_pending 1/);
    configReloadPending.set(0);
    assert.match(await register.metrics(), /ythril_config_reload_pending 0/,
      'a successful reload has to clear it, or the alert never resolves and gets muted');
  });
});

describe('the watcher actually moves them', () => {
  const loader = readFileSync('server/src/config/loader.ts', 'utf8');
  const app = readFileSync('server/src/app.ts', 'utf8');

  /*
   * THE WIRING IS SPLIT ACROSS TWO FILES, and that is the fix rather than an accident.
   *
   * The loader cannot import the metrics registry: `registry.ts` reaches back to the loader through
   * `quota` and `db/mongo`, so the import closes a runtime import cycle and
   * `no-runtime-import-cycles.test.js` refuses it — which it did, on the first attempt at this change.
   * So the watcher REPORTS its outcome through a callback and the composition root records it.
   *
   * Both halves are asserted, because either alone is a watcher that tells nobody: a callback nothing
   * passes, or a metric nothing moves.
   */
  it('the watcher reports whether a reload applied, both ways', () => {
    assert.match(loader, /onReloadOutcome\?\.\(true\)/,
      'a successful watched reload must say so, or the condition can never clear');
    assert.match(loader, /onReloadOutcome\?\.\(false\)/,
      'the catch must report the failure, or the log line is still the only trace');
  });

  it('the composition root turns that into the counter and the gauge', () => {
    // No distance window between the two: a character count is a guess at how much of a subject fits,
    // and `gates-bound-their-subject-structurally.test.js` refuses one — it did, on the first attempt.
    // That the callback exists at all is asserted above, on the loader; this asserts what it is wired to.
    assert.match(app, /startConfigWatcher\(/, 'the watcher is not started here any more — this gate moved');
    assert.match(app, /configReloadFailedTotal\.inc\(\)/,
      'nothing counts a failed watched reload');
    assert.match(app, /configReloadPending\.set\(1\)/,
      'a failed watched reload leaves the running config older than the file, and nothing retries it');
    assert.match(app, /configReloadPending\.set\(0\)/,
      'nothing clears the pending gauge, so the condition would read as permanent after one bad edit');
  });
});
