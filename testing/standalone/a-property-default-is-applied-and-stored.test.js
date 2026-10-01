/**
 * A declared `default` fills in an omitted property, satisfies `required`, and is the value STORED.
 *
 * ## What it was
 *
 * `PropertySchema.default` was declared in the interface, documented in the integration guide, and editable in
 * the settings UI — and **read by nothing in the entire server**. An operator could set one, save it, and it did
 * nothing for ever, with no hint that it had not taken.
 *
 * Owner, 2026-08-29: *"thats not a decicion, thats a bugfix."* The product already promised the behaviour, so
 * there was never a choice about direction — only about where the filling happens.
 *
 * ## The three properties that make it right, each pinned below
 *
 * 1. **Before validation.** A property that is `required` AND has a `default` must not be a violation — the
 *    default is what satisfies the requirement. Filling after validation would refuse writes the schema was
 *    designed to accept.
 * 2. **Never overrides.** A caller who said something keeps what they said, including a falsy value.
 * 3. **On insert, not on update.** On an update an absent property may be one the caller has just removed, so
 *    filling it would resurrect a deliberate deletion. That is checked in the edge planner (`brain/write-plan/plan-edge.ts`) rather than here.
 *
 * Run: node --test testing/standalone/a-property-default-is-applied-and-stored.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, statementAround } from './_structural-window.mjs';

const { applyPropertyDefaults, validateEdge } = await import('../../server/dist/spaces/schema-validation.js');

/**
 * The edge write's DECISION lives in its planner since Q-99 part 3: `upsertEdge` is a door that hands `planEdge`
 * a read set, and `bulkWrite` plans its edges through the same function — so the planner is the one place both
 * doors' defaults are decided, and the place this reads.
 */
function planEdgeBody() {
  const src = stripComments(readFileSync('server/src/brain/write-plan/plan-edge.ts', 'utf8'));
  return bodyOf(src, 'planEdge');
}

const SCHEMA = {
  propertySchemas: {
    status: { type: 'string', default: 'draft' },
    weight: { type: 'number', default: 0 },
    reviewed: { type: 'boolean', default: false },
    mandatory: { type: 'string', required: true, default: 'filled-in' },
    open: { type: 'string' },
  },
};

describe('a property default is applied and stored', () => {
  it('fills a property the caller omitted', () => {
    const out = applyPropertyDefaults(SCHEMA, { open: 'x' });
    assert.equal(out.status, 'draft');
    assert.equal(out.open, 'x', 'what the caller sent must survive');
  });

  it('fills falsy defaults too', () => {
    // `0` and `false` are the values a truthiness check silently drops, and both are legitimate defaults.
    const out = applyPropertyDefaults(SCHEMA, {});
    assert.equal(out.weight, 0, 'a numeric default of 0 must be applied');
    assert.equal(out.reviewed, false, 'a boolean default of false must be applied');
  });

  it('never overrides what the caller said, including a falsy value', () => {
    const out = applyPropertyDefaults(SCHEMA, { status: 'published', weight: 5, reviewed: true });
    assert.equal(out.status, 'published');
    assert.equal(out.weight, 5);
    assert.equal(out.reviewed, true);
  });

  it('a default satisfies `required` — so the order is defaults THEN validation', () => {
    const filled = applyPropertyDefaults(SCHEMA, {});
    const violations = validateEdge(
      { validationMode: 'strict', typeSchemas: { edge: { supersedes: SCHEMA } } },
      { label: 'supersedes', properties: filled },
    );
    assert.deepEqual(
      violations.filter(v => v.field === 'mandatory'), [],
      'a property that is required AND defaulted must not be a violation — validating before filling would '
      + 'refuse a write the schema was written to accept',
    );
  });

  it('a schema with no propertySchemas is left exactly alone', () => {
    const props = { a: 1 };
    assert.equal(applyPropertyDefaults(undefined, props), props, 'must return the same object, not a copy');
    assert.equal(applyPropertyDefaults({}, props), props);
  });

  it('the write path stores the DEFAULTED values, not the caller original', () => {
    /*
     * The defect this guards is the one already found in memory upserts: validate one document, store another.
     * Filling defaults and then writing the untouched input would pass every assertion above and persist
     * nothing.
     */
    const body = planEdgeBody();
    assert.match(body, /applyPropertyDefaults\(/, 'planEdge does not apply defaults at all');
    const stored = body.slice(body.indexOf('const effectiveProps'));
    assert.match(
      stored.slice(0, stored.indexOf('\n')), /withDefaults/,
      'the stored properties come from the caller input rather than the defaulted document, so a default is '
      + 'validated and then thrown away',
    );
  });

  it('defaults apply on INSERT only, so an update cannot resurrect a deletion', () => {
    const body = planEdgeBody();
    // The whole statement, not a hand-sliced line: the call is the false branch of a three-line ternary, and
    // counting newlines backwards to find its start is exactly the fragility this suite keeps catching.
    const at = body.indexOf('applyPropertyDefaults(');
    assert.notEqual(at, -1, 'planEdge no longer applies defaults — re-point this gate');
    const stmt = statementAround(body, at, 'the defaults statement');
    assert.match(
      stmt, /existing/,
      'the defaults must be conditional on there being no existing record. On an update an absent property may '
      + 'be one `deleteFields` has just removed, and filling it would silently undo a deliberate deletion.',
    );
  });
});
