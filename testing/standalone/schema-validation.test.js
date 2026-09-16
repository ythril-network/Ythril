/**
 * Schema validation — against the REAL engine.
 *
 * This file used to be ~20 KB of simulation: it re-implemented nine functions
 * (`safeRegexTest`, `hasReDoSRisk`, `validateValue`, `validateProperties`, `validateEntity`,
 * `validateEdge`, `validateFact`, `validateChrono`, `buildSchemaSummary`) and then tested the
 * copies. It passed continuously while testing nothing about the product.
 *
 * Worse than the duplication: **it validated a data model production had deleted.** The fixtures
 * used `entityTypes`, `namingPatterns` and `requiredProperties` at the root of `meta` — a shape with
 * zero occurrences anywhere in `server/src`. Production moved to per-type `typeSchemas`, where each
 * entity type / edge label / memory type / chrono type owns its own naming pattern and property
 * schemas, and `required` is an inline flag on the property rather than a list beside it. The old
 * tests could not have caught a regression in any of it, because none of it was what they ran.
 *
 * The cases below are the same INTENT, rewritten onto the real API and importing the real functions.
 * Two areas the simulation never covered at all are added, both places where a silent pass is the
 * dangerous outcome: unresolvable `$ref`s, and the ReDoS guard on operator-supplied patterns.
 *
 * Run: node --test testing/standalone/schema-validation.test.js
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const {
  validateEntity, validateEdge, validateFact, validateChrono,
  getAllowedChronoTypes, resolveMetaRefs, buildSchemaSummary,
} = await import('../../server/dist/spaces/schema-validation.js');

/** The real shape: per-type schemas, `required` inline on the property. */
const META = {
  validationMode: 'strict',
  typeSchemas: {
    entity: {
      service: {
        namingPattern: '^[a-z][a-z0-9-]+$',
        propertySchemas: {
          status: { type: 'string', enum: ['active', 'deprecated', 'planned'], required: true },
          repo:   { type: 'string', required: true },
          port:   { type: 'number', minimum: 1, maximum: 65535 },
        },
      },
      library: { propertySchemas: { status: { type: 'string' } } },
      team:    {},
    },
    edge: {
      depends_on: { propertySchemas: { since: { type: 'string', required: true } } },
      owns:       {},
    },
    fact: {
      note: { propertySchemas: { severity: { type: 'string', enum: ['low', 'high'], required: true } } },
    },
    chrono: {
      release: { propertySchemas: { version: { type: 'string', required: true } } },
    },
  },
};

const ok = v => assert.deepEqual(v, [], `expected no violations, got ${JSON.stringify(v)}`);
const has = (v, field, fragment) => assert.ok(
  v.some(x => x.field === field && x.reason.includes(fragment)),
  `expected a violation on '${field}' containing "${fragment}", got ${JSON.stringify(v)}`,
);

describe('validateEntity', () => {
  it('accepts a valid entity', () => {
    ok(validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'active', repo: 'git@x' } }));
  });

  it('rejects a type outside the allowlist', () => {
    const v = validateEntity(META, { name: 'foo', type: 'servicee', properties: { status: 'active', repo: 'x' } });
    has(v, 'type', 'not in entityTypes allowlist');
  });

  it('rejects a name failing its type naming pattern', () => {
    const v = validateEntity(META, { name: 'MyService', type: 'service', properties: { status: 'active', repo: 'x' } });
    has(v, 'name', 'does not match naming pattern');
  });

  it('the naming pattern is PER TYPE — a type without one accepts any name', () => {
    // The whole point of the model production moved to: patterns hang off the type, not off a
    // space-wide map keyed by name.
    ok(validateEntity(META, { name: 'Anything At All', type: 'team' }));
  });

  it('rejects a missing required property', () => {
    const v = validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'active' } });
    has(v, 'properties.repo', "required property 'repo' is missing");
  });

  it('treats empty string as missing for a required property', () => {
    const v = validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'active', repo: '' } });
    has(v, 'properties.repo', 'missing or empty');
  });

  it('rejects a value outside its enum', () => {
    const v = validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'retired', repo: 'x' } });
    has(v, 'properties.status', 'must be one of');
  });

  it('rejects a value of the wrong type', () => {
    const v = validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'active', repo: 'x', port: 'eighty' } });
    has(v, 'properties.port', "expected type 'number'");
  });

  it('rejects a number outside its range, at both ends', () => {
    const below = validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'active', repo: 'x', port: 0 } });
    has(below, 'properties.port', 'must be >= 1');
    const above = validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'active', repo: 'x', port: 70000 } });
    has(above, 'properties.port', 'must be <= 65535');
  });

  it('does not check the allowlist when no entity types are defined', () => {
    ok(validateEntity({ typeSchemas: { entity: {} } }, { name: 'x', type: 'anything' }));
    ok(validateEntity({}, { name: 'x', type: 'anything' }));
  });

  it('an entity with no type is unconstrained', () => {
    ok(validateEntity(META, { name: 'ANYTHING', properties: { whatever: 1 } }));
  });

  it('a property not in the schema is not rejected', () => {
    // The schema declares what it knows about; it is not an exhaustive allowlist of keys.
    ok(validateEntity(META, { name: 'my-service', type: 'service', properties: { status: 'active', repo: 'x', extra: 'fine' } }));
  });
});

describe('validateEdge', () => {
  it('accepts a valid edge', () => {
    ok(validateEdge(META, { label: 'depends_on', properties: { since: '2026-01-01' } }));
  });

  it('rejects a label outside the allowlist', () => {
    has(validateEdge(META, { label: 'dependz_on' }), 'label', 'not in edgeLabels allowlist');
  });

  it('rejects a missing required property', () => {
    has(validateEdge(META, { label: 'depends_on', properties: {} }), 'properties.since', 'required property');
  });

  it('is unconstrained with no meta', () => {
    ok(validateEdge({}, { label: 'anything' }));
  });
});

describe('validateFact', () => {
  it('accepts a valid memory', () => {
    ok(validateFact(META, { type: 'note', properties: { severity: 'low' } }));
  });

  it('rejects a missing required property', () => {
    has(validateFact(META, { type: 'note', properties: {} }), 'properties.severity', 'required property');
  });

  it('rejects an invalid enum value', () => {
    has(validateFact(META, { type: 'note', properties: { severity: 'medium' } }), 'properties.severity', 'must be one of');
  });

  it('rejects a type outside the declared allowlist, like the other three', () => {
    /*
     * REVERSED on 2026-08-30, and the reversal is the whole record of why.
     *
     * This asserted the opposite, with the note: "Deliberately asymmetric with entity/edge/chrono. Pinned so
     * the asymmetry is a decision on record rather than something a later reader 'fixes' into an allowlist."
     * It did its job — it stopped exactly that fix, and sent the question to the owner instead, because
     * `types-knowledge.ts` and two integration-guide pages had been claiming the allowlist existed all along.
     *
     * Owner ruled A: the keys ARE the allowlist. So the asymmetry was ruled away rather than overlooked, and
     * that distinction is why this is rewritten rather than deleted.
     */
    has(validateFact(META, { type: 'not-declared' }), 'type', 'not in memoryTypes allowlist');
  });

  it('but a space that declares NO memory types still accepts any string', () => {
    // The bound on what this can newly refuse, and the same condition the other three carry. A space with no
    // `typeSchemas.memory` never asked to constrain anything, and must not start refusing writes.
    ok(validateFact({ validationMode: 'strict', typeSchemas: {} }, { type: 'anything-at-all' }));
    ok(validateFact({ validationMode: 'strict' }, { type: 'anything-at-all' }));
  });
});

describe('validateChrono', () => {
  it('accepts a declared chrono type', () => {
    ok(validateChrono(META, { type: 'release', properties: { version: '1.0' } }));
  });

  it('rejects a type outside a custom allowlist', () => {
    has(validateChrono(META, { type: 'event' }), 'type', 'not in chronoTypes allowlist');
  });

  it('rejects a missing required property', () => {
    has(validateChrono(META, { type: 'release', properties: {} }), 'properties.version', 'required property');
  });
});

describe('getAllowedChronoTypes', () => {
  it('falls back to the five built-ins when a space declares none', () => {
    assert.deepEqual([...getAllowedChronoTypes({})].sort(),
      ['deadline', 'event', 'milestone', 'plan', 'prediction']);
    assert.deepEqual([...getAllowedChronoTypes(undefined)].sort(),
      ['deadline', 'event', 'milestone', 'plan', 'prediction']);
  });

  it('a space that declares chrono types REPLACES the built-ins rather than extending them', () => {
    // Extending would silently keep `event` valid on a space that deliberately narrowed the set.
    assert.deepEqual([...getAllowedChronoTypes(META)], ['release']);
  });
});

describe('unresolvable $ref — the silent-pass case the simulation never covered', () => {
  // A `$ref` that cannot be resolved must NOT behave like "no schema, nothing to check". A space
  // whose library entry was renamed or deleted would otherwise start accepting anything, and the
  // only symptom would be validation quietly doing nothing.
  const REF_META = { typeSchemas: { entity: { service: { $ref: 'library:does-not-exist' } } } };

  it('stamps _unresolvedRef instead of dropping the constraint', () => {
    const resolved = resolveMetaRefs(REF_META);
    assert.equal(resolved.typeSchemas.entity.service._unresolvedRef, 'library:does-not-exist');
  });

  it('surfaces a violation rather than passing with no constraints', () => {
    const v = validateEntity(resolveMetaRefs(REF_META), { name: 'x', type: 'service' });
    assert.ok(v.length > 0, 'an unresolvable $ref must produce a violation, not silence');
  });

  it('leaves meta untouched when there are no refs to resolve', () => {
    assert.equal(resolveMetaRefs(META), META, 'expected the same object back when nothing changed');
  });
});

describe('operator-supplied regex is guarded — a bad pattern fails closed', () => {
  const withPattern = pattern => ({
    typeSchemas: { entity: { thing: { propertySchemas: { code: { type: 'string', pattern } } } } },
  });

  it('a matching pattern passes', () => {
    ok(validateEntity(withPattern('^[A-Z]{3}$'), { type: 'thing', properties: { code: 'ABC' } }));
  });

  it('a non-matching value is a violation', () => {
    has(validateEntity(withPattern('^[A-Z]{3}$'), { type: 'thing', properties: { code: 'abc' } }),
      'properties.code', 'does not match pattern');
  });

  it('an INVALID regex fails closed, and says the pattern was the problem', () => {
    // A malformed pattern is operator input. Throwing would 500 the write; passing would make the
    // constraint silently optional. It is reported as a violation instead — and the violation names the
    // PATTERN, because the value here is not what is wrong with this write (`Q-7`).
    has(validateEntity(withPattern('^[unterminated'), { type: 'thing', properties: { code: 'x' } }),
      'properties.code', 'not evaluated');
  });

  it('a ReDoS-risky pattern is refused rather than run, and SAYS it was not run', () => {
    // The value here MATCHES the pattern. That is the point: if the guard were removed the regex
    // would run and pass, so the violation below can only come from the guard declining to run it.
    // An earlier version used a non-matching value, which produced a violation either way and
    // therefore proved nothing — it survived the mutation that disables the guard.
    //
    // The REASON is asserted as well, and that half is `Q-7`: this test used to require the wording
    // "does not match pattern", which is what a value that genuinely failed would produce. A schema that
    // could never be applied therefore reported the same thing as bad data, and every record of the type
    // was rejected for ever with an error naming the operator's value. The test encoded the bug.
    has(validateEntity(withPattern('^(a+)+$'), { type: 'thing', properties: { code: 'aaaa' } }),
      'properties.code', 'not evaluated');
  });

  it('an over-long value is refused rather than run', () => {
    // Same three-way answer: the pattern is fine and the value is simply too long to test safely, so the
    // violation says the check did not happen rather than claiming the value failed it.
    has(validateEntity(withPattern('^[a-z]+$'), { type: 'thing', properties: { code: 'a'.repeat(10_001) } }),
      'properties.code', 'not evaluated');
  });
});

describe('properties absent entirely', () => {
  it('a type with no required properties accepts a record with none', () => {
    ok(validateEntity(META, { name: 'x', type: 'library' }));
  });

  it('required properties are still reported when properties is undefined', () => {
    // The tempting shortcut — skip validation when there is nothing to validate — would let a write
    // with no properties at all bypass every required check.
    has(validateEntity(META, { name: 'my-service', type: 'service' }), 'properties.status', 'required property');
  });
});

describe('buildSchemaSummary', () => {
  it('names the declared types so an MCP client can see them', () => {
    const summary = buildSchemaSummary(META);
    assert.match(summary, /service/);
    assert.match(summary, /depends_on/);
  });

  it('says nothing about a space with no schema', () => {
    assert.equal(buildSchemaSummary({}), '');
  });
});
