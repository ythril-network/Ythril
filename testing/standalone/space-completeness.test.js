/**
 * Space completeness — the scoring rules, exercised without a database.
 *
 * The feature's one design rule is that **every lost point names a specific missing thing**, so the
 * tests here are about the judging, not the plumbing: which checks apply, what they count, and what the
 * roll-up does with a question this space cannot be asked.
 *
 * The properties worth protecting, each of which is a way the score could quietly become a lie:
 *
 *  1. **A check with no denominator is ABSENT, not present-and-failed.** A space that declares no
 *     schemas has opted out of schema governance; scoring it 0 % makes the number a scold nobody can act
 *     on, and an operator who cannot make the number go up stops reading it.
 *  2. **An empty allowlist forbids nothing.** `typeSchemas.entity = {}` means "all values accepted", so
 *     counting every record as an undeclared-type violation would invert the setting's meaning.
 *  3. **One mistake is charged once.** A declared type nobody instantiated is `declared-type-unused`; its
 *     unfilled properties are not *also* `declared-property-never-filled`.
 *  4. **Findings are per knowledge kind.** An unused entity type and an unused edge label are different
 *     findings with different samples and different tabs; collapsing them makes the sample meaningless.
 *  5. **Partial credit is proportional.** 1 unlinked entity out of 40 must not read like 40 out of 40.
 *
 * Run: node --test testing/standalone/space-completeness.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let scoreCompleteness, CHECK_WEIGHTS, PROPERTY_KEY_CAP;

before(async () => {
  ({ scoreCompleteness, CHECK_WEIGHTS, PROPERTY_KEY_CAP } = await import('../../server/dist/spaces/completeness.js'));
});

/** Facts for a space with nothing in it — every counted check has a zero denominator. */
const emptyFacts = () => ({
  typeCounts: { entity: {}, fact: {}, edge: {}, chrono: {} },
  propertyFilled: { entity: {}, fact: {}, edge: {}, chrono: {} },
  entities: 0,
  entitiesWithEdges: 0,
  unlinkedEntitySample: [],
  files: 0,
  filesNotRecallable: 0,
  fileSample: [],
});

/** First check with this id — optionally narrowed to one knowledge kind. */
const check = (report, id, scope) => report.checks.find(c => c.id === id && (!scope || c.scope === scope));

describe('space completeness — applicability', () => {
  it('omits a check with no denominator instead of scoring it zero', () => {
    // No schemas, no records — only `meta-purpose-missing` can be asked at all.
    const r = scoreCompleteness('s', {}, emptyFacts());
    assert.equal(check(r, 'declared-type-unused'), undefined, 'nothing was declared, so nothing was checked');
    assert.equal(check(r, 'schemas-declared-but-unenforced'), undefined, 'no schemas → the question does not arise');
    assert.equal(check(r, 'entity-without-edges'), undefined, 'no entities → not a finding, just an empty space');
    assert.deepEqual(r.checks.map(c => c.id), ['meta-purpose-missing']);
    assert.equal(r.score, 0, 'the one applicable check failed');
  });

  it('every check in the report applied — `total` is never zero', () => {
    const r = scoreCompleteness('s', { typeSchemas: { entity: { service: {} } } }, {
      ...emptyFacts(),
      typeCounts: { entity: { service: 3 }, fact: {}, edge: {}, chrono: {} },
      entities: 3, entitiesWithEdges: 1,
    });
    assert.ok(r.checks.length > 0);
    for (const c of r.checks) assert.ok(c.total > 0, `${c.id}/${c.scope} was reported without a denominator`);
  });

  it('a space with no purpose but nothing else wrong is not dragged down by the absent checks', () => {
    const facts = { ...emptyFacts(), entities: 10, entitiesWithEdges: 10 };
    const r = scoreCompleteness('s', {}, facts);
    // Applicable: entity-without-edges (perfect, weight 2) + meta-purpose-missing (failed, weight 1).
    const expected = Math.round((CHECK_WEIGHTS['entity-without-edges'] /
      (CHECK_WEIGHTS['entity-without-edges'] + CHECK_WEIGHTS['meta-purpose-missing'])) * 100);
    assert.equal(r.score, expected);
  });

  it('a fully set-up empty space scores 100 rather than null', () => {
    const r = scoreCompleteness('s', { purpose: 'x' }, emptyFacts());
    assert.equal(check(r, 'meta-purpose-missing').affected, 0, 'the purpose check always applies');
    assert.equal(r.score, 100);
  });
});

describe('space completeness — the allowlist checks', () => {
  it('an EMPTY typeSchemas map forbids nothing, so no record is an undeclared type', () => {
    const facts = { ...emptyFacts(), typeCounts: { entity: { service: 30, runbook: 12 }, fact: {}, edge: {}, chrono: {} } };
    const r = scoreCompleteness('s', { typeSchemas: { entity: {} } }, facts);
    assert.equal(check(r, 'undeclared-type-in-use'), undefined, 'an empty allowlist is not a denominator');
    assert.equal(check(r, 'declared-type-unused'), undefined);
  });

  it('a NON-EMPTY allowlist counts the records strict validation would now reject', () => {
    const facts = { ...emptyFacts(), typeCounts: { entity: { service: 30, mystery: 4 }, fact: {}, edge: {}, chrono: {} } };
    const c = check(scoreCompleteness('s', { typeSchemas: { entity: { service: {} } } }, facts), 'undeclared-type-in-use');
    assert.equal(c.affected, 4);
    assert.equal(c.total, 34);
    assert.deepEqual(c.sample, ['mystery']);
    assert.equal(c.targetTab, 'entities', 'the finding must say where the records are');
  });

  it('an UNTYPED record is not an allowlist violation — validation only fires on a value that is present', () => {
    const facts = { ...emptyFacts(), typeCounts: { entity: { service: 30, '': 7 }, fact: {}, edge: {}, chrono: {} } };
    const c = check(scoreCompleteness('s', { typeSchemas: { entity: { service: {} } } }, facts), 'undeclared-type-in-use');
    assert.equal(c.affected, 0);
    assert.equal(c.total, 30, 'untyped records are out of scope entirely, not a passing 7');
  });

  it('a declared type with no records is unused, and is NOT also charged for unfilled properties', () => {
    const facts = { ...emptyFacts(), typeCounts: { entity: { service: 5 }, fact: {}, edge: {}, chrono: {} } };
    const meta = {
      typeSchemas: {
        entity: {
          service: { propertySchemas: { owner: {} } },
          runbook: { propertySchemas: { owner: {}, sop: {} } },   // declared, never instantiated
        },
      },
    };
    const r = scoreCompleteness('s', meta, facts);
    assert.equal(check(r, 'declared-type-unused').affected, 1);
    assert.deepEqual(check(r, 'declared-type-unused').sample, ['runbook']);
    // Only `service.owner` was checked — runbook's two properties are not a second penalty for the
    // same mistake.
    const props = check(r, 'declared-property-never-filled');
    assert.equal(props.total, 1, 'only the instantiated type contributes property checks');
    assert.equal(props.affected, 1, 'no service record fills owner');
    assert.deepEqual(props.sample, ['service.owner']);
  });

  it('a filled property earns its point back', () => {
    const facts = {
      ...emptyFacts(),
      typeCounts: { entity: { service: 5 }, fact: {}, edge: {}, chrono: {} },
      propertyFilled: { entity: { service: { owner: 3 } }, fact: {}, edge: {}, chrono: {} },
    };
    const meta = { typeSchemas: { entity: { service: { propertySchemas: { owner: {} } } } } };
    const props = check(scoreCompleteness('s', meta, facts), 'declared-property-never-filled');
    assert.equal(props.affected, 0, 'presence on ANY record clears the key — this is not a fill-rate check');
    assert.equal(props.earned, props.weight);
  });

  it('flags truncation rather than silently checking the first N property keys', () => {
    const many = {};
    for (let i = 0; i < PROPERTY_KEY_CAP + 3; i++) many[`p${i}`] = {};
    const facts = { ...emptyFacts(), typeCounts: { entity: { service: 1 }, fact: {}, edge: {}, chrono: {} } };
    const meta = { typeSchemas: { entity: { service: { propertySchemas: many } } } };
    const r = scoreCompleteness('s', meta, facts);
    assert.equal(r.truncated, true);
    assert.equal(check(r, 'declared-property-never-filled').total, PROPERTY_KEY_CAP);
  });

  it('reports per knowledge kind — an unused edge label is not an entity finding', () => {
    const facts = {
      ...emptyFacts(),
      typeCounts: { entity: { service: 3 }, fact: {}, edge: { runs_on: 9, wat: 1 }, chrono: {} },
    };
    const meta = { typeSchemas: { entity: { service: {} }, edge: { runs_on: {}, ghost_label: {} } } };
    const r = scoreCompleteness('s', meta, facts);

    const edgeUndeclared = check(r, 'undeclared-type-in-use', 'edge');
    assert.deepEqual(edgeUndeclared.sample, ['wat'], 'edges are typed by their label');
    assert.equal(edgeUndeclared.targetTab, 'edges');
    assert.equal(check(r, 'undeclared-type-in-use', 'entity').affected, 0, 'the entity side is clean');

    const edgeUnused = check(r, 'declared-type-unused', 'edge');
    assert.deepEqual(edgeUnused.sample, ['ghost_label']);
    assert.equal(check(r, 'declared-type-unused', 'entity').affected, 0);
  });
});

describe('space completeness — partial credit and the boolean checks', () => {
  it('one unlinked entity out of forty does not read like forty out of forty', () => {
    const few = scoreCompleteness('s', {}, { ...emptyFacts(), entities: 40, entitiesWithEdges: 39 });
    const all = scoreCompleteness('s', {}, { ...emptyFacts(), entities: 40, entitiesWithEdges: 0 });
    const c = check(few, 'entity-without-edges');
    assert.equal(c.affected, 1);
    assert.ok(Math.abs(c.earned - c.weight * (39 / 40)) < 1e-9, 'credit is proportional to what is linked');
    assert.equal(check(all, 'entity-without-edges').earned, 0);
  });

  it('schemas declared with validation off is a warning; turning validation on clears it', () => {
    const facts = { ...emptyFacts(), typeCounts: { entity: { service: 1 }, fact: {}, edge: {}, chrono: {} } };
    const meta = { typeSchemas: { entity: { service: {} } } };
    const off = check(scoreCompleteness('s', meta, facts), 'schemas-declared-but-unenforced');
    assert.equal(off.affected, 1, 'default validationMode is off');
    assert.equal(off.earned, 0);
    const on = check(scoreCompleteness('s', { ...meta, validationMode: 'strict' }, facts), 'schemas-declared-but-unenforced');
    assert.equal(on.affected, 0);
    assert.equal(on.earned, on.weight);
  });

  it('a whitespace-only purpose is not a purpose', () => {
    assert.equal(check(scoreCompleteness('s', { purpose: '   ' }, emptyFacts()), 'meta-purpose-missing').affected, 1);
  });

  it('every check carries a weight, a bounded sample, and either a tab or a reason it has none', () => {
    const facts = { ...emptyFacts(), entities: 9, entitiesWithEdges: 0, unlinkedEntitySample: ['a', 'b', 'c', 'd', 'e'] };
    const r = scoreCompleteness('s', {}, facts);
    for (const c of r.checks) {
      assert.ok(c.sample.length <= 5, `${c.id} sample must stay bounded`);
      assert.ok(c.weight > 0, `${c.id} must carry a weight`);
      // A null tab is only legitimate for a finding about the space itself, which no collection shows.
      if (c.targetTab === null) assert.equal(c.scope, 'space', `${c.id} must say where to go`);
    }
  });

  it('a perfect space scores 100, a fully failing one scores 0, and a mixed one lands between', () => {
    const good = scoreCompleteness('s', { purpose: 'p', validationMode: 'strict', typeSchemas: { entity: { service: { propertySchemas: { owner: {} } } } } }, {
      ...emptyFacts(),
      typeCounts: { entity: { service: 4 }, fact: {}, edge: {}, chrono: {} },
      propertyFilled: { entity: { service: { owner: 4 } }, fact: {}, edge: {}, chrono: {} },
      entities: 4, entitiesWithEdges: 4,
      files: 2, filesNotRecallable: 0,
    });
    assert.equal(good.score, 100);

    // Every applicable check fully failed: the one declared type was never used, so every record
    // carries an undeclared one; no entity is linked; no file is recallable; no purpose; schemas off.
    const bad = scoreCompleteness('s', { typeSchemas: { entity: { ghost: {} } } }, {
      ...emptyFacts(),
      typeCounts: { entity: { mystery: 6 }, fact: {}, edge: {}, chrono: {} },
      entities: 6, entitiesWithEdges: 0,
      files: 3, filesNotRecallable: 3,
    });
    assert.equal(bad.score, 0);

    const mixed = scoreCompleteness('s', { typeSchemas: { entity: { service: {}, ghost: {} } } }, {
      ...emptyFacts(),
      typeCounts: { entity: { service: 4, mystery: 2 }, fact: {}, edge: {}, chrono: {} },
      entities: 6, entitiesWithEdges: 3,
      files: 3, filesNotRecallable: 1,
    });
    assert.ok(mixed.score > 0 && mixed.score < 100, `expected a middling score, got ${mixed.score}`);
  });
});
