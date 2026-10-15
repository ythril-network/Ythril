/**
 * The judge answers an unknown top-level field by what happened to the write, names it once, and stays bounded
 * (bundle-128, Q-320; design-v3 section 2.2 and section 8.3 "near-miss distance function").
 *
 * ## What it prevents
 *
 * Both doors ask ONE module whether a write carries a field the write does not take: `answerUnknownWriteFields` in
 * `contract/write-accepts.ts`. A row it builds is what a caller reads while deciding whether its integration is wrong, so the
 * three halves a hand-written copy would drop are asserted here, per OUTCOME and not per site:
 *
 * - **the wording is by outcome**: stored is `unknown field — ignored`, refused (by the judge or for another reason) is
 *   `unknown field — not accepted`, and the stable `code` is `unknown_field` either way;
 * - **no `value` on a refusal**: `03-auth-and-limits.md` promises no received value is reflected on a refusal, so the row builder
 *   omits it itself, and a stored answer carries it (bounded);
 * - **the accepted list appears ONCE per answer**, not once per row;
 * - **the near-miss hint is bounded**: only the rowed keys, at distance <= 2 or a case-only difference, and a megabyte key costs
 *   a bounded amount of time (V7);
 * - **more than ten names is ten rows and a `(+N more)` row**, and a body that is not a plain object is judged as nothing.
 *
 * ## The near-miss function is tested through the judge
 *
 * The plan names the distance function's threshold, band, early exit and length skip but gives it no export. A test that imported
 * an unplanned name would go red for the wrong reason, so the rule is asserted where it is observable: the row's reason. The
 * oracle for "how far is this key from that one" is the Levenshtein distance written in THIS file, independent of the code under
 * test (a fixture that derived its expectation from the module would assert the module equals itself).
 *
 * ## Red on the unchanged base
 *
 * `server/dist/contract/write-accepts.js` does not exist on the base, so every case fails on the import in `before`. That is the
 * planned red for this file: the module is what the change creates.
 *
 * Run: node --test testing/standalone/the-unknown-write-field-judge-answers-by-outcome-and-stays-bounded.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openUnknownWriteFieldsConfig, WARN_SPACE, REFUSE_SPACE } from './_unknown-write-fields-config.mjs';

const DASH = '—';
const IGNORED = `unknown field ${DASH} ignored`;
const NOT_ACCEPTED = `unknown field ${DASH} not accepted`;
/** Keys that are addressing, never body keys of a write: the judge does not count them as accepted. */
const ADDRESSING = new Set(['space', 'targetSpace']);
const OPERATION = 'entity.create';
const TOOL = 'save_entity';

let cfg, judge, retired, acceptedByTool;

/** Plain Levenshtein distance. The oracle: independent of the judge. */
function levenshtein(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, j) => j);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    for (let j = 1; j <= b.length; j++) {
      cur[j] = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
    }
    prev = cur;
  }
  return prev[b.length];
}

/** The keys the paired tool's schema declares, minus addressing: what a `save_entity` body accepts. Read from the tool, not listed. */
async function acceptedKeysOf(toolName) {
  const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
  const tool = ALL_TOOLS.find(t => t.name === toolName);
  const schema = tool.inputSchema({ requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } });
  return Object.keys(schema.properties).filter(k => !ADDRESSING.has(k));
}

const valid = { name: 'Acme', type: 'concept' };
const judgeOn = (space, body, door = 'rest') => judge.answerUnknownWriteFields(body, OPERATION, space, door);

describe('the judge answers an unknown field by the outcome of the write', () => {
  before(async () => {
    cfg = await openUnknownWriteFieldsConfig({ suite: 'b128-judge' });
    judge = await import('../../server/dist/contract/write-accepts.js');
    ({ RETIRED_WRITE_FIELDS: retired } = await import('../../server/dist/brain/retired-write-fields.js'));
    acceptedByTool = await acceptedKeysOf(TOOL);
  });
  after(() => cfg?.close());

  it('the fixture is sound: the accepted keys are found, and the names the cases send are not among them', () => {
    assert.ok(acceptedByTool.length >= 10, `only ${acceptedByTool.length} accepted keys read from ${TOOL}: the reader is wrong, not the code`);
    for (const k of ['zz', 'yy', 'unknownOne']) assert.ok(!acceptedByTool.includes(k), `${k} is accepted by ${TOOL}: pick another unknown name`);
  });

  it('under warn: the write proceeds, and each unknown field is a row that says it was ignored and carries its value', () => {
    const r = judgeOn(WARN_SPACE, { ...valid, zz: 1, yy: 'a string' });
    assert.equal(r.refused, false, 'a space with no setting warns: it must not refuse');
    assert.deepEqual(r.rows.map(x => x.field), ['zz', 'yy'], 'one row per unknown field, in the order the body carries them');
    for (const row of r.rows) {
      assert.equal(row.code, 'unknown_field', `row for ${row.field} has no stable code`);
      assert.ok(row.reason.startsWith(IGNORED), `row for ${row.field} says ${JSON.stringify(row.reason)}, not ${JSON.stringify(IGNORED)}`);
    }
    assert.equal(r.rows[0].value, 1);
    assert.equal(r.rows[1].value, 'a string');
  });

  it('under refuse: the judge refuses, each row says it was not accepted, and NO row carries a value', () => {
    const r = judgeOn(REFUSE_SPACE, { ...valid, zz: 1, yy: 'a secret-looking value' });
    assert.equal(r.refused, true, 'a space set to refuse must refuse');
    assert.deepEqual(r.rows.map(x => x.field), ['zz', 'yy']);
    for (const row of r.rows) {
      assert.equal(row.code, 'unknown_field');
      assert.ok(row.reason.startsWith(NOT_ACCEPTED), `row for ${row.field} says ${JSON.stringify(row.reason)}, not ${JSON.stringify(NOT_ACCEPTED)}`);
      assert.ok(!('value' in row), `the refusal row for ${row.field} reflects the received value: no value may ride a refusal`);
    }
  });

  it('the accepted-key list appears once per answer, in the first row, and names every key the paired tool declares', () => {
    for (const space of [WARN_SPACE, REFUSE_SPACE]) {
      const r = judgeOn(space, { ...valid, zz: 1, yy: 2, unknownOne: 3 });
      const listed = r.rows.filter(x => x.reason.includes('This write accepts:'));
      assert.deepEqual(listed.map(x => x.field), ['zz'], `${space}: the list must be on the FIRST row and on no other`);
      for (const k of acceptedByTool) assert.ok(listed[0].reason.includes(k), `${space}: the accepted list omits ${k}, a key ${TOOL} declares`);
      for (const k of ADDRESSING) assert.ok(!new RegExp(`accepts:.*\\b${k}\\b`).test(listed[0].reason), `${space}: addressing key ${k} listed as a body key`);
    }
  });

  it('a body with no unknown field is judged as nothing, in both modes', () => {
    for (const space of [WARN_SPACE, REFUSE_SPACE]) {
      const r = judgeOn(space, { ...valid, description: 'fine' });
      assert.deepEqual(r.rows, [], `${space}: invented rows for a body whose every key is accepted`);
      assert.equal(r.refused, false);
    }
  });

  it('a body that is not a plain object judges nothing and does not throw (the judge is total)', () => {
    for (const body of [undefined, null, 'text', 42, [1, 2], [{ zz: 1 }]]) {
      for (const space of [WARN_SPACE, REFUSE_SPACE]) {
        const r = judgeOn(space, body);
        assert.deepEqual(r.rows, [], `${JSON.stringify(body)} in ${space}: rows were invented for something that is not a bag of keys`);
        assert.equal(r.refused, false);
      }
    }
  });

  it('a retired name is refused in every mode, and the unknown rows ride along as not accepted, without a value', () => {
    const names = Object.keys(retired).filter(n => !acceptedByTool.includes(n));
    assert.ok(names.length >= 1, 'no retired name that save_entity does not accept: re-anchor');
    for (const space of [WARN_SPACE, REFUSE_SPACE]) {
      for (const name of names) {
        const r = judgeOn(space, { ...valid, [name]: [], zz: 'kept out of the answer' });
        assert.equal(r.refused, true, `${name} in ${space}: a retired name is refused whatever the mode`);
        const row = r.rows.find(x => x.field === 'zz');
        assert.ok(row, `${name} in ${space}: the unknown key is not named beside the retired refusal`);
        assert.ok(row.reason.startsWith(NOT_ACCEPTED), `the write was refused, so the row says ${JSON.stringify(row.reason)}`);
        assert.ok(!('value' in row), 'a refusal row carries no value');
      }
    }
  });

  it('a key that is a name on Object.prototype is an unknown key like any other (membership is a Set lookup, not `in`)', () => {
    const body = JSON.parse('{"name":"Acme","type":"concept","constructor":1,"__proto__":{"x":1},"toString":2}');
    const r = judgeOn(WARN_SPACE, body);
    const named = r.rows.map(x => x.field);
    for (const k of ['constructor', '__proto__', 'toString']) assert.ok(named.includes(k), `${k} was treated as an accepted key: ${JSON.stringify(named)}`);
  });
});

describe('the judge bounds what it names', () => {
  before(async () => {
    cfg = await openUnknownWriteFieldsConfig({ suite: 'b128-judge-bounds' });
    judge = await import('../../server/dist/contract/write-accepts.js');
    acceptedByTool = await acceptedKeysOf(TOOL);
  });
  after(() => cfg?.close());

  /** `n` distinct unknown names that are far from every accepted key, so no near-miss hint competes with the bound. */
  const manyUnknown = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`qqqq_unknown_field_number_${String(i).padStart(3, '0')}`, i]));

  it('ten unknown names are ten rows; eleven are ten rows and one `(+1 more)` row; twelve say how many were left out', () => {
    for (const space of [WARN_SPACE, REFUSE_SPACE]) {
      const ten = judgeOn(space, { ...valid, ...manyUnknown(10) }).rows;
      assert.equal(ten.length, 10, `${space}: exactly ten names must be ten rows and no summary row`);
      assert.ok(ten.every(x => !x.field.includes('more')), `${space}: a summary row for exactly ten names`);

      const eleven = judgeOn(space, { ...valid, ...manyUnknown(11) }).rows;
      assert.equal(eleven.length, 11, `${space}: eleven names are ten rows plus one summary row`);
      assert.equal(eleven[10].field, '…(+1 more)');
      assert.equal(eleven[10].code, 'unknown_field', 'the summary row carries the stable code too');

      const twelve = judgeOn(space, { ...valid, ...manyUnknown(12) }).rows;
      assert.equal(twelve[10].field, '…(+2 more)');
      if (space === REFUSE_SPACE) assert.ok(!('value' in twelve[10]), 'the summary row of a refusal carries no value either');
    }
  });

  it('the accepted list is on one row of an eleven-name answer, not on eleven', () => {
    const rows = judgeOn(WARN_SPACE, { ...valid, ...manyUnknown(11) }).rows;
    assert.equal(rows.filter(x => x.reason.includes('This write accepts:')).length, 1);
  });

  it('a hostile key is cut to the bound a refusal quotes a name by, and cannot forge a line', () => {
    const huge = `forged\r\nINJECTED ${'x'.repeat(50_000)}`;
    const r = judgeOn(WARN_SPACE, { ...valid, [huge]: 1 });
    assert.equal(r.rows.length, 1);
    assert.ok(r.rows[0].field.length < 1_000, `the field was echoed at ${r.rows[0].field.length} characters`);
    assert.ok(!/[\r\n]/.test(r.rows[0].field), 'a line break in a caller-chosen key survived into the row');
    assert.ok(!/[\r\n]/.test(r.rows[0].reason), 'a line break reached the reason');
  });
});

describe('the near-miss hint fires for one or two edits or a case-only difference, and never beyond', () => {
  /** The accepted key every variant is made from: the longest, so no variant sits nearer another key. Derived, not named. */
  let key;
  /** `variant` is judged to be `distance` from `key` and from no accepted key nearer. */
  const hintOf = (variant) => {
    const r = judgeOn(WARN_SPACE, { ...valid, [variant]: 1 });
    assert.equal(r.rows.length, 1, `${variant}: expected one row`);
    return r.rows[0].reason;
  };
  const says = (key_) => ` ${DASH} did you mean '${key_}'?`;

  before(async () => {
    cfg = await openUnknownWriteFieldsConfig({ suite: 'b128-judge-nearmiss' });
    judge = await import('../../server/dist/contract/write-accepts.js');
    acceptedByTool = await acceptedKeysOf(TOOL);
    key = [...acceptedByTool].sort((a, b) => b.length - a.length)[0];
  });
  after(() => cfg?.close());

  /** Every accepted key's distance to `variant`: the oracle says the hint names `key` only if `key` is the unique nearest within 2. */
  const nearest = (variant) => acceptedByTool
    .map(k => ({ k, d: levenshtein(variant, k) })).sort((a, b) => a.d - b.d);

  it('one deletion (distance 1) carries the hint naming the key', () => {
    const variant = key.slice(0, 4) + key.slice(5);
    assert.equal(nearest(variant)[0].k, key);
    assert.equal(nearest(variant)[0].d, 1);
    assert.ok(hintOf(variant).includes(says(key)), `no hint for ${variant}, one edit from ${key}: ${hintOf(variant)}`);
  });

  it('two substitutions (distance 2) carry the hint', () => {
    const variant = `${key.slice(0, 3)}__${key.slice(5)}`;
    assert.ok(nearest(variant)[0].k === key && nearest(variant)[0].d === 2, `fixture: ${variant} is not exactly 2 from ${key} and nearer to nothing else`);
    assert.ok(hintOf(variant).includes(says(key)), `no hint for ${variant}, two edits from ${key}`);
  });

  it('a case-only difference carries the hint, though a distance of the length of the key', () => {
    const variant = key.toUpperCase();
    assert.notEqual(variant, key);
    assert.ok(hintOf(variant).includes(says(key)), `no hint for ${variant}, ${key} in another case`);
  });

  it('three substitutions (distance 3) carry no hint', () => {
    const variant = `${key.slice(0, 3)}___${key.slice(6)}`;
    assert.ok(nearest(variant)[0].d >= 3, `fixture: ${variant} is within 2 of ${nearest(variant)[0].k}`);
    assert.ok(!hintOf(variant).includes('did you mean'), `a hint for ${variant}, three edits from every accepted key`);
  });

  it('a key three characters longer (the length skip) carries no hint, and is still named as unknown', () => {
    const variant = `${key}xyz`;
    assert.ok(nearest(variant)[0].d >= 3);
    const reason = hintOf(variant);
    assert.ok(!reason.includes('did you mean'), `a hint for ${variant}, three characters longer than ${key}`);
    assert.ok(reason.startsWith(IGNORED));
  });

  it('a key near nothing carries no hint', () => {
    assert.ok(!hintOf('zzzzzzzz').includes('did you mean'));
  });

  it('the hint rides a refusal as well, and still carries no value', () => {
    const variant = key.slice(0, 4) + key.slice(5);
    const r = judgeOn(REFUSE_SPACE, { ...valid, [variant]: 1 });
    assert.equal(r.refused, true);
    assert.ok(r.rows[0].reason.startsWith(NOT_ACCEPTED));
    assert.ok(r.rows[0].reason.includes(says(key)), 'the suggestion is for the refused call too: that is when it is needed');
    assert.ok(!('value' in r.rows[0]));
  });

  it('ten megabyte keys are answered within a time bound (a distance computed on the whole key would not be)', () => {
    const body = { ...valid };
    for (let i = 0; i < 10; i++) body[`${key.slice(0, 5)}${i}${'x'.repeat(1_000_000)}`] = 1;
    const t0 = Date.now();
    const r = judgeOn(WARN_SPACE, body);
    const took = Date.now() - t0;
    assert.equal(r.rows.length, 10);
    assert.ok(took < 5_000, `ten one-megabyte keys took ${took} ms: the near-miss distance is not bounded by the cut key`);
  });
});

describe('the judge reads the target space it is handed, and no other', () => {
  before(async () => {
    cfg = await openUnknownWriteFieldsConfig({ suite: 'b128-judge-target' });
    judge = await import('../../server/dist/contract/write-accepts.js');
  });
  after(() => cfg?.close());

  it('one body, two spaces: the answer follows the space the write lands in', () => {
    const body = { ...valid, zz: 1 };
    assert.equal(judgeOn(WARN_SPACE, body).refused, false);
    assert.equal(judgeOn(REFUSE_SPACE, body).refused, true);
    assert.equal(judgeOn(WARN_SPACE, body).refused, false, 'sandwich: the first read still holds, so the second was compared to a stable value');
  });

  it('the door only names the caller: the rows are the same whichever door asked', () => {
    const body = { ...valid, zz: 1, yy: 'v' };
    const rest = judgeOn(REFUSE_SPACE, body, 'rest').rows;
    for (const door of ['mcp', 'tool']) assert.deepEqual(judgeOn(REFUSE_SPACE, body, door).rows, rest, `door ${door} words the rows differently from REST`);
  });
});

describe('the unrecognized-keys issue is built in ONE place, for a failed parse and for the judge (probe P30)', () => {
  let log;
  before(async () => { log = await import('../../server/dist/util/log.js'); });

  const names = (n) => Array.from({ length: n }, (_, i) => `unknown_key_${String(i).padStart(2, '0')}`);

  it('util/log.ts exports unrecognizedKeysIssue, extracted from the rendering refusalOfParse does (not copied beside it)', () => {
    assert.equal(typeof log.unrecognizedKeysIssue, 'function', 'util/log.ts exports no unrecognizedKeysIssue(keys)');
  });

  it('it builds the very issue refusalOfParse puts in `issues`, bounded to the ten names a refusal shows', () => {
    const keys = names(12);
    const built = log.unrecognizedKeysIssue(keys);
    const refusal = log.refusalOfParse({ issues: [{ code: 'unrecognized_keys', path: [], keys }] });
    // Shape-agnostic: the issue may be returned bare or inside a wrapper, but it is the same object a failed parse answers with.
    assert.ok(JSON.stringify(built).includes(JSON.stringify(refusal.issues[0])),
      `unrecognizedKeysIssue builds ${JSON.stringify(built)}, not the issue refusalOfParse answers with: ${JSON.stringify(refusal.issues[0])}`);
    assert.equal(refusal.issues[0].keys.length, 10);
    assert.ok(!JSON.stringify(built).includes(keys[10]), 'the eleventh name was not cut: the bound is not the shared one');
  });

  it('a hostile key is cut to the bound a refusal quotes a name by', () => {
    const built = JSON.stringify(log.unrecognizedKeysIssue([`k${'x'.repeat(100_000)}`]));
    assert.ok(built.length < 2_000, `the issue carries a key at ${built.length} characters`);
  });
});
