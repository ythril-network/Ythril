/**
 * A space's schema versions - list them, read one, compare two (bundle-267, Q-742): `GET /api/spaces/:id/schema-versions`, one route with the
 * tool's parameters. No `fp` the list, `fp` one version, `fp` and `against` (`current` or a fingerprint) the comparison; `against` alone is
 * `400 against_needs_fp`. Mounted at `/api/spaces` beside the spaces router, in its own file as `spaces-schema-layers.ts` is.
 *
 * The decisions are `spaces/schema-versions-acts.ts` (`schemaVersionsToolAct`), the act MCP `space_schema_versions` runs, so one capability has
 * one request shape on both doors. Rights come from `ROUTE_RIGHTS`: `schema: read`. A personal view is answered as an unknown space, as
 * `GET /meta` answers it (a schema-area door takes no view).
 */
import { Router } from 'express';
import { requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { queryInt } from '../brain/result-budget.js';
import { networkIdsSharedWithCaller } from '../networks/network-spaces.js';
import { schemaVersionsToolAct } from '../spaces/schema-versions-acts.js';
import { sendCaughtFailure } from './send-failure.js';
import { sendSpaceActAnswer } from './send-act-answer.js';

export const spaceSchemaVersionsRouter = Router();

// GET /api/spaces/:id/schema-versions[?fp=<fp>[&against=current|<fp>]] - the list (one page), one version, or a comparison.
spaceSchemaVersionsRouter.get('/:id/schema-versions', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    sendSpaceActAnswer(res, await schemaVersionsToolAct(spaceId, {
      fp: req.query['fp'], against: req.query['against'], skip: queryInt(req.query['skip']),
      maxChars: queryInt(req.query['maxChars']), maxBytes: queryInt(req.query['maxBytes']), maxTokens: queryInt(req.query['maxTokens']),
    }, { shared: networkIdsSharedWithCaller(spaceId, req.authToken as object | undefined), transport: 'rest' }));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-versions', err);
  }
});
