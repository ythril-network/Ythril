/**
 * A failing webhook subscription recovers by itself when its sink answers again, and the store's status writes hold against a second
 * writer: another process, a concurrent failure, a disabled row (bundle-119, Q-477, design rev 3). Against the harness Mongo.
 *
 * ## The defect it closes
 *
 * `markWebhookFailure` read the subscription from this process's cache, added one, and `$set` the count and the status back: two failures
 * at once wrote the same count. Once failing, nothing ever delivered to the subscription again, and only an admin reset it. The cache had
 * no expiry and was dropped only by this process's own writes, so a status another instance wrote (a rolling update runs two) never
 * reached this one. `markWebhookSuccess` wrote `status: 'active'` to whatever row it was handed, a disabled one included.
 *
 * ## What is held
 *
 *  8. **Two module instances** (two processes' caches over one database): one probes and recovers a subscription, and the other's event
 *     match sees it within `CACHE_TTL_MS`. Also for a recovery by `markWebhookSuccess` (the test ping's path).
 *  9. **The probe is signed with the plaintext secret**: the subscription the poll hands to the probe's delivery is read through
 *     `getWebhookFull`, never the row the claim returned (whose `secret` is the stored ciphertext).
 * 10. **Concurrent failures end at +n**: an atomic `$inc`, from one module and from two.
 * 11. **A failing subscription recovers by itself** when the fake sink answers again: a failed probe leaves it failing and scheduled, a
 *     tick before the schedule probes nothing, and a probe after it recovers the subscription.
 * 12. **A row with no `status`** (active by `acceptsDeliveries`) still flips to failing at `FAILING_AFTER`, and the flip schedules the first
 *     probe (`nextProbeAt`, `probeAttempts: 0`).
 * 13. **`markWebhookSuccess` never touches a disabled row.**
 * 15. **Metrics**: `ythril_webhook_probes_total{outcome}` counts a failed and a recovered probe, and the `ythril_webhooks_failing` gauge is
 *     read at scrape time (it is poisoned before the scrape: a gauge that is never set reads its last value, or zero after a reset).
 *
 * A delivery is an outbound request the SSRF guard refuses to send to anything a test can listen on, so the probe's delivery is the
 * one door faked (`deliverProbe`); the claim, the read of the subscription and the result writes are production's
 * (`productionRetryPollDeps()`, which the design adds; until it exists, the store's own functions stand in so the case can fail on
 * behaviour rather than at the name).
 *
 * ## Seen red
 *
 * At a644fe92: no probe is ever made (8, 9, 11, 15's counter fail on "not probed"), the second instance never sees a recovery (8),
 * concurrent failures end at +1 (10), the flip writes no nextProbeAt (12), a success flips a disabled row to active (13), and neither
 * metric is registered (15).
 *
 * Run: node --test testing/standalone/a-failing-webhook-recovers-by-itself-db.test.js
 * (requires the harness Mongo and a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { mongoSkipReason, openTestMongo, closeTestMongo } from './_mongo-harness.mjs';
import { ok, failed, armedRetryWorker } from './_retry-poll-rig.mjs';
import { waitFor, holdsWithin } from '../_shared/wait-for.mjs';

// The webhook secret is encrypted with a key kept in secrets.json beside CONFIG_PATH: a scratch directory, set before the server loads.
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-webhook-recover-'));
process.env['CONFIG_PATH'] = path.join(scratch, 'config.json');
process.env['DATA_ROOT'] = path.join(scratch, 'data');

const skip = await mongoSkipReason();
const SUITE = 'webhookrecover';
const WEBHOOKS = '_webhooks';
const T0 = Date.parse('2026-10-23T12:00:00.000Z');

let mongo, store, storeB, dispatcher, registry;

const hmac = (secret, body) => crypto.createHmac('sha256', secret).update(body).digest('hex');
const rowOf = (id) => mongo.col(WEBHOOKS).findOne({ id });

/** A webhook created through the store (its secret encrypted), then marked failing in the database the way a pre-upgrade row is: no probe fields. */
async function failingWebhook(tag, { secret = `${tag}-secret-0123456789` } = {}) {
  const { id } = await store.createWebhook({ url: `https://example.invalid/${tag}`, secret });
  await mongo.col(WEBHOOKS).updateOne({ id }, { $set: { status: 'failing', consecutiveFailures: 6 } });
  return { id, secret };
}

/**
 * The poll's deps as production builds them, with the probe's delivery faked and the clock handed in. No retries are due here
 * (`dueJobs` answers none), so a tick is the probe step alone.
 */
function probeDeps({ deliverProbe, now }) {
  const production = typeof dispatcher.productionRetryPollDeps === 'function' ? dispatcher.productionRetryPollDeps() : {
    removeJob: async () => {}, getWebhook: (id) => store.getWebhookFull(id), deliver: async () => failed,
    markSuccess: store.markWebhookSuccess, markFailure: store.markWebhookFailure, requeue: async () => {},
    ...(store.claimDueProbe ? { claimDueProbe: store.claimDueProbe } : {}),
    ...(store.markProbeRecovered ? { markProbeRecovered: store.markProbeRecovered } : {}),
  };
  // `claimed` counts the claims that took a row, `probesSettled` the probes whose outcome is in: the subscription was gone, the sink
  // refused (or the delivery threw), or the recovery write answered. A claim's write lands BEFORE its probe is delivered, so a case
  // that waited on what the claim wrote (`probeAttempts`) used to read the probes, the row and the counters while the probe was still
  // on its way (the CI failure of PR #1538: "not probed on the first tick", 0 probes, with the probe's own line logged just after).
  const state = { probes: [], claims: 0, claimsSettled: 0, claimed: 0, probesSettled: 0 };
  const claim = production.claimDueProbe;
  const recover = production.markProbeRecovered;
  const deps = {
    ...production,
    now: () => now(),
    dueJobs: async () => [],
    // A tick's probe step goes on after the case has what it waited for (its second claim): once `tick` closes the deps, that claim
    // answers null, so a case's tick never claims a row the NEXT case created.
    ...(claim ? { claimDueProbe: async (at) => {
      if (state.closed) return null;
      state.claims++;
      try { const got = await claim(at); if (got) state.claimed++; return got; } finally { state.claimsSettled++; }
    } } : {}),
    getWebhook: async (id) => { const sub = await production.getWebhook(id); if (!sub) state.probesSettled++; return sub; },
    deliverProbe: async (sub, body, event, spaceId, deliveryId) => {
      state.probes.push({ id: sub.id, secret: sub.secret, body, event, spaceId, deliveryId });
      let result;
      try { result = await deliverProbe(sub); } catch (err) { state.probesSettled++; throw err; }
      if (!result.success) state.probesSettled++;
      return result;
    },
    ...(recover ? { markProbeRecovered: async (id, url) => { try { return await recover(id, url); } finally { state.probesSettled++; } } } : {}),
  };
  return { deps, state };
}

/**
 * One tick of a fresh worker (its own single flight, so a tick still finishing never makes this one a skip), awaited to `until`, and
 * then to its END: no claim in flight, and every probe it claimed settled. A case reads what the tick did, never what it had begun.
 */
async function tick(deps, state, until, ms = 10_000) {
  const { worker, fire } = armedRetryWorker(dispatcher, deps, state);
  const claimsBefore = state.claimsSettled;
  state.closed = false;
  worker.job.start();
  await fire();
  worker.job.stop();
  try {
    if (until) return await holdsWithin(until, ms, 25);
    // THIS tick's first claim has answered (a count over every tick would be met before this one claimed anything).
    return await holdsWithin(() => state.claimsSettled > claimsBefore, ms, 25);
  } finally {
    state.closed = true;
    await holdsWithin(() => state.claimsSettled === state.claims && state.probesSettled === state.claimed, ms, 10);
  }
}

/** A metric's value as an operator reads it from the scrape, or undefined when it is not on the scrape. */
async function scraped(name, labels = '') {
  const metric = registry.register.getSingleMetric(name);
  if (!metric) return undefined;
  const text = await registry.register.getSingleMetricAsString(name);
  const line = text.split(/\r?\n/).find(l => l.startsWith(`${name}${labels} `));
  return line === undefined ? undefined : Number(line.trim().split(/\s+/).at(-1));
}

describe('a failing webhook recovers by itself (Q-477)', { skip }, () => {
  before(async () => {
    // Command monitoring on: case 19 counts the reads a burst of successes costs.
    mongo = await openTestMongo(SUITE, { query: '&monitorCommands=true' });
    store = await import('../../server/dist/webhooks/store.js');
    // A second instance of the store module: its own cache over the same database, as a second process has.
    storeB = await import('../../server/dist/webhooks/store.js?instance=b');
    dispatcher = await import('../../server/dist/webhooks/dispatcher.js');
    registry = await import('../../server/dist/metrics/registry.js');
  });
  after(async () => {
    await closeTestMongo();
    fs.rmSync(scratch, { recursive: true, force: true });
  });
  beforeEach(async () => { await mongo.col(WEBHOOKS).deleteMany({}); await store.deleteWebhook('-').catch(() => {}); await storeB.deleteWebhook('-').catch(() => {}); });

  describe('8. two module instances', () => {
    it('one instance probes and recovers a subscription, and the other\'s event match sees it within CACHE_TTL_MS', async () => {
      const { id } = await failingWebhook('two');
      // B has read the subscription while it was failing: its cache holds that.
      assert.equal((await storeB.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), false, 'fixture: a failing subscription matched');
      const { deps, state } = probeDeps({ deliverProbe: async () => ok, now: () => T0 });
      await tick(deps, state, async () => (await rowOf(id))?.status === 'active');
      assert.equal(state.probes.length, 1, 'instance A never probed the failing subscription');
      assert.equal((await rowOf(id)).status, 'active', 'the probe the sink answered did not recover the subscription');
      const ttl = storeB.CACHE_TTL_MS ?? 5_000;
      const seen = await holdsWithin(async () => (await storeB.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), ttl + 3_000, 100);
      assert.ok(seen, `instance B still refused the recovered subscription ${ttl + 3_000} ms later: its cache never expires`);
      assert.equal(typeof storeB.CACHE_TTL_MS, 'number', 'webhooks/store.ts exports no CACHE_TTL_MS');
    });

    it('a recovery by markWebhookSuccess (a delivered test ping) on one instance reaches the other within CACHE_TTL_MS', async () => {
      const { id } = await failingWebhook('ping');
      assert.equal((await storeB.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), false, 'fixture: a failing subscription matched');
      await store.markWebhookSuccess(id);
      assert.equal((await rowOf(id)).status, 'active', 'fixture: markWebhookSuccess did not recover the row');
      const ttl = storeB.CACHE_TTL_MS ?? 5_000;
      const seen = await holdsWithin(async () => (await storeB.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), ttl + 3_000, 100);
      assert.ok(seen, `instance B still refused a subscription instance A recovered, ${ttl + 3_000} ms later: its cache never expires`);
    });
  });

  describe('9. the probe is signed with the plaintext secret', () => {
    it('the subscription handed to the probe\'s delivery carries the decrypted secret, never the stored ciphertext', async () => {
      const { id, secret } = await failingWebhook('sig', { secret: 'plain-probe-secret-0123456789' });
      const stored = (await rowOf(id)).secret;
      assert.notEqual(stored, secret, 'fixture: the secret is stored in plaintext, so the case cannot tell the two apart');
      const { deps, state } = probeDeps({ deliverProbe: async () => ok, now: () => T0 });
      await tick(deps, state, () => state.probes.length >= 1);
      assert.equal(state.probes.length, 1, 'the failing subscription was never probed');
      const p = state.probes[0];
      assert.equal(hmac(p.secret, p.body), hmac(secret, p.body),
        `the probe would be signed with ${p.secret === stored ? 'the stored ciphertext' : 'a key that is not the secret'}: the receiver's verification fails, and the probe never recovers it`);
    });
  });

  describe('10. concurrent failures end at +n', () => {
    it('five failures at once, from one module, count five', async () => {
      const { id } = await store.createWebhook({ url: 'https://example.invalid/inc', secret: 'inc-secret-0123456789' });
      await Promise.all(Array.from({ length: 5 }, () => store.markWebhookFailure(id)));
      assert.equal((await rowOf(id)).consecutiveFailures, 5, 'concurrent failures were counted by read-modify-write: each wrote the same count');
    });

    it('failures from two instances at once count every one', async () => {
      const { id } = await store.createWebhook({ url: 'https://example.invalid/inc2', secret: 'inc2-secret-0123456789' });
      await Promise.all([store.markWebhookFailure(id), storeB.markWebhookFailure(id), store.markWebhookFailure(id), storeB.markWebhookFailure(id)]);
      assert.equal((await rowOf(id)).consecutiveFailures, 4, 'failures from two processes were counted by read-modify-write');
    });
  });

  describe('11. a failing subscription recovers by itself when its sink answers again', () => {
    it('a failed probe leaves it failing and scheduled, a tick before the schedule probes nothing, and a probe after it recovers it', async () => {
      const { id } = await failingWebhook('self');
      let sinkUp = false;
      let clock = T0;
      const { deps, state } = probeDeps({ deliverProbe: async () => (sinkUp ? ok : failed), now: () => clock });

      await tick(deps, state, async () => (await rowOf(id))?.probeAttempts === 1);
      assert.equal(state.probes.length, 1, 'a failing subscription with no probe scheduled (a pre-upgrade row) was not probed on the first tick');
      const afterFail = await rowOf(id);
      assert.equal(afterFail.status, 'failing', 'a probe the sink refused recovered the subscription');
      assert.equal(afterFail.probeAttempts, 1, 'a failed probe did not count its attempt');
      const next = new Date(afterFail.nextProbeAt).getTime();
      assert.ok(next - T0 >= 30_000 && next - T0 <= 60_000, `the first failed probe scheduled the next ${next - T0} ms on, not 30-60 s`);

      clock = T0 + 10_000;
      await tick(deps, state);
      assert.equal(state.probes.length, 1, 'a subscription was probed before its schedule');

      sinkUp = true;
      clock = T0 + 2 * 3_600_000;
      await tick(deps, state, async () => (await rowOf(id))?.status === 'active');
      const recovered = await rowOf(id);
      assert.equal(recovered.status, 'active', 'the sink answered and the subscription stayed failing: nothing recovers it but an admin');
      assert.equal(recovered.consecutiveFailures, (store.FAILING_AFTER ?? 6) - 1, 'the recovery did not leave the subscription on probation');
      assert.equal('nextProbeAt' in recovered || 'probeAttempts' in recovered, false, 'the recovery left probe fields behind');
      const ttl = store.CACHE_TTL_MS ?? 5_000;
      assert.ok(await holdsWithin(async () => (await store.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), ttl + 3_000, 100),
        'the recovered subscription takes no new events');
    });
  });

  describe('12. a row with no status flips to failing at FAILING_AFTER', () => {
    it('a subscription with no status field (active) one failure short flips on the next, and the flip schedules the first probe', async () => {
      const n = store.FAILING_AFTER ?? 6;
      const id = `nostatus-${crypto.randomUUID()}`;
      await mongo.col(WEBHOOKS).insertOne({ id, url: 'https://example.invalid/nostatus', secret: 'x', spaces: [], events: [], enabled: true,
        consecutiveFailures: n - 1, createdAt: '', updatedAt: '' });
      await store.deleteWebhook('-');   // a write through the module drops its cache, so it reads the row inserted beside it
      await store.markWebhookFailure(id);
      const row = await rowOf(id);
      assert.equal(row.consecutiveFailures, n);
      assert.equal(row.status, 'failing', 'a row with no status (active by acceptsDeliveries) did not flip at FAILING_AFTER');
      assert.ok(row.nextProbeAt !== undefined && row.nextProbeAt !== null, 'the flip to failing scheduled no probe (nextProbeAt)');
      assert.equal(row.probeAttempts, 0, 'the flip did not reset probeAttempts');
    });
  });

  describe('13. markWebhookSuccess never touches a disabled row', () => {
    it('a success recorded for a disabled subscription leaves it disabled', async () => {
      const { id } = await store.createWebhook({ url: 'https://example.invalid/off', secret: 'off-secret-0123456789', enabled: false });
      assert.equal((await rowOf(id)).status, 'disabled', 'fixture');
      await store.markWebhookSuccess(id);
      const row = await rowOf(id);
      assert.equal(row.status, 'disabled', 'a delivery success (a test ping to a switched-off subscription) flipped a disabled row to active');
      assert.equal(row.enabled, false);
    });

    it('a probe recovery of a subscription disabled mid-probe leaves it disabled', async () => {
      const { id } = await failingWebhook('midprobe');
      const { deps, state } = probeDeps({
        deliverProbe: async () => { await mongo.col(WEBHOOKS).updateOne({ id }, { $set: { enabled: false, status: 'disabled' } }); return ok; },
        now: () => T0,
      });
      await tick(deps, state, () => state.probes.length >= 1);
      assert.equal(state.probes.length, 1, 'the failing subscription was never probed');
      await holdsWithin(() => false, 300, 50);
      assert.equal((await rowOf(id)).status, 'disabled', 'a probe success flipped a subscription disabled mid-probe back to active');
    });
  });

  describe('15. probe and failing metrics', () => {
    it('ythril_webhook_probes_total counts a failed and a recovered probe', async () => {
      const { id } = await failingWebhook('metric');
      const failedBefore = await scraped('ythril_webhook_probes_total', '{outcome="failed"}');
      const recoveredBefore = await scraped('ythril_webhook_probes_total', '{outcome="recovered"}');
      let sinkUp = false;
      let clock = T0;
      const { deps, state } = probeDeps({ deliverProbe: async () => (sinkUp ? ok : failed), now: () => clock });
      await tick(deps, state, async () => (await rowOf(id))?.probeAttempts === 1);
      sinkUp = true; clock = T0 + 2 * 3_600_000;
      await tick(deps, state, async () => (await rowOf(id))?.status === 'active');
      assert.equal(state.probes.length, 2, `${state.probes.length} probes for one failed and one answered`);
      assert.notEqual(failedBefore, undefined, 'ythril_webhook_probes_total{outcome="failed"} is not on the scrape');
      assert.notEqual(recoveredBefore, undefined, 'ythril_webhook_probes_total{outcome="recovered"} is not on the scrape');
      assert.equal(await scraped('ythril_webhook_probes_total', '{outcome="failed"}') - failedBefore, 1, 'a failed probe was not counted');
      assert.equal(await scraped('ythril_webhook_probes_total', '{outcome="recovered"}') - recoveredBefore, 1, 'a recovered probe was not counted');
    });

    it('ythril_webhooks_failing is read at scrape time: a poisoned value is replaced by the count of failing subscriptions', async () => {
      await failingWebhook('g1');
      await failingWebhook('g2');
      await store.createWebhook({ url: 'https://example.invalid/g3', secret: 'g3-secret-0123456789' });
      const gauge = registry.register.getSingleMetric('ythril_webhooks_failing');
      assert.ok(gauge, 'ythril_webhooks_failing is not registered: an operator cannot see how many subscriptions are failing');
      gauge.set(999);
      assert.equal(await scraped('ythril_webhooks_failing'), 2, 'the failing gauge is not read at scrape time: it reports the value it was last set to');
    });
  });

  // ── Round 2 (lens findings on bdd271ee) ─────────────────────────────────────────────────────────────────────────────

  describe('16. a success resets a failure another instance counted (F2)', () => {
    it('instance A, whose copy shows the subscription active with no failures, still resets a failure instance B counted a moment ago', async () => {
      const { id } = await store.createWebhook({ url: 'https://example.invalid/reset', secret: 'reset-secret-0123456789' });
      // A reads the subscription now: its copy says active, count 0, and stays trusted for CACHE_TTL_MS.
      assert.ok((await store.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), 'fixture: A does not see the active subscription');
      await storeB.markWebhookFailure(id);
      assert.equal((await rowOf(id)).consecutiveFailures, 1, 'fixture: B did not count its failure');
      await store.markWebhookSuccess(id);
      // The check runs after the success, off the delivery's time: within a moment, never "at the next success".
      const reset = await holdsWithin(async () => (await rowOf(id)).consecutiveFailures === 0, 3_000, 25);
      assert.ok(reset,
        'a delivery success on A did not reset the failure B counted: A trusted its copy (active, 0) and wrote nothing, so the count survives the success');
    });
  });

  describe('17. one malformed row does not stop the probes (F3)', () => {
    it('a failing row with probeAttempts null, due first, does not keep a good row from being probed', async () => {
      const bad = await failingWebhook('badattempts');
      await mongo.col(WEBHOOKS).updateOne({ id: bad.id }, { $set: { probeAttempts: null, nextProbeAt: '2000-01-01T00:00:00.000Z' } });
      const good = await failingWebhook('goodattempts');
      await mongo.col(WEBHOOKS).updateOne({ id: good.id }, { $set: { probeAttempts: 0, nextProbeAt: '2001-01-01T00:00:00.000Z' } });
      const { deps, state } = probeDeps({ deliverProbe: async () => failed, now: () => T0 });
      await tick(deps, state, () => state.probes.some(p => p.id === good.id), 5_000);
      assert.ok(state.probes.some(p => p.id === good.id),
        `the good failing subscription was never probed (probed: ${JSON.stringify(state.probes.map(p => p.id))}): a row whose probeAttempts is null is read first and never claimed`);
      const badRow = await rowOf(bad.id);
      assert.equal(badRow.probeAttempts, 1, 'the malformed row was not claimed with its count started again');
    });
  });

  describe('18. two instances racing for one due probe: exactly one claims it (F4)', () => {
    it('both read the due row; the second claim, computed from that same read, matches nothing, even on a clock past the first claim\'s schedule', async () => {
      const { id } = await failingWebhook('race');
      // The interleaving a race produces, made deterministic: both instances have read the row before either writes.
      const read = await mongo.col(WEBHOOKS).findOne({ id });
      const claimA = store.probeClaim(read, new Date(T0));
      const claimB = storeB.probeClaim(read, new Date(T0 + 2 * 3_600_000));   // B's tick runs later, still holding the read
      const a = await mongo.col(WEBHOOKS).updateOne(claimA.filter, claimA.update);
      const b = await mongo.col(WEBHOOKS).updateOne(claimB.filter, claimB.update);
      assert.equal(a.modifiedCount, 1, 'fixture: the first claim did not take the due row');
      assert.equal(b.modifiedCount, 0, 'a second instance claimed the probe the first had claimed: two probes go out for one schedule');
      assert.equal((await rowOf(id)).probeAttempts, 1);
    });

    it('two instances claiming at once send one probe', async () => {
      const { id } = await failingWebhook('race2');
      const results = await Promise.all([store.claimDueProbe(new Date(T0)), storeB.claimDueProbe(new Date(T0))]);
      assert.equal(results.filter(r => r?.id === id).length, 1, `${results.filter(r => r?.id === id).length} claims of one due probe`);
      assert.equal((await rowOf(id)).probeAttempts, 1);
    });
  });

  // ── Round 3 (re-review of e8f497c8) ─────────────────────────────────────────────────────────────────────────────────

  /** The reads of `_webhooks` that ask whether a success must reset a row (the `$or` filter of the check), made while `fn` runs. */
  async function successChecksDuring(fn) {
    const client = mongo.getMongo();
    const seen = [];
    const listener = (ev) => {
      if (ev.commandName === 'find' && ev.command?.find === WEBHOOKS && ev.command?.filter?.$or) seen.push(ev.command.filter.id);
    };
    client.on('commandStarted', listener);
    try { await fn(); } finally { client.off('commandStarted', listener); }
    return seen;
  }

  describe('19. a busy healthy subscription pays a bounded number of success checks (round 3, item 2)', () => {
    it('20 successes spread over well under CACHE_TTL_MS cost at most one check read', async () => {
      const { id } = await store.createWebhook({ url: 'https://example.invalid/busy', secret: 'busy-secret-0123456789' });
      assert.ok((await store.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), 'fixture: the subscription is not active in the copy');
      const reads = await successChecksDuring(async () => {
        for (let i = 0; i < 20; i++) {
          await store.markWebhookSuccess(id);
          await holdsWithin(() => false, 40, 20);   // each success after the last check has finished
        }
        await holdsWithin(() => false, 200, 50);
      });
      const mine = reads.filter(r => r === id).length;
      assert.ok(mine >= 1, 'fixture: no check read at all, so the count proves nothing');
      assert.ok(mine <= 1, `${mine} check reads for 20 successes inside one CACHE_TTL_MS window: a busy healthy subscription pays a read per success`);
    });
  });

  describe('20. no success check starts once shutdown has begun (round 3, item 3)', () => {
    it('after stopSuccessChecks, a success starts no read (a late one would land after closeMongo)', async () => {
      assert.equal(typeof storeB.stopSuccessChecks, 'function', 'webhooks/store.ts exports no stopSuccessChecks: nothing stops the background checks at shutdown');
      const { id } = await storeB.createWebhook({ url: 'https://example.invalid/stopping', secret: 'stop-secret-0123456789' });
      assert.ok((await storeB.getMatchingWebhooks('entity.created', 'any')).some(s => s.id === id), 'fixture');
      storeB.stopSuccessChecks();   // instance B only: A's module keeps its checks for the cases above
      const reads = await successChecksDuring(async () => {
        await storeB.markWebhookSuccess(id);
        await holdsWithin(() => false, 200, 50);
      });
      assert.deepEqual(reads.filter(r => r === id), [], 'a success check started after shutdown began');
    });
  });
});
