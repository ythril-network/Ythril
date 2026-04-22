# Changelog

All notable changes to Ythril are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **Instance-level Schema Library** — a dedicated first-class store of reusable `TypeSchema` definitions, persisted in `schema-library.json` (sibling to `config.json`).
  - Full CRUD REST API: `GET/POST/PUT/DELETE /api/schema-library/:name`. Max 500 entries. Entry names must match `^[a-z0-9][a-z0-9_-]{0,199}$`.
  - `TypeSchema` now accepts `{ "$ref": "library:<name>" }` in place of an inline definition. `resolveMetaRefs()` in `schema-validation.ts` resolves all refs before validation runs. Unresolvable refs silently degrade to an empty schema (no constraints).
  - Editing a library entry takes effect immediately for all referencing spaces — no per-space re-patch needed.
  - **Schema Library** UI is a top-level page (`/schema-library`) accessible from the Workspace section of the main navigation. Editor reuses the same TypeSchemaState-based form as the per-space schema editor (naming pattern, tag suggestions, full property table).
  - Per-type export/import buttons in the spaces schema editor: **→ Lib** (save to library) and **← Lib** (import inline or as `$ref`). Types using `$ref` display a blue badge in the type list.
  - File export (↓) and bulk import from file (↑ Import from file) in the library page.
  - Integration tests: `testing/integration/schema-library.test.js` covering CRUD, `$ref` resolution, live library-update propagation, unresolvable-ref fallback, 409 duplicate, 400 invalid payloads, and name-format validation.
  - i18n: en / de / pl.

---


## [1.0.0] — 2026-04-20

### ⚠ Breaking Changes

Two breaking API changes are present in this release. Clients, tests, and scripts that were written against the 0.9.x/0.10.x schema API or the chrono API must be updated before upgrading.

---

#### 1. `ChronoEntry.kind` renamed to `type`

The `kind` field on chrono entries has been renamed to `type` to be consistent with all other knowledge types in the API (`memory.type`, `entity.type`, `edge.type`).

**Affected endpoints:**
- `POST /api/brain/spaces/:spaceId/chrono` — request body
- `POST /api/brain/spaces/:spaceId/bulk` — `chrono[]` items in the bulk body
- `GET /api/brain/spaces/:spaceId/chrono` — response documents
- MCP tools: `create_chrono`, `bulk_write` (chrono items), `list_chrono` (filter param and response)

**Migration — before:**
```json
{ "title": "Sprint review", "kind": "event", "startsAt": "2026-05-01T10:00:00Z" }
```

**Migration — after:**
```json
{ "title": "Sprint review", "type": "event", "startsAt": "2026-05-01T10:00:00Z" }
```

Valid values are unchanged: `event`, `deadline`, `plan`, `prediction`, `milestone`.

The TypeScript type alias `ChronoKind` remains exported as a deprecated alias for `ChronoType` to ease library migration, but will be removed in a future release.

---

#### 2. Space schema meta format replaced by `typeSchemas`

The flat schema fields on `SpaceMeta` (`entityTypes`, `edgeLabels`, `namingPatterns`, `requiredProperties`, `propertySchemas`) have been replaced by a single nested `typeSchemas` object. The old flat fields are no longer accepted — `PATCH /api/spaces/:id` uses a strict Zod schema and will return 400 `unrecognized_key` for any old field names.

**Affected endpoints:**
- `PATCH /api/spaces/:id` — `meta` field in request body
- `GET /api/spaces/:id/meta` — response shape (no `entityTypes` array in response)
- `POST /api/spaces/:id/validate-schema` — schema in `meta` payload
- MCP tools: `update_space` (meta argument), `get_space_meta` (response)

**Migration — before (flat format):**
```json
{
  "validationMode": "strict",
  "entityTypes": ["service", "person"],
  "edgeLabels": ["depends_on", "owns"],
  "namingPatterns": { "service": "^[A-Z]" },
  "requiredProperties": {
    "entity": ["team"],
    "memory": ["source"],
    "edge": ["confidence"],
    "chrono": ["priority"]
  },
  "propertySchemas": {
    "entity": { "team": { "type": "string", "enum": ["alpha", "beta"] } },
    "memory": { "source": { "type": "string" } },
    "edge": { "confidence": { "type": "number", "minimum": 0, "maximum": 1 } },
    "chrono": { "priority": { "type": "string", "enum": ["low", "medium", "high"] } }
  }
}
```

**Migration — after (`typeSchemas` format):**
```json
{
  "validationMode": "strict",
  "typeSchemas": {
    "entity": {
      "service": {
        "namingPattern": "^[A-Z]",
        "propertySchemas": {
          "team": { "type": "string", "enum": ["alpha", "beta"], "required": true }
        }
      },
      "person": {
        "propertySchemas": {
          "team": { "type": "string", "enum": ["alpha", "beta"], "required": true }
        }
      }
    },
    "edge": {
      "depends_on": {
        "propertySchemas": {
          "confidence": { "type": "number", "minimum": 0, "maximum": 1, "required": true }
        }
      },
      "owns": {}
    },
    "memory": {
      "note": {
        "propertySchemas": {
          "source": { "type": "string", "required": true }
        }
      }
    },
    "chrono": {
      "event": {
        "propertySchemas": {
          "priority": { "type": "string", "enum": ["low", "medium", "high"], "required": true }
        }
      }
    }
  }
}
```

Key differences:
- `entityTypes` and `edgeLabels` are gone — allowed types/labels are now inferred from the keys of `typeSchemas.entity` and `typeSchemas.edge`
- `namingPatterns` (global map) → `typeSchemas.entity.<typeName>.namingPattern` (per-type inline string)
- `requiredProperties` (list per knowledge-type) → `required: true` flag inline on each `propertySchemas` entry
- `propertySchemas` (nested `entity/memory/edge/chrono`) → `typeSchemas.<knowledgeType>.<typeName>.propertySchemas`
- To clear a schema entirely, send `{ "typeSchemas": {} }` — the old empty-list pattern (`"entityTypes": []`) is no longer accepted
- `GET /api/spaces/:id/meta` no longer returns `entityTypes` — check `typeSchemas` instead

**Memory and chrono schema validation now require `type` field:**
Schema validation for memories and chrono entries is only triggered when the document carries a `type` field matching a key in `typeSchemas.memory` / `typeSchemas.chrono` respectively. Documents without a `type` are not validated (allowing untyped legacy data to coexist). To enforce validation, define the types you care about in `typeSchemas` and always include `type` in write payloads.

---

### Security

- **Sync write routes require non-read-only tokens**: All `POST` routes under `/api/sync/` now enforce `denyReadOnly`, matching the same constraint on the brain and admin APIs. Previously a read-only token could push gossip, bulk-upsert documents, and trigger reindexes. Any sync client using a scoped read-only token for writes must be issued a full-access token.
- **Sync member URL hijacking fixed**: `POST /api/sync/networks/:networkId/members` now verifies that the requesting `peerInstanceId` matches the member record being submitted. A peer could previously register a URL pointing to any host on behalf of any other member.
- **Sync vote forgery fixed**: `POST /api/sync/networks/:networkId/votes/:roundId` now verifies that `instanceId` in the vote payload matches the authenticated `peerInstanceId`. A peer could previously cast votes on behalf of other members in a vote round.
- **CSP hardened**: Content-Security-Policy response header now includes `object-src 'none'; base-uri 'self'` in addition to the existing directives, blocking plugin/embed injection and base-tag hijacking.

### Fixed

- **Memory `type` field now stored and validated**: `POST /api/brain/:spaceId/memories` and `POST /api/brain/spaces/:spaceId/memories` previously ignored the `type` field in the request body — it was neither stored nor passed to schema validation. `type` is now extracted, stored on the document, and forwarded to `validateMemory` so `typeSchemas.memory` rules are enforced correctly.
- **Bulk write memory `type` not passed to validator**: In `POST /api/brain/spaces/:spaceId/bulk`, each memory item's `type` was extracted but not forwarded to `validateMemory`, meaning required-property rules defined under `typeSchemas.memory.<typeName>` were silently skipped. All three memory items would be inserted regardless of schema violations. Now `type` is passed to both the validator and the `remember()` call.

## [0.10.3] — 2026-04-18

### Changed

- **Entity type dropdown**: The entity type field is now a `<select>` when the space schema defines `entityTypes`, making it required and preventing free-text entry of unknown types. The first defined type is pre-selected when the create form opens.
- **Entity type change rebuilds properties**: Selecting a different entity type in the create, inline-edit, or drawer-edit form rebuilds the properties object to match the schema for that type — existing values are preserved and new required fields are added with their defaults.
- **Edge label dropdown**: The edge label field is now a `<select>` when the space schema defines `edgeLabels`, replacing the free-text input. The first defined label is pre-selected.
- **Schema violation error messages**: API errors with `error: 'schema_violation'` are now formatted as human-readable messages listing each violated field and reason (e.g. `Schema violation — properties.status: required property 'status' is missing or empty`).
- **Linked entities shown as name chips**: The "entities" column in the Memories and Chrono tables now displays entity name chips (resolved via the entity name cache) instead of a plain "X linked" count, consistent with the Files tab.
- **Edit button removed from rows**: The ✎ inline-edit button has been removed from Memory, Entity, Edge, and Chrono table rows — the ⊙ view-details button (which opens the full editable drawer) is the single entry point for editing. The ✎ button is retained on File Metadata rows which have no drawer.

## [0.10.2] — 2026-04-16

### Changed

- **Enable Networks one-click bootstrap**: The wizard now bootstraps the local connector automatically so users no longer need to run the workstation setup command manually in normal cases.
- **First-run cloudflare automation**: One-click setup now handles `cloudflared` install, Cloudflare login (when needed), tunnel ensure/create, and tunnel config writing in an idempotent flow.
- **Safer DNS behavior**: DNS overwrite is now explicit user choice; overwrite remains off by default and can be opted in when replacing an existing hostname record is intentional.
- **Wizard flow clarity**: Automatic path is now primary; manual command flow is shown only as fallback, reducing confusion for non-technical operators.

### Fixed

- **cloudflared runtime launch path**: User-mode tunnel startup now uses the resolved `cloudflared` executable path instead of a hardcoded command name, improving reliability on fresh Windows installs.

## [0.10.1] — 2026-04-16

### Added

- **Proxy wildcard `['*']`**: Create Space now supports an "All" proxy-for option stored as the sentinel value `['*']`. The server resolves this at query time to all current non-proxy spaces, so spaces added after the proxy was created are automatically included without reconfiguration.
- **Purpose field on space creation**: Create Space dialog now exposes a `Purpose` textarea (mapped to `meta.purpose`) with a rich default template listing all 29 available MCP tools, making space intent visible to LLM clients during the MCP handshake.
- **Schema validation on space creation**: `validationMode` (off / warn / strict) and `strictLinkage` can now be set at creation time in the Admin → Spaces dialog instead of only through a post-creation patch.

### Changed

- **Create Space dialog wider**: max-width increased from 700 → 960 px and the purpose field uses a larger textarea (5 rows, 4000 char max) to accommodate detailed descriptions.
- **Audit log consolidated**: Server Logs are now only in Logs → Server Log sub-tab. The duplicate section in the About page has been removed. The stream auto-starts when the tab is activated — no manual Stream button needed.
- **Retention time displayed**: Audit Log tab now shows the configured retention period (days) next to the export buttons, read from the server config.
- **Built-in column removed**: The redundant "Built-in" column has been removed from the Admin → Spaces table.

### Fixed

- **File manager directory detection**: `listFiles` now correctly maps the server's `type: 'file'|'dir'` and `modifiedAt` response fields to the client `FileEntry` shape (`isFile`, `isDirectory`, `modified`). Previously all entries appeared as files and folders could not be navigated.
- **File download 401**: Download links now include the bearer token as a `?token=` query parameter, matching the server's existing fallback for contexts where `Authorization` headers cannot be set.
- **File preview 401**: The preview fetch for text files now sends the `Authorization: Bearer` header so previewing files no longer returns `{"error":"Missing Authorization header"}`.

## [0.10.0] — 2026-04-15

### Added

- **Entity-centric graph exploration UI**: New graph-first workflow to inspect entities with linked chrono and memory context in a single view, improving relationship discovery and triage for dense knowledge spaces.
- **Entity merge API + MCP tool**: `POST /api/brain/spaces/:spaceId/entities/:survivorId/merge/:absorbedId` and `merge_entities` MCP tool with per-property conflict resolution, relinking, and duplicate-edge warning support.
- **Field deletion in partial updates**: `deleteFields` dot-notation support added to PATCH update flows (memories/entities/edges) and corresponding MCP update tools, enabling safe cleanup of stale keys without full document rewrites.
- **Strict linkage enforcement mode**: per-space `strictLinkage` opt-in enforcing UUID linkage semantics for references plus stronger entity-delete protections when backlinks exist.
- **Test orchestration improvements**: full-suite runner with automatic cleanup path and explicit keep-artifacts mode (`test:all:keep`) to make CI/local runs deterministic while preserving debug workflows when needed.

### Changed

- **Version line promoted to 0.10.0**: post-v0.9.1 feature accumulation (graph UX, merge semantics, strict linkage, update model changes) consolidated into a minor release bump.
- **Documentation parity sweep**: integration and developer documentation re-audited against current server/client implementation and recent commits, with endpoint coverage corrections and MCP/API alignment updates.
- **Repository hygiene updates**: test command/path references normalized to the current `testing/` layout and compose invocation patterns aligned for reproducible local and CI execution.

### Fixed

- **UI settings/feedback correctness**: follow-up fixes across Brain/Settings UX including data table behavior, dialog consistency, and quota naming (`minGiB` → `maxGiB`) to reduce operator confusion.
- **Audit and observability polish**: incremental fixes in audit-related UI/behavior and log-viewing workflows to improve reliability during investigations.

## [0.9.2] — 2026-04-15

### Changed

- **Documentation parity pass**: `docs/integration-guide.md` was reconciled against the current server implementation and commit history to ensure endpoint coverage reflects the actual code surface.
- **Sync API reference expanded**: replaced partial/high-level endpoint notes with a full route overview including collection sync routes, gossip routes, warm-up endpoint, and updated request/response examples.
- **Brain API reference corrected**: documented REST availability for recall, added structured query and file-metadata listing endpoints, and clarified behavior where MCP and REST parity exists.
- **Auth/admin endpoint coverage improved**: added missing token self-introspection (`GET /api/tokens/me`), readiness probe (`GET /ready`), OIDC discovery (`GET /api/auth/oidc-info`), and admin log streaming (`GET /api/about/logs/stream`) documentation.
- **Setup and conflict utilities documented**: added legacy first-run HTML setup routes and conflict/link-violation utility endpoints used by operations/testing.
- **Version metadata alignment**: root, client, server package versions and lockfile metadata bumped to `0.9.2`.

## [0.9.1] — 2026-04-12

### Security

- **Fork depth chain bypass**: The fork-depth check in the sync protocol counted only direct siblings (`countDocuments({ forkOf })`) instead of walking the chain upward. An attacker could create an unbounded A→B→C→… chain by targeting each new fork's `_id`. Replaced with `forkChainDepth()` — walks the `forkOf` chain upward with a visited-set cycle guard and hard cap at `MAX_FORK_DEPTH`. Fixed at both single-doc and batch-upsert sites.
- **Rate-limit IP isolation**: Added `app.set('trust proxy', 1)` so `req.ip` reflects the real client address behind reverse proxies (Traefik, nginx). Without this, all clients behind Docker/K8s shared a single rate-limit bucket.
- **Webhook secrets encrypted at rest**: Webhook secret strings are now AES-256-GCM encrypted before storage and decrypted on read. Requires `webhookEncryptionKey` in the secrets file.

### Fixed

- **Dynamic `import()` in sync handlers**: Replaced 4 dynamic `await import()` calls inside request handlers (`uuid`, `manifest.js`, `merkle.js`, `loader.js`) with top-level static imports. Eliminates per-request module-resolution latency.
- **Webhook retry queue**: Replaced in-memory `setTimeout` retry chains with a MongoDB-backed retry queue (`_webhook_retry_queue` collection with `scheduledAt` index). Retries survive process restarts.
- **Webhook auto-disable**: Webhooks that reach the maximum retry count are automatically set to `status: 'failing'` and excluded from future dispatch until re-enabled.
- **Webhook delivery TTL**: Delivery history records are TTL-indexed (`_expireAt` + `expireAfterSeconds: 0`) for automatic purge.
- **Typed error routing**: Introduced `NotFoundError` and `ValidationError` classes. Brain memory lookups throw typed errors; the API layer catches and routes to 404/400 without string matching.
- **Audit middleware method grouping**: Route rules refactored into `RULES_BY_METHOD: ReadonlyMap` — O(1) method lookup instead of scanning all rules. Added `bulk.write` and `brain.traverse` operation names.
- **Audit TTL index**: Switched from `createIndex({ timestamp }, { expireAfterSeconds })` to `collMod` with a bare `{ timestamp: -1 }` performance index and a dedicated `_expireAt` BSON Date field for the TTL daemon.

### Changed

- **Contribution guide**: Added comprehensive **Engineering Principles** section covering six non-negotiable standards: Security, Scalability, Stability, State-of-the-Art, Cleverness (simplicity), and Legal — with concrete, enforceable rules drawn from the codebase.

## [0.9.0] — 2026-04-11

### Added

- **Space schema definition and validation**: Spaces now carry a `meta` block that defines allowed entity types, edge labels, naming patterns (regex per entity type), required properties (per knowledge type), and property value schemas (type, enum, min/max, pattern). Three validation modes: **strict** (rejects violations with 400), **warn** (accepts with warnings array), **off** (default). Configured via `PATCH /api/spaces/:id` with a `meta` field.
- **`GET /api/spaces/:id/meta`**: Read a space's full schema definition with derived stats (memory/entity/edge/chrono/file counts). Returned to MCP clients via the `get_space_meta` tool.
- **`POST /api/spaces/:id/validate-schema`**: Dry-run schema validation — scans existing data (up to 10K docs per collection, 500 violations reported) against the current or proposed schema without writing anything. Useful for auditing impact before enabling strict mode.
- **Schema validation in bulk writes**: `POST /api/brain/spaces/:spaceId/bulk` and the MCP `bulk_write` tool now validate each item against the space schema. Strict mode skips violating items (recorded as errors); warn mode proceeds with warnings.
- **MCP `get_space_meta` tool**: Returns the full space schema, purpose, usage notes, and stats. The schema summary is also injected into MCP `instructions` during the SSE handshake so LLM clients see constraints upfront.
- **MCP `find_entities_by_name` tool**: Exact name lookup returning all matching entities regardless of type.
- **Find-similar endpoint**: `POST /api/brain/spaces/:spaceId/find-similar` and MCP `find_similar` tool — vector similarity search by existing entry ID. Uses the entry's stored embedding directly (no re-embedding). Supports cross-space search, target-type filtering (`memory`, `entity`, `edge`, `chrono`, `file`), score thresholds, and configurable `topK` (1–100).
- **Audit log**: Append-only, immutable access log stored in `audit_log` MongoDB collection. Tracks all write operations, auth failures, and optionally read operations (`audit.logReads` config). Fields: token identity, OIDC subject, operation, space, HTTP status, IP, duration. TTL-based auto-purge (default 90 days). Admin-only query API with filtering and pagination at `GET /api/admin/audit-log`. Web UI in **Settings → Audit Log** with search, detail views, and JSON/CSV export.
- **Webhook event subscriptions**: Subscribe external systems to real-time HTTP POST notifications on write events. 15 event types across memories, entities, edges, chrono, and files plus `test.ping`. Payloads signed with HMAC-SHA256, at-least-once delivery with 6 retries (10s → 30s → 1m → 5m → 30m → 1h). SSRF-protected URL validation. Admin CRUD API at `/api/admin/webhooks` with delivery history. Requires admin token + MFA.
- **Space export API**: `GET /api/admin/spaces/:spaceId/export` dumps all knowledge (memories, entities, edges, chrono, file metadata) as a single JSON document with embedding vectors stripped. Binary file content is not included.
- **Space import API**: `POST /api/admin/spaces/:spaceId/import` upserts exported data back into a space. Each document is matched by `_id` — existing docs are replaced, new docs are inserted. Run reindex afterward to rebuild embeddings.
- **Bulk write API**: `POST /api/brain/spaces/:spaceId/bulk` and MCP `bulk_write` tool for batch-upserting up to 500 memories, entities, edges, and chrono entries per call. Processing order: memories → entities → edges → chrono (edges can reference entities created in the same batch).
- **Graph traversal API**: `POST /api/brain/spaces/:spaceId/traverse` and MCP `traverse` tool — multi-hop BFS from a starting entity with direction control (`outgoing`, `incoming`, `both`), edge-label filtering, configurable `maxDepth` (hard cap 10), cycle detection, and result limiting.
- **Query REST endpoint**: `POST /api/brain/spaces/:spaceId/query` — structured MongoDB filter queries on any collection (`memories`, `entities`, `edges`, `chrono`, `files`) with projection, limit, and timeout control. Previously MCP-only (`query` tool), now accessible via REST.
- **Query panel in Brain UI**: Interactive query builder in the web interface for running structured queries against any collection.
- **Chrono advanced filters**: `list_chrono` tool and `GET /chrono` now support date-range (`after`/`before`), AND/OR tag filtering (`tags`/`tagsAny`), full-text `search`, and `kind`/`status` filters.
- **Space wipe API**: `POST /api/admin/spaces/:spaceId/wipe` with per-type granularity — wipe only memories, or only entities+edges, etc. Tombstones are cleaned for wiped types. Also available as MCP `wipe_space` tool.
- **MCP `update_space` tool**: Update space label and/or description from MCP (admin tokens only).
- **ID-only update paths**: `update_entity`, `update_edge`, `update_memory`, and `update_chrono` now accept updates by ID without requiring all fields — partial patches work correctly.
- **Entity upsert duplicate warning**: When inserting an entity without an `id` and entities with the same `name`+`type` already exist, the response includes a `warning` field explaining how many duplicates exist and advising to pass `id` for updates. Surfaced in both REST and MCP responses.

### Fixed

- **Entity identity model**: Name+type is no longer a unique constraint. Multiple entities with the same name and type are valid — `id` (UUID v4) is the sole unique key. The `(spaceId, name, type)` index now exists as a non-unique performance index.
- **Index migration**: On startup, if the legacy unique index `spaceId_1_name_1_type_1` exists, it is dropped and recreated as non-unique. The migration check runs once via `listIndexes()` and is a no-op after the first run.
- **`$options` injection hardening**: The `$options` MongoDB operator is now validated: must appear alongside `$regex` (bare `$options` rejected), value must be a string containing only valid regex flags (`i`, `m`, `s`, `x`). Invalid flags or non-string values return 400.
- **ReDoS protection**: User-supplied regex patterns in schema `namingPatterns` and `propertySchemas` are structurally analysed for nested quantifiers (`(a+)+`) and alternation-with-quantifier (`(a|b)+`) patterns. Dangerous patterns are rejected before execution. Pattern length is capped at 500 characters, test values at 10K characters.
- **PATCH endpoints dropping fields**: All PATCH/update endpoints for entities, edges, memories, and chrono now correctly preserve unmentioned fields instead of silently clearing them.
- **Schema validation double-call in MCP**: The MCP router previously validated once for strict and again for warn mode. Fixed to validate once and reuse the result.
- **Audit log TTL index**: Timestamp field is stored as an ISO string for API compatibility; a dedicated `_expireAt` BSON Date field powers the TTL index so entries are actually purged by MongoDB's TTL daemon.
- **Audit log auth failure coverage**: `logAuthFailure` is now called in `requireAdmin` and `requireAdminMfa` middlewares (not just `requireAuth` and `requireSpaceAuth`), ensuring all failed authentication attempts are logged.
- **Webhook SSRF protection**: Webhook URLs are validated against private/reserved IP ranges using `isSsrfSafeUrl()`, matching the protection already applied to invite and network endpoints.
- **Webhook MFA enforcement**: Webhook admin routes now use `requireAdminMfa` instead of `requireAdmin`, consistent with all other admin endpoints (export, import, wipe, config reload).

### Changed

- **README**: Rewritten with structured feature sections (semantic recall, knowledge graph, chrono timeline, file storage, schema validation, bulk operations, proxy spaces, export/import, find-similar, audit log, webhooks, 30 MCP tools, multi-brain sync, security) for better discoverability.
- Documentation: `integration-guide.md` updated — schema validation section, space meta endpoint, validate-schema endpoint, export/import endpoints, find-similar endpoint, audit log API section, entity identity model clarification, $options validation, bulk write schema validation note. `userguide.md` updated — schema configuration, export/import, query panel, audit log and webhook settings pages, find_similar in MCP tools table. `contribution-guide.md` updated — test suite descriptions reflect current coverage.

## [0.8.0] — 2026-04-04

### Added

- **Brain UI — space stats bar**: five stat pills (Memories, Entities, Edges, Chrono, Files) at the top of the Brain page pull from `GET /api/brain/spaces/:id/stats` and refresh on every load.
- **Brain UI — needs-reindex banner**: when the space returns `needsReindex: true`, a banner prompts the user to reindex. Clicking "Reindex now" calls `POST /api/brain/spaces/:id/reindex` and shows a confirmation on completion.
- **Brain UI — memory `description` + `properties` fields**: free-text description textarea and key/value properties builder added to the create-memory form. Values are displayed inline on each memory card.
- **Brain UI — entity `description` field**: optional description field added to the create-entity form; displayed in the entity table's Description column.
- **Brain UI — entity search + pagination**: search-by-name bar dispatches `GET /api/brain/spaces/:id/entities?search=…` and entity list pages 20 at a time with Prev / Next controls.
- **Brain UI — edge `tags`, `description`, `properties` fields**: tags (comma-separated), description, and properties added to the create-edge form; Tags column added to the edge table; description shown as a subtitle row.
- **Brain UI — edge pagination**: edge list pages 20 at a time with Prev / Next controls.
- **Brain UI — chrono filter bar + pagination**: tag and status filter dropdowns filter `GET /api/brain/spaces/:id/chrono`; chrono list pages 20 at a time with Prev / Next controls.
- **Brain UI — inline delete confirmations**: per-row inline confirm/cancel buttons replace browser `confirm()` dialogs for deleting memories, entities, edges, and chrono entries. A single `confirmDeleteId` signal tracks the active confirmation.
- **Files UI — drag-and-drop upload**: the file listing area accepts drag-and-drop; `dragover`/`dragleave`/`drop` host listeners toggle a `.drag-over` CSS class and route dropped files through the shared `uploadFiles()` method.
- **Files UI — preview button**: a 👁 Preview button in the Actions column opens a file in the preview panel (before the existing Download button).
- **Server: `properties` field on chrono entries**: chrono create (`POST /spaces/:spaceId/chrono`) and update (`POST /spaces/:spaceId/chrono/:id`) REST routes now accept, validate, and persist an optional `properties: Record<string, string | number | boolean>` body field.
- **Server: `properties` field on file metadata via REST upload**: the file write route (`PUT /api/files/spaces/:spaceId/*`) now accepts and persists an optional `properties` body field alongside the existing `description` and `tags`.

### Fixed

- **Chrono REST routes missing `properties` pass-through**: the `POST /spaces/:spaceId/chrono` and `POST /spaces/:spaceId/chrono/:id` routes did not destructure `properties` from `req.body` and did not forward it to `createChrono()` / `updateChrono()`. Values were silently dropped.
- **File upload REST route missing `properties` pass-through**: `metaOpts` type only declared `description` and `tags`; `properties` was never extracted from `req.body` or forwarded to `upsertFileMeta()`.

### Changed

- `docs/userguide.md`: updated Brain and Files sections to document all new UI fields, controls, and interactions added in this release.
- Brain integration tests: new tests for memory `description`/`properties`, entity `description`, edge `tags`/`description`/`properties` with union-merge and validation, chrono `properties`, and file metadata `properties`. All 385 integration tests pass (0 failures).
- Red-team tests: all 175 pass (0 failures). Sync tests: 158 pass, 1 skip. Standalone tests: 194 pass, 4 skip (Windows permission-bit checks not applicable).

## [0.7.1] — 2026-04-04

### Added

- **MCP `recall`/`recall_global` `types` filter**: integration tests covering `types=['memory']`, `types=['entity']`, `types=['memory','entity','edge']`, unknown type strings (graceful no-op), and `recall_global` with type filter. All skip gracefully when the embedding server is not configured.
- **Brain memory dual-prefix**: `GET`, `DELETE` and bulk-wipe memory routes are now accessible under both `/:spaceId/` (original) and `/spaces/:spaceId/` (preferred, consistent with entities/edges/chrono). Both forms are fully equivalent. Documentation updated in `integration-guide.md`.

### Fixed

- **`GET /api/about/logs` auth escalation** (MEDIUM): endpoint previously required only `requireAuth` (any valid token), allowing non-admin tokens to read log lines that may contain space IDs, peer URLs, and internal paths. Now requires `requireAdmin`.
- **`POST /api/admin/reload-config` insufficient auth** (MEDIUM): endpoint previously required only `requireAuth`. Reloading config can add/remove spaces and triggers token migration — privileged operations. Now requires `requireAdminMfa` (admin token + TOTP when MFA is enabled), consistent with other admin-destructive endpoints.
- **Space description limit**: raised from 2 000 to 4 000 characters (`PATCH /api/spaces/:id` Zod schema). MCP clients using the description as system instructions need the additional headroom for the default auto-generated tool listing.
- **`uploadFile()` removed from `ApiService`**: the legacy single-request upload method was an unused dead stub — all uploads go through the chunked path. Removed to prevent accidental use that bypassed chunking for large files.

### Changed

- Documentation: `integration-guide.md` updated — reload-config MFA note, about/logs admin requirement, space description limit (2000 → 4000), brain memory dual-prefix section.

## [0.7.0] — 2026-03-30

### Added

- **Space rename**: `PATCH /api/spaces/:id/rename` atomically renames a space — moves MongoDB collections, file directories, updates network `spaces[]` arrays and token scopes. Inline rename UI (pencil icon) in Settings → Spaces. The built-in `general` space cannot be renamed.
- **Space ID remapping (`spaceMap`)**: `NetworkConfig.spaceMap` (`Record<string, string>`) maps remote space IDs to local space IDs. The sync engine translates between remote and local IDs transparently during pull and push via `remoteToLocal()` / `localToRemote()` helpers. Watermark keys use remote IDs; local storage uses local IDs.
- **Join collision resolution UI**: When joining a network whose spaces collide with existing local spaces, a per-space dropdown lets the user choose **Merge** (sync into the existing space) or **Alias** (create a new local name). Alias names flow into the `spaceMap` on the network config.
- **Reload-config token migration**: `POST /api/admin/reload-config` now evicts tokens that lack a `prefix` field (legacy format) and persists the cleaned config. Prevents stale tokens from surviving a reload.
- **Process crash handlers**: `process.on('unhandledRejection')` and `process.on('uncaughtException')` in the server entry point. Unhandled rejections are logged but do not exit; uncaught exceptions log and exit with code 1.
- Tests: `space-rename.test.js` (integration, 9 tests).

### Fixed

- **Auth test concurrent safety**: Replaced `docker restart` in `auth.test.js` with atomic config file write + `POST /api/admin/reload-config` + retry loop. Eliminates container restarts that caused socket errors when tests run concurrently.

### Changed

- Documentation updated: `userguide.md` (space rename, join collision resolution), `integration-guide.md` (rename endpoint, `spaceMap` on join-remote, reload-config migration), `sync-protocol.md` (space ID remapping section).

## [0.6.0] — 2026-03-29

### Added

- **Pub/Sub network type**: Single publisher distributes knowledge to any number of subscribers. Auto-accept joins (no voting), reusable invite key, push-only data flow (publisher → subscribers). Publisher can remove subscribers unilaterally. Subscriber-local data is protected by UUIDv4 identity and author guard on tombstones.
- **Sync direction enforcement**: `SyncDirection = 'both' | 'push' | 'pull'` on member records. Seven inbound sync POST endpoints (`/memories`, `/entities`, `/edges`, `/chrono`, `/batch-upsert`, `/tombstones`, `/file-tombstones`) now reject writes from peers whose `direction === 'push'` with `403`. Server-side complement to the engine's client-side skip logic.
- **MCP `remember` input size limit**: `fact` field capped at 50 000 characters in the MCP handler, matching the existing REST API constraint. Prevents oversized facts from bypassing quota semantics.
- Tests: `pubsub-topology.test.js` (sync), `direction-enforcement.test.js` (red-team), `mcp-security.test.js` (red-team) — 6 MCP SSE session tests covering recall_global scope isolation, oversized input rejection, operator injection blocklist, and depth-limited filters.

### Fixed

- **`requireSpaceAuth` scope bypass** (MEDIUM): Scoped tokens accessing non-existent spaces received `404` instead of `403` because `resolveMemberSpaces()` returned `[]` for unknown spaces, causing the scope check to silently pass. Now falls back to `[spaceId]` so the check correctly rejects.
- **`reloadConfig()` missing `initSpace()`** (MEDIUM): Adding a new space to `config.json` and calling `POST /api/admin/reload-config` left the space without MongoDB collections, indexes, vector search index, or file directories until the next container restart. The endpoint now calls `ensureGeneralSpace()` and `initSpace()` for any newly added non-proxy spaces.
- **`syncCyclesTotal` metric invisible at startup**: prom-client labeled counters don't emit HELP/TYPE lines until the first `.inc()` call. Pre-initialized with `.inc(0)` so the metric is discoverable by monitoring dashboards from startup.

### Changed

- Documentation updated: `sync-protocol.md` (direction enforcement section), `integration-guide.md` (pubsub type, reload-config behaviour, add-member pubsub notes, sync 403), `userguide.md` (pubsub rows in governance/removal tables), `contribution-guide.md` (test coverage descriptions).

## [0.5.1] — 2026-03-28

### Added

- **External theming API**: Static CSS override via `theme.cssUrl` in config + runtime `postMessage` with `{ type: 'ythril:theme', tokens }` for portal embedding. Server endpoint `GET /api/theme` (public, no auth).
- **ThemeService** (Angular): `APP_INITIALIZER`-based loader with 3 s timeout; postMessage listener restricted to `--`-prefixed CSS custom properties only.
- **OIDC silent refresh**: Hidden-iframe token renewal with PKCE. Decodes JWT `exp` claim, schedules refresh 60 s before expiry, falls back to 401 interceptor on failure.
- **Space deletion purge**: `DELETE /api/spaces/:id` now drops all `{spaceId}_*` MongoDB collections, vector search indexes, `/data/files/{spaceId}/`, and `/data/.chunks/{spaceId}/`. Cleanup errors abort deletion (space stays in config for retry).
- **Space deletion governance**: Networked spaces open a `space_deletion` vote round on every containing network instead of deleting immediately.
- Tests: `space-deletion.test.js` (integration), `theme.test.js`, `config-loader.test.js`, `config-permissions.test.js`, `oidc-silent-refresh.test.js`, `theme-postmessage.test.js` (standalone).
- **SSO auto-redirect**: Login page auto-redirects to OIDC provider when SSO is enabled. `?local` query param bypasses for local login. OIDC callback links to `/login?local` on error.
- **Use case examples**: `docs/usecase-examples.md` — 26 practical deployment scenarios covering all network types, proxy spaces, multi-space/multi-network topologies, and MCP tool workflows.
- **Features TODO**: Public knowledge spaces — open pub/sub networks for frictionless distribution.

### Fixed

- **Theme postMessage origin check** (MEDIUM): `handleThemeMessage()` now validates `event.origin === self` — rejects cross-origin theming messages that could restyle the UI for phishing.
- **`$regex` injection in `removeSpace()`** (LOW): Replaced `$regex` interpolation with `listCollections()` + `.startsWith()` filter.
- **`cssUrl` injection** (LOW): `injectExternalStylesheet()` now validates URLs via `URL` constructor; rejects non-HTTPS (except localhost for dev).
- **`removeSpace` partial-failure orphaned data**: Cleanup errors now throw — space remains in config so the operator can investigate and retry, instead of silently losing the config entry.
- **Theme endpoint disk thrash**: `GET /api/theme` now uses in-memory `getConfig()` with `loadConfig()` fallback instead of reading config.json from disk on every request.
- **`X-Frame-Options: DENY` vs iframe theming**: Replaced with `Content-Security-Policy: frame-ancestors 'self'` to allow same-origin iframing (OIDC silent refresh, theming) while blocking cross-origin clickjacking.
- **Startup crash on missing arrays**: `loadConfig()` and `reloadConfig()` now normalise absent/null `spaces`, `tokens`, `networks` arrays via `??= []`.
- **Config file permission auto-fix**: `checkPermissions()` auto-fixes loose permissions when the process owns the file (K8s hostPath mounts), with warning log instead of hard exit.
- **Path traversal false-positive**: Leading slashes in browser-sourced filenames (`/Screenshot 2024.png`) are now stripped before `path.resolve()`, preventing spurious traversal rejections.
- **OIDC silent refresh**: Fixed PKCE verifier isolation (closure, not sessionStorage which is iframe-isolated); added 30 s iframe timeout; state validation on postMessage.
- **Theme init timeout**: `APP_INITIALIZER` no longer blocks app bootstrap indefinitely — resolves after 3 s if `/api/theme` is unresponsive.

## [0.5.0] — 2026-03-27

### Added

- **OpenID Connect (OIDC) authentication**: Authorization Code + PKCE flow via `jose` v6. Supports Keycloak, Entra ID, Okta, Auth0 and any OIDC-compliant IdP. Claim-based mapping for admin, readOnly, and spaces. Discovery document caching with 5-min TTL.
- **OIDC callback route guard**: `/oidc-callback` requires `code`+`state` or `error` query params; otherwise redirects to `/login`.
- **OIDC config validation**: `validateOidcBlock()` validates issuerUrl and clientId at config load/reload time.
- **Notify identity verification**: `POST /api/notify` now verifies that the caller's token is authorised for the claimed `instanceId` via `peerInstanceId` on TokenRecord.

### Fixed

- **Bearer token leak to cross-origin** (CRITICAL): Auth interceptor no longer sends bearer tokens to cross-origin requests (e.g. IdP endpoints). Scoped to same-origin only.
- **SSRF-hardened OIDC discovery**: Discovery document fetch validates URLs against IMDS, loopback, non-HTTP schemes, and embedded credentials. Issuer-match and `jwks_uri` validation per OIDC Discovery §4.3.
- **Notify instanceId spoofing**: Non-admin tokens without a matching `peerInstanceId` can no longer forge events as arbitrary remote peers.
- Removed stale `clientSecret` field from OIDC types and documentation.
- Fixed pre-existing missing `});` in `/ready` handler (app.ts).
- Cleaned redundant hash-stripping in auth middleware.

### Changed

- TokenRecord now carries optional `peerInstanceId` field, set automatically during invite handshake.

## [0.4.0] — 2026-03-26

### Changed

- License changed from AGPL-3.0 to PolyForm Small Business License 1.0.0.

## [0.3.0] — 2026-03-26

### Added

- **Readiness probe**: `GET /ready` endpoint with MongoDB and vectorSearch dependency checks.
- **Prometheus metrics**: `GET /metrics` endpoint exposing HTTP request counters, response time histograms, and active connection gauges.
- **Flexible MongoDB backend**: Support any `$vectorSearch`-capable MongoDB (Atlas, Atlas Local, MongoDB 8.2+).
- **MCP tools**: `update_memory`, `delete_memory`, `get_stats`.

## [0.2.0] — 2026-03-26

### Added

- **Entity properties**: Entities now support an optional `properties` field — a flat key-value map where each value can be a string, number, or boolean. Upserts shallow-merge properties (new keys added, existing keys overwritten). Supported across the REST API, MCP `upsert_entity` tool, sync protocol, and client UI.
- Six new integration tests covering entity property CRUD, merge behaviour, validation, and listing.

## [0.1.1] — 2026-03-26

Audit hardening and polish.

### Fixed

- Pinned `@modelcontextprotocol/sdk` to `^1.28.0` (was `"latest"`).
- Changed `catch (err: any)` to `catch (err: unknown)` in conflicts API.
- Added error handlers to 16 client `subscribe()` calls that were missing them.
- Tightened all loose dependency version ranges (`bcrypt`, `express`, `mongodb`, `multer`, `uuid`, `zod`, etc.).

### Added

- Docker healthcheck on `/health` endpoint in `docker-compose.yml`.
- Missing fields in `config.example.json`: `embedding.baseUrl`, `storage.files`, `storage.brain`, `ejectedFromNetworks`.
- Security headers and CORS behaviour documented in integration guide.
- Four undocumented API endpoints documented: Remove Member, Reparent Self, Adopt Member, Revert Parent.
- TLS termination examples (Nginx, Caddy, Traefik), resource requirements, and upgrade/backup guide.
- `aria-label` attributes on all icon-only buttons and unlabelled form controls across the client.
- `minlength="8"` on the confirm-password field in the setup wizard.
- `CHANGELOG.md`.

## [0.1.0] — 2025-06-24

Initial public release.

### Added

#### Core
- Space-isolated knowledge management: memories, entities, edges, tombstones.
- Semantic search via OpenAI-compatible embedding endpoint (`/v1/embeddings`).
- Proxy spaces — virtual read-aggregation across multiple real spaces.
- File manager with chunked upload, directory tree, inline preview (text, image, PDF).
- Per-space MCP endpoint (`/mcp/{spaceId}`) with full tool set for LLM clients.
- Storage quota enforcement (soft/hard limits for files and brain data).

#### Authentication & Security
- PAT token auth (`ythril_*`) with bcrypt-hashed storage, space-scoped allowlists.
- Optional MFA (TOTP) for admin mutations.
- RSA-4096-OAEP zero-knowledge invite handshake.
- Zod validation on all inputs; MongoDB operator whitelist (blocks `$where`, `$function`).
- Path sandboxing against traversal, null bytes, and encoded characters.
- SSRF guard blocking RFC-1918, loopback, IMDS, IPv6 ULA, link-local, and embedded credentials.
- Security headers: `X-Content-Type-Options`, `X-Frame-Options`, `Referrer-Policy`, `X-Request-Id`.
- Config and secrets files enforced at mode `0600`.
- Global rate-limiting middleware (configurable per-endpoint).

#### Brain Networks & Sync
- Network types: Closed, Democratic, Club, Braintree (hierarchical push-only).
- Watermark-based incremental sync: pull → push → file manifest (SHA-256) → gossip.
- Voting system for membership changes (unanimous, majority, supermajority, ancestor-path).
- Conflict detection and resolution (keep-local, keep-incoming, keep-both, save-to-space).
- Configurable sync schedules (cron) with manual trigger.
- Sync history tracking with per-run stats and error reporting.

#### Client (Angular 21)
- Web UI: brain explorer, file manager, space manager, token manager, network manager.
- Conflict resolution page with bulk actions.
- MFA enrollment flow with QR code display.
- Accessible forms with aria-labels and HTML5 validation.

#### Infrastructure
- Single `docker-compose.yml` deployment with MongoDB Atlas Local.
- Docker healthcheck on `/health` endpoint.
- Hot-reloadable configuration with permissions enforcement.
- First-run setup wizard (admin password, instance label, embedding config).

#### Documentation
- User guide, integration guide (full REST & MCP API reference), contribution guide.
- Network types specification, sync protocol specification, dependency inventory.
