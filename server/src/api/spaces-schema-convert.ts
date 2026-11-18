/**
 * A space's schema conversion - start one, read how it went (Q-746, bundle-284 design r5 section 2.3): `POST` and `GET /api/spaces/:id/schema-convert`.
 * Mounted at `/api/spaces` beside the spaces router, in its own file as `spaces-schema-versions.ts` is, because `api/spaces.ts` is on the god-file ratchet.
 *
 * The decisions are `spaces/schema-convert-acts.ts` (`schemaConvertStartAct`, `schemaConvertStatusAct`), the acts MCP `space_schema_convert` and
 * `space_schema_conversion` run, so one capability has one request shape on both doors. The body goes to the act whole and the rights are decided
 * inside it (the knowledge rung, and for a start the space's admin right), so no mounting can leave them out; the guards here are the door's own
 * (rate limit, authentication and reach, a second factor and the read-only refusal for a start). Rights rows come from `ROUTE_RIGHTS`:
 * `knowledge: admin` for the start, `knowledge: read` for the read.
 */
import { Router } from 'express';
import { denyReadOnly, requireSpaceAuthMfaScoped, requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { schemaConvertStartAct, schemaConvertStatusAct } from '../spaces/schema-convert-acts.js';
import { schemaConvertCallerOf } from '../spaces/schema-convert-terms.js';
import { viewReadOfRequest } from '../spaces/read-scope.js';
import { sendCaughtFailure } from './send-failure.js';
import { sendSpaceActAnswer } from './send-act-answer.js';
import { convertStartChanges } from '../audit/audit-changes.js';

/** The lowest status an act answers a refusal with: below it the start was accepted. */
const FIRST_REFUSAL_STATUS = 400;

export const spaceSchemaConvertRouter = Router();

/** Who is asking, as the acts need it (`schemaConvertCallerOf`: the one reading, which the schema save's price reads too). */
const callerOf = schemaConvertCallerOf;

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

// GET /api/spaces/:id/schema-convert - the run as it stands (or { state: 'none' }); writes nothing. Takes the caller's own view (the guard's `viewRead`).
spaceSchemaConvertRouter.get('/:id/schema-convert', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const spaceId = req.params['id'] as string;
  try {
    sendSpaceActAnswer(res, await schemaConvertStatusAct(spaceId, callerOf(req), viewReadOfRequest(req, spaceId)));
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-convert', err);
  }
});
