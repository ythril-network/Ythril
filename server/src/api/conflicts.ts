import { spacesWhereTokenMay } from '../auth/reachable-spaces.js';
import { findWhereTokenMay } from '../auth/find-where-token-may.js';
import { Router } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { requireAuth, requireAdmin, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { log, peerText } from '../util/log.js';
import { caughtFailureText } from '../brain/store-failure.js';
import { resolveSafePath, spaceRoot } from '../files/sandbox.js';
import { deleteStored, moveStored } from '../files/stored-bytes.js';
import type { ConflictDoc, LinkViolationDoc } from '../config/types.js';
import { spaceCollection } from '../db/space-collection.js';

export const conflictsRouter = Router();

const VALID_ACTIONS = ['keep-local', 'keep-incoming', 'keep-both', 'save-to-space'] as const;
type ResolveAction = typeof VALID_ACTIONS[number];

/*
 * These routes take no space in the path: they walk every space the token can reach, so the space list each one
 * walks IS its enforcement point (`auth/reachable-spaces.ts`). Every walk names its area and rung at the call —
 * `spacesWhereTokenMay` for a list, `findWhereTokenMay` for a record by id — and neither has a default (`Q-304`).
 */

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
        await deleteStored(abs);
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
      // A move, under both paths' locks: the stored bytes (ciphertext or not) are valid wherever they land (F-43).
      await moveStored(srcAbs, dstAbs);
      break;
    }
    case 'keep-both': {
      // Keep both files. If rename is provided, rename the conflict copy.
      if (rename) {
        const srcAbs = resolveSafePath(spaceId, doc.conflictPath);
        const dstAbs = resolveSafePath(spaceId, rename);
        await fs.mkdir(path.dirname(dstAbs), { recursive: true });
        await moveStored(srcAbs, dstAbs);
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
      await moveStored(srcAbs, dstAbs);
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
    // `?spaceId=` narrows to one space, as 10-mfa-and-conflicts.md has always said; it was read nowhere, so a
    // caller asking about one space got every space's conflicts and read them as that space's.
    const requested = typeof req.query['spaceId'] === 'string' ? req.query['spaceId'] : undefined;
    const reachable = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'read');
    if (requested && !reachable.includes(requested)) { res.status(403).json({ error: `Token does not have access to space '${requested}'` }); return; }
    const spaces = requested ? [requested] : reachable;
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
    log.error(`GET /api/conflicts: ${peerText(err)}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// LINK VIOLATIONS — sync-ingested documents that violate strict linkage
// ═══════════════════════════════════════════════════════════════════════════

// GET /api/conflicts/link-violations — list all link violations
conflictsRouter.get('/link-violations', globalRateLimit, requireAuth, async (_req, res) => {
  try {
    const spaces = spacesWhereTokenMay(_req.authToken?.rights, 'dataQuality', 'read');
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
    log.error(`GET /api/conflicts/link-violations: ${peerText(err)}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/conflicts/link-violations/:id — dismiss a single link violation
conflictsRouter.delete('/link-violations/:id', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write');
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
    log.error(`DELETE /api/conflicts/link-violations/:id: ${peerText(err)}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// DELETE /api/conflicts/link-violations — dismiss all link violations for accessible spaces
conflictsRouter.delete('/link-violations', globalRateLimit, requireAuth, denyReadOnly, async (_req, res) => {
  try {
    const spaces = spacesWhereTokenMay(_req.authToken?.rights, 'dataQuality', 'write');
    let total = 0;
    for (const spaceId of spaces) {
      const result = await col<LinkViolationDoc>(spaceCollection(spaceId, 'linkViolations')).deleteMany({});
      total += result.deletedCount;
    }
    res.json({ dismissed: total });
  } catch (err) {
    log.error(`DELETE /api/conflicts/link-violations: ${peerText(err)}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// GET /api/conflicts/:id — get a single conflict record
conflictsRouter.get('/:id', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const found = await findWhereTokenMay<ConflictDoc>(req.authToken?.rights, 'dataQuality', 'read', 'conflicts', req.params['id'] as string);
    if (found) {
      const { doc } = found;
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
    res.status(404).json({ error: 'Conflict not found' });
  } catch (err) {
    log.error(`GET /api/conflicts/:id: ${peerText(err)}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

// There is no DELETE /api/conflicts/:id. It closed the record and left the incoming copy in the space under its
// conflict name, where it replicated to every member — a keep-both without the rename (removed 2026-09-27). A
// conflict closes only through a resolution.

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
    const spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write');
    if (action === 'save-to-space' && !spaces.includes(targetSpaceId)) {
      res.status(403).json({ error: 'Token does not have access to target space' });
      return;
    }

    let resolved = 0;
    const failed: { id: string; error: string }[] = [];

    for (const id of ids) {
      try {
        const found = await findWhereTokenMay<ConflictDoc>(req.authToken?.rights, 'dataQuality', 'write', 'conflicts', id);
        if (!found) {
          failed.push({ id, error: 'Conflict not found' });
          continue;
        }
        await executeResolve(found.doc, found.spaceId, action, rename, targetSpaceId);
        resolved++;
      } catch (err: unknown) {
        failed.push({ id, error: caughtFailureText(err, 'resolve a conflict') });
      }
    }

    res.json({ resolved, failed });
  } catch (err) {
    log.error(`POST /api/conflicts/bulk-resolve: ${peerText(err)}`);
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
    const spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write');
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
    log.error(`POST /api/conflicts/seed: ${peerText(err)}`);
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

    const spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write');

    // Validate target space access for save-to-space
    if (action === 'save-to-space' && !spaces.includes(targetSpaceId)) {
      res.status(403).json({ error: 'Token does not have access to target space' });
      return;
    }

    const found = await findWhereTokenMay<ConflictDoc>(req.authToken?.rights, 'dataQuality', 'write', 'conflicts', req.params['id'] as string);
    if (!found) {
      res.status(404).json({ error: 'Conflict not found' });
      return;
    }

    await executeResolve(found.doc, found.spaceId, action, rename, targetSpaceId);
    res.status(200).json({ status: 'resolved' });
  } catch (err) {
    log.error(`POST /api/conflicts/:id/resolve: ${peerText(err)}`);
    res.status(500).json({ error: 'Internal error' });
  }
});

