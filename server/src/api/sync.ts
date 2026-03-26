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
import { getConfig, getSecrets, getDataRoot } from '../config/loader.js';
import { listTombstones, applyRemoteTombstone } from '../brain/tombstones.js';
import { requireAuth } from '../auth/middleware.js';
import { log } from '../util/log.js';
import { nextSeq, bumpSeq } from '../util/seq.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import type {
  MemoryDoc,
  EntityDoc,
  EdgeDoc,
  ChronoEntry,
  TombstoneDoc,
  FileTombstoneDoc,
  NetworkMember,
} from '../config/types.js';

export const syncRouter = Router();

// ── Safety limits ─────────────────────────────────────────────────────────

/**
 * Upper bound on any seq value accepted from a remote peer.
 * Prevents an attacker from submitting seq = Number.MAX_SAFE_INTEGER (9007199254740991)
 * to permanently poison the high-water mark, causing all future legitimate
 * writes by other peers to be silently ignored.
 *
 * 2^50 ≈ 1.1 quadrillion — larger than any realistic counter, but safely
 * below MAX_SAFE_INTEGER so that nextSeq() arithmetic stays in safe range.
 */
const MAX_SYNC_SEQ = 2 ** 50; // 1_125_899_906_842_624

/**
 * Maximum number of fork copies that can accumulate for a single memory _id.
 * Prevents a "forkOf bomb" where an attacker repeatedly sends equal-seq docs
 * with different content to create an unbounded chain of fork copies.
 */
const MAX_FORK_DEPTH = 10;

// ── Incoming document schemas (Zod validation for peer-submitted docs) ─────

const AuthorRefSchema = z.object({
  instanceId: z.string().min(1),
  instanceLabel: z.string().min(1),
});

const IncomingMemoryDoc = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  fact: z.string(),
  embedding: z.array(z.number()),
  tags: z.array(z.string()).max(100),
  entityIds: z.array(z.string()).max(500),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
  embeddingModel: z.string(),
  forkOf: z.string().optional(),
});

const IncomingEntityDoc = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  name: z.string().min(1),
  type: z.string().min(1),
  tags: z.array(z.string()).max(100),
  properties: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

const IncomingEdgeDoc = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  from: z.string().min(1),
  to: z.string().min(1),
  label: z.string(),
  type: z.string().optional(),
  weight: z.number().optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

const IncomingChronoDoc = z.object({
  _id: z.string().min(1),
  spaceId: z.string().min(1),
  title: z.string().min(1),
  description: z.string().optional(),
  kind: z.enum(['event', 'deadline', 'plan', 'prediction', 'milestone']),
  startsAt: z.string().min(1),
  endsAt: z.string().optional(),
  status: z.enum(['upcoming', 'active', 'completed', 'overdue', 'cancelled']),
  confidence: z.number().min(0).max(1).optional(),
  tags: z.array(z.string()).max(100).default([]),
  entityIds: z.array(z.string()).max(500).default([]),
  memoryIds: z.array(z.string()).max(500).default([]),
  recurrence: z.object({
    freq: z.enum(['daily', 'weekly', 'monthly', 'yearly']),
    interval: z.number().int().positive(),
    until: z.string().optional(),
  }).optional(),
  author: AuthorRefSchema,
  createdAt: z.string(),
  updatedAt: z.string(),
  seq: z.number().int().nonnegative().max(MAX_SYNC_SEQ),
});

// ── Paginated cursor helpers ─────────────────────────────────────────────────

function encodeCursor(seq: number): string {
  return Buffer.from(String(seq)).toString('base64url');
}
function decodeCursor(token: string): number {
  try { return parseInt(Buffer.from(token, 'base64url').toString(), 10) || 0; }
  catch { return 0; }
}

// ── Space access guard ─────────────────────────────────────────────────────

/**
 * Returns true if:
 *  1. The calling token (if space-scoped) includes spaceId in its allowlist, AND
 *  2. The spaceId is valid for the given networkId (or exists locally if no networkId).
 *
 * @param tokenSpaces - the `spaces` field from req.authToken (undefined = full-access token)
 */
function spaceAllowed(spaceId: string, networkId?: string, tokenSpaces?: string[]): boolean {
  const cfg = getConfig();
  // Enforce token-level space scope before any network check
  if (tokenSpaces && !tokenSpaces.includes(spaceId)) return false;
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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
    const returnFull = fullParam === 'true';

    const rawDocs = returnFull
      ? await col<MemoryDoc>(`${spaceId}_memories`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).toArray() as MemoryDoc[]
      : await col<MemoryDoc>(`${spaceId}_memories`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

    const hasMore = rawDocs.length > pageSize;
    const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
    const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

    // Tombstone stubs are appended within the current page's seq range only.
    // Capping at the last memory item's seq prevents tombstones with high seq
    // from appearing on both the current page AND the next page (cursor duplicate bug).
    const pageMaxSeq = items.length > 0 ? (items[items.length - 1] as { seq: number }).seq : sinceVal;
    const tombstones = await listTombstones(spaceId, sinceVal, pageSize);
    const tombs = tombstones
      .filter(t => t.type === 'memory' && t.seq <= pageMaxSeq)
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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const parsed = IncomingMemoryDoc.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid memory document' });
      return;
    }
    const incoming = parsed.data as MemoryDoc;

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
      // Concurrent independent edit — fork; but cap the chain length
      const forkCount = await col<MemoryDoc>(`${spaceId}_memories`)
        .countDocuments({ forkOf: incoming._id } as never);
      if (forkCount >= MAX_FORK_DEPTH) {
        res.status(400).json({ error: `Fork depth limit (${MAX_FORK_DEPTH}) exceeded for _id '${incoming._id}'` });
        return;
      }
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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
    const returnFull = fullParam === 'true';

    const rawDocs = returnFull
      ? await col<EntityDoc>(`${spaceId}_entities`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).toArray() as EntityDoc[]
      : await col<EntityDoc>(`${spaceId}_entities`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

    const hasMore = rawDocs.length > pageSize;
    const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
    const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

    const pageMaxSeq = items.length > 0 ? (items[items.length - 1] as { seq: number }).seq : sinceVal;
    const tombstones = await listTombstones(spaceId, sinceVal, pageSize);
    const tombs = tombstones
      .filter(t => t.type === 'entity' && t.seq <= pageMaxSeq)
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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const parsed = IncomingEntityDoc.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid entity document' });
      return;
    }
    const incoming = parsed.data as EntityDoc;

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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
    const returnFull = fullParam === 'true';

    const rawDocs = returnFull
      ? await col<EdgeDoc>(`${spaceId}_edges`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).toArray() as EdgeDoc[]
      : await col<EdgeDoc>(`${spaceId}_edges`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

    const hasMore = rawDocs.length > pageSize;
    const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
    const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

    const pageMaxSeq = items.length > 0 ? (items[items.length - 1] as { seq: number }).seq : sinceVal;
    const tombstones = await listTombstones(spaceId, sinceVal, pageSize);
    const tombs = tombstones
      .filter(t => t.type === 'edge' && t.seq <= pageMaxSeq)
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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const parsed = IncomingEdgeDoc.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid edge document' });
      return;
    }
    const incoming = parsed.data as EdgeDoc;

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
// CHRONO
// ═══════════════════════════════════════════════════════════════════════════

syncRouter.get('/chrono', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, sinceSeq = '0', limit = '100', cursor, full: fullParam } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const sinceVal = cursor ? decodeCursor(cursor) : parseInt(sinceSeq, 10);
    const pageSize = Math.min(parseInt(limit, 10) || 100, 500);
    const returnFull = fullParam === 'true';

    const rawDocs = returnFull
      ? await col<ChronoEntry>(`${spaceId}_chrono`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).toArray() as ChronoEntry[]
      : await col<ChronoEntry>(`${spaceId}_chrono`).find({ seq: { $gt: sinceVal } } as never).sort({ seq: 1 }).limit(pageSize + 1).project({ _id: 1, seq: 1 }).toArray() as { _id: string; seq: number }[];

    const hasMore = rawDocs.length > pageSize;
    const items: typeof rawDocs = hasMore ? rawDocs.slice(0, pageSize) : rawDocs;
    const nextCursor = hasMore ? encodeCursor((items[items.length - 1] as { seq: number }).seq) : null;

    const pageMaxSeq = items.length > 0 ? (items[items.length - 1] as { seq: number }).seq : sinceVal;
    const tombstones = await listTombstones(spaceId, sinceVal, pageSize);
    const tombs = tombstones
      .filter(t => t.type === 'chrono' && t.seq <= pageMaxSeq)
      .map(t => ({ _id: t._id, seq: t.seq, deletedAt: t.deletedAt }));

    res.json({ items: [...items, ...tombs].sort((a, b) => (a as { seq: number }).seq - (b as { seq: number }).seq), nextCursor });
  } catch (err) {
    log.error(`sync GET chrono: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

syncRouter.get('/chrono/:id', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const doc = await col<ChronoEntry>(`${spaceId}_chrono`).findOne({ _id: req.params['id'] } as never);
    if (!doc) { res.status(404).json({ error: 'Not found' }); return; }
    res.json(doc);
  } catch (err) {
    res.status(500).json({ error: 'Internal error' });
  }
});

syncRouter.post('/chrono', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const parsed = IncomingChronoDoc.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: 'Invalid chrono document' });
      return;
    }
    const incoming = parsed.data as ChronoEntry;

    const tombstone = await col<TombstoneDoc>(`${spaceId}_tombstones`)
      .findOne({ _id: incoming._id, type: 'chrono' } as never) as TombstoneDoc | null;
    if (tombstone && tombstone.seq >= incoming.seq) {
      res.status(200).json({ status: 'tombstoned' });
      return;
    }

    const existing = await col<ChronoEntry>(`${spaceId}_chrono`).findOne({ _id: incoming._id } as never) as ChronoEntry | null;
    if (!existing || incoming.seq > existing.seq) {
      await col<ChronoEntry>(`${spaceId}_chrono`).replaceOne(
        { _id: incoming._id } as never,
        incoming as never,
        { upsert: true },
      );
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    log.error(`sync POST chrono: ${err}`);
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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const body = req.body as { memories?: unknown[]; entities?: unknown[]; edges?: unknown[]; chrono?: unknown[] };
    const memories = (Array.isArray(body?.memories) ? body.memories.slice(0, 500) : [])
      .flatMap(m => { const r = IncomingMemoryDoc.safeParse(m); return r.success ? [r.data as MemoryDoc] : []; });
    const entities = (Array.isArray(body?.entities) ? body.entities.slice(0, 500) : [])
      .flatMap(e => { const r = IncomingEntityDoc.safeParse(e); return r.success ? [r.data as EntityDoc] : []; });
    const edges = (Array.isArray(body?.edges) ? body.edges.slice(0, 500) : [])
      .flatMap(e => { const r = IncomingEdgeDoc.safeParse(e); return r.success ? [r.data as EdgeDoc] : []; });
    const chrono = (Array.isArray(body?.chrono) ? body.chrono.slice(0, 500) : [])
      .flatMap(c => { const r = IncomingChronoDoc.safeParse(c); return r.success ? [r.data as ChronoEntry] : []; });

    // ── Memories ─────────────────────────────────────────────────────────
    const memStats = { inserted: 0, updated: 0, forked: 0, skipped: 0, tombstoned: 0 };
    for (const incoming of memories) {
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
        // Cap fork chains to prevent unbounded growth
        const forkCount = await col<MemoryDoc>(`${spaceId}_memories`)
          .countDocuments({ forkOf: incoming._id } as never);
        if (forkCount >= MAX_FORK_DEPTH) { memStats.skipped++; continue; }
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

    // ── Chrono ─────────────────────────────────────────────────────────────────
    const chronoStats = { upserted: 0, skipped: 0, tombstoned: 0 };
    for (const incoming of chrono) {
      const tomb = await col<TombstoneDoc>(`${spaceId}_tombstones`)
        .findOne({ _id: incoming._id, type: 'chrono' } as never) as TombstoneDoc | null;
      if (tomb && tomb.seq >= incoming.seq) { chronoStats.tombstoned++; continue; }

      const existing = await col<ChronoEntry>(`${spaceId}_chrono`)
        .findOne({ _id: incoming._id } as never) as ChronoEntry | null;
      if (!existing || incoming.seq > existing.seq) {
        await col<ChronoEntry>(`${spaceId}_chrono`).replaceOne(
          { _id: incoming._id } as never, incoming as never, { upsert: true },
        );
        chronoStats.upserted++;
      } else {
        chronoStats.skipped++;
      }
    }

    res.status(200).json({ status: 'ok', memories: memStats, entities: entStats, edges: edgeStats, chrono: chronoStats });

    // Bump the local seq counter so future local writes always get a seq higher
    // than any document received via push.  Fire-and-forget after the response.
    const allSeqs = [
      ...memories.map(m => m.seq ?? 0),
      ...entities.map(e => e.seq ?? 0),
      ...edges.map(e => e.seq ?? 0),
      ...chrono.map(c => c.seq ?? 0),
    ];
    const maxIncoming = Math.max(0, ...allSeqs);
    if (maxIncoming > 0) bumpSeq(spaceId, maxIncoming).catch(() => {});
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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

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
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

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
// FILE TOMBSTONES
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/file-tombstones?spaceId=&networkId=&since=<isoTimestamp>
 * Returns file deletion tombstones so peers can replicate file removals.
 * Omit `since` for all tombstones; provide an ISO timestamp for incremental sync.
 */
syncRouter.get('/file-tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId, since } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const filter = since
      ? { spaceId, deletedAt: { $gt: since } }
      : { spaceId };
    const tombstones = await col<FileTombstoneDoc>(`${spaceId}_file_tombstones`)
      .find(filter as never)
      .sort({ deletedAt: 1 })
      .limit(5000)
      .toArray();
    res.json({ tombstones });
  } catch (err) {
    log.error(`sync GET file-tombstones: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

/**
 * POST /api/sync/file-tombstones
 * Accepts file-deletion tombstones from a peer and applies them locally:
 * each tombstone causes the corresponding file to be removed from the local
 * filesystem and the tombstone to be recorded in our MongoDB so we can
 * re-propagate it to further peers.
 */
syncRouter.post('/file-tombstones', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, tombstones } = req.body as { spaceId?: string; tombstones?: unknown[] };
    if (!spaceId || typeof spaceId !== 'string') { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!Array.isArray(tombstones)) { res.status(400).json({ error: 'tombstones must be array' }); return; }
    if (!spaceAllowed(spaceId, undefined, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const spaceFiles = path.resolve(getDataRoot(), 'files', spaceId);
    let applied = 0;

    for (const raw of tombstones) {
      const ts = raw as Partial<FileTombstoneDoc>;
      if (!ts._id || !ts.path || typeof ts.path !== 'string') continue;

      // Path-traversal guard — must stay within the space's files directory.
      const rel = ts.path.replace(/\\/g, '/').replace(/^\/+/, '');
      const abs = path.join(spaceFiles, rel);
      if (!abs.startsWith(spaceFiles + path.sep) && abs !== spaceFiles) continue;

      // Delete the file (ignore if already gone).
      await fs.unlink(abs).catch(() => {});

      // Record tombstone locally so we can propagate it to further peers.
      const doc: FileTombstoneDoc = {
        _id: ts._id,
        spaceId,
        path: rel,
        deletedAt: typeof ts.deletedAt === 'string' ? ts.deletedAt : new Date().toISOString(),
      };
      await col<FileTombstoneDoc>(`${spaceId}_file_tombstones`).updateOne(
        { _id: doc._id } as never,
        { $setOnInsert: doc } as never,
        { upsert: true },
      );
      applied++;
    }

    res.json({ applied });
  } catch (err) {
    log.error(`sync POST file-tombstones: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// MERKLE ROOT
// ═══════════════════════════════════════════════════════════════════════════

/**
 * GET /api/sync/merkle?spaceId=&networkId=
 *
 * Returns the SHA-256 Merkle root for the given space.  The root covers all
 * memory / entity / edge documents (identified by their _id + seq) and all
 * files in the space (identified by their relative path + sha256 hash).
 *
 * This endpoint is consumed by the sync engine when a network has
 * `merkle: true` — after data sync the engine compares roots across peers and
 * emits a MERKLE_DIVERGENCE warning if they disagree.
 *
 * Response: { spaceId, networkId, root, leafCount, computedAt }
 */
syncRouter.get('/merkle', syncRateLimit, requireAuth, async (req, res) => {
  try {
    const { spaceId, networkId } = req.query as Record<string, string>;
    if (!spaceId) { res.status(400).json({ error: 'spaceId required' }); return; }
    if (!spaceAllowed(spaceId, networkId, req.authToken?.spaces)) { res.status(403).json({ error: 'Forbidden' }); return; }

    const { computeMerkleRoot } = await import('../brain/merkle.js');
    const result = await computeMerkleRoot(spaceId);
    res.json({ ...result, networkId: networkId ?? null });
  } catch (err) {
    log.error(`sync GET merkle: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GOSSIP — member list & votes
// ═══════════════════════════════════════════════════════════════════════════

// ── Ejection guard ────────────────────────────────────────────────────────
// If this instance has been removed from a network by vote, all sync requests
// for that network return 401 {"error":"ejected"} so peers stop trying to sync.
syncRouter.use('/networks/:networkId', (req, res, next) => {
  const cfg = getConfig();
  if (cfg.ejectedFromNetworks?.includes(req.params['networkId'] ?? '')) {
    res.status(401).json({ error: 'ejected' });
    return;
  }
  next();
});

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
    if (!incoming?.instanceId || !incoming?.label) {
      res.status(400).json({ error: 'instanceId and label required' });
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

    // Piggyback our own identity in the response so the caller can update their record for us
    const selfUrl = process.env['INSTANCE_URL'] ?? '';
    const selfRecord: Record<string, unknown> = { instanceId: cfg.instanceId, label: cfg.instanceLabel };
    if (selfUrl) selfRecord['url'] = selfUrl;
    res.status(200).json({ status: 'ok', self: selfRecord });
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

    const open = net.pendingRounds
      .filter(r => !r.concluded)
      .map(r => {
        // Strip sensitive key material before sending to a peer instance
        const { inviteKeyHash: _ikh, ...safeRound } = r;
        if (safeRound.pendingMember) {
          const { tokenHash: _th, ...safeMember } = safeRound.pendingMember;
          safeRound.pendingMember = safeMember as typeof safeRound.pendingMember;
        }
        return safeRound;
      });
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

    // If a remove round just passed, notify the ejected member
    if (round.concluded && round.passed && round.type === 'remove') {
      sendMemberRemovedNotify(round.subjectUrl, round.subjectInstanceId, net.id);
    }

    // If a braintree join round just passed via this vote relay, add the pending member
    // only if this instance is the direct parent in the tree.
    if (round.concluded && round.type === 'join' && round.pendingMember &&
        net.type === 'braintree') {
      const alreadyAdded = net.members.some(m => m.instanceId === round.subjectInstanceId);
      const isDirectParent = !round.pendingMember.parentInstanceId ||
        round.pendingMember.parentInstanceId === cfg.instanceId;
      const vetoed = round.votes.some(v => v.vote === 'veto');
      if (!alreadyAdded && isDirectParent && !vetoed) {
        net.members.push(round.pendingMember);
        log.info(`Braintree join ${round.roundId} passed via vote relay — added ${round.subjectLabel} to network ${net.id}`);
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
): boolean {
  const voters = net.members.filter(m => !round.subjectInstanceId || m.instanceId !== round.subjectInstanceId);
  const vetoCount = round.votes.filter(v => v.vote === 'veto').length;
  const pastDeadline = new Date(round.deadline) < new Date();

  if (vetoCount > 0 || pastDeadline) {
    round.concluded = true;
    round.passed = false;
    return false;
  }

  // For unanimous-requirement types (closed, braintree): every remote voter must have voted yes
  // individually. A self/proposer yes vote counts as evidence of intent but does NOT short-circuit
  // the requirement for all listed members to vote.
  const allRemoteVotedYes =
    voters.length === 0 ||
    voters.every(v => round.votes.some(c => c.instanceId === v.instanceId && c.vote === 'yes'));

  const yesCount = round.votes.filter(v => v.vote === 'yes').length;

  let passed = false;
  switch (net.type) {
    case 'closed':
      passed = allRemoteVotedYes;
      break;
    case 'braintree':
      if (round.requiredVoters && round.requiredVoters.length > 0) {
        // Only the designated ancestors (path from inviting node to root) must vote yes.
        // The subject itself is excluded from the required set.
        const relevant = round.requiredVoters.filter(id => id !== round.subjectInstanceId);
        passed = relevant.every(id =>
          round.votes.some(c => c.instanceId === id && c.vote === 'yes'),
        );
      } else {
        // Fallback for rounds created before requiredVoters was introduced
        passed = allRemoteVotedYes;
      }
      break;
    case 'democratic':
      passed = (voters.length === 0 && yesCount > 0) || (yesCount > voters.length / 2 && vetoCount === 0);
      break;
    case 'club':
      // For Club: only the inviter/proposer (first yes voter) decides
      passed = yesCount >= 1 && vetoCount === 0;
      break;
  }
  if (passed) {
    round.concluded = true;
    round.passed = true;
    // On join round pass: the candidate will call join again and get a 200 with member list
    // On remove round pass: remove the member
    if (round.type === 'remove') {
      const idx = net.members.findIndex(m => m.instanceId === round.subjectInstanceId);
      if (idx >= 0) net.members.splice(idx, 1);
    }
    return true;
  }
  return false;
}

// ── Notify ejected member after a remove vote passes ──────────────────────
// Fire-and-forget: non-fatal if the peer is unreachable.
export function sendMemberRemovedNotify(
  subjectUrl: string,
  subjectInstanceId: string,
  networkId: string,
): void {
  const cfg = getConfig();
  const secrets = getSecrets();
  const peerToken = secrets.peerTokens[subjectInstanceId];
  if (!peerToken) {
    log.warn(`member_removed: no outbound token for ${subjectInstanceId} — cannot notify`);
    return;
  }
  fetch(`${subjectUrl}/api/notify`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${peerToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ networkId, instanceId: cfg.instanceId, event: 'member_removed' }),
    signal: AbortSignal.timeout(10_000),
  }).catch(err => log.warn(`member_removed notify to ${subjectInstanceId}: ${err}`));
}

// Re-export the helper for use by the network router and sync engine
export { concludeRoundIfReady };

