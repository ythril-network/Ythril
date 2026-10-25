/**
 * Review's forks over REST (/api/brain/spaces/:spaceId/forks): the list, and the resolve of one.
 *
 * Two copies of a fact at one version with different text are kept as a fork beside the first (`brain/forks.ts` says why and what a resolve does).
 * Both routes are thin: the act, the caps and every refusal's sentence are `brain/forks.ts`'s, the same functions MCP `list_forks` and
 * `resolve_fork` call, so the doors cannot disagree about either.
 */
import { Router } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { answeredUnknownSpace, writeSpaceOf } from '../write-target-answer.js';
import { listForks, resolveFork, ForkRefusal } from '../../brain/forks.js';
import { webhookToken } from './_shared.js';

export const forksRouter = Router();

// GET /api/brain/spaces/:spaceId/forks — the forks of the space, each beside its parent, paged by `skip` and `limit`.
forksRouter.get('/spaces/:spaceId/forks', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  try {
    res.json(await listForks(spaceId, { skip: req.query['skip'], limit: req.query['limit'] }));
  } catch (err) {
    if (err instanceof ForkRefusal) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});

// POST /api/brain/spaces/:spaceId/forks/:forkId/resolve {keep: 'fork' | 'parent'} — keep one version, delete the fork, repoint what named it.
forksRouter.post('/spaces/:spaceId/forks/:forkId/resolve', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  // A resolve writes: the retired `targetSpace` is refused by name and a space that is not configured is answered by the one existence rule.
  if (writeSpaceOf(req, res, spaceId) === null) return;
  try {
    res.json(await resolveFork(spaceId, req.params['forkId'], (req.body as { keep?: unknown } | undefined)?.keep, webhookToken(req)));
  } catch (err) {
    if (err instanceof ForkRefusal) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});
