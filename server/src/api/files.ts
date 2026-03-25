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

import express, { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import fs from 'fs/promises';
import path from 'path';
import { requireSpaceAuth, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import {
  readFileBytes,
  writeFileBytes,
  listDir,
  deleteFile,
  createDir,
  moveFile,
} from '../files/files.js';
import { checkQuota, QuotaError } from '../quota/quota.js';
import { resolveSafePath, spaceRoot } from '../files/sandbox.js';
import { col } from '../db/mongo.js';
import type { FileTombstoneDoc } from '../config/types.js';
import { v4 as uuidv4 } from 'uuid';
import { resolveMemberSpaces, resolveWriteTarget } from '../spaces/proxy.js';

export const filesRouter = Router();

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Validate and return the `path` query param; 404 if missing. */
function requireQueryPath(req: Request, res: Response): string | null {
  const p = req.query['path'];
  if (typeof p !== 'string' || !p.trim()) {
    res.status(400).json({ error: 'Missing required query parameter: path' });
    return null;
  }
  return p;
}

/**
 * Reject requests whose Content-Length exceeds `maxUploadBodyBytes` from
 * config. Must run BEFORE body parsers so the limit check fires early.
 */
function enforceSizeLimit(req: Request, res: Response, next: NextFunction): void {
  const limit = getConfig().maxUploadBodyBytes;
  if (limit !== undefined) {
    const cl = parseInt(req.headers['content-length'] ?? '', 10);
    if (!isNaN(cl) && cl > limit) {
      res
        .status(413)
        .json({ error: `Payload too large. Maximum upload size is ${limit} bytes.` });
      return;
    }
  }
  next();
}

// ── GET /api/files/:spaceId ───────────────────────────────────────────────────
// Stat the path: directory → JSON list, file → stream bytes.
filesRouter.get('/:spaceId', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const filePath = req.query['path'];
  const normalised = typeof filePath === 'string' && filePath.trim() ? filePath : '.';
  const memberIds = resolveMemberSpaces(spaceId);

  // Directory listing — aggregate across all member spaces
  // Try to find the first member where the path resolves successfully
  let foundMid: string | null = null;
  let absPath = '';
  let stat: Awaited<ReturnType<typeof fs.stat>> | null = null;

  for (const mid of memberIds) {
    try {
      const p = resolveSafePath(mid, normalised);
      const s = await fs.stat(p);
      foundMid = mid;
      absPath = p;
      stat = s;
      break;
    } catch {
      continue;
    }
  }

  if (!foundMid || !stat) {
    // For directory listing at root, aggregate even if some members have no dir
    if (normalised === '.') {
      const allEntries: { name: string; type: 'file' | 'dir'; size?: number }[] = [];
      const seen = new Set<string>();
      for (const mid of memberIds) {
        try {
          const entries = await listDir(mid, normalised);
          for (const e of entries) {
            if (!seen.has(e.name)) { seen.add(e.name); allEntries.push(e); }
          }
        } catch { /* member may have no files dir */ }
      }
      res.json({ path: normalised, type: 'dir', entries: allEntries });
      return;
    }
    res.status(404).json({ error: 'Path not found' });
    return;
  }

  if (stat.isDirectory()) {
    // Aggregate directory entries across all member spaces
    const allEntries: { name: string; type: 'file' | 'dir'; size?: number }[] = [];
    const seen = new Set<string>();
    for (const mid of memberIds) {
      try {
        const entries = await listDir(mid, normalised);
        for (const e of entries) {
          if (!seen.has(e.name)) { seen.add(e.name); allEntries.push(e); }
        }
      } catch { /* dir may not exist in this member */ }
    }
    res.json({ path: normalised, type: 'dir', entries: allEntries });
    return;
  }

  // File download — serve from the first member that has it
  try {
    const bytes = await readFileBytes(foundMid, normalised);
    const ext = path.extname(normalised).toLowerCase();
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream';
    res
      .status(200)
      .setHeader('Content-Type', contentType)
      .setHeader('Content-Length', bytes.length)
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(bytes);
  } catch (err) {
    log.warn(`readFileBytes error for space ${foundMid}, path ${normalised}: ${err}`);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// ── POST /api/files/:spaceId/mkdir ────────────────────────────────────────────
filesRouter.post(
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

// ── POST /api/files/:spaceId ──────────────────────────────────────────────────
// Write a file. Accepts raw bytes (any non-JSON Content-Type) or
// JSON { content: string, encoding?: 'utf8' | 'base64' }.
filesRouter.post(
  '/:spaceId',
  globalRateLimit,
  requireSpaceAuth,
  denyReadOnly,
  enforceSizeLimit,
  // Raw-body capture for non-JSON content types
  (req: Request, res: Response, next: NextFunction): void => {
    if (req.is('application/json')) { next(); return; }
    express.raw({ type: '*/*', limit: getConfig().maxUploadBodyBytes ?? '50mb' })(req, res, next);
  },
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

    const filePath = requireQueryPath(req, res);
    if (filePath === null) return;

    try {
      let sha256: string;
      let incomingBytes = 0;

      if (Buffer.isBuffer(req.body)) {
        incomingBytes = req.body.length;
      } else if (req.body && typeof req.body === 'object' && typeof req.body.content === 'string') {
        const encoding: string = req.body.encoding ?? 'utf8';
        if (encoding !== 'utf8' && encoding !== 'base64') {
          res.status(400).json({ error: "encoding must be 'utf8' or 'base64'" });
          return;
        }
        incomingBytes = Buffer.byteLength(req.body.content as string, encoding as BufferEncoding);
      } else {
        res
          .status(400)
          .json({
            error:
              'Send file content as a raw body (any Content-Type) or JSON { content: string, encoding?: "utf8"|"base64" }',
          });
        return;
      }

      // Storage quota check — rejects with 507 if hard limit exceeded
      let quotaResult;
      try {
        quotaResult = await checkQuota('files');
      } catch (err) {
        if (err instanceof QuotaError) {
          res.status(507).json({ error: err.message, storageExceeded: true });
          return;
        }
        throw err;
      }

      if (Buffer.isBuffer(req.body)) {
        ({ sha256 } = await writeFileBytes(targetSpace, filePath, req.body));
      } else {
        const encoding = (req.body.encoding ?? 'utf8') as BufferEncoding;
        const buf = Buffer.from(req.body.content as string, encoding);
        ({ sha256 } = await writeFileBytes(targetSpace, filePath, buf));
      }

      const response: { path: string; sha256: string; storageWarning?: boolean } = { path: filePath, sha256 };
      if (quotaResult.softBreached) response.storageWarning = true;
      res.status(201).json(response);
    } catch (err) {
      if (err instanceof RangeError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.warn(`writeFile error for space ${targetSpace}, path ${filePath}: ${err}`);
      res.status(500).json({ error: 'Failed to write file' });
    }
  },
);

// ── DELETE /api/files/:spaceId ────────────────────────────────────────────────
// Deletes a file. Deleting a directory requires { confirm: true } in the JSON body.
filesRouter.delete('/:spaceId', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
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
  } catch (err) {
    res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    return;
  }

  let stat: Awaited<ReturnType<typeof fs.stat>>;
  try {
    stat = await fs.stat(absPath);
  } catch {
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
      await fs.rm(absPath, { recursive: true, force: false });
      log.info(`Deleted directory ${absPath} (space: ${targetSpace})`);
      res.status(204).end();
    } catch (err) {
      log.warn(`rm dir error for space ${targetSpace}, path ${filePath}: ${err}`);
      res.status(500).json({ error: 'Failed to delete directory' });
    }
    return;
  }

  try {
    await deleteFile(targetSpace, filePath);
    const tombstone: FileTombstoneDoc = {
      _id: uuidv4(),
      spaceId: targetSpace,
      path: filePath.replace(/\\/g, '/'),
      deletedAt: new Date().toISOString(),
    };
    await col<FileTombstoneDoc>(`${targetSpace}_file_tombstones`).insertOne(tombstone as never);
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
filesRouter.patch('/:spaceId', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
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
    await moveFile(targetSpace, srcPath, destination);
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

// ── MIME type lookup (basic set) ─────────────────────────────────────────────
const MIME_MAP: Record<string, string> = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.ts': 'text/typescript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.yaml': 'text/yaml; charset=utf-8',
  '.yml': 'text/yaml; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
};
