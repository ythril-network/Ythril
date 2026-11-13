/**
 * A space's schema versions - list them, read one, compare two (bundle-267, Q-742). Mounted at `/api/spaces` beside the spaces router, in its
 * own file as `spaces-schema-layers.ts` is.
 *
 * The decisions are `spaces/schema-versions-acts.ts`, shared with MCP `space_schema_versions`. Rights come from `ROUTE_RIGHTS`: `schema: read`
 * on each. A personal view is answered as an unknown space, as `GET /meta` answers it (a schema-area door takes no view).
 */
import { Router, type Request, type Response } from 'express';
import { requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { queryInt } from '../brain/result-budget.js';
import { networkIdsSharedWithCaller } from '../networks/network-spaces.js';
import {
  listSchemaVersionsAct, readSchemaVersionAct, diffSchemaVersionAct, type SchemaVersionsActResult, type SchemaVersionsCaller,
} from '../spaces/schema-versions-acts.js';
import { sendCaughtFailure } from './send-failure.js';

export const spaceSchemaVersionsRouter = Router();

function send(res: Response, r: SchemaVersionsActResult): void {
  if ('error' in r) { res.status(r.status).json({ error: r.error, ...(r.code ? { code: r.code } : {}) }); return; }
  res.status(r.status).json(r.body);
}

const callerOf = (req: Request, spaceId: string): SchemaVersionsCaller =>
  ({ shared: networkIdsSharedWithCaller(spaceId, req.authToken as object | undefined), transport: 'rest' });

// GET /api/spaces/:id/schema-versions - the versions the space's config and rows hold and its records carry, one page.
spaceSchemaVersionsRouter.get('/:id/schema-versions', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    send(res, await listSchemaVersionsAct(spaceId, {
      skip: queryInt(req.query['skip']), maxChars: queryInt(req.query['maxChars']),
      maxBytes: queryInt(req.query['maxBytes']), maxTokens: queryInt(req.query['maxTokens']),
    }, callerOf(req, spaceId)));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-versions', err);
  }
});

// GET /api/spaces/:id/schema-versions/:fp - one version's schema.
spaceSchemaVersionsRouter.get('/:id/schema-versions/:fp', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    send(res, await readSchemaVersionAct(spaceId, req.params['fp'] as string, {
      maxChars: queryInt(req.query['maxChars']), maxBytes: queryInt(req.query['maxBytes']), maxTokens: queryInt(req.query['maxTokens']),
    }, callerOf(req, spaceId)));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-versions/:fp', err);
  }
});

// GET /api/spaces/:id/schema-versions/:fp/diff?against=current|<fp> - what changed from :fp to `against` (the current version by default).
spaceSchemaVersionsRouter.get('/:id/schema-versions/:fp/diff', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    send(res, await diffSchemaVersionAct(spaceId, req.params['fp'] as string, req.query['against'], {
      maxChars: queryInt(req.query['maxChars']), maxBytes: queryInt(req.query['maxBytes']), maxTokens: queryInt(req.query['maxTokens']),
    }, callerOf(req, spaceId)));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-versions/:fp/diff', err);
  }
});
