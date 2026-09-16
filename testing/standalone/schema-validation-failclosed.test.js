/**
 * A broken `$ref` produces a violation — it never validates as "no constraints".
 *
 * `spaces/schema-validation.ts` had no importing test at all. The rule that most needed one is the
 * fail-closed branch: when a type's `$ref` points at a library entry that does not exist,
 * `resolveMetaRefs` stamps `_unresolvedRef` and every `validate*` must report it and STOP.
 *
 * The failure it guards against is silent and inverted. An unresolved `$ref` leaves a type with no
 * naming pattern, no required properties and no property schemas — so the natural, permissive reading is
 * "nothing to check, this record is fine". A space running `validationMode: 'strict'` would then accept
 * everything for that type, and the only symptom is data that should have been rejected quietly getting
 * in. Deleting a library entry that spaces still reference is an ordinary admin action that causes it.
 *
 * The tests below therefore assert both halves for every knowledge type: the violation is raised, AND
 * validation does not continue past it (which would produce a second, misleading violation about a
 * naming pattern or a missing property that the schema no longer actually declares).
 *
 * Run: node --test testing/standalone/schema-validation-failclosed.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let validateEntity, validateEdge, validateFact, validateChrono;

before(async () => {
  ({ validateEntity, validateEdge, validateFact, validateChrono } =
    await import('../../server/dist/spaces/schema-validation.js'));
});

/** Meta as `resolveMetaRefs` leaves it when the referenced library entry is gone. */
const brokenRef = (kind, typeName) => ({
  typeSchemas: { [kind]: { [typeName]: { _unresolvedRef: 'library:vanished' } } },
});

/** A resolvable schema for the same type, to prove the tests are not passing by accident. */
const workingSchema = (kind, typeName) => ({
  typeSchemas: { [kind]: { [typeName]: { namingPattern: '^ok-', propertySchemas: { owner: { required: true } } } } },
});

const refViolation = vs => vs.find(v => v.field === '$ref');

describe('an unresolved $ref fails closed, per knowledge type', () => {
  it('entity: reports the broken ref and does not fall through to the rest of the checks', () => {
    const vs = validateEntity(brokenRef('entity', 'service'), { name: 'anything', type: 'service', properties: {} });
    const ref = refViolation(vs);
    assert.ok(ref, 'a broken $ref must be a violation, not an absence of constraints');
    assert.equal(ref.value, 'library:vanished');
    assert.match(ref.reason, /not found/);
    // Nothing else is reported: the schema's real rules are unknown, so inventing verdicts from the
    // empty husk left behind would be noise at best and wrong at worst.
    assert.deepEqual(vs.filter(v => v.field !== '$ref'), []);
  });

  it('edge: same, keyed by label', () => {
    const vs = validateEdge(brokenRef('edge', 'depends_on'), { label: 'depends_on', properties: {} });
    assert.ok(refViolation(vs));
    assert.deepEqual(vs.filter(v => v.field !== '$ref'), []);
  });

  it('memory: same', () => {
    const vs = validateFact(brokenRef('fact', 'decision'), { type: 'decision', properties: {} });
    assert.ok(refViolation(vs));
  });

  it('chrono: same', () => {
    const vs = validateChrono(brokenRef('chrono', 'milestone'), { type: 'milestone', properties: {} });
    assert.ok(refViolation(vs));
  });
});

describe('the fail-closed branch is not swallowing everything', () => {
  it('a RESOLVED schema still enforces its own rules', () => {
    // If this passed too, the tests above would prove nothing — a validator that rejects every record
    // would satisfy them.
    const vs = validateEntity(workingSchema('entity', 'service'), { name: 'bad-name', type: 'service', properties: {} });
    assert.equal(refViolation(vs), undefined, 'no $ref violation when the schema resolved');
    assert.ok(vs.some(v => v.field === 'name'), 'the naming pattern must still be checked');
    assert.ok(vs.some(v => v.field.includes('owner')), 'the required property must still be checked');
  });

  it('a record that satisfies a resolved schema produces no violations at all', () => {
    const vs = validateEntity(workingSchema('entity', 'service'), {
      name: 'ok-svc', type: 'service', properties: { owner: 'team-a' },
    });
    assert.deepEqual(vs, []);
  });

  it('a space with no schemas at all is unconstrained, not broken', () => {
    // The permissive reading is correct HERE — declaring nothing is a choice. It is only wrong when a
    // schema was declared and could not be loaded, which is the distinction this whole rule turns on.
    assert.deepEqual(validateEntity({}, { name: 'x', type: 'whatever' }), []);
  });
});
