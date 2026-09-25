import { spacesWhereTokenMay } from '../auth/reachable-spaces.js';
import type { TokenRights, Rung } from '../config/rights-shape.js';
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { requireAuth, requireAdmin, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { log } from '../util/log.js';
import { resolveSafePath, spaceRoot } from '../files/sandbox.js';
import type { ConflictDoc, LinkViolationDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

export const conflictsRouter = Router();

const VALID_ACTIONS = ['keep-local', 'keep-incoming', 'keep-both', 'save-to-space'] as const;
type ResolveAction = typeof VALID_ACTIONS[number];

/** Return the space IDs the authenticated token is allowed to access. */
/**
 * The space IDs this token may act on at the given Data-quality level.
 *
 * These routes take no space in the path — they walk every space the token can reach — so this list IS the
 * enforcement point. It also removes the copy of a conflation that lived here: `tokenSpaces.length === 0`
 * used to mean "unrestricted". An ABSENT allowlist means every space; an EMPTY one means none. Anything
 * holding `spaces: []` was handed the whole instance.
 */
function accessibleSpaces(req: { authToken?: unknown }, needs: Rung = 'read'): string[] {
  const t = req.authToken as { rights?: TokenRights; spaces?: string[] } | undefined;
  return spacesWhereTokenMay(t?.rights, 'dataQuality', needs);
}

/** Find a conflict document across accessible spaces. Returns doc + spaceId, or null. */
async function findConflict(
  conflictId: string,
  spaces: string[],
): Promise<{ doc: ConflictDoc; spaceId: string } | null> {
  for (const spaceId of spaces) {
    const doc = await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts'))
      .findOne(asFilter<ConflictDoc>({ _id: conflictId })) as ConflictDoc | null;
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
  await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts'))
    .deleteOne(asFilter<ConflictDoc>({ _id: doc._id }));
}

// Bounds for the cross-space list endpoints below. Without these the fan-in was up to 500·N docs
// materialised in memory for an N-space token, and the client got a silently-capped array with no way
// to tell it was incomplete. We cap per space (fetch cap+1 to DETECT overflow) and bound the total,
// and always report `truncated` + `returned` so the caller knows whether it saw everything.
const PER_SPACE_CAP = 500;
const MAX_TOTAL = 2000;

// GET /api/conflicts — list unresolved conflicts for all accessible spaces
conflictsRouter.get('/', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req, 'read');
    const results: ConflictDoc[] = [];
    let truncated = false;
    for (const spaceId of spaces) {
      const docs = await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts'))
        .find({})
        .sort({ detectedAt: -1 })
        .limit(PER_SPACE_CAP + 1)
        .toArray() as ConflictDoc[];
      if (docs.length > PER_SPACE_CAP) { truncated = true; docs.length = PER_SPACE_CAP; }
      results.push(...docs);
      if (results.length >= MAX_TOTAL) { truncated = true; break; } // bound cross-space fact
    }
    results.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    if (results.length > MAX_TOTAL) { results.length = MAX_TOTAL; truncated = true; }
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
      returned: results.length,
      truncated,
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
    const spaces = accessibleSpaces(_req, 'read');
    const results: LinkViolationDoc[] = [];
    let truncated = false;
    for (const spaceId of spaces) {
      const docs = await col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations'))
        .find({})
        .sort({ detectedAt: -1 })
        .limit(PER_SPACE_CAP + 1)
        .toArray() as LinkViolationDoc[];
      if (docs.length > PER_SPACE_CAP) { truncated = true; docs.length = PER_SPACE_CAP; }
      results.push(...docs);
      if (results.length >= MAX_TOTAL) { truncated = true; break; }
    }
    results.sort((a, b) => b.detectedAt.localeCompare(a.detectedAt));
    if (results.length > MAX_TOTAL) { results.length = MAX_TOTAL; truncated = true; }
    res.json({ violations: results, returned: results.length, truncated });
  } catch (err) {
    log.error(`GET /api/conflicts/link-violations: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/conflicts/link-violations/:id — dismiss a single link violation
conflictsRouter.delete('/link-violations/:id', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req, 'write');
    for (const spaceId of spaces) {
      const result = await col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations'))
        .deleteOne(asFilter<LinkViolationDoc>({ _id: req.params['id'] }));
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
conflictsRouter.delete('/link-violations', globalRateLimit, requireAuth, denyReadOnly, async (_req, res) => {
  try {
    const spaces = accessibleSpaces(_req, 'write');
    let total = 0;
    for (const spaceId of spaces) {
      const result = await col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations')).deleteMany({});
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
    const spaces = accessibleSpaces(req, 'read');
    for (const spaceId of spaces) {
      const doc = await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts'))
        .findOne(asFilter<ConflictDoc>({ _id: req.params['id'] })) as ConflictDoc | null;
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
conflictsRouter.delete('/:id', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const spaces = accessibleSpaces(req, 'write');
    for (const spaceId of spaces) {
      const result = await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts'))
        .deleteOne(asFilter<ConflictDoc>({ _id: req.params['id'] }));
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
conflictsRouter.post('/bulk-resolve', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
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
    const spaces = accessibleSpaces(req, 'write');
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

// POST /api/conflicts/seed — seed a conflict record (test support)
//
// This fabricates a conflict record that the UI presents as a genuine sync
// conflict with a named peer, and whose resolution actions move/overwrite files.
// It is a test fixture, not a product feature, so it is admin-gated: any
// space-scoped token could previously inject conflicts (with an attacker-chosen
// `peerInstanceLabel`) into any space it could read.
conflictsRouter.post('/seed', globalRateLimit, requireAdmin, denyReadOnly, async (req, res) => {
  try {
    const { _id, spaceId, originalPath, conflictPath, peerInstanceId, peerInstanceLabel, detectedAt } = req.body ?? {};
    if (!_id || !spaceId || !originalPath || !conflictPath) {
      res.status(400).json({ error: 'Missing required fields: _id, spaceId, originalPath, conflictPath' });
      return;
    }
    const spaces = accessibleSpaces(req, 'write');
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
    await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts')).insertOne(asDoc<ConflictDoc>(doc));
    res.status(201).json({ id: _id });
  } catch (err) {
    log.error(`POST /api/conflicts/seed: ${err}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// POST /api/conflicts/:id/resolve — resolve a single conflict with an action
conflictsRouter.post('/:id/resolve', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
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

    const spaces = accessibleSpaces(req, 'write');

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

