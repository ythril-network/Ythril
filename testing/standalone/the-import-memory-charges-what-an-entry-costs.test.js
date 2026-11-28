/**
 * The memory an RDF import charges for one entry is what the entry costs on the heap, with stated headroom, and a held key is never charged twice
 * (bundle-384, Q-983, vet amendments S2 and G6).
 *
 * ## The rule
 *
 * The room one import has (`import-memory.ts`) is spent per entry of the import's index and of its two digest sets, so each charge must not be
 * below what the entry takes, or an import the room admits could outgrow it. A Map's table doubles when it is full, so an entry costs most just
 * after a doubling (the table is half empty) and least just before the next: the charge is pinned at both, for each kind of id the index holds
 * (a minted id as its 16 bytes, a short text id, a 1 000-character text id, a text id with characters above U+00FF: V8 holds an entry with a character
 * above U+00FF as a two-byte string, any other as one byte a character). The measured heap per entry is at most the charge (the headroom) and at
 * least 0.65 of it (a charge that is far above the cost refuses imports that fit).
 *
 * A key set again charges only the growth of its entry (a subject is set again when its record turns out stored), and the index, the sets and the
 * pass-two bare edges spend one meter.
 *
 * Run: node --test testing/standalone/the-import-memory-charges-what-an-entry-costs.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import v8 from 'node:v8';
import vm from 'node:vm';
import { importOrFail } from '../_shared/import-or-fail.mjs';

v8.setFlagsFromString('--expose-gc');
const gc = vm.runInNewContext('gc');
const memory = () => importOrFail('server/dist/rdf/import-memory.js', 'the import\'s memory room and what an entry costs (Q-983)');
const indexModule = () => importOrFail('server/dist/rdf/import-index.js', 'the import\'s index (Q-983)');
const countModule = () => importOrFail('server/dist/rdf/import-count.js', 'the import\'s digest sets (Q-983)');

/** A Map holds up to a power of two entries: the count just past one (a half-empty table, the dearest entry) and one near the next (the cheapest). */
const POWER = 2 ** 14;
const JUST_PAST = POWER + 1;
const NEAR_FULL = POWER - 64;
/**
 * The measured heap per entry may be this share of the charge at the least: a charge far above the cost refuses imports that fit. A charge that
 * covers an entry just after its Map doubled (a half-empty table) is about a third above what the same entry costs just before the next doubling.
 */
const AT_LEAST = 0.65;

const liveHeap = () => { gc(); gc(); return process.memoryUsage().heapUsed; };

const IDS = {
  'a minted id': () => crypto.randomUUID(),
  'a short text id': (i) => `rec-${i}`,
  'a 1 000-character text id': (i) => `${'p'.repeat(980)}${String(i).padStart(12, '0')}`,
  'a Latin-1 non-ASCII text id': (i) => `Übergröße-${i}`,
  'a text id with characters above U+00FF': (i) => `Übergröße-日本語-${i}`,
};

const keyOf = (i) => JSON.stringify([`http://www.example.org/instances/dataFromProducer${i % 997}/Product${i}`, '']);

describe('an index entry is charged what it costs on the heap', { timeout: 120_000 }, () => {
  for (const [what, idOf] of Object.entries(IDS)) {
    for (const [at, count] of [['just past a power of two', JUST_PAST], ['near full', NEAR_FULL]]) {
      it(`${what}, ${count} entries (${at}): the heap per entry is within the charge and at least ${AT_LEAST} of it`, async () => {
        const { ImportMemoryMeter, indexEntryBytes } = await memory();
        const { ImportIndex } = await indexModule();
        const meter = new ImportMemoryMeter(Number.MAX_SAFE_INTEGER);
        // The ids and keys are made as the index takes them and kept nowhere else: a UUID from crypto is a rope of its hex pieces (about 500 bytes) until
        // something flattens it, and a baseline taken with ropes alive would shrink when the index flattens them.
        const before = liveHeap();
        const index = new ImportIndex({ meter });
        let expected = 0;
        let charged = 0;
        for (let i = 0; i < count; i += 1) {
          const id = idOf(i);
          charged = indexEntryBytes(id);
          expected += charged;
          index.set(keyOf(i), { kind: 'entity', id, stored: false });
        }
        const perEntry = (liveHeap() - before) / count;
        console.log(`index, ${what}, ${count} entries: ${perEntry.toFixed(1)} B per entry, charged ${charged} B`);
        assert.equal(index.size, count);
        assert.ok(perEntry <= charged, `an entry takes ${perEntry.toFixed(1)} bytes and is charged ${charged}: an import could outgrow its room`);
        assert.ok(perEntry >= AT_LEAST * charged, `an entry takes ${perEntry.toFixed(1)} bytes and is charged ${charged}: the charge refuses imports that fit`);
        assert.equal(meter.used, expected, 'the index charged something other than the entries\' own charges');
      });
    }
  }

  it('the charge of a text id grows with its length at a byte a character, two when a character is above U+00FF, and a minted id costs the same whatever its digits', async () => {
    const { indexEntryBytes } = await memory();
    assert.equal(indexEntryBytes('a'.repeat(101)) - indexEntryBytes('a'.repeat(1)), 100, 'an ASCII text id is held one byte a character');
    assert.equal(indexEntryBytes('ü'.repeat(51)) - indexEntryBytes('ü'.repeat(1)), 50, 'a character up to U+00FF is held in one byte');
    assert.equal(indexEntryBytes('日'.repeat(101)) - indexEntryBytes('日'.repeat(1)), 200, 'a character above U+00FF is held in two');
    assert.equal(indexEntryBytes(`${'a'.repeat(99)}日`) - indexEntryBytes(`${'a'.repeat(99)}b`), 100, 'one wide character makes the whole entry a two-byte string');
    assert.equal(indexEntryBytes(crypto.randomUUID()), indexEntryBytes(crypto.randomUUID()));
    assert.ok(indexEntryBytes('a'.repeat(200)) > indexEntryBytes(crypto.randomUUID()), 'a long text id was charged less than a minted one');
  });
});

describe('a digest set entry is charged what it costs on the heap', { timeout: 120_000 }, () => {
  for (const [at, count] of [['just past a power of two', JUST_PAST], ['near full', NEAR_FULL]]) {
    it(`${count} entries (${at}): the heap per entry is within the charge and at least ${AT_LEAST} of it`, async () => {
      const { SET_ENTRY_BYTES } = await memory();
      const { DigestSet } = await countModule();
      const before = liveHeap();
      const set = new DigestSet();
      for (let i = 0; i < count; i += 1) set.add(JSON.stringify([`http://x.example/s${i}`, 'http://x.example/p', `http://x.example/o${i}`, '']));
      const perEntry = (liveHeap() - before) / count;
      console.log(`set, ${count} entries: ${perEntry.toFixed(1)} B per entry, charged ${SET_ENTRY_BYTES} B`);
      assert.equal(set.size, count);
      assert.ok(perEntry <= SET_ENTRY_BYTES, `an entry takes ${perEntry.toFixed(1)} bytes and is charged ${SET_ENTRY_BYTES}`);
      assert.ok(perEntry >= AT_LEAST * SET_ENTRY_BYTES, `an entry takes ${perEntry.toFixed(1)} bytes and is charged ${SET_ENTRY_BYTES}: too dear`);
    });
  }
});

describe('what the index, the sets and the bare edges charge, they charge once on one meter', () => {
  const A = '11111111-1111-4111-8111-111111111111';

  it('a key set again charges only the difference: the same entry nothing, a longer id its growth, a shorter one nothing', async () => {
    const { ImportMemoryMeter, indexEntryBytes } = await memory();
    const { ImportIndex } = await indexModule();
    const meter = new ImportMemoryMeter(Number.MAX_SAFE_INTEGER);
    const index = new ImportIndex({ meter });
    index.set('k', { kind: 'entity', id: A, stored: false });
    assert.equal(meter.used, indexEntryBytes(A));
    index.set('k', { kind: 'entity', id: A, stored: true });
    assert.equal(meter.used, indexEntryBytes(A), 'a subject set again as stored was charged a second entry');
    const long = 'x'.repeat(100);
    index.set('k', { kind: 'entity', id: long, stored: true });
    assert.equal(meter.used, indexEntryBytes(long), 'a longer id was charged in full on top of the first');
    index.set('k', { kind: 'entity', id: 'y', stored: true });
    assert.equal(meter.used, indexEntryBytes(long), 'a shorter id changed what the import needs');
    assert.equal(index.size, 1);
  });

  it('a refused set keeps nothing: the entry is not held and the meter is as it was', async () => {
    const { ImportMemoryMeter, indexEntryBytes } = await memory();
    const { ImportIndex } = await indexModule();
    const meter = new ImportMemoryMeter(indexEntryBytes(A) * 2);
    const index = new ImportIndex({ meter });
    index.set('k1', { kind: 'entity', id: A, stored: false });
    index.set('k2', { kind: 'entity', id: A, stored: false });
    assert.throws(() => index.set('k3', { kind: 'entity', id: A, stored: false }), (err) => err?.bound === 'RDF_IMPORT_MAX_MEMORY' && err.limit === indexEntryBytes(A) * 2);
    assert.equal(index.has('k3'), false, 'the refused entry was kept');
    assert.equal(index.size, 2);
    assert.equal(meter.used, indexEntryBytes(A) * 2);
  });

  it('the index and the sets of one import spend one meter, and a statement held twice is charged once', async () => {
    const { ImportMemoryMeter, indexEntryBytes, SET_ENTRY_BYTES } = await memory();
    const { ImportIndex } = await indexModule();
    const { TripletSets } = await countModule();
    const { addressNames } = await importOrFail('server/dist/rdf/term-reverse.js', 'the reverse addressing');
    const BASE = 'https://rdf.example.org/ld/notes/';
    const names = addressNames({ rdf: { enabled: true, base: BASE, vocab: `${BASE}vocab/` }, typeSchemas: { edge: { knows: {} } } });
    const iri = (value) => ({ kind: 'iri', value });
    const quads = [{ subject: iri('http://p.example/a'), predicate: iri(`${BASE}vocab/edge/knows`), object: iri('http://p.example/b') }];
    const meter = new ImportMemoryMeter(Number.MAX_SAFE_INTEGER);
    const index = new ImportIndex({ meter });
    const sets = new TripletSets(meter);
    index.set('s', { kind: 'entity', id: A, stored: false });
    sets.addGroup(quads, names);
    sets.addGroup(quads, names);
    assert.equal(sets.asserted.size, 1);
    assert.equal(meter.used, indexEntryBytes(A) + SET_ENTRY_BYTES, 'the index and the sets did not charge one meter, or a held statement was charged twice');
  });
});
