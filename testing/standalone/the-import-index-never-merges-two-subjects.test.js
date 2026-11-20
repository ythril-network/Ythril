/**
 * The import's index never lets one subject overwrite another, and its record bound is the door's subject bound (bundle-270 review U4, U7).
 *
 * ## U7: a digest collision
 *
 * The index holds a subject by a 128-bit digest of its key, not by the key, so two subjects of one digest were one entry and `set` overwrote
 * the first silently: two records of the file would have become one, with no error. The digest of a hostile file's subjects is out of any
 * caller's control, so the index keeps a second, independent check of each key beside the entry and refuses a `set` whose digest is held by
 * another key (and answers no `get` for a key that is not the one held). The collision is forced through the index's test seam
 * (`lookupDigest`, never set outside a test), which makes two keys share a lookup digest.
 *
 * ## U4: the record bound after the door's subject bound
 *
 * The door lets a file in by its subject bound (`RDF_IMPORT_MAX_SUBJECTS`), and the index refuses past its record bound
 * (`RDF_IMPORT_MAX_RECORDS`); an asserted triple no reifier names is an edge the index also holds (under its triplet key), so a file within the
 * subject bound can still reach the record bound, and then the refusal is the index's, by name, as the door's 413 (the same error class). The
 * subject bound may never be above the record bound, or a file of subjects alone would be let in and refused.
 *
 * Run: node --test testing/standalone/the-import-index-never-merges-two-subjects.test.js (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { indexModule, spoolModule, refusalOf, assertBound } from './_rdf-import-spool-doors.mjs';

const ENTITY = (id) => ({ kind: 'entity', id, stored: false });
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

describe('two subjects of one digest are never one entry', () => {
  // A lookup digest is 16 bytes (a latin1 string of 16 characters), as the written index spells it.
  const collide = (key) => (key.startsWith('same:') ? '0123456789abcdef' : Buffer.from(key.padEnd(16, '.').slice(0, 16), 'latin1').toString('latin1'));

  it('setting a second key of a held digest is refused, and the first entry is unchanged', async () => {
    const { ImportIndex } = await indexModule();
    const index = new ImportIndex({ lookupDigest: collide });
    index.set('same:first', ENTITY(A));
    const err = await refusalOf(Promise.resolve().then(() => index.set('same:second', ENTITY(B))), 'a second key of a held digest');
    assert.match(err.message, /digest/i);
    assert.deepEqual(index.get('same:first'), ENTITY(A), 'the first subject was overwritten');
    assert.equal(index.size, 1);
  });

  it('a key that is not the one held is never answered with the held entry', async () => {
    const { ImportIndex } = await indexModule();
    const index = new ImportIndex({ lookupDigest: collide });
    index.set('same:first', ENTITY(A));
    assert.equal(index.get('same:second'), undefined, 'a get of another key answered the first key\'s record');
    assert.equal(index.has('same:second'), false);
  });

  it('setting the same key again updates its entry (a subject is set again when its record is stored)', async () => {
    const { ImportIndex } = await indexModule();
    const index = new ImportIndex({ lookupDigest: collide });
    index.set('same:first', ENTITY(A));
    index.set('same:first', { ...ENTITY(A), stored: true });
    assert.equal(index.get('same:first')?.stored, true);
    assert.equal(index.size, 1);
  });

  it('a written index reads back with its checks: the collision is still refused after a resume', async () => {
    const { ImportIndex } = await indexModule();
    const { openImportFolder } = await spoolModule();
    const { tempFolder } = await import('./_rdf-import-spool-doors.mjs');
    const folder = await openImportFolder(tempFolder('collide'));
    const index = new ImportIndex({ lookupDigest: collide });
    index.set('same:first', ENTITY(A));
    await index.write(folder);
    const back = await ImportIndex.read(folder, { lookupDigest: collide });
    assert.deepEqual(back.get('same:first'), ENTITY(A));
    assert.equal(back.get('same:second'), undefined);
    await refusalOf(Promise.resolve().then(() => back.set('same:second', ENTITY(B))), 'a collision after a resume');
  });
});

describe('the door\'s subject bound and the index\'s record bound', () => {
  it('a file of subjects alone, at the door\'s bound, is never refused by the index: the subject bound is not above the record bound', async () => {
    const { DEFAULT_IMPORT_SPOOL_BOUNDS } = await spoolModule();
    const { RDF_IMPORT_MAX_RECORDS } = await indexModule();
    assert.ok(DEFAULT_IMPORT_SPOOL_BOUNDS.maxSubjects <= RDF_IMPORT_MAX_RECORDS,
      `the door lets ${DEFAULT_IMPORT_SPOOL_BOUNDS.maxSubjects} subjects in and the index refuses past ${RDF_IMPORT_MAX_RECORDS} records`);
  });

  it('a minted edge (its triplet key) counts as a record: subjects at the bound plus one edge reach the record bound, refused by name', async () => {
    const { ImportIndex } = await indexModule();
    const index = new ImportIndex({ maxRecords: 5 });
    for (let k = 0; k < 5; k += 1) index.set(`subject:${k}`, ENTITY(`00000000-0000-4000-8000-00000000000${k}`));
    assertBound(await refusalOf(Promise.resolve().then(() => index.set('triplet:a knows b', { kind: 'edge', id: B, stored: false })), 'an edge past the record bound'),
      'RDF_IMPORT_MAX_RECORDS', 5);
  });
});
