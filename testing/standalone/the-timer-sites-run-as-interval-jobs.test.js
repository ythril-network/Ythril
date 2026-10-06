/**
 * The four remaining bare timers of `server/src` are interval jobs, and the fifth stays a plain `setInterval` for a stated reason
 * (`Q-317`, `Q-358`, bundle-53 G23).
 *
 * ## What this covers
 *
 * `api/invite-sessions.ts` (the session purge, armed at import), `audit/change-retention.ts` (the six-hourly redaction),
 * `util/seq.ts` (the hold watchdog) and `metrics/space-activity-store.ts` (the usage flush) each wrote `setInterval(…).unref()`
 * by hand. `intervalJob` owns that now: one tick at a time, a bounded database, a contained throw, a timer that does not hold the
 * process, a `stop` that clears. The webhook retry poll is the fifth site and has its own file
 * (`the-webhook-retry-poll-skips-an-overlap-and-delivers-four-at-a-time.test.js`), because it also changes how it delivers.
 *
 * **What is pinned here, per site:** it declares its job at construction (`declareJob`, so `ythril_interval_tick_skipped_total{job}`
 * starts at 0); the timer is armed once however often `start` is called; it is unref'd; `stop` clears it; and the interval is the
 * one the site always had (the watchdog's is derived from the hold figure and is re-read when the watchdog restarts).
 *
 * `util/sse-stream.ts` is the one named exemption: the heartbeat lives and dies with ONE connection, is synchronous and cannot
 * overlap, so an interval job (a single-flight, a bound, a throttled line, a registry label) would answer questions nobody asked.
 * It stays a plain `setInterval`, and what is pinned is that its `clearInterval` sits in a `finally`, so no way out of `close`
 * leaves the timer running.
 *
 * ## How a timer is seen
 *
 * `intervalJob` arms through the GLOBAL `setInterval`, looked up at the moment it arms. The test replaces the global for the span of
 * one synchronous call and records the handle and the interval it was given; no timer fires here.
 *
 * Run: node --test testing/standalone/the-timer-sites-run-as-interval-jobs.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

let signals, wb, retention, seq, activity;
const read = (p) => fs.readFileSync(new URL(`../../${p}`, import.meta.url), 'utf8');

before(async () => {
  signals = await import('../../server/dist/util/housekeeping-signals.js');
  wb = await import('../../server/dist/db/write-bound.js');
  retention = await import('../../server/dist/audit/change-retention.js');
  seq = await import('../../server/dist/util/seq.js');
  activity = await import('../../server/dist/metrics/space-activity-store.js');
  await import('../../server/dist/api/invite-sessions.js');   // armed at import: every site's module is loaded before a label is asked for
});
after(() => wb?.setWriteBoundForTest(null));

/**
 * Replace the global interval timer for the span of `fn` (sync or async); returns what it made and what was cleared. Keep `fn`
 * short: while the global is replaced, any other code that arms a timer is recorded too.
 */
async function recording(fn) {
  const out = { made: [], cleared: [] };
  const realSet = globalThis.setInterval;
  const realClear = globalThis.clearInterval;
  globalThis.setInterval = (callback, ms) => {
    const handle = { callback, ms, refed: true, unref() { handle.refed = false; return handle; }, hasRef() { return handle.refed; } };
    out.made.push(handle);
    return handle;
  };
  globalThis.clearInterval = (handle) => { out.cleared.push(handle); };
  try { await fn(); } finally { globalThis.setInterval = realSet; globalThis.clearInterval = realClear; }
  return out;
}

describe('every timer site declares its job at construction', () => {
  it('each label is a declared interval job', () => {
    const declared = signals.declaredJobs();
    for (const label of ['Invite session purge', 'Audit change retention', 'Seq hold watchdog', 'Space activity flush']) {
      assert.ok(declared.includes(label), `'${label}' is not a declared interval job (${declared.join(', ')}): its timer is a bare setInterval`);
    }
  });
});

describe('the invite session purge (armed at import)', () => {
  it('arms one 60 s timer when the module is evaluated, and it does not hold the process', async () => {
    const { made } = await recording(() => import(`../../server/dist/api/invite-sessions.js?fresh=${Date.now()}`));
    assert.equal(made.length, 1, `the module armed ${made.length} timers at import`);
    assert.equal(made[0].ms, 60_000);
    assert.equal(made[0].hasRef(), false, 'the purge timer holds the process open');
  });
});

describe('the audit change-retention sweep', () => {
  it('is armed once however often it is started, at six hours, unref\'d, and stop clears it', async () => {
    const { made, cleared } = await recording(() => {
      retention.startAuditChangeRetention();
      retention.startAuditChangeRetention();
      retention.stopAuditChangeRetention();
      retention.stopAuditChangeRetention();
    });
    assert.equal(made.length, 1, `started twice, armed ${made.length} timers`);
    assert.equal(made[0].ms, 6 * 60 * 60 * 1000);
    assert.equal(made[0].hasRef(), false);
    assert.deepEqual(cleared, [made[0]], 'stop did not clear the timer exactly once');
  });

  it('can be started again after a stop', async () => {
    const { made } = await recording(() => {
      retention.startAuditChangeRetention();
      retention.stopAuditChangeRetention();
      retention.startAuditChangeRetention();
      retention.stopAuditChangeRetention();
    });
    assert.equal(made.length, 2);
  });
});

describe('the seq hold watchdog', () => {
  it('ticks at a quarter of the hold warning, at least 250 ms, and re-reads the figure when it restarts', async () => {
    try {
      wb.setWriteBoundForTest({ holdDeadlineMs: 4_000 });          // warn at 2 000 ms -> every 500 ms
      const first = await recording(() => { seq.startSeqHoldWatchdog(); seq.stopSeqHoldWatchdog(); });
      wb.setWriteBoundForTest({ holdDeadlineMs: 8_000 });          // warn at 4 000 ms -> every 1 000 ms
      const second = await recording(() => { seq.startSeqHoldWatchdog(); seq.stopSeqHoldWatchdog(); });
      wb.setWriteBoundForTest({ holdDeadlineMs: 1_000 });          // a quarter would be 125 ms: floored at 250
      const third = await recording(() => { seq.startSeqHoldWatchdog(); seq.stopSeqHoldWatchdog(); });
      assert.deepEqual([first.made[0].ms, second.made[0].ms, third.made[0].ms], [500, 1_000, 250]);
      for (const r of [first, second, third]) {
        assert.equal(r.made.length, 1);
        assert.equal(r.made[0].hasRef(), false, 'the watchdog holds the process open');
        assert.deepEqual(r.cleared, [r.made[0]]);
      }
    } finally { wb.setWriteBoundForTest(null); }
  });

  it('starting a running watchdog restarts it: the old timer is cleared and the new one reads the figure in force', async () => {
    try {
      wb.setWriteBoundForTest({ holdDeadlineMs: 4_000 });
      const { made, cleared } = await recording(() => {
        seq.startSeqHoldWatchdog();
        wb.setWriteBoundForTest({ holdDeadlineMs: 8_000 });
        seq.startSeqHoldWatchdog();
        seq.stopSeqHoldWatchdog();
      });
      assert.deepEqual(made.map(h => h.ms), [500, 1_000]);
      assert.deepEqual(cleared, made, 'a restart left the first timer running');
    } finally { wb.setWriteBoundForTest(null); }
  });
});

describe('the space activity flush', () => {
  it('is armed once, at its interval, unref\'d, and stop clears it (and writes what is pending)', async () => {
    const result = await recording(async () => {
      activity.startSpaceActivityFlush();
      activity.startSpaceActivityFlush();
      await activity.stopSpaceActivityFlush();   // nothing is pending, so the final flush touches no database
      await activity.stopSpaceActivityFlush();
    });
    assert.equal(result.made.length, 1, `started twice, armed ${result.made.length} timers`);
    assert.equal(result.made[0].ms, activity.ACTIVITY_FLUSH_INTERVAL_MS);
    assert.equal(result.made[0].hasRef(), false);
    assert.deepEqual(result.cleared, [result.made[0]]);
  });
});

describe('the SSE keepalive is the one named exemption', () => {
  const src = read('server/src/util/sse-stream.ts');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');

  it('stays one plain setInterval', () => {
    assert.equal((code.match(/\bsetInterval\b/g) ?? []).length, 1);
    assert.doesNotMatch(code, /intervalJob/);
  });

  it('clears the heartbeat in a finally, so no way out of close leaves it running', () => {
    assert.match(code, /finally\s*\{[^}]*clearInterval\(\s*heartbeat\s*\)/, 'clearInterval(heartbeat) is not in a finally block');
  });

  it('says why it is not an interval job', () => {
    assert.match(src, /one connection/i);
    assert.match(src, /interval job|intervalJob/);
  });
});
