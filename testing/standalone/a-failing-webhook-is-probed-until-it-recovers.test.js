/**
 * A webhook subscription marked failing is probed by the retry poll until its sink answers again, and every write of its status is
 * conditional on what the row says when the write lands (bundle-119, Q-477, design rev 3).
 *
 * ## The defect it closes
 *
 * `markWebhookFailure` flipped a subscription to `failing` after six exhausted retry schedules, and from then on nothing delivered to it:
 * `acceptsDeliveries` refuses a failing subscription, the dispatcher drops its queued retries, and only an admin's re-enable (or a test
 * ping) reset it. A sink that was down for an afternoon stayed cut off until someone noticed. The status writes were also read from this
 * process's cache and written back whole, so a probe's success could flip a subscription an admin disabled meanwhile.
 *
 * ## What is held (pure: the poll over the `RetryPollDeps` fakes, and the store's writes as `{ filter, update }` against the house matcher)
 *
 *  1. **The claim filter takes a legacy failing row**: a subscription that was failing before the upgrade has no `nextProbeAt` and no
 *     `probeAttempts`, and the claim matches it (`$or` missing / due), so it is probed on the first tick after the upgrade.
 *  2. **The probe is the existing `test.ping`**, in the test route's envelope (`spaceId` / `spaceName` `'_test'`), marked
 *     `entry.probe: true`: no new event type, no change to the event table a receiver switches on.
 *  3. **Probes run first in a tick, at most `PROBES_PER_TICK`, each asked against `RETRY_TICK_BUDGET_MS` before it starts** (the claim
 *     is made at the probe's own start, after the budget check, so a spent tick claims nothing).
 *  4. **The claim is the schedule**: one write `{ id, status: 'failing', enabled: true, nextProbeAt missing or due, probeAttempts: k }`
 *     -> `$set nextProbeAt = now + backoffDelayMs(k, 60 000, 3 600 000)`, `$inc probeAttempts 1`. Equal jitter, so the wait is a RANGE:
 *     `[nominal / 2, nominal]`, and the cap reads 30 to 60 minutes.
 *  5. **Probation**: a probe success sets the count to `FAILING_AFTER - 1`, so one more exhausted schedule flips the subscription back.
 *  6. **Conditional result writes**: a subscription disabled mid-probe stays disabled, one whose URL changed mid-probe is not recovered
 *     (the poll hands the PROBED url to the recovery write), and a re-enable clears the probe fields.
 *  7. **The "marked as failing" and "recovered" lines are said once each**: only by the call whose conditional write changed the row
 *     (`modifiedCount` 1), not on every exhausted schedule.
 *
 * ## Names this file takes from the design (the implementer exports them)
 *
 * `store.js`: `FAILING_AFTER`, `probeClaim(row, now)`, `probeRecoveryWrite(id, url)`, `failingFlipWrite(id, now)`,
 * `webhookUpdateWrite(input)` (each answers the store write as `{ filter, update }`, or the update document, so the rule can be read
 * without a database). `dispatcher.js`: `PROBES_PER_TICK`; `RetryPollDeps` gains `claimDueProbe(now)` (answers `{ id, url }` or null),
 * `deliverProbe(sub, body, event, spaceId, deliveryId)` and `markProbeRecovered(id, url)` (answers whether it changed the row), and
 * `markFailure` answers whether its flip changed the row.
 *
 * ## Seen red
 *
 * At a644fe92: the poll never probes (2, 3, 6 and 7's recovery case fail on "nothing was probed"), `markFailure`'s line is said on every
 * exhausted schedule (7, behaviour), and the store exports none of the write builders (1, 4, 5, 6 fail on the missing name).
 *
 * Run: node --test testing/standalone/a-failing-webhook-is-probed-until-it-recovers.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { ok, failed, armedRetryWorker } from './_retry-poll-rig.mjs';
import { matchesFilter } from '../_shared/filter-matcher.mjs';

let dispatcher, store, types, getLogLines;

before(async () => {
  dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
  store = await import('../../server/dist/webhooks/store.js');
  types = await import('../../server/dist/webhooks/types.js');
  ({ getLogLines } = await import('../../server/dist/util/log.js'));
});

const NOW = new Date('2026-10-23T12:00:00.000Z');
const BASE_MS = 60_000;
const CAP_MS = 3_600_000;
const uniq = (tag) => `${tag}-${Math.random().toString(36).slice(2, 10)}`;
const urlOf = (id) => `https://example.invalid/${id}`;

/** A subscription the dispatcher marked failing before the upgrade: no probe fields at all. */
const failingRow = (id, over = {}) => ({
  id, url: urlOf(id), secret: 's', spaces: [], events: [], enabled: true, status: 'failing', consecutiveFailures: 6,
  createdAt: '', updatedAt: '', ...over,
});

const retryJob = (n, over = {}) => ({
  _id: `job-${n}`, webhookId: `sink-${n}`, body: '{}', event: 'entity.created', spaceId: 's', deliveryId: `d-${n}`,
  attempt: 2, scheduledAt: new Date(0), createdAt: new Date(0), ...over,
});

/**
 * The retry poll over fakes, with the probe members the design adds. `probes` is what `claimDueProbe` hands out, one per call, until it is
 * empty (a function of the call number may answer for ever). Every door is logged in `events`, in order.
 */
function rig({ due = [], probes = [], subs = {}, deliverProbe = async () => ok, recovered = async () => true, flipped = async () => true, now } = {}) {
  const events = [];
  const state = { claims: 0, probes: [], recovered: [] };
  const handOut = typeof probes === 'function' ? probes : (n) => probes[n - 1] ?? null;
  const deps = {
    ...(now ? { now } : {}),
    dueJobs: async () => due,
    removeJob: async (id) => { events.push(`remove ${id}`); },
    getWebhook: async (id) => subs[id] ?? failingRow(id, { status: 'active', consecutiveFailures: 0 }),
    deliver: async (_sub, j) => { events.push(`deliver ${j._id}`); return ok; },
    markSuccess: async (id) => { events.push(`success ${id}`); },
    markFailure: async (id) => { events.push(`failing ${id}`); return flipped(id); },
    requeue: async (j) => { events.push(`requeue ${j._id}`); },
    claimDueProbe: async (at) => { state.claims++; events.push('claim'); state.claimedAt = at; return handOut(state.claims); },
    deliverProbe: async (sub, body, event, spaceId, deliveryId) => {
      events.push(`probe ${sub.id}`);
      state.probes.push({ sub, body, event, spaceId, deliveryId });
      return deliverProbe(sub);
    },
    markProbeRecovered: async (id, url) => { events.push(`recovered ${id}`); state.recovered.push({ id, url }); return recovered(id); },
  };
  const { worker, fire } = armedRetryWorker(dispatcher, deps, state);
  return { worker, deps, events, state, fire };
}

/** The type the store keeps `nextProbeAt` in (a Date or an ISO string), read from its own claim, so a fixture compares like with like. */
const asStored = (ms, like) => (like instanceof Date ? new Date(ms) : new Date(ms).toISOString());
const msOf = (v) => (v instanceof Date ? v.getTime() : Date.parse(v));

describe('1. the claim filter takes a failing row that has no probe fields (a legacy row)', () => {
  it('a subscription failing before the upgrade (no nextProbeAt, no probeAttempts) is claimed; active, disabled, switched-off and not-yet-due rows are not', () => {
    assert.equal(typeof store.probeClaim, 'function', 'webhooks/store.ts exports no probeClaim(row, now): the claim of a due probe cannot be read');
    const legacy = failingRow('w1');
    const { filter, update } = store.probeClaim(legacy, NOW);
    assert.ok(matchesFilter(legacy, filter),
      `a row failing before the upgrade (no nextProbeAt, no probeAttempts) is never claimed: ${JSON.stringify(filter)}`);
    const later = asStored(NOW.getTime() + 60_000, update?.$set?.nextProbeAt);
    const earlier = asStored(NOW.getTime() - 1, update?.$set?.nextProbeAt);
    assert.ok(matchesFilter({ ...legacy, nextProbeAt: earlier, probeAttempts: 0 }, filter), 'a row whose probe is due is not claimed');
    for (const [name, row] of [
      ['active', { ...legacy, status: 'active' }],
      ['disabled', { ...legacy, status: 'disabled' }],
      ['switched off', { ...legacy, enabled: false }],
      ['another subscription', { ...legacy, id: 'w2' }],
      ['not yet due', { ...legacy, nextProbeAt: later, probeAttempts: 0 }],
    ]) assert.equal(matchesFilter(row, filter), false, `the claim took a row that is ${name}`);
  });
});

describe('2. the probe is the test route\'s test.ping, marked entry.probe', () => {
  it('a due failing subscription is sent one test.ping in the test envelope, with entry.probe true, and no new event type exists', async () => {
    const r = rig({ probes: [{ id: 'w1', url: urlOf('w1') }], subs: { w1: failingRow('w1') } });
    r.worker.job.start();
    await r.fire();
    assert.equal(r.state.probes.length, 1, `a failing subscription whose probe was due was not probed (events: ${r.events.join(' | ')}): nothing recovers it but an admin`);
    const p = r.state.probes[0];
    assert.equal(p.event, 'test.ping', 'the probe is not the test.ping event receivers already know');
    assert.equal(p.spaceId, '_test');
    const body = JSON.parse(p.body);
    assert.equal(body.event, 'test.ping');
    assert.equal(body.spaceId, '_test', 'the probe is not in the test route\'s envelope');
    assert.equal(body.spaceName, '_test', 'the probe is not in the test route\'s envelope');
    assert.equal(typeof body.timestamp, 'string');
    assert.equal(body.entry?.probe, true, 'the probe is not marked entry.probe: a receiver cannot tell it from an admin\'s test');
    assert.equal(p.sub.id, 'w1');
    assert.equal(types.ALL_WEBHOOK_EVENTS.has('webhook.probe'), false, 'a webhook.probe event type was added: receivers switching on the event table refuse it');
  });
});

describe('3. probes run first, at most PROBES_PER_TICK, each asked against the tick budget before it starts', () => {
  it('with retries due and more probes due than the cap: the first probe starts before any retry, and the cap is kept', async () => {
    const r = rig({ due: [retryJob(1), retryJob(2)], probes: (n) => ({ id: `p${n}`, url: urlOf(`p${n}`) }) });
    r.worker.job.start();
    await r.fire();
    const firstProbe = r.events.findIndex(e => e.startsWith('probe '));
    const firstRetry = r.events.findIndex(e => e.startsWith('deliver '));
    assert.ok(firstProbe >= 0, `no failing subscription was probed in a tick that had probes due (events: ${r.events.join(' | ')})`);
    assert.ok(firstRetry < 0 || firstProbe < firstRetry, `a retry started before the tick's probes: ${r.events.join(' | ')}`);
    assert.equal(typeof dispatcher.PROBES_PER_TICK, 'number', 'webhooks/dispatcher.ts exports no PROBES_PER_TICK');
    assert.ok(dispatcher.PROBES_PER_TICK >= 1 && dispatcher.PROBES_PER_TICK < dispatcher.RETRY_BATCH, `PROBES_PER_TICK is ${dispatcher.PROBES_PER_TICK}: not small`);
    assert.equal(r.state.probes.length, dispatcher.PROBES_PER_TICK, `${r.state.probes.length} probes in one tick, cap ${dispatcher.PROBES_PER_TICK}`);
    assert.ok(r.state.claims <= dispatcher.PROBES_PER_TICK, `${r.state.claims} claims for a cap of ${dispatcher.PROBES_PER_TICK}: a claim beyond the cap schedules a probe that never runs`);
    assert.deepEqual(['job-1', 'job-2'].filter(id => !r.events.includes(`deliver ${id}`)), [], 'the probes took the tick from the retries');
  });

  it('a tick whose budget is spent after the first probe claims and starts nothing more, retries included', async () => {
    let t = 1_000_000;
    const r = rig({
      due: [retryJob(1)],
      probes: (n) => ({ id: `b${n}`, url: urlOf(`b${n}`) }),
      deliverProbe: async () => { t += dispatcher.RETRY_TICK_BUDGET_MS; return failed; },
      now: () => t,
    });
    r.worker.job.start();
    await r.fire();
    assert.equal(r.state.probes.length, 1, `the budget was not asked before each probe: ${r.state.probes.length} probes started (events: ${r.events.join(' | ')})`);
    assert.equal(r.state.claims, 1, `${r.state.claims} claims: a claim made after the budget was spent schedules a probe the tick never starts`);
    assert.ok(!r.events.includes('deliver job-1'), 'a retry started after the tick\'s budget was spent');
  });
});

describe('4. the claim schedules the next probe by backoffDelayMs(probeAttempts, 60 s, 1 h)', () => {
  it('the claim sets nextProbeAt within the equal-jittered range for k, increments probeAttempts, and carries k in its filter', () => {
    assert.equal(typeof store.probeClaim, 'function', 'webhooks/store.ts exports no probeClaim(row, now)');
    for (const k of [0, 1, 3, 20]) {
      const row = failingRow('w1', { probeAttempts: k, nextProbeAt: asStored(NOW.getTime() - 1, new Date()) });
      const { filter, update } = store.probeClaim(k === 0 ? failingRow('w1') : row, NOW);
      const nominal = Math.min(BASE_MS * 2 ** k, CAP_MS);
      const wait = msOf(update.$set.nextProbeAt) - NOW.getTime();
      assert.ok(wait >= nominal / 2 && wait <= nominal,
        `probeAttempts ${k}: the next probe is ${wait} ms away, outside [${nominal / 2}, ${nominal}] (backoffDelayMs(${k}, ${BASE_MS}, ${CAP_MS}), equal jitter)`);
      assert.deepEqual(update.$inc, { probeAttempts: 1 }, `probeAttempts ${k}: the claim does not $inc probeAttempts by one`);
      if (k > 0) {
        assert.ok(matchesFilter({ ...row, nextProbeAt: asStored(NOW.getTime() - 1, update.$set.nextProbeAt) }, filter), `probeAttempts ${k}: the claim does not take its own row`);
        assert.equal(matchesFilter({ ...row, probeAttempts: k + 1, nextProbeAt: asStored(NOW.getTime() - 1, update.$set.nextProbeAt) }, filter), false,
          `probeAttempts ${k}: the claim does not carry k in its filter, so a second process's claim of the same row is a read-then-write`);
      }
    }
  });

  it('a row whose probeAttempts is not a count (null, -1, a string) is claimed as the row it is, and its count starts again at 1 (round 2, F3)', () => {
    // A claim filter that does not match the row the claim read leaves that row first in the due order for ever: every try reads it
    // and claims nothing, and no other failing subscription is probed again.
    for (const bad of [null, -1, 'x']) {
      const row = failingRow('w1', { probeAttempts: bad, nextProbeAt: asStored(NOW.getTime() - 1, '') });
      const { filter, update } = store.probeClaim(row, NOW);
      assert.ok(matchesFilter(row, filter), `probeAttempts ${JSON.stringify(bad)}: the claim does not take the row it read, so that row is read first and never claimed`);
      assert.equal(update.$set?.probeAttempts, 1, `probeAttempts ${JSON.stringify(bad)}: the claim does not start the count again (an $inc of a non-number fails in the store)`);
      assert.equal(update.$inc?.probeAttempts, undefined, `probeAttempts ${JSON.stringify(bad)}: the claim $incs a value that is not a count`);
      const wait = msOf(update.$set.nextProbeAt) - NOW.getTime();
      assert.ok(wait >= BASE_MS / 2 && wait <= BASE_MS, `probeAttempts ${JSON.stringify(bad)}: scheduled ${wait} ms on, not as a first attempt`);
    }
  });

  it('at the cap a failing subscription is probed every 30 to 60 minutes, for ever', () => {
    assert.equal(typeof store.probeClaim, 'function', 'webhooks/store.ts exports no probeClaim(row, now)');
    const waits = Array.from({ length: 50 }, () => {
      const { update } = store.probeClaim(failingRow('w1', { probeAttempts: 40, nextProbeAt: asStored(0, new Date()) }), NOW);
      return msOf(update.$set.nextProbeAt) - NOW.getTime();
    });
    assert.ok(waits.every(w => w >= 30 * 60_000 && w <= 60 * 60_000), `capped waits outside 30-60 min: ${waits.filter(w => w < 1_800_000 || w > 3_600_000).join(', ')}`);
  });

  it('a failed probe writes nothing more than its claim: no recovery, no reset', async () => {
    const r = rig({ probes: [{ id: 'w1', url: urlOf('w1') }], subs: { w1: failingRow('w1') }, deliverProbe: async () => failed });
    r.worker.job.start();
    await r.fire();
    assert.equal(r.state.probes.length, 1, `a due failing subscription was not probed (events: ${r.events.join(' | ')})`);
    assert.deepEqual(r.events.filter(e => e.startsWith('recovered') || e.startsWith('success')), [], 'a failed probe recovered the subscription');
  });
});

describe('5. probation: a probe success leaves the count at FAILING_AFTER - 1', () => {
  it('the recovery sets active and FAILING_AFTER - 1 and clears the probe fields; one more exhausted schedule flips it back', () => {
    assert.equal(typeof store.FAILING_AFTER, 'number', 'webhooks/store.ts exports no FAILING_AFTER: the threshold is a literal');
    assert.equal(store.FAILING_AFTER, 6, 'FAILING_AFTER is not today\'s six exhausted schedules');
    assert.equal(typeof store.probeRecoveryWrite, 'function', 'webhooks/store.ts exports no probeRecoveryWrite(id, url)');
    assert.equal(typeof store.failingFlipWrite, 'function', 'webhooks/store.ts exports no failingFlipWrite(id, now)');
    const { update } = store.probeRecoveryWrite('w1', urlOf('w1'));
    assert.equal(update.$set?.status, 'active');
    assert.equal(update.$set?.consecutiveFailures, store.FAILING_AFTER - 1,
      'a probe success reset the count: a sink that answers pings and refuses payloads takes six more schedules (about ten hours) to fail again');
    assert.deepEqual(Object.keys(update.$unset ?? {}).sort(), ['nextProbeAt', 'probeAttempts'], 'the recovery leaves probe fields behind');
    const flip = store.failingFlipWrite('w1', NOW);
    const recovered = { ...failingRow('w1'), status: 'active', consecutiveFailures: store.FAILING_AFTER - 1 };
    assert.equal(matchesFilter(recovered, flip.filter), false, 'a recovered subscription is flipped back before any further failure');
    assert.ok(matchesFilter({ ...recovered, consecutiveFailures: store.FAILING_AFTER }, flip.filter),
      'one more exhausted schedule after a probe recovery does not flip the subscription back to failing');
    assert.equal(flip.update.$set?.status, 'failing');
    assert.ok('nextProbeAt' in (flip.update.$set ?? {}), 'the flip does not schedule the first probe');
    assert.equal(flip.update.$set?.probeAttempts, 0, 'the flip does not reset probeAttempts');
  });

  it('the flip also takes a row with no status (active by acceptsDeliveries) and never a disabled, failing or switched-off one', () => {
    assert.equal(typeof store.failingFlipWrite, 'function', 'webhooks/store.ts exports no failingFlipWrite(id, now)');
    const n = store.FAILING_AFTER ?? 6;
    const { filter } = store.failingFlipWrite('w1', NOW);
    const base = { id: 'w1', url: urlOf('w1'), enabled: true, consecutiveFailures: n };
    assert.ok(matchesFilter(base, filter), 'a row with no status is never flipped (acceptsDeliveries treats it as active)');
    assert.ok(matchesFilter({ ...base, status: 'active' }, filter));
    for (const over of [{ status: 'disabled' }, { status: 'failing' }, { enabled: false, status: 'active' }]) {
      assert.equal(matchesFilter({ ...base, ...over }, filter), false, `the flip took ${JSON.stringify(over)}`);
    }
  });
});

describe('6. the result writes are conditional on the row as it is when they land', () => {
  it('a subscription disabled mid-probe stays disabled, and one whose URL changed mid-probe is not recovered', () => {
    assert.equal(typeof store.probeRecoveryWrite, 'function', 'webhooks/store.ts exports no probeRecoveryWrite(id, url)');
    const probed = failingRow('w1');
    const { filter } = store.probeRecoveryWrite('w1', probed.url);
    assert.ok(matchesFilter(probed, filter), 'the recovery does not take the row it probed');
    assert.equal(matchesFilter({ ...probed, enabled: false, status: 'disabled' }, filter), false, 'a probe success flipped a subscription an admin disabled mid-probe back to active');
    assert.equal(matchesFilter({ ...probed, enabled: false }, filter), false, 'a probe success recovered a switched-off subscription');
    assert.equal(matchesFilter({ ...probed, url: 'https://elsewhere.example.invalid/' }, filter), false, 'a probe of the old URL recovered a subscription whose URL changed mid-probe');
    assert.equal(matchesFilter({ ...probed, status: 'active' }, filter), false, 'the recovery wrote over a subscription already recovered (a real success)');
  });

  it('the poll hands the recovery write the URL it probed', async () => {
    const r = rig({ probes: [{ id: 'w1', url: urlOf('w1') }], subs: { w1: failingRow('w1') } });
    r.worker.job.start();
    await r.fire();
    assert.equal(r.state.recovered.length, 1, `a probe the sink answered recovered nothing (events: ${r.events.join(' | ')})`);
    assert.deepEqual(r.state.recovered[0], { id: 'w1', url: urlOf('w1') });
    assert.ok(!r.events.includes('success w1'), 'a probe success went through markWebhookSuccess, which resets the count to 0 (no probation)');
  });

  it('a re-enable (enabled in the body, either way) clears nextProbeAt and probeAttempts; an edit without enabled leaves them', () => {
    assert.equal(typeof store.webhookUpdateWrite, 'function', 'webhooks/store.ts exports no webhookUpdateWrite(input)');
    for (const enabled of [true, false]) {
      const u = store.webhookUpdateWrite({ enabled });
      assert.deepEqual(Object.keys(u.$unset ?? {}).sort(), ['nextProbeAt', 'probeAttempts'], `enabled: ${enabled} left the probe fields behind`);
    }
    const on = store.webhookUpdateWrite({ enabled: true });
    assert.equal(on.$set.status, 'active');
    assert.equal(on.$set.consecutiveFailures, 0, 'the documented reset of a re-enable was lost');
    assert.equal(store.webhookUpdateWrite({ url: 'https://x.example.invalid/' }).$unset, undefined, 'an edit of the URL alone cleared the probe schedule');
  });
});

describe('7. the status lines are said once, by the write that changed the row', () => {
  it('"marked as failing" is said only by the exhausted schedule whose flip changed the row', async () => {
    const id = uniq('flip');
    let call = 0;
    const r = rig({
      due: [1, 2, 3, 4].map(n => retryJob(`${id}-${n}`, { webhookId: id, attempt: dispatcher.MAX_ATTEMPTS })),
      subs: { [id]: failingRow(id, { status: 'active', consecutiveFailures: 0 }) },
      flipped: async () => (++call === 2),
    });
    r.deps.deliver = async (_s, j) => { r.events.push(`deliver ${j._id}`); return failed; };
    r.worker.job.start();
    await r.fire();
    assert.equal(r.events.filter(e => e === `failing ${id}`).length, 4, `fixture: four exhausted schedules (events: ${r.events.join(' | ')})`);
    const said = getLogLines(500).filter(l => l.includes(id) && /marked as failing/.test(l));
    assert.equal(said.length, 1, `${said.length} "marked as failing" lines for one flip of four exhausted schedules: ${said.join(' | ')}`);
  });

  it('a probe answered after its subscription changed (disabled, URL changed) is counted as superseded, not as neither outcome (round 2, F6)', async () => {
    const before = dispatcher.webhookProbeCounts();
    assert.equal(typeof before.superseded, 'number', 'ythril_webhook_probes_total has no superseded outcome: an answered probe whose recovery matched nothing is counted nowhere');
    const id = uniq('sup');
    const r = rig({ probes: [{ id, url: urlOf(id) }], subs: { [id]: failingRow(id) }, recovered: async () => false });
    r.worker.job.start();
    await r.fire();
    assert.equal(r.state.probes.length, 1, `a due failing subscription was not probed (events: ${r.events.join(' | ')})`);
    const after = dispatcher.webhookProbeCounts();
    assert.equal(after.superseded - before.superseded, 1, 'an answered probe whose recovery write matched nothing was not counted superseded');
    assert.equal(after.recovered - before.recovered, 0);
    assert.equal(after.failed - before.failed, 0);
  });

  it('a probe whose delivery throws, or whose recovery write throws after the sink answered, is counted as error (round 3, item 5)', async () => {
    const before = dispatcher.webhookProbeCounts();
    assert.equal(typeof before.error, 'number', 'ythril_webhook_probes_total has no error outcome: a probe that threw is counted nowhere');
    const boom = () => { throw new Error('boom'); };
    const thrown = uniq('thr');
    const r1 = rig({ probes: [{ id: thrown, url: urlOf(thrown) }], subs: { [thrown]: failingRow(thrown) }, deliverProbe: async () => boom() });
    r1.worker.job.start();
    await r1.fire();
    const lost = uniq('lost');
    const r2 = rig({ probes: [{ id: lost, url: urlOf(lost) }], subs: { [lost]: failingRow(lost) }, recovered: async () => boom() });
    r2.worker.job.start();
    await r2.fire();
    assert.equal(r1.state.probes.length + r2.state.probes.length, 2, 'fixture: the two probes were not sent');
    const after = dispatcher.webhookProbeCounts();
    assert.equal(after.error - before.error, 2, 'a probe that threw (in its delivery, or in its recovery write after the sink answered) was not counted as error');
    for (const k of ['recovered', 'failed', 'superseded']) assert.equal(after[k] - before[k], 0, `a probe that threw was counted as ${k}`);
  });

  it('"recovered" is said once, by the recovery write that changed the row, and not by one that matched nothing', async () => {
    const id = uniq('rec');
    let call = 0;
    const r = rig({ probes: [{ id, url: urlOf(id) }, { id, url: urlOf(id) }], subs: { [id]: failingRow(id) }, recovered: async () => (++call === 1) });
    r.worker.job.start();
    await r.fire();
    assert.ok(r.state.probes.length >= 1, `a due failing subscription was not probed (events: ${r.events.join(' | ')})`);
    const said = getLogLines(500).filter(l => l.includes(id) && /recovered/i.test(l));
    assert.equal(said.length, 1, `${said.length} "recovered" lines for one recovery: ${said.join(' | ')}`);
  });
});
