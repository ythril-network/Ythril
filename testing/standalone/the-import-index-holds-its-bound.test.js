/**
 * The import's index of subjects holds its record bound, stays compact per record whatever an address's length, and reads back equal from
 * disk (bundle-270 S5, plan question (b)).
 *
 * ## The rule
 *
 * The index maps each subject of an import to its record kind, its id (minted by the instance or addressed in the file) and whether the record
 * is stored. It is the one structure the import keeps in memory for the whole file, so its size per record is what bounds the import: the
 * plan's figure is about 200 bytes per record (1 000 000 records in about 200 MB). It is measured here on the live heap for 100 000 records,
 * with ordinary addresses and with addresses of 1 000 characters, which a foreign file may well use: the size must not grow with the address.
 * Over its record bound it refuses naming the bound; a record set again is not a new one. A resumed import reads back the ids it minted, so a
 * written index reads back equal, refuses to read past a smaller bound, never reads a missing index as an empty one, and is not on disk in
 * plain under a master secret.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import {
  spoolModule, indexModule, tempFolder, cleanupFolders, bytesIn, iri, blank, refusalOf, assertBound,
} from './_rdf-import-spool-doors.mjs';

after(cleanupFolders);

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const KINDS = ['entity', 'fact', 'chrono', 'edge', 'file'];
/** The plan's figure for one record of the index (question (b): ~200 B per record, 1 000 000 records ~200 MB). */
const BYTES_PER_RECORD = 200;

function liveHeap() { gc(); gc(); return process.memoryUsage().heapUsed; }

async function bytesPerRecord(addressOf) {
  const { ImportIndex } = await indexModule();
  const { subjectKey } = await spoolModule();
  const before = liveHeap();
  const index = new ImportIndex();
  for (let i = 0; i < 100_000; i += 1) index.set(subjectKey(iri(addressOf(i))), { kind: KINDS[i % 5], id: crypto.randomUUID(), stored: i % 2 === 0 });
  const per = (liveHeap() - before) / 100_000;
  assert.equal(index.size, 100_000);
  return per;
}

describe('the import index holds its bound', () => {
  it(`stays under ${BYTES_PER_RECORD} bytes per record for 100 000 records with ordinary addresses`, async () => {
    const per = await bytesPerRecord(i => `https://data.example.org/ld/space/entity/${crypto.randomUUID()}-${i}`);
    console.log(`index: ${per.toFixed(1)} bytes per record (ordinary addresses)`);
    assert.ok(per < BYTES_PER_RECORD, `the index takes ${per.toFixed(1)} bytes per record`);
  });

  it(`stays under ${BYTES_PER_RECORD} bytes per record when every address is 1 000 characters long`, async () => {
    const per = await bytesPerRecord(i => `https://foreign.example.org/${'p'.repeat(940)}/${String(i).padStart(12, '0')}`);
    console.log(`index: ${per.toFixed(1)} bytes per record (1 000-character addresses)`);
    assert.ok(per < BYTES_PER_RECORD, `the index takes ${per.toFixed(1)} bytes per record: it grows with the address`);
  });

  it('refuses one record over its bound, naming it; setting a held record again is not a new record', async () => {
    const { ImportIndex } = await indexModule();
    const index = new ImportIndex({ maxRecords: 5 });
    for (let i = 0; i < 5; i += 1) index.set(`k${i}`, { kind: 'entity', id: `id${i}`, stored: false });
    index.set('k2', { kind: 'entity', id: 'id2', stored: true });
    assert.equal(index.get('k2').stored, true);
    assert.throws(() => index.set('k5', { kind: 'fact', id: 'id5', stored: false }), (err) => { assertBound(err, 'RDF_IMPORT_MAX_RECORDS', 5); return true; });
    assert.equal(index.size, 5);
    assert.equal(index.has('k5'), false, 'the refused record was kept');
  });

  it('answers each subject\'s kind, id and stored flag, apart for two subjects and absent for one never set', async () => {
    const { ImportIndex } = await indexModule();
    const { subjectKey } = await spoolModule();
    const index = new ImportIndex();
    const a = subjectKey(blank('in-x'));
    const b = subjectKey(blank('in-x'), iri('https://graphs.example.org/g'));
    index.set(a, { kind: 'entity', id: 'one', stored: true });
    index.set(b, { kind: 'chrono', id: 'two', stored: false });
    assert.deepEqual(index.get(a), { kind: 'entity', id: 'one', stored: true });
    assert.deepEqual(index.get(b), { kind: 'chrono', id: 'two', stored: false });
    assert.equal(index.get(subjectKey(blank('in-y'))), undefined);
    assert.throws(() => index.set('k', { kind: 'link', id: 'x', stored: false }), TypeError, 'a kind that is no record kind was taken');
    assert.throws(() => index.set('k', { kind: 'entity', id: '', stored: false }), TypeError, 'an empty id was taken');
  });

  it('a written index reads back equal; read past a smaller bound it refuses; a missing index is no empty one', async () => {
    const { ImportIndex } = await indexModule();
    const { openImportFolder } = await spoolModule();
    const folder = await openImportFolder(tempFolder('index-io'));
    const index = new ImportIndex();
    const expected = new Map();
    for (let i = 0; i < 1000; i += 1) {
      const key = `key\t${i}\n${'é'.repeat(i % 3)}`;
      const record = { kind: KINDS[i % 5], id: i % 4 === 0 ? `addressed\t\n"${i}"\uD800` : crypto.randomUUID(), stored: i % 3 === 0 };
      index.set(key, record);
      expected.set(key, record);
    }
    await index.write(folder);
    const back = await ImportIndex.read(folder);
    assert.equal(back.size, expected.size);
    for (const [key, record] of expected) assert.deepEqual(back.get(key), record, `record ${JSON.stringify(key)} read back differently`);
    assertBound(await refusalOf(ImportIndex.read(folder, { maxRecords: 999 }), 'an index read past a smaller bound'), 'RDF_IMPORT_MAX_RECORDS', 999);
    const empty = await openImportFolder(tempFolder('index-none'));
    await refusalOf(ImportIndex.read(empty), 'a folder with no index');
  });

  it('with a master secret configured, the written index holds no id in plain and reads back', async () => {
    const before = process.env.YTHRIL_MASTER_KEY;
    process.env.YTHRIL_MASTER_KEY = 'c'.repeat(64);
    try {
      const { ImportIndex } = await indexModule();
      const { openImportFolder } = await spoolModule();
      const folder = await openImportFolder(tempFolder('index-secret'));
      const index = new ImportIndex();
      index.set('k', { kind: 'fact', id: 'an-id-nobody-may-read-on-disk', stored: true });
      await index.write(folder);
      assert.ok(!bytesIn(folder.dir).includes(Buffer.from('an-id-nobody-may-read-on-disk')), 'an id is on disk in plain under a master secret');
      assert.deepEqual((await ImportIndex.read(folder)).get('k'), { kind: 'fact', id: 'an-id-nobody-may-read-on-disk', stored: true });
    } finally {
      if (before === undefined) delete process.env.YTHRIL_MASTER_KEY; else process.env.YTHRIL_MASTER_KEY = before;
    }
  });
});
