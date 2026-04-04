# Changelog

All notable changes to Ythril are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
