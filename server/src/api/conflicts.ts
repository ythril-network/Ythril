import { spacesWhereTokenMay, holdsRungOnEvery } from '../auth/reachable-spaces.js';
import { findWhereTokenMay } from '../auth/find-where-token-may.js';
import { Router } from 'express';
import path from 'path';
import { requireAuth, requireAdmin, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { col, asFilter, asDoc } from '../db/mongo.js';
import { fileKeyOf, resolveSafePathChecked } from '../files/sandbox.js';
import { deleteStoredIfPresent, lstatIfPresent, moveStored } from '../files/stored-bytes.js';
import { placeIfFree } from '../files/files.js';
import { assertDestinationReachable, assertNothingStandsAt, fsRefusalOf } from '../files/destination.js';
import { FileSystemFault, fileActAnswer } from '../files/act-answers.js';
import { answerFileActFailure } from '../files/act-failure-answer.js';
import { mkdirPrivate } from '../util/fs-modes.js';
import { isInstanceLocalFile } from '../sync/file-conflict.js';
import { isProxySpace } from '../spaces/proxy.js';
import { storeFailureAnswer } from '../brain/store-failure.js';
import { reportServerFailure } from '../util/report-failure.js';
import { toDocId } from '../util/paths.js';
import type { ConflictDoc, LinkViolationDoc } from '../config/types.js';
import type { TokenRights } from '../config/rights-shape.js';
import { spaceCollection } from '../db/space-collection.js';
import { MAX_CONFLICT_IDS, countError } from '../util/request-bounds.js';
import { sendCaughtFailure } from './send-failure.js';

export const conflictsRouter = Router();

const VALID_ACTIONS = ['keep-local', 'keep-incoming', 'keep-both', 'save-to-space'] as const;
type ResolveAction = typeof VALID_ACTIONS[number];

/*
 * These routes take no space in the path: they walk every space the token can reach, so the space list each one
 * walks IS its enforcement point (`auth/reachable-spaces.ts`). Every walk names its area and rung at the call —
 * `spacesWhereTokenMay` for a list, `findWhereTokenMay` for a record by id — and neither has a default (`Q-304`).
 */

/** What a resolution did: it did its action and closed the record, or there was no copy to place and it closed the record having touched no file. */
type Resolution = 'resolved' | 'nothing-to-place';

/**
 * Place the incoming copy at a path the CALLER chose (`rename`) or at the conflict's own path in another space (save-to-space), and never
 * replace what stands there: the one sequence of questions `keep-both` with a rename and `save-to-space` share, so neither can leave one out.
 *
 * ## What it prevents
 *
 * Both placed the copy with a rename, which replaces: a rename onto a file, a folder or a file's record destroyed it, and a replicated
 * file's loss travels to every instance; in another space the same, for a token that held only the data-quality area there (Q-466).
 *
 * ## The order, and why
 *
 *  1. the destination through the sandbox's CHECKED resolve (a lexical one follows a link on the way out of the space);
 *  2. a path this instance keeps for itself (`isInstanceLocalFile`) is refused when the CALLER named it: a conversion's output tree, a
 *     schema snapshot, a conflict copy's own name. The default destination of a save (the copy's own name) is not the caller's choice;
 *  3. a file standing where a directory is needed (`assertDestinationReachable`: `409 path_blocked`, not the `500` a rename gave);
 *  4. NOTHING TO PLACE (the destination is the copy's own path, or the copy is gone: a retry after a placement whose record delete
 *     failed) closes the record and moves nothing. It comes before the next question, because the placement of an earlier attempt is
 *     standing at the destination and must not be refused against itself;
 *  5. nothing stands at the destination (`assertNothingStandsAt`), except this copy's own half-made link, which the placing finishes;
 *  6. the placing, which asks again under the locks (`placeIfFree`).
 */
async function placeIncomingCopy(
  srcAbs: string, spaceId: string, dstSpaceId: string, dstPath: string, { callerChose }: { callerChose: boolean },
): Promise<Resolution> {
  const dstAbs = await resolveSafePathChecked(dstSpaceId, dstPath);
  if (dstSpaceId === spaceId && dstAbs === srcAbs) return 'nothing-to-place';
  if (callerChose && isInstanceLocalFile(fileKeyOf(dstSpaceId, dstPath).key)) {
    throw new RangeError(`'${toDocId(dstPath)}' is a path this instance keeps for itself (a conversion's output, a conflict copy or a schema snapshot), and a resolution does not place a file there.`);
  }
  await assertDestinationReachable(dstSpaceId, dstPath);
  if (await lstatIfPresent(srcAbs) === null) return 'nothing-to-place';
  await assertNothingStandsAt(dstSpaceId, dstPath, { placing: srcAbs });
  // `begun`: the conflict record being open IS the evidence that a hard link of the copy at the destination is this placing's own.
  await placeIfFree(srcAbs, dstAbs, toDocId(dstPath), { begun: true, act: 'resolution' });
  return 'resolved';
}

/**
 * Perform the file operations for a given resolve action, then delete the conflict record.
 *
 * Every path of the conflict (the copy's and the original's) and every destination goes through the sandbox's CHECKED resolve before it
 * is touched, whichever action runs: a conflict record's paths come from a peer, and a link on the way out of the space must not be
 * followed by a delete or a move. `keep-incoming` is the one action that REPLACES (the local file, which is its purpose); every other
 * placement refuses an occupied destination.
 */
async function executeResolve(
  doc: ConflictDoc,
  spaceId: string,
  action: ResolveAction,
  rename?: string,
  targetSpaceId?: string,
): Promise<Resolution> {
  const srcAbs = await resolveSafePathChecked(spaceId, doc.conflictPath);
  let outcome: Resolution = 'resolved';
  switch (action) {
    case 'keep-local': {
      // Delete the conflict copy, keep the original
      // Already gone is fine.
      await deleteStoredIfPresent(srcAbs);
      break;
    }
    case 'keep-incoming': {
      // Replace the original with the conflict copy, then delete the conflict copy
      const dstAbs = await resolveSafePathChecked(spaceId, doc.originalPath);
      if (dstAbs === srcAbs || await lstatIfPresent(srcAbs) === null) { outcome = 'nothing-to-place'; break; }
      await mkdirPrivate(path.dirname(dstAbs)).catch((err: unknown) => { throw fsRefusalOf(err, [doc.originalPath]); });
      // A move, under both paths' locks: the stored bytes (ciphertext or not) are valid wherever they land (F-43).
      await moveStored(srcAbs, dstAbs).catch((err: unknown) => { throw fsRefusalOf(err, [doc.originalPath]); });
      break;
    }
    case 'keep-both': {
      // Keep both files. If rename is provided, rename the conflict copy.
      // Without rename, both files stay as-is — nothing to do.
      if (rename) outcome = await placeIncomingCopy(srcAbs, spaceId, spaceId, rename, { callerChose: true });
      break;
    }
    case 'save-to-space': {
      // The move IS the save: the copy leaves this space for the target, then the conflict record is deleted.
      outcome = await placeIncomingCopy(srcAbs, spaceId, targetSpaceId!, rename || doc.conflictPath, { callerChose: !!rename });
      break;
    }
  }

  // Remove the conflict record
  await col<ConflictDoc>(spaceCollection(spaceId, 'conflicts'))
    .deleteOne(asFilter<ConflictDoc>({ _id: doc._id }));
  return outcome;
}

/** The body a resolution answers `200` with: `resolved` is present only when there was nothing to place. */
const resolvedBody = (outcome: Resolution): { status: 'resolved'; resolved?: 'nothing-to-place' } =>
  outcome === 'nothing-to-place' ? { status: 'resolved', resolved: 'nothing-to-place' } : { status: 'resolved' };

/**
 * Why a resolution's body cannot be served, or null: the action, the two strings a caller chooses a destination by, and the target a
 * save needs. One function for both doors, so neither takes what the other refuses.
 *
 * `rename` and `targetSpaceId` are read as strings downstream (`path.resolve`, a space lookup): an array or an object reached them
 * unchecked, and a rename of `['a.txt']` was the file `a.txt` by its `toString`. An empty rename is no rename (as it always was).
 */
export function resolveBodyError(body: unknown): string | null {
  const { action, rename, targetSpaceId } = (body ?? {}) as Record<string, unknown>;
  if (!action || !VALID_ACTIONS.includes(action as ResolveAction)) return `action must be one of: ${VALID_ACTIONS.join(', ')}`;
  for (const [name, value] of [['rename', rename], ['targetSpaceId', targetSpaceId]] as const) {
    if (value !== undefined && value !== null && typeof value !== 'string') return `${name} must be a string`;
  }
  if (action === 'save-to-space' && !targetSpaceId) return 'targetSpaceId is required for save-to-space action';
  return null;
}

/**
 * Whether the token may save a conflict's copy to `targetSpaceId`: `null` when it may, else the refusal. A save is a WRITE of a file in
 * the target space, so it needs `files:write` THERE on top of the data-quality area that lets it resolve conflicts, and the target must
 * be a concrete space (a proxy holds no files of its own).
 *
 * The rights are asked BEFORE the target is looked at, so a token that may not write there is refused identically whatever the target
 * holds and cannot use a resolution to learn what is in a space it may not write in. `spaces` is the set the token may resolve
 * conflicts in (`spacesWhereTokenMay`, the iteration set of the route).
 */
function saveTargetRefusal(
  rights: TokenRights | undefined, spaces: readonly string[], targetSpaceId: string,
): { status: 400 | 403; error: string } | null {
  if (!spaces.includes(targetSpaceId)) return { status: 403, error: 'Token does not have access to target space' };
  if (!holdsRungOnEvery(rights, [targetSpaceId], 'files', 'write')) {
    return { status: 403, error: 'Token does not have write access to files in the target space' };
  }
  if (isProxySpace(targetSpaceId)) return { status: 400, error: `'${targetSpaceId}' is a proxy space and holds no files of its own: choose one of its member spaces` };
  return null;
}

/** One conflict a bulk resolution could not resolve: the id, our sentence, and, for a file act's refusal, its code, status and path. */
interface FailedResolution { id: string; error: string; code?: string; status?: number; path?: string }

/**
 * A bulk resolution's failure for one id, in the file act's one answer (`fileActAnswer`), never `err.message`, which for a file-system
 * failure names the server's absolute data path. A failure that is not one of the file acts' is the store's answer when it is the
 * store's, a `400` for a path outside the space, and otherwise the file-system-fault sentence (its code, no path); the cause is logged.
 */
function failedResolution(id: string, err: unknown, where: string): FailedResolution {
  const act = answerFileActFailure(err, where);
  if (act) {
    return { id, error: act.body.error, code: act.body.code, status: act.status, ...(act.body.path !== undefined ? { path: act.body.path } : {}) };
  }
  if (err instanceof RangeError) return { id, error: err.message, status: 400 };
  const store = storeFailureAnswer(err, where);
  if (store) return { id, error: store.body.error, status: store.status };
  reportServerFailure(where, err);
  const fault = fileActAnswer(new FileSystemFault(err))!;
  return { id, error: fault.body.error, code: fault.body.code, status: fault.status };
}

// Bounds for the cross-space list endpoints below. Without these the fan-in was up to 500·N docs
// materialised in memory for an N-space token, and the client got a silently-capped array with no way
// to tell it was incomplete. We cap per space (fetch cap+1 to DETECT overflow) and bound the total,
// and always report `truncated` + `returned` so the caller knows whether it saw everything.
const PER_SPACE_CAP = 500;
// The same number a bulk-resolve may name: a caller selects from what this listing shows.
const MAX_TOTAL = MAX_CONFLICT_IDS;

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
    sendCaughtFailure(res, `GET /api/conflicts`, err);
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
    sendCaughtFailure(res, `GET /api/conflicts/link-violations`, err);
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
    sendCaughtFailure(res, `DELETE /api/conflicts/link-violations/:id`, err);
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
    sendCaughtFailure(res, `DELETE /api/conflicts/link-violations`, err);
  }
});

// GET /api/conflicts/:id — get a single conflict record
conflictsRouter.get('/:id', globalRateLimit, requireAuth, async (req, res) => {
  try {
    const found = await findWhereTokenMay<ConflictDoc>(req.authToken?.rights, 'dataQuality', 'read', 'conflicts', req.params['id'] as string);
    if (!found) { res.status(404).json({ error: 'Conflict not found' }); return; }
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
  } catch (err) {
    sendCaughtFailure(res, `GET /api/conflicts/:id`, err);
  }
});

// There is no DELETE /api/conflicts/:id. It closed the record and left the incoming copy in the space under its
// conflict name, where it replicated to every member — a keep-both without the rename (removed 2026-09-27). A
// conflict closes only through a resolution.

/**
 * Why a bulk-resolve body cannot be served, or null (`Q-108`).
 *
 * `ids` is a COUNT of cross-space lookups, one per id, so it is bounded — at `MAX_CONFLICT_IDS`, the most the
 * conflict listing shows, which is what a caller selects from. It took any number, and any value per entry.
 */
export function bulkResolveBodyError(body: unknown): string | null {
  const { ids } = (body ?? {}) as Record<string, unknown>;
  if (!Array.isArray(ids) || ids.length === 0) return 'ids must be a non-empty array';
  if (ids.some(id => typeof id !== 'string' || !id)) return 'ids must contain non-empty strings';
  const tooMany = countError('ids', ids, MAX_CONFLICT_IDS);
  if (tooMany) return tooMany;
  return resolveBodyError(body);
}

// POST /api/conflicts/bulk-resolve — resolve multiple conflicts at once
conflictsRouter.post('/bulk-resolve', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { ids, action, rename, targetSpaceId } = req.body ?? {};
    const bodyErr = bulkResolveBodyError({ ids, action, rename, targetSpaceId });
    if (bodyErr) {
      res.status(400).json({ error: bodyErr });
      return;
    }
    const spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write');
    const refusal = action === 'save-to-space' ? saveTargetRefusal(req.authToken?.rights, spaces, targetSpaceId) : null;
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }

    let resolved = 0;
    const failed: FailedResolution[] = [];

    for (const id of ids) {
      try {
        const found = await findWhereTokenMay<ConflictDoc>(req.authToken?.rights, 'dataQuality', 'write', 'conflicts', id);
        if (!found) {
          failed.push({ id, error: 'Conflict not found', status: 404 });
          continue;
        }
        await executeResolve(found.doc, found.spaceId, action, rename, targetSpaceId);
        resolved++;
      } catch (err: unknown) {
        failed.push(failedResolution(id, err, 'POST /api/conflicts/bulk-resolve'));
      }
    }

    res.json({ resolved, failed });
  } catch (err) {
    sendCaughtFailure(res, `POST /api/conflicts/bulk-resolve`, err);
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
    sendCaughtFailure(res, `POST /api/conflicts/seed`, err);
  }
});

// POST /api/conflicts/:id/resolve — resolve a single conflict with an action
conflictsRouter.post('/:id/resolve', globalRateLimit, requireAuth, denyReadOnly, async (req, res) => {
  try {
    const { action, rename, targetSpaceId } = req.body ?? {};

    // Validate the action and the strings a destination is chosen by (400 before any 403: a malformed request says what is wrong with it)
    const bodyErr = resolveBodyError({ action, rename, targetSpaceId });
    if (bodyErr) {
      res.status(400).json({ error: bodyErr });
      return;
    }

    const spaces = spacesWhereTokenMay(req.authToken?.rights, 'dataQuality', 'write');

    // A save is a write in the target space: files:write there, and a concrete target
    const refusal = action === 'save-to-space' ? saveTargetRefusal(req.authToken?.rights, spaces, targetSpaceId) : null;
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.error });
      return;
    }

    const found = await findWhereTokenMay<ConflictDoc>(req.authToken?.rights, 'dataQuality', 'write', 'conflicts', req.params['id'] as string);
    if (!found) {
      res.status(404).json({ error: 'Conflict not found' });
      return;
    }

    const outcome = await executeResolve(found.doc, found.spaceId, action, rename, targetSpaceId);
    res.status(200).json(resolvedBody(outcome));
  } catch (err) {
    // A path outside the space (or through a link out of it) is the request's: 400, as the file doors answer it.
    if (err instanceof RangeError) { res.status(400).json({ error: err.message }); return; }
    sendCaughtFailure(res, `POST /api/conflicts/:id/resolve`, err);
  }
});

