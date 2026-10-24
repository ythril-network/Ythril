/**
 * A space owes its positions until ONE write says it does not, and while it owes, the sync doors answer `503 positions_building`, which
 * a sender reads as HELD (bundle-81, design rev 8 §3 "The owed marker", "First carry", decision 6 and decision 7; §9 test 9).
 *
 * ## The defect it closes
 *
 * Rev 7 read "first carry" off the ABSENCE of `seqSeenBy6`, but every allocation writes it: a carry interrupted after its first landing
 * was never resumed and the space answered 503 for good, and a space created, renamed or restored at runtime had no path to readiness.
 * A sender that read the 503 as a failure counted the member unreachable for the length of every carry.
 *
 * ## The rules
 *
 * 1. **Doors.** Every sync door (batch-upsert, single POST, tombstone POST, record page, tombstone page) of a space that owes answers
 *    `503` with `code: 'positions_building'`, and stores nothing.
 * 2. **Senders.** A peer that answers `503 positions_building` is HELD, not failed: on the pull leg and on the push leg the mark is
 *    exactly its SENTINEL (not NaN) and the member's failure count does not move. Its positive control: the same cycle against a
 *    peer that answers normally moves the mark.
 * 3. **A landing during the carry keeps its clock position.** The carry's backfill writes only rows that have no position, so a row that
 *    landed while it was parked (a `_write-faults.mjs` park, not timing) keeps the position it was stamped with.
 * 4. **An interrupted carry still owes.** A write that fails after the first collection's rows were positioned leaves the marker, and the
 *    owed job finishes the carry (every row positioned, `positionsReadyAt` written, `positionsOwed` gone).
 * 5. **A failed `(pos,_id)` index build keeps the space owing**, and the job retries within a tick, not at the next boot.
 * 6. **A space created or renamed at runtime is ready before its act answers**; a pre-6.0 backup restored by the act has identity
 *    positions (`pos = posAtSeq = seq`) and `writtenHere` on every row before the act releases the space.
 *
 * ## What is not here, and why
 *
 * A space JOINED at runtime (`join-remote-act.ts`) needs an invite stack this harness does not stand up; its readiness is one call of
 * the same `owePositions` + inline work as rename and restore. It belongs to `testing/sync`'s join cases, and is reported as not covered.
 *
 * ## The state is specified, the pass is assumed
 *
 * A space owes while its counter document carries `positionsOwed` and is ready with `positionsReadyAt` and no `positionsOwed`
 * (`_b81b-owed.mjs`). The plan names the owed job and no function that runs one pass of it; the cases that run the job call
 * `positionsOwedTick` from `sync/positions-owed.js` through that one helper.
 *
 * ## Red at 9a7ab3f7
 *
 * Rule 1: base serves and stores (200). Rule 2: base counts a 503 as a failed transfer (the failure count moves, the turn throws).
 * Rules 3-5 fail on the missing module `sync/positions-owed.js`. Rule 6: base writes no `positionsReadyAt`, no `pos`, no `writtenHere`.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-space-owes-its-positions-until-one-write-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { parkWrites, failWrites } from './_write-faults.mjs';
import { failIndexBuild, storeIndexRefusal } from './_failing-index-build.mjs';
import { restoreModules, restoreToTheEnd, takeBackup } from './_restore-act.mjs';
import { openWireProxy } from './_b81b-wire.mjs';
import { clearPositionMarks, readMark, setMark, positioned, positionedTombstone } from './_b81b-positions.mjs';
import { counterDoc, isReady, oweDirectly, runOwedJob } from './_b81b-owed.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SUITE = 'b81tB_owed';
const SENTINEL = 3;
/** One space per case that reads readiness: the answer is cached in process, so a space nobody has asked about is a cold one. */
const SPACES = ['owedfact', 'owedsingle', 'owedtomb', 'owedpage', 'owedtpage', 'owedheld', 'owedcarry', 'owedbreak', 'owedindex', 'owedrename-a', 'owedrestore'];
const POS_INDEX = 'pos_1__id_1';

let door, proxy, proto, park, faults, indexFaults, SEQ_CARRYING, ME, engine;

/** One cycle of the whole network, as the scheduler runs it: the one that counts a member failure (`runSyncForPeer` does not). */
const networkCycle = async () => { await engine.runSyncForNetwork(door.NET); await door.settled(); };

/** A GET of a real sync handler as a peer reaches it, whatever it answers (the shared `pull` asserts a 200). */
async function getAnswer(routePath, query) {
  const req = { method: 'GET', query: { full: 'true', ...query }, params: {}, authToken: PEER_TOKEN, get: () => undefined };
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; }, setHeader() { return this; } };
  await door.handler('get', routePath)(req, res);
  return { code: res.code, body: res.body };
}

describe('a space owes its positions until one write', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: SUITE, spaces: SPACES, direction: 'both' });
    proxy = await openWireProxy(door.url, { mode: '6.0' });
    door.member().url = proxy.url;
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    ({ SEQ_CARRYING } = await import('../../server/dist/util/seq.js'));
    engine = await import('../../server/dist/sync/engine.js');
    ME = { instanceId: door.instanceId, instanceLabel: 'Receiver' };
  });
  after(async () => {
    indexFaults?.restore(); faults?.restore(); park?.restore();
    await proxy?.close(); await door?.close();
  });
  beforeEach(async () => {
    indexFaults?.restore(); faults?.restore(); park?.restore();
    park = parkWrites(proto);
    faults = failWrites(proto, ['updateMany', 'bulkWrite']);
    indexFaults = failIndexBuild(proto);
    clearPositionMarks(door);
    door.state.family = door.serveFamily;
  });

  describe('the sync doors answer 503 positions_building and store nothing', () => {
    const DOORS = [
      { name: 'batch-upsert', space: 'owedfact', call: (s) => door.push('/batch-upsert', { facts: [build.fact(s, 'owed-b', 5, { author: PEER_AUTHOR })] }, { spaceId: s }) },
      { name: 'single POST', space: 'owedsingle', call: (s) => door.push('/facts', build.fact(s, 'owed-s', 5, { author: PEER_AUTHOR }), { spaceId: s }) },
      { name: 'tombstone POST', space: 'owedtomb', call: (s) => door.push('/tombstones', { tombstones: [build.tombstone(s, 'owed-t', 'fact', 5)] }, { spaceId: s }) },
      { name: 'record page', space: 'owedpage', call: (s) => getAnswer('/facts', { spaceId: s, afterPos: '0' }) },
      { name: 'tombstone page', space: 'owedtpage', call: (s) => getAnswer('/tombstones', { spaceId: s, afterPos: '0' }) },
    ];
    for (const d of DOORS) {
      it(d.name, async () => {
        await oweDirectly(door, d.space, 'carry');
        const answer = await d.call(d.space);
        assert.equal(answer.code, 503, `${d.name} of a space that owes its positions answered ${answer.code}: ${JSON.stringify(answer.body)}`);
        assert.equal(answer.body?.code, 'positions_building', `${d.name} answered 503 without the code a sender reads as held: ${JSON.stringify(answer.body)}`);
        for (const part of ['facts', 'tombstones']) assert.equal(await door.coll(d.space, part).countDocuments(), 0, `${d.name} stored a ${part} row in a space that owes its positions`);
      });
    }
  });

  describe('a sender reads 503 positions_building as held: no mark moves, no failure is counted', () => {
    const HELD = 'owedheld';
    const freshCycle = async (direction) => {
      await door.reset({ direction });
      clearPositionMarks(door);
      door.member().consecutiveFailures = 0;
      door.state.family = door.serveFamily;
    };
    const building = { status: 503, body: { error: 'positions are being built', code: 'positions_building' } };

    it('pull leg: a page answered 503 positions_building', async () => {
      await freshCycle('pull');
      setMark(door, 'received', HELD, SENTINEL);
      door.state.family = (_req, res) => { res.status(building.status).json(building.body); };
      await networkCycle();
      assert.ok(readMark(door, 'received', HELD) === SENTINEL, `lastPosReceived is ${String(readMark(door, 'received', HELD))}: a held answer moved the mark (it must stay exactly ${SENTINEL})`);
      assert.equal(door.member().consecutiveFailures ?? 0, 0, 'a peer that said positions_building was counted as a failed member: the sender reads that 503 as a failure');
    });

    it('push leg: a batch answered 503 positions_building', async () => {
      await freshCycle('push');
      await door.coll(HELD, 'facts').insertOne(positioned(build.fact(HELD, 'owed-held-f', 30, { author: ME }), { writtenHere: true }));
      await door.raiseVersionTo(HELD, 30);
      setMark(door, 'pushed', HELD, SENTINEL);
      door.state.batchUpsert = () => building;
      await networkCycle();
      assert.ok(readMark(door, 'pushed', HELD) === SENTINEL, `lastPosPushed is ${String(readMark(door, 'pushed', HELD))}: a held answer moved the mark`);
      assert.equal(door.member().consecutiveFailures ?? 0, 0, 'a peer that said positions_building was counted as a failed member');
    });

    it('control: the same push against a peer that answers normally moves the mark and sends the record', async () => {
      await freshCycle('push');
      await door.coll(HELD, 'facts').insertOne(positioned(build.fact(HELD, 'owed-held-f', 30, { author: ME }), { writtenHere: true }));
      await door.raiseVersionTo(HELD, 30);
      setMark(door, 'pushed', HELD, SENTINEL);
      await networkCycle();
      assert.deepEqual(door.state.pushedRecords.map(r => r._id), ['owed-held-f']);
      const mark = readMark(door, 'pushed', HELD);
      assert.ok(Number.isSafeInteger(mark) && mark > SENTINEL, `control: lastPosPushed is ${String(mark)} after a normal push`);
    });
  });

  describe('the carry', () => {
    /** Rows a 5.6 instance left: a seq and no position, no writtenHere, in every carrying collection. */
    async function legacyRows(space) {
      const rows = {
        facts: [1, 2, 3].map(s => build.fact(space, `${space}-f${s}`, s, { author: ME })),
        entities: [4].map(s => build.entity(space, `${space}-e${s}`, s, { author: ME })),
        edges: [5].map(s => build.edge(space, `${space}-g${s}`, s, { author: ME })),
        tombstones: [6].map(s => build.tombstone(space, `${space}-t${s}`, 'fact', s, { instanceId: door.instanceId })),
      };
      for (const [part, docs] of Object.entries(rows)) await door.coll(space, part).insertMany(docs.map(d => ({ ...d })));
      await door.raiseVersionTo(space, 6);
      return rows;
    }
    const noPosition = async (space) => {
      const left = [];
      for (const part of SEQ_CARRYING) for (const d of await door.coll(space, part).find({ pos: { $exists: false } }).toArray()) left.push(`${part}/${d._id}`);
      return left;
    };

    it('a row that landed while the carry was parked keeps its clock position, and the legacy rows get the identity band', async () => {
      const space = 'owedcarry';
      await legacyRows(space);
      await oweDirectly(door, space, 'carry');
      const landed = { ...build.fact(space, 'owed-landed', 7, { author: ME }), pos: Date.now() * 1000, posAtSeq: 7, writtenHere: true };
      const gate = park.arm(`${space}_facts`, { when: (m) => m === 'updateMany' || m === 'bulkWrite' });
      const running = runOwedJob();
      await gate.reached;
      await door.coll(space, 'facts').insertOne({ ...landed });
      gate.release();
      await running;
      const row = await door.coll(space, 'facts').findOne({ _id: landed._id });
      assert.equal(row.pos, landed.pos, 'the carry overwrote the position of a row that landed while it was parked');
      for (const s of [1, 2, 3]) {
        const legacy = await door.coll(space, 'facts').findOne({ _id: `${space}-f${s}` });
        assert.deepEqual({ pos: legacy.pos, posAtSeq: legacy.posAtSeq }, { pos: s, posAtSeq: s }, `legacy row f${s} did not get the identity band`);
      }
      assert.equal(await isReady(door, space), true, 'the carry ended and the space is not ready');
    });

    it('a carry that fails after the first collection\'s rows were positioned leaves the space owing, and the job finishes it', async () => {
      const space = 'owedbreak';
      await legacyRows(space);
      await oweDirectly(door, space, 'carry');
      // The first collections are positioned; the write for `edges` fails, as a store that stopped answering would.
      faults.fail('updateMany', `${space}_edges`, new Error('the store stopped answering'), { times: 1 });
      faults.fail('bulkWrite', `${space}_edges`, new Error('the store stopped answering'), { times: 1 });
      await runOwedJob().catch(() => {});
      const owing = await counterDoc(door, space);
      assert.equal(owing.positionsOwed, 'carry', 'an interrupted carry cleared the marker: nothing would resume it');
      assert.equal(owing.positionsReadyAt, undefined, 'an interrupted carry recorded readiness');
      faults.restore();
      await runOwedJob();
      assert.deepEqual(await noPosition(space), [], 'the owed job did not position every row of the interrupted carry');
      assert.equal(await isReady(door, space), true, 'the owed job finished the carry and the space is still not ready');
    });

    it('a failed (pos,_id) index build keeps the space owing, and the job retries it within a tick', async () => {
      const space = 'owedindex';
      await legacyRows(space);
      await oweDirectly(door, space, 'carry');
      indexFaults.fail(`${space}_facts`, POS_INDEX, await storeIndexRefusal(door.mongo.getDb()));
      await runOwedJob().catch(() => {});
      assert.ok(indexFaults.fired() > 0, 'the index fault never fired: the job did not build the (pos,_id) index, so this case proves nothing');
      assert.equal(await isReady(door, space), false, 'a space whose position index failed to build was recorded ready');
      assert.equal((await counterDoc(door, space)).positionsOwed, 'carry', 'a failed index build cleared the marker');
      indexFaults.clear();
      await runOwedJob();
      assert.equal(await isReady(door, space), true, 'the next tick did not retry the index and finish: only a reboot would');
      const names = (await door.coll(space, 'facts').indexes()).map(i => i.name);
      assert.ok(names.includes(POS_INDEX), `the retry left no ${POS_INDEX} index (${names.join(', ')})`);
    });
  });

  describe('a space created, renamed or restored at runtime is ready before its act answers', () => {
    it('created', async () => {
      const lifecycle = await import('../../server/dist/spaces/lifecycle.js');
      await lifecycle.createSpace({ id: 'owedcreate', label: 'owedcreate' }, { tokenId: null });
      assert.equal(await isReady(door, 'owedcreate'), true, `a space created at runtime is not ready: ${JSON.stringify(await counterDoc(door, 'owedcreate'))}`);
    });

    it('renamed (a space with rows)', async () => {
      const rename = await import('../../server/dist/spaces/rename.js');
      await door.coll('owedrename-a', 'facts').insertOne(positioned(build.fact('owedrename-a', 'owed-r1', 5, { author: ME }), { writtenHere: true }));
      await door.mongo.col('ythril_counters').updateOne({ _id: 'owedrename-a' }, { $set: { seq: 5, seqSeenBy6: 5, positionsReadyAt: new Date().toISOString() } }, { upsert: true });
      await rename.renameSpace('owedrename-a', 'owedrename-b');
      assert.equal(await isReady(door, 'owedrename-b'), true, `a renamed space is not ready: ${JSON.stringify(await counterDoc(door, 'owedrename-b'))}`);
    });

    it('restored from a pre-6.0 backup: identity positions and writtenHere before the act releases the space', async () => {
      const space = 'owedrestore';
      const own = build.fact(space, 'owed-own', 5, { author: ME });
      const relayed = build.fact(space, 'owed-relayed', 9, { author: PEER_AUTHOR, deliveredBy: PEER_AUTHOR.instanceId });
      await door.coll(space, 'facts').insertMany([own, relayed]);
      await door.raiseVersionTo(space, 9);
      const backup = await takeBackup(SUITE, 'b81tB-owed-backup');
      await door.wipe(space);
      await restoreToTheEnd(await restoreModules(), { backupId: backup.id });
      const rows = Object.fromEntries((await door.coll(space, 'facts').find({}).toArray()).map(d => [d._id, d]));
      assert.deepEqual(Object.keys(rows).sort(), ['owed-own', 'owed-relayed'], 'the restore did not bring the rows back');
      assert.deepEqual({ pos: rows['owed-own'].pos, posAtSeq: rows['owed-own'].posAtSeq }, { pos: 5, posAtSeq: 5 }, 'a restored pre-6.0 row has no identity position');
      assert.deepEqual({ pos: rows['owed-relayed'].pos, posAtSeq: rows['owed-relayed'].posAtSeq }, { pos: 9, posAtSeq: 9 }, 'a restored pre-6.0 row has no identity position');
      assert.equal(rows['owed-own'].writtenHere, true, 'a restored pre-6.0 row written here has no writtenHere: it would never be pushed on a mesh');
      assert.equal(rows['owed-relayed'].writtenHere, false, 'a restored pre-6.0 row a peer delivered was stamped writtenHere');
      assert.equal(await isReady(door, space), true, 'the restored space was released while it still owed its positions');
    });
  });
});
