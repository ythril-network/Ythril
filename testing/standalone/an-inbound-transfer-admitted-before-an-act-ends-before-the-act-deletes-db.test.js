/**
 * An inbound transfer a peer made BEFORE an act registered is waited for (its unit in flight) or destroyed (its stream), never raced; a transfer held
 * open past its bound is destroyed by the server; and a drain that outlasts its bound is a state, not a failure (bundle-106 PR A, section 3.3a,
 * R-W4d, R-X5b, R-X5c).
 *
 * ## What was true before
 *
 * A peer's push was admitted by the door and then ran: the arrival writer wrote its pages while a wipe of the same space emptied it, so a record the
 * peer pushed before the wipe landed after it. A peer's file upload held a connection open with nothing bounding it on the server (a slow or hostile
 * sender kept a socket and a half-written upload for as long as it liked), and a wipe never knew the upload existed.
 *
 * ## What holds now
 *
 * - **R-W4d (records)** a push admitted before the act, whose write is in flight (parked behind a latch): the act does not delete while that write is in
 *   flight, a SECOND push of the space is refused `423 space_held` (never `409`) while the act stands, and after the latch is released nothing the push
 *   carried survives - the first delete follows the push's last write.
 * - **R-W4d (upload)** a file upload admitted before the act, stalled in its body: the act's registration DESTROYS the stream at once (the door listens on
 *   the transfer's signal), so the act does not wait for the upload's bound, and the bytes the sender would have sent after the act are not on disk.
 * - **R-X5b** an upload held open past `INBOUND_TRANSFER_MS` (the knob lowered) is destroyed by the SERVER, with no act at all, and the transfer is no
 *   longer counted.
 * - **R-X5c** a write unit latched past `EXCHANGE_DRAIN_MS` (the knob lowered): the act's entry reads `state: 'draining'`, `ythril_space_acts_waiting` is 1,
 *   `outcome="failed"` has not moved and no error line was logged; ANOTHER space's delete completes meanwhile (the wait is outside the slot); and once
 *   the latch is released the act completes and the gauge returns to 0.
 *
 * ## How it is driven
 *
 * The WHOLE chain: the real application (`createApp`) over a loopback socket and a real peer token, because the hold, the fence and the write path's
 * refusals live in the layers a handler called alone skips. A write unit is parked at the driver (`parkWrites`), the latch the test releases; an
 * upload is a raw request whose body the test sends in two halves. The act is `wipeSpace`. Order is `_store-command-log.mjs`.
 *
 * ## Seen red
 *
 * Against 84f0b3cc the act deletes at once and the parked push lands afterwards (R-W4d records: the record survives, the second push is answered 200); the
 * stalled upload is not destroyed by the act and lands after it (R-W4d upload); and the runner, its knobs and the fence do not exist (R-X5b, R-X5c).
 * The control (a peer push of a space nothing holds is stored, through this very chain) passes on purpose.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/an-inbound-transfer-admitted-before-an-act-ends-before-the-act-deletes-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { settleWithin, parkWrites } from './_write-faults.mjs';
import { openStoreCommandLog } from './_store-command-log.mjs';
import { resetRunnerForTest, entriesOf, metricSample } from './_space-act-harness.mjs';
import { loadRunnerIfBuilt, loadFenceIfBuilt, requireRunner, requireFence, settleActs } from './_space-act-modules.mjs';
import { rowRules } from './_row-rules.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'inbact';
const FREE = 'inbfree';
const OTHER = 'inbother';
const T = { timeout: 180_000 };
const BOUND = 30_000;

let door, loader, lifecycle, server, peerKey, parks, cmd, dataParts, logModule;

const wipe = (space) => lifecycle.wipeSpace(space);
const quiet = () => settleActs(door, loader);

/** A peer's push of one fact, through the whole chain. */
async function pushFact(space, id, seq) {
  const r = await fetch(`${server.url}/api/sync/batch-upsert?spaceId=${space}&networkId=${door.NET}`, {
    method: 'POST', headers: { Authorization: `Bearer ${peerKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ facts: [build.fact(space, id, seq, { author: PEER_AUTHOR })] }),
  });
  const text = await r.text();
  let body; try { body = JSON.parse(text); } catch { body = { raw: text }; }
  return { status: r.status, body };
}

/**
 * A peer's file upload whose body is sent in two halves: the first goes now, `finish()` sends the rest. `ended` resolves with what the server did to the
 * connection: `{ status }` when it answered, `{ error }` or `{ closed }` when it destroyed it.
 */
function stalledUpload(space, rel) {
  const body = Buffer.alloc(4096, 7);
  const req = http.request({
    host: '127.0.0.1', port: server.port, method: 'POST', path: `/api/files/${space}?path=${rel}`,
    headers: { Authorization: `Bearer ${peerKey}`, 'Content-Type': 'application/octet-stream', 'Content-Length': body.length },
  });
  const ended = new Promise((resolve) => {
    req.on('response', (res) => { res.resume(); resolve({ status: res.statusCode }); });
    req.on('error', (err) => resolve({ error: err.code ?? String(err) }));
    req.on('close', () => resolve({ closed: true }));
  });
  req.write(body.subarray(0, 512));
  return { ended, finish() { try { req.end(body.subarray(512)); } catch { /* the server destroyed it */ } } };
}

/** The upload has been ADMITTED by the door: the fence counts it (built), or the request has had its turns (not built). */
async function untilAdmitted(space) {
  const fence = await loadFenceIfBuilt();
  if (!fence) { for (let i = 0; i < 300; i++) await new Promise(resolve => setImmediate(resolve)); return; }
  assert.ok(await holdsWithin(() => fence.spaceTransfersRunning(space) >= 1, BOUND, 10, { what: `the upload counted as a transfer of ${space}` }),
    'fixture: the upload was never admitted by the door, so the act was not started in the middle of a transfer');
}

describe('an inbound transfer admitted before an act ends before the act deletes', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'inboundact', spaces: [S, FREE], extraSpaces: [OTHER], type: 'club', direction: 'both', files: true, monitorCommands: true });
    loader = await import('../../server/dist/config/loader.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
    dataParts = [...new Set(REPLICATED_FAMILIES.map(f => f.collection))];
    ({ log: logModule } = await import('../../server/dist/util/log.js'));
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({ name: 'peer', peerInstanceId: PEER, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: area, [FREE]: area } } })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
    parks = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
    cmd = openStoreCommandLog(door.mongo);
  });
  after(async () => {
    cmd?.stop();
    parks?.restore();
    await server?.close();
    try { const runner = await loadRunnerIfBuilt(); if (runner) resetRunnerForTest(runner); } catch { /* best effort */ }
    await door?.close();
  });
  beforeEach(async () => {
    await door.reset();
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.pendingRounds = []; net.spaces = [S, FREE];
      delete cfg.pendingSpaceActs; delete cfg.pendingSpaceOp;
    });
    const runner = await loadRunnerIfBuilt();
    if (runner) resetRunnerForTest(runner);
    cmd.reset();
  });

  it('control: through this chain a peer push of a space nothing holds is stored', T, async () => {
    const r = await pushFact(FREE, 'free-1', 7);
    assert.equal(r.status, 200, `the chain does not admit a peer push at all (${r.status} ${JSON.stringify(r.body)}), so no row below says anything about an act`);
    assert.equal(await door.coll(FREE, 'facts').countDocuments({ _id: 'free-1' }), 1, 'the push was answered 200 and stored nothing');
  });

  it('R-W4d (records): a push admitted before the act is waited for, a second push is refused 423 while the act stands, and nothing the push carried survives', T, async () => {
    const park = parks.arm(`${S}_facts`, { when: (method) => !/^delete/.test(method) });
    const first = pushFact(S, 'in-1', 7);
    first.catch(() => {});
    const reached = await settleWithin(park.reached, BOUND);
    assert.ok(reached.settled, 'fixture: the push never reached its write, so the act was not started in the middle of anything');
    cmd.reset();
    const wiping = wipe(S);
    wiping.catch(() => {});
    // The act cannot have deleted yet: the write it must follow is parked. A bound for the ABSENCE of an early finish, not an ordering.
    const early = await settleWithin(wiping, 1_500);
    const second = await pushFact(S, 'in-2', 8);
    park.release();
    const firstAnswer = await settleWithin(first, BOUND);
    const done = await settleWithin(wiping, BOUND);
    await quiet();

    const rules = rowRules();
    rules.that(early.settled === false, 'the act finished while a write admitted before it was still in flight: it does not wait for what it interrupted');
    rules.that(second.status === 423 && second.body?.code === 'space_held',
      `a second push of the space was answered ${second.status} ${JSON.stringify(second.body)} while the act stood (want 423 space_held, never 409)`);
    rules.that(firstAnswer.settled, 'the first push never answered once its write was released');
    rules.that(done.settled, 'the act did not complete once the write it waited for was released');
    rules.that(await door.coll(S, 'facts').countDocuments({}) === 0, 'a record the peer pushed survived the wipe: its write landed after the act deleted');
    rules.that(cmd.writesEndedAfterFirstDelete(S, dataParts).length === 0, `a write to the space ended after the act's first delete started: ${cmd.describe(S, dataParts)}`);
    rules.done();
  });

  it('R-W4d (upload): the act destroys an upload admitted before it at once, and the rest of its bytes are not on disk after the act', T, async () => {
    const upload = stalledUpload(S, 'up.bin');
    await untilAdmitted(S);
    const wiping = wipe(S);
    wiping.catch(() => {});
    const wiped = await settleWithin(wiping, BOUND);
    // destroyed by the act, long before the transfer bound (ten minutes) could have ended it
    const destroyed = await settleWithin(upload.ended, 5_000);
    upload.finish();
    const answered = await settleWithin(upload.ended, 10_000);
    await quiet();

    const rules = rowRules();
    rules.that(wiped.settled, 'the act did not complete while an upload was open: it waited for the sender instead of cutting the stream');
    rules.that(destroyed.settled && (destroyed.value?.error !== undefined || destroyed.value?.closed === true),
      `the act did not destroy the upload that was open when it registered (${JSON.stringify(destroyed.value)})`);
    rules.that(!door.localFileExists(S, 'up.bin'), 'the upload completed after the act: its bytes are on disk in the wiped space');
    rules.that(await door.coll(S, 'files').countDocuments({}) === 0, 'a file row for the upload exists in the wiped space');
    rules.that(answered.settled, 'the upload neither answered nor ended');
    rules.done();
  });

  it('R-X5b: an upload held open past INBOUND_TRANSFER_MS is destroyed by the server, and is no longer counted', T, async () => {
    const runner = await requireRunner('INBOUND_TRANSFER_MS is a knob of the runner module (section 2.5) and the bound the server puts on one inbound transfer');
    const fence = await requireFence('the fence counts the inbound transfer the bound ends');
    runner.setSpaceActKnobsForTest({ INBOUND_TRANSFER_MS: 100 });
    const upload = stalledUpload(S, 'held-open.bin');
    await untilAdmitted(S);
    const ended = await settleWithin(upload.ended, 10_000);
    const rules = rowRules();
    rules.that(ended.settled && (ended.value?.error !== undefined || ended.value?.closed === true),
      `the server never ended an upload held open past INBOUND_TRANSFER_MS (${JSON.stringify(ended.value)}): a sender keeps a socket and a half-written upload for as long as it likes`);
    rules.that(await holdsWithin(() => fence.spaceTransfersRunning(S) === 0, BOUND, 10, { what: 'the destroyed upload no longer counted' }), 'the transfer the bound destroyed is still counted: it would block every later act\'s drain');
    rules.done();
  });

  it('R-X5c: a write unit latched past EXCHANGE_DRAIN_MS leaves the act draining - not failed - while another space\'s delete completes, and the release completes it', T, async () => {
    const runner = await requireRunner('a drain that outlasts EXCHANGE_DRAIN_MS is the runner\'s state (section 2.5), not a failure');
    runner.setSpaceActKnobsForTest({ EXCHANGE_DRAIN_MS: 50 });
    const errorLines = [];
    const originalError = logModule.error;
    logModule.error = (...args) => { errorLines.push(args.join(' ')); };
    const failedBefore = await metricSample('ythril_space_acts_total', { kind: 'wipe', outcome: 'failed' });
    const park = parks.arm(`${S}_facts`, { when: (method) => !/^delete/.test(method) });
    let wiping; let other; let draining; let waiting; let failedDuring; let first;
    try {
      first = pushFact(S, 'drain-1', 7);
      first.catch(() => {});
      assert.ok((await settleWithin(park.reached, BOUND)).settled, 'fixture: the push never reached its write');
      wiping = wipe(S);
      wiping.catch(() => {});
      draining = await holdsWithin(() => entriesOf(loader).some(e => e.kind === 'wipe' && e.localId === S && e.state === 'draining'), BOUND, 10, { what: 'the act\'s entry reading draining' });
      waiting = await metricSample('ythril_space_acts_waiting');
      failedDuring = await metricSample('ythril_space_acts_total', { kind: 'wipe', outcome: 'failed' });
      other = await settleWithin(lifecycle.removeSpace(OTHER), BOUND);
    } finally {
      park.release();
      logModule.error = originalError;
    }
    const done = await settleWithin(wiping, BOUND);
    await settleWithin(first, BOUND);
    await quiet();

    const rules = rowRules();
    rules.that(draining === true, 'the entry never read state "draining" while a write unit it waits for was latched past EXCHANGE_DRAIN_MS');
    rules.that(waiting === 1, `ythril_space_acts_waiting was ${waiting} while one act waited for a drain (want 1)`);
    rules.that(failedDuring === failedBefore, 'outcome="failed" moved while the act was only waiting: a long drain is counted as a failure');
    rules.that(errorLines.filter(l => /wipe|space act|drain/i.test(l)).length === 0, `an error line was logged for an act that was only waiting: ${errorLines.join(' | ')}`);
    rules.that(other?.settled === true && other.ok === true, 'another space\'s delete did not complete while the first act was draining: the wait occupies the instance-wide slot');
    rules.that(done.settled, 'the act did not complete once the latched write was released');
    rules.that(entriesOf(loader).length === 0, 'an entry is left on the config after the act completed');
    rules.that(await metricSample('ythril_space_acts_waiting') === 0, 'the waiting gauge did not return to 0');
    rules.that(await door.coll(S, 'facts').countDocuments({}) === 0, 'a record survived the wipe');
    rules.done();
  });
});
