/**
 * The cursor of a read keyed by an INSTANT (the file tombstones, bundle-51) names a position exactly, and refuses what it
 * cannot read — the twin of the seq cursor in `util/seq-keyset.ts`.
 *
 * ## The rule
 *
 * A position is a PAIR, `(instant, _id)`: two records published in the same millisecond share an instant, and a cursor
 * that named only the instant would skip the rest of that run at every page boundary (the defect `Q-277` fixed for seqs).
 * `encodeIsoCursor` / `isoReadStart` are the only codec. What they hold:
 *
 *   - **round trip**: every comparable instant, with no id, with an id, and with an id that is a path holding colons (the
 *     instant holds colons too, so the text is split at its FIXED width and never searched);
 *   - **an over-long id is dropped**, not wedged: the position falls back to the bare instant, as the seq cursor does;
 *   - **refusals**: a non-string (`cursor[$ne]`), text that is not base64url, an instant that is not the comparable form
 *     (an offset, no milliseconds, a date-only), a pair with no separator or an empty id, and an unencodable instant at
 *     the encoder — each answers `undefined` and never throws on the read side, so the route answers a fixed `400`;
 *   - **no cursor is the start of time**: absent and empty both read as `ISO_READ_START`, so a caller has one answer for
 *     "the first page".
 *
 * ## Mutation that turns it red
 *
 * Split the text at the first or last colon instead of the instant's width (the path-with-colons rows go red), accept an
 * instant without milliseconds or with an offset, let an empty id through, or make an absent cursor refused.
 *
 * Run: node --test testing/standalone/an-iso-cursor-names-a-position-exactly.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { loadDistModule, needModule } from './_load-dist-module.mjs';

let loaded;
before(async () => { loaded = await loadDistModule('../../server/dist/util/seq-keyset.js', import.meta.url); });
const mod = (rule) => needModule(loaded, ['encodeIsoCursor', 'isoReadStart', 'ISO_READ_START', 'BAD_ISO_CURSOR', 'MAX_CURSOR_ID_LENGTH'], rule);

const AT = '2026-09-01T10:20:30.123Z';
const b64 = (text) => Buffer.from(text).toString('base64url');

const INSTANTS = ['1970-01-01T00:00:00.000Z', AT, '2026-12-31T23:59:59.999Z', '9999-12-31T23:59:59.999Z'];
const IDS = [undefined, 'plain', 'a:b', ':leading', 'trailing:', 'a::b::c', 'docs/notes: 2026/12:30.md', 'ünïcödé/日本語.txt', '12:34', AT];

describe('the round trip', () => {
  it('every instant x every id comes back as the position that went in', () => {
    const { encodeIsoCursor, isoReadStart } = mod('round trip');
    let rows = 0;
    for (const at of INSTANTS) {
      for (const id of IDS) {
        const back = isoReadStart(encodeIsoCursor({ at, id }));
        assert.deepEqual(back, id === undefined ? { at } : { at, id }, `${at} / ${id}`);
        rows++;
      }
    }
    assert.ok(rows >= 30, `only ${rows} rows`);
  });

  it('is opaque base64url text', () => {
    const { encodeIsoCursor } = mod('opaque');
    assert.match(encodeIsoCursor({ at: AT, id: 'a/b:c' }), /^[A-Za-z0-9_-]+$/);
  });

  it('an empty id is no id', () => {
    const { encodeIsoCursor, isoReadStart } = mod('empty id');
    assert.deepEqual(isoReadStart(encodeIsoCursor({ at: AT, id: '' })), { at: AT });
  });

  it('an id past the bound falls back to the bare instant, and one at the bound is kept', () => {
    const { encodeIsoCursor, isoReadStart, MAX_CURSOR_ID_LENGTH } = mod('long id');
    assert.deepEqual(isoReadStart(encodeIsoCursor({ at: AT, id: 'x'.repeat(MAX_CURSOR_ID_LENGTH + 1) })), { at: AT });
    const edge = 'y'.repeat(MAX_CURSOR_ID_LENGTH);
    assert.deepEqual(isoReadStart(encodeIsoCursor({ at: AT, id: edge })), { at: AT, id: edge });
  });
});

describe('what the encoder will not name', () => {
  it('throws on an instant that does not sort as text', () => {
    const { encodeIsoCursor } = mod('encoder refuses');
    for (const at of ['', 'not a date', '2026-09-01', '2026-09-01T10:20:30Z', '2026-09-01T10:20:30.123+02:00', '2026-09-01T10:20:30.12Z', undefined, 7]) {
      assert.throws(() => encodeIsoCursor({ at }), RangeError, String(at));
    }
  });
});

describe('what the reader refuses', () => {
  it('answers undefined for everything it cannot read, and never throws', () => {
    const { isoReadStart } = mod('refusals');
    const refused = [
      ['an object (cursor[$ne]=x)', { $ne: 'x' }],
      ['an array', [b64(AT)]],
      ['a number', 7],
      ['null', null],
      ['not base64url', 'not base64!'],
      ['an instant with an offset', b64('2026-09-01T10:20:30.123+02:00')],
      ['an instant without milliseconds', b64('2026-09-01T10:20:30Z')],
      ['a date only', b64('2026-09-01')],
      ['a seq cursor', b64('47:abc')],
      ['a bare seq', b64('47')],
      ['a pair with no separator', b64(`${AT}x`)],
      ['a pair with the wrong separator', b64(`${AT}|id`)],
      ['a pair with an empty id', b64(`${AT}:`)],
      ['a pair with an over-long id', b64(`${AT}:${'z'.repeat(2000)}`)],
    ];
    for (const [name, cursor] of refused) assert.equal(isoReadStart(cursor), undefined, name);
  });

  it('the refusal text is fixed and repeats nothing a caller sent', () => {
    const { BAD_ISO_CURSOR } = mod('fixed text');
    assert.equal(typeof BAD_ISO_CURSOR, 'string');
    assert.ok(BAD_ISO_CURSOR.length > 0 && !/[<>{}$]/.test(BAD_ISO_CURSOR));
  });
});

describe('no cursor is the start of time', () => {
  it('absent and empty read as ISO_READ_START, which sorts before every instant', () => {
    const { isoReadStart, ISO_READ_START } = mod('start');
    assert.deepEqual(isoReadStart(undefined), ISO_READ_START);
    assert.deepEqual(isoReadStart(''), ISO_READ_START);
    assert.equal(ISO_READ_START.at, '');
    for (const at of INSTANTS) assert.ok(at > ISO_READ_START.at);
  });
});
