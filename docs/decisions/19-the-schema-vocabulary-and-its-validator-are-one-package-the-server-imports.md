# 19 — The space-schema vocabulary and its validator are one package, `@ythril/schema`, which the server imports and an app can run

**Status:** proposed, 2026-11-01 · **Scope:** the types, tuples and limits of a space schema, the zod bodies of a space meta and its type schemas, the parses that mint a stored meta (`parseSpaceMeta`, `parseTypeSchema`, `readStoredMeta`, `readPeerMeta`), the save-time CEL rule checks, and the text a refusal of them is worded in

## Context

A space schema is written by more than the server's own doors. Apps that write to Ythril — space templates, generators,
flows — build `meta.typeSchemas` themselves, and each kept a hand-written mirror of `TypeSchema`, the limits and the
rules a body enforces. They learned whether a schema was valid only when an instance answered `400`, on a live space at
deploy time. A mirror in another repository drifts from the server on the first change to either, and nothing in either
repository can see it: this repository's gates hold one definition per question inside the tree, and an outside copy is
outside every one of them.

The validator could not simply be handed out: `server/src/spaces/body-schemas.ts` read the instance's schema library
through `config/loader.ts`, which brings the environment, the secrets and the logger with it, and the refusal text was
worded by `util/log.ts`, the logger itself.

## Decision

- **The vocabulary and the validator are one npm workspace, `schema/` (`@ythril/schema`), and the server imports it.**
  The server modules that defined them (`config/types-knowledge.ts`, `spaces/body-schemas.ts`, `spaces/schema-rules.ts`,
  `spaces/meta-fields.ts`, `spaces/_shared.ts`, `util/log.ts`, `util/redos.ts`, ...) re-export the package's objects, so
  every importer keeps its path and no definition exists twice. The server's answers and refusal texts are unchanged.
- **The package reads no instance.** The schema library a `$ref` names is handed in: an app passes the entries it knows
  (`validateSpaceMeta(meta, { library })`), and the server installs its own library once (`useSchemaLibrary`, in
  `spaces/library-ref-expansion.ts`), read at each parse. The package imports zod, the CEL engine and Node built-ins only.
- **What the server alone needs stays in the server**: the route bodies (create, update, rename, delete, reorder, dupe
  rules), rule EVALUATION (the program cache, the boot check, the metrics), and the logger's ring, request ids and stack
  formatting. Rule evaluation compiles through the package's `compileRule`, so the analysis a save runs and the program a
  write runs are one.
- **The text a refusal is worded in moved with the validator**: `peerText`, `peerList`, `refusalOfParse` and the secret
  redaction they apply are the package's, and the logger formats its lines with them. Two copies would be a validator
  whose refusal drifts from the server's on the first edit of either.
- **The package is versioned with the release** (`@ythril/schema@6.3.0` validates what a 6.3.0 server accepts) and carries
  the repository's licence. Publishing it is a release step, not part of this decision.

## Consequences

- **A change to a schema body, limit or rule check is a change to `schema/src`.** The server picks it up on its next
  build (`server` runs `tsc -p ../schema` before itself); the Docker image builds and ships `schema/dist` beside
  `server/dist`.
- **`@ythril/schema/internal` is not an app API.** It carries what the server shares beyond the schema (the text
  renderer, the bounded cache, the rule engine hook) and moves with the server.
- **A gate that read a definition from a server source file reads it from the package now**; the re-exports keep every
  import path, not every source path.
- **This is the reversal to prevent:** a second definition of a schema body, tuple, limit or refusal wording in the server
  "for convenience"; the package reading the instance's config, environment or files (an app has none); and an app keeping
  its own mirror of the vocabulary once the package is published.

## Where the detail lives

- `schema/README.md` — what the package is for and how an app validates a schema.
- `schema/src/space-meta.ts` — the bodies and the parses; `schema/src/validate.ts` — the app's dry entry.
- `schema/src/library.ts` — how the schema library is handed in.
- `schema/src/rules.ts` — the save-time CEL checks and `compileRule`; `server/src/spaces/schema-rules.ts` — evaluation.
- `testing/standalone/an-outside-apps-schema-validates-through-the-schema-package.test.js` — an outside app's metas
  validate through the package, the server's names are the package's, and no definition is left in the server.
- `docs/integration-guide/06a-schema-api.md` — the schema contract, and the package that checks it offline.
