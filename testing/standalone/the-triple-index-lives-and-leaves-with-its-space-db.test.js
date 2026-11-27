/**
 * The triple index is the space's own: it moves with a rename, goes with a delete, is never carried by a backup and is dropped by a
 * restore, and a space with RDF off has none (bundle-273, Q-764 slice S1; contract rows 1, 2 and 9).
 *
 * ## The rules
 *
 * 1. **A rename carries the index.** The collections are `SPACE_COLLECTIONS` suffixes (`rdf_terms`, `rdf_quads`, `rdf_records`,
 *    `rdf_state`, and the journal's `rdf_dirty`), so the rename's prefix move takes them, rows and all, and the old names are gone.
 * 2. **A delete takes the index.** No `<space>_rdf_*` collection outlives the space.
 * 3. **A backup leaves the index out, and a restore drops it.** The dump names no `rdf_*` collection (it is derived, and a restore rebuilds
 *    it); a restore drops the index collections the backup does not hold, so a missing index reads as not ready.
 * 4. **RDF off, no index.** A record written in a space with RDF off builds no index collection, while the same write in a space with RDF
 *    on does.
 *
 * ## Seen red
 *
 * On aae46da89 (no index): every case fails at its first read of the index ("no index collection was built"); rule 3's dump and restore
 * cases fail at the backup naming `rdf_quads` and at the restore keeping it.
 *
 * Run: a Mongo the harness accepts, npm run build:server, then
 *      node --test testing/standalone/the-triple-index-lives-and-leaves-with-its-space-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason, testMongoUri } from './_mongo-harness.mjs';
import { openSparqlDoors, rdfMeta } from './_sparql-doors.mjs';
import { indexCollections, indexedStatements } from './_triple-index.mjs';
import { buildIndexes } from './_triple-index-read.mjs';

const skip = await mongoSkipReason();
const SUITE = 'b273-tix-life';
const R = 'tix-move';
const MOVED = 'tix-moved';
const X = 'tix-drop';
const OFF = 'tix-off';
const ON = 'tix-on';
const STAMP = '2026-03-04T05:06:07.000Z';
// The journal's collection too: its indexes (review finding G5) are built when a rebuild swaps the index in, which makes it.
const INDEX = ['rdf_dirty', 'rdf_quads', 'rdf_records', 'rdf_state', 'rdf_terms'];
const TMP = process.env.TEMP ?? process.env.TMPDIR ?? '/tmp';

let d, stream, lifecycle, rename, dump, restore;
let tmpDir;

async function landed(space, id) {
  await stream.withLandingStamp(space, [stream.localRow(1)], async ([patch]) => {
    await d.col(d.spaceCollection(space, 'entities')).replaceOne({ _id: id },
      { _id: id, spaceId: space, name: id, type: 'thing', seq: 1, tags: [], createdAt: STAMP, updatedAt: STAMP, ...patch }, { upsert: true });
  }, 'test.landing');
}

describe('the triple index lives and leaves with its space', { skip }, () => {
  before(async () => {
    d = await openSparqlDoors({
      suite: SUITE,
      spaces: [{ id: R, meta: rdfMeta(R) }, { id: X, meta: rdfMeta(X) }, { id: ON, meta: rdfMeta(ON) },
        { id: OFF, meta: { suppressEmbeddings: true, validationMode: 'warn' } }],
    });
    stream = await import('../../server/dist/sync/record-position-stream.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    rename = await import('../../server/dist/spaces/rename.js');
    dump = await import('../../server/dist/db/dump.js');
    restore = await import('../../server/dist/db/restore.js');
    tmpDir = fs.mkdtempSync(path.join(TMP, 'b273-tix-life-'));
    // The follower makes no index of its own (pre-ship finding P2): a rebuild builds each RDF space's, as the upkeep does.
    await buildIndexes([R, X, ON]);
  });
  after(async () => {
    await d?.close();
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('a space with RDF off builds no index, the same write in a space with RDF on and a built index states in it', async () => {
    await landed(ON, 'on1');
    await landed(OFF, 'off1');
    assert.deepEqual(await indexCollections(d, ON), INDEX.map(s => `${ON}_${s}`), 'no index collection was built for the RDF space');
    assert.deepEqual(await indexCollections(d, OFF), [], 'a space with RDF off has no index');
  });

  it('a rename carries the index, rows and all', async () => {
    await landed(R, 'm1');
    const before = await indexedStatements(d, R, 'entity', 'm1');
    assert.ok(before?.length > 0, 'no index collection was built for the space');
    await rename.renameSpace(R, MOVED);
    assert.deepEqual(await indexCollections(d, R), [], 'the old names are gone');
    assert.deepEqual(await indexCollections(d, MOVED), INDEX.map(s => `${MOVED}_${s}`), 'the index moved under the new name');
    assert.equal(await d.col(`${MOVED}_rdf_records`).countDocuments({ _id: 'entity:m1' }), 1, 'with its record rows');
  });

  it('a delete takes the index', async () => {
    await landed(X, 'x1');
    assert.equal((await indexCollections(d, X)).length, INDEX.length, 'no index collection was built for the space');
    assert.equal(await lifecycle.removeSpace(X), true, 'the delete did not complete');
    assert.deepEqual(await indexCollections(d, X), [], 'no index collection outlives its space');
  });

  it('a backup leaves the index out, and a restore drops it', async () => {
    await landed(ON, 'on2');
    assert.equal((await indexCollections(d, ON)).length, INDEX.length, 'no index collection was built for the space');
    const dest = path.join(tmpDir, 'dump');
    const manifest = await dump.dumpDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);
    const names = manifest.collections.map(c => c.name);
    assert.ok(names.includes(`${ON}_entities`), `the backup still carries the records: ${names.join(', ')}`);
    assert.deepEqual(names.filter(n => n.includes('_rdf_')), [], 'the backup carries no index collection');
    await restore.restoreDatabase(testMongoUri(`ythril_harness_${SUITE}`), dest);
    assert.deepEqual(await indexCollections(d, ON), [], 'a restore drops the index the backup does not hold');
    assert.equal(await d.col(d.spaceCollection(ON, 'entities')).countDocuments({ _id: 'on2' }), 1, 'and restores the records');
  });
});
