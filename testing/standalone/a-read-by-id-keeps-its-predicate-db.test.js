/**
 * PIN (Q-211, P5): a by-id read keeps its predicate and its projection when it moves onto the one reader.
 *
 * ## Why this is a characterization, and green on the base
 *
 * Q-211 moves the hand-written `_id: { $in }` reads onto `readStoredById`. The reads with a PREDICATE beside the
 * ids are the ones a move can change without anyone noticing: a `spaceId` or a class `scope` dropped in the move
 * returns a record from the wrong space, or a file's chunks as if they were files, and every caller still gets an
 * array. A projection changed in the move returns a vector to a caller that never asked for one. So the rows these
 * reads answer today are pinned here, row by row and field by field, and must still be the answer after the move.
 *
 * Over MORE ids than one reader chunk (`READ_CHUNK`, 500), so a reader that chunks must still return the union of
 * its chunks — a reader that returned only the last chunk passes any test that hands it ten ids.
 *
 * Sites (the converted reads that carry a predicate):
 * - `link-adjacency.ts` `docsFromCollection` (class scope + an `extra` narrowing + a projection override) and
 *   `scopedDocs` (class scope + class projection);
 * - `edge-endpoint-names.ts` `neighbourNodes` (`spaceId: mid` beside the ids);
 * - `entities.ts` `findEntitiesByIds` (`spaceId`, repeated ids, never-returned projection);
 * - `walk-reads.ts` `readRecordsById` (`extra` scope, never-returned projection, a deadline).
 *
 * Order is NOT pinned: these reads return the database's order and their callers impose their own. Rows are compared
 * as sets keyed by `_id`, with every field.
 *
 * Run: node --test testing/standalone/a-read-by-id-keeps-its-predicate-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-read-by-id-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const S = 'byid';
const OTHER = 'byidother';
/** More ids than one chunk of the reader, so a chunked reader must union its chunks. */
const N = 1_234;
const id = (p, n) => `${p}-${String(n).padStart(4, '0')}`;
const VEC = [0.25, 0.5, 0.75];

let mongo, adjacency, endpointNames, entities, walkReads, READ_CHUNK, NEVER_RETURNED_FIELDS;

/** Every third entity is stored in this space's collection under ANOTHER space's id: the `spaceId` predicate's job. */
const ENTITIES = Array.from({ length: N }, (_, i) => ({
  _id: id('ent', i), spaceId: i % 3 === 0 ? OTHER : S, name: `entity ${i}`, type: i % 2 ? 'person' : 'place',
  tags: [`t${i % 5}`], seq: i + 1, embedding: VEC, embeddingModel: 'm', matchedText: `entity ${i}`,
}));
/** Every second file row is a CHUNK of the file before it: the class scope's job. */
const FILES = Array.from({ length: N }, (_, i) => (i % 2 === 0
  ? { _id: id('file', i), spaceId: S, path: `docs/f${i}.md`, description: `file ${i}`, tags: ['doc'], sizeBytes: i, embedding: VEC }
  : { _id: id('file', i), spaceId: S, path: `docs/f${i - 1}.md#chunk`, parentFileId: id('file', i - 1), tags: [], sizeBytes: 1, embedding: VEC }));
/** Every fourth fact is attributed: the `extra` narrowing's job. */
const FACTS = Array.from({ length: N }, (_, i) => ({
  _id: id('fact', i), spaceId: i % 7 === 0 ? OTHER : S, fact: `fact ${i}`, type: '', tags: [],
  properties: { attributed: i % 4 === 0 }, seq: i + 1, embedding: VEC, embeddingModel: 'm',
}));

/** The ids asked for: every seeded id, ones that do not exist, and repeats. */
const asked = (rows) => [...rows.map(r => r._id), 'missing-1', 'missing-2', rows[5]._id, rows[700]._id];

const pick = (doc, fields) => Object.fromEntries(['_id', ...fields].filter(f => f in doc).map(f => [f, doc[f]]));
const without = (doc, fields) => Object.fromEntries(Object.entries(doc).filter(([k]) => !fields.includes(k)));
const byId = (rows) => [...rows].map(r => ({ ...r })).sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));

describe('PIN: a by-id read keeps its predicate and projection (Q-211 characterization)', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('read-by-id-keeps-its-predicate');
    adjacency = await import('../../server/dist/brain/link-adjacency.js');
    endpointNames = await import('../../server/dist/brain/edge-endpoint-names.js');
    entities = await import('../../server/dist/brain/entities.js');
    walkReads = await import('../../server/dist/brain/walk-reads.js');
    ({ READ_CHUNK } = await import('../../server/dist/db/read-by-id.js'));
    ({ NEVER_RETURNED_FIELDS } = await import('../../server/dist/brain/recall-shape.js'));
    assert.ok(N > 2 * READ_CHUNK, `the fixture must cross more than two reader chunks (${READ_CHUNK})`);
    await mongo.col(`${S}_entities`).insertMany(ENTITIES.map(d => ({ ...d })));
    await mongo.col(`${S}_files`).insertMany(FILES.map(d => ({ ...d })));
    await mongo.col(`${S}_facts`).insertMany(FACTS.map(d => ({ ...d })));
  });
  after(async () => {
    await closeTestMongo();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('findEntitiesByIds: only this space\'s entities, every field but the never-returned ones', async () => {
    const rows = await entities.findEntitiesByIds(S, asked(ENTITIES));
    const want = ENTITIES.filter(e => e.spaceId === S).map(e => without(e, NEVER_RETURNED_FIELDS));
    assert.deepEqual(byId(rows), byId(want));
    assert.ok(rows.every(r => !('embedding' in r)), 'a vector came back from findEntitiesByIds');
  });

  it('neighbourNodes: an entity under another space\'s id is not a neighbour; nodes keep their shape', async () => {
    const ids = asked(ENTITIES);
    const nodes = await endpointNames.neighbourNodes([S], ids, ids.map(() => undefined), 2);
    const want = ENTITIES.filter(e => e.spaceId === S).map(e => ({ _id: e._id, name: e.name, type: e.type, depth: 2 }));
    assert.deepEqual(byId([...nodes.values()]), byId(want));
    assert.deepEqual([...nodes.keys()].sort(), want.map(w => w._id).sort(), 'the map is keyed by the node id');
  });

  it('readRecordsById: the extra scope narrows the query, the never-returned fields stay home', async () => {
    const rows = await walkReads.readRecordsById(`${S}_facts`, asked(FACTS), { spaceId: S }, () => 30_000);
    const want = FACTS.filter(f => f.spaceId === S).map(f => without(f, NEVER_RETURNED_FIELDS));
    assert.deepEqual(byId(rows), byId(want));
  });

  it('readRecordsById: no extra reads every id that exists', async () => {
    const rows = await walkReads.readRecordsById(`${S}_facts`, asked(FACTS));
    assert.deepEqual(byId(rows), byId(FACTS.map(f => without(f, NEVER_RETURNED_FIELDS))));
  });

  it('docsFromCollection: files without their chunks, in the collection\'s union projection', async () => {
    const rows = await adjacency.docsFromCollection(S, 'files', asked(FILES));
    const fields = Object.keys(adjacency.projectionForCollection('files'));
    const want = FILES.filter(f => !('parentFileId' in f)).map(f => pick(f, fields));
    assert.deepEqual(byId(rows), byId(want));
  });

  it('docsFromCollection: a projection override and an extra narrowing both reach the query', async () => {
    const rows = await adjacency.docsFromCollection(S, 'facts', asked(FACTS), { _id: 1 }, { 'properties.attributed': true });
    const want = FACTS.filter(f => f.properties.attributed).map(f => ({ _id: f._id }));
    assert.deepEqual(byId(rows), byId(want));
  });

  it('scopedDocs: a file class admits files, never chunks, in the class projection', async () => {
    const cls = adjacency.LINK_CLASSES.find(c => c.collection === 'files');
    assert.ok(cls, 'no link class reads the files collection');
    const rows = await adjacency.scopedDocs(S, cls, asked(FILES));
    const want = FILES.filter(f => !('parentFileId' in f)).map(f => pick(f, Object.keys(cls.projection)));
    assert.deepEqual(byId(rows), byId(want));
  });

  it('scopedDocs: a class with no scope admits every id that exists, in its projection', async () => {
    const cls = adjacency.LINK_CLASSES.find(c => c.collection === 'facts');
    assert.ok(cls, 'no link class reads the facts collection');
    const rows = await adjacency.scopedDocs(S, cls, asked(FACTS));
    assert.deepEqual(byId(rows), byId(FACTS.map(f => pick(f, Object.keys(cls.projection)))));
  });
});
