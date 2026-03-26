# Changelog

All notable changes to Ythril are documented in this file.
The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

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
