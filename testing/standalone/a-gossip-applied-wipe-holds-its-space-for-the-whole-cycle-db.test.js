/**
 * A wipe the gossip pass applies in the middle of a cycle holds its space for the REST of that cycle - no request for the space is made before the
 * wipe is done - while the cycle itself does not wait for the wipe (bundle-106 PR A, section 3.4, R6-e, P20).
 *
 * ## What was true before
 *
 * `runSyncForMember` runs the governance gossip FIRST and the per-space data loop after it. A passed wipe the gossip pass concluded (a peer's yes
 * arrived in the vote list it pulled) started its `wipeSpace` right there, un-awaited, and the data loop then went on to exchange the very space that
 * was being emptied: it pulled the peer's pre-wipe records into it and pushed the instance's own out of it, in the same cycle that applied the wipe.
 * Nothing refused it, because nothing knew the wipe was under way - the round was marked applied before its deletes had run.
 *
 * ## What holds now (P20's race, closed by the standing act and the per-space re-check)
 *
 * The act is registered in the very write that records the conclusion, so by the time the loop reaches the space it STANDS and the space is held
 * (`act owed here`): no manifest, tombstone, page or push request names it before the act is done. And "the pass awaits nothing" (VR6): the cycle
 * returns while the act is still running, and every other space of the network is exchanged as ever.
 *
 * ## How it is driven
 *
 * The REAL engine against the pull door's fake peer behind `_stalling-peer-proxy.mjs`, which only records here (no request is parked). The fake peer
 * serves, as its vote list, an open wipe round of the space carrying its own yes: in a club that passes at the instance that reads it, so the gossip
 * pass concludes and applies it - no vote is cast by hand. The wipe is made SLOW by a real thing, a document lock the act's first delete needs
 * (`holdDocumentLock`): the act stands for exactly as long as the test holds the lock, with no seam in the wipe, so the row means the same before and
 * after the runner exists. "The cycle returned before the wipe did" is read off the locked document, which is still there when the cycle returns.
 *
 * ## Seen red
 *
 * Against 84f0b3cc the loop exchanges the space whose wipe is running: the proxy saw page, manifest and push requests for it. The twin (the space
 * nothing holds IS exchanged in the same cycle), the round having concluded passed, and the cycle returning before the wipe are controls that pass on
 * purpose: each is what makes the absence mean something.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-gossip-applied-wipe-holds-its-space-for-the-whole-cycle-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { holdDocumentLock } from './_write-faults.mjs';
import { startStallingPeerProxy } from './_stalling-peer-proxy.mjs';
import { resetRunnerForTest } from './_space-act-harness.mjs';
import { loadRunnerIfBuilt, settleActs } from './_space-act-modules.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const HELD = 'gossipheld';
const FREE = 'gossipfree';
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const T = { timeout: 180_000 };
const BOUND = 30_000;
const ROUND = 'gossip-wipe-round';

let door, loader, proxy, served;

/** The wipe round the peer serves: open, one yes (the peer's own), for the space this instance carries. */
const peerRound = () => ({
  roundId: ROUND, type: 'space_wipe', spaceId: HELD, subjectInstanceId: PEER, subjectLabel: 'peer', subjectUrl: '',
  openedAt: iso(NOW - 60_000), deadline: iso(NOW + 23 * HOUR), concluded: false,
  votes: [{ instanceId: PEER, vote: 'yes', castAt: iso(NOW - 60_000) }],
});
const ourRound = () => loader.getConfig().networks.find(n => n.id === door.NET).pendingRounds.find(r => r.roundId === ROUND);

describe('a wipe the gossip pass applies holds its space for the rest of the cycle', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'gossipwipe', spaces: [HELD, FREE], type: 'club', direction: 'both', files: true });
    loader = await import('../../server/dist/config/loader.js');
    proxy = await startStallingPeerProxy(door.url);
    loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === door.NET).members[0].url = proxy.url; });
  });
  after(async () => {
    await proxy?.close();
    try { const runner = await loadRunnerIfBuilt(); if (runner) resetRunnerForTest(runner); } catch { /* best effort */ }
    await door?.close();
  });
  beforeEach(async () => {
    proxy.reset();
    await door.reset();
    served = [];
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.pendingRounds = []; net.spaces = [HELD, FREE]; net.merkle = false;
      delete cfg.pendingSpaceActs; delete cfg.pendingSpaceOp;
    });
    door.state.family = (req, res, family) => door.serveFamily(req, res, family);
    door.state.network = (req, res, next) => {
      if (req.method === 'GET' && req.path === `/${door.NET}/votes`) { res.json({ rounds: served }); return; }
      if (req.method === 'POST' && /\/votes\//.test(req.path)) { res.json({ status: 'ok' }); return; }
      next();
    };
    const runner = await loadRunnerIfBuilt();
    if (runner) resetRunnerForTest(runner);
    // Something to pull and something to push for each space, so an exchange is visible as requests.
    for (const space of [HELD, FREE]) {
      const put = await door.push('/batch-upsert', { facts: [build.fact(space, `${space}-local`, 3, { author: { instanceId: door.instanceId, instanceLabel: 'Receiver' } })] }, { spaceId: space, networkId: door.NET, token: ADMIN_TOKEN });
      assert.equal(put.code, 200, `fixture: the local record of ${space} was not stored (${JSON.stringify(put.body)})`);
      await door.seedPeerRecords(space, 'facts', [build.fact(space, `${space}-peer`, 5, { author: PEER_AUTHOR })]);
    }
    await door.settled();
  });

  it('R-W4 / R6-e: a gossip-applied wipe against a slow act - no request for the space before the act is done, the cycle returns before it does, the other space is exchanged', T, async () => {
    // The act's first delete needs this document, so the wipe is under way and cannot finish for as long as the lock is held.
    const lock = await holdDocumentLock(door.mongo, `${HELD}_facts`, { filter: { _id: `${HELD}-local` } });
    let released = false;
    try {
      served = [peerRound()];
      const since = proxy.requests.length;
      const out = await door.sync();
      assert.equal(out.errors ?? 0, 0, `the cycle failed: ${JSON.stringify(out)}`);

      // the scenario is what it says: the gossip pass concluded the round passed, and the wipe has NOT finished (the locked document is still there)
      const round = ourRound();
      assert.ok(round?.concluded === true && round.passed === true, `fixture: the gossip pass did not conclude the peer's round as passed (${JSON.stringify(round)})`);
      assert.equal(await door.coll(HELD, 'facts').countDocuments({ _id: `${HELD}-local` }), 1, 'the cycle waited for the wipe: the locked document is gone, so the cycle did not return before the wipe did');

      assert.ok(proxy.requestsForSpace(FREE, since).length > 0, 'the twin failed: the space nothing holds was not exchanged in the same cycle, so the absence below proves nothing');
      const touched = proxy.requestsForSpace(HELD, since).map(r => `${r.method} ${r.path}`);
      assert.deepEqual(touched, [], 'the data loop exchanged the space whose wipe the gossip pass had just started: the peer\'s pre-wipe records and files come back, and this instance\'s own are pushed out');

      await lock.release(); released = true;
      assert.ok(await waitFor(async () => ourRound()?.appliedHere === true, BOUND, 20, undefined, { what: 'the round applied once the act finished' }), 'the act never finished after the lock was released');
    } finally {
      if (!released) await lock.release();
      await settleActs(door, loader);
    }
  });

  it('control: with no wipe in the vote list the same cycle exchanges both spaces (so the rows above are about the wipe, not the fixture)', T, async () => {
    served = [];
    const since = proxy.requests.length;
    const out = await door.sync();
    assert.equal(out.errors ?? 0, 0, `the cycle failed: ${JSON.stringify(out)}`);
    for (const space of [HELD, FREE]) {
      const kinds = proxy.requestsForSpace(space, since).map(r => r.path);
      assert.ok(kinds.includes('/api/sync/facts') && kinds.includes('/api/sync/manifest'),
        `the fixture exchanges nothing of ${space} even when nothing is wiped (${kinds.join(', ')}): a pull page and the manifest should both be there`);
    }
  });
});
