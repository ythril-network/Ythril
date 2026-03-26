# Ythril TODO

## Planned — Timeline Collection

Add a temporal data layer alongside the brain's entities/edges/memories.

**Collection:** `{spaceId}_timeline` (one per space, like memories/entities/edges).

**Document type:** `TimelineEntry`

```ts
interface TimelineEntry {
  _id: string;
  spaceId: string;
  title: string;
  description?: string;
  kind: 'event' | 'deadline' | 'plan' | 'prediction' | 'milestone';
  startsAt: Date;            // required — when it begins (or the single point in time)
  endsAt?: Date;             // optional — for spans
  status: 'upcoming' | 'active' | 'completed' | 'overdue' | 'cancelled';
  confidence?: number;       // 0–1, for predictions
  tags: string[];
  entityIds: string[];       // link to brain entities
  memoryIds: string[];       // link to memories
  recurrence?: {             // optional repeating pattern
    freq: 'daily' | 'weekly' | 'monthly' | 'yearly';
    interval: number;
    until?: Date;
  };
  author: string;
  createdAt: Date;
  updatedAt: Date;
  seq: number;               // for sync protocol
}
```

**Indexes:** `{ spaceId, startsAt }`, `{ spaceId, status }`, `{ spaceId, seq }`.

**MCP tools:** `create_timeline`, `update_timeline`, `list_timeline`, `upcoming`, `overdue`, `complete_timeline`, `cancel_timeline`.

**API routes:** `POST/GET/DELETE /api/brain/spaces/:spaceId/timeline`.

**Sync:** Same last-writer-wins `seq`-based rule as entities/edges. Add `timeline` array to `POST /api/sync/batch-upsert`.
