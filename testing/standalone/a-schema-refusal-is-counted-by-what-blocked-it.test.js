/**
 * A schema refusal is counted by what blocked it, and every outcome the metric declares is one some refusal can have (F-46, ruling R6-13).
 *
 * ## What it prevents
 *
 * `ythril_schema_refusals_total{door,outcome}` declares its outcomes at 0 from process start, so "absent" and "0" never mean opposite
 * things on a graph. That promise is only worth something if each declared outcome can be COUNTED: `countSchemaRefusal` told an undeclared
 * key from everything else, so a write refused by a rule, by a rule that could not be evaluated or by a record too large to check was
 * counted as `property` — and `rule`, `could_not_evaluate` and `too_large` read 0 for ever on a dashboard, beside a `refused_name` nothing
 * produced at all. An operator reading the graph would conclude no rule had ever refused a write.
 *
 * ## What is asserted
 *
 * 1. Each refusal, made by the real validator and the real classifier, moves exactly the counter of its own outcome.
 * 2. **G4** — every outcome the metric declares is one of those: derived from `SCHEMA_REFUSAL_OUTCOMES` (never listed here), each must
 *    be produced by a case below, so an outcome added to the declaration with no path that produces it is red.
 *
 * Run: node --test testing/standalone/a-schema-refusal-is-counted-by-what-blocked-it.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rule, strictMeta, recordOf, evaluation, DECLARED, REPO_DIST } from './_cel-rules.mjs';

const { SCHEMA_REFUSAL_OUTCOMES, schemaRefusalCounts } = await import(`${REPO_DIST}brain/schema-refusal-tally.js`);

const ENUMED = { ...DECLARED, status: { type: 'string', enum: ['open', 'closed'] } };
const metaWith = (rules) => strictMeta({ rules, propertySchemas: ENUMED });

/** One write per outcome, as a client would send it: the stored record it lands on is a sound one. */
const CASES = {
  undeclared: [metaWith(undefined), { properties: { notDeclared: 'x' } }],
  property: [metaWith(undefined), { properties: { status: 'neither' } }],
  rule: [metaWith({ below: rule('self.properties.b < 100.0', 'b must be below one hundred') }), { properties: { b: 500 } }],
  // `a` is a declared string, so the record breaks nothing but the rule — which compares it with a number and cannot run.
  could_not_evaluate: [metaWith({ compared: rule('self.properties.a < 100.0', 'a must be below one hundred') }), { properties: { a: 'text' } }],
  too_large: [metaWith({ filled: rule('size(self.properties.a) > 0', 'a must not be empty') }), { properties: { a: 'x'.repeat(10_001) } }],
};

const counts = () => new Map(schemaRefusalCounts().filter(c => c.door === 'rest').map(c => [c.outcome, c.count]));

/** Refuse the write through the classifier every write goes through, and count it where REST answers it. */
async function countedAs(meta, write) {
  const { writeValidation } = await evaluation();
  const check = writeValidation.classifyEntityUpsertAgainst(meta, recordOf.entity({ properties: {} }), { name: 'Acme', type: 'thing', ...write });
  assert.equal(check.blocked, true, `the fixture is not refused: ${JSON.stringify(check.introduced).slice(0, 300)}`);
  const before = counts();
  writeValidation.connectionRefusalAnswer(new writeValidation.SchemaViolationError(check), 'update');
  const after = counts();
  return [...after].filter(([o, n]) => n !== before.get(o)).map(([o, n]) => [o, n - (before.get(o) ?? 0)]);
}

describe('a refusal is counted by what blocked it', () => {
  for (const [outcome, [meta, write]] of Object.entries(CASES)) {
    it(`${outcome}: moves its own counter by one and no other`, async () => {
      assert.deepEqual(await countedAs(meta, write), [[outcome, 1]]);
    });
  }
});

describe('every outcome the metric declares is one a refusal can have (G4)', () => {
  it('the declaration is found, and holds the outcomes a rule adds (a floor, so an empty list is not a clean one)', () => {
    assert.ok(SCHEMA_REFUSAL_OUTCOMES.length >= 4, `only ${SCHEMA_REFUSAL_OUTCOMES.length} outcome(s) declared: the import is broken`);
  });

  it('each declared outcome is produced by a refusal above', () => {
    const produced = new Set(Object.keys(CASES));
    assert.deepEqual(SCHEMA_REFUSAL_OUTCOMES.filter(o => !produced.has(o)), [],
      'these outcomes are declared at 0 and no refusal produces them: a graph of them reads "never happened" for ever');
  });
});
