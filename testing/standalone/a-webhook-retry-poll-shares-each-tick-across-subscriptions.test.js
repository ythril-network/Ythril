/**
 * The retry poll's tick is shared across subscriptions and ends at a budget (bundle-169, Q-483; design rev 3.2).
 *
 * ## The defect
 *
 * `dueJobs` took the 50 oldest due rows and the poll delivered them in the order it was given, four at a time, with no end to a tick but its
 * last delivery. One subscription with a large backlog therefore took every slot of every tick (its rows are the oldest), and another subscription's
 * single due retry waited until the whole backlog had drained: hours at 50 rows per 10 s for a few thousand rows. The stated bound that replaces
 * that wait is in TICKS: a due subscription starts within a bounded number of ticks, and a tick stops STARTING deliveries at `RETRY_TICK_BUDGET_MS`
 * (30 s) so that a tick of slow sinks cannot outlast the overlap skip for minutes. Rows it did not start stay in the queue, because the row is removed
 * in `retryOne`, which an unstarted row never reaches.
 *
 * ## What is pinned here
 *
 * - **The budget, on an injected clock.** `RetryPollDeps.now` (a function returning ms, like `IntervalJobDeps.now`) is the poll's clock: twelve due rows of
 *   twelve subscriptions, the first four started and held, the clock moved past the budget, the held four released: the other eight are NOT started and NOT
 *   removed, the tick ends, and `ythril_webhook_retry_ticks_cut_total` rose by one. A tick that ends inside its budget is not counted, the counter is on the
 *   scrape at 0 before any tick is cut, and the next tick polls again (the cut one released the single flight). Nothing sleeps: the clock is a variable.
 * - **Lanes are ordered by each subscription's OLDEST due row.** Whatever order the selection comes in, the first four deliveries started are the four
 *   oldest subscriptions', and a subscription that did not start in a cut tick (its row stays the oldest) leads the next tick, ahead of rows the cut tick
 *   delivered and re-queued. Without that, a fixed lane order starves a late subscription for ever behind a budget.
 *
 * ## What is NOT here, on purpose
 *
 * The 10 000-rows-against-3 case (the second subscription's rows are in the first tick's SELECTION) is a property of the real `dueJobs` against a real collection,
 * and a fake `dueJobs` returns whatever it is told: it lives in `webhook-retry-selection-reads-ids-on-its-indexes-db.test.js`. The per-subscription cap is in
 * `the-webhook-retry-poll-skips-an-overlap-and-delivers-four-at-a-time.test.js`, and `mapLimitPerKey` in `a-pool-caps-each-key-without-holding-a-slot.test.js`.
 *
 * ## Red at base, and which assertion proves the rule once the export exists
 *
 * - budget: the poll has no clock and no budget, so all twelve rows are delivered (`only the four started rows were delivered` fails: red BY THE RULE where the code
 *   exists). The counter `ythril_webhook_retry_ticks_cut_total` does not exist: `the cut was counted` reads 0 and fails (red by rule; the series is read from the
 *   scrape, so no export is needed). The control (a tick inside its budget is delivered whole and not counted) is green at base and guards over-counting.
 * - lane order: the base poll hands the rows to `mapLimit` in the order it received them, so `the four oldest subscriptions start first` fails (red by rule).
 *   `a subscription that was not started leads the next tick` fails at base because nothing is ever left unstarted, so the next tick holds only re-queued rows.
 * - the seam: `now` is a new optional field of `RetryPollDeps`; at base it is ignored, which is why no case needs an import that fails. The assertion that proves
 *   the clock is READ is `only the four started rows were delivered` with the clock moved past the budget by the test alone.
 *
 * Run: node --test testing/standalone/a-webhook-retry-poll-shares-each-tick-across-subscriptions.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { settle } from './_virtual-time.mjs';
import { gate, ok, failed, armedRetryWorker } from './_retry-poll-rig.mjs';

let dispatcher, register;

before(async () => {
  dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
  ({ register } = await import('../../server/dist/metrics/registry.js'));
});

const T0 = 1_700_000_000_000;
const BUDGET_MS = () => dispatcher.RETRY_TICK_BUDGET_MS ?? 30_000;

/** A row of subscription `n`, due since `T0 + at` (a fixed epoch long before the real clock, so it is due whatever clock the poll reads). */
const row = (n, at = n, over = {}) => ({
  _id: `row-${n}-${at}`, webhookId: `sink-${n}`, body: '{}', event: 'entity.created', spaceId: 's', deliveryId: `d-${n}-${at}`,
  attempt: 2, scheduledAt: new Date(T0 + at), createdAt: new Date(T0), ...over,
});

/**
 * An in-memory queue behind the poll's seam, an adversarial one: `dueJobs` returns EVERY row left, newest-due first (so a poll that keeps the order it is
 * handed starts the wrong subscriptions), and `removeJob` really removes. `clock` is the poll's injected clock, a number the test moves.
 */
function rig({ rows, deliver }) {
  const state = { rows: [...rows], removed: [], started: [], clock: T0, dueCalls: 0 };
  const deps = {
    now: () => state.clock,
    dueJobs: async () => { state.dueCalls++; return [...state.rows].sort((a, b) => b.scheduledAt - a.scheduledAt); },
    removeJob: async (id) => { state.removed.push(id); state.rows = state.rows.filter(r => r._id !== id); },
    getWebhook: async (id) => ({ id, url: `https://example.invalid/${id}`, secret: 's', spaces: [], events: [], enabled: true, status: 'active', consecutiveFailures: 0, createdAt: '', updatedAt: '' }),
    deliver: async (sub, j) => { state.started.push(j._id); return await deliver(sub, j, state); },
    markSuccess: async () => {},
    markFailure: async () => {},
    // Put the job back for its next attempt, due now: newer than anything that was never started.
    requeue: async (j) => { state.rows.push({ ...j, _id: `${j._id}-r`, attempt: j.attempt + 1, scheduledAt: new Date(T0 + 1_000_000) }); },
  };
  const { worker, fire } = armedRetryWorker(dispatcher, deps, state);
  worker.job.start();
  return { state, fire };
}

/** Sum of every series of a counter on the scrape, or 0 when it is not there (a counter that does not exist reads as nothing, not as an error). */
async function scrapeTotal(name) {
  let text = '';
  try { text = await register.getSingleMetricAsString(name); } catch { return null; }
  return text.split(/\r?\n/).filter(l => l.startsWith(name) && !l.startsWith('#')).reduce((n, l) => n + Number(l.trim().split(/\s+/).at(-1)), 0);
}
const CUT = 'ythril_webhook_retry_ticks_cut_total';

describe('a tick stops starting deliveries at its budget', () => {
  it('twelve due rows of twelve subscriptions, the first four held, the clock moved past the budget: only the four started rows were delivered, the rest stay queued, and the cut is counted', async () => {
    const holds = new Map();
    const r = rig({
      rows: Array.from({ length: 12 }, (_, i) => row(i + 1)),
      deliver: async (_s, j) => { const g = gate(); holds.set(j._id, g); await g.p; return ok; },
    });
    const cutBefore = (await scrapeTotal(CUT)) ?? 0;
    await r.fire();
    assert.equal(r.state.started.length, dispatcher.RETRY_CONCURRENCY, 'the tick did not fill its four slots');
    r.state.clock = T0 + BUDGET_MS() + 1;        // the budget is over: nothing may START from here on
    for (const g of holds.values()) g.release();
    await settle();
    assert.equal(r.state.started.length, dispatcher.RETRY_CONCURRENCY,
      `only the four started rows were delivered: ${r.state.started.length} deliveries began, the tick went on starting after its budget`);
    assert.equal(r.state.removed.length, dispatcher.RETRY_CONCURRENCY, 'a row that was never started was removed from the queue: it would be lost');
    assert.equal(r.state.rows.length, 8, 'the rows not started are not all still queued');
    assert.equal((await scrapeTotal(CUT) ?? 0) - cutBefore, 1, `the cut was counted: ${CUT} rose by ${(await scrapeTotal(CUT) ?? 0) - cutBefore}, expected 1 for one cut tick`);
  });

  it('the next tick after a cut one polls again and delivers what was left (the cut tick released the single flight)', async () => {
    const r = rig({
      rows: Array.from({ length: 6 }, (_, i) => row(i + 1)),
      deliver: async (_s, _j, state) => { state.clock += BUDGET_MS() + 1; return ok; },   // every delivery ends past its tick's budget
    });
    await r.fire();
    assert.ok(r.state.rows.length > 0, 'nothing was left queued by a tick whose budget ended at its first delivery');
    const left = r.state.rows.length;
    r.state.clock = T0 + 10_000_000;               // a later tick starts its own budget from its own start
    await r.fire();
    assert.equal(r.state.dueCalls, 2, 'a tick after a cut one did not poll');
    assert.ok(r.state.rows.length < left, 'the tick after the cut one delivered nothing of what was left');
  });

  it('control: twelve rows delivered inside the budget are all delivered, and nothing is counted as cut', async () => {
    const r = rig({
      rows: Array.from({ length: 12 }, (_, i) => row(i + 1)),
      deliver: async () => { await new Promise(res => setImmediate(res)); return ok; },
    });
    const cutBefore = (await scrapeTotal(CUT)) ?? 0;
    await r.fire();
    assert.equal(r.state.started.length, 12);
    assert.equal(r.state.rows.length, 0);
    assert.equal((await scrapeTotal(CUT) ?? 0) - cutBefore, 0, 'a tick that ended inside its budget was counted as cut');
  });

  it('the counter is on the scrape at 0 before any tick is cut', async () => {
    const total = await scrapeTotal(CUT);
    assert.notEqual(total, null, `${CUT} is not on the scrape: it must be declared at 0 so the series exists from the start`);
    assert.ok(Number.isFinite(total));
  });
});

describe('lanes start in the order of each subscription\'s oldest due row', () => {
  it('six subscriptions handed over newest first: the four oldest subscriptions start first', async () => {
    const holds = [];
    const r = rig({
      rows: Array.from({ length: 6 }, (_, i) => row(i + 1, i + 1)),
      deliver: async () => { const g = gate(); holds.push(g); await g.p; return ok; },
    });
    await r.fire();
    assert.deepEqual(r.state.started.map(id => id.split('-')[1]).sort(), ['1', '2', '3', '4'],
      `the four oldest subscriptions start first: started ${r.state.started.join(' ')} of the due rows`);
    for (const g of holds) g.release();
    await settle();
  });

  it('a subscription with several rows is placed by its OLDEST: its newer rows do not move it behind a subscription whose only row is older than them', async () => {
    const holds = [];
    // sink-1 has rows at 1 and 90; sink-2..5 one row each at 10..40; sink-6 one at 50. Oldest per subscription: 1, 10, 20, 30, 40, 50.
    const rows = [row(1, 1), row(1, 90), row(2, 10), row(3, 20), row(4, 30), row(5, 40), row(6, 50)];
    const r = rig({ rows, deliver: async () => { const g = gate(); holds.push(g); await g.p; return ok; } });
    await r.fire();
    const subs = new Set(r.state.started.map(id => id.split('-')[1]));
    assert.deepEqual([...subs].sort(), ['1', '2', '3', '4'], `lanes were not ordered by each subscription's oldest row: started ${r.state.started.join(' ')}`);
    for (const g of holds) g.release();
    await settle();
  });

  it('a subscription that was not started in a cut tick leads the next tick, ahead of the rows the cut tick delivered and re-queued', async () => {
    const holds = new Map();
    const r = rig({
      rows: Array.from({ length: 6 }, (_, i) => row(i + 1, i + 1)),
      deliver: async (_s, j) => { const g = gate(); holds.set(j._id, g); await g.p; return failed; },   // a failure re-queues the row, due again at once
    });
    await r.fire();                                  // tick 1 starts the four oldest and holds them
    assert.equal(r.state.started.length, 4);
    r.state.clock = T0 + BUDGET_MS() + 1;
    for (const g of holds.values()) g.release();     // they fail and are re-queued; subscriptions 5 and 6 are never started
    await settle();
    assert.deepEqual(r.state.rows.map(x => x.webhookId).sort(), ['sink-1', 'sink-2', 'sink-3', 'sink-4', 'sink-5', 'sink-6'],
      'after the cut tick the queue is not the four re-queued rows plus the two that were never started');
    holds.clear();
    r.state.started.length = 0;
    r.state.clock = T0 + 10_000_000;
    await r.fire();                                  // tick 2: four slots, the selection handed over newest first (the re-queued rows are newest)
    const firstFour = r.state.started.map(id => id.split('-')[1]);
    assert.ok(firstFour.includes('5') && firstFour.includes('6'),
      `a subscription not started last tick did not lead this one: started ${r.state.started.join(' ')}`);
    for (const g of holds.values()) g.release();
    await settle();
  });
});
