# Changelog

All notable changes to Ythril are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
