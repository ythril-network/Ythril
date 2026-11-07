# @ythril-network/schema

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
npm install @ythril-network/schema@<your server's version>
```

The package is on the npm registry from 6.5.0, versioned with the Ythril release it was cut from (see [Versions](#versions));
install the version of the server you write to. To install a build of your own instead, pack it from a clone of the
repository and install the tarball:

```sh
npm pack -w @ythril-network/schema
npm install ./ythril-network-schema-*.tgz
```

ESM only, Node 22 or later: the CEL rule engine (`@bufbuild/cel`) is loaded with a top-level `await`.

An app that reads a space meta back from TypeScript (see [Read a space meta from TypeScript](#read-a-space-meta-from-typescript))
also installs the compiler itself: `typescript` is an optional peer dependency (`>=5.4`), loaded only by the
`@ythril-network/schema/from-typescript` entry. An app that never reads TypeScript installs nothing more.

## Validate a space meta

```ts
import { validateSpaceMeta, type SpaceMeta } from '@ythril-network/schema';

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
import { validateSpaceMeta } from '@ythril-network/schema';

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
import { parseTypeSchema } from '@ythril-network/schema';

const r = parseTypeSchema('edge', 'reports_to', { endpoints: { from: ['person'], to: ['person'] }, functional: true });
if (!r.ok) console.error(r.refusal.error, r.refusal.issues);
```

`parseTypeSchema` answers the single-type door's refusal, `{ error, issues }`, on the paths of the definition you sent.

## Generate TypeScript types

```ts
import { writeFileSync } from 'node:fs';
import { typesOfSpaceMeta } from '@ythril-network/schema';

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

`ENUM_LITERAL_MAX` is `200`: an enum with more values is written as its base type and reported as `enum-too-long`. The
reasons, the whole list (a reason added is a deliberate edit an app's switch can see):

- `not-translated`: a field TypeScript cannot carry (a type's rules, naming pattern, retention, a space's rules), named in `field`.
- `type-skipped`: a type the parse refuses, or one that is not an object; `detail` has the parse's words.
- `unknown-field`: a field this release does not know (a newer server wrote it), stripped before the parse; named in `field`.
- `unresolved-ref`: a `$ref` no library entry answers; the type is written open.
- `wrong-kind-ref`: a `$ref` to an entry filed under another knowledge type; the type is written open, `detail` names that kind.
- `kind-not-verified`: a type converted from the definition beside its `$ref` with no library entry to confirm the kind.
- `enum-emptied`: an enum none of whose values has the declared type; the member is `never`.
- `enum-too-long`: an enum longer than `ENUM_LITERAL_MAX`; the member is its base type.
- `renamed`: a type whose identifier was taken; `detail` is the one it got.
- `no-type-schemas`: a meta with no type schemas to read (missing, or not an object, or the meta itself is not one).

## Read a space meta from TypeScript

```ts
import { spaceMetaFromTypeScript } from '@ythril-network/schema/from-typescript';

const answer = await spaceMetaFromTypeScript(readFileSync('src/garden-types.ts', 'utf8'));
if (!answer.ok) throw new Error(answer.refusals.map(r => `${r.path.join('.')}: ${r.reason}`).join('\n'));
const { meta, notRead } = answer; // meta.typeSchemas: what the source declares; notRead: what it could not carry
```

`spaceMetaFromTypeScript` is the way back from `typesOfSpaceMeta`: it reads a space's type schemas out of TypeScript (the
integration guide's [Schema API](https://github.com/ythril-network/Ythril/blob/main/docs/integration-guide/06a-schema-api.md#read-a-space-meta-from-typescript)
tells the same from the app's side). The
source is one exported interface or type alias, `SpaceTypes` unless `options.map` names another, shaped as the forward direction
writes it: a knowledge type, then a type name as a string literal, then `{ properties: <object type> }` (a `stored` entry is
ignored). It lives behind its own export, `@ythril-network/schema/from-typescript`, and the main entry never loads it.

| Export | What it is |
| --- | --- |
| `spaceMetaFromTypeScript` | `(source, options?) => Promise<FromTypeScriptResult>`: the meta the source declares, or every reason it cannot be read |
| `UNREPRESENTED_REASONS` | the closed list of reasons a source is refused, each below |
| `SOURCE_MAX` | the most characters of source one call reads; a longer one is refused before anything is parsed |
| `FromTypeScriptOptions` | `{ map?, typescript? }`: the interface that holds the map, and a loaded compiler to use |
| `FromTypeScriptResult` | `{ ok: true, meta: { typeSchemas }, notRead }` or `{ ok: false, refusals, more }` |
| `Refusal` | `{ path, reason, detail, code? }`: where in the source, one of `UNREPRESENTED_REASONS`, bounded text; `code` is the compiler's number for `source-does-not-compile` |
| `NotRead` | `{ path }`: `[kind, type, 'propertySchemas', member, field]` for a field of a member the source cannot carry |

**The compiler is yours.** `typescript` is an optional peer dependency (`>=5.4`): npm does not install it for you, and the main
entry never loads it. The range has no ceiling, so an app whose own `typescript` is newer still installs the package. The first
call loads it from your own install; with none, the call rejects with one error that names the fix, `npm install typescript@6`,
and the `typescript` option, which takes a module you loaded yourself. A `typescript` with no compiler API (7.x has none) is refused
the same way, and the error also names the install that keeps yours: `npm install typescript-6@npm:typescript@6`, then pass
`(await import('typescript-6')).default` as the `typescript` option. Any other error loading it is thrown as it is. The compile is closed: it reads the source you gave it and the compiler's own lib, and nothing else on the
machine; no import resolves.

**Whole or nothing.** A source with one member this cannot say exactly is refused as a whole, with up to ten refusals and
`more` counting the rest; a type is never read as one near it. A member reads as a kind (`string`, `number`, `boolean`), as an
enum (a union of string or number literals, in the order the source lists them, at most `ENUM_LITERAL_MAX`), optional with `?` or
`| undefined`, and untyped as the forward direction writes it (`string | number | boolean` on an entity, `unknown` on any
other kind). An object whose only member is an index signature is an open type.

**What the source cannot carry is named, not dropped.** A date reads back as a string; a boolean enum widens to boolean; a
required property with a default reads back optional; a pattern, a minimum, a maximum, a default, a merge function and a
description are only notes in the source. Each is an entry in `notRead`, by path, and none is read back. The server replaces each
type it is handed whole, so merge the result over the stored meta before you write it, or the write strips what `notRead` names.

The reasons, the whole list (a reason added is a deliberate edit an app's switch can see):

- `imports-not-read`: an import, an `export ... from` or a `/// <reference>`; the compile resolves nothing, so the source must be whole.
- `directive-not-read`: a `@ts-nocheck`, `@ts-ignore` or `@ts-expect-error` comment, which would switch off the diagnostics that judge the source.
- `source-too-large`: more than `SOURCE_MAX` characters; refused before the compiler loads.
- `map-not-found`: no interface or type alias of the map's name, or a type of it with no object `properties` member.
- `unknown-kind`: a key of the map that is not one of the four knowledge types.
- `internal-name`: a type or member named `__proto__`, `constructor` or `prototype`, which no plain object can carry as a key.
- `null-not-representable`: a member that admits `null`.
- `never-not-representable`: a member that is `never`, or has no value but `undefined`.
- `untyped-not-read`: a member that is `any`, `unknown` on an entity (an entity value is a primitive), or an index signature that is typed.
- `date-not-representable`: a `Date` (write the date as a string).
- `object-not-representable`: an object type, or an index signature beside declared members.
- `array-not-representable`: an array or a tuple.
- `union-not-representable`: a union that is not literals of one base type.
- `method-not-representable`: a method or a function type.
- `generic-not-representable`: a generic type or alias.
- `template-not-representable`: a template literal type.
- `branded-not-representable`: an intersection, such as a branded string.
- `enum-too-long`: a union of literals longer than `ENUM_LITERAL_MAX`.
- `source-does-not-compile`: a diagnostic of the file (`code` is the compiler's number, `detail` its text); a `@ts-` comment cannot silence it.
- `compiler-failed`: the compiler threw on the source (a nesting deeper than it can follow, for one).
- `server-refuses`: what was read is not a meta the server stores; `detail` is the server's own sentence.

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
`@ythril-network/schema/internal` exists for the Ythril server (its merges, its reads of a peer's and a stored meta, its library
installer) and moves with it; an app should not import it.

## Versions

The package is versioned with the Ythril release it was cut from: `@ythril-network/schema@6.5.4` validates what a 6.5.4 server
accepts. It was first published as 6.5.0; no earlier version is on the registry. A newer server may accept a field an older package refuses; validate against the package of the oldest server you
write to.

## Licence

[Apache License 2.0](LICENSE). This package is Apache-2.0, unlike the rest of the Ythril repository it is built from; its
[NOTICE](NOTICE) names the runtime dependencies npm installs beside it.
