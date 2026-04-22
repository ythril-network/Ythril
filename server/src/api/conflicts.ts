import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { requireAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, mFilter, mDoc } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { resolveSafePath, spaceRoot } from '../files/sandbox.js';
import type { ConflictDoc, LinkViolationDoc } from '../config/types.js';

export const conflictsRouter = Router();

const VALID_ACTIONS = ['keep-local', 'keep-incoming', 'keep-both', 'save-to-space'] as const;
type ResolveAction = typeof VALID_ACTIONS[number];

/** Return the space IDs the authenticated token is allowed to access. */
function accessibleSpaces(tokenSpaces?: string[]): string[] {
  const cfg = getConfig();
  const all = cfg.spaces.map(s => s.id);
  if (!tokenSpaces || tokenSpaces.length === 0) return all;
  return all.filter(id => tokenSpaces.includes(id));
}

/** Find a conflict document across accessible spaces. Returns doc + spaceId, or null. */
async function findConflict(
  conflictId: string,
  spaces: string[],
): Promise<{ doc: ConflictDoc; spaceId: string } | null> {
  for (const spaceId of spaces) {
    const doc = await col<ConflictDoc>(`${spaceId}_conflicts`)
      .findOne(mFilter<ConflictDoc>({ _id: conflictId })) as ConflictDoc | null;
    if (doc) return { doc, spaceId };
  }
  return null;
}

/** Perform the file operations for a given resolve action, then delete the conflict record. */
async function executeResolve(
  doc: ConflictDoc,
  spaceId: string,
  action: ResolveAction,
  rename?: string,
  targetSpaceId?: string,
): Promise<void> {
  switch (action) {
    case 'keep-local': {
      // Delete the conflict copy, keep the original
      try {
        const abs = resolveSafePath(spaceId, doc.conflictPath);
        await fs.unlink(abs);
      } catch (err: unknown) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err; // already gone is fine
      }
      break;
    }
    case 'keep-incoming': {
      // Replace the original with the conflict copy, then delete the conflict copy
      const srcAbs = resolveSafePath(spaceId, doc.conflictPath);
      const dstAbs = resolveSafePath(spaceId, doc.originalPath);
      await fs.mkdir(path.dirname(dstAbs), { recursive: true });
      await fs.copyFile(srcAbs, dstAbs);
      await fs.unlink(srcAbs);
      break;
    }
    case 'keep-both': {
      // Keep both files. If rename is provided, rename the conflict copy.
      if (rename) {
        const srcAbs = resolveSafePath(spaceId, doc.conflictPath);
        const dstAbs = resolveSafePath(spaceId, rename);
        await fs.mkdir(path.dirname(dstAbs), { recursive: true });
        await fs.rename(srcAbs, dstAbs);
      }
      // Without rename, both files stay as-is — nothing to do.
      break;
    }
    case 'save-to-space': {
      // Copy conflict file to target space, then delete from source space
      const srcAbs = resolveSafePath(spaceId, doc.conflictPath);
      const destPath = rename || doc.conflictPath;
      const dstRoot = spaceRoot(targetSpaceId!);
      await fs.mkdir(dstRoot, { recursive: true });
      const dstAbs = resolveSafePath(targetSpaceId!, destPath);
      await fs.mkdir(path.dirname(dstAbs), { recursive: true });
      await fs.copyFile(srcAbs, dstAbs);
      await fs.unlink(srcAbs);
      break;
    }
  }

  // Remove the conflict record
  await col<ConflictDoc>(`${spaceId}_conflicts`)
    .deleteOne(mFilter<ConflictDoc>({ _id: doc._id }));
}

// GET /api/conflicts — list unresolved conflicts for all accessible spaces
conflictsRouter.get('/', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    const results: ConflictDoc[] = [];
    for (const spaceId of spaces) {
      const docs = await col<ConflictDoc>(`${spaceId}_conflicts`)
        .find({})
        .sort({ detectedAt: -1 })
        .limit(500)
        .toArray() as ConflictDoc[];
      results.push(...docs);
    }
    results.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    res.json({
      conflicts: results.map(c => ({
        id: c._id,
        spaceId: c.spaceId,
        originalPath: c.originalPath,
        conflictPath: c.conflictPath,
        peerInstanceId: c.peerInstanceId,
        peerInstanceLabel: c.peerInstanceLabel,
        detectedAt: c.detectedAt,
      })),
    });
  } catch (err) {
    log.error(`GET /api/conflicts: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LINK VIOLATIONS — sync-ingested documents that violate strict linkage
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/conflicts/link-violations — list all link violations
conflictsRouter.get('/link-violations', globalRateLimit, requireAuth, async (_req, res) => {
  try {
    const spaces = accessibleSpaces(_req.authToken?.spaces);
    const results: LinkViolationDoc[] = [];
    for (const spaceId of spaces) {
      const docs = await col<LinkViolationDoc>(`${spaceId}_link_violations`)
        .find({})
        .sort({ detectedAt: -1 })
        .limit(500)
        .toArray() as LinkViolationDoc[];
      results.push(...docs);
    }
    results.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    res.json({ violations: results });
  } catch (err) {
    log.error(`GET /api/conflicts/link-violations: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/conflicts/link-violations/:id — dismiss a single link violation
conflictsRouter.delete('/link-violations/:id', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    for (const spaceId of spaces) {
      const result = await col<LinkViolationDoc>(`${spaceId}_link_violations`)
        .deleteOne(mFilter<LinkViolationDoc>({ _id: req.params['id'] }));
      if (result.deletedCount > 0) {
        res.status(204).end();
        return;
      }
    }
    res.status(404).json({ error: 'Link violation not found' });
  } catch (err) {
    log.error(`DELETE /api/conflicts/link-violations/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/conflicts/link-violations — dismiss all link violations for accessible spaces
conflictsRouter.delete('/link-violations', globalRateLimit, requireAuth, async (_req, res) => {
  try {
    const spaces = accessibleSpaces(_req.authToken?.spaces);
    let total = 0;
    for (const spaceId of spaces) {
      const result = await col<LinkViolationDoc>(`${spaceId}_link_violations`).deleteMany({});
      total += result.deletedCount;
    }
    res.json({ dismissed: total });
  } catch (err) {
    log.error(`DELETE /api/conflicts/link-violations: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/conflicts/:id — get a single conflict record
conflictsRouter.get('/:id', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    for (const spaceId of spaces) {
      const doc = await col<ConflictDoc>(`${spaceId}_conflicts`)
        .findOne(mFilter<ConflictDoc>({ _id: req.params['id'] })) as ConflictDoc | null;
      if (doc) {
        res.json({
          id: doc._id,
          spaceId: doc.spaceId,
          originalPath: doc.originalPath,
          conflictPath: doc.conflictPath,
          peerInstanceId: doc.peerInstanceId,
          peerInstanceLabel: doc.peerInstanceLabel,
          detectedAt: doc.detectedAt,
        });
        return;
      }
    }
    res.status(404).json({ error: 'Conflict not found' });
  } catch (err) {
    log.error(`GET /api/conflicts/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/conflicts/:id — dismiss (resolve) a conflict record
conflictsRouter.delete('/:id', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req.authToken?.spaces);
    for (const spaceId of spaces) {
      const result = await col<ConflictDoc>(`${spaceId}_conflicts`)
        .deleteOne(mFilter<ConflictDoc>({ _id: req.params['id'] }));
      if (result.deletedCount > 0) {
        res.status(204).end();
        return;
      }
    }
    res.status(404).json({ error: 'Conflict not found' });
  } catch (err) {
    log.error(`DELETE /api/conflicts/:id: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/conflicts/bulk-resolve — resolve multiple conflicts at once
conflictsRouter.post('/bulk-resolve', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const { ids, action, rename, targetSpaceId } = req.body ?? {};
    if (!Array.isArray(ids) || ids.length === 0) {
      res.status(400).json({ error: 'ids must be a non-empty array' });
      return;
    }
    if (!action || !VALID_ACTIONS.includes(action)) {
      res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
      return;
    }
    if (action === 'save-to-space' && !targetSpaceId) {
      res.status(400).json({ error: 'targetSpaceId is required for save-to-space action' });
      return;
    }
    const spaces = accessibleSpaces(req.authToken?.spaces);
    if (action === 'save-to-space' && !spaces.includes(targetSpaceId)) {
      res.status(403).json({ error: 'Token does not have access to target space' });
      return;
    }

    let resolved = 0;
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const found = await findConflict(id, spaces);
        if (!found) {
          failed.push({ id, error: 'Conflict not found' });
          continue;
        }
        await executeResolve(found.doc, found.spaceId, action, rename, targetSpaceId);
        resolved++;
      } catch (err: unknown) {
        failed.push({ id, error: err instanceof Error ? err.message : 'Unknown error' });
      }
    }

    res.json({ resolved, failed });
  } catch (err) {
    log.error(`POST /api/conflicts/bulk-resolve: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/conflicts/seed — seed a conflict record (for testing)
conflictsRouter.post('/seed', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const { _id, spaceId, originalPath, conflictPath, peerInstanceId, peerInstanceLabel, detectedAt } = req.body ?? {};
    if (!_id || !spaceId || !originalPath || !conflictPath) {
      res.status(400).json({ error: 'Missing required fields: _id, spaceId, originalPath, conflictPath' });
      return;
    }
    const spaces = accessibleSpaces(req.authToken?.spaces);
    if (!spaces.includes(spaceId)) {
      res.status(403).json({ error: 'Token does not have access to this space' });
      return;
    }
    const doc: ConflictDoc = {
      _id,
      spaceId,
      originalPath,
      conflictPath,
      peerInstanceId: peerInstanceId || 'unknown',
      peerInstanceLabel: peerInstanceLabel || 'Unknown',
      detectedAt: detectedAt || new Date().toISOString(),
    };
    await col<ConflictDoc>(`${spaceId}_conflicts`).insertOne(mDoc<ConflictDoc>(doc));
    res.status(201).json({ id: _id });
  } catch (err) {
    log.error(`POST /api/conflicts/seed: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/conflicts/:id/resolve — resolve a single conflict with an action
conflictsRouter.post('/:id/resolve', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const { action, rename, targetSpaceId } = req.body ?? {};

    // Validate action
    if (!action || !VALID_ACTIONS.includes(action)) {
      res.status(400).json({ error: `action must be one of: ${VALID_ACTIONS.join(', ')}` });
      return;
    }
    if (action === 'save-to-space' && !targetSpaceId) {
      res.status(400).json({ error: 'targetSpaceId is required for save-to-space action' });
      return;
    }

    const spaces = accessibleSpaces(req.authToken?.spaces);

    // Validate target space access for save-to-space
    if (action === 'save-to-space' && !spaces.includes(targetSpaceId)) {
      res.status(403).json({ error: 'Token does not have access to target space' });
      return;
    }

    const found = await findConflict(req.params['id'] as string, spaces);
    if (!found) {
      res.status(404).json({ error: 'Conflict not found' });
      return;
    }

    await executeResolve(found.doc, found.spaceId, action, rename, targetSpaceId);
    res.status(200).json({ status: 'resolved' });
  } catch (err) {
    log.error(`POST /api/conflicts/:id/resolve: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

