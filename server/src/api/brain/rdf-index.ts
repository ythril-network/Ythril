/**
 * The REST route of a space's SPARQL triple index rebuild (bundle-273, Q-764 S4; contract row 6): `POST
 * /api/brain/spaces/:spaceId/rdf-index/rebuild`, the twin of the MCP tool `space_rdf_rebuild` (and its tool door `POST /api/space_rdf_rebuild`).
 *
 * The start and its refusal live in `rdf/triple-index/rebuild.ts` (`startTripleIndexRebuild`), so both doors answer alike: `{ status, spaceId }`
 * with `status` `started` or `running`, or a refusal: `409 rdf_off`, `409 rebuild_busy` (another instance's build holds the build row) or
 * `503 shutting_down`. The route is audited as `space.rdf.rebuild` (`audit/middleware.ts`), the operation the
 * tool records (`mcp/audit-map.ts`); the rung is the knowledge area's `admin` (`ROUTE_RIGHTS`, as the tool's `TOOL_RIGHTS` row).
 */
import { Router, type Request, type Response } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { answeredUnknownSpace } from '../write-target-answer.js';
import { startTripleIndexRebuild } from '../../rdf/triple-index/rebuild.js';

export const rdfIndexRouter = Router();

// POST /api/brain/spaces/:spaceId/rdf-index/rebuild - start a rebuild of the space's triple index; answered once it holds the build row.
rdfIndexRouter.post('/spaces/:spaceId/rdf-index/rebuild', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req: Request, res: Response): Promise<void> => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  const started = await startTripleIndexRebuild(spaceId);
  if (!started.ok) {
    res.status(started.status).json({ error: started.error, code: started.code });
    return;
  }
  res.json({ status: started.status, spaceId: started.spaceId });
});
