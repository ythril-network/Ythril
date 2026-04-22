import { Router } from 'express';
import path from 'path';
import { requireAuth, requireAdmin, requireAdminMfa } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig, saveConfig, getSecrets, getDataRoot } from '../config/loader.js';
import { createSpace, updateSpace, removeSpace, renameSpace, slugify } from '../spaces/spaces.js';
import { measureUsage, dirSizeBytes } from '../quota/quota.js';
import { col } from '../db/mongo.js';
import { resolveMemberSpaces } from '../spaces/proxy.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { log } from '../util/log.js';
import type { SpaceMeta } from '../config/types.js';

export const spacesRouter = Router();

// ── Zod schema for PropertySchema ──────────────────────────────────────────
const PropertySchemaZ = z.object({
  type: z.enum(['string', 'number', 'boolean', 'date']).optional(),
  enum: z.array(z.union([z.string(), z.number(), z.boolean()])).optional(),
  minimum: z.number().optional(),
  maximum: z.number().optional(),
  pattern: z.string().max(500).optional(),
  mergeFn: z.enum(['avg', 'min', 'max', 'sum', 'and', 'or', 'xor']).optional(),
  required: z.boolean().optional(),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
}).strict().refine(data => {
  if (!data.mergeFn) return true;
  const numericFns = new Set(['avg', 'min', 'max', 'sum']);
  const booleanFns = new Set(['and', 'or', 'xor']);
  if (data.type === 'number') return numericFns.has(data.mergeFn);
  if (data.type === 'boolean') return booleanFns.has(data.mergeFn);
  // mergeFn requires a compatible type declaration
  if (data.type === 'string' || data.type === 'date') return false;
  // No type declared but mergeFn given — allow if the fn could be valid for some type
  return numericFns.has(data.mergeFn) || booleanFns.has(data.mergeFn);
}, {
  message: 'mergeFn is incompatible with the declared type (numeric fns require type "number", boolean fns require type "boolean")',
});

const TypeSchemaZ = z.object({
  namingPattern: z.string().max(500).optional(),
  tagSuggestions: z.array(z.string().min(1).max(200)).max(200).optional(),
  propertySchemas: z.record(z.string().min(1).max(200), PropertySchemaZ).optional(),
}).strict();

const TypeSchemasZ = z.object({
  entity: z.record(z.string().min(1).max(200), TypeSchemaZ).optional(),
  memory: z.record(z.string().min(1).max(200), TypeSchemaZ).optional(),
  edge:   z.record(z.string().min(1).max(200), TypeSchemaZ).optional(),
  chrono: z.record(z.string().min(1).max(200), TypeSchemaZ).optional(),
}).strict();

const SpaceMetaBody = z.object({
  purpose: z.string().max(4000).optional(),
  usageNotes: z.string().max(50_000).optional(),
  validationMode: z.enum(['off', 'warn', 'strict']).optional(),
  typeSchemas: TypeSchemasZ.optional(),
  tagSuggestions: z.array(z.string().min(1).max(200)).max(200).optional(),
  strictLinkage: z.boolean().optional(),
}).strict();

// proxyFor accepts either the wildcard sentinel ['*'] or a list of specific space IDs
const ProxyForZ = z.union([
  z.tuple([z.literal('*')]),
  z.array(z.string().min(1).max(40)).min(1),
]);

const CreateSpaceBody = z.object({
  id: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/).optional(),
  label: z.string().min(1).max(200),
  description: z.string().max(4000).optional(),
  folders: z.array(z.string()).optional(),
  maxGiB: z.number().positive().optional(),
  proxyFor: ProxyForZ.optional(),
  meta: SpaceMetaBody.optional(),
});

const DeleteSpaceBody = z.object({
  confirm: z.literal(true),
});

const RenameSpaceBody = z.object({
  newId: z.string().min(1).max(40).regex(/^[a-z0-9-]+$/),
});

const UpdateSpaceBody = z.object({
  label: z.string().min(1).max(200).optional(),
  description: z.string().max(4000).optional(),
  maxGiB: z.number().positive().nullable().optional(),
  meta: SpaceMetaBody.optional(),
}).refine(d => d.label !== undefined || d.description !== undefined || d.meta !== undefined || d.maxGiB !== undefined, {
  message: 'At least one of label, description, maxGiB, or meta must be provided',
});

// PATCH /api/spaces/:id/rename
spacesRouter.patch('/:id/rename', globalRateLimit, requireAdminMfa, async (req, res) => {
  const oldId = req.params['id'] as string;
  const parsed = RenameSpaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  try {
    const space = await renameSpace(oldId, parsed.data.newId);
    res.json({ space });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      res.status(404).json({ error: msg });
    } else if (msg.includes('already exists')) {
      res.status(409).json({ error: msg });
    } else if (msg.includes('built-in')) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// GET /api/spaces
spacesRouter.get('/', globalRateLimit, requireAuth, async (_req, res) => {
  const cfg = getConfig();
  const dataRoot = getDataRoot();
  const GiB = 1024 ** 3;

  // Measure per-space file usage in parallel (non-blocking; falls back to 0 on error)
  const usageResults = await Promise.allSettled(
    cfg.spaces.map(s => dirSizeBytes(path.join(dataRoot, 'files', s.id))),
  );
  const usageGiBByIdx = usageResults.map(r => r.status === 'fulfilled' ? r.value / GiB : 0);

  const spaces = cfg.spaces.map(({ id, label, builtIn, folders, maxGiB, flex, description, proxyFor, meta }, idx) => ({
    id, label, builtIn, folders, maxGiB, flex, description,
    usageGiB: usageGiBByIdx[idx],
    ...(proxyFor ? { proxyFor } : {}),
    ...(meta ? { meta: { ...meta, previousVersions: undefined } } : {}),
  }));
  // Include storage usage summary when quota is configured
  let storage: { usageGiB?: { files: number; brain: number; total: number }; limits?: typeof cfg.storage } | undefined;
  if (cfg.storage) {
    try {
      const usage = await measureUsage();
      storage = { usageGiB: usage, limits: cfg.storage };
    } catch {
      // Non-fatal: storage summary omitted on measurement error
    }
  }
  res.json({ spaces, ...(storage ? { storage } : {}) });
});

// POST /api/spaces
spacesRouter.post('/', globalRateLimit, requireAdminMfa, async (req, res) => {
  const parsed = CreateSpaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const { id: rawId, label, description, folders, maxGiB, proxyFor, meta } = parsed.data;
  const id = rawId ?? slugify(label);

  // Validate proxy members exist and are not themselves proxies
  // '*' is the wildcard sentinel — skip per-member validation
  if (proxyFor && !(proxyFor.length === 1 && proxyFor[0] === '*')) {
    const cfg = getConfig();
    for (const memberId of proxyFor) {
      const member = cfg.spaces.find(s => s.id === memberId);
      if (!member) {
        res.status(400).json({ error: `Proxy member space '${memberId}' not found` });
        return;
      }
      if (member.proxyFor) {
        res.status(400).json({ error: `Proxy member '${memberId}' is itself a proxy space (nesting not allowed)` });
        return;
      }
    }
  }

  try {
    const space = await createSpace({ id, label, description, folders, maxGiB, proxyFor, meta: meta as SpaceMeta | undefined });
    res.status(201).json({ space });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('already exists')) {
      res.status(409).json({ error: msg });
    } else {
      res.status(500).json({ error: 'Failed to create space' });
    }
  }
});

// PATCH /api/spaces/:id
spacesRouter.patch('/:id', globalRateLimit, requireAdminMfa, async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();

  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  const parsed = UpdateSpaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // ── Network voting for meta changes ──────────────────────────────────────
  // If this space is part of a network and a meta change is requested,
  // open a meta_change vote round instead of applying immediately.
  if (parsed.data.meta !== undefined) {
    const networkedIn = cfg.networks.filter(n => n.spaces.includes(id));
    if (networkedIn.length > 0) {
      const now = new Date().toISOString();
      const rounds: { networkId: string; networkLabel: string; roundId: string }[] = [];

      for (const net of networkedIn) {
        const roundId = uuidv4();
        const deadline = new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString();
        net.pendingRounds.push({
          roundId,
          type: 'meta_change',
          subjectInstanceId: cfg.instanceId,
          subjectLabel: cfg.instanceLabel,
          subjectUrl: '',
          deadline,
          openedAt: now,
          votes: [{ instanceId: cfg.instanceId, vote: 'yes', castAt: now }],
          spaceId: id,
          pendingMeta: parsed.data.meta as SpaceMeta,
        });
        rounds.push({ networkId: net.id, networkLabel: net.label, roundId });
      }

      // Apply non-meta updates immediately (label, description, maxGiB)
      const nonMetaUpdates: { label?: string; description?: string; maxGiB?: number | null } = {};
      if (parsed.data.label !== undefined) nonMetaUpdates.label = parsed.data.label;
      if (parsed.data.description !== undefined) nonMetaUpdates.description = parsed.data.description;
      if (parsed.data.maxGiB !== undefined) nonMetaUpdates.maxGiB = parsed.data.maxGiB;
      if (Object.keys(nonMetaUpdates).length > 0) {
        updateSpace(id, nonMetaUpdates);
      } else {
        saveConfig(cfg);
      }

      // Notify peers (best-effort)
      const secrets = getSecrets();
      for (const net of networkedIn) {
        for (const member of net.members) {
          const peerToken = secrets.peerTokens[member.instanceId];
          if (!peerToken) continue;
          fetch(`${member.url}/api/notify`, {
            method: 'POST',
            headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
            body: JSON.stringify({
              networkId: net.id,
              instanceId: cfg.instanceId,
              event: 'meta_change_pending',
              data: { spaceId: id, spaceLabel: space.label },
            }),
            signal: AbortSignal.timeout(5_000),
          }).catch(err => log.warn(`notify ${member.label} of meta_change_pending: ${err}`));
        }
      }

      res.status(202).json({ status: 'vote_pending', rounds, message: 'Meta change requires network vote' });
      return;
    }
  }

  const updated = updateSpace(id, parsed.data);
  if (!updated) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }
  res.json({ space: updated });
});

// GET /api/spaces/:id/meta — read the meta block with derived stats
spacesRouter.get('/:id/meta', globalRateLimit, requireAuth, async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  const meta = space.meta ?? {};
  const memberIds = resolveMemberSpaces(id);
  const counts = await Promise.all(memberIds.map(async mid => ({
    memories: await col(`${mid}_memories`).countDocuments(),
    entities: await col(`${mid}_entities`).countDocuments(),
    edges: await col(`${mid}_edges`).countDocuments(),
    chrono: await col(`${mid}_chrono`).countDocuments(),
    files: await col(`${mid}_files`).countDocuments(),
  })));

  const stats = {
    memories: counts.reduce((s, c) => s + c.memories, 0),
    entities: counts.reduce((s, c) => s + c.entities, 0),
    edges: counts.reduce((s, c) => s + c.edges, 0),
    chrono: counts.reduce((s, c) => s + c.chrono, 0),
    files: counts.reduce((s, c) => s + c.files, 0),
  };

  // Strip previousVersions from public response (available via dedicated endpoint if needed)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { previousVersions: _pv, ...metaPublic } = meta;

  res.json({
    spaceId: id,
    spaceName: space.label,
    ...metaPublic,
    stats,
  });
});

// POST /api/spaces/:id/validate-schema — dry-run validation of existing data
spacesRouter.post('/:id/validate-schema', globalRateLimit, requireAdminMfa, async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // Use the provided meta for dry-run, or fall back to the space's current meta
  // Strip internal-only fields (version, updatedAt, previousVersions) before Zod validation
  const rawMeta = req.body?.meta ?? space.meta ?? {};
  const { version: _v, updatedAt: _u, previousVersions: _pv, ...metaForParse } = rawMeta;
  const parsedMeta = SpaceMetaBody.safeParse(metaForParse);
  if (!parsedMeta.success) {
    res.status(400).json({ error: parsedMeta.error.message });
    return;
  }
  const dryMeta = parsedMeta.data as SpaceMeta;

  // Import validation functions dynamically to avoid circular deps
  const { validateEntity, validateEdge, validateMemory, validateChrono } = await import('../spaces/schema-validation.js');

  const violations: Array<{ collection: string; _id: string; violations: Array<{ field: string; value: unknown; reason: string }> }> = [];
  const memberIds = resolveMemberSpaces(id);
  const SCAN_LIMIT = 10_000;

  for (const mid of memberIds) {
    // Entities
    const entities = await col(`${mid}_entities`).find({}).limit(SCAN_LIMIT).toArray();
    for (const ent of entities) {
      const doc = ent as unknown as { _id: string; name?: string; type?: string; properties?: Record<string, unknown> };
      const v = validateEntity(dryMeta, doc);
      if (v.length) violations.push({ collection: 'entities', _id: String(doc._id), violations: v });
    }

    // Edges
    const edges = await col(`${mid}_edges`).find({}).limit(SCAN_LIMIT).toArray();
    for (const edge of edges) {
      const doc = edge as unknown as { _id: string; label?: string; properties?: Record<string, unknown> };
      const v = validateEdge(dryMeta, doc);
      if (v.length) violations.push({ collection: 'edges', _id: String(doc._id), violations: v });
    }

    // Memories
    const memories = await col(`${mid}_memories`).find({}).limit(SCAN_LIMIT).toArray();
    for (const mem of memories) {
      const doc = mem as unknown as { _id: string; properties?: Record<string, unknown> };
      const v = validateMemory(dryMeta, doc);
      if (v.length) violations.push({ collection: 'memories', _id: String(doc._id), violations: v });
    }

    // Chrono
    const chronoEntries = await col(`${mid}_chrono`).find({}).limit(SCAN_LIMIT).toArray();
    for (const ch of chronoEntries) {
      const doc = ch as unknown as { _id: string; properties?: Record<string, unknown> };
      const v = validateChrono(dryMeta, doc);
      if (v.length) violations.push({ collection: 'chrono', _id: String(doc._id), violations: v });
    }
  }

  res.json({
    spaceId: id,
    meta: dryMeta,
    totalViolations: violations.length,
    violations: violations.slice(0, 500), // cap response size
  });
});

// DELETE /api/spaces/:id
//
// Solo space (not in any network): requires { "confirm": true } body to guard against accidents.
// Networked space: opens a space_deletion vote round on every network that includes this space,
// casts this instance's own yes vote immediately, notifies all peers, and returns 202.
// The space is only deleted once the vote passes on each network.
spacesRouter.delete('/:id', globalRateLimit, requireAdminMfa, async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();

  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  if (space.builtIn) {
    res.status(400).json({ error: `Space '${id}' is a built-in space and cannot be deleted` });
    return;
  }

  const networkedIn = cfg.networks.filter(n => n.spaces.includes(id));

  // ── Solo path ─────────────────────────────────────────────────────────────
  if (networkedIn.length === 0) {
    const body = DeleteSpaceBody.safeParse(req.body);
    if (!body.success || !body.data.confirm) {
      res.status(400).json({
        error: 'This space is not in any network. Send { "confirm": true } to delete it permanently.',
      });
      return;
    }
    const ok = await removeSpace(id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
      return null;
    });
    if (ok === null) return; // error already sent
    if (!ok) { res.status(404).json({ error: `Space '${id}' not found` }); return; }
    res.status(204).end();
    return;
  }

  // ── Networked path ────────────────────────────────────────────────────────
  // Open a space_deletion vote round on every network that contains this space.
  // This instance votes yes immediately; deletion happens once each round passes.
  const rounds: { networkId: string; networkLabel: string; roundId: string }[] = [];
  const now = new Date().toISOString();

  for (const net of networkedIn) {
    const roundId = uuidv4();
    const deadline = new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString();
    net.pendingRounds.push({
      roundId,
      type: 'space_deletion',
      subjectInstanceId: cfg.instanceId,
      subjectLabel: cfg.instanceLabel,
      subjectUrl: '',       // not meaningful for space deletion
      deadline,
      openedAt: now,
      votes: [{ instanceId: cfg.instanceId, vote: 'yes', castAt: now }],
      spaceId: id,
    });
    rounds.push({ networkId: net.id, networkLabel: net.label, roundId });
  }
  saveConfig(cfg);

  // Notify all peers (best-effort — failures are logged but don't abort the response)
  const secrets = getSecrets();
  for (const net of networkedIn) {
    for (const member of net.members) {
      const peerToken = secrets.peerTokens[member.instanceId];
      if (!peerToken) continue;
      fetch(`${member.url}/api/notify`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          networkId: net.id,
          instanceId: cfg.instanceId,
          event: 'space_deletion_pending',
          data: { spaceId: id, spaceLabel: space.label },
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(err => log.warn(`notify ${member.label} of space_deletion_pending: ${err}`));
    }
  }

  res.status(202).json({ status: 'vote_pending', rounds });
});
