/**
 * "Which local records come after this position" is answered in ONE module, and the answer includes the records that
 * share the position's seq (bundle-52, Q-277).
 *
 * ## The defect
 *
 * A record keeps its AUTHOR's seq, so records relayed from several authors share seqs. Every reader that pages by
 * `seq > last` loses the tail of a run of equal seqs at a page or batch boundary. The position that does not lose
 * it is a PAIR, `(seq, _id)`, read as two index-bounded finds against `{ seq: 1, _id: 1 }`:
 *
 * 1. the rest of the run at the cursor's own seq: `{ seq: s, _id: { $gt: id } }`, and only when `s` is below the
 *    horizon (a cursor at or above it has nothing settled at `s`);
 * 2. then, for what is still owed, `{ seq: { $gt: s, $lt: horizon } }`.
 *
 * Module under test: `server/src/util/seq-keyset.ts` (built to `server/dist/util/seq-keyset.js`).
 *
 * ## The module's contract, as these tests state it
 *
 * - `encodeSeqCursor({ seq, id? })` -> an opaque base64url string. `base64url("<seq>:<id>")` for a pair; the bare
 *   seq (`base64url("<seq>")`, exactly what a 5.6.x server emitted) when there is no id OR the id is longer than
 *   1024 characters, so that one boundary behaves as it did before rather than wedging on a cursor nobody can read.
 * - `decodeSeqCursor(cursor: unknown)` -> `{ seq, id? }`, or `undefined` for anything it refuses (the route answers
 *   400 with Q-388's fixed text; the value is never echoed). Splits at the FIRST colon, because a file `_id` is a
 *   path and may hold `:`. A bare seq reads as `{ seq }`.
 * - `seqKeysetFilters(after: { seq, id? }, horizon: number, extra?: object)` -> `{ tie: filter | null, range: filter }`,
 *   PURE: the horizon is handed in (production gets it from the settled-seq state), so the shapes are testable without
 *   a database. The extra filter (`ownedFilter`, a family's `pushFilter`) is composed into each with `$and`.
 * - `SEQ_KEYSET_SORT` = `{ seq: 1, _id: 1 }`.
 *
 * Every rule below loads the module itself and fails with "does not exist" while it is not written, so each one is
 * a named failure and not a crash at load.
 *
 * Run: node --test testing/standalone/a-seq-keyset-reads-every-record-after-a-position.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const { MAX_SYNC_SEQ } = await import('../../server/dist/util/seq.js');

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/util/seq-keyset.js', import.meta.url); });
const mod = (rule, names) => needModule(loaded, names, rule);

/**
 * What a 5.6.x server's `decodeCursor` does with a cursor, written out so the test pins the OLD reader and not
 * whatever `_shared.ts` holds by the time this runs.
 */
const legacyDecode = (token) => parseInt(Buffer.from(token, 'base64url').toString(), 10) || 0;

const b64 = (text) => Buffer.from(text).toString('base64url');

const HOSTILE_IDS = [
  'plain',
  'a:b',
  ':leading-colon',
  'trailing-colon:',
  'a::b::c',
  '12:34',
  'ends=',
  '==',
  'a=b=c',
  'caf\u00e9',
  '\u65e5\u672c\u8a9e/\u30d1\u30b9.md',
  '\u{1F600}',
  'x\u{1F600}y:\u{1F4A9}',
  'with space/and\ttab',
  'line\nbreak',
  'path/to/file.txt:v2',
  'x'.repeat(1023),
  'x'.repeat(1024),
];

describe('the cursor is a pair, opaque, and survives hostile ids', () => {
  it('every hostile id round-trips through encode and decode, with its seq', () => {
    const { encodeSeqCursor, decodeSeqCursor } = mod('round trip', ['encodeSeqCursor', 'decodeSeqCursor']);
    assert.ok(HOSTILE_IDS.length >= 15, 'the fixture list is the floor of this rule');
    for (const id of HOSTILE_IDS) {
      for (const seq of [0, 1, 7, 123456789, MAX_SYNC_SEQ]) {
        const cursor = encodeSeqCursor({ seq, id });
        assert.equal(typeof cursor, 'string');
        assert.match(cursor, /^[A-Za-z0-9_-]+$/, 'base64url only, so it survives a query string unescaped');
        assert.deepEqual(decodeSeqCursor(cursor), { seq, id },
          `seq ${seq}, id ${JSON.stringify(id.length > 40 ? `${id.slice(0, 12)}... (${id.length} chars)` : id)}`);
      }
    }
  });

  it('splits at the FIRST colon: an id that holds colons keeps all of them', () => {
    const { decodeSeqCursor } = mod('first colon', ['decodeSeqCursor']);
    assert.deepEqual(decodeSeqCursor(b64('5:a:b:c')), { seq: 5, id: 'a:b:c' });
    assert.deepEqual(decodeSeqCursor(b64('5::x')), { seq: 5, id: ':x' });
    assert.deepEqual(decodeSeqCursor(b64('5:12:34')), { seq: 5, id: '12:34' });
  });

  it('an id longer than 1024 characters is encoded as a BARE seq, which still reads', () => {
    const { encodeSeqCursor, decodeSeqCursor } = mod('over-long id', ['encodeSeqCursor', 'decodeSeqCursor']);
    for (const length of [1025, 2000]) {
      const cursor = encodeSeqCursor({ seq: 42, id: 'p'.repeat(length) });
      assert.equal(cursor, b64('42'), `a ${length}-character id must degrade to the bare seq a 5.6.x server emits`);
      const read = decodeSeqCursor(cursor);
      assert.deepEqual(read, { seq: 42 });
      assert.equal(read.id, undefined);
    }
    assert.ok(encodeSeqCursor({ seq: 42, id: 'x'.repeat(1024) }) !== b64('42'), 'exactly 1024 is still a pair');
  });

  it('a bare legacy seq reads as { seq } with no id', () => {
    const { decodeSeqCursor, encodeSeqCursor } = mod('legacy bare seq', ['decodeSeqCursor', 'encodeSeqCursor']);
    for (const seq of [0, 1, 99, MAX_SYNC_SEQ]) {
      const read = decodeSeqCursor(b64(String(seq)));
      assert.deepEqual(read, { seq });
      assert.equal('id' in read && read.id !== undefined, false);
    }
    assert.equal(encodeSeqCursor({ seq: 5 }), b64('5'), 'no id: the cursor is the bare seq');
  });

  it('a 5.6.x decoder (parseInt of the decoded text) reads a pair as its seq — rollback safety', () => {
    const { encodeSeqCursor } = mod('rollback', ['encodeSeqCursor']);
    for (const id of HOSTILE_IDS) {
      for (const seq of [0, 3, 987654321]) {
        assert.equal(legacyDecode(encodeSeqCursor({ seq, id })), seq,
          `an old server handed the pair (${seq}, ${id.length} chars) must read seq ${seq}`);
      }
    }
    assert.equal(legacyDecode(encodeSeqCursor({ seq: 17, id: 'x'.repeat(2000) })), 17, 'the bare fallback too');
  });
});

describe('the decoder refuses every malformed cursor and never reads a default', () => {
  it('not a string at all', () => {
    const { decodeSeqCursor } = mod('non-string', ['decodeSeqCursor']);
    for (const bad of [undefined, null, 5, 0, true, {}, { $ne: '' }, ['abc'], [b64('5:a')], () => 'x']) {
      assert.equal(decodeSeqCursor(bad), undefined, `${typeof bad} ${JSON.stringify(bad)} must be refused`);
    }
  });

  it('a seq that is not a plain whole decimal number of 0 or more within MAX_SYNC_SEQ', () => {
    const { decodeSeqCursor } = mod('bad seq', ['decodeSeqCursor']);
    const badSeqs = [
      '-1', '-0', '1.5', '1e3', '1e+21', '0x10', '+5', ' 5', '5 ', 'NaN', 'Infinity', 'abc', '',
      String(MAX_SYNC_SEQ + 1), String(2 ** 60), '9'.repeat(17), '99999999999999999999',
    ];
    for (const seq of badSeqs) {
      assert.equal(decodeSeqCursor(b64(`${seq}:abc`)), undefined, `pair with seq ${JSON.stringify(seq)}`);
      if (seq !== '') assert.equal(decodeSeqCursor(b64(seq)), undefined, `bare seq ${JSON.stringify(seq)}`);
    }
    assert.deepEqual(decodeSeqCursor(b64(`${MAX_SYNC_SEQ}:abc`)), { seq: MAX_SYNC_SEQ, id: 'abc' },
      'MAX_SYNC_SEQ itself is within the bound');
  });

  it('an empty or over-long id, or nothing after the seq', () => {
    const { decodeSeqCursor } = mod('bad id', ['decodeSeqCursor']);
    assert.equal(decodeSeqCursor(b64('5:')), undefined, 'a pair with an empty id');
    assert.equal(decodeSeqCursor(b64(':abc')), undefined, 'no seq');
    assert.equal(decodeSeqCursor(b64('abc:def')), undefined, 'a non-numeric seq');
    assert.equal(decodeSeqCursor(b64(`5:${'x'.repeat(1025)}`)), undefined, 'an id past 1024 characters');
    assert.deepEqual(decodeSeqCursor(b64(`5:${'x'.repeat(1024)}`)), { seq: 5, id: 'x'.repeat(1024) });
  });

  it('garbage that is not base64url text reads as nothing, never as seq 0', () => {
    const { decodeSeqCursor } = mod('garbage', ['decodeSeqCursor']);
    for (const bad of ['!!!!', '@@', '%00', 'not a cursor', '\u0000', '$ne']) {
      assert.equal(decodeSeqCursor(bad), undefined, JSON.stringify(bad));
    }
  });
});

/** The conjuncts of a filter, whether it is `{ $and: [...] }` or a bare filter. */
const conjuncts = (f) => (Array.isArray(f?.$and) ? f.$and : [f]).filter(c => c !== undefined && Object.keys(c).length > 0);

describe('the two finds a keyset read makes', () => {
  const EXTRA = Object.freeze({ 'author.instanceId': 'me', parentFileId: { $exists: false } });

  it('the tie branch reads the rest of the run at the cursor seq, by _id, and only when the seq is below the horizon', () => {
    const { seqKeysetFilters } = mod('tie branch', ['seqKeysetFilters']);
    const { tie, range } = seqKeysetFilters({ seq: 5, id: 'k' }, 100);
    assert.ok(tie, 'a pair below the horizon has a tie branch');
    assert.deepEqual(conjuncts(tie), [{ seq: 5, _id: { $gt: 'k' } }], '`$gt` on _id: the record AT the cursor was already delivered');
    assert.deepEqual(conjuncts(range), [{ seq: { $gt: 5, $lt: 100 } }]);
  });

  it('a cursor at or above the horizon reads nothing at its own seq', () => {
    const { seqKeysetFilters } = mod('horizon', ['seqKeysetFilters']);
    for (const [seq, horizon] of [[100, 100], [101, 100], [5, 5], [6, 5]]) {
      assert.equal(seqKeysetFilters({ seq, id: 'k' }, horizon).tie, null, `seq ${seq} against horizon ${horizon}`);
    }
    assert.ok(seqKeysetFilters({ seq: 99, id: 'k' }, 100).tie, 'one below the horizon still has a tie branch');
  });

  it('a start with no id (sinceSeq, a legacy cursor) has no tie branch and a strict range', () => {
    const { seqKeysetFilters } = mod('no id', ['seqKeysetFilters']);
    const { tie, range } = seqKeysetFilters({ seq: 5 }, 100);
    assert.equal(tie, null);
    assert.deepEqual(conjuncts(range), [{ seq: { $gt: 5, $lt: 100 } }]);
  });

  it('the extra filter is composed with $and into BOTH finds, never spread, so it cannot overwrite the guard', () => {
    const { seqKeysetFilters } = mod('extra filter', ['seqKeysetFilters']);
    // A hostile extra that spells the very keys the guard owns: a spread would let it replace the position.
    const hostile = Object.freeze({ seq: { $gt: 0 }, _id: { $ne: 'zzz' }, ...EXTRA });
    for (const extra of [EXTRA, hostile]) {
      const { tie, range } = seqKeysetFilters({ seq: 5, id: 'k' }, 100, extra);
      for (const [name, filter] of [['tie', tie], ['range', range]]) {
        assert.ok(filter, name);
        const parts = conjuncts(filter);
        assert.ok(parts.some(c => JSON.stringify(c) === JSON.stringify(extra)), `${name} carries the extra filter whole`);
        const guard = name === 'tie' ? { seq: 5, _id: { $gt: 'k' } } : { seq: { $gt: 5, $lt: 100 } };
        assert.ok(parts.some(c => JSON.stringify(c) === JSON.stringify(guard)), `${name} carries its position guard whole`);
        assert.deepEqual(Object.keys(filter), ['$and'], `${name}: the only top-level key is $and — nothing of the extra is spread beside the guard`);
      }
    }
    const { range: bare } = seqKeysetFilters({ seq: 5 }, 100, hostile);
    assert.deepEqual(Object.keys(bare), ['$and'], 'the no-id range composes the extra filter the same way');
  });

  it('does not mutate what it is handed', () => {
    const { seqKeysetFilters } = mod('purity', ['seqKeysetFilters']);
    const after = Object.freeze({ seq: 5, id: 'k' });
    const extra = Object.freeze({ a: Object.freeze({ b: 1 }) });
    assert.doesNotThrow(() => seqKeysetFilters(after, 100, extra));
  });

  it('the sort that goes with it is { seq: 1, _id: 1 }', () => {
    const { SEQ_KEYSET_SORT } = mod('sort', ['SEQ_KEYSET_SORT']);
    assert.deepEqual(SEQ_KEYSET_SORT, { seq: 1, _id: 1 });
    assert.deepEqual(Object.keys(SEQ_KEYSET_SORT), ['seq', '_id'], 'seq first, _id last: key order is the sort order');
  });
});
