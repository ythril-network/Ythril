/**
 * REST doors of personal views (Q-531): the caller's own views, a copy to a token the caller manages, and the instance admin's three doors
 * (orphans, claim, purge) and migration report. Each is one capability whose MCP twin is `view_*` (`mcp/tools/views.ts`); the rules live in
 * `spaces/view-acts.ts` and are refused there, so this file only translates a request into an act and an answer.
 *
 * - `GET /api/views`, `POST /api/views {name, members}` - any token, read-only ones included: a view is a lens over what its owner
 *   already reads, and it writes nowhere. No `denyReadOnly`, and no area: the rights table calls these owner-scoped.
 * - `GET|PATCH|DELETE /api/views/:id` - the owner's only; another token's view is `view_not_found`, as an id that never existed.
 * - `POST /api/views/:id/copy {toTokenId}` - the guard and the second factor of managing that token.
 * - `GET /api/admin/views/orphans`, `POST /api/admin/views/claim {name}`, `POST /api/admin/views/retired/:id/purge {confirmOidcClaims}`,
 *   `GET /api/admin/views/migration` - the instance admin's.
 */
import { Router } from 'express';
import type { Request, Response, NextFunction } from 'express';
import { requireAuth, requireAdmin, requireAdminOrSpaceAdminMfa } from '../auth/middleware.js';
import { authRateLimit, globalRateLimit } from '../rate-limit/middleware.js';
import { ViewRefusal, viewOwnerOf } from '../config/views.js';
import {
  auditViewAct, claimUnclaimedView, copyViewTo, createView, deleteOwnView, getOwnView, listOwnViews, orphanAnswer,
  purgeRetiredSpaceId, refuseCopyByNonManager, updateView, viewsMigrationReport, type ViewActor, type ViewAuditDoor,
} from '../spaces/view-acts.js';
import { VIEW_OPERATIONS, auditAuthMethod, auditOidcSubject } from '../audit/middleware.js';

export const viewsRouter = Router();
export const adminViewsRouter = Router();

/** Who is acting, off the request's authenticated token. */
function actorOf(req: Request): ViewActor {
  const token = req.authToken as ViewActor['record'];
  return { record: token, rights: (token as { rights?: ViewActor['rights'] }).rights };
}

/** The audit door of a view act: the route PATTERN is the path, because the request path would carry the view's name. */
function doorOf(req: Request, pattern: string): ViewAuditDoor {
  const token = req.authToken;
  return {
    ip: req.ip ?? req.socket.remoteAddress ?? 'unknown',
    method: req.method,
    path: pattern,
    tokenId: token && 'id' in token ? token.id : null,
    tokenLabel: token?.name ?? null,
    authMethod: auditAuthMethod(token),
    oidcSubject: auditOidcSubject(token),
  };
}

/** Run an act and answer a refusal with its status and body; anything else is the error handler's. */
const act = (fn: (req: Request, res: Response) => void | Promise<void>) =>
  async (req: Request, res: Response, next: NextFunction): Promise<void> => {
    try {
      await fn(req, res);
    } catch (err) {
      if (err instanceof ViewRefusal) { res.status(err.status).json(err.body); return; }
      next(err);
    }
  };

const bodyOf = (req: Request): Record<string, unknown> => (req.body && typeof req.body === 'object' ? req.body as Record<string, unknown> : {});
const idOf = (req: Request): string => String(req.params['id'] ?? '');

// ── The caller's own views ─────────────────────────────────────────────────────────────────────────────────────────

viewsRouter.get('/', globalRateLimit, requireAuth, act((req, res) => {
  res.json({ views: listOwnViews(actorOf(req)) });
}));

viewsRouter.post('/', authRateLimit, requireAuth, act(async (req, res) => {
  const { name, members } = bodyOf(req);
  const made = createView(actorOf(req), { name, members });
  await auditViewAct(doorOf(req, '/api/views'), VIEW_OPERATIONS.created, made);
  res.status(201).json({ view: made.view });
}));

viewsRouter.get('/:id', globalRateLimit, requireAuth, act((req, res) => {
  res.json({ view: getOwnView(actorOf(req), idOf(req)) });
}));

viewsRouter.patch('/:id', globalRateLimit, requireAuth, act(async (req, res) => {
  const { name, members } = bodyOf(req);
  const changed = updateView(actorOf(req), idOf(req), { name, members });
  await auditViewAct(doorOf(req, '/api/views/:id'), VIEW_OPERATIONS.updated, changed);
  res.json({ view: changed.view });
}));

viewsRouter.delete('/:id', globalRateLimit, requireAuth, act(async (req, res) => {
  const gone = deleteOwnView(actorOf(req), idOf(req));
  await auditViewAct(doorOf(req, '/api/views/:id'), VIEW_OPERATIONS.deleted, gone);
  res.status(204).end();
}));

// A copy is a grant of reading to another token: the second factor and the admin door token management has.
// The caller who may manage no token is refused by the act's own rule first, so it gets `view_copy_forbidden` as on MCP, not the
// step-up guard's generic admin refusal.
const copierOrRefuse = (req: Request, res: Response, next: NextFunction): void => {
  try {
    refuseCopyByNonManager(actorOf(req).record);
  } catch (err) {
    if (err instanceof ViewRefusal) { res.status(err.status).json(err.body); return; }
    next(err);
    return;
  }
  next();
};

viewsRouter.post('/:id/copy', authRateLimit, requireAuth, copierOrRefuse, requireAdminOrSpaceAdminMfa, act(async (req, res) => {
  const given = copyViewTo(actorOf(req), idOf(req), bodyOf(req)['toTokenId'], bodyOf(req)['fromTokenId']);
  await auditViewAct(doorOf(req, '/api/views/:id/copy'), VIEW_OPERATIONS.copied, given);
  res.status(given.created ? 201 : 200).json({ view: given.view, created: given.created });
}));

// ── The instance admin's doors ─────────────────────────────────────────────────────────────────────────────────────

adminViewsRouter.get('/orphans', globalRateLimit, requireAdmin, act((_req, res) => {
  res.json(orphanAnswer());
}));

adminViewsRouter.post('/claim', authRateLimit, requireAdmin, act(async (req, res) => {
  const claimed = claimUnclaimedView(actorOf(req), bodyOf(req)['name']);
  await auditViewAct(doorOf(req, '/api/admin/views/claim'), VIEW_OPERATIONS.claimed, claimed);
  res.status(201).json({ view: claimed.view });
}));

adminViewsRouter.post('/retired/:id/purge', authRateLimit, requireAdmin, act(async (req, res) => {
  const { released } = await purgeRetiredSpaceId(idOf(req), { confirmOidcClaims: bodyOf(req)['confirmOidcClaims'] === true });
  const owner = viewOwnerOf(actorOf(req).record) ?? 'unknown';
  await auditViewAct(doorOf(req, '/api/admin/views/retired/:id/purge'), VIEW_OPERATIONS.purgedRetiredId, { ownerKey: owner, memberCount: 0 });
  // The id as released, as MCP answers it: a JSON value is not a log line, and escaping it here made one purge answer two ids.
  res.json({ released });
}));

adminViewsRouter.get('/migration', globalRateLimit, requireAdmin, act((_req, res) => {
  res.json(viewsMigrationReport());
}));
