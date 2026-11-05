/**
 * `typesOfSpaceMeta` converts every shape a space meta reaches an app in, and never refuses or throws as a whole (Q-669, design v3
 * items 1 and 2, slice-B S3).
 *
 * ## The shapes held here
 *
 * - **The fixtures**: the three garden metas (`testing/fixtures/outside-app-schemas/`) and the benchmark schema library
 *   (`benchmarks/space/schema.json`), converted as library entries through a meta that names each one by `$ref` (one call, one
 *   allocator). Every declared type is in `SpaceTypes` with exactly its declared property keys, and nothing is skipped.
 * - **Library references**: `{ $ref, _unresolvedRef }` (the server's mark for a reference it could not resolve) and a bare `{ $ref }`
 *   take the entry from `options.library`; with no entry the type is open and reported `unresolved-ref`. `{ $ref, ...definition }`
 *   (the meta's default answer) is converted from the definition beside the reference, and reported `kind-not-verified` when no
 *   library entry confirms its kind.
 * - **A wrong-kind entry** (an entity type referencing an edge entry) is an open type reported `wrong-kind-ref`; the rest converts.
 * - **A newer server's key** (a type field and a property field this package has never heard of) is stripped and reported
 *   `unknown-field`, and the type still converts.
 * - **A stale type the parse refuses** is skipped and reported `type-skipped` with the parse's own words; the other types convert.
 * - **A missing or non-object `typeSchemas`**, and a meta that is not an object, give a source with an empty map, reported
 *   `no-type-schemas`.
 * - **No library installed**: nothing here installs one (the server is not imported), and no shape above throws.
 *
 * The GET /meta answer built by the server's own expansion is held in
 * `typescript-of-a-meta-answer-converts-the-servers-own-expansion.test.js`, which needs server/dist.
 *
 * Run: node --test testing/standalone/typescript-of-a-space-meta-reads-every-input-shape.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  schema, compileInMemory, converted, assertReported, reportsLike, withLines, lit, unionOf, at,
} from './_typescript-of-space-meta.mjs';
import { REPO_ROOT } from './_sources.mjs';

const { KNOWLEDGE_TYPES } = schema;
const readJson = (rel) => JSON.parse(readFileSync(join(REPO_ROOT, rel), 'utf8'));
const GARDENS = ['garden-plants', 'garden-beds', 'garden-season'].map(name => [name, readJson(`testing/fixtures/outside-app-schemas/${name}.json`)]);
const BENCHMARK = readJson('benchmarks/space/schema.json');

/** A meta that names every benchmark entry by `$ref`, under its own kind, by its entry name. */
const BENCHMARK_META = {
  typeSchemas: Object.fromEntries(KNOWLEDGE_TYPES.map(kind => [kind,
    Object.fromEntries(BENCHMARK.filter(e => e.knowledgeType === kind).map(e => [e.name, { $ref: `library:${e.name}` }]))])),
};

const ENTRY = { name: 'thing-v1', knowledgeType: 'entity', schema: { propertySchemas: { size: { type: 'number' }, label: { type: 'string' } } } };
const EDGE_ENTRY = { name: 'link-v1', knowledgeType: 'edge', schema: { functional: true, propertySchemas: { weight: { type: 'number' } } } };
const PLAIN = { propertySchemas: { kept: { type: 'string' } } };

const REFS = {
  typeSchemas: {
    entity: {
      unresolved: { $ref: 'library:thing-v1', _unresolvedRef: 'library:thing-v1' },
      bare: { $ref: 'library:thing-v1' },
      missing: { $ref: 'library:nowhere-v1' },
      expanded: { $ref: 'library:thing-v1', ...structuredClone(ENTRY.schema) },
      wrongKind: { $ref: 'library:link-v1' },
      plain: PLAIN,
    },
  },
};

const NEWER = {
  typeSchemas: { entity: { future: { futureField: { x: 1 }, propertySchemas: { a: { type: 'string', futureProp: true } } }, plain: PLAIN } },
};

const STALE = {
  typeSchemas: {
    entity: {
      stale: { propertySchemas: { a: { type: 'string', mergeFn: 'avg' } } },
      plain: PLAIN,
    },
  },
};

const NO_TYPES = [['missing', {}], ['a string', { typeSchemas: 'x' }], ['a list', { typeSchemas: [] }], ['null', { typeSchemas: null }]];
const NOT_A_META = [['null', null], ['a string', 'meta'], ['a list', []], ['a number', 7]];

/** The declared names and property keys of a meta whose types are inline: kind -> name -> keys. */
function declared(meta) {
  return Object.fromEntries(KNOWLEDGE_TYPES.map(kind => [kind,
    Object.fromEntries(Object.entries(meta.typeSchemas?.[kind] ?? {}).map(([name, def]) => [name, Object.keys(def.propertySchemas ?? {})]))]));
}

/** Expectations: SpaceTypes holds exactly `shape`'s names per kind and each type exactly its property keys. */
function holds(genName, shape) {
  const lines = [`import type { SpaceTypes } from './${genName}';`, "import type { Equals, Expect, HasIndex } from './assert-types';"];
  let i = 0;
  for (const kind of KNOWLEDGE_TYPES) {
    lines.push(`type _${i++} = Expect<Equals<keyof SpaceTypes[${lit(kind)}], ${unionOf(Object.keys(shape[kind] ?? {}))}>>;`);
    for (const [name, keys] of Object.entries(shape[kind] ?? {})) {
      if (keys === 'open') lines.push(`type _${i++} = Expect<HasIndex<${at(kind, name)}>>;`);
      else if (keys.length > 0) lines.push(`type _${i++} = Expect<Equals<keyof ${at(kind, name)}, ${unionOf(keys)}>>;`);
    }
  }
  return lines.join('\n') + '\n';
}

const benchmarkShape = () => Object.fromEntries(KNOWLEDGE_TYPES.map(kind => [kind,
  Object.fromEntries(BENCHMARK.filter(e => e.knowledgeType === kind).map(e => [e.name, Object.keys(e.schema.propertySchemas ?? {})]))]));

let memo;
function all() {
  if (memo) return memo;
  const out = {};
  const files = {};
  for (const [name, meta] of GARDENS) { out[name] = converted(meta); files[name] = out[name].source; files[`u-${name}`] = holds(name, declared(meta)); }
  out.benchmark = converted(BENCHMARK_META, { library: BENCHMARK });
  files.benchmark = out.benchmark.source;
  files['u-benchmark'] = holds('benchmark', benchmarkShape());
  out.refsNone = converted(REFS);
  out.refsLib = converted(REFS, { library: [ENTRY, EDGE_ENTRY] });
  files['refs-none'] = out.refsNone.source;
  files['refs-lib'] = out.refsLib.source;
  const keys = Object.keys(ENTRY.schema.propertySchemas);
  files['u-refs-none'] = holds('refs-none', { entity: { unresolved: 'open', bare: 'open', missing: 'open', expanded: keys, wrongKind: 'open', plain: ['kept'] } });
  files['u-refs-lib'] = holds('refs-lib', { entity: { unresolved: keys, bare: keys, missing: 'open', expanded: keys, wrongKind: 'open', plain: ['kept'] } });
  out.newer = converted(NEWER);
  files.newer = out.newer.source;
  files['u-newer'] = holds('newer', { entity: { future: ['a'], plain: ['kept'] } });
  out.stale = converted(STALE);
  files.stale = out.stale.source;
  files['u-stale'] = holds('stale', { entity: { plain: ['kept'] } });
  for (const [i, [, meta]] of [...NO_TYPES, ...NOT_A_META].entries()) {
    const key = `empty-${i}`;
    out[key] = converted(meta);
    files[key] = out[key].source;
    files[`u-${key}`] = holds(key, {});
  }
  memo = { out, files, result: compileInMemory(files) };
  return memo;
}

function clean(name, why) {
  const { files, result } = all();
  assert.deepEqual(result.global, [], 'the program has no global diagnostics');
  for (const f of [name, `u-${name}`]) assert.equal(result.byFile[f].length, 0, `${why} (${f}):\n${withLines(result.byFile[f], files[f])}`);
}

describe('the fixtures convert whole', () => {
  for (const [name] of GARDENS) {
    it(`${name}: every declared type with exactly its declared keys, nothing skipped`, () => {
      const { untranslated } = all().out[name];
      assert.deepEqual(reportsLike(untranslated, { reason: 'type-skipped' }), [], `${name} has a type skipped`);
      clean(name, `${name} does not convert to its declared types`);
    });
  }

  it('the benchmark schema library, as entries a meta names, converts every entry', () => {
    assert.ok(BENCHMARK.length >= 20, `the benchmark library reads ${BENCHMARK.length} entries`);
    const { untranslated } = all().out.benchmark;
    for (const reason of ['type-skipped', 'unresolved-ref', 'wrong-kind-ref', 'kind-not-verified']) {
      assert.deepEqual(reportsLike(untranslated, { reason }), [], `a benchmark entry is reported ${reason}`);
    }
    clean('benchmark', 'the benchmark entries do not convert to their declared types');
  });
});

describe('library references', () => {
  it('with no library: {$ref, _unresolvedRef}, a bare $ref and a missing entry are open and reported unresolved-ref', () => {
    const { untranslated } = all().out.refsNone;
    for (const type of ['unresolved', 'bare', 'missing']) assertReported(untranslated, { reason: 'unresolved-ref', kind: 'entity', type }, type);
    clean('refs-none', 'an unresolved reference is not an open type');
  });

  it('with the library: {$ref, _unresolvedRef} and a bare $ref take the entry; a missing entry stays open and reported', () => {
    const { untranslated } = all().out.refsLib;
    for (const type of ['unresolved', 'bare']) assert.deepEqual(reportsLike(untranslated, { reason: 'unresolved-ref', type }), [], `${type} resolved`);
    assertReported(untranslated, { reason: 'unresolved-ref', kind: 'entity', type: 'missing' }, 'missing');
    clean('refs-lib', 'a reference does not take its library entry');
  });

  it('{$ref, ...definition} converts from the definition; kind-not-verified only when no entry confirms it', () => {
    assertReported(all().out.refsNone.untranslated, { reason: 'kind-not-verified', kind: 'entity', type: 'expanded' }, 'no library');
    assert.deepEqual(reportsLike(all().out.refsLib.untranslated, { reason: 'kind-not-verified', type: 'expanded' }), [], 'the entry confirms it');
  });

  it('a wrong-kind entry is an open type reported wrong-kind-ref, never a refusal of the meta', () => {
    assertReported(all().out.refsLib.untranslated, { reason: 'wrong-kind-ref', kind: 'entity', type: 'wrongKind' }, 'entity -> edge entry');
  });
});

describe('what a newer or older server stored', () => {
  it('a key a newer server added is stripped and reported unknown-field; the type converts', () => {
    const { untranslated } = all().out.newer;
    assertReported(untranslated, { reason: 'unknown-field', kind: 'entity', type: 'future', field: 'futureField' }, 'a type field');
    assertReported(untranslated, { reason: 'unknown-field', kind: 'entity', type: 'future', field: 'propertySchemas.a.futureProp' }, 'a property field');
    clean('newer', 'the type with a newer key did not convert');
  });

  it('a stale type the parse refuses is skipped and reported with the parse\'s words; the rest converts', () => {
    const [skipped] = reportsLike(all().out.stale.untranslated, { reason: 'type-skipped', kind: 'entity', type: 'stale' });
    assert.ok(skipped, `the stale type is reported type-skipped: ${JSON.stringify(all().out.stale.untranslated)}`);
    const parse = schema.parseTypeSchema('entity', 'stale', STALE.typeSchemas.entity.stale);
    assert.equal(parse.ok, false, 'the fixture is one the parse refuses');
    assert.ok(typeof skipped.detail === 'string' && skipped.detail.includes('mergeFn is incompatible'),
      `the report carries the parse's words (${parse.refusal.error}), got ${JSON.stringify(skipped)}`);
    clean('stale', 'the rest of the meta did not convert');
  });
});

describe('no types to convert', () => {
  it('a missing or non-object typeSchemas, and a meta that is not an object, give an empty map reported no-type-schemas', () => {
    const { out, files, result } = all();
    const keys = Object.keys(out).filter(k => k.startsWith('empty-'));
    assert.equal(keys.length, NO_TYPES.length + NOT_A_META.length);
    for (const key of keys) {
      assertReported(out[key].untranslated, { reason: 'no-type-schemas' }, key);
      for (const f of [key, `u-${key}`]) assert.equal(result.byFile[f].length, 0, `${f}:\n${withLines(result.byFile[f], files[f])}`);
    }
  });
});

describe('no library installed', () => {
  it('nothing here installed one, and no reference shape throws', () => {
    assert.throws(() => schema.currentSchemaLibrary(), /no schema library installed/, 'the premise: this process has no library installed');
    for (const meta of [REFS, NEWER, STALE, BENCHMARK_META]) assert.doesNotThrow(() => converted(meta));
    assert.doesNotThrow(() => converted(REFS, {}));
  });
});
