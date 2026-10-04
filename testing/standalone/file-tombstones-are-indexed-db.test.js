/**
 * The questions asked of a space's file tombstones on every move and every sweep are answered from an index, on a new
 * space and on one that already exists (bundle-30 I16, preship-4 P4-6).
 *
 * ## The finding
 *
 * `<space>_file_tombstones` had no index but `_id`, while I15 began asking it two questions as routine work:
 *
 *     settleStalePendingFileTombstones  { pending: true, deletedAt <= t }  sort { deletedAt: 1 }   per space, every TTL cycle
 *     moveWasBegun / forgetFinishedMove { 'move.from': a, 'move.to': b }                          per move
 *
 * and I17 a third, every time a tombstone is published (verify-drive-5 F1):
 *
 *     one tombstone per path            { path: { $in: paths } }                                     per publish
 *
 * Each was a collection scan. And the collection is not small on the instances where it matters: a space with an
 * offline peer never prunes it, because a prune needs every peer's acknowledgement.
 *
 * ## What is asserted
 *
 * - Space initialisation creates both indexes, and the boot pass that covers spaces initialisation never revisits
 *   (`ensureQueryIndexes`) creates them on a space whose collection has none.
 * - MongoDB's winning plan for each REAL query uses them — an index the planner does not choose is decoration — and the
 *   same queries scan without them, which is the control that makes the first assertion mean something.
 *
 * Run: node --test testing/standalone/file-tombstones-are-indexed-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';

const skip = await mongoSkipReason();
const S = 'tombidx';

let door, coll;

/** Every stage name in a winning plan, flattened. */
function planStages(explain) {
  const names = [];
  (function walk(node) {
    if (!node || typeof node !== 'object') return;
    if (typeof node.stage === 'string') names.push(node.stage);
    for (const v of Object.values(node)) {
      if (Array.isArray(v)) v.forEach(walk); else if (v && typeof v === 'object') walk(v);
    }
  })(explain?.queryPlanner?.winningPlan ?? {});
  return names;
}
const keysOf = async () => (await coll.listIndexes().toArray()).map(ix => Object.keys(ix.key).join(',')).filter(k => k !== '_id');
const WANTED = ['pending,deletedAt', 'move.from,move.to', 'path'];

/** The two questions, as the module asks them. */
const settleQuery = () => coll.find({ pending: true, deletedAt: { $lte: new Date().toISOString() } }).sort({ deletedAt: 1 }).limit(500);
const markerQuery = () => coll.find({ 'move.from': 'a.txt', 'move.to': 'b.txt' });
const pathQuery = () => coll.find({ path: { $in: ['x.txt', 'a.txt'] } });
const QUESTIONS = [['settle', settleQuery], ['move marker', markerQuery], ['one per path', pathQuery]];

describe('file tombstones are indexed', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'tombidx', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    coll = door.coll(S, 'file_tombstones');
    // Enough published rows that a scan and an index plan differ, and a few of each kind the queries look for.
    const now = Date.now();
    await coll.insertMany(Array.from({ length: 200 }, (_, i) => ({ _id: `p${i}`, spaceId: S, path: `f${i}.txt`, deletedAt: new Date(now - i).toISOString() })));
    await coll.insertMany([
      { _id: 'pend', spaceId: S, path: 'x.txt', deletedAt: new Date(now - 3_600_000).toISOString(), pending: true },
      { _id: 'mark', spaceId: S, path: 'a.txt', deletedAt: new Date(now).toISOString(), move: { from: 'a.txt', to: 'b.txt' } },
    ]);
  });
  after(async () => { await door?.close(); });

  it('space initialisation creates each', async () => {
    const keys = await keysOf();
    for (const k of WANTED) assert.ok(keys.includes(k), `initSpace did not index ${k}: found ${keys.join(' | ') || 'none'}`);
  });

  it('the settle, the move\'s marker and the one-per-path question are answered from them', async () => {
    for (const [name, q] of QUESTIONS) {
      const stages = planStages(await q().explain('queryPlanner'));
      assert.ok(stages.includes('IXSCAN') && !stages.includes('COLLSCAN'), `${name}: ${stages.join(' > ')}`);
    }
    assert.deepEqual((await settleQuery().toArray()).map(t => t._id), ['pend'], 'the settle\'s question no longer finds its row');
    assert.deepEqual((await markerQuery().toArray()).map(t => t._id), ['mark'], 'the marker\'s question no longer finds its row');
    assert.deepEqual((await pathQuery().toArray()).map(t => t._id).sort(), ['mark', 'pend'], 'the one-per-path question no longer finds its rows');
  });

  it('without them the same questions scan — the control — and the boot pass puts them back on an existing space', async () => {
    await coll.dropIndexes();
    for (const [name, q] of QUESTIONS) {
      assert.ok(planStages(await q().explain('queryPlanner')).includes('COLLSCAN'), `${name}: an index answered it with none created`);
    }
    const { ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js');
    await ensureQueryIndexes();
    const keys = await keysOf();
    for (const k of WANTED) assert.ok(keys.includes(k), `the boot pass did not index ${k} on an existing space: found ${keys.join(' | ') || 'none'}`);
  });
});
