# TODO — Ythril

## Security

- [x] **MEDIUM — Theme postMessage accepts any origin.** `handleThemeMessage()` in `client/src/app/core/theme.service.ts` has no `event.origin` check. Any cross-origin page can send `{ type: 'ythril:theme', tokens: { ... } }` to restyle the UI for phishing. Add origin validation — accept only `self` or a configured allowed-origin list. **FIXED: added `event.origin !== selfOrigin` guard.**
- [x] **LOW — `$regex` interpolation of `spaceId` in `removeSpace()`.** `server/src/spaces/spaces.ts` line 249: `db.listCollections({ name: { $regex: \`^\${prefix}\` } })`. Safe today because space IDs are `[a-z0-9-]+`, but fragile. Escape the prefix or use `startsWith` iteration. **FIXED: replaced $regex with listCollections() + .startsWith() filter.**
- [x] **LOW — `cssUrl` from config injected into `<link href>` with no URL validation.** `client/src/app/core/theme.service.ts` line 47. Only server admins can set it, but a compromised config could load arbitrary external CSS. Add `URL` constructor validation + `https:`-only enforcement. **FIXED: added URL constructor validation + https-only (http allowed on localhost for dev).**
- [x] **INFO — `X-Frame-Options: DENY` conflicts with iframe theming.** `server/src/app.ts` line 55 sets `DENY`, which prevents the postMessage theming path from working inside iframes. If Ythril is intended to be embeddable, switch to `Content-Security-Policy: frame-ancestors 'self'` (or a configurable origin list). **FIXED: replaced X-Frame-Options: DENY with CSP frame-ancestors 'self'. Updated setup.test.js.**

## Code Quality

- [x] **`removeSpace` partial-failure leaves orphaned data.** Individual collection drops and file deletions in `server/src/spaces/spaces.ts` are wrapped in try/catch with `log.warn`, so a partially-failed deletion silently continues. If a collection drop fails, the space is still removed from config, leaving orphaned data. Consider a pre-check or rollback strategy. **FIXED: cleanup errors now throw — space stays in config for retry. API returns 500 with error details.**
- [x] **`loadConfig()` called on every request in theme endpoint.** `server/src/api/theme.ts` line 17 calls `loadConfig()` (synchronous disk read) on every `GET /api/theme`. Should use `getConfig()` when config is already loaded, falling back to `loadConfig()` only during setup. **FIXED: uses getConfig() with loadConfig() fallback.**

## UI/UX

- [x] **No timeout on theme init HTTP call.** `APP_INITIALIZER` in `client/src/app/app.config.ts` blocks app bootstrap until `/api/theme` responds. If the endpoint is slow, users see a blank page. The error catch resolves, but no timeout is set. Add a 3–5 s timeout. **FIXED: added 3 s setTimeout fallback in ThemeService.init().**

## Test Coverage

- [x] **Test: space deletion — DB/file cleanup.** Verify that `DELETE /api/spaces/:id` actually drops all `{spaceId}_*` MongoDB collections, removes `/data/files/{spaceId}/`, and removes `/data/.chunks/{spaceId}/`. **ADDED: `testing/integration/space-deletion.test.js`**
- [x] **Test: space deletion — networked (voted) path.** Verify that deleting a networked space opens vote rounds on all containing networks. **ADDED: `testing/integration/space-deletion.test.js`**
- [x] **Test: config loader — missing arrays.** Verify that `loadConfig()` handles `{}`, `{ "spaces": null }`, etc. without crashing (the `??= []` normalisation). **ADDED: `testing/standalone/config-loader.test.js`**
- [x] **Test: config loader — mode auto-fix.** Verify the owner-match chmod path in `checkPermissions()`. **ADDED: `testing/standalone/config-permissions.test.js` (skips on Windows, runs in Docker).**
- [x] **Test: OIDC silent refresh.** Integration test for the iframe-based silent token renewal cycle. **ADDED: `testing/standalone/oidc-silent-refresh.test.js` (server-side contracts: /oidc-callback serves SPA, /api/auth/oidc-info shape, CSP frame-ancestors).**
- [x] **Test: theme API endpoint.** `GET /api/theme` returns `{ cssUrl: null }` by default and `{ cssUrl: "..." }` when configured. **ADDED: `testing/standalone/theme.test.js`**
- [x] **Test: theme postMessage runtime tokens.** Verify that only `--`-prefixed properties are applied and standard CSS properties are rejected. **ADDED: `testing/standalone/theme-postmessage.test.js` (9 tests, passes locally).**

## Documentation

- [x] **CHANGELOG.md is stale.** Needs an entry covering: external theming API, space deletion purge, startup crash fix, file permission auto-fix, OIDC silent refresh, path traversal false-positive fix. **DONE: added [0.5.1] — 2026-03-28 entry.**
- [x] **integration-guide.md: security headers table wrong.** Listed `X-Frame-Options: DENY` — now uses `Content-Security-Policy: frame-ancestors 'self'`. **FIXED.**
- [x] **integration-guide.md + userguide.md: SSO login flow outdated.** Described manual "Sign in with SSO" button click. Now auto-redirects; `?local` bypasses. **FIXED both files.**
- [x] **All docs: Theme API undocumented.** `GET /api/theme`, `cssUrl` config, `postMessage` runtime tokens — zero docs. **FIXED: added Theme API section to integration-guide.md.**
- [x] **All docs: `/login?local` escape hatch undocumented.** **FIXED: documented in both userguide.md and integration-guide.md.**
- [x] **All docs: Config file permission auto-fix undocumented.** `checkPermissions()` auto-fixes to `0600`. **FIXED: added Config File Permissions section to integration-guide.md.**
- [x] **userguide.md: MCP tools table incomplete.** 14 of 20 tools listed. Missing: `update_memory`, `delete_memory`, `get_stats`, `create_chrono`, `update_chrono`, `list_chrono`. **FIXED: all 20 now listed.**
- [x] **userguide.md: read-only tools list incomplete.** Missing `get_stats` and `list_chrono`. **FIXED.**
- [x] **integration-guide.md: space deletion missing 500 response.** Only documented 204. **FIXED: added partial-failure 500 path.**
- [x] **contribution-guide.md: standalone test description stale.** Listed 5 test areas, actual: 14 files. **FIXED: listed all test areas.**
- [x] **sync-protocol.md: chrono missing from API reference table.** Documented in pull phase text but omitted from the endpoint table. **FIXED: added `GET /api/sync/chrono` and `GET /api/sync/chrono/:id`; updated batch-upsert body.**
- [x] **integration-guide.md: OIDC silent refresh missing CSP mention.** Didn't explain that `frame-ancestors 'self'` is needed for the iframe mechanism. **FIXED.**
- [x] **dependencies.md: MongoDB 8.2+ CE not mentioned.** Integration guide documents it but dependencies doc didn't. **FIXED: added MongoDB 8.2+ section with licensing analysis.**
