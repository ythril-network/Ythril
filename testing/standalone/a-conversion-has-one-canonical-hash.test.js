/**
 * One `convertRecords` has one canonical text, so one hash, on every member whatever order its keys were written in (Q-745, bundle-284
 * design r4 sections 1.1 and 1.5).
 *
 * ## The defect this prevents
 *
 * The steps of a conversion travel with a vote round and are bound to the proposer by a signature over a HASH of them (design 2.4). A
 * member that receives the same steps with their keys in another order (a relayer that re-serialises, a client that builds the object
 * another way) would hash another text, fail the signature and treat the steps as unsigned. The text is `canonicalJson` of the PARSED
 * form: keys sorted at every level, an absent optional key and an `undefined` one the same, and a body that does not parse has no text at
 * all, so no caller can hash what it never validated.
 *
 * ## What is held
 *
 * - Two key orders of one `convertRecords`, at every level (the body, a step, a `values` map, a case), give one text and one sha256.
 * - The text IS `canonicalJson` of what `ConvertRecordsZ` parses to: there is no second serialiser.
 * - Different content gives different text: another value, another case order, another step order. (The ARRAYS keep their order: it is the
 *   proposer's list, and the order steps apply in is fixed by `convertedRecord` anyway.)
 * - A body that does not parse (an unknown key, an unknown op, over a bound) throws, and the throw names the refusal.
 *
 * Seen red on afb6eb8c: `schema/dist/internal.js` exports neither `ConvertRecordsZ` nor `canonicalConvertRecordsText`, so every case fails on that.
 *
 * Run: node --test testing/standalone/a-conversion-has-one-canonical-hash.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import * as pkg from '../../schema/dist/internal.js';

const { canonicalConvertRecordsText, ConvertRecordsZ, canonicalJson } = pkg;
const sha256 = (text) => createHash('sha256').update(text, 'utf8').digest('hex');

/** The same value with the keys of every object written in reverse order. */
const reversedKeys = (v) => {
  if (Array.isArray(v)) return v.map(reversedKeys);
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).reverse().map(([k, x]) => [k, reversedKeys(x)]));
  return v;
};

const STEPS = [
  { op: 'renameProperty', kind: 'entity', type: 'person', from: 'name', to: 'fullName' },
  { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { open: 'OPEN', wip: 'WIP', done: 'DONE' } },
  { op: 'renameType', kind: 'edge', from: 'knows', to: 'knew' },
  { op: 'splitType', kind: 'entity', from: 'company', cases: [{ when: 'self.properties.size > 9', to: 'large' }, { when: 'self.properties.size > 3', to: 'medium' }], otherwise: 'small' },
];
const ONE = { steps: STEPS };

describe('one convertRecords, one text', () => {
  it('two key orders at every level give one text and one hash', () => {
    const a = canonicalConvertRecordsText(ONE);
    const b = canonicalConvertRecordsText(reversedKeys(ONE));
    assert.equal(typeof a, 'string');
    assert.equal(a, b);
    assert.equal(sha256(a), sha256(b));
    assert.ok(JSON.stringify(reversedKeys(ONE)) !== JSON.stringify(ONE), 'fixture: the two inputs are written differently');
  });

  it('the text is canonicalJson of the parsed body: there is no second serialiser', () => {
    const parsed = ConvertRecordsZ.parse(reversedKeys(ONE));
    assert.equal(canonicalConvertRecordsText(reversedKeys(ONE)), canonicalJson(parsed));
    assert.deepEqual(JSON.parse(canonicalConvertRecordsText(ONE)), JSON.parse(JSON.stringify(ONE)), 'the text says what the body says');
    const text = canonicalConvertRecordsText(ONE);
    const mapAt = text.indexOf('"values"');
    assert.ok(text.indexOf('"done"', mapAt) < text.indexOf('"open"', mapAt), 'keys are sorted inside a values map');
  });

  it('an absent optional key and an undefined one are one text; `{}` is its own text', () => {
    const withUndefined = { steps: [{ ...STEPS[3], otherwise: undefined }] };
    const without = { steps: [(({ otherwise, ...rest }) => rest)(STEPS[3])] };
    assert.equal(canonicalConvertRecordsText(withUndefined), canonicalConvertRecordsText(without));
    assert.equal(canonicalConvertRecordsText({}), '{}');
    assert.notEqual(canonicalConvertRecordsText({}), canonicalConvertRecordsText(ONE));
  });

  it('different content is different text: a value, a case order, a step order', () => {
    const base = canonicalConvertRecordsText(ONE);
    const otherValue = structuredClone(ONE);
    otherValue.steps[1].values.open = 'Open';
    const otherCases = structuredClone(ONE);
    otherCases.steps[3].cases.reverse();
    const otherSteps = { steps: [...STEPS].reverse() };
    const texts = [base, ...[otherValue, otherCases, otherSteps].map(canonicalConvertRecordsText)];
    assert.equal(new Set(texts).size, texts.length, 'four contents, four texts');
  });
});

describe('a body that does not parse has no text', () => {
  it('throws for an unknown key, an unknown op, and a step over a bound', () => {
    const bad = [
      { steps: STEPS, extra: true },
      { steps: [{ op: 'dropEverything', kind: 'entity', from: 'a' }] },
      { steps: Array.from({ length: pkg.CONVERSION_STEPS_MAX + 1 }, (_, i) => ({ op: 'renameType', kind: 'entity', from: `a${i}`, to: `b${i}` })) },
      { steps: [{ ...STEPS[0], from: 7 }] },
      'steps',
      null,
    ];
    for (const body of bad) {
      assert.throws(() => canonicalConvertRecordsText(body), (err) => err instanceof Error && err.message.length > 0, JSON.stringify(body).slice(0, 60));
      assert.equal(ConvertRecordsZ.safeParse(body).success, false);
    }
  });

  it('a body that parses is not changed by asking for its text', () => {
    const body = structuredClone(ONE);
    const before = JSON.stringify(body);
    canonicalConvertRecordsText(body);
    assert.equal(JSON.stringify(body), before);
  });
});
