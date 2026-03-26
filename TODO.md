# Ythril TODO

## ✅ Done — Chrono Collection (v0.3.0)

Temporal data layer added alongside brain's entities/edges/memories.

**Collection:** `{spaceId}_chrono` (one per space, like memories/entities/edges).

**Document type:** `ChronoEntry` — `kind` (event/deadline/plan/prediction/milestone), `status` (upcoming/active/completed/overdue/cancelled), `confidence` (0–1), tags, entityIds, memoryIds, recurrence.

**Indexes:** `{ spaceId, startsAt }`, `{ spaceId, status }`, `{ spaceId, seq }`.

**MCP tools:** `create_chrono`, `update_chrono`, `list_chrono` + `query` collection support.

**API routes:** `POST/GET/DELETE /api/brain/spaces/:spaceId/chrono`, `POST .../chrono/:id`.

**Sync:** Last-writer-wins `seq`-based rule. Individual `GET/POST /api/sync/chrono` + batch-upsert support. Tombstone type `'chrono'`.
