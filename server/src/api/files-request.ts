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
import { answerUnknownSpace } from '../spaces/unknown-space.js';
import { retiredAddressingQueryError } from '../brain/retired-write-fields.js';

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
 * The space a file route names, or `null` after answering: the one place the existence answer is built (`answerUnknownSpace`), so a route
 * cannot name a space the instance does not have - or a personal view, which holds no files of its own - and reach the filesystem with it.
 */
export function requireKnownSpace(req: Request, res: Response): string | null {
  const spaceId = req.params['spaceId'] as string;
  const unknown = answerUnknownSpace(req, spaceId);
  if (unknown) {
    res.status(unknown.status).json(unknown.body);
    return null;
  }
  return spaceId;
}

/** The space a write route names, which is the space it writes to. */
export interface WriteTarget { spaceId: string }
/** A {@link WriteTarget} and the path the route acts on. */
export interface WritePath extends WriteTarget { path: string }

/**
 * The space a file WRITE route names, or `null` after answering: the retired `?targetSpace=` is refused by name (`400`), and an id that
 * is not a configured space is answered as such (`requireKnownSpace`). The route's guard has judged reach and the rung on the space the
 * path names; a write lands in that space and in no other, since a view never writes.
 */
export function requireWriteTarget(req: Request, res: Response): WriteTarget | null {
  const retired = retiredAddressingQueryError(req.query);
  if (retired) { res.status(400).json({ error: retired }); return null; }
  const spaceId = requireKnownSpace(req, res);
  return spaceId === null ? null : { spaceId };
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
