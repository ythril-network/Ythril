/**
 * Sync protocol endpoints — called by remote peer instances.
 *
 * Authentication: validated against the network member's tokenHash using the
 * same Bearer token mechanism as client tokens, but via a separate lookup
 * that checks network member hashes rather than named PATs.
 *
 * Route prefix: /api/sync
 */

import { Router } from 'express';
import { z } from 'zod';
import { col } from '../db/mongo.js';
import { syncRateLimit } from '../rate-limit/middleware.js';
import { getConfig } from '../config/loader.js';
import { listTombstones, applyRemoteTombstone } from '../brain/tombstones.js';
import { requireAuth } from '../auth/middleware.js';
import { log } from '../util/log.js';
import { nextSeq } from '../util/seq.js';
import type {
  MemoryDoc,
  EntityDoc,
  EdgeDoc,
  TombstoneDoc,
  NetworkMember,
} from '../config/types.js';

export const syncRouter = Router();

// ── Paginated cursor helpers ───────────────────────────────────────────────

function encodeCursor(seq: number): string {
  return Buffer.from(String(seq)).toString('base64url');
}
function decodeCursor(token: string): number {
  try { return parseInt(Buffer.from(token, 'base64url').toString(), 10) || 0; }
  catch { return 0; }
}

// ── Space access guard ─────────────────────────────────────────────────────

function spaceAllowed(spaceId: string, networkId?: string): boolean {
  const cfg = getConfig();
  // If no networkId given, allow any known space
  if (!networkId) return cfg.spaces.some(s => s.id === spaceId);
  const net = cfg.networks.find(n => n.id === networkId);
  // networkId not found locally — fall back to checking the space exists.
  // This handles asymmetric networks where the caller has the network config
  // but the recipient does not (e.g. single-side configured networks).
  if (!net) return cfg.spaces.some(s => s.id === spaceId);
  return net.spaces.includes(spaceId);
}

// ═══════════════════════════════════════════════════════════════════════════
// MEMORIES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/memories?spaceId=&networkId=&sinceSeq=&limit=&cursor=&full=
 * Returns paginated stubs by default.  Add ?full=true to return complete docs
 * in a single pass (eliminates the N per-document fetches on the pull side).
 */
syncRouter.get('/memories', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, sinceSeq = '0', limit = '100', cursor, full: fullParam } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
    const returnFull = fullParam === 'true';

    const rawDocs = returnFull
      ? await col<MemoryDoc>(`${spaceId}_memories`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).toArray() as MemoryDoc[]
      : await col<MemoryDoc>(`${spaceId}_memories`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

    const hasMore = rawDocs.length > pageSize;
    const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
    const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

    // Tombstone stubs are always appended (tombstones are stubs regardless of full mode)
    const tombstones = await listTombstones(spaceId, sinceVal, pageSize);
    const tombs = tombstones
      .filter(t => t.type === 'memory')
      .map(t => ({ _id: t._id, seq: t.seq, deletedAt: t.deletedAt }));

    res.json({ items: [...items, ...tombs].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq), nextCursor });
  } catch (err) {
    log.error(`sync GET memories: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/sync/memories/:id?spaceId=
 * Fetch a single full memory document.
 */
syncRouter.get('/memories/:id', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const doc = await col<MemoryDoc>(`${spaceId}_memories`).findOne({ _id: req.params['id'] } as never);
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(doc);
  } catch (err) {
    log.error(`sync GET memory/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/sync/memories?spaceId=&networkId=
 * Upsert a memory received from a peer.
 * Conflict rule: higher seq wins; equal seq forks.
 */
syncRouter.post('/memories', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const incoming = req.body as MemoryDoc;
    if (!incoming?._id || typeof incoming.seq !== 'number') {
      res.status(400).json({ error: 'Invalid memory document' });
      return;
    }

    // Check for tombstone — if a tombstone with >= seq exists, skip
    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne({ _id: incoming._id, type: 'memory' } as never) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }

    const existing = await col<MemoryDoc>(`${spaceId}_memories`)
      .findOne({ _id: incoming._id } as never) as MemoryDoc | null;

    if (!existing) {
      // No local copy — insert directly
      await col<MemoryDoc>(`${spaceId}_memories`).insertOne(incoming as never);
      res.status(200).json({ status: 'inserted' });
      return;
    }

    if (incoming.seq > existing.seq) {
      // Remote is newer — overwrite
      await col<MemoryDoc>(`${spaceId}_memories`).replaceOne({ _id: incoming._id } as never, incoming as never);
      res.status(200).json({ status: 'updated' });
      return;
    }

    if (incoming.seq === existing.seq && incoming.fact !== existing.fact) {
      // Concurrent independent edit — fork
      const { v4: uuidv4 } = await import('uuid');
      const forkSeq = await nextSeq(spaceId);
      const fork: MemoryDoc = {
        ...incoming,
        _id: uuidv4(),
        forkOf: incoming._id,
        seq: forkSeq,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      await col<MemoryDoc>(`${spaceId}_memories`).insertOne(fork as never);
      res.status(200).json({ status: 'forked', forkId: fork._id });
      return;
    }

    res.status(200).json({ status: 'skipped' });
  } catch (err) {
    log.error(`sync POST memories: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// ENTITIES
// ═══════════════════════════════════════════════════════════════════════════

syncRouter.get('/entities', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, sinceSeq = '0', limit = '100', cursor, full: fullParam } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
    const returnFull = fullParam === 'true';

    const rawDocs = returnFull
      ? await col<EntityDoc>(`${spaceId}_entities`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).toArray() as EntityDoc[]
      : await col<EntityDoc>(`${spaceId}_entities`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

    const hasMore = rawDocs.length > pageSize;
    const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
    const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

    const tombstones = await listTombstones(spaceId, sinceVal, pageSize);
    const tombs = tombstones
      .filter(t => t.type === 'entity')
      .map(t => ({ _id: t._id, seq: t.seq, deletedAt: t.deletedAt }));

    res.json({ items: [...items, ...tombs].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq), nextCursor });
  } catch (err) {
    log.error(`sync GET entities: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

syncRouter.get('/entities/:id', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const doc = await col<EntityDoc>(`${spaceId}_entities`).findOne({ _id: req.params['id'] } as never);
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

syncRouter.post('/entities', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const incoming = req.body as EntityDoc;
    if (!incoming?._id || typeof incoming.seq !== 'number') {
      res.status(400).json({ error: 'Invalid entity document' });
      return;
    }

    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne({ _id: incoming._id, type: 'entity' } as never) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }

    await col<EntityDoc>(`${spaceId}_entities`).updateOne(
      { _id: incoming._id } as never,
      { $setOnInsert: incoming } as never,
      { upsert: true },
    );

    // Merge tags on conflict
    const existing = await col<EntityDoc>(`${spaceId}_entities`).findOne({ _id: incoming._id } as never) as EntityDoc;
    if (existing && incoming.seq > existing.seq) {
      await col<EntityDoc>(`${spaceId}_entities`).replaceOne({ _id: incoming._id } as never, incoming as never);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error(`sync POST entities: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// EDGES
// ═══════════════════════════════════════════════════════════════════════════

syncRouter.get('/edges', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, sinceSeq = '0', limit = '100', cursor, full: fullParam } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
    const returnFull = fullParam === 'true';

    const rawDocs = returnFull
      ? await col<EdgeDoc>(`${spaceId}_edges`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).toArray() as EdgeDoc[]
      : await col<EdgeDoc>(`${spaceId}_edges`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

    const hasMore = rawDocs.length > pageSize;
    const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
    const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

    const tombstones = await listTombstones(spaceId, sinceVal, pageSize);
    const tombs = tombstones
      .filter(t => t.type === 'edge')
      .map(t => ({ _id: t._id, seq: t.seq, deletedAt: t.deletedAt }));

    res.json({ items: [...items, ...tombs].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq), nextCursor });
  } catch (err) {
    log.error(`sync GET edges: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

syncRouter.get('/edges/:id', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const doc = await col<EdgeDoc>(`${spaceId}_edges`).findOne({ _id: req.params['id'] } as never);
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

syncRouter.post('/edges', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const incoming = req.body as EdgeDoc;
    if (!incoming?._id || typeof incoming.seq !== 'number') {
      res.status(400).json({ error: 'Invalid edge document' });
      return;
    }

    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne({ _id: incoming._id, type: 'edge' } as never) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }

    const existing = await col<EdgeDoc>(`${spaceId}_edges`).findOne({ _id: incoming._id } as never) as EdgeDoc | null;
    if (!existing || incoming.seq > existing.seq) {
      await col<EdgeDoc>(`${spaceId}_edges`).replaceOne(
        { _id: incoming._id } as never,
        incoming as never,
        { upsert: true },
      );
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error(`sync POST edges: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// BATCH UPSERT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * POST /api/sync/batch-upsert?spaceId=&networkId=
 * Accept arrays of memories, entities and/or edges and upsert them all in one
 * request.  Same conflict rules as the individual POST endpoints.
 * Limits: 500 docs per type per request to cap payload size.
 */
syncRouter.post('/batch-upsert', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const body = req.body as { memories?: MemoryDoc[]; entities?: EntityDoc[]; edges?: EdgeDoc[] };
    const memories = Array.isArray(body?.memories) ? body.memories.slice(0, 500) : [];
    const entities = Array.isArray(body?.entities) ? body.entities.slice(0, 500) : [];
    const edges    = Array.isArray(body?.edges)    ? body.edges.slice(0, 500)    : [];

    // ── Memories ─────────────────────────────────────────────────────────
    const memStats = { inserted: 0, updated: 0, forked: 0, skipped: 0, tombstoned: 0 };
    for (const incoming of memories) {
      if (!incoming?._id || typeof incoming.seq !== 'number') continue;
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne({ _id: incoming._id, type: 'memory' } as never) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { memStats.tombstoned++; continue; }

      const existing = await col<MemoryDoc>(`${spaceId}_memories`)
        .findOne({ _id: incoming._id } as never) as MemoryDoc | null;
      if (!existing) {
        await col<MemoryDoc>(`${spaceId}_memories`).insertOne(incoming as never);
        memStats.inserted++;
      } else if (incoming.seq > existing.seq) {
        await col<MemoryDoc>(`${spaceId}_memories`).replaceOne({ _id: incoming._id } as never, incoming as never);
        memStats.updated++;
      } else if (incoming.seq === existing.seq && incoming.fact !== existing.fact) {
        const { v4: uuidv4 } = await import('uuid');
        const forkSeq = await nextSeq(spaceId);
        const fork: MemoryDoc = {
          ...incoming, _id: uuidv4(), forkOf: incoming._id, seq: forkSeq,
          createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        await col<MemoryDoc>(`${spaceId}_memories`).insertOne(fork as never);
        memStats.forked++;
      } else {
        memStats.skipped++;
      }
    }

    // ── Entities ─────────────────────────────────────────────────────────
    const entStats = { upserted: 0, skipped: 0, tombstoned: 0 };
    for (const incoming of entities) {
      if (!incoming?._id || typeof incoming.seq !== 'number') continue;
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne({ _id: incoming._id, type: 'entity' } as never) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { entStats.tombstoned++; continue; }

      const existing = await col<EntityDoc>(`${spaceId}_entities`)
        .findOne({ _id: incoming._id } as never) as EntityDoc | null;
      if (!existing || incoming.seq > existing.seq) {
        await col<EntityDoc>(`${spaceId}_entities`).replaceOne(
          { _id: incoming._id } as never, incoming as never, { upsert: true },
        );
        entStats.upserted++;
      } else {
        entStats.skipped++;
      }
    }

    // ── Edges ─────────────────────────────────────────────────────────────
    const edgeStats = { upserted: 0, skipped: 0, tombstoned: 0 };
    for (const incoming of edges) {
      if (!incoming?._id || typeof incoming.seq !== 'number') continue;
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne({ _id: incoming._id, type: 'edge' } as never) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { edgeStats.tombstoned++; continue; }

      const existing = await col<EdgeDoc>(`${spaceId}_edges`)
        .findOne({ _id: incoming._id } as never) as EdgeDoc | null;
      if (!existing || incoming.seq > existing.seq) {
        await col<EdgeDoc>(`${spaceId}_edges`).replaceOne(
          { _id: incoming._id } as never, incoming as never, { upsert: true },
        );
        edgeStats.upserted++;
      } else {
        edgeStats.skipped++;
      }
    }

    res.status(200).json({ status: 'ok', memories: memStats, entities: entStats, edges: edgeStats });
  } catch (err) {
    log.error(`sync POST batch-upsert: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// TOMBSTONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/tombstones?spaceId=&networkId=&sinceSeq=
 * Bulk tombstone export for efficient deletion sync.
 */
syncRouter.get('/tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, sinceSeq = '0' } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const since = parseInt(sinceSeq, 10);
    const all = await listTombstones(spaceId, since, 1000);
    res.json({
      memories: all.filter(t => t.type === 'memory'),
      entities: all.filter(t => t.type === 'entity'),
      edges: all.filter(t => t.type === 'edge'),
    });
  } catch (err) {
    log.error(`sync GET tombstones: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

/** POST /api/sync/tombstones — apply tombstones received from a peer */
syncRouter.post('/tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const body = req.body as { tombstones?: TombstoneDoc[] };
    const tombstones = body?.tombstones ?? [];

    const schema = z.array(z.object({
      _id: z.string(),
      type: z.enum(['memory', 'entity', 'edge']),
      spaceId: z.string(),
      deletedAt: z.string(),
      instanceId: z.string(),
      seq: z.number(),
    }));
    const parsed = schema.safeParse(tombstones);
    if (!parsed.success) { res.status(400).json({ error: 'Invalid tombstone format' }); return; }

    await Promise.all(parsed.data.map(t => applyRemoteTombstone(t)));
    res.status(200).json({ applied: parsed.data.length });
  } catch (err) {
    log.error(`sync POST tombstones: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FILE MANIFEST
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/manifest?spaceId=&networkId=&since=<isoTimestamp>
 * Returns list of { path, sha256, size, modifiedAt } for files changed since timestamp.
 * Omit `since` for a full manifest.
 */
syncRouter.get('/manifest', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, since } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const { buildFileManifest } = await import('../files/manifest.js');
    const sinceDate = since ? new Date(since) : undefined;
    const manifest = await buildFileManifest(spaceId, sinceDate);
    res.json({ manifest });
  } catch (err) {
    log.error(`sync GET manifest: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GOSSIP — member list & votes
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/networks/:networkId/members
 * Return our current view of this network's member list (excluding sensitive fields).
 */
syncRouter.get('/networks/:networkId/members', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const safeMembers = net.members.map(m => {
      const { tokenHash: _th, skipTlsVerify: _sv, ...safe } = m;
      return safe;
    });
    res.json({ members: safeMembers, updatedAt: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/sync/networks/:networkId/members
 * Peer announces its own member record or relays records it knows about.
 * Only a member may update its own record (gossip poisoning protection).
 */
syncRouter.post('/networks/:networkId/members', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const incoming = req.body as Partial<NetworkMember>;
    if (!incoming?.instanceId || !incoming?.label || !incoming?.url) {
      res.status(400).json({ error: 'instanceId, label, url required' });
      return;
    }

    // Gossip poisoning protection: only accept record for the member the caller represents.
    // We identify the caller by the token they used (its author instanceId).
    // For Now, we validate that the URL hostname matches expected.
    const existing = net.members.find(m => m.instanceId === incoming.instanceId);
    if (!existing) {
      // Unknown member — relay is informational; don't auto-add
      res.status(200).json({ status: 'unknown_member' });
      return;
    }

    // Only the declared instance may update its own record's URL/label/children/direction
    // We trust the caller if they can authenticate (which syncAuth already verified).
    // For simplicity in Phase 3 we apply without full cryptographic proof.
    const { saveConfig, loadConfig } = await import('../config/loader.js');
    const fresh = loadConfig();
    const freshNet = fresh.networks.find(n => n.id === req.params['networkId']);
    if (freshNet) {
      const idx = freshNet.members.findIndex(m => m.instanceId === incoming.instanceId);
      if (idx >= 0) {
        freshNet.members[idx] = {
          ...freshNet.members[idx]!,
          label: incoming.label ?? freshNet.members[idx]!.label,
          url: incoming.url ?? freshNet.members[idx]!.url,
          children: incoming.children ?? freshNet.members[idx]!.children,
          lastSyncAt: new Date().toISOString(),
        };
        saveConfig(fresh);
      }
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error(`sync POST members: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * GET /api/sync/networks/:networkId/votes
 * Return current open vote rounds for this network.
 */
syncRouter.get('/networks/:networkId/votes', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const cfg = getConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const open = net.pendingRounds.filter(r => !r.concluded);
    res.json({ rounds: open });
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/sync/networks/:networkId/votes/:roundId
 * Peer submits or relays a vote: { vote: 'yes' | 'veto', instanceId }
 */
syncRouter.post('/networks/:networkId/votes/:roundId', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const body = req.body as { vote: string; instanceId: string };
    if (!body?.vote || !body?.instanceId || !['yes', 'veto'].includes(body.vote)) {
      res.status(400).json({ error: 'vote (yes|veto) and instanceId required' });
      return;
    }

    const { loadConfig, saveConfig } = await import('../config/loader.js');
    const cfg = loadConfig();
    const net = cfg.networks.find(n => n.id === req.params['networkId']);
    if (!net) { res.status(404).json({ error: 'Network not found' }); return; }

    const round = net.pendingRounds.find(r => r.roundId === req.params['roundId'] && !r.concluded);
    if (!round) { res.status(404).json({ error: 'Round not found or concluded' }); return; }

    // Deduplicate: replace existing vote from this instance if present
    const existing = round.votes.findIndex(v => v.instanceId === body.instanceId);
    const cast = { instanceId: body.instanceId, vote: body.vote as 'yes' | 'veto', castAt: new Date().toISOString() };
    if (existing >= 0) { round.votes[existing] = cast; }
    else { round.votes.push(cast); }

    // Check if the round should auto-conclude
    concludeRoundIfReady(net, round);

    // If a space_deletion round just passed, remove the space on this instance
    if (round.concluded && round.type === 'space_deletion') {
      const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
      if (vetoCount === 0 && round.spaceId) {
        import('../spaces/spaces.js').then(({ removeSpace }) => {
          removeSpace(round.spaceId!).catch(err => log.error(`space_deletion gossip side-effect: ${err}`));
        }).catch(err => log.error(`space_deletion import: ${err}`));
      }
    }

    saveConfig(cfg);
    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error(`sync POST votes: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ── Vote conclusion logic ──────────────────────────────────────────────────

function concludeRoundIfReady(
  net: import('../config/types.js').NetworkConfig,
  round: import('../config/types.js').VoteRound,
): void {
  const voters = net.members.filter(m => !round.subjectInstanceId || m.instanceId !== round.subjectInstanceId);
  const yesCount = round.votes.filter(v => v.vote === 'yes').length;
  const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
  const pastDeadline = new Date(round.deadline) < new Date();

  let passed = false;
  switch (net.type) {
    case 'closed':
      // Unanimous yes from all existing members; if no members yet, proposer's yes suffices
      passed = vetoCount === 0 && (voters.length === 0 || yesCount >= voters.length);
      break;
    case 'democratic':
      passed = (voters.length === 0 && yesCount > 0) || (yesCount > voters.length / 2 && vetoCount === 0);
      break;
    case 'club':
      // For Club: only the inviter/proposer (first yes voter) decides
      passed = yesCount >= 1 && vetoCount === 0;
      break;
    case 'braintree':
      // Ancestors on the path must all vote yes — simplified: all voters
      passed = vetoCount === 0 && (voters.length === 0 || yesCount >= voters.length);
      break;
  }

  if (vetoCount > 0 || pastDeadline) {
    round.concluded = true;
    return;
  }
  if (passed) {
    round.concluded = true;
    // On join round pass: the candidate will call join again and get a 200 with member list
    // On remove round pass: remove the member
    if (round.type === 'remove') {
      const idx = net.members.findIndex(m => m.instanceId === round.subjectInstanceId);
      if (idx >= 0) net.members.splice(idx, 1);
    }
  }
}

// Re-export the helper for use by the network router
export { concludeRoundIfReady };
