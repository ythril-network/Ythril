/**
 * The import's index of subjects holds its memory bound, stays compact per record whatever an address's length, and reads back equal from
 * disk (bundle-270 S5, plan question (b); the bound is memory since bundle-384, Q-983).
 *
 * ## The rule
 *
 * The index maps each subject of an import to its record kind, its id (minted by the instance or addressed in the file) and whether the record
 * is stored. It is the one structure the import keeps in memory for the whole file, so its size per record is what bounds the import: each entry
 * is charged to the import's memory meter (`import-memory.ts`) at what it costs, a minted id at `MINTED_ENTRY_BYTES`. It is measured here on the
 * live heap for 100 000 records, with ordinary addresses and with addresses of 1 000 characters, which a foreign file may well use: the size must
 * not grow with the address, so it stays within the minted charge. Past the room of its meter it refuses naming `RDF_IMPORT_MAX_MEMORY`; a record
 * set again is not a new one (`the-import-memory-charges-what-an-entry-costs.test.js` holds the charges). A resumed import reads back the ids it
 * minted, so a written index reads back equal, never reads a missing index as an empty one, and is not on disk in plain under a master secret.
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import {
  spoolModule, indexModule, tempFolder, cleanupFolders, bytesIn, iri, blank, refusalOf, assertBound,
} from './_rdf-import-spool-doors.mjs';
import { importOrFail } from '../_shared/import-or-fail.mjs';

after(cleanupFolders);

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const KINDS = ['entity', 'fact', 'chrono', 'edge', 'file'];
const memory = () => importOrFail('server/dist/rdf/import-memory.js', 'the import\'s memory room and what an entry costs (Q-983)');

function liveHeap() { gc(); gc(); return process.memoryUsage().heapUsed; }

async function bytesPerRecord(addressOf) {
  const { ImportIndex } = await indexModule();
  const { ImportMemoryMeter } = await memory();
  const { quadGroupKey } = await spoolModule();
  const before = liveHeap();
  const index = new ImportIndex({ meter: new ImportMemoryMeter(Number.MAX_SAFE_INTEGER) });
  for (let i = 0; i < 100_000; i += 1) index.set(quadGroupKey(iri(addressOf(i))), { kind: KINDS[i % 5], id: crypto.randomUUID(), stored: i % 2 === 0 });
  const per = (liveHeap() - before) / 100_000;
  assert.equal(index.size, 100_000);
  return per;
}

describe('the import index holds its bound', { timeout: 60_000 }, () => {
  it('stays within the minted charge per record for 100 000 records with ordinary addresses', async () => {
    const { MINTED_ENTRY_BYTES } = await memory();
    const per = await bytesPerRecord(i => `https://data.example.org/ld/space/entity/${crypto.randomUUID()}-${i}`);
    console.log(`index: ${per.toFixed(1)} bytes per record (ordinary addresses), charged ${MINTED_ENTRY_BYTES}`);
    assert.ok(per <= MINTED_ENTRY_BYTES, `the index takes ${per.toFixed(1)} bytes per record`);
  });

  it('stays within the minted charge per record when every address is 1 000 characters long', async () => {
    const { MINTED_ENTRY_BYTES } = await memory();
    const per = await bytesPerRecord(i => `https://foreign.example.org/${'p'.repeat(940)}/${String(i).padStart(12, '0')}`);
    console.log(`index: ${per.toFixed(1)} bytes per record (1 000-character addresses), charged ${MINTED_ENTRY_BYTES}`);
    assert.ok(per <= MINTED_ENTRY_BYTES, `the index takes ${per.toFixed(1)} bytes per record: it grows with the address`);
  });

  it('refuses one record past its room, naming the memory bound; setting a held record again is not a new record', async () => {
    const { ImportIndex } = await indexModule();
    const { ImportMemoryMeter, indexEntryBytes } = await memory();
    const room = 5 * indexEntryBytes('id0');
    const index = new ImportIndex({ meter: new ImportMemoryMeter(room) });
    for (let i = 0; i < 5; i += 1) index.set(`k${i}`, { kind: 'entity', id: `id${i}`, stored: false });
    index.set('k2', { kind: 'entity', id: 'id2', stored: true });
    assert.equal(index.get('k2').stored, true);
    assert.throws(() => index.set('k5', { kind: 'fact', id: 'id5', stored: false }), (err) => { assertBound(err, 'RDF_IMPORT_MAX_MEMORY', room); return true; });
    assert.equal(index.size, 5);
    assert.equal(index.has('k5'), false, 'the refused record was kept');
  });

  it('answers each subject\'s kind, id and stored flag, apart for two subjects and absent for one never set', async () => {
    const { ImportIndex } = await indexModule();
    const { quadGroupKey } = await spoolModule();
    const index = new ImportIndex();
    const a = quadGroupKey(blank('in-x'));
    const b = quadGroupKey(blank('in-x'), iri('https://graphs.example.org/g'));
    index.set(a, { kind: 'entity', id: 'one', stored: true });
    index.set(b, { kind: 'chrono', id: 'two', stored: false });
    assert.deepEqual(index.get(a), { kind: 'entity', id: 'one', stored: true });
    assert.deepEqual(index.get(b), { kind: 'chrono', id: 'two', stored: false });
    assert.equal(index.get(quadGroupKey(blank('in-y'))), undefined);
    assert.throws(() => index.set('k', { kind: 'link', id: 'x', stored: false }), TypeError, 'a kind that is no record kind was taken');
    assert.throws(() => index.set('k', { kind: 'entity', id: '', stored: false }), TypeError, 'an empty id was taken');
  });

  it('a written index reads back equal; a missing index is no empty one', async () => {
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
    const empty = await openImportFolder(tempFolder('index-none'));
    await refusalOf(ImportIndex.read(empty), 'a folder with no index');
  });

  it('a read charges nothing: an index written under a larger room is read back whole under a meter of none (the read has no product caller)', async () => {
    const { ImportIndex } = await indexModule();
    const { ImportMemoryMeter } = await memory();
    const { openImportFolder } = await spoolModule();
    const folder = await openImportFolder(tempFolder('index-read-free'));
    const index = new ImportIndex({ meter: new ImportMemoryMeter(Number.MAX_SAFE_INTEGER) });
    for (let i = 0; i < 50; i += 1) index.set(`key${i}`, { kind: 'entity', id: crypto.randomUUID(), stored: false });
    await index.write(folder);
    const meter = new ImportMemoryMeter(1);
    const back = await ImportIndex.read(folder, { meter });
    assert.equal(back.size, 50);
    assert.equal(meter.used, 0, 'a read charged the meter');
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
