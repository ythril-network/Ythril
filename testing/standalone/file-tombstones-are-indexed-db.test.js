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
 * - The served page and the push's pages (bundle-51, Q-96) read `{ positionAt > p }` in `(positionAt, _id)` order, every request of
 *   every peer every cycle: a fourth index serves it, partial on the stamp only a published tombstone carries, and the boot pass
 *   gives a tombstone stored before positions existed its local position.
 * - (bundle-71, Q-352) The settle's index is on `{ pending, settleAt }`, the clock the settle moves; the one it replaces
 *   (`{ pending, deletedAt }`) is dropped by the boot pass. The questions explained are the MODULE's own, read from its
 *   `FILE_TOMBSTONE_QUERIES` (settle, pending-by-path, capped page, prune page and whatever it adds), never copies written here.
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
// The settle reads `{ pending, settleAt }` (bundle-71, Q-352): the bump of a row it could not look at moves `settleAt`, never
// `deletedAt`, so the index the settle's question needs is on the clock it moves. The index it replaces is dropped by the boot pass.
const WANTED = ['pending,settleAt', 'move.from,move.to', 'path', 'positionAt,_id'];
const REPLACED = 'pending,deletedAt';

/**
 * The questions the MODULE asks, read from the module and not written here again (bundle-71, vet S6). A copy of a query in a
 * test is a copy of the question as its author imagined it, and a gate that explains the copy answers about the copy: the
 * settle's copy here scanned for the wrong reason the day the settle changed its clock, and the test said nothing about the
 * real query. `FILE_TOMBSTONE_QUERIES` is the one export that holds them: each value is a function of one sample bag
 * (`{ spaceId, now, before, paths, after, cap, upTo, limit }`) answering `{ filter, sort?, limit? }`, and the module runs
 * every one of its own reads through it.
 *
 * What the gate needs of it, by NAME (each is a question the plan names, and a rename is a re-anchor, said loudly): `settle`,
 * `pendingByPath`, `cappedPage` and `prunePage`. What it takes besides is whatever else the module exports — derived, with a
 * floor — so a fifth question added later is explained too.
 */
const REQUIRED_QUERIES = ['settle', 'pendingByPath', 'cappedPage', 'prunePage'];
let builders;
const sample = () => ({
  spaceId: S, now: new Date(), before: new Date(Date.now() - 600_000).toISOString(), paths: ['x.txt', 'a.txt'],
  after: { at: '' }, cap: new Date(Date.now() + 60_000).toISOString(), upTo: '9999-12-31T23:59:59.999Z', limit: 500,
});
/** A builder's answer, run as the module would run it. */
const run = (name) => {
  const q = builders[name](sample());
  let cursor = coll.find(q.filter);
  if (q.sort) cursor = cursor.sort(q.sort);
  if (q.limit) cursor = cursor.limit(q.limit);
  return cursor;
};

// The two questions the module's builders do not (yet) cover: a move's marker, and the stored read of a publish. Kept as copies,
// and said so: they are the only copies left here.
const markerQuery = () => coll.find({ 'move.from': 'a.txt', 'move.to': 'b.txt' });
const pathQuery = () => coll.find({ path: { $in: ['x.txt', 'a.txt'] } });
const questions = () => [...Object.keys(builders).map(n => [n, () => run(n)]), ['move marker', markerQuery], ['one per path', pathQuery]];

describe('file tombstones are indexed', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'tombidx', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    coll = door.coll(S, 'file_tombstones');
    builders = (await import('../../server/dist/files/tombstones.js')).FILE_TOMBSTONE_QUERIES ?? {};
    // Enough published rows that a scan and an index plan differ, and a few of each kind the queries look for.
    const now = Date.now();
    await coll.insertMany(Array.from({ length: 200 }, (_, i) => {
      const at = new Date(now - i).toISOString();
      return { _id: `p${i}`, spaceId: S, path: `f${i}.txt`, deletedAt: at, positionAt: at };
    }));
    await coll.insertMany([
      // A pending row as the module writes it: `writtenAt` (its position among this instance's writes) and `settleAt` (the clock the
      // settle selects and bumps by) both stand where `deletedAt` did.
      { _id: 'pend', spaceId: S, path: 'x.txt', deletedAt: new Date(now - 3_600_000).toISOString(), pending: true,
        writtenAt: new Date(now - 3_600_000).toISOString(), settleAt: new Date(now - 3_600_000).toISOString() },
      { _id: 'mark', spaceId: S, path: 'a.txt', deletedAt: new Date(now).toISOString(), move: { from: 'a.txt', to: 'b.txt' } },
      // A tombstone stored before positions existed: published, and with no `positionAt` — the boot pass gives it one.
      { _id: 'legacy', spaceId: S, path: 'legacy.txt', deletedAt: '2026-01-01T00:00:00.000Z' },
    ]);
  });
  after(async () => { await door?.close(); });

  it('space initialisation creates each', async () => {
    const keys = await keysOf();
    for (const k of WANTED) assert.ok(keys.includes(k), `initSpace did not index ${k}: found ${keys.join(' | ') || 'none'}`);
  });

  it('the module exports the questions it asks of the collection, by the names the plan gives them, and nothing in them is a copy kept here', () => {
    assert.ok(builders && typeof builders === 'object' && Object.keys(builders).length > 0,
      'files/tombstones.js exports no FILE_TOMBSTONE_QUERIES: this gate explains copies of its queries, and a copy that drifts answers about itself');
    for (const name of REQUIRED_QUERIES) assert.equal(typeof builders[name], 'function', `FILE_TOMBSTONE_QUERIES has no \`${name}\` builder`);
    for (const [name, b] of Object.entries(builders)) {
      assert.equal(typeof b, 'function', `FILE_TOMBSTONE_QUERIES.${name} is not a builder`);
      const q = b(sample());
      assert.ok(q && typeof q.filter === 'object', `FILE_TOMBSTONE_QUERIES.${name} answers no filter`);
    }
  });

  it('the settle, the pending-by-path read, the capped page, the prune page, the move\'s marker and the one-per-path question are answered from them', async () => {
    for (const [name, q] of questions()) {
      const stages = planStages(await q().explain('queryPlanner'));
      assert.ok(stages.includes('IXSCAN') && !stages.includes('COLLSCAN'), `${name}: ${stages.join(' > ')}`);
    }
    assert.deepEqual((await run('settle').toArray()).map(t => t._id), ['pend'], 'the settle\'s question no longer finds its row');
    assert.deepEqual((await run('pendingByPath').toArray()).map(t => t._id), ['pend'], 'the pending-by-path question finds more or less than the pending row');
    assert.deepEqual((await markerQuery().toArray()).map(t => t._id), ['mark'], 'the marker\'s question no longer finds its row');
    assert.deepEqual((await pathQuery().toArray()).map(t => t._id).sort(), ['mark', 'pend'], 'the one-per-path question no longer finds its rows');
    for (const name of ['cappedPage', 'prunePage']) {
      const rows = await run(name).toArray();
      assert.ok(rows.length > 0, `${name} finds nothing in a collection of published rows`);
      assert.ok(rows.every(t => t.pending === undefined), `${name} reads a pending tombstone: nothing that serves or prunes may`);
      assert.ok(rows.every(t => t._id.startsWith('p') && typeof t.positionAt === 'string' && t.positionAt < sample().cap), `${name} reads a row at or above the cap, or one with no position`);
    }
    const page = (await run('cappedPage').toArray()).map(t => [t.positionAt, t._id]);
    assert.deepEqual(page, [...page].sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0)),
      'the capped page is not in (position, id) order, which is what its cursor resumes from');
  });

  it('without them the same questions scan — the control — and the boot pass puts them back on an existing space', async () => {
    await coll.dropIndexes();
    for (const [name, q] of questions()) {
      assert.ok(planStages(await q().explain('queryPlanner')).includes('COLLSCAN'), `${name}: an index answered it with none created`);
    }
    const { ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js');
    await ensureQueryIndexes();
    const keys = await keysOf();
    for (const k of WANTED) assert.ok(keys.includes(k), `the boot pass did not index ${k} on an existing space: found ${keys.join(' | ') || 'none'}`);
  });

  it('the boot pass gives a tombstone stored before positions existed its local position, and never to a pending one', async () => {
    const { ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js');
    await ensureQueryIndexes();
    const legacy = await coll.findOne({ _id: 'legacy' });
    assert.equal(typeof legacy?.positionAt, 'string', 'a published tombstone with no position is invisible to the paged read and the push, which read `positionAt`');
    assert.ok(legacy.positionAt >= '2026-01-01T00:00:00.000Z', 'its position is not a local instant');
    assert.equal((await coll.findOne({ _id: 'pend' }))?.positionAt, undefined, 'a pending tombstone was given a position: it is published only once its act has happened');
  });

  it('the boot pass drops the index the settle no longer reads, on a space that was upgraded with it (local state: nothing to migrate but the index)', async () => {
    const { ensureQueryIndexes } = await import('../../server/dist/spaces/ensure-query-indexes.js');
    await coll.createIndex({ pending: 1, deletedAt: 1 }, { partialFilterExpression: { pending: { $exists: true } } });
    assert.ok((await keysOf()).includes(REPLACED), 'the old index was not created — the case is not reached');
    await ensureQueryIndexes();
    const keys = await keysOf();
    assert.ok(!keys.includes(REPLACED), `the replaced index ${REPLACED} is still maintained on every pending write: ${keys.join(' | ')}`);
    for (const k of WANTED) assert.ok(keys.includes(k), `the boot pass did not keep ${k}: ${keys.join(' | ')}`);
  });
});
