# @ythril/schema

The vocabulary of a Ythril space schema, and the validator a Ythril server runs on it.

A Ythril space carries a schema in its meta: per knowledge type (`entity`, `fact`, `edge`, `chrono`) a map of type
definitions, each with its property schemas, naming pattern, retention, endpoints and CEL rules, beside the space's own
settings (`validationMode`, `purpose`, the space rules, ...). The server refuses a meta it would not store with a 400 that
names each failing part.

This package is that refusal, without a server. It is the code the server itself imports (`server/src/spaces/body-schemas.ts`
re-exports it), so an app that writes schemas — a space template, a generator, a flow — can:

- **type** what it writes with the server's own types (`SpaceMeta`, `TypeSchema`, `PropertySchema`, ...) instead of a
  hand-copied mirror;
- **read** the tuples and limits the server enforces (`KNOWLEDGE_TYPES`, `MERGE_FNS`, `DATE_PASSED_VALUES`,
  `SPACE_PURPOSE_MAX`, `MAX_RULES_PER_TYPE`, ...);
- **validate** a meta offline, in its own CI, and get the refusal text an instance would give.

The full contract of a schema is the integration guide's
[Schema API](https://github.com/ythril-network/Ythril/blob/main/docs/integration-guide/06a-schema-api.md); this package is
its machine-checkable half.

## Install

```sh
npm install @ythril/schema
```

ESM only, Node 22 or later: the CEL rule engine (`@bufbuild/cel`) is loaded with a top-level `await`.

## Validate a space meta

```ts
import { validateSpaceMeta, type SpaceMeta } from '@ythril/schema';

const meta: SpaceMeta = {
  validationMode: 'strict',
  typeSchemas: {
    entity: {
      person: {
        description: 'A person the space knows about.',
        propertySchemas: { email: { type: 'string', pattern: '^[^@]+@[^@]+$' } },
        rules: { named: { rule: "self.title != ''", message: 'a person has a name' } },
      },
    },
  },
};

const result = validateSpaceMeta(meta);
if (!result.ok) {
  // The server's own refusal: `message` is its 400 text, `failed` names each part (`entity:person — propertySchemas.email.pattern: ...`).
  console.error(result.message, result.failed);
  process.exit(1);
}
```

`validateSpaceMeta` is dry: it stores nothing and reads no configuration. It answers `{ ok: true, meta, unknown }` with the
parsed meta, or `{ ok: false, message, failed }`.

`message` is the text a server sends as its refusal's `error`. The paths in it are the meta's own
(`typeSchemas.entity.person...`); a `PATCH /api/spaces/:id` carries the meta under `meta`, so the server's paths for the
same fault start `meta.` (`meta.typeSchemas.entity.person...`).

Pass `{ tolerant: true }` to read a meta as a peer's: a key this release does not know is named in `unknown` instead of
refused (a key it knows and finds wrong still refuses). Leave it off for a schema your app writes, where an unknown key is
a typo the server would refuse.

Strip what is not part of the meta before you validate it (a space's `id`, `label` and other space-level fields live beside
`meta`, not in it). The server-owned fields a `GET` returns (`version`, `updatedAt`, `previousVersions`, ...) are dropped
for you, as the server drops them.

## Types that reference the schema library

A type may be declared `{ "$ref": "library:<name>" }`: its definition is an entry of the instance's schema library. The
package never reads an instance, so hand it the entries your meta references:

```ts
import { validateSpaceMeta } from '@ythril/schema';

const library = [
  { name: 'service-v1', knowledgeType: 'entity', schema: { propertySchemas: { url: { type: 'string' } } } },
];

validateSpaceMeta(meta, { library });
```

With a library, each `$ref` must name one of its entries, filed under the knowledge type the referencing type sits under,
and a round-tripped `{ $ref, ...definition }` must equal the entry's definition. Without one, the library is empty, and a
`$ref` that names an entry is refused as an entry that does not exist — which is what an instance without that entry would
answer.

A server answers a `$ref` to a missing entry, or to one filed under another knowledge type, with **422** (not 400): its
`error` is the same sentence as `message` here, with no `issues`. `libraryRefRefusal(typeSchemas, library)` asks that
question alone, and answers `{ message, failed }`, or `null` when every reference holds.

A direct parse (`parseSpaceMeta`, `parseTypeSchema`) reads the library for a round-tripped `{ $ref, ...definition }`. Run it
inside `withSchemaLibrary(entries, () => ...)`, with a synchronous callback (an async one throws): outside one, such a parse
throws "no schema library installed" rather than answering as if the library were empty.

## One type at a time

```ts
import { parseTypeSchema } from '@ythril/schema';

const r = parseTypeSchema('edge', 'reports_to', { endpoints: { from: ['person'], to: ['person'] }, functional: true });
if (!r.ok) console.error(r.refusal.error, r.refusal.issues);
```

`parseTypeSchema` answers the single-type door's refusal, `{ error, issues }`, on the paths of the definition you sent.

## Generate TypeScript types

```ts
import { writeFileSync } from 'node:fs';
import { typesOfSpaceMeta } from '@ythril/schema';

const meta = await (await fetch(`${base}/api/spaces/garden/meta`, { headers })).json();
const { source, untranslated } = typesOfSpaceMeta(meta, { library: entries });
writeFileSync('src/garden-types.ts', source);
for (const u of untranslated) console.warn(u.reason, u.kind ?? '', u.type ?? '', u.field ?? '', u.detail ?? '');
```

`typesOfSpaceMeta` turns a space's type schemas into TypeScript. Per type it writes `<Kind><Name>Properties`, what a create
must carry, and `<Kind><Name>StoredProperties`, what a stored record may hold (every member `unknown`, any other key
allowed); `SpaceTypes` maps each knowledge type and real type name to both, so `SpaceTypes['entity']['plant']['properties']`
needs no identifier. A patch is `Partial<...>` of the create type.

- Convert with the package of the server the meta was read from, or a newer one: a field a newer server added is stripped
  and reported, not translated.
- Required members and the closed key list hold under `validationMode: 'strict'` only; under `warn` or `off` the server
  accepts more than the types state.
- The output is a snapshot: regenerate it after a schema or validation-mode change.

It takes the meta as the GET meta answer gives it (the answer's own fields are ignored, a library type is read from the
definition beside its `$ref`), a stored meta, or a written one. It never throws and never refuses as a whole: a type the
parse refuses is skipped, and everything the source does not carry (CEL rules, naming patterns, retention, endpoints,
unresolved `$ref`s, renamed identifiers) is an entry in `untranslated`, with one of `UNTRANSLATED_REASONS`. Pass `library`
to resolve a bare `$ref` and to confirm an expanded one's kind. An enum longer than `ENUM_LITERAL_MAX` is written as its
base type.

## What else is exported

| export | what it is |
| --- | --- |
| `SpaceMeta`, `TypeSchema`, `PropertySchema`, `SchemaRule`, `SpaceSchemaRule`, `KnowledgeType`, `ValidationMode`, `MergeFn`, `NumericMergeFn`, `BooleanMergeFn`, `DatePassedPolicy` | the schema types |
| `KNOWLEDGE_TYPES`, `MERGE_FNS`, `NUMERIC_MERGE_FNS`, `BOOLEAN_MERGE_FNS`, `DATE_PASSED_VALUES` | the runtime tuples the types derive from |
| `SPACE_PURPOSE_MAX`, `SCHEMA_DESCRIPTION_MAX`, `PROPERTY_DESCRIPTION_MAX`, `MAX_RULE_LENGTH`, `MAX_MESSAGE_LENGTH`, `MAX_RULES_PER_TYPE`, `MAX_RULES_PER_SPACE`, `MAX_APPLICABLE_RULES`, `RULE_NAME_PATTERN`, `MAX_PATTERN_LENGTH`, `LONGEST_CHECKED_STRING` | the limits an editor shows a counter for |
| `NAME_QUOTED`, `LOG_VALUE_MAX`, `REFUSAL_NAMES_MAX`, `MAX_UNKNOWN_NAMES` | how much of a caller's text, and how many names, a refusal shows before it cuts and counts the rest |
| `SpaceMetaBody`, `TypeSchemasZ`, `TypeSchemaZ`, `InlineTypeSchemaZ`, `PropertySchemaZ`, `EndpointMemberZ`, `TypeRuleZ`, `SpaceRuleZ` | the zod bodies (zod 4) |
| `parseSpaceMeta`, `parseTypeSchema`, `parseInlineDefinition`, `validateSpaceMeta` | the parses |
| `ParsedSpaceMeta`, `ParsedTypeSchema`, `MetaParse`, `MetaParseOptions`, `ValidateSpaceMetaOptions` | what the parses answer and the options they take |
| `libraryRefRefusal`, `withSchemaLibrary`, `currentSchemaLibrary`, `libraryDefinitionOf`, `libraryEntryNameOf`, `takeBackLibraryDefinition`, `libraryDeletePathProblem` | the schema library: the `$ref` refusal, a scoped library and the one a parse reads now, an entry's definition, the entry a reference names, a round-tripped `$ref` taken back to its entry, why a `deleteFields` path names nothing |
| `LIBRARY_REF_PREFIX`, `LIBRARY_SCHEMA_KEYS` | the prefix a library reference carries (`library:`) and the keys an entry's schema can hold |
| `SchemaLibraryEntryLike`, `SchemaLibrarySource`, `WrongKindLibraryRef` | the library's types: an entry as a parse reads it, where a parse gets its entries, a `$ref` to an entry of another kind |
| `META_FIELD_KINDS`, `PER_TYPE_META_FIELD`, `SERVER_OWNED_META_FIELDS`, `metaFieldKind`, `unknownMetaFields`, `stripServerOwnedMeta`, `MetaFieldKind` | the fields of a meta: the kind of each, the ones a server owns and a request drops, the names a tolerant read reports |
| `VIEW_FIELDS`, `ALL_VIEW_FIELDS`, `ViewField`, `ViewKind` | what `self` holds in a rule, per kind |
| `hasReDoSRisk`, `REDOS_REFUSAL`, `typeRuleIssues`, `spaceRuleIssues`, `applicableRuleIssues`, `ruleMapIssues`, `collectionScopeIssues`, `readingStoredRules`, `RuleIssue`, `ChangedRuleParts` | single checks: a pattern the server would refuse to run and its wording, a rule it could not apply, the rules that apply to one record, a rules map's shape, a field that does not belong under `collection`, a read of a stored meta with the save-time rule checks off |
| `refusalOfParse`, `peerText`, `peerList`, `unrecognizedKeysIssue`, `ParseRefusal`, `ParseRefusalIssue`, `ParseRefusalOptions`, `ParseIssueLike` | how a refusal is worded, and its shape |
| `typesOfSpaceMeta`, `UNTRANSLATED_REASONS`, `ENUM_LITERAL_MAX`, `TypeScriptOptions`, `TypeScriptSource`, `Untranslated` | a space's type schemas as TypeScript, the reasons a part was not translated, the longest enum written as literals, and the call's options, answer and report entry |

The entry's names are a fixed list, held by a test in the Ythril repository: a new export is a decision, not a side effect.
This table names every one of them, and a second test holds the table to that list.
`@ythril/schema/internal` exists for the Ythril server (its merges, its reads of a peer's and a stored meta, its library
installer) and moves with it; an app should not import it.

## Versions

The package is versioned with the Ythril release it was cut from: `@ythril/schema@6.3.2` validates what a 6.3.2 server
accepts. The package is first published with 6.3.2. A newer server may accept a field an older package refuses; validate against the package of the oldest server you
write to.

## Licence

[Apache License 2.0](LICENSE). This package is Apache-2.0, unlike the rest of the Ythril repository it is built from; its
[NOTICE](NOTICE) names the runtime dependencies npm installs beside it.
