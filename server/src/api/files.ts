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
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import {
  readFileBytes,
  listDir,
  createDir,
  moveFile,
  listFilesRecursive,
  type FileEntry,
} from '../files/files.js';
import { fetchJobProgress } from '../files/media/job-queue.js';
import {
  getUploadReceived,
} from '../files/chunks.js';
import { invalidateUsageCache } from '../quota/quota.js';
import { resolveSafePath, assertNoSymlinkEscape, spaceRoot } from '../files/sandbox.js';
import { col, asFilter } from '../db/mongo.js';
import type { FileMetaDoc } from '../config/types.js';
import { deleteFileMeta, deleteFileMetaByPrefix, renameFileMeta, renameFileMetaByPrefix, markFileMetaDeletedByPrefix } from '../files/file-meta.js';
import { writeFileTombstones } from '../files/tombstones.js';
import { deleteFileCascade } from '../files/delete-cascade.js';
import { resolveWriteTarget } from '../spaces/proxy.js';
import { memberSpacesForRequest } from '../spaces/proxy-scoped.js';
import { emitWebhookEvent } from '../webhooks/dispatcher.js';
import { deleteConversionArtifactsByPrefix } from '../files/converters/pipeline.js';
import { cancelMediaJobsByPrefix } from '../files/media/job-queue.js';
import { contentTypeForDownload } from '../files/mime.js';
import { hideDerivedTrees } from '../files/derived-trees.js';
import { registerUploadRoute } from './files-upload.js';
import { webhookToken, requireQueryPath } from './files-request.js';
import { spaceCollection } from '../db/space-collection.js';

export const fileStoreRouter = Router();

// The request-shape helpers moved to `files-request.ts` when the upload route left (G-4): the routes that
// stayed use three of the four, so taking them along would have left a copy behind.

// ── Merged file listing: join filesystem entries with their FileMeta records ──────────────────────
// Folders get a recursive content size; files get their embedding status + tags. Both come from ONE
// indexed prefix query per member over the `{space}_files` records (chunk/derived records carry a
// `parentFileId` and are excluded; soft-deleted records excluded). The roll-up is pure JS (unicode-safe,
// unlike Mongo `$substr` byte offsets).

/** A file-level FileMeta row projected for the merged listing: path, raw size, and the bits the UI
 *  shows per file (embedding status, tags). */
interface FileMetaRow { _id?: string; path: string; sizeBytes?: number; embeddingStatus?: FileEntry['embeddingStatus']; tags?: string[] }

/**
 * What the roll-up records per file sitting directly in the listed directory.
 *
 * `id` and `memberId` are carried so the live-stage lookup can find the file's job afterwards: a media
 * job's `_id` IS the file record's `_id`, and jobs live in the MEMBER space's collection — a proxy
 * space's listing merges several members, so the id alone would not say which collection to ask.
 */
interface DirFileMeta {
  embeddingStatus?: FileEntry['embeddingStatus'];
  tags?: string[];
  id?: string;
  memberId?: string;
}

/** Statuses worth a progress lookup. Anything else is finished and has nothing left to draw. */
const IN_FLIGHT = new Set(['pending', 'processing']);

/**
 * Pure roll-up over the file-level records under a directory: sums each file's `sizeBytes` into the
 * IMMEDIATE sub-folder it lives under (nested files roll up), and — for files sitting DIRECTLY in the
 * listed directory — records their metadata (status, tags) keyed by name. A loose file belongs to no
 * sub-folder; a nested file's metadata belongs to a deeper listing, not this one. Exported for testing;
 * accumulates into the given maps so callers can merge across member spaces.
 */
export function rollUpDirRows(
  rows: FileMetaRow[], prefix: string,
  folderSizes = new Map<string, number>(),
  fileMeta = new Map<string, DirFileMeta>(),
  memberId?: string,
): { folderSizes: Map<string, number>; fileMeta: Map<string, DirFileMeta> } {
  for (const r of rows) {
    const rel = prefix ? r.path.slice(prefix.length) : r.path;
    const slash = rel.indexOf('/');
    if (slash > 0) {
      // Nested → contributes to the immediate sub-folder's size.
      const child = rel.slice(0, slash);
      folderSizes.set(child, (folderSizes.get(child) ?? 0) + (r.sizeBytes ?? 0));
    } else if (slash === -1 && rel) {
      // A file sitting directly in the listed directory → carry its metadata onto the row.
      if (!fileMeta.has(rel)) {
        fileMeta.set(rel, {
          embeddingStatus: r.embeddingStatus, tags: r.tags,
          ...(r._id ? { id: r._id } : {}), ...(memberId ? { memberId } : {}),
        });
      }
    }
  }
  return { folderSizes, fileMeta };
}

/**
 * The stored-path prefix for a directory listing — `''` for the root, `reports/` for a sub-folder.
 *
 * Pure and exported because getting it wrong fails SILENTLY and completely: file records store their path
 * with no leading slash (`notes.txt`), so a prefix of `/` makes the indexed range `['/', '/￿')` match
 * nothing at all. The listing still returns every file — the filesystem walk is a separate thing — they
 * just arrive with no status, no tags and no folder sizes, which reads as "nothing has been processed yet"
 * rather than as a bug.
 *
 * That is exactly what happened: the caller compared the RAW path against `'.'`, but the client asks for
 * the root as `/`. `toDocId('/')` is `''`, so the old expression produced `'' + '/'` — the broken prefix —
 * for every root listing, which is most listings. Normalise FIRST, then decide if it is the root.
 */
export function dirPrefix(dirPath: string): string {
  const docPath = toDocId(dirPath).replace(/\/+$/, '');
  return docPath === '' || docPath === '.' ? '' : docPath + '/';
}

async function dirAggregates(memberIds: string[], dirPath: string): Promise<ReturnType<typeof rollUpDirRows>> {
  const prefix = dirPrefix(dirPath);
  const folderSizes = new Map<string, number>();
  const fileMeta = new Map<string, DirFileMeta>();
  for (const mid of memberIds) {
    try {
      const rows = await col<FileMetaDoc>(spaceCollection(mid, 'files')).find(
        asFilter<FileMetaDoc>({
          parentFileId: { $exists: false },
          deletedAt: { $exists: false },
          // Indexed prefix range over `path` — files under this directory only (all files when root).
          // '￿' is the highest BMP code unit, so `[prefix, prefix+￿)` covers every path with
          // this prefix without a regex.
          ...(prefix ? { path: { $gte: prefix, $lt: prefix + '￿' } } : {}),
        }),
        { projection: { _id: 1, path: 1, sizeBytes: 1, embeddingStatus: 1, tags: 1 } },
      ).toArray() as FileMetaRow[];
      rollUpDirRows(rows, prefix, folderSizes, fileMeta, mid);
    } catch { /* member has no files collection — skip */ }
  }
  return { folderSizes, fileMeta };
}

/**
 * Attach the live stage to the files that HAVE one.
 *
 * Only in-flight files are looked up, and only the member spaces that actually contain one are queried:
 * a listing of finished files — which is most listings — issues no query at all, and a proxy space with
 * five members does not pay five round trips to decorate two files. The lookup is grouped by member
 * because a media job lives in its own space's collection and its `_id` is the file record's `_id`.
 *
 * Best-effort, like the heartbeat that writes the data: a failed lookup simply leaves the rows
 * undecorated and the UI falls back to the status pill. A progress bar is not worth failing a listing over.
 *
 * `lookup` is injectable so a test can observe WHICH members were queried with WHICH ids — asserting on
 * the decorated rows alone cannot tell "skipped the query" from "queried and got nothing back", and
 * skipping it for finished files is the whole point.
 */
export async function attachLiveStage(
  entries: FileEntry[],
  fileMeta: Map<string, DirFileMeta>,
  lookup: typeof fetchJobProgress = fetchJobProgress,
): Promise<void> {
  const byMember = new Map<string, Array<{ entry: FileEntry; id: string }>>();
  for (const e of entries) {
    if (e.type === 'dir' || !IN_FLIGHT.has(String(e.embeddingStatus ?? ''))) continue;
    const m = fileMeta.get(e.name);
    if (!m?.id || !m.memberId) continue;
    const list = byMember.get(m.memberId) ?? [];
    list.push({ entry: e, id: m.id });
    byMember.set(m.memberId, list);
  }
  if (byMember.size === 0) return;

  await Promise.all([...byMember].map(async ([mid, items]) => {
    try {
      const progressById = await lookup(mid, items.map(i => i.id));
      for (const { entry, id } of items) {
        const view = progressById.get(id);
        // A claimed job that has not reported its first step yet adds nothing — leaving the field absent
        // keeps "we do not know yet" distinct from "the route has no steps".
        if (!view?.progress) continue;
        entry.progress = view.progress;
        entry.progressAt = view.progressAt;
      }
    } catch {
      // One member's jobs collection being unreachable must not lose the OTHER members' rows, and must
      // never fail the listing. `fetchJobProgress` already swallows its own errors; this covers the rest.
    }
  }));
}

/**
 * Enrich a directory listing from the FileMeta records in one query per member: directories get their
 * recursive content `size`, files get their `embeddingStatus` + `tags` — the merged filesystem +
 * metadata rows the Files list renders — plus the live processing stage for anything still in flight.
 */
async function enrichEntries(memberIds: string[], dirPath: string, entries: FileEntry[]): Promise<FileEntry[]> {
  if (entries.length === 0) return entries;
  const { folderSizes, fileMeta } = await dirAggregates(memberIds, dirPath);
  for (const e of entries) {
    if (e.type === 'dir') {
      e.size = folderSizes.get(e.name) ?? 0;
    } else {
      const m = fileMeta.get(e.name);
      if (m) { e.embeddingStatus = m.embeddingStatus; e.tags = m.tags; }
    }
  }
  await attachLiveStage(entries, fileMeta);
  return entries;
}

// ── GET /api/files/:spaceId ───────────────────────────────────────────────────
// Stat the path: directory → JSON list, file → stream bytes.
fileStoreRouter.get('/:spaceId', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const filePath = req.query['path'];
  const normalised = typeof filePath === 'string' && filePath.trim() ? filePath : '.';
  const memberIds = memberSpacesForRequest(req, spaceId);

  // Directory listing — aggregate across all member spaces
  // Try to find the first member where the path resolves successfully
  let foundMid: string | null = null;
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;

  for (const mid of memberIds) {
    try {
      const p = resolveSafePath(mid, normalised);
      const s = await fs.stat(p);
      foundMid = mid;
      stat = s;
      break;
    } catch {
      continue;
    }
  }

  if (!foundMid || !stat) {
    // For directory listing at root, aggregate even if some members have no dir
    if (normalised === '.') {
      const allEntries: FileEntry[] = [];
      const seen = new Set<string>();
      for (const mid of memberIds) {
        try {
          const entries = await listDir(mid, normalised);
          for (const e of entries) {
            if (!seen.has(e.name)) { seen.add(e.name); allEntries.push(e); }
          }
        } catch { /* member may have no files dir */ }
      }
      res.json({ path: normalised, type: 'dir', entries: await enrichEntries(memberIds, normalised, allEntries) });
      return;
    }
    res.status(404).json({ error: 'Path not found' });
    return;
  }

  if (stat.isDirectory()) {
    // Aggregate directory entries across all member spaces
    const allEntries: FileEntry[] = [];
    const seen = new Set<string>();
    for (const mid of memberIds) {
      try {
        const entries = await listDir(mid, normalised);
        for (const e of entries) {
          if (!seen.has(e.name)) { seen.add(e.name); allEntries.push(e); }
        }
      } catch { /* dir may not exist in this member */ }
    }
    res.json({
      path: normalised, type: 'dir',
      entries: await enrichEntries(memberIds, normalised, hideDerivedTrees(normalised, allEntries, req)),
    });
    return;
  }

  // File download — serve from the first member that has it
  try {
    const bytes = await readFileBytes(foundMid, normalised);
    const ext = path.extname(normalised).toLowerCase();
    const contentType = contentTypeForDownload(normalised);
    // Stored XSS guard: user-uploaded HTML/SVG/XML rendered inline would run
    // script in this origin (token theft from the web UI). Active-content
    // types are forced to download and get a sandbox CSP so nothing executes
    // even if a browser renders them anyway. Passive types (images, pdf,
    // plain text) stay inline so previews keep working.
    const filename = path.basename(normalised).replace(/[\r\n"\\]/g, '_');
    const isActive = ACTIVE_CONTENT_EXTS.has(ext);
    res
      .status(200)
      .setHeader('Content-Type', contentType)
      .setHeader('Content-Length', bytes.length)
      .setHeader('X-Content-Type-Options', 'nosniff')
      .setHeader('Content-Disposition', `${isActive ? 'attachment' : 'inline'}; filename="${filename}"`);
    if (isActive) {
      res.setHeader('Content-Security-Policy', "sandbox; default-src 'none'");
    }
    res.send(bytes);
  } catch (err) {
    log.warn(`readFileBytes error for space ${foundMid}, path ${normalised}: ${err}`);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// ── POST /api/files/:spaceId/mkdir ────────────────────────────────────────────
fileStoreRouter.post(
  '/:spaceId/mkdir',
  globalRateLimit,
  requireSpaceAuth,
  denyReadOnly,
  async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }

    const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
    if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
    const targetSpace = wt.target;

    const dirPath = requireQueryPath(req, res);
    if (dirPath === null) return;

    try {
      await createDir(targetSpace, dirPath);
      res.status(201).json({ created: dirPath });
    } catch (err) {
      if (err instanceof RangeError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.warn(`createDir error for space ${targetSpace}, path ${dirPath}: ${err}`);
      res.status(500).json({ error: 'Failed to create directory' });
    }
  },
);

// ── GET /api/files/:spaceId/upload-status ─────────────────────────────────────
// Returns bytes received for an in-progress chunked upload.
fileStoreRouter.get('/:spaceId/upload-status', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
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
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }

    const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
    if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
    const targetSpace = wt.target;

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
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }

    const { retryJob } = await import('../files/media/job-queue.js');
    const result = await retryJob(targetSpace, normId).catch(err => {
      log.warn(`retryJob error for ${targetSpace}/${normId}: ${err}`);
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
        res.status(500).json({ error: 'Internal error' });
    }
  },
);

// ── DELETE /api/files/:spaceId ────────────────────────────────────────────────
// Deletes a file. Deleting a directory requires { confirm: true } in the JSON body.
fileStoreRouter.delete('/:spaceId', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const targetSpace = wt.target;

  const filePath = requireQueryPath(req, res);
  if (filePath === null) return;

  let absPath: string;
  try {
    absPath = resolveSafePath(targetSpace, filePath);
    // Symlink-aware boundary re-check before a recursive delete: the lexical
    // path may stay under the root while a symlink component points outside it.
    await assertNoSymlinkEscape(targetSpace, absPath);
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>> | null;
  try {
    stat = await fs.stat(absPath);
  } catch (statErr: unknown) {
    const code = (statErr as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      // Check for an orphaned meta record (file deleted externally, meta still exists).
      // If there is one, clean it up and return 204 so the UI can remove it.
      // If there is none, the path was never known — return 404.
      const normalisedPath = toDocId(filePath);
      const orphan = await col<FileMetaDoc>(spaceCollection(targetSpace, 'files')).findOne(
        asFilter<FileMetaDoc>({ _id: normalisedPath }),
      );
      if (orphan) {
        await deleteFileMeta(targetSpace, filePath).catch(err => {
          log.warn(`deleteFileMeta (orphan cleanup) error for space ${targetSpace}, path ${filePath}: ${err}`);
        });
        res.status(204).end();
        return;
      }
      res.status(404).json({ error: 'Path not found' });
      return;
    }
    res.status(404).json({ error: 'Path not found' });
    return;
  }

  if (stat.isDirectory()) {
    if (!req.body || req.body.confirm !== true) {
      res.status(422).json({
        error:
          'Deleting a directory requires { "confirm": true } in the request body.',
      });
      return;
    }
    if (absPath === spaceRoot(targetSpace)) {
      res.status(400).json({ error: 'Cannot delete the space root directory.' });
      return;
    }
    try {
      // Enumerate every file about to be removed — the folder tree AND its conversion
      // sidecars — BEFORE deleting, so we can write a sync tombstone for each. Without
      // tombstones a peer would re-push the files on the next sync (resurrection).
      const removedPaths = (await Promise.all([
        listFilesRecursive(targetSpace, filePath),
        listFilesRecursive(targetSpace, `_converted/${filePath}`),
        listFilesRecursive(targetSpace, `_extracted/${filePath}`),
      ])).flat();

      await fs.rm(absPath, { recursive: true, force: false });
      log.info(`Deleted directory ${absPath} (space: ${targetSpace})`);
      invalidateUsageCache(); // freed disk — reflect it in the next quota check

      // Metadata: soft-flag the user-visible file records (retain for audit) or hard-delete
      // them, per the softDeleteFileMeta setting. Derived chunk records are always removed.
      if (getConfig().softDeleteFileMeta === true) {
        await markFileMetaDeletedByPrefix(targetSpace, filePath).catch(err => {
          log.warn(`markFileMetaDeletedByPrefix error for space ${targetSpace}, path ${filePath}: ${err}`);
        });
      } else {
        await deleteFileMetaByPrefix(targetSpace, filePath).catch(err => {
          log.warn(`deleteFileMetaByPrefix error for space ${targetSpace}, path ${filePath}: ${err}`);
        });
      }
      // Cancel any queued media/text jobs for files under this folder, or they would
      // outlive their sources and retry forever against paths that no longer exist.
      await cancelMediaJobsByPrefix(targetSpace, filePath).catch(err => {
        log.warn(`cancelMediaJobsByPrefix error for space ${targetSpace}, path ${filePath}: ${err}`);
      });
      // Remove conversion sidecar records + on-disk files (`_converted/<path>`,
      // `_extracted/<path>`), which live outside the folder prefix and would otherwise orphan.
      await deleteConversionArtifactsByPrefix(targetSpace, filePath).catch(err => {
        log.warn(`deleteConversionArtifactsByPrefix error for space ${targetSpace}, path ${filePath}: ${err}`);
      });
      // Propagate the deletion to sync peers.
      await writeFileTombstones(targetSpace, removedPaths);
      res.status(204).end();
    } catch (err) {
      log.warn(`rm dir error for space ${targetSpace}, path ${filePath}: ${err}`);
      res.status(500).json({ error: 'Failed to delete directory' });
    }
    return;
  }

  try {
    // Full cascade (blob + tombstone + meta + job + artifacts + usage + webhook) — shared with the MCP
    // delete_file tool and the TTL sweep so every delete path cleans up identically.
    await deleteFileCascade(targetSpace, filePath, webhookToken(req));
    res.status(204).end();
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.warn(`deleteFile error for space ${targetSpace}, path ${filePath}: ${err}`);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── PATCH /api/files/:spaceId ─────────────────────────────────────────────────
// Move/rename a file or directory. Body: { destination: string }
fileStoreRouter.patch('/:spaceId', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const targetSpace = wt.target;

  const srcPath = requireQueryPath(req, res);
  if (srcPath === null) return;

  const destination = req.body?.destination;
  if (typeof destination !== 'string' || !destination.trim()) {
    res.status(400).json({ error: 'Body must contain { destination: string }' });
    return;
  }

  try {
    // Collect the OLD paths before the move so we can tombstone them: sync has no rename
    // detection, so without a tombstone the peer's manifest still advertises the source path
    // and re-downloads it (the moved-away file resurrects). For a directory move these are the
    // child files; for a single file it is the source path itself.
    const movedChildren = await listFilesRecursive(targetSpace, srcPath);
    const oldPaths = movedChildren.length > 0 ? movedChildren : [srcPath];

    await moveFile(targetSpace, srcPath, destination);
    await Promise.all([
      renameFileMeta(targetSpace, srcPath, destination),
      renameFileMetaByPrefix(targetSpace, srcPath, destination),
    ]).catch(err => {
      log.warn(`renameFileMeta error for space ${targetSpace}, ${srcPath} → ${destination}: ${err}`);
    });
    await writeFileTombstones(targetSpace, oldPaths);
    emitWebhookEvent({ event: 'file.updated', spaceId: targetSpace, entry: { path: destination, previousPath: srcPath }, ...webhookToken(req) });
    res.json({ from: srcPath, to: destination });
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.warn(`moveFile error for space ${targetSpace}, ${srcPath} → ${destination}: ${err}`);
    res.status(500).json({ error: 'Failed to move path' });
  }
});


// Extensions whose content can execute script when rendered inline by a
// browser — always served as attachments (stored-XSS guard).
const ACTIVE_CONTENT_EXTS = new Set(['.html', '.htm', '.svg', '.xml', '.xhtml']);

// MIME lookup for downloads now comes from the shared table in `files/mime.ts` — see
// `contentTypeForDownload`. The local copy that used to live here listed a different set of
// extensions than the processing path did, which is the drift that let a `.png` be served correctly
// while being *processed* as `application/octet-stream`.
