/**
 * Two removers of marker rows running together never drop both rows of a move that is still owed (bundle-44, preship).
 *
 * ## The defect
 *
 * A move that is still owed must keep its marker on at least one row (`removeUnlessOwed`, `files/move-markers.ts`): the marker is the
 * only record that tells a retry "this is a move I began". The function read whether another row of the move SURVIVED, and then deleted
 * its own, as two steps with nothing between them and the other removers. Two removers (the prune after an acknowledgement,
 * `supersedeFileTombstones`, a drop of pending rows) running at once could each read the OTHER's row as the survivor and each delete
 * its own, and the move lost its marker while its records were still at the source: nothing would ever finish it.
 *
 * ## What is asserted
 *
 * Two `supersedeFileTombstones` calls over two rows of one owed move, with the first delete held back long enough for both to have read
 * their survivor: one row is still there afterwards, whichever order they ran in. The control: a move that is no longer owed loses both.
 *
 * Seen red against the two-step function: both rows gone.
 *
 * Run: node --test testing/standalone/two-removers-never-drop-an-owed-moves-last-marker-db.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';
import { driverWriteFailures, failWrites } from './_write-faults.mjs';
import { sleep } from '../_shared/sleep.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'markerrace';
const FILES = `${S}_files`;
/** Long enough for the other remover to have read its survivor while this one's delete is still pending. */
const DELETE_HELD_MS = 150;

let acts, tombstones, markerMod, F, faults, proto, realDeleteMany;

const markerRows = () => acts.door.coll(S, 'file_tombstones').find({ 'move.from': 'dm' }).toArray();

/** A DIRECTORY move a store failure stopped after its bytes: two files under it, each carrying the move's marker. */
async function owedDirectoryMove() {
  await acts.seed('dm/a.txt');
  await acts.seed('dm/b.txt');
  faults.fail('deleteMany', FILES, F.storeGone.single);
  const a = await acts.move('REST', 'dm', 'dn');
  assert.equal(acts.statusOf(a), 503, `the move was not stopped by the store: ${JSON.stringify(a.body)}`);
  assert.equal((await markerMod.moveMarkerOf(S, 'dm', 'dn')) !== undefined, true, 'the move left no marker — the case is not reached');
  // The rows are published at versions below the arrivals that supersede them.
  await acts.door.coll(S, 'file_tombstones').updateMany({ 'move.from': 'dm' }, { $set: { rowSeq: 1 }, $unset: { pending: '' } });
  const rows = await markerRows();
  assert.equal(rows.length >= 2, true, `the case needs two rows carrying the marker, found ${rows.length}`);
  return rows;
}

describe('two removers of marker rows never drop the last row of an owed move', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'markerrace', space: S });
    F = await driverWriteFailures('ythril_harness_markerrace');
    tombstones = await import('../../server/dist/files/tombstones.js');
    markerMod = await import('../../server/dist/files/move-markers.js');
    faults = failWrites(Object.getPrototypeOf(acts.door.mongo.col('probe')), ['insertMany', 'deleteMany']);
    proto = Object.getPrototypeOf(acts.door.mongo.col('probe'));
  });
  after(async () => { faults?.restore(); await acts?.close(); });
  beforeEach(async () => { faults.clear(); await acts.reset(); });
  afterEach(() => {
    faults.clear();
    if (realDeleteMany) { proto.deleteMany = realDeleteMany; realDeleteMany = undefined; }
  });

  /** Every delete from the tombstones collection is held back, so a concurrent remover reads its survivor before it lands. */
  function holdTombstoneDeletes() {
    realDeleteMany = proto.deleteMany;
    const real = realDeleteMany;
    proto.deleteMany = async function held(...args) {
      if (String(this.collectionName).endsWith('_file_tombstones')) await sleep(DELETE_HELD_MS);
      return real.apply(this, args);
    };
  }

  it('an owed move keeps a marker row when two removers each find the other\'s row surviving', async () => {
    const rows = await owedDirectoryMove();
    const paths = rows.map(r => r.path).sort();
    holdTombstoneDeletes();
    faults.clear();   // the stopping fault is spent; nothing else may fail
    await Promise.all(paths.slice(0, 2).map(p => tombstones.supersedeFileTombstones(S, [{ path: p, seq: 5 }])));
    proto.deleteMany = realDeleteMany; realDeleteMany = undefined;
    const left = await markerRows();
    assert.ok(left.length >= 1, 'both removers dropped the rows carrying the marker of a move that is still owed: nothing will ever finish it');
    assert.equal((await markerMod.moveMarkerOf(S, 'dm', 'dn')) !== undefined, true, 'the owed move lost its marker');
  });

  it('control: a move that is NOT owed loses every row', async () => {
    const rows = await owedDirectoryMove();
    const paths = rows.map(r => r.path).sort();
    // The records reach the destination: the move is over, whatever its marker says.
    const files = acts.door.coll(S, 'files');
    for (const p of ['dm/a.txt', 'dm/b.txt']) {
      const r = await files.findOne({ _id: p });
      if (r) { await files.deleteOne({ _id: p }); await files.insertOne({ ...r, _id: p.replace('dm/', 'dn/'), path: p.replace('dm/', 'dn/') }); }
    }
    await tombstones.supersedeFileTombstones(S, paths.map(p => ({ path: p, seq: 5 })));
    assert.deepEqual(await markerRows(), [], 'a finished move kept a marker row it no longer needs');
  });
});
