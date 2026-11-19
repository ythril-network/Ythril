/**
 * Every field a schema can state about a property, a type or the space lands somewhere in the exported OWL and SHACL graph, or is named as not
 * exported with its reason (Q-751, design r4 §6, §8; owner, 2026-11-18: every schema field and every description reaches the export).
 *
 * ## The defect this prevents
 *
 * The schema export is a hand-written mapping from the schema's fields to standard terms. The day `PropertySchemaZ` or `InlineTypeSchemaZ`
 * gains a field, the mapping would pass it over without a word, and every test written against today's fields would stay green: a consumer
 * validating records against the exported shapes would then be checking a weaker schema than the space runs, and nobody would know. So the
 * field list is read from the package's own zod shapes, never written by hand (the pattern of
 * `every-schema-key-is-translated-reported-or-irrelevant.test.js`), and the map `SCHEMA_FIELD_EXPORT` in `server/src/rdf/schema-owl-shacl.ts`
 * must have a row for each.
 *
 * ## What it holds
 *
 * - `SCHEMA_FIELD_EXPORT[path][key]` has a row for every key of `PropertySchemaZ.shape` (`property`), `InlineTypeSchemaZ.shape` (`type`) and
 *   `SpaceMetaBody.shape` (`space`), and a row only for a key that exists. A row whose name starts with `(` is a pseudo-field the tables of
 *   the design list beside the fields (the key, the name, an unresolved `$ref`), and each is in the one list `SCHEMA_PSEUDO_FIELDS`.
 * - Each row names an OWL term, a SHACL term or a `ythril:` annotation (prefixed names, the `ythril:` ones declared in the vocabulary), or
 *   gives a reason for not exporting the field, never both and never neither.
 * - For every mapped field, a fixture that sets it gives the graph MORE occurrences of each term the row names than the same fixture without
 *   it, in at least one kind of type: the field really reaches the term the map says. A field the map says is not exported changes nothing.
 * - The property `type` enum is read the same way: every declared type has its datatype.
 * - The reader is proven on planted keys: a planted property field, a planted type field and a planted stale row are each named.
 *
 * Run: node --test testing/standalone/every-schema-field-reaches-the-schema-export.test.js (after the schema and server builds)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as schema from '../../schema/dist/index.js';

const mod = await import('../../server/dist/rdf/schema-owl-shacl.js').catch(() => ({}));
const vocab = await import('../../server/dist/rdf/ythril-vocabulary.js').catch(() => ({}));

const { InlineTypeSchemaZ, PropertySchemaZ, SpaceMetaBody } = schema;

const BASE = 'https://ythril.example.org/ld/space-1/';
const VOCAB = `${BASE}vocab/`;
const FP = 'a'.repeat(64);
const KINDS = ['entity', 'fact', 'edge', 'chrono'];

const map = () => {
  assert.equal(typeof mod.SCHEMA_FIELD_EXPORT, 'object', 'SCHEMA_FIELD_EXPORT is not exported by server/src/rdf/schema-owl-shacl.ts: no schema field has a place in the export');
  return mod.SCHEMA_FIELD_EXPORT;
};
const graphOf = (meta) => {
  assert.equal(typeof mod.schemaGraph, 'function', 'schemaGraph is not exported by server/src/rdf/schema-owl-shacl.ts: the schema has no RDF form');
  return mod.schemaGraph(meta, FP);
};

/** The keys `actual` has that `rows` does not place, and the rows (pseudo-fields aside) for keys `actual` lacks. */
function placementGaps(path, actual, rows, pseudo) {
  const real = Object.keys(rows).filter(k => !pseudo.includes(k));
  return {
    unplaced: actual.filter(k => !real.includes(k)).sort().map(k => `${path} field '${k}' has no row in SCHEMA_FIELD_EXPORT.${path}`),
    stale: real.filter(k => !actual.includes(k)).sort().map(k => `SCHEMA_FIELD_EXPORT.${path} has a row for '${k}', which the schema no longer has`),
  };
}

const SHAPES = () => ({
  property: Object.keys(PropertySchemaZ.shape),
  type: Object.keys(InlineTypeSchemaZ.shape),
  space: Object.keys(SpaceMetaBody.shape),
});

/** The fixtures: what sets each field, and where it can be set (`kinds`). The base of a comparison is the same host without the field. */
const PROPERTY_SAMPLES = {
  description: { type: 'string', description: 'what this means' },
  type: { type: 'number' },
  enum: { type: 'string', enum: ['one', 'two'] },
  minimum: { type: 'number', minimum: 3 },
  maximum: { type: 'number', maximum: 9 },
  pattern: { type: 'string', pattern: '^a' },
  mergeFn: { type: 'number', mergeFn: 'sum' },
  required: { type: 'string', required: true },
  default: { type: 'string', default: 'dflt' },
  iri: { type: 'string', iri: 'http://schema.org/email' },
};
const TYPE_SAMPLES = {
  description: { value: 'what this type is', kinds: KINDS },
  namingPattern: { value: '^[A-Z]', kinds: KINDS },
  propertySchemas: { value: { p: { type: 'string' } }, kinds: KINDS },
  retention: { value: { days: 30, contentDays: 7 }, kinds: KINDS },
  suppressEmbeddings: { value: true, kinds: KINDS },
  whenDuePasses: { value: 'nothing', kinds: ['chrono'] },
  endpoints: { value: { from: ['person'], to: ['person'] }, kinds: ['edge'] },
  functional: { value: true, kinds: ['edge'] },
  rules: { value: { named: { rule: 'true', message: 'always' } }, kinds: KINDS },
  iri: { value: 'http://schema.org/Thing', kinds: KINDS },
};
const SPACE_SAMPLES = {
  purpose: 'a purpose',
  validationMode: 'warn',
  strictLinkage: true,
  rules: { named: { rule: 'true', message: 'always', kinds: ['entity'] } },
  typeSchemas: { entity: { t: {} } },
  usageNotes: 'notes',
  suppressEmbeddings: true,
  whenDuePasses: 'nothing',
  stampSkew: { warnMinutes: 5 },
  rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 },
};

/** A type-level pseudo-field of the design's tables, with how a test adds one to a graph (the property ones are an added property). */
const PSEUDO_ADDS = {
  type: {
    '(name)': { add: (meta, kind) => ({ ...meta, typeSchemas: { ...meta.typeSchemas, [kind]: { ...(meta.typeSchemas?.[kind] ?? {}), another: {} } } }) },
    '(unresolved $ref)': { add: (meta, kind) => ({ ...meta, typeSchemas: { ...meta.typeSchemas, [kind]: { ...(meta.typeSchemas?.[kind] ?? {}), broken: { $ref: 'library:missing' } } } }) },
  },
};

const metaOf = (kind, def, extra = {}) => ({ rdf: { enabled: true, base: BASE, vocab: VOCAB, baseEpoch: 0 }, typeSchemas: { [kind]: { t: def } }, ...extra });
const propHost = (prop) => ({ propertySchemas: { p: prop } });

/** A prefixed name as the full address. */
function termIri(name) {
  const [prefix, local] = name.split(':');
  const ns = vocab.STANDARD_PREFIXES?.[prefix];
  assert.equal(typeof ns, 'string', `${name}: the prefix ${prefix} is not a standard prefix of ythril-vocabulary.ts`);
  return `${ns}${local}`;
}
const PREFIXED = /^[a-z]+:[A-Za-z]+$/;
const occurrences = (quads, term) => quads.filter(q => [q.subject, q.predicate, q.object].some(t => t.kind === 'iri' && t.value === term)).length;
const namedTerms = (row) => [...(row.owl ?? []), ...(row.shacl ?? []), ...(row.annotation ?? [])];

describe('the reader is proven on planted keys', () => {
  it('a planted property field, a planted type field and a planted stale row are each named', () => {
    const rows = { property: { description: {}, '(key)': {} }, type: { description: {} } };
    assert.deepEqual(placementGaps('property', ['description', 'plantedUnit'], rows.property, ['(key)']), {
      unplaced: ["property field 'plantedUnit' has no row in SCHEMA_FIELD_EXPORT.property"], stale: [],
    });
    assert.deepEqual(placementGaps('type', ['description', 'plantedFacet'], rows.type, []).unplaced, ["type field 'plantedFacet' has no row in SCHEMA_FIELD_EXPORT.type"]);
    assert.deepEqual(placementGaps('type', [], rows.type, []).stale, ["SCHEMA_FIELD_EXPORT.type has a row for 'description', which the schema no longer has"]);
  });

  it('the real shapes are read, above a floor', () => {
    for (const [path, keys] of Object.entries(SHAPES())) assert.ok(keys.length >= 9, `${path} reads ${keys.length} keys`);
  });
});

describe('every field has a row, and every row a field', () => {
  it('SCHEMA_FIELD_EXPORT places every key of the three shapes and nothing else', () => {
    const rows = map();
    const pseudo = mod.SCHEMA_PSEUDO_FIELDS;
    assert.ok(Array.isArray(pseudo), 'SCHEMA_PSEUDO_FIELDS is not exported by server/src/rdf/schema-owl-shacl.ts');
    assert.deepEqual(Object.keys(rows).sort(), ['property', 'space', 'type'], 'the map has one table per path');
    for (const [path, keys] of Object.entries(SHAPES())) {
      assert.deepEqual(placementGaps(path, keys, rows[path] ?? {}, pseudo), { unplaced: [], stale: [] }, `${path}: place the new field or drop the row`);
    }
  });

  it('a pseudo-field is a row whose name starts with "(", and every such row is in the one list', () => {
    const rows = map();
    const named = Object.entries(rows).flatMap(([path, table]) => Object.keys(table).filter(k => k.startsWith('(')).map(k => `${path}:${k}`));
    assert.deepEqual(named.sort(), ['property:(every property)', 'property:(key)', 'type:(name)', 'type:(unresolved $ref)'].sort());
    for (const key of mod.SCHEMA_PSEUDO_FIELDS) assert.ok(key.startsWith('('), `${key} is a pseudo-field`);
    assert.deepEqual([...new Set(mod.SCHEMA_PSEUDO_FIELDS)].sort(), ['(every property)', '(key)', '(name)', '(unresolved $ref)']);
  });

  it('each row names a term or gives a reason, never both and never neither', () => {
    for (const [path, table] of Object.entries(map())) {
      for (const [key, row] of Object.entries(table)) {
        const where = `SCHEMA_FIELD_EXPORT.${path}.${key}`;
        const terms = namedTerms(row);
        assert.ok(terms.length > 0 || typeof row.reason === 'string' && row.reason.length > 0, `${where} names no term and gives no reason`);
        assert.ok(terms.length === 0 || row.reason === undefined, `${where} names a term and also says it is not exported`);
        for (const term of terms.filter(t => PREFIXED.test(t))) {
          termIri(term);
          if (term.startsWith('ythril:')) {
            assert.ok(vocab.YTHRIL_TERMS.some(t => `ythril:${t.name}` === term), `${where}: ${term} is not declared in YTHRIL_TERMS`);
          }
        }
      }
    }
  });
});

describe('a mapped property field reaches the terms its row names', () => {
  for (const [key, sample] of Object.entries(PROPERTY_SAMPLES)) {
    if (key === 'iri') continue; // its row names the term itself, held below
    it(`property ${key}`, () => {
      const row = map().property[key];
      const { [key]: _field, ...without } = sample;
      const terms = namedTerms(row).filter(t => PREFIXED.test(t));
      assert.ok(terms.length > 0, `property.${key} names a term this test can count`);
      for (const term of terms) {
        const gained = KINDS.some(kind => occurrences(graphOf(metaOf(kind, propHost(sample))).quads, termIri(term)) > occurrences(graphOf(metaOf(kind, propHost(without))).quads, termIri(term)));
        assert.ok(gained, `a property that sets ${key} gives the graph no more of ${term} than one that does not, in any kind of type`);
      }
    });
  }

  it('property iri: the explicit address is the property term itself and the sh:path of its shape; the space vocab no longer names it', () => {
    const quads = graphOf(metaOf('entity', propHost({ type: 'string', iri: 'http://schema.org/email' }))).quads;
    const path = quads.filter(q => q.predicate.value === termIri('sh:path')).map(q => q.object.value);
    assert.ok(path.includes('http://schema.org/email'), 'sh:path is the explicit iri');
    assert.ok(!quads.some(q => [q.subject, q.predicate, q.object].some(t => t.kind === 'iri' && t.value === `${VOCAB}entity/t#p`)), 'the derived address is not used');
    assert.ok(!quads.some(q => q.subject.kind === 'iri' && q.subject.value === 'http://schema.org/email'), 'an outside term is never the subject of a statement');
  });

  it('every property field of the schema has a fixture here', () => {
    assert.deepEqual(Object.keys(PROPERTY_SAMPLES).sort(), Object.keys(PropertySchemaZ.shape).sort(), 'add a fixture for the new property field');
  });

  it('the pseudo-fields (every property, the key) reach their terms', () => {
    const rows = map().property;
    for (const key of ['(key)', '(every property)']) {
      const terms = namedTerms(rows[key]).filter(t => PREFIXED.test(t));
      assert.ok(terms.length > 0, `property.${key} names terms`);
      for (const term of terms) {
        const gained = KINDS.some(kind => occurrences(graphOf(metaOf(kind, propHost({ type: 'string' }))).quads, termIri(term)) > occurrences(graphOf(metaOf(kind, {})).quads, termIri(term)));
        assert.ok(gained, `a property gives the graph no more of ${term} than none, in any kind of type`);
      }
    }
  });

  it('every declared property type has its datatype', () => {
    const options = [...PropertySchemaZ.shape.type.unwrap().options];
    assert.ok(options.length >= 4, 'the type enum is read');
    for (const type of options) {
      const quads = graphOf(metaOf('entity', propHost({ type }))).quads;
      assert.ok(occurrences(quads, termIri('sh:datatype')) + occurrences(quads, termIri('sh:or')) > 0, `type ${type} gives sh:datatype or the date union`);
      assert.ok(occurrences(quads, termIri('rdfs:range')) > 0, `type ${type} gives rdfs:range`);
    }
  });
});

describe('a mapped type field reaches the terms its row names', () => {
  for (const [key, { value, kinds }] of Object.entries(TYPE_SAMPLES)) {
    if (key === 'iri') continue;
    it(`type ${key}`, () => {
      const row = map().type[key];
      const terms = namedTerms(row).filter(t => PREFIXED.test(t));
      assert.ok(terms.length > 0, `type.${key} names a term this test can count`);
      for (const term of terms) {
        const gained = kinds.some(kind => occurrences(graphOf(metaOf(kind, { [key]: value })).quads, termIri(term)) > occurrences(graphOf(metaOf(kind, {})).quads, termIri(term)));
        assert.ok(gained, `a type that sets ${key} gives the graph no more of ${term} than one that does not`);
      }
    });
  }

  it('type iri: the explicit address is the class, the sh:targetClass; an edge label is the sh:targetSubjectsOf', () => {
    const entity = graphOf(metaOf('entity', { iri: 'http://schema.org/Person' })).quads;
    assert.ok(entity.some(q => q.predicate.value === termIri('sh:targetClass') && q.object.value === 'http://schema.org/Person'));
    const edge = graphOf(metaOf('edge', { iri: 'http://schema.org/knows' })).quads;
    assert.ok(edge.some(q => q.predicate.value === termIri('sh:targetSubjectsOf') && q.object.value === 'http://schema.org/knows'));
    assert.ok(![...entity, ...edge].some(q => q.subject.kind === 'iri' && q.subject.value.startsWith('http://schema.org/')), 'an outside term is never the subject of a statement');
  });

  it('every type field of the schema has a fixture here', () => {
    assert.deepEqual(Object.keys(TYPE_SAMPLES).sort(), Object.keys(InlineTypeSchemaZ.shape).sort(), 'add a fixture for the new type field');
  });

  it('the pseudo-fields (the name, an unresolved $ref) reach their terms', () => {
    const rows = map().type;
    for (const key of ['(name)', '(unresolved $ref)']) {
      const terms = namedTerms(rows[key]).filter(t => PREFIXED.test(t));
      assert.ok(terms.length > 0, `type.${key} names terms`);
      for (const term of terms) {
        const base = metaOf('entity', {});
        const gained = KINDS.some(kind => occurrences(graphOf(PSEUDO_ADDS.type[key].add(base, kind)).quads, termIri(term)) > occurrences(graphOf(base).quads, termIri(term)));
        assert.ok(gained, `${key} gives the graph no more of ${term}`);
      }
    }
  });
});

describe('a space field reaches its term, or is named as not exported', () => {
  const placed = (key) => map().space[key];
  it('every space field of the schema has a fixture here', () => {
    assert.deepEqual(Object.keys(SPACE_SAMPLES).sort(), Object.keys(SpaceMetaBody.shape).sort(), 'add a fixture for the new space field');
  });
  for (const [key, value] of Object.entries(SPACE_SAMPLES)) {
    it(`space ${key}`, () => {
      const row = placed(key);
      const terms = namedTerms(row).filter(t => PREFIXED.test(t));
      const base = metaOf('entity', {});
      const set = { ...base, [key]: value };
      if (terms.length === 0) {
        assert.ok(row.reason, `space.${key} gives a reason`);
        if (key === 'typeSchemas') return; // the types are each placed by the type table
        assert.deepEqual(graphOf(set).quads, graphOf(base).quads, `space.${key} is said not to be exported, so it changes nothing in the graph`);
        return;
      }
      for (const term of terms) {
        assert.ok(occurrences(graphOf(set).quads, termIri(term)) > occurrences(graphOf(base).quads, termIri(term)), `space ${key} gives the graph no more of ${term} than a space without it`);
      }
    });
  }
});
