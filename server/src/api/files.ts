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
import { requireSpaceAuth } from '../auth/middleware.js';
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

  let absPath: string;
  try {
    absPath = resolveSafePath(spaceId, normalised);
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
    try {
      const entries = await listDir(spaceId, normalised);
      res.json({ path: normalised, type: 'dir', entries });
    } catch (err) {
      log.warn(`listDir error for space ${spaceId}, path ${normalised}: ${err}`);
      res.status(500).json({ error: 'Failed to list directory' });
    }
    return;
  }

  // File download
  try {
    const bytes = await readFileBytes(spaceId, normalised);
    // Resolve Content-Type from extension (basic set)
    const ext = path.extname(normalised).toLowerCase();
    const contentType = MIME_MAP[ext] ?? 'application/octet-stream';
    res
      .status(200)
      .setHeader('Content-Type', contentType)
      .setHeader('Content-Length', bytes.length)
      .setHeader('X-Content-Type-Options', 'nosniff')
      .send(bytes);
  } catch (err) {
    log.warn(`readFileBytes error for space ${spaceId}, path ${normalised}: ${err}`);
    res.status(500).json({ error: 'Failed to read file' });
  }
});

// ── POST /api/files/:spaceId/mkdir ────────────────────────────────────────────
filesRouter.post(
  '/:spaceId/mkdir',
  globalRateLimit,
  requireSpaceAuth,
  async (req, res) => {
    const spaceId = req.params['spaceId'] as string;
    const cfg = getConfig();
    if (!cfg.spaces.some(s => s.id === spaceId)) {
      res.status(404).json({ error: `Space '${spaceId}' not found` });
      return;
    }

    const dirPath = requireQueryPath(req, res);
    if (dirPath === null) return;

    try {
      await createDir(spaceId, dirPath);
      res.status(201).json({ created: dirPath });
    } catch (err) {
      if (err instanceof RangeError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.warn(`createDir error for space ${spaceId}, path ${dirPath}: ${err}`);
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
        ({ sha256 } = await writeFileBytes(spaceId, filePath, req.body));
      } else {
        const encoding = (req.body.encoding ?? 'utf8') as BufferEncoding;
        const buf = Buffer.from(req.body.content as string, encoding);
        ({ sha256 } = await writeFileBytes(spaceId, filePath, buf));
      }

      const response: { path: string; sha256: string; storageWarning?: boolean } = { path: filePath, sha256 };
      if (quotaResult.softBreached) response.storageWarning = true;
      res.status(201).json(response);
    } catch (err) {
      if (err instanceof RangeError) {
        res.status(400).json({ error: err.message });
        return;
      }
      log.warn(`writeFile error for space ${spaceId}, path ${filePath}: ${err}`);
      res.status(500).json({ error: 'Failed to write file' });
    }
  },
);

// ── DELETE /api/files/:spaceId ────────────────────────────────────────────────
// Deletes a file. Deleting a directory requires { confirm: true } in the JSON body.
filesRouter.delete('/:spaceId', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const filePath = requireQueryPath(req, res);
  if (filePath === null) return;

  let absPath: string;
  try {
    absPath = resolveSafePath(spaceId, filePath);
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
    // Require explicit confirmation before recursive delete
    if (!req.body || req.body.confirm !== true) {
      res.status(422).json({
        error:
          'Deleting a directory requires { "confirm": true } in the request body.',
      });
      return;
    }
    // Safety check: cannot delete the space root itself
    if (absPath === spaceRoot(spaceId)) {
      res.status(400).json({ error: 'Cannot delete the space root directory.' });
      return;
    }
    try {
      await fs.rm(absPath, { recursive: true, force: false });
      log.info(`Deleted directory ${absPath} (space: ${spaceId})`);
      res.status(204).end();
    } catch (err) {
      log.warn(`rm dir error for space ${spaceId}, path ${filePath}: ${err}`);
      res.status(500).json({ error: 'Failed to delete directory' });
    }
    return;
  }

  // Regular file
  try {
    await deleteFile(spaceId, filePath);
    // Write a file tombstone so peers can replicate the deletion on their next sync.
    const tombstone: FileTombstoneDoc = {
      _id: uuidv4(),
      spaceId,
      path: filePath.replace(/\\/g, '/'),
      deletedAt: new Date().toISOString(),
    };
    await col<FileTombstoneDoc>(`${spaceId}_file_tombstones`).insertOne(tombstone as never);
    res.status(204).end();
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.warn(`deleteFile error for space ${spaceId}, path ${filePath}: ${err}`);
    res.status(500).json({ error: 'Failed to delete file' });
  }
});

// ── PATCH /api/files/:spaceId ─────────────────────────────────────────────────
// Move/rename a file or directory. Body: { destination: string }
filesRouter.patch('/:spaceId', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }

  const srcPath = requireQueryPath(req, res);
  if (srcPath === null) return;

  const destination = req.body?.destination;
  if (typeof destination !== 'string' || !destination.trim()) {
    res.status(400).json({ error: 'Body must contain { destination: string }' });
    return;
  }

  try {
    await moveFile(spaceId, srcPath, destination);
    res.json({ from: srcPath, to: destination });
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: err.message });
      return;
    }
    log.warn(`moveFile error for space ${spaceId}, ${srcPath} → ${destination}: ${err}`);
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
