/**
 * Review's forks over REST (/api/brain/spaces/:spaceId/forks): the list, and the resolve of one, for every kind that forks (Q-624).
 *
 * Both routes are thin: the act, the caps and every refusal's sentence are `brain/forks.ts`'s, the same functions MCP `list_forks` and `resolve_fork`
 * call, with the same parameters (`ForkListParams`, `ForkResolveParams`), so the doors cannot disagree. A resolve's audit entry is built by the fork
 * module from the resolution and handed to the audit middleware as it is (`req.auditChangesExplicit`): a diff of snapshots records nothing for it.
 */
import { Router } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { answeredUnknownSpace, writeSpaceOf } from '../write-target-answer.js';
import { listForks, resolveFork, ForkRefusal } from '../../brain/forks.js';
import { webhookToken } from './_shared.js';

export const forksRouter = Router();

// GET /api/brain/spaces/:spaceId/forks?kind=&skip=&limit= — the forks of the space, every kind or the one named, each beside its parent.
// Validated by `ForkListParams` inside `listForks`.
forksRouter.get('/spaces/:spaceId/forks', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  try {
    res.json(await listForks(spaceId, { kind: req.query['kind'], skip: req.query['skip'], limit: req.query['limit'] }));
  } catch (err) {
    if (err instanceof ForkRefusal) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});

// POST /api/brain/spaces/:spaceId/forks/:forkId/resolve {kind, keep, ifMatchSeq, ifMatchParentSeq}, all required (ForkResolveParams.parse via
// parseResolveParams) — keep one version on THIS instance, delete this instance's copy of the fork, repoint what named it.
forksRouter.post('/spaces/:spaceId/forks/:forkId/resolve', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  // A resolve writes: the retired `targetSpace` is refused by name and a space that is not configured is answered by the one existence rule.
  if (writeSpaceOf(req, res, spaceId) === null) return;
  const body = (req.body ?? {}) as Record<string, unknown>;
  try {
    const { resolution, audit } = await resolveFork(spaceId, {
      kind: body['kind'], forkId: req.params['forkId'], keep: body['keep'], ifMatchSeq: body['ifMatchSeq'], ifMatchParentSeq: body['ifMatchParentSeq'],
    }, webhookToken(req));
    req.auditChangesExplicit = audit;
    res.json(resolution);
  } catch (err) {
    if (err instanceof ForkRefusal) { res.status(err.status).json({ error: err.message }); return; }
    throw err;
  }
});
