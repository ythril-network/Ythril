/**
 * `ingest` (`F-31`): `POST /api/brain/spaces/:spaceId/ingest` starts a run, `GET …/ingest/:runId` reads it back.
 *
 * The whole sequence — the space, the proxy write target, the body, phase 0's refusals, the start — is
 * `beginIngest`, the module the MCP `ingest` tool calls too. This file only turns its answer into a status code.
 */
import { Router } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { beginIngest, ingestStatus } from '../../extractor/ingest-door.js';
import type { TokenRights } from '../../config/rights-shape.js';

export const ingestRouter = Router();

ingestRouter.post('/spaces/:spaceId/ingest', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const r = await beginIngest(req.params['spaceId'] as string, req.query['targetSpace'] as string | undefined, req.body,
    (req.authToken as { rights?: TokenRights } | undefined)?.rights);
  if (r.status === 202) { res.status(202).json({ runId: r.run.runId, conversationId: r.run.conversationId, phase: r.run.phase }); return; }
  res.status(r.status).json({ error: r.error, ...('refusals' in r ? { refusals: r.refusals } : {}) });
});

ingestRouter.get('/spaces/:spaceId/ingest/:runId', globalRateLimit, requireSpaceAuth, (req, res) => {
  const run = ingestStatus(req.params['spaceId'] as string, req.query['targetSpace'] as string | undefined, req.params['runId'] as string);
  if (!run) {
    res.status(404).json({ error: `No ingest run '${req.params['runId']}' in this space. Runs are held in memory, so a restart forgets them — not the records a finished run wrote.` });
    return;
  }
  res.json(run);
});
