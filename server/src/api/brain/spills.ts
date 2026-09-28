/**
 * `GET /api/brain/spills/:id` — the REST half of MCP `read_spill` (Q-92). One act behind both.
 *
 * Authenticated, and deliberately NOT area-scoped by a rights row: the spill names no space, so a row would
 * resolve to none and check nothing. `readSpillAct` checks the issuer and knowledge read on every member
 * space the spill recorded — see its note. `NOT_AREA_SCOPED` in `auth/space-rights.ts` says the same.
 */
import { Router, type Request, type Response } from 'express';
import { requireAuth } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { readSpillAct, readSpillByPath } from '../../brain/read-spill-act.js';
import { queryInt } from '../../brain/result-budget.js';
import { restToolCaller } from '../rest-tool-caller.js';

export const spillsRouter = Router();

spillsRouter.get('/spills/:id', globalRateLimit, requireAuth, async (req, res) => {
  const caller = restToolCaller(req);
  const r = await readSpillAct({
    id: req.params['id'],
    skip: queryInt(req.query['skip']),
    maxChars: queryInt(req.query['maxChars']),
    maxBytes: queryInt(req.query['maxBytes']),
    maxTokens: queryInt(req.query['maxTokens']),
    tokenId: caller.tokenId,
    rights: caller.rights,
    accessibleSpaceIds: null,
    transport: caller.transport,
  });
  // A spill holds records a search returned: never cached, never sniffed.
  res.setHeader('Cache-Control', 'no-store');
  res.status(r.status).json(r.body);
});

/**
 * The files GET's half of the deprecated `path` (Q-92): when `filePath` is a spill's, answer it from the spill
 * store under the store's own rule and return `true`; otherwise `false`, and the caller serves the file.
 * Here rather than in `api/files.ts` so the files router keeps one line of it. Removed at the next major.
 */
export async function answerSpillPath(req: Request, res: Response, filePath: string): Promise<boolean> {
  const caller = restToolCaller(req);
  const spill = await readSpillByPath(filePath, {
    tokenId: caller.tokenId, rights: caller.rights, accessibleSpaceIds: null, transport: caller.transport,
  });
  if (!spill) return false;
  res.setHeader('Cache-Control', 'no-store');
  res.status(spill.status).json(spill.body);
  return true;
}
