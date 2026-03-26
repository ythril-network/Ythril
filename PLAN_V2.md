# Ythril — V2 Roadmap

**Status:** In Progress  
**Created:** 2026-03-25

Items identified during the PLAN.md ↔ implementation audit. Each section is a self-contained work item with acceptance criteria.

---

## V2-1 · Chunked Upload (Content-Range)  ✅ DONE

**Current state:** `POST /api/files/:spaceId` accepts a single-request upload only. `maxUploadBodyBytes` (default 5 GiB) caps the entire request.

**Required:**

Server (`server/src/api/files.ts`):
- Accept `Content-Range` header on `POST /api/files/:spaceId?path=<path>`. Format: `bytes <start>-<end>/<total>`.
- Accumulate chunks under a temporary path (`/data/.chunks/<spaceId>/<upload-id>/`). Generate a stable `upload-id` from `(spaceId, path, total)` so the same logical upload always writes to the same temp location.
- On receipt of the final chunk (end === total - 1), assemble the temp parts into the target file atomically (rename), clean up temp dir.
- Resume: if the client re-sends a range that was already written (byte offset ≤ last acknowledged), skip the duplicate bytes and acknowledge normally. No error.
- New endpoint `GET /api/files/:spaceId/upload-status?path=<path>&total=<n>` — returns `{ received: <bytes> }` so the client can resume from the right offset.
- Stale temp cleanup: on startup + periodic (every hour), delete temp chunk dirs older than 24 h.
- `maxUploadBodyBytes` applies per-chunk, not per-file.

Client (`client/src/app/pages/files/file-manager.component.ts`):
- Files > 10 MB are automatically chunked (chunk size: 5 MB).
- Upload progress bar showing % complete.
- On failure, retry from last acknowledged offset (max 3 retries per chunk).

**Acceptance:** Upload a 50 MB file in 5 MB chunks. Kill the server mid-upload, restart, resume from last offset. File matches sha256 of original.

---

## V2-2 · Conflict Resolution Actions  ✅ DONE

**Current state:** ~~`POST /api/conflicts/:id/resolve` exists but only deletes the conflict record. The `action` body parameter is ignored. No file operations are performed.~~ Fully implemented.

**Completed:**

Server (`server/src/api/conflicts.ts`):
- Accepts body: `{ action: "keep-local" | "keep-incoming" | "keep-both" | "save-to-space", rename?: string, targetSpaceId?: string }`
- All 4 actions implemented with file operations + conflict record cleanup.
- Bulk resolve: `POST /api/conflicts/bulk-resolve` returns `{ resolved, failed }`.
- Test seeding endpoint: `POST /api/conflicts/seed`.

Client (`client/src/app/pages/files/conflicts.component.ts`):
- Per-conflict action dropdown, checkbox selection, bulk action bar, save-to-space space picker, dismiss button.

Tests: 15 new tests in `testing/integration/conflict-resolution.test.js`. 10/10 existing `conflicts.test.js` tests updated and passing.

Docs: Conflict resolution section added to `docs/userguide.md` (API + UI workflow).

---

## V2-3 · Bulk Memory Wipe  ✅ DONE

**Current state:** Only `DELETE /api/brain/:spaceId/memories/:id` exists (single delete). No bulk wipe endpoint.

**Required:**

Server (`server/src/api/brain.ts`):
- `DELETE /api/brain/:spaceId/memories` with body `{ confirm: true }` — deletes ALL memories in the space.
- Write a tombstone for each deleted memory (required for sync propagation).
- Same for the long-form route: `DELETE /api/brain/spaces/:spaceId/memories` with `{ confirm: true }`.
- Proxy spaces: reject with 400 ("bulk wipe not supported on proxy spaces — target member spaces individually").
- Return `{ deleted: number }`.

Client (`client/src/app/pages/brain/brain.component.ts`):
- "Wipe all memories" button (danger-styled) on the memories tab.
- Confirmation modal: "This will permanently delete all N memories in space X. This action cannot be undone. Type the space name to confirm."
- Double confirmation: type-to-confirm pattern (user must type the space ID).

**Acceptance:** Wipe all memories in a space with 10+ memories. Verify they are tombstoned and deleted. Verify sync propagates the tombstones.

---

## V2-4 · Memory List Filtering

**Current state:** `GET /api/brain/:spaceId/memories` supports `limit` and `skip` but no filtering by tag or entity.

**Required:**

Server (`server/src/api/brain.ts` + `server/src/brain/memory.ts`):
- Accept optional query params: `tag=<string>` and `entity=<string>` (entity name or ID).
- `tag`: filter memories where `tags` array contains the given value (case-insensitive).
- `entity`: filter memories where `entities` array contains the given value, OR where linked entity's `name` matches (case-insensitive).
- Both filters can be combined (AND).
- Pass filter object to `listMemories()` instead of `{}`.
- Ensure MongoDB indexes support the query efficiently: index on `tags` and `entities` arrays.

Client (`client/src/app/pages/brain/brain.component.ts`):
- Tag filter: clickable tag pills on memory rows that filter the list when clicked.
- Entity filter: clickable entity badges on memory rows.
- Filter bar above the memory table showing active filters as removable chips.
- "Clear filters" button.

**Acceptance:** Create 5 memories with different tags. Filter by tag → only matching memories shown. Filter by entity → only linked memories shown. Combine both → intersection.

**Status: DONE** — `buildMemoryFilter()` in brain.ts, `listMemories()` sorted by createdAt desc, client filter bar with clickable tag/entity chips. 6 integration tests in brain.test.js.

---

## V2-5 · Settings UI — About Section  ✅ DONE

**Current state:** Settings has tabs for Tokens, Spaces, Storage, Networks, MFA. No "About" tab.

**Required:**

Server:
- `GET /api/about` — returns `{ instanceId, instanceLabel, version, uptime, mongoVersion, diskInfo: { total, used, available } }`.
- `version`: read from `package.json` at startup.
- `uptime`: `process.uptime()` formatted as human-readable (e.g. "3d 14h 22m").
- `mongoVersion`: `db.admin().serverInfo().version` on startup (cached).
- `diskInfo`: disk usage of the data root partition.

Client (`client/src/app/pages/settings/about.component.ts` — new):
- Standalone Angular component registered as a tab in `settings.component.ts`.
- Display: instance label, instance ID (monospace), version, uptime, MongoDB version.
- Disk usage bar (used / total with percentage).
- Log viewer: last 200 lines of server log, auto-scroll, monospace font. Endpoint: `GET /api/about/logs?lines=200`.

**Acceptance:** About tab renders all fields. Log viewer shows recent log lines. Disk usage is accurate.

---

## V2-6 · Sync History Log  ✅ DONE

**Current state:** Sync result shows as a 4-second transient toast in the Networks UI. No persisted history.

**Required:**

Server (`server/src/sync/engine.ts` + new `server/src/sync/history.ts`):
- After each sync cycle (success or failure), persist a summary record to MongoDB collection `_sync_history`.
- Record: `{ _id, networkId, triggeredAt, completedAt, status: "success" | "partial" | "failed", pulled: { memories, entities, edges, files }, pushed: { memories, entities, edges, files }, errors?: string[] }`.
- Retain last 100 records per network. Prune on insert.
- `GET /api/sync/history?networkId=<id>&limit=<n>` — paginated list, most recent first.

Client (`client/src/app/pages/settings/networks.component.ts`):
- Per-network expandable section: "Sync History" showing the last 20 sync results.
- Each entry: timestamp, status badge (green/yellow/red), pulled/pushed counts, expandable error details.
- Auto-refresh when a sync completes.

**Acceptance:** Run 5 syncs (mix of success and partial). History shows all 5 with correct counts. List is pruned at 100.

---

## V2-7 · Edge `type` Field  ✅ DONE

**Current state:** ~~Edges have `from`, `to`, `label`, optional `weight`. No `type` field.~~ Implemented.

**Completed:**

Server:
- `type?: string` added to `EdgeDoc` in `server/src/config/types.ts`.
- `upsertEdge()` in `server/src/brain/edges.ts`: accepts optional `type` param, persists it.
- `upsert_edge` MCP tool in `server/src/mcp/router.ts`: `type` in input schema (optional string).
- Sync: `POST /api/sync/edges` round-trips `type` via `replaceOne` — verified.
- Brain API: `GET /api/brain/spaces/:spaceId/edges` returns `type` if present.

Client:
- Brain UI edges tab: `Type` column shown between `Relation` and `To`.

Tests: 2 new tests in `testing/integration/brain.test.js` (edge with type persists; edge without type unaffected). 30/30 brain tests pass.

Docs: Knowledge-graph edges subsection added to `docs/userguide.md`.

---

## V2-8 · File Preview  ✅ DONE

**Current state:** File manager lists files with name, size, date. Clicking downloads. No inline preview.

**Required:**

Client (`client/src/app/pages/files/file-manager.component.ts`):
- Clicking a file opens a preview pane (right panel or overlay) instead of downloading.
- Text files (`.txt`, `.md`, `.json`, `.yaml`, `.yml`, `.ts`, `.js`, `.py`, `.sh`, `.csv`, `.xml`, `.html`, `.css`, `.log`, `.env`, `.toml`): syntax-highlighted code view. Use a lightweight highlighter (e.g. Prism.js or highlight.js — pick one, no heavy editor).
- Images (`.png`, `.jpg`, `.jpeg`, `.gif`, `.webp`, `.svg`, `.bmp`): `<img>` tag with constrained max size.
- PDF (`.pdf`): embedded `<iframe>` or `<object>` tag pointing at the download URL.
- Unknown types: show file metadata (size, modified, type) with a Download button.
- "Download" button always visible in preview pane header.
- Close button / Escape to dismiss preview.
- Keyboard: arrow keys to navigate between files while preview is open.

Server: No changes needed — `GET /api/files/:spaceId?path=<path>` already serves file contents with correct MIME types.

**Acceptance:** Preview a .md file (syntax highlighted), a .png image (rendered), a .pdf (embedded viewer). Unknown .zip shows metadata + download button.

---

## V2-9 · Directory Tree Sidebar  ✅ DONE

**Current state:** File manager uses flat listing with breadcrumb navigation. No persistent tree view.

**Required:**

Client (`client/src/app/pages/files/file-manager.component.ts`):
- Left sidebar showing directory tree for the active space.
- Tree loads lazily: root children on init, subdirectories expand on click (calls `GET /api/files/:spaceId?path=<dir>`).
- Current directory highlighted in tree.
- Clicking a directory in the tree navigates the main pane to that directory.
- Collapsible: toggle button to hide/show sidebar. State persisted in localStorage.
- Tree nodes: folder icon + name. Expandable with caret indicator.
- Main pane retains: breadcrumbs, file listing, upload zone, context menu actions.

**Acceptance:** Navigate a 3-level deep directory structure using only the tree sidebar. Current dir highlighted. Collapse sidebar, refresh page, sidebar stays collapsed.

---

## Priority Order

| Priority | Item | Effort |
|----------|------|--------|
| 1 | V2-2 · Conflict Resolution Actions | Medium |
| 2 | V2-7 · Edge `type` Field | Small |
| 3 | V2-4 · Memory List Filtering | Small |
| 4 | V2-3 · Bulk Memory Wipe | Small |
| 5 | V2-1 · Chunked Upload | Large |
| 6 | V2-6 · Sync History Log | Medium |
| 7 | V2-5 · About Section | Small |
| 8 | V2-8 · File Preview | Medium |
| 9 | V2-9 · Directory Tree Sidebar | Medium |
