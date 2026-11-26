/**
 * The SPARQL 1.1 Protocol's update operation over one space (bundle-272, Q-761; owner D-91: its own address):
 * `POST /api/brain/spaces/:spaceId/sparql/update` with an `application/sparql-update` body (the protocol's `using-graph-uri` and
 * `using-named-graph-uri` in the URL) or an urlencoded `update=` form. MCP `sparql_update` runs the same act (`spaces/sparql-update-act.ts`),
 * which owns every parameter, bound, refusal and count; this door reads the body off its wire and puts the answer back on it.
 *
 * ## What this door holds, and what it prevents
 *
 * - **A write without the write rung, or through a view.** The route's `ROUTE_RIGHTS` row asks `knowledge: write` on the path's space
 *   (never `schema`, which no Update needs), and `denyReadOnly` refuses a read-only token as every write route does; a view id is not a
 *   space a write row admits, so it is answered as a missing space.
 * - **A body the server buffers unbounded.** The query door's chain, copied: `globalRateLimit`, `requireSpaceAuth`, then parsers of its own
 *   at the text cap (`app.ts` marks this path so the global parsers leave it alone); a body past it is `413 sparql_query_too_large`.
 * - **A media type taken for another.** `application/sparql-update` and the urlencoded form only; anything else is
 *   `415 sparql_unsupported_media_type`. A query sent here is the act's `400 sparql_not_an_update`.
 * - **The text in the audit.** The audit rule (`brain.sparql_update`, written when cut off too) takes the act's counts and outcome; the
 *   Update's text is in no row, log line or error body.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { answeredUnknownSpace } from '../write-target-answer.js';
import { abortWhenClientGoes, slotCallerKey } from '../../http/read-caller.js';
import { sendCaughtFailure } from '../send-failure.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { SPARQL_QUERY_MAX_BYTES } from '../../rdf/sparql-engine.js';
import { SPARQL_BAD_REQUEST, SPARQL_TOO_LARGE, SPARQL_QUERY_TOO_LARGE } from '../../rdf/sparql-refusal.js';
import { SPARQL_UNSUPPORTED_MEDIA_TYPE, SPARQL_UNSUPPORTED_MEDIA_TYPE_STATUS } from '../../rdf/sparql-answer.js';
import { z } from 'zod';
import { refusalOfParse } from '../../util/log.js';
import {
  asParameterList, auditChangesOf, sparqlUpdateAct, sparqlUpdateParametersRefusal, SPARQL_NO_UPDATE, USING_GRAPH_URIS_MAX, type SparqlUpdateAnswer,
} from '../../spaces/sparql-update-act.js';
import { webhookToken } from './_shared.js';

/** The route's full path, for the parser marker `app.ts` mounts before the global body parsers. */
export const SPARQL_UPDATE_PATH = '/api/brain/spaces/:spaceId/sparql/update';
const ROUTE = 'POST /api/brain/spaces/:spaceId/sparql/update';

const UPDATE_TYPE = 'application/sparql-update';
const FORM_TYPE = 'application/x-www-form-urlencoded';
/** The text cap and room for a little more, so a text just past the cap is answered by the act's own check. */
const BODY_SLACK_BYTES = 1024;
const UPDATE_BODY_LIMIT = SPARQL_QUERY_MAX_BYTES + BODY_SLACK_BYTES;
/** Percent-encoding writes a byte as up to three. */
const PERCENT_ENCODED = 3;
const FORM_BODY_LIMIT = SPARQL_QUERY_MAX_BYTES * PERCENT_ENCODED + BODY_SLACK_BYTES;

const updateBody = express.text({ type: UPDATE_TYPE, limit: UPDATE_BODY_LIMIT });
const formBody = express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT });

export const sparqlUpdateRouter = Router();

interface Refusal { status: number; code: string; error: string }

function send(res: Response, r: Refusal & { retryAfterSeconds?: number; body?: Record<string, unknown> }): void {
  if (r.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(r.retryAfterSeconds));
  res.status(r.status).json(r.body ?? { error: r.error, code: r.code });
}

/** Parse with `parser`; its refusals are the act's codes with fixed words, never the parser's message. */
function parsed(parser: express.RequestHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    parser(req, res, (err?: unknown) => {
      if (!err) { next(); return; }
      const type = (err as { type?: unknown } | null)?.type;
      if (type === 'entity.too.large' || type === 'parameters.too.many') {
        send(res, { status: SPARQL_TOO_LARGE, code: SPARQL_QUERY_TOO_LARGE, error: `The Update is longer than ${SPARQL_QUERY_MAX_BYTES} bytes` });
      } else if (type === 'charset.unsupported' || type === 'encoding.unsupported') {
        send(res, { status: SPARQL_UNSUPPORTED_MEDIA_TYPE_STATUS, code: SPARQL_UNSUPPORTED_MEDIA_TYPE, error: 'Send the Update as UTF-8, uncompressed' });
      } else {
        send(res, { status: SPARQL_BAD_REQUEST, code: SPARQL_NO_UPDATE, error: 'The body could not be read as an Update' });
      }
    });
  };
}

/**
 * The route's parameters, parsed at the boundary: the tool's three, with the tool's bounds (the text cap, `USING_GRAPH_URIS_MAX`). A value
 * this refuses is answered in the act's own codes and words (`sparqlUpdateParametersRefusal`), so both doors refuse alike.
 */
export const SparqlUpdateParameters = z.object({
  update: z.string().min(1).max(SPARQL_QUERY_MAX_BYTES).optional(),
  'using-graph-uri': z.array(z.string()).max(USING_GRAPH_URIS_MAX).optional(),
  'using-named-graph-uri': z.array(z.string()).max(USING_GRAPH_URIS_MAX).optional(),
});

/**
 * Gathers the protocol's parameters into the body, from where the media type puts them: the text body and the URL's lists for
 * `application/sparql-update`, the form's fields for the urlencoded form. Any other media type is refused here.
 */
function gatherProtocolParameters(req: Request, res: Response, next: NextFunction): void {
  if (req.is(UPDATE_TYPE)) {
    const url = req.query as Record<string, unknown>;
    req.body = {
      update: typeof req.body === 'string' ? req.body : undefined,
      'using-graph-uri': asParameterList(url['using-graph-uri']), 'using-named-graph-uri': asParameterList(url['using-named-graph-uri']),
    };
    next();
    return;
  }
  if (req.is(FORM_TYPE)) {
    const form = (req.body ?? {}) as Record<string, unknown>;
    req.body = {
      update: form['update'],
      'using-graph-uri': asParameterList(form['using-graph-uri']), 'using-named-graph-uri': asParameterList(form['using-named-graph-uri']),
    };
    next();
    return;
  }
  send(res, { status: SPARQL_UNSUPPORTED_MEDIA_TYPE_STATUS, code: SPARQL_UNSUPPORTED_MEDIA_TYPE, error: `An Update is POSTed as ${UPDATE_TYPE} or ${FORM_TYPE} (update=...)` });
}

// POST /api/brain/spaces/:spaceId/sparql/update - a SPARQL 1.1 Update on one space, by the protocol; a write.
sparqlUpdateRouter.post('/spaces/:spaceId/sparql/update', globalRateLimit, requireSpaceAuth, denyReadOnly, parsed(updateBody), parsed(formBody), gatherProtocolParameters,
  async (req: Request, res: Response): Promise<void> => {
    const spaceId = req.params['spaceId'] as string;
    if (answeredUnknownSpace(req, res, spaceId)) return;
    res.setHeader('Cache-Control', 'no-store');
    const params = SparqlUpdateParameters.safeParse(req.body);
    if (!params.success) { send(res, sparqlUpdateParametersRefusal(refusalOfParse(params.error).issues[0])); return; }
    const token = req.authToken as { id?: string; admin?: boolean; rights?: TokenRights | null } | undefined;
    try {
      const answer: SparqlUpdateAnswer = await sparqlUpdateAct({
        spaceId, update: params.data.update, usingGraphUri: params.data['using-graph-uri'], usingNamedGraphUri: params.data['using-named-graph-uri'],
        caller: token, callerKey: slotCallerKey(req), actor: webhookToken(req), fingerprintOf: schemaFingerprintOf, signal: abortWhenClientGoes(res),
      });
      req.auditChangesExplicit = auditChangesOf(answer.audit);
      if (answer.ok) { res.status(answer.status).json(answer.body); return; }
      send(res, answer);
    } catch (err) {
      sendCaughtFailure(res, ROUTE, err);
    }
  });
