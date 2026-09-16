/**
 * The inferred ER model — the counting and set logic, tested against hand-built rows.
 *
 * ## Why this is a unit test and not an integration one
 *
 * Everything that can be WRONG in this feature is arithmetic: which type a record counts toward, whether a
 * memory linking two entities of one type counts once or twice, what an edge with an unresolvable endpoint
 * means. None of that needs a container or a seeded space — and a test that needed one would run rarely
 * enough that the arithmetic would go unchecked between releases.
 *
 * `assembleErModel` is pure for exactly this reason: `buildErModel` does the reads, this does the thinking.
 *
 * ## The three cases the feature exists for
 *
 * A diagram drawn from `typeSchemas` alone would show a declared-but-empty type and silently omit a type
 * that has records and no declaration. That is backwards — the undeclared ones are the ones nobody knows
 * about, and an operator arrived at this product with 21 of them. All three cases are asserted below,
 * because "it renders" would pass with any two of them.
 *
 * Run: node --test testing/standalone/er-model.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let assembleErModel, UNTYPED;

before(async () => {
  ({ assembleErModel, UNTYPED } = await import('../../server/dist/brain/er-model.js'));
});

/** Minimal well-formed input; each test overrides only what it is about. */
const inputs = (over = {}) => ({
  spaceId: 'test',
  entities: [],
  edges: [],
  links: { facts: [], chrono: [], files: [] },
  declared: {},
  totals: { entities: 0, edges: 0 },
  truncated: null,
  ...over,
});

const typeNamed = (model, name) => model.entityTypes.find(t => t.type === name);

describe('the schema and the records are BOTH sources', () => {
  it('a declared type with records reports its count and its properties', () => {
    const m = assembleErModel(inputs({
      entities: [{ _id: 'a', type: 'service' }, { _id: 'b', type: 'service' }],
      declared: {
        service: {
          namingPattern: '^[a-z-]+$',
          propertySchemas: {
            tier: { type: 'string', enum: ['gold', 'silver'], required: true },
            repo: { type: 'string' },
          },
        },
      },
    }));
    const t = typeNamed(m, 'service');
    assert.equal(t.count, 2);
    assert.equal(t.declared, true);
    assert.equal(t.namingPattern, '^[a-z-]+$');
    assert.deepEqual(t.properties.find(p => p.name === 'tier'),
      { name: 'tier', type: 'string', required: true, enumValues: ['gold', 'silver'] });
    assert.equal(t.properties.find(p => p.name === 'repo').required, false);
  });

  it('a declared type with ZERO records is still reported', () => {
    // The whole point of reading the schema as well. A type nobody writes is either aspirational or unknown
    // to the writers, and a count of 0 is the only way anyone sees it.
    const m = assembleErModel(inputs({ declared: { runbook: { propertySchemas: {} } } }));
    const t = typeNamed(m, 'runbook');
    assert.ok(t, 'a declared type with no records vanished from the model');
    assert.equal(t.count, 0);
    assert.equal(t.declared, true);
  });

  it('a type with records and NO declaration is reported, and marked as such', () => {
    // The case a schema-only diagram would silently omit — and the one that actually cost an operator time.
    const m = assembleErModel(inputs({
      entities: [{ _id: 'a', type: 'document' }, { _id: 'b', type: 'document' }],
    }));
    const t = typeNamed(m, 'document');
    assert.ok(t, 'records outside the declared vocabulary are invisible in the model');
    assert.equal(t.count, 2);
    assert.equal(t.declared, false,
      'an undeclared type is reported as declared, so the diagram cannot distinguish it from an agreed one');
    assert.deepEqual(t.properties, [], 'properties were invented for a type that declares none');
  });

  it('an entity with no type at all lands in a named bucket rather than vanishing', () => {
    const m = assembleErModel(inputs({
      entities: [{ _id: 'a' }, { _id: 'b', type: '   ' }],
    }));
    const t = typeNamed(m, UNTYPED);
    assert.ok(t, 'untyped records were dropped — they are real records and the count would not add up');
    assert.equal(t.count, 2, 'a blank-string type and a missing type are the same case and must share a bucket');
  });
});

describe('relationships are the edge set grouped by TYPE', () => {
  const entities = [
    { _id: 'p1', type: 'person' }, { _id: 'p2', type: 'person' },
    { _id: 's1', type: 'service' }, { _id: 's2', type: 'service' },
  ];

  it('edges between the same pair of types collapse into one relationship with a count', () => {
    const m = assembleErModel(inputs({
      entities,
      edges: [
        { from: 'p1', to: 's1', label: 'owns' },
        { from: 'p2', to: 's2', label: 'owns' },
      ],
    }));
    assert.equal(m.relationships.length, 1);
    assert.deepEqual(m.relationships[0], { from: 'person', to: 'service', label: 'owns', count: 2 });
  });

  it('direction matters — A→B and B→A are different relationships', () => {
    const m = assembleErModel(inputs({
      entities,
      edges: [{ from: 'p1', to: 's1', label: 'x' }, { from: 's1', to: 'p1', label: 'x' }],
    }));
    assert.equal(m.relationships.length, 2, 'opposite directions were merged, which reverses what the diagram claims');
  });

  it('a type related to itself is one relationship, not two nodes', () => {
    const m = assembleErModel(inputs({
      entities,
      edges: [{ from: 's1', to: 's2', label: 'depends_on' }],
    }));
    assert.deepEqual(m.relationships[0], { from: 'service', to: 'service', label: 'depends_on', count: 1 });
  });

  it('an edge whose endpoint does not resolve is counted as dangling, never as a relationship', () => {
    // Two ways to get here: a genuinely dangling edge where `strictLinkage` is off, or an entity beyond the
    // read cap. Either way, inventing a relationship from it would put a line in the diagram for a join
    // that cannot be shown to exist.
    const m = assembleErModel(inputs({
      entities,
      edges: [{ from: 'p1', to: 'GONE', label: 'owns' }, { from: 'MISSING', to: 's1', label: 'owns' }],
    }));
    assert.equal(m.danglingEdges, 2);
    assert.deepEqual(m.relationships, []);
  });

  it('labels containing spaces cannot collide into one relationship', () => {
    // Regression. The grouping key was built by joining the triple with a separator; with a plain space,
    // (from "a b", label "c") and (from "a", label "b c") produce the same key and two distinct
    // relationships silently merge into one with a doubled count.
    const m = assembleErModel(inputs({
      entities: [{ _id: 'x', type: 'a b' }, { _id: 'y', type: 'a' }, { _id: 'z', type: 'z' }],
      edges: [
        { from: 'x', to: 'z', label: 'c' },
        { from: 'y', to: 'z', label: 'b c' },
      ],
    }));
    assert.equal(m.relationships.length, 2,
      'two different relationships merged — the grouping key is ambiguous for values containing its separator');
    assert.ok(m.relationships.every(r => r.count === 1), 'a merged key produced a doubled count');
  });
});

describe('links from the other three record kinds', () => {
  const entities = [
    { _id: 's1', type: 'service' }, { _id: 's2', type: 'service' }, { _id: 'p1', type: 'person' },
  ];

  it('one record linking TWO entities of the same type counts once for that type', () => {
    // "How many memories mention a service" must not double because one memory mentions two services.
    const m = assembleErModel(inputs({
      entities,
      links: { facts: [['s1', 's2']], chrono: [], files: [] },
    }));
    assert.equal(typeNamed(m, 'service').linkedFrom.facts, 1);
  });

  it('one record spanning two types counts once for EACH', () => {
    const m = assembleErModel(inputs({
      entities,
      links: { facts: [['s1', 'p1']], chrono: [], files: [] },
    }));
    assert.equal(typeNamed(m, 'service').linkedFrom.facts, 1);
    assert.equal(typeNamed(m, 'person').linkedFrom.facts, 1);
  });

  it('the three kinds are counted separately', () => {
    const m = assembleErModel(inputs({
      entities,
      links: { facts: [['s1']], chrono: [['s1'], ['s2']], files: [] },
    }));
    assert.deepEqual(typeNamed(m, 'service').linkedFrom, { facts: 1, chrono: 2, files: 0 });
  });

  it('a link to an entity that does not resolve is ignored rather than counted', () => {
    const m = assembleErModel(inputs({ entities, links: { facts: [['GONE']], chrono: [], files: [] } }));
    assert.equal(typeNamed(m, 'service').linkedFrom.facts, 0);
  });
});

describe('ordering puts the shape of the space first', () => {
  it('types are sorted by record count, so an undeclared type with records outranks a declared empty one', () => {
    const m = assembleErModel(inputs({
      entities: [{ _id: 'a', type: 'loud' }, { _id: 'b', type: 'loud' }, { _id: 'c', type: 'quiet' }],
      declared: { empty: { propertySchemas: {} }, quiet: { propertySchemas: {} } },
    }));
    assert.deepEqual(m.entityTypes.map(t => t.type), ['loud', 'quiet', 'empty']);
  });

  it('relationships are sorted by count', () => {
    const m = assembleErModel(inputs({
      entities: [{ _id: 'a', type: 'A' }, { _id: 'b', type: 'B' }, { _id: 'c', type: 'C' }],
      edges: [
        { from: 'a', to: 'b', label: 'rare' },
        { from: 'a', to: 'c', label: 'common' },
        { from: 'a', to: 'c', label: 'common' },
      ],
    }));
    assert.equal(m.relationships[0].label, 'common');
  });
});

describe('a bounded read says so', () => {
  it('truncation is carried through rather than dropped', () => {
    // The diagram must never present a partial read as complete: "absent" and "not looked at" are different
    // answers, and only one of them is a fact about the space.
    const m = assembleErModel(inputs({ truncated: { scan: 'edges', limit: 200000 } }));
    assert.deepEqual(m.truncated, { scan: 'edges', limit: 200000 });
  });

  it('the pre-cap totals survive, so the caller can see what share it is looking at', () => {
    const m = assembleErModel(inputs({
      entities: [{ _id: 'a', type: 'x' }],
      totals: { entities: 999999, edges: 12345 },
    }));
    assert.deepEqual(m.totals, { entities: 999999, edges: 12345 });
    assert.equal(typeNamed(m, 'x').count, 1, 'the per-type count must be what was READ, not the pre-cap total');
  });
});
