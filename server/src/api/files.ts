/**
 * /api/files/:spaceId  — File manager HTTP API
 *
 * All routes require a valid Bearer PAT with access to the requested space.
 * The file path is passed as the `path` query parameter.
 *
 * GET    /api/files/:spaceId?path={path}   Stat path: if dir → JSON listing,
 *                                          if file → stream bytes
 * POST   /api/files/:spaceId?path={path}   Write/overwrite file.
 *                                          Body: raw bytes (any Content-Type
 *                                          except application/json) OR JSON
 *                                          { content: string, encoding?: 'utf8'|'base64' }
 * DELETE /api/files/:spaceId?path={path}   Delete file. Deleting a directory
 *                                          requires { confirm: true } in body.
 * PATCH  /api/files/:spaceId?path={path}   Move/rename.
 *                                          Body: { destination: string }
 * POST   /api/files/:spaceId/mkdir?path={path}  Create directory.
 */

import { Router } from 'express';
import { toDocId } from '../util/paths.js';
import fs from 'fs/promises';
import path from 'path';
import { requireSpaceAuth, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { log } from '../util/log.js';
import { openStoredRead, statStored } from '../files/stored-bytes.js';
import { type FileEntry } from '../files/files.js';
import { listAcrossMembers } from '../files/list-across-members.js';
import { fileReadFaultOf } from '../files/read-fault.js';
import { enrichEntries, listingBody } from '../files/merged-listing.js';
import {
  getUploadReceived,
} from '../files/chunks.js';
import { resolveSafePath, resolveSafePathChecked } from '../files/sandbox.js';
import { heldEntryOf } from '../files/held-spelling.js';
import { NotFoundError, RequestRefusal } from '../util/errors.js';
import { moveFileCascade } from '../files/move-cascade.js';
import { deletePath } from '../files/delete-cascade.js';
import { readSpacesOfRequest } from '../spaces/read-scope.js';
import { contentTypeForDownload } from '../files/mime.js';
import { contentDispositionOf } from '../util/content-disposition.js';
import { hideDerivedTrees } from '../files/derived-trees.js';
import { registerUploadRoute } from './files-upload.js';
import { registerMkdirRoute } from './files-mkdir.js';
import { registerFileChangesRoute } from './files-changes.js';
import { webhookToken, requireWritePath, requireWriteTarget } from './files-request.js';
import { answeredUnknownSpace } from './write-target-answer.js';
import { answerSpillPath } from './brain/spills.js';
import { sendCaughtFailure } from './send-failure.js';

export const fileStoreRouter = Router();

// The request-shape helpers moved to `files-request.ts` when the upload route left (G-4): the routes that
// stayed use three of the four, so taking them along would have left a copy behind.

// ── GET /api/files/:spaceId ───────────────────────────────────────────────────
// Stat the path: directory → JSON list, file → stream bytes.
fileStoreRouter.get('/:spaceId', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;

  const filePath = req.query['path'];
  const normalised = typeof filePath === 'string' && filePath.trim() ? filePath : '.';
  // A spill's deprecated `path` (Q-92): answered from the spill store for its issuer alone, never as a file here.
  if (await answerSpillPath(req, res, normalised)) return;
  const memberIds = readSpacesOfRequest(req, spaceId);

  // Directory listing — aggregate across all member spaces
  // Try to find the first member where the path resolves successfully
  let foundMid: string | null = null;
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;
  // Where the path is when it is held under another spelling (a decomposed name, Q-581): `heldEntryOf`, the lookup MCP's doors make too.
  let heldAbs: string | null = null;
  for (const mid of memberIds) {
    let at: Awaited<ReturnType<typeof heldEntryOf>>;
    try {
      at = await heldEntryOf(mid, normalised);
    } catch (err) {
      // A member that holds nothing at the path (a name too long, a link loop) is skipped; a fault of the storage is answered 500 file_system_fault
      // by the shared answer, never a bare 500 from the application's last-resort handler (`fileReadFaultOf`).
      const fault = fileReadFaultOf(err);
      if (fault) { sendCaughtFailure(res, `heldEntryOf for space ${mid}, path ${normalised}`, fault, { error: 'Failed to read file' }); return; }
      continue;
    }
    if (at) { foundMid = mid; stat = at.stat; heldAbs = at.heldAbs; break; }
  }

  if (!foundMid || !stat) {
    // For directory listing at root, aggregate even if some members have no dir
    if (normalised === '.') {
      try {
        const allEntries = await listAcrossMembers(memberIds, normalised);
        res.json(listingBody(normalised, await enrichEntries(memberIds, normalised, allEntries)));
      } catch (err) {
        sendCaughtFailure(res, `list for space ${spaceId}, path ${normalised}`, err, { error: 'Failed to list directory' });
      }
      return;
    }
    res.status(404).json({ error: 'Path not found' });
    return;
  }

  if (stat.isDirectory()) {
    // Aggregate directory entries across all member spaces
    let allEntries: FileEntry[];
    try {
      allEntries = await listAcrossMembers(memberIds, normalised);
    } catch (err) {
      sendCaughtFailure(res, `list for space ${spaceId}, path ${normalised}`, err, { error: 'Failed to list directory' });
      return;
    }
    res.json(listingBody(normalised, await enrichEntries(memberIds, normalised, hideDerivedTrees(normalised, allEntries, req))));
    return;
  }

  // File download — serve from the first member that has it
  try {
    // STREAMED through the stored-bytes door (F-43): a file of any size, decrypted a chunk at a time when it is
    // encrypted at rest. The length is the PLAINTEXT size, read from the ciphertext length without decrypting.
    const abs = heldAbs ?? await resolveSafePathChecked(foundMid, normalised);
    const { size } = await statStored(abs);
    const body = await openStoredRead(abs);
    const ext = path.extname(normalised).toLowerCase();
    const contentType = contentTypeForDownload(normalised);
    // Stored XSS guard: user-uploaded HTML/SVG/XML rendered inline would run
    // script in this origin (token theft from the web UI). Active-content
    // types are forced to download and get a sandbox CSP so nothing executes
    // even if a browser renders them anyway. Passive types (images, pdf,
    // plain text) stay inline so previews keep working.
    const isActive = ACTIVE_CONTENT_EXTS.has(ext);
    res
      .status(200)
      .setHeader('Content-Type', contentType)
      .setHeader('Content-Length', size)
      .setHeader('X-Content-Type-Options', 'nosniff')
      .setHeader('Content-Disposition', contentDispositionOf(isActive ? 'attachment' : 'inline', path.basename(abs)));
    if (isActive) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    }
    /*
     * A chunk that fails its integrity check AFTER bytes were sent must ABORT the response. Ending it normally would
     * hand the client a truncated file that looks complete; destroying it makes the client see a failed transfer.
     */
    body.on('error', err => {
      log.warn(`download of ${foundMid}/${normalised} failed mid-stream: ${err instanceof Error ? err.message : String(err)}`);
      res.destroy(err instanceof Error ? err : undefined);
    });
    body.pipe(res);
  } catch (err) {
    // A stored file that cannot be read is answered by what it is inside `sendCaughtFailure` (500, its base name and "cannot be read",
    // reported there), the same words as the tool doors.
    sendCaughtFailure(res, `readFileBytes for space ${foundMid}, path ${normalised}`, err, { error: 'Failed to read file' });
  }
});

// The mkdir route lives in `files-mkdir.ts`: the destination check made it the concern this frozen file moved out.
registerMkdirRoute(fileStoreRouter);
registerFileChangesRoute(fileStoreRouter);

// ── GET /api/files/:spaceId/upload-status ─────────────────────────────────────
// Returns bytes received for an in-progress chunked upload.
fileStoreRouter.get('/:spaceId/upload-status', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  const filePath = req.query['path'];
  const total = parseInt(req.query['total'] as string, 10);
  if (typeof filePath !== 'string' || !filePath.trim() || isNaN(total) || total <= 0) {
    res.status(400).json({ error: 'Required query params: path, total (positive integer)' });
    return;
  }
  const received = await getUploadReceived(spaceId, filePath, total);
  res.json({ received });
});

// The upload route lives in `files-upload.ts` (G-4): 196 code lines, the largest body in this file.
registerUploadRoute(fileStoreRouter);

// ── POST /api/files/:spaceId/retry_embedding ──────────────────────────────────
// Manually re-trigger media embedding for a failed / skipped file.
fileStoreRouter.post(
  '/:spaceId/retry_embedding',
  globalRateLimit,
  requireSpaceAuth,
  denyReadOnly,
  async (req, res) => {
    const target = requireWriteTarget(req, res);
    if (target === null) return;
    const { spaceId: targetSpace } = target;

    const filePath = req.query['path'];
    if (typeof filePath !== 'string' || !filePath.trim()) {
      res.status(400).json({ error: 'Required query param: path' });
      return;
    }

    let normId: string;
    try {
      normId = toDocId(filePath);
      // Validate the path doesn't escape the space root
      resolveSafePath(targetSpace, filePath);
    } catch (err) {
      // The path's own refusal is the caller's `400` in its sentence; anything else that failed here is not (`sendCaughtFailure`).
      if (!(err instanceof RequestRefusal)) { sendCaughtFailure(res, `retry embedding for space ${targetSpace}, path ${filePath}`, err); return; }
      res.status(400).json({ error: err.message });
      return;
    }

    const { retryJob } = await import('../files/media/job-queue.js');
    // The failure is KEPT, not logged and replaced by a token: a store failure here answers as every door answers it.
    let failure: unknown;
    const result = await retryJob(targetSpace, normId).catch(err => {
      failure = err;
      return 'error' as const;
    });

    switch (result) {
      case 'not_found':
        res.status(404).json({ error: 'No media job found for this file' });
        break;
      case 'processing':
        res.status(409).json({ error: 'Job is currently processing' });
        break;
      case 'ok':
        res.status(202).json({ queued: true });
        break;
      default:
        sendCaughtFailure(res, `retryJob for ${targetSpace}/${normId}`, failure);
    }
  },
);

// ── DELETE /api/files/:spaceId ────────────────────────────────────────────────
// Deletes a file, or — with { confirm: true } in the JSON body — a directory tree. `deletePath` decides which, and
// is what MCP `delete_file` and `POST /api/delete_file` call too.
fileStoreRouter.delete('/:spaceId', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const request = requireWritePath(req, res);
  if (request === null) return;
  const { spaceId: targetSpace, path: filePath } = request;

  try {
    // Blob, tombstone, metadata, job, artifacts, usage and (for a file) the webhook, in the order `files/delete-cascade.ts`
    // explains — shared with the MCP tool and the TTL sweep so every delete path cleans up identically.
    const deleted = await deletePath(targetSpace, filePath, { confirm: req.body?.confirm, actor: webhookToken(req) });
    // A directory delete is audited with what it was; a single file records nothing, as before.
    if (deleted === 'directory') req.auditSnapshots = { before: {}, after: { kind: 'directory' } };
    res.status(204).end();
  } catch (err) {
    if (err instanceof RequestRefusal) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'Path not found' });
      return;
    }
    sendCaughtFailure(res, `delete for space ${targetSpace}, path ${filePath}`, err, { error: 'Failed to delete' });
  }
});

// ── PATCH /api/files/:spaceId ─────────────────────────────────────────────────
// Move/rename a file or directory. Body: { destination: string }
fileStoreRouter.patch('/:spaceId', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const request = requireWritePath(req, res);
  if (request === null) return;
  const { spaceId: targetSpace, path: srcPath } = request;

  const destination = req.body?.destination;
  if (typeof destination !== 'string' || !destination.trim()) {
    res.status(400).json({ error: 'Body must contain { destination: string }' });
    return;
  }

  try {
    // The whole move — bytes, metadata, derived records, sidecars, jobs, tombstones, webhook — shared with MCP
    // `move_file`, and ordered so a conversion still running on the source cannot write under the old path.
    await moveFileCascade(targetSpace, srcPath, destination, webhookToken(req));
    res.json({ from: srcPath, to: destination });
  } catch (err) {
    if (err instanceof RequestRefusal) {
      res.status(400).json({ error: err.message });
      return;
    }
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: 'Path not found' });
      return;
    }
    sendCaughtFailure(res, `file move for space ${targetSpace}, ${srcPath} → ${destination}`, err, { error: 'Failed to move path' });
  }
});


// Extensions whose content can execute script when rendered inline by a
// browser — always served as attachments (stored-XSS guard).
const ACTIVE_CONTENT_EXTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);

// MIME lookup for downloads now comes from the shared table in `files/mime.ts` — see
// `contentTypeForDownload`. The local copy that used to live here listed a different set of
// extensions than the processing path did, which is the drift that let a `.png` be served correctly
// while being *processed* as `application/octet-stream`.
