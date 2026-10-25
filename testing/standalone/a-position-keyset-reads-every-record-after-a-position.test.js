/**
 * "Which local records come after this position" is answered in ONE module, and the answer includes the records that share the position's `pos`
 * (bundle-52, Q-277; re-pointed to positions by bundle-81, design rev 8 §6: `util/position-keyset.ts`, the successor of `util/seq-keyset.ts`'s reader).
 *
 * ## The defect
 *
 * A record keeps its AUTHOR's position in the legacy band (a carried 5.6 seq, which a relayed record shares with its author's), so several records can share a
 * position. Every reader that pages by `pos > last` loses the tail of a run of equal positions at a page or batch boundary. The position that does not lose it is a
 * PAIR, `(pos, _id)`, read as two index-bounded finds against `{ pos: 1, _id: 1 }`:
 *
 * 1. the rest of the run at the cursor's own position: `{ pos: p, _id: { $gt: id } }`, and only when `p` is below the settled cap (a cursor at or above it has
 *    nothing settled at `p`);
 * 2. then, for what is still owed, `{ pos: { $gt: p, $lt: cap } }`.
 *
 * Module under test: `server/src/util/position-keyset.ts` (built to `server/dist/util/position-keyset.js`).
 *
 * ## The module's contract, as these tests state it
 *
 * - `encodePositionCursor({ pos, id? })` -> an opaque string: `p1.` + `base64url("<pos>:<id>")` for a pair, `p1.` + `base64url("<pos>")` when there is no id OR the
 *   id is longer than 1024 characters, so that one boundary degrades to a bare position rather than wedging on a cursor nobody can read.
 * - `decodePositionCursor(cursor: unknown)` -> `{ pos, id? }`, or `undefined` for anything it refuses (the route answers 400 with a fixed text; the value is never
 *   echoed). The `p1.` prefix is what tells a 6.0 cursor from every older form, which are ALL refused: a 5.x cursor is a position in another space of numbers.
 *   Splits at the FIRST colon, because a file `_id` is a path and may hold `:`. A bare position reads as `{ pos }`.
 * - `positionKeysetFilters(after: { pos, id? }, cap: number, extra?: object)` -> `{ tie: filter | null, range: filter }`, PURE: the cap is handed in (production
 *   gets it from `settledPositionCap`), so the shapes are testable without a database. The extra filter (a push's selection, a family's `pushFilter`) is composed
 *   into each with `$and`.
 * - `POSITION_KEYSET_SORT` = `{ pos: 1, _id: 1 }`.
 * - A position's own bound is `Number.MAX_SAFE_INTEGER` (a clock-band position is above `MAX_SYNC_SEQ`, which would refuse every one).
 *
 * Every rule below loads the module itself and fails with "does not exist" while it is not written, so each one is a named failure and not a crash at load.
 *
 * Run: node --test testing/standalone/a-position-keyset-reads-every-record-after-a-position.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

const { MAX_SYNC_SEQ } = await import('../../server/dist/util/seq.js');
const MAX_POS = Number.MAX_SAFE_INTEGER;
/** A clock-band position (microseconds since 1970): above every legacy seq, which is what the seq paging's bound would have refused. */
const CLOCK_POS = 1_790_000_000_000_000;

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/util/position-keyset.js', import.meta.url); });
const mod = (rule, names) => needModule(loaded, names, rule);

const b64 = (text) => Buffer.from(text).toString('base64url');
/** A 6.0 cursor spelled out, so the test pins the format and not whatever the encoder does. */
const cursorOf = (text) => `p1.${b64(text)}`;

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
  it('every hostile id round-trips through encode and decode, with its position', () => {
    const { encodePositionCursor, decodePositionCursor } = mod('round trip', ['encodePositionCursor', 'decodePositionCursor']);
    assert.ok(HOSTILE_IDS.length >= 15, 'the fixture list is the floor of this rule');
    for (const id of HOSTILE_IDS) {
      for (const pos of [0, 1, 7, 123456789, MAX_SYNC_SEQ, CLOCK_POS, MAX_POS]) {
        const cursor = encodePositionCursor({ pos, id });
        assert.equal(typeof cursor, 'string');
        assert.match(cursor, /^p1\.[A-Za-z0-9_-]+$/, 'the 6.0 prefix, then base64url only, so it survives a query string unescaped');
        assert.deepEqual(decodePositionCursor(cursor), { pos, id },
          `pos ${pos}, id ${JSON.stringify(id.length > 40 ? `${id.slice(0, 12)}... (${id.length} chars)` : id)}`);
      }
    }
  });

  it('splits at the FIRST colon: an id that holds colons keeps all of them', () => {
    const { decodePositionCursor } = mod('first colon', ['decodePositionCursor']);
    assert.deepEqual(decodePositionCursor(cursorOf('5:a:b:c')), { pos: 5, id: 'a:b:c' });
    assert.deepEqual(decodePositionCursor(cursorOf('5::x')), { pos: 5, id: ':x' });
    assert.deepEqual(decodePositionCursor(cursorOf('5:12:34')), { pos: 5, id: '12:34' });
  });

  it('an id longer than 1024 characters is encoded as a BARE position, which still reads', () => {
    const { encodePositionCursor, decodePositionCursor } = mod('over-long id', ['encodePositionCursor', 'decodePositionCursor']);
    for (const length of [1025, 2000]) {
      const cursor = encodePositionCursor({ pos: 42, id: 'p'.repeat(length) });
      assert.equal(cursor, cursorOf('42'), `a ${length}-character id must degrade to the bare position`);
      const read = decodePositionCursor(cursor);
      assert.deepEqual(read, { pos: 42 });
      assert.equal(read.id, undefined);
    }
    assert.ok(encodePositionCursor({ pos: 42, id: 'x'.repeat(1024) }) !== cursorOf('42'), 'exactly 1024 is still a pair');
  });

  it('a bare position reads as { pos } with no id', () => {
    const { decodePositionCursor, encodePositionCursor } = mod('bare position', ['decodePositionCursor', 'encodePositionCursor']);
    for (const pos of [0, 1, 99, MAX_SYNC_SEQ, CLOCK_POS, MAX_POS]) {
      const read = decodePositionCursor(cursorOf(String(pos)));
      assert.deepEqual(read, { pos });
      assert.equal('id' in read && read.id !== undefined, false);
    }
    assert.equal(encodePositionCursor({ pos: 5 }), cursorOf('5'), 'no id: the cursor is the bare position');
  });

  it('EVERY older cursor form is refused: a cursor without the 6.0 prefix is a position in another space of numbers', () => {
    const { encodePositionCursor, decodePositionCursor } = mod('older forms', ['encodePositionCursor', 'decodePositionCursor']);
    // The forms a 5.6.x server emitted or a 5.6.x integrator wrote: a pair, a bare seq, the bare seq as the integrator guide told clients to build it.
    for (const old of [b64('5:some-record-id'), b64('0'), b64('1'), b64('5'), '5', b64('9007199254740991:x')]) {
      assert.equal(decodePositionCursor(old), undefined, `the older cursor ${old} must be refused`);
    }
    // And what the 6.0 encoder writes is not what a 5.6 decoder would read as a seq: it is refused there, never misread.
    const parseInt56 = (token) => parseInt(Buffer.from(token, 'base64url').toString(), 10);
    assert.ok(Number.isNaN(parseInt56(encodePositionCursor({ pos: 5, id: 'a' }))), 'a 6.0 cursor read by a 5.6 decoder is no number, so it cannot be mistaken for a seq');
  });
});

describe('the decoder refuses every malformed cursor and never reads a default', () => {
  it('not a string at all', () => {
    const { decodePositionCursor } = mod('non-string', ['decodePositionCursor']);
    for (const bad of [undefined, null, 5, 0, true, {}, { $ne: '' }, ['abc'], [cursorOf('5:a')], () => 'x']) {
      assert.equal(decodePositionCursor(bad), undefined, `${typeof bad} ${JSON.stringify(bad)} must be refused`);
    }
  });

  it('a position that is not a plain whole decimal number of 0 or more within Number.MAX_SAFE_INTEGER', () => {
    const { decodePositionCursor } = mod('bad position', ['decodePositionCursor']);
    const badPositions = [
      '-1', '-0', '1.5', '1e3', '1e+21', '0x10', '+5', ' 5', '5 ', 'NaN', 'Infinity', 'abc', '',
      String(MAX_POS + 1), String(2 ** 60), '9'.repeat(17), '99999999999999999999',
    ];
    for (const pos of badPositions) {
      assert.equal(decodePositionCursor(cursorOf(`${pos}:abc`)), undefined, `pair with position ${JSON.stringify(pos)}`);
      if (pos !== '') assert.equal(decodePositionCursor(cursorOf(pos)), undefined, `bare position ${JSON.stringify(pos)}`);
    }
    assert.deepEqual(decodePositionCursor(cursorOf(`${MAX_POS}:abc`)), { pos: MAX_POS, id: 'abc' }, 'Number.MAX_SAFE_INTEGER itself is within the bound');
    assert.deepEqual(decodePositionCursor(cursorOf(`${CLOCK_POS}:abc`)), { pos: CLOCK_POS, id: 'abc' }, 'a clock-band position is above MAX_SYNC_SEQ and must be read');
  });

  it('an empty or over-long id, or nothing after the position', () => {
    const { decodePositionCursor } = mod('bad id', ['decodePositionCursor']);
    assert.equal(decodePositionCursor(cursorOf('5:')), undefined, 'a pair with an empty id');
    assert.equal(decodePositionCursor(cursorOf(':abc')), undefined, 'no position');
    assert.equal(decodePositionCursor(cursorOf('abc:def')), undefined, 'a non-numeric position');
    assert.equal(decodePositionCursor(cursorOf(`5:${'x'.repeat(1025)}`)), undefined, 'an id past 1024 characters');
    assert.deepEqual(decodePositionCursor(cursorOf(`5:${'x'.repeat(1024)}`)), { pos: 5, id: 'x'.repeat(1024) });
  });

  it('garbage that is not a prefixed base64url text reads as nothing, never as position 0', () => {
    const { decodePositionCursor } = mod('garbage', ['decodePositionCursor']);
    for (const bad of ['!!!!', '@@', '%00', 'not a cursor', '\u0000', '$ne', 'p1.', 'p1.!!', 'p1.%00', 'p1', 'P1.abc']) {
      assert.equal(decodePositionCursor(bad), undefined, JSON.stringify(bad));
    }
  });
});

/** The conjuncts of a filter, whether it is `{ $and: [...] }` or a bare filter. */
const conjuncts = (f) => (Array.isArray(f?.$and) ? f.$and : [f]).filter(c => c !== undefined && Object.keys(c).length > 0);

describe('the two finds a keyset read makes', () => {
  const EXTRA = Object.freeze({ writtenHere: true, parentFileId: { $exists: false } });

  it('the tie branch reads the rest of the run at the cursor position, by _id, and only when the position is below the cap', () => {
    const { positionKeysetFilters } = mod('tie branch', ['positionKeysetFilters']);
    const { tie, range } = positionKeysetFilters({ pos: 5, id: 'k' }, 100);
    assert.ok(tie, 'a pair below the cap has a tie branch');
    assert.deepEqual(conjuncts(tie), [{ pos: 5, _id: { $gt: 'k' } }], '`$gt` on _id: the record AT the cursor was already delivered');
    assert.deepEqual(conjuncts(range), [{ pos: { $gt: 5, $lt: 100 } }]);
  });

  it('a cursor at or above the cap reads nothing at its own position', () => {
    const { positionKeysetFilters } = mod('cap', ['positionKeysetFilters']);
    for (const [pos, cap] of [[100, 100], [101, 100], [5, 5], [6, 5]]) {
      assert.equal(positionKeysetFilters({ pos, id: 'k' }, cap).tie, null, `position ${pos} against cap ${cap}`);
    }
    assert.ok(positionKeysetFilters({ pos: 99, id: 'k' }, 100).tie, 'one below the cap still has a tie branch');
  });

  it('a start with no id (afterPos, a bare cursor) has no tie branch and a strict range', () => {
    const { positionKeysetFilters } = mod('no id', ['positionKeysetFilters']);
    const { tie, range } = positionKeysetFilters({ pos: 5 }, 100);
    assert.equal(tie, null);
    assert.deepEqual(conjuncts(range), [{ pos: { $gt: 5, $lt: 100 } }]);
  });

  it('the extra filter is composed with $and into BOTH finds, never spread, so it cannot overwrite the guard', () => {
    const { positionKeysetFilters } = mod('extra filter', ['positionKeysetFilters']);
    // A hostile extra that spells the very keys the guard owns: a spread would let it replace the position.
    const hostile = Object.freeze({ pos: { $gt: 0 }, _id: { $ne: 'zzz' }, ...EXTRA });
    for (const extra of [EXTRA, hostile]) {
      const { tie, range } = positionKeysetFilters({ pos: 5, id: 'k' }, 100, extra);
      for (const [name, filter] of [['tie', tie], ['range', range]]) {
        assert.ok(filter, name);
        const parts = conjuncts(filter);
        assert.ok(parts.some(c => JSON.stringify(c) === JSON.stringify(extra)), `${name} carries the extra filter whole`);
        const guard = name === 'tie' ? { pos: 5, _id: { $gt: 'k' } } : { pos: { $gt: 5, $lt: 100 } };
        assert.ok(parts.some(c => JSON.stringify(c) === JSON.stringify(guard)), `${name} carries its position guard whole`);
        assert.deepEqual(Object.keys(filter), ['$and'], `${name}: the only top-level key is $and — nothing of the extra is spread beside the guard`);
      }
    }
    const { range: bare } = positionKeysetFilters({ pos: 5 }, 100, hostile);
    assert.deepEqual(Object.keys(bare), ['$and'], 'the no-id range composes the extra filter the same way');
  });

  it('does not mutate what it is handed', () => {
    const { positionKeysetFilters } = mod('purity', ['positionKeysetFilters']);
    const after = Object.freeze({ pos: 5, id: 'k' });
    const extra = Object.freeze({ a: Object.freeze({ b: 1 }) });
    assert.doesNotThrow(() => positionKeysetFilters(after, 100, extra));
  });

  it('the sort that goes with it is { pos: 1, _id: 1 }', () => {
    const { POSITION_KEYSET_SORT } = mod('sort', ['POSITION_KEYSET_SORT']);
    assert.deepEqual(POSITION_KEYSET_SORT, { pos: 1, _id: 1 });
    assert.deepEqual(Object.keys(POSITION_KEYSET_SORT), ['pos', '_id'], 'pos first, _id last: key order is the sort order');
  });

  it('two positions are ordered as the store orders them: by position, then by _id as UTF-8 BYTES', () => {
    const { comparePositionStarts } = mod('order', ['comparePositionStarts']);
    assert.ok(comparePositionStarts({ pos: 1, id: 'z' }, { pos: 2, id: 'a' }) < 0);
    assert.ok(comparePositionStarts({ pos: 2 }, { pos: 2, id: 'a' }) < 0, 'a position without an id comes before every id at its position');
    assert.equal(comparePositionStarts({ pos: 2, id: 'a' }, { pos: 2, id: 'a' }), 0);
    assert.ok(comparePositionStarts({ pos: 5, id: '\u{E000}' }, { pos: 5, id: '\u{1F600}' }) < 0, 'as bytes U+E000 (EE..) is before U+1F600 (F0..), though UTF-16 units say the opposite');
  });
});
