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
and a round-tripped `{ $ref, ...definition }` must equal the entry's definition. Without one, a `$ref` that names an entry is
refused as an entry that does not exist — which is what an instance without that entry would answer.

## One type at a time

```ts
import { parseTypeSchema } from '@ythril/schema';

const r = parseTypeSchema('edge', 'reports_to', { endpoints: { from: ['person'], to: ['person'] }, functional: true });
if (!r.ok) console.error(r.refusal.error, r.refusal.issues);
```

`parseTypeSchema` answers the single-type door's refusal, `{ error, issues }`, on the paths of the definition you sent.

## What else is exported

| export | what it is |
|---|---|
| `SpaceMeta`, `TypeSchema`, `PropertySchema`, `SchemaRule`, `SpaceSchemaRule`, `KnowledgeType`, `ValidationMode`, `MergeFn`, `DatePassedPolicy` | the types |
| `KNOWLEDGE_TYPES`, `MERGE_FNS`, `NUMERIC_MERGE_FNS`, `BOOLEAN_MERGE_FNS`, `DATE_PASSED_VALUES` | the runtime tuples the types derive from |
| `SPACE_PURPOSE_MAX`, `SCHEMA_DESCRIPTION_MAX`, `PROPERTY_DESCRIPTION_MAX`, `MAX_RULE_LENGTH`, `MAX_MESSAGE_LENGTH`, `MAX_RULES_PER_TYPE`, `MAX_RULES_PER_SPACE`, `MAX_APPLICABLE_RULES`, `RULE_NAME_PATTERN`, `MAX_PATTERN_LENGTH` | the limits an editor shows a counter for |
| `SpaceMetaBody`, `TypeSchemasZ`, `TypeSchemaZ`, `InlineTypeSchemaZ`, `PropertySchemaZ`, `TypeRuleZ`, `SpaceRuleZ` | the zod bodies (zod 4) |
| `parseSpaceMeta`, `parseTypeSchema`, `readPeerMeta`, `readStoredMeta`, `validateSpaceMeta` | the parses |
| `hasReDoSRisk`, `typeRuleIssues`, `spaceRuleIssues` | single checks: a pattern the server would refuse to run, a rule it could not apply |
| `refusalOfParse`, `peerText` | how a refusal is worded |

`@ythril/schema/internal` exists for the Ythril server and moves with it; an app should not import it.

## Versions

The package is versioned with the Ythril release it was cut from: `@ythril/schema@6.3.0` validates what a 6.3.0 server
accepts. A newer server may accept a field an older package refuses; validate against the package of the oldest server you
write to.

## Licence

[PolyForm Small Business 1.0.0](https://github.com/ythril-network/Ythril/blob/main/LICENSE), the licence of the Ythril
repository it is built from.
