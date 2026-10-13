/**
 * Request-shape helpers shared by every file-store route.
 *
 * ## Why they are here rather than in the module that needed them first
 *
 * `api/files.ts` is a frozen god-file, and G-4 is the task to move its route bodies out. The upload route was
 * the first to go — and it uses all four of these, while the routes that stay use three. Taking them along
 * would have left a copy behind, which is this codebase's most expensive defect: one rule, two
 * implementations, and the weaker one wins silently.
 *
 * So they moved sideways instead. That is the whole reason this module exists, and it is the shape the rest of
 * G-4 should follow: as each route leaves, whatever it shares goes here rather than being duplicated.
 */

import type { Request, Response, NextFunction } from 'express';
import { getConfig } from '../config/loader.js';
import { resolveWriteTarget } from '../spaces/proxy.js';

/** Extract token identification from the request for webhook payloads. */
export function webhookToken(req: Request): { tokenId?: string; tokenLabel?: string } {
  const t = req.authToken;
  if (!t) return {};
  return {
    tokenId: 'id' in t ? (t as { id: string }).id : undefined,
    tokenLabel: t.name,
  };
}

/**
 * Parse an optional `?ttlDays=` upload query param (per-record file TTL, F12). Must be a query param,
 * not a body field, so it works for raw-binary uploads too. A non-negative number wins; `0` means
 * "never expire" (explicit); anything invalid/absent → undefined (fall back to the space default).
 */
export function parseTtlDaysQuery(req: Request): number | undefined {
  const raw = req.query['ttlDays'];
  if (raw == null || raw === '') return undefined;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : undefined;
}

/** Validate and return the `path` query param; `400` if missing. */
export function requireQueryPath(req: Request, res: Response): string | null {
  const p = req.query['path'];
  if (typeof p !== 'string' || !p.trim()) {
    res.status(400).json({ error: 'Missing required query parameter: path' });
    return null;
  }
  return p;
}

/**
 * The space a file route names, or `null` after answering `404` — the one place that answer is built, so a route cannot name a
 * space the instance does not have and reach the filesystem with it.
 */
export function requireKnownSpace(req: Request, res: Response): string | null {
  const spaceId = req.params['spaceId'] as string;
  if (!getConfig().spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return null;
  }
  return spaceId;
}

/** The space a write route names, and the space it writes to. */
export interface WriteTarget { spaceId: string; targetSpace: string }
/** A {@link WriteTarget} and the path the route acts on. */
export interface WritePath extends WriteTarget { path: string }

/**
 * The space a file WRITE route names and the space it writes to (`?targetSpace=`, which a proxy space narrows), or `null` after
 * answering: `404` for an unknown space, `400` for a target the space may not write to. `requireKnownSpace` then `resolveWriteTarget`,
 * asked together so no write route can ask the second without the first.
 */
export function requireWriteTarget(req: Request, res: Response): WriteTarget | null {
  const spaceId = requireKnownSpace(req, res);
  if (spaceId === null) return null;
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return null; }
  return { spaceId, targetSpace: wt.target };
}

/**
 * {@link requireWriteTarget} and the `path` the route acts on ({@link requireQueryPath}): the prologue every file route that writes
 * at a caller's path begins with, answered in this order, once.
 */
export function requireWritePath(req: Request, res: Response): WritePath | null {
  const target = requireWriteTarget(req, res);
  if (target === null) return null;
  const p = requireQueryPath(req, res);
  return p === null ? null : { ...target, path: p };
}

/**
 * Reject requests whose Content-Length exceeds `maxUploadBodyBytes` from
 * config. Must run BEFORE body parsers so the limit check fires early.
 */
export function enforceSizeLimit(req: Request, res: Response, next: NextFunction): void {
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
