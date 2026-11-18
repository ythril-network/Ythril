/**
 * A space's schema conversion - start one, read how it went (Q-746, bundle-284 design r5 section 2.3): `POST` and `GET /api/spaces/:id/schema-convert`.
 * Mounted at `/api/spaces` beside the spaces router, in its own file as `spaces-schema-versions.ts` is, because `api/spaces.ts` is on the god-file ratchet.
 *
 * The decisions are `spaces/schema-convert-acts.ts` (`schemaConvertStartAct`, `schemaConvertStatusAct`), the acts MCP `space_schema_convert` and
 * `space_schema_conversion` run, so one capability has one request shape on both doors. The body goes to the act whole and the rights are decided
 * inside it (the knowledge rung, and for a start the space's admin right), so no mounting can leave them out; the guards here are the door's own
 * (rate limit, authentication and reach, a second factor and the read-only refusal for a start). Rights rows come from `ROUTE_RIGHTS`:
 * `knowledge: admin` for the start, `knowledge: read` for the read.
 *
 * It also hands the MCP tools the same two acts (`useSchemaConvertActs`): the tool module is registered by the tools index, a module of the
 * server's largest import cycle, and does not name the acts so they stay out of it; this module is the one of the capability the application
 * always loads (it mounts the route) and no member of that cycle reaches.
 */
import { Router } from 'express';
import { denyReadOnly, requireSpaceAuthMfaScoped, requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { schemaConvertStartAct, schemaConvertStatusAct } from '../spaces/schema-convert-acts.js';
import { useSchemaConvertActs } from '../mcp/tools/schema-convert.js';
import type { TokenRights } from '../config/rights-shape.js';
import type { SchemaConvertCaller } from '../spaces/schema-convert-terms.js';
import { sendCaughtFailure } from './send-failure.js';
import { sendSpaceActAnswer } from './send-act-answer.js';
import { convertStartChanges } from '../audit/audit-changes.js';

useSchemaConvertActs({ start: schemaConvertStartAct, status: schemaConvertStatusAct });

/** The lowest status an act answers a refusal with: below it the start was accepted. */
const FIRST_REFUSAL_STATUS = 400;

export const spaceSchemaConvertRouter = Router();

/**
 * Who is asking, as the acts need it: the rights of the token the guards accepted, and the key the heavy-call rail counts a start against (the
 * token's id, or the address when it has none: the key `callTool` gives the tool, so both doors spend one allowance).
 */
const callerOf = (req: { authToken?: unknown; ip?: string }): SchemaConvertCaller => {
  const token = req.authToken as { id?: string; rights?: TokenRights } | undefined;
  return { rights: token?.rights, rateKey: token?.id ?? req.ip ?? '' };
};

// POST /api/spaces/:id/schema-convert - convert the records of the named types toward the space's current schema: { types: [{ kind, type }], steps? }.
spaceSchemaConvertRouter.post('/:id/schema-convert', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    const answer = await schemaConvertStartAct(spaceId, req.body, callerOf(req));
    // What the act accepted, for the audit entry (`schema.convert.start`): the types and the number of steps, never the steps' text.
    if (answer.status < FIRST_REFUSAL_STATUS) req.auditChangesExplicit = convertStartChanges(answer.body);
    sendSpaceActAnswer(res, answer);
  } catch (err) {
    sendCaughtFailure(res, 'POST /api/spaces/:id/schema-convert', err);
  }
});

// GET /api/spaces/:id/schema-convert - the run as it stands (or { state: 'none' }); writes nothing.
spaceSchemaConvertRouter.get('/:id/schema-convert', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    sendSpaceActAnswer(res, await schemaConvertStatusAct(spaceId, callerOf(req)));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-convert', err);
  }
});
