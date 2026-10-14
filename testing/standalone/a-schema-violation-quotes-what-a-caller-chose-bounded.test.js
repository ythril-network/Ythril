/**
 * What a schema refusal or a warning row QUOTES of a caller's own choice is bounded — a violation's `field`, a string
 * `value`, the names a message lists, and the unknown keys a warning names (`Q-362`, R5-4, R6-11).
 *
 * ## The finding
 *
 * The caller chooses a property key, a body key and a string value, and a refusal quotes all three: a
 * `SchemaViolation` is `{ field, value, reason }`, `describeUpdateViolations` joins the fields into the sentence,
 * `unknownFieldWarnings` makes one row per unknown key and re-sorts the accepted list for every one of them. With
 * undeclared property keys becoming violations (Q-93) the caller's key becomes a `field`, so the megabyte-key class the
 * zod doors had returns through the record doors, in `introduced`, in `violations` and in the message — and on REST
 * a 10 MB body of unknown keys is hundreds of thousands of rows, each carrying the same accepted list.
 *
 * ## What is held
 *
 *  - `SchemaViolationError.toStructured()` renders every `field` through `peerText` at `NAME_QUOTED` and every STRING
 *    `value` through `peerText`, in `introduced`, `preExisting` and `violations` alike. A value that is not a string
 *    (a number, a boolean, `null`, an array, an object) is carried unchanged: it is the caller's structured value, and
 *    stringifying it would change what a caller that compares it sees.
 *  - `describeUpdateViolations` joins the names it lists through the list renderer, each at `NAME_QUOTED`, so one huge
 *    field neither floods the sentence nor hides the field named after it.
 *  - `unknownFieldWarnings` names at most ten unknown keys, then says how many it left out, and builds the accepted-key
 *    list once. This is the BOUND only: whether an unknown key is warned or refused is Q-320's rule, owner decision
 *    D-32, and no case here depends on it.
 *
 * Expected values are `peerText`'s own output for the input (the renderer is the specification), and the bounds are
 * constants read from the module that owns them.
 *
 * ## Seen red
 *
 * On 85c4c564 `toStructured()` returns the field and value whole (a megabyte each), `describeUpdateViolations` joins the
 * names raw, and 500 unknown keys are 500 rows each carrying a re-sorted copy of the accepted list.
 *
 * Run: node --test testing/standalone/a-schema-violation-quotes-what-a-caller-chose-bounded.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const log = await import('../../server/dist/util/log.js');
const { SchemaViolationError, describeUpdateViolations } = await import('../../server/dist/brain/write-validation.js');
const { unknownFieldWarnings, SHARED_WRITE_BODY_KEYS } = await import('../../server/dist/api/brain/unknown-fields.js');
const { peerText, NAME_QUOTED, LOG_VALUE_MAX } = log;

const HUGE = 'k'.repeat(1_000_000);
const CUT = /…\(\+(\d+) chars\)$/;
const LS = String.fromCharCode(0x2028);

/** A refusal over exactly these violations, the way a classifier builds one. */
function refusalOf({ introduced = [], preExisting = [], message = 'The change violates this space\'s schema.' } = {}) {
  const all = [...introduced, ...preExisting];
  return new SchemaViolationError({ blocked: true, introduced, preExisting, all, warnings: all, message });
}

describe('toStructured() quotes a violation\'s field and string value bounded, in all three lists', () => {
  const rows = (v) => ({
    introduced: refusalOf({ introduced: [v] }).toStructured().introduced,
    preExisting: refusalOf({ preExisting: [v] }).toStructured().preExisting,
    violations: refusalOf({ introduced: [v] }).toStructured().violations,
  });

  for (const list of ['introduced', 'preExisting', 'violations']) {
    it(`${list}: a megabyte field is rendered at NAME_QUOTED and says how much was cut`, () => {
      const [row] = rows({ field: `properties.${HUGE}`, value: 'x', reason: 'no such property' })[list];
      assert.equal(row.field, peerText(`properties.${HUGE}`, { max: NAME_QUOTED }), 'the field is not rendered by peerText at NAME_QUOTED');
      assert.match(row.field, CUT);
      assert.ok(row.field.length < NAME_QUOTED + 40, `the field is ${row.field.length} characters`);
      assert.equal(row.reason, 'no such property', 'an ordinary reason changed');
    });

    it(`${list}: a megabyte string value is rendered by peerText, and a line-breaking one is escaped`, () => {
      const [big] = rows({ field: 'properties.note', value: HUGE, reason: 'too long' })[list];
      assert.equal(big.value, peerText(HUGE));
      assert.ok(big.value.length < LOG_VALUE_MAX + 40, `the value is ${big.value.length} characters`);
      assert.match(big.value, CUT);
      const [broken] = rows({ field: 'properties.note', value: `a${LS}\r\nFORGED`, reason: 'bad' })[list];
      assert.equal(broken.value, peerText(`a${LS}\r\nFORGED`));
      assert.doesNotMatch(broken.value, new RegExp(`[\\r\\n${LS}]`), 'a value\'s line-breaking character was carried raw');
    });

    it(`${list}: a credential inside a string value is redacted, as every quoted value is`, () => {
      const [row] = rows({ field: 'properties.header', value: 'sent Bearer abcdef123456 to it', reason: 'bad' })[list];
      assert.doesNotMatch(row.value, /abcdef123456/, 'a bearer token reached the refusal');
    });
  }

  it('a value that is not a string is carried exactly as it came, by identity or deep equality', () => {
    const structured = { a: [1, 2, { b: null }], c: true };
    const array = ['x', 2];
    const fixtures = [42, 0, true, false, null, structured, array];
    const out = refusalOf({ introduced: fixtures.map((value, i) => ({ field: `properties.p${i}`, value, reason: 'r' })) })
      .toStructured().introduced;
    assert.equal(out.length, fixtures.length);
    out.forEach((row, i) => {
      assert.deepEqual(row.value, fixtures[i], `value ${i} (${JSON.stringify(fixtures[i])}) was changed`);
      assert.equal(typeof row.value, typeof fixtures[i], `value ${i} changed type`);
    });
  });

  it('an ordinary violation is answered exactly as before: nothing short is cut or marked', () => {
    const v = { field: 'properties.status', value: 'retired', reason: 'must be one of: open, closed' };
    const s = structuredOf(v);
    assert.deepEqual(s.introduced, [v]);
    assert.deepEqual(s.violations, [v]);
    assert.equal(s.error, 'schema_violation');
  });

  function structuredOf(v) { return refusalOf({ introduced: [v] }).toStructured(); }
});

describe('the sentence a refusal says lists the fields it names bounded', () => {
  it('one megabyte field is cut at NAME_QUOTED and the field named after it is still named', () => {
    const text = describeUpdateViolations(
      [{ field: `properties.${HUGE}`, value: 1, reason: 'no such property' }, { field: 'properties.status', value: 'x', reason: 'not allowed' }], []);
    assert.ok(text.length < 2 * LOG_VALUE_MAX, `the sentence is ${text.length} characters — the field came back whole`);
    assert.match(text, /properties\.status/, 'the second field is no longer named');
    assert.match(text, /…\(\+\d+ chars\)/, 'the cut field does not say it was cut');
  });

  it('the same holds for the pre-existing half and for both halves together', () => {
    const big = { field: `properties.${HUGE}`, value: 1, reason: 'r' };
    for (const [intro, pre] of [[[], [big]], [[big], [{ ...big, field: `properties.${HUGE}x` }]]]) {
      const text = describeUpdateViolations(intro, pre);
      assert.ok(text.length < 3 * LOG_VALUE_MAX, `the sentence is ${text.length} characters`);
    }
  });

  it('a short field name is named whole, as before', () => {
    assert.equal(describeUpdateViolations([{ field: 'properties.a', value: 1, reason: 'r' }], []),
      'The change violates this space\'s schema: properties.a.');
  });
});

describe('unknown-field warning rows: at most ten, then a count, with the accepted list built once', () => {
  const KNOWN = ['name', 'type', 'description', 'tags', 'properties'];
  const bodyOf = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`extra${String(i).padStart(4, '0')}`, i]));

  it('500 unknown keys name the first ten and count the other 490', () => {
    const rows = unknownFieldWarnings({ name: 'n', ...bodyOf(500) }, KNOWN);
    assert.ok(rows.length <= 11, `${rows.length} rows came back for 500 unknown keys`);
    assert.deepEqual(rows.slice(0, 10).map(r => r.field), Array.from({ length: 10 }, (_, i) => `extra${String(i).padStart(4, '0')}`),
      'the rows shown are not the first ten unknown keys, in order');
    assert.match(JSON.stringify(rows.slice(10)), /\b490\b/, 'the 490 keys left out are not counted');
  });

  it('ten or fewer unknown keys are each named, with no count row', () => {
    const rows = unknownFieldWarnings(bodyOf(10), KNOWN);
    assert.equal(rows.length, 10);
    assert.deepEqual(rows.map(r => r.field), Object.keys(bodyOf(10)));
    assert.doesNotMatch(JSON.stringify(rows), /…\(\+\d+ more\)|left out/);
  });

  it('a row still says what the route accepts, from the shared keys and the route\'s own', () => {
    const [row] = unknownFieldWarnings({ bogus: 1 }, KNOWN);
    assert.equal(row.field, 'bogus');
    assert.equal(row.value, 1);
    for (const k of [...KNOWN, ...SHARED_WRITE_BODY_KEYS]) assert.ok(row.reason.includes(k), `the reason does not list the accepted key ${k}`);
  });

  it('a megabyte unknown key is named at NAME_QUOTED', () => {
    const [row] = unknownFieldWarnings({ [HUGE]: 1 }, KNOWN);
    assert.equal(row.field, peerText(HUGE, { max: NAME_QUOTED }));
    assert.match(row.field, CUT);
  });

  it('a megabyte STRING value is not echoed whole (the row is a warning, not a reflection of the payload)', () => {
    const [row] = unknownFieldWarnings({ bogus: HUGE }, KNOWN);
    assert.ok(JSON.stringify(row).length < 2 * LOG_VALUE_MAX, `the row is ${JSON.stringify(row).length} characters`);
  });

  it('the accepted list is built once, not once per unknown key', () => {
    // Counted at the one primitive a per-key rebuild must call: the sort of the accepted keys.
    let sorts = 0;
    const original = Array.prototype.sort;
    Array.prototype.sort = function counted(...args) { sorts++; return original.apply(this, args); };
    try { unknownFieldWarnings(bodyOf(500), KNOWN); } finally { Array.prototype.sort = original; }
    assert.ok(sorts <= 1, `the accepted list was sorted ${sorts} times for 500 unknown keys — it is rebuilt per key`);
  });
});
