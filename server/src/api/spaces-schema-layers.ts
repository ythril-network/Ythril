/**
 * A space's network schema layers — see them, reorder them (`F-39.3`). Mounted at `/api/spaces` beside the spaces
 * router, in its own file because `api/spaces.ts` is on the god-file ratchet.
 *
 * The decisions are `spaces/schema-layers-acts.ts`, shared with MCP `space_schema_layers` and
 * `space_set_network_precedence`. Rights come from `ROUTE_RIGHTS`: `schema: read` to see, `schema: admin` to reorder.
 */
import { Router } from 'express';
import { denyReadOnly, requireSpaceAuthMfaScoped, requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { NetworkPrecedenceBody, schemaLayersAct, setNetworkPrecedenceAct, type SchemaLayersActResult } from '../spaces/schema-layers-acts.js';

export const spaceSchemaLayersRouter = Router();

function send(res: import('express').Response, r: SchemaLayersActResult): void {
  if ('error' in r) { res.status(r.status).json({ error: r.error }); return; }
  res.status(r.status).json(r.body);
}

// GET /api/spaces/:id/schema-layers — own definitions, each network's layer in precedence, and the clashes.
spaceSchemaLayersRouter.get('/:id/schema-layers', globalRateLimit, requireSpaceAuthScoped('id'), (req, res) => {
  send(res, schemaLayersAct(req.params['id'] as string));
});

// PUT /api/spaces/:id/network-precedence — which network wins a clash, highest first.
spaceSchemaLayersRouter.put('/:id/network-precedence', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, (req, res) => {
  // Parsed here as well as in the act: the same-parameters gate reads a route's accepted keys off this call.
  const parsed = NetworkPrecedenceBody.safeParse(req.body);
  if (!parsed.success) { res.status(400).json({ error: parsed.error.message }); return; }
  send(res, setNetworkPrecedenceAct(req.params['id'] as string, parsed.data));
});
