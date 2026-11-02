/**
 * The meta answer an app actually receives (GET /api/spaces/:id/meta, `space_meta`) converts with `typesOfSpaceMeta`, and the header
 * of the source copies none of the server's lists (Q-669, design v3 items 1, 2 and 8; slice-B S3).
 *
 * ## Why the server is imported here, and only here
 *
 * The answer's shape is the server's: `spaceMetaAnswer` (server/src/spaces/space-meta-answer.ts) spreads the meta beside `spaceId`,
 * `spaceName`, `stats` and the server-owned fields, and `withLibraryDefinitions` (server/src/spaces/library-ref-expansion.ts) turns each
 * library type into `{ $ref, ...definition }`, or `{ $ref, _unresolvedRef }` when the entry is missing. A hand-built copy of that shape
 * would hold the converter to what a test author remembered, so the library types are built by the server's own expansion (scoped to a
 * library with `withSchemaLibrary`, so no instance's library is read). The answer builder itself needs a database for `stats`, so the
 * fields it adds around the meta are written here from its return statement, and the server-owned ones from `SERVER_OWNED_META_FIELDS`.
 * The pure input-shape cases are in `typescript-of-a-space-meta-reads-every-input-shape.test.js`.
 *
 * ## What is held
 *
 * - The answer converts: the linked type from the definition beside its `$ref` (reported `kind-not-verified` with no library, not
 *   reported with it), the missing one open and reported `unresolved-ref`, the inline one as declared.
 * - `spaceId`, `spaceName`, `stats` and the server-owned fields are ignored: no report names them.
 * - The header lists none of the server's values it describes in prose: the labels the server writes on edges
 *   (`SERVER_WRITTEN_EDGE_LABELS`), the built-in chrono types (`getAllowedChronoTypes` of a meta with none) and the keys the instance
 *   writes (`INSTANCE_WRITTEN_PROPERTY_KEYS`). A copy there is a third copy of a server list, wrong on the day the server's changes.
 *
 * Run: node --test testing/standalone/typescript-of-a-meta-answer-converts-the-servers-own-expansion.test.js
 * (requires a prior `npm run build -w @ythril/schema` and `npm run build -w server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { withLibraryDefinitions } from '../../server/dist/spaces/library-ref-expansion.js';
import {
  SERVER_WRITTEN_EDGE_LABELS, INSTANCE_WRITTEN_PROPERTY_KEYS, getAllowedChronoTypes,
} from '../../server/dist/spaces/schema-validation.js';
import {
  schema, compileInMemory, converted, assertReported, reportsLike, headerOf, withLines, lit, at,
} from './_typescript-of-space-meta.mjs';

const ENTRY = { name: 'thing-v1', knowledgeType: 'entity', schema: { propertySchemas: { size: { type: 'number' }, label: { type: 'string', required: true } } } };

const STORED = {
  purpose: 'a space',
  validationMode: 'strict',
  version: 4,
  updatedAt: '2026-11-02T00:00:00.000Z',
  previousVersions: [],
  typeSchemas: {
    entity: {
      linked: { $ref: 'library:thing-v1' },
      gone: { $ref: 'library:gone-v1' },
      inline: { propertySchemas: { colour: { type: 'string', enum: ['red', 'green'] } } },
    },
  },
};

/** The answer as `spaceMetaAnswer` returns it: the expanded meta without its history, between the fields it adds. */
function answerOf(stored) {
  const meta = schema.withSchemaLibrary([ENTRY], () => withLibraryDefinitions(stored));
  const { previousVersions: _pv, ...metaPublic } = meta;
  const answer = {
    spaceId: 'garden', spaceName: 'Garden', ...metaPublic,
    stats: { facts: 0, entities: 3, edges: 0, chrono: 0, files: 0 },
    needsReindex: false, reindexRun: null, invalidRules: [], actualSchema: { entity: { linked: { count: 3 } } },
  };
  for (const field of schema.SERVER_OWNED_META_FIELDS) if (!(field in answer)) answer[field] = null;
  return answer;
}

const ANSWER = answerOf(STORED);

let memo;
function all() {
  if (memo) return memo;
  const none = converted(ANSWER);
  const lib = converted(ANSWER, { library: [ENTRY] });
  const usage = (gen) => [
    `import type { SpaceTypes } from './${gen}';`, "import type { Equals, Expect, HasIndex } from './assert-types';",
    `type _a = Expect<Equals<keyof SpaceTypes['entity'], 'linked' | 'gone' | 'inline'>>;`,
    `type _b = Expect<Equals<keyof ${at('entity', 'linked')}, 'size' | 'label'>>;`,
    `type _c = Expect<Equals<${at('entity', 'linked')}[${lit('label')}], string>>;`,
    `type _d = Expect<HasIndex<${at('entity', 'gone')}>>;`,
    `type _e = Expect<Equals<Required<${at('entity', 'inline')}>['colour'], 'red' | 'green'>>;`,
  ].join('\n') + '\n';
  const files = { none: none.source, lib: lib.source, 'u-none': usage('none'), 'u-lib': usage('lib') };
  memo = { none, lib, files, result: compileInMemory(files) };
  return memo;
}

describe('the premise: the server\'s expansion', () => {
  it('shows a linked type as { $ref, ...definition } and a missing one as { $ref, _unresolvedRef }, beside the answer\'s own fields', () => {
    const types = ANSWER.typeSchemas.entity;
    assert.deepEqual(types.linked, { $ref: 'library:thing-v1', ...ENTRY.schema });
    assert.deepEqual(types.gone, { $ref: 'library:gone-v1', _unresolvedRef: 'library:gone-v1' });
    for (const key of ['spaceId', 'spaceName', 'stats', ...schema.SERVER_OWNED_META_FIELDS.filter(f => f !== 'previousVersions')]) {
      assert.ok(key in ANSWER, `the answer carries ${key}`);
    }
  });
});

describe('the meta answer converts', () => {
  it('the linked type from its definition, the missing one open, the inline one as declared; it compiles', () => {
    const { files, result } = all();
    assert.deepEqual(result.global, []);
    for (const f of Object.keys(files)) assert.equal(result.byFile[f].length, 0, `${f}:\n${withLines(result.byFile[f], files[f])}`);
  });

  it('kind-not-verified with no library and not with it; the missing entry is unresolved-ref either way', () => {
    const { none, lib } = all();
    assertReported(none.untranslated, { reason: 'kind-not-verified', kind: 'entity', type: 'linked' }, 'no library');
    assert.deepEqual(reportsLike(lib.untranslated, { reason: 'kind-not-verified' }), [], 'the library confirms the kind');
    for (const out of [none, lib]) assertReported(out.untranslated, { reason: 'unresolved-ref', kind: 'entity', type: 'gone' }, 'gone');
  });

  it('spaceId, spaceName, stats and the server-owned fields are ignored: no report names them', () => {
    const ignored = new Set(['spaceId', 'spaceName', 'stats', ...schema.SERVER_OWNED_META_FIELDS, 'purpose', 'validationMode']);
    for (const out of [all().none, all().lib]) {
      const named = out.untranslated.filter(u => ignored.has(u.field) || ignored.has(u.type));
      assert.deepEqual(named, [], 'a field of the answer around the meta is reported');
      assert.deepEqual(reportsLike(out.untranslated, { reason: 'type-skipped' }), [], 'a type of the answer is skipped');
    }
  });
});

const LISTS = {
  SERVER_WRITTEN_EDGE_LABELS: [...SERVER_WRITTEN_EDGE_LABELS],
  'built-in chrono types': [...getAllowedChronoTypes(undefined)],
  INSTANCE_WRITTEN_PROPERTY_KEYS: Object.values(INSTANCE_WRITTEN_PROPERTY_KEYS).flat(),
};

/** The values of each server list a header quotes, by list: a quoted value is how a copied list reads. */
function copiedInto(header) {
  return Object.entries(LISTS)
    .map(([name, values]) => [name, values.filter(v => new RegExp(`['"\`]${v.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"\`]`).test(header))])
    .filter(([, copied]) => copied.length > 0);
}

describe('the header copies no server list', () => {
  it('the reader: each list reads whole, and a planted header quoting one value of each is caught', () => {
    for (const [name, values] of Object.entries(LISTS)) assert.ok(values.length > 0, `${name} reads empty: the reader is broken`);
    const planted = `/** chrono falls back to ${Object.values(LISTS).map(v => `'${v[0]}'`).join(', ')} */`;
    assert.deepEqual(copiedInto(planted).map(([name]) => name), Object.keys(LISTS));
    assert.deepEqual(copiedInto('/** a space with no chrono types accepts the built-in ones */'), []);
  });

  it('names no edge label the server writes, no built-in chrono type and no key the instance writes', () => {
    const header = headerOf(all().none.source);
    assert.ok(header.length > 0, 'the source has a header');
    assert.deepEqual(copiedInto(header), [], 'the header copies a server list');
  });
});
