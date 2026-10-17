/**
 * A wipe started in the MIDDLE of an exchange waits for the exchange's unit in flight, cuts the rest of the turn, deletes after the exchange's last
 * write, and nothing the exchange moved survives it; while the act stands no second exchange of the space is made (bundle-106 PR A, section 3.3a,
 * R-W4a, R-W4b, R-W4c, R-W4 (second exchange), R-X5a).
 *
 * ## What was true before
 *
 * The hold was asked when an exchange STARTED. A wipe that began while a turn was in the middle of a page, a push or a file raced it: the wipe emptied
 * the space and the page, the push mark or the file the turn was still moving landed afterwards - the records of a wiped space came back from the very
 * exchange that was running when it was wiped, with no error anywhere. The turn read its spaces and its units once and nothing told it to stop.
 *
 * ## What holds now
 *
 * An act REGISTERS durably the moment it is owed, and from then: the turn stops at its next unit (between pages, between files) and the unit in flight
 * is cut at once (the fetch takes the transfer's signal); the act waits for what was admitted, outside the instance-wide slot, and only then deletes;
 * and an exchange of the space is refused for as long as the act stands. So, per row:
 *
 * - **R-W4a** a wipe started while a PAGE of the pull is in flight (the first family's page has landed, the second's is parked at the peer): the page in
 *   flight is cut, both families' records are gone when the act ends, the receive mark is absent, and no EXCHANGE write to the space's collections
 *   ended after the act's first delete (the act's own writes - learnt from the act run alone, `actOperationsOf` - are the act and do not count).
 * - **R-W4b** the same while a PUSH is in flight: the request is cut and no push mark is written past data that is about to go.
 * - **R-W4c** the same between FILES of a multi-file manifest: no file's bytes or row survive, and no file is requested after the act began.
 * - **R-X5a** the multi-file case again, for the transfer module's own answers: the turn stops before the next file, the download in flight is aborted,
 *   the fence answers `drained` (nothing left counted), and a SECOND space's delete completes meanwhile (the drain is outside the slot).
 * - **R-W4 (second exchange)** with the act STANDING (its first delete is held behind a real document lock), a second cycle makes no request for the
 *   space and still exchanges the space nothing holds (the twin).
 *
 * ## How it is driven
 *
 * The REAL engine against the pull door's fake peer, through `_stalling-peer-proxy.mjs`: the proxy parks ONE request (a latch the test releases), so the
 * receiver is in the middle of a unit when the act is started, and says whether the receiver cut it. The act is `wipeSpace`, the door every wipe goes
 * through, so nothing here depends on how the runner is spelled. A standing act is held by a REAL lock (`holdDocumentLock`) on a document its first
 * delete needs. Order is `_store-command-log.mjs`: the sequence number of the last write that ENDED against the first delete that STARTED.
 *
 * ## Seen red
 *
 * Against 84f0b3cc a wipe runs the moment it is asked: the parked page, push or file is neither cut nor waited for, so after the latch is released it
 * lands in the wiped space (R-W4a, R-W4c), the push mark is written past gone data (R-W4b), a download is requested after the act began, the in-flight
 * unit is never aborted, `space-transfer-fence.js` does not exist (R-X5a), and a second cycle exchanges the space whose wipe is still running. The twin
 * assertions (the carried space IS exchanged in the same cycle) are controls that pass on purpose.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-wipe-started-mid-exchange-follows-the-exchange-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, ADMIN_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { settleWithin, holdDocumentLock } from './_write-faults.mjs';
import { waitForLiveWrite } from './_active-operations.mjs';
import { startStallingPeerProxy } from './_stalling-peer-proxy.mjs';
import { openStoreCommandLog } from './_store-command-log.mjs';
import { resetRunnerForTest } from './_space-act-harness.mjs';
import { loadRunnerIfBuilt, requireFence, settleActs } from './_space-act-modules.mjs';
import { rowRules } from './_row-rules.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'midexch';
const FREE = 'midfree';
const OTHER = 'midother';
const T = { timeout: 180_000 };
/** What a test may wait for something that must happen: a bound for a failure message, never an ordering. */
const BOUND = 30_000;

let door, loader, lifecycle, proxy, cmd, families, dataParts;

const wipe = (space) => lifecycle.wipeSpace(space);
const ownAuthor = () => ({ instanceId: door.instanceId, instanceLabel: 'Receiver' });

const quiet = () => settleActs(door, loader);

/**
 * The operations the act body issues on `space`'s data collections, learnt from the same act run ALONE (nothing exchanging): its own writes
 * (the wipe's face unlabel on the files rows) are the act, not a write it raced, so the order rule leaves them out by WHAT they are - never
 * by when they ran. Every other write still counts.
 */
async function actOperationsOf(space) {
  cmd.reset();
  await wipe(space);
  await quiet();
  const ops = cmd.writeShapes(space, dataParts);
  cmd.reset();
  return ops;
}

/** Two families in the order the pull takes them, and a record of each on the peer: the first is on disk before the second is asked for. */
async function seedPeerPages() {
  for (const [key, make] of [['facts', build.fact], ['entities', build.entity]]) {
    await door.seedPeerRecords(S, key, [make(S, `peer-${key}-1`, 5, { author: PEER_AUTHOR })]);
  }
}

/** Park the cycle, start the wipe, and answer what happened: the shape every row below shares. */
async function wipeDuring(stall, { cycle, during, ready }) {
  const parked = await settleWithin(stall.reached, BOUND);
  assert.ok(parked.settled, 'fixture: the cycle never reached the unit the proxy parks, so the act was not started in the middle of anything');
  if (ready) await ready();
  cmd.reset();
  const since = proxy.requests.length;
  const wiping = wipe(S);
  const wiped = await settleWithin(wiping, BOUND);
  let extra; let extraError;
  if (during) { try { extra = await during(); } catch (err) { extraError = err; } }
  const cut = await settleWithin(stall.aborted, 5_000);
  stall.release();
  const cycled = await settleWithin(cycle, BOUND);
  await quiet();
  return { since, wiped, cut: cut.settled, cycled, extra, extraError };
}

describe('a wipe started in the middle of an exchange follows it', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'midexchange', spaces: [S, FREE], extraSpaces: [OTHER], type: 'club', direction: 'both', files: true, monitorCommands: true });
    loader = await import('../../server/dist/config/loader.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
    families = REPLICATED_FAMILIES.map(f => f.payloadKey);
    dataParts = [...new Set(REPLICATED_FAMILIES.map(f => f.collection))];
    assert.ok(families.indexOf('facts') >= 0 && families.indexOf('facts') < families.indexOf('entities'), 'fixture: the pull no longer takes facts before entities, so the page parked below is not the second');
    assert.ok(REPLICATED_FAMILIES.length >= 5 && dataParts.includes('files'), 'fixture: the derived family list is too short to stand for the replicated data');
    proxy = await startStallingPeerProxy(door.url);
    loader.mutateConfig((cfg) => { cfg.networks.find(n => n.id === door.NET).members[0].url = proxy.url; });
    cmd = openStoreCommandLog(door.mongo);
  });
  after(async () => {
    cmd?.stop();
    await proxy?.close();
    try { const runner = await loadRunnerIfBuilt(); if (runner) resetRunnerForTest(runner); } catch { /* best effort */ }
    await door?.close();
  });
  beforeEach(async () => {
    proxy.reset();
    await door.reset();
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.pendingRounds = []; net.spaces = [S, FREE]; net.merkle = false;
      delete cfg.pendingSpaceActs; delete cfg.pendingSpaceOp;
    });
    // the real page handler over the peer's own storage, as the cycles of the hold tests are served
    door.state.family = (req, res, family) => door.serveFamily(req, res, family);
    const runner = await loadRunnerIfBuilt();
    if (runner) resetRunnerForTest(runner);
    cmd.reset();
  });

  it('R-W4a: a wipe started while a PAGE of the pull is in flight cuts it, deletes after the exchange\'s last write, and nothing the pull moved survives', T, async () => {
    const actOperations = await actOperationsOf(S);
    await seedPeerPages();
    const stall = proxy.stallNext(r => r.method === 'GET' && r.path === '/api/sync/entities' && r.query.spaceId === S);
    const cycle = door.sync();
    // the first family's page must have LANDED before the second is parked, or there is nothing for the act to wait for or delete
    const out = await wipeDuring(stall, {
      cycle,
      ready: async () => assert.equal(await door.coll(S, 'facts').countDocuments({}), 1, 'fixture: the first family\'s page had not landed when the second was parked'),
    });
    assert.ok(proxy.requestsForSpace(FREE).length > 0, 'the twin failed: the space nothing holds was not exchanged in the same cycle, so the cycle died instead of stopping one turn');
    const rules = rowRules();
    rules.that(out.wiped.settled, 'the act did not complete while the page it interrupted was in flight: the unit in flight was neither cut nor waited for');
    for (const key of ['facts', 'entities']) {
      rules.that(await door.coll(S, key).countDocuments({}) === 0, `a ${key} record the exchange moved survived the wipe: the page in flight landed after the act deleted`);
    }
    rules.that(door.member().lastSeqReceived?.[S] === undefined, 'a receive mark was written for a space that was wiped under the pull');
    rules.that(cmd.firstDeleteStart(S, dataParts) >= 0, 'fixture: the act deleted nothing from the space\'s data collections, so no order was observed');
    rules.that(cmd.writesEndedAfterFirstDelete(S, dataParts, { actOperations }).length === 0, `an exchange write to the space ended after the act's first delete started: ${cmd.describe(S, dataParts)}`);
    rules.that(out.cut, 'the page in flight when the act began was not cut: the receiver kept waiting for the peer');
    rules.done();
  });

  it('R-W4b: a wipe started while a PUSH is in flight cuts it and no push mark is written past the data that is about to go', T, async () => {
    const put = await door.push('/batch-upsert', { facts: [build.fact(S, 'local-f1', 3, { author: ownAuthor() })] }, { spaceId: S, networkId: door.NET, token: ADMIN_TOKEN });
    assert.equal(put.code, 200, `fixture: the local record was not stored (${JSON.stringify(put.body)})`);
    const stall = proxy.stallNext(r => r.method === 'POST' && r.path === '/api/sync/batch-upsert' && r.query.spaceId === S);
    const cycle = door.sync();
    const out = await wipeDuring(stall, { cycle });
    assert.ok(proxy.requestsForSpace(FREE).length > 0, 'the twin failed: the space nothing holds was not exchanged in the same cycle');
    const rules = rowRules();
    rules.that(out.wiped.settled, 'the act did not complete while the push it interrupted was in flight');
    rules.that(await door.coll(S, 'facts').countDocuments({}) === 0, 'a record is left in the wiped space');
    rules.that(door.member().lastSeqPushed?.[S] === undefined, 'a push mark was written for a space that was wiped under the push: it now stands past data that no longer exists');
    rules.that(out.cut, 'the push in flight when the act began was not cut');
    rules.done();
  });

  /** The multi-file scenario of R-W4c and R-X5a: three files on the peer, the SECOND download parked, the act started then. */
  async function filesScenario(during) {
    for (const name of ['a.txt', 'b.txt', 'c.txt']) door.seedPeerFile(S, name, `bytes of ${name}`);
    // the manifest names the peer's side of the space, and that is the path a byte download carries
    const isDownload = (r) => r.method === 'GET' && r.path === `/api/files/${door.peerSide(S)}`;
    const stall = proxy.stallNext(isDownload, { skip: 1 });
    const cycle = door.sync();
    const out = await wipeDuring(stall, {
      cycle, during,
      ready: async () => {
        const first = proxy.requests.find(isDownload);
        assert.ok(door.localFileExists(S, first.query.path), `fixture: the first file (${first.query.path}) had not landed when the second was parked`);
      },
    });
    return { ...out, isDownload };
  }
  const anyFileLeft = async () => ['a.txt', 'b.txt', 'c.txt'].filter(n => door.localFileExists(S, n));

  it('R-W4c: a wipe started between FILES leaves no file of the exchange behind and no file is requested after the act began', T, async () => {
    const out = await filesScenario();
    assert.ok(proxy.requestsForSpace(FREE).length > 0, 'the twin failed: the space nothing holds was not exchanged in the same cycle');
    const rules = rowRules();
    rules.that(out.wiped.settled, 'the act did not complete while a file download was in flight');
    const left = await anyFileLeft();
    rules.that(left.length === 0, `a file the exchange was moving is on disk after the wipe (${left.join(', ')}): the download in flight landed after the act deleted, or the turn went on to the next file`);
    rules.that(await door.coll(S, 'files').countDocuments({}) === 0, 'a file row the exchange recorded survived the wipe');
    const after = proxy.requests.filter(r => r.n >= out.since && out.isDownload(r)).map(r => r.query.path);
    rules.that(after.length === 0, `the turn went on to request more files after the act began (${after.join(', ')}): it does not stop at its next unit`);
    rules.that(cmd.writesEndedAfterFirstDelete(S, dataParts).length === 0, `a write to the space ended after the act's first delete started: ${cmd.describe(S, dataParts)}`);
    rules.done();
  });

  it('R-X5a: the turn stops before the next file, the download in flight is aborted, the fence says drained, and another space\'s delete completes meanwhile', T, async () => {
    const out = await filesScenario(async () => {
      const fence = await requireFence('the fence is what says a cut transfer is no longer counted');
      const drained = await fence.awaitSpaceTransfersDrained(S, 10_000);
      const running = fence.spaceTransfersRunning(S);
      const other = await settleWithin(lifecycle.removeSpace(OTHER), BOUND);
      return { drained, running, other };
    });
    const rules = rowRules();
    rules.that(out.extraError === undefined, `the fence cannot be asked: ${out.extraError?.message}`);
    rules.that(out.cut, 'the download in flight when the act registered was not aborted');
    const after = proxy.requests.filter(r => r.n >= out.since && out.isDownload(r)).map(r => r.query.path);
    rules.that(after.length === 0, `the turn requested another file after the act registered (${after.join(', ')})`);
    rules.that(out.extra?.drained === 'drained', `the drain answered ${JSON.stringify(out.extra?.drained)} for a transfer that was cut`);
    rules.that(out.extra?.running === 0, 'a transfer of the space is still counted after it was cut');
    rules.that(out.extra?.other?.settled === true && out.extra.other.ok === true, 'a second space\'s delete did not complete while the first space\'s act waited: the drain sits inside the instance-wide slot');
    rules.done();
  });

  it('R-W4 (second exchange): while the act stands no second exchange of the space is made, and the space nothing holds is still exchanged (twin)', T, async () => {
    const put = await door.push('/batch-upsert', { facts: [build.fact(S, 'locked-f', 3, { author: ownAuthor() })] }, { spaceId: S, networkId: door.NET, token: ADMIN_TOKEN });
    assert.equal(put.code, 200, `fixture: the record the lock is held on was not stored (${JSON.stringify(put.body)})`);
    // The act's first delete needs this document, so the act STANDS - registered, begun, unable to finish - for as long as the lock is held.
    const lock = await holdDocumentLock(door.mongo, `${S}_facts`, { filter: { _id: 'locked-f' } });
    let wiping; let released = false;
    try {
      wiping = wipe(S);
      wiping.catch(() => {});
      assert.ok(await waitForLiveWrite(door.mongo, `${S}_facts`), 'fixture: the act\'s delete never reached the store, so the act is not standing');
      const since = proxy.requests.length;
      await door.sync();
      const touched = proxy.requestsForSpace(S, since);
      assert.deepEqual(touched.map(r => `${r.method} ${r.path}`), [], 'a second exchange of the space was made while an act on it stood: its pre-wipe records and files can come back');
      assert.ok(proxy.requestsForSpace(FREE, since).length > 0, 'the twin failed: the space nothing holds was not exchanged either, so the absence above proves nothing');
      await lock.release(); released = true;
      const done = await settleWithin(wiping, BOUND);
      assert.ok(done.settled, 'the act did not complete once the lock was released');
    } finally {
      if (!released) await lock.release();
      await quiet();
    }
  });
});
