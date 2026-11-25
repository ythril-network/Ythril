/**
 * The SPARQL 1.1 Protocol over a space or the caller's own view (bundle-271, Q-757; design §2, r2 R1.2, R3.5, R4.6, R5):
 * `GET /api/brain/spaces/:spaceId/sparql?query=...`, `POST` with an `application/sparql-query` body or an urlencoded `query=`, and `HEAD`.
 * The parameters are the protocol's (`query`, `default-graph-uri`, `named-graph-uri`) and the endpoint's `limit`; MCP `sparql_query` runs
 * the same act (`rdf/sparql-answer.ts`), which owns every parameter, bound, refusal and byte of the answer.
 *
 * ## What this door holds, and what it prevents
 *
 * - **A body the server buffers unbounded.** The query bodies are parsed here, by parsers of their own with a limit just above the text cap
 *   (`app.ts` keeps the global parsers off this path), and a body past it is `413 sparql_query_too_large`, the act's own code, never the
 *   parser's bare 413. GET is bounded by the server's header size; the guide recommends POST.
 * - **A media type taken for another.** A POST answers only `application/sparql-query` and the urlencoded form; an update
 *   (`application/sparql-update`, `update=`) is `400 sparql_update_not_here`, anything else `415 sparql_unsupported_media_type`.
 * - **A standard body with keys of its own.** What the answer left out is said in headers (`X-Ythril-Members-Left-Out`,
 *   `X-Ythril-File-Triples-Withheld`, percent-encoded member ids), never in the results body a SPARQL client parses. Every answer says
 *   `Vary: Accept`.
 * - **A query that runs on after its client left.** The act gets a signal that aborts when the response closes before it was written: the
 *   engine is destroyed and the slot freed at once.
 * - **An unaudited query, or a query in the audit.** The audit rule (`brain.sparql_query`, written whatever `logReads` says and when cut
 *   off, as `rdf.export`) takes the act's counts; the query's text is in no row, log line or error body.
 * - **A `HEAD`** is judged and audited as the `GET` (`http/governed-method.ts`) and answered with its status and headers: the query is
 *   parsed and checked, nothing is run.
 */
import express, { Router, type NextFunction, type Request, type Response } from 'express';
import { requireSpaceAuth } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { readSpacesOfRequest, viewReadOfRequest } from '../../spaces/read-scope.js';
import { answeredUnknownSpace } from '../write-target-answer.js';
import { sendCaughtFailure } from '../send-failure.js';
import { schemaFingerprintOf } from '../../spaces/schema-stamp.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { SPARQL_QUERY_MAX_BYTES } from '../../rdf/sparql-engine.js';
import { SPARQL_BAD_REQUEST, SPARQL_TOO_LARGE, SPARQL_QUERY_TOO_LARGE, SPARQL_UPDATE_NOT_HERE } from '../../rdf/sparql-refusal.js';
import {
  answerSparql, prepareSparql, renderSparql, headerList, CallerGone, SPARQL_UNSUPPORTED_MEDIA_TYPE, SPARQL_UNSUPPORTED_MEDIA_TYPE_STATUS,
  type SparqlAnswerRefusal, type SparqlQueryInput, type PreparedSparql,
} from '../../rdf/sparql-answer.js';

/** The route's full path, for the parser marker `app.ts` mounts before the global body parsers. */
export const SPARQL_PATH = '/api/brain/spaces/:spaceId/sparql';
const ROUTE = 'GET|POST /api/brain/spaces/:spaceId/sparql';
/** The status of an answer. */
const SPARQL_ANSWERED = 200;
/** The headers that say what an answer left out. */
export const MEMBERS_LEFT_OUT_HEADER = 'X-Ythril-Members-Left-Out';
export const FILE_TRIPLES_WITHHELD_HEADER = 'X-Ythril-File-Triples-Withheld';
const EXPOSED = `${MEMBERS_LEFT_OUT_HEADER}, ${FILE_TRIPLES_WITHHELD_HEADER}, Retry-After`;

const QUERY_TYPE = 'application/sparql-query';
const FORM_TYPE = 'application/x-www-form-urlencoded';
const UPDATE_TYPE = 'application/sparql-update';
/** A query body's limit: the text cap and room for a little more, so a text just past the cap is answered by the act's own check. */
const BODY_SLACK_BYTES = 1024;
const QUERY_BODY_LIMIT = SPARQL_QUERY_MAX_BYTES + BODY_SLACK_BYTES;
/** A form body's limit: percent-encoding writes a byte as up to three, so the cap's text fits however it is encoded. */
const PERCENT_ENCODED = 3;
const FORM_BODY_LIMIT = SPARQL_QUERY_MAX_BYTES * PERCENT_ENCODED + BODY_SLACK_BYTES;

const queryBody = express.text({ type: QUERY_TYPE, limit: QUERY_BODY_LIMIT });
const formBody = express.urlencoded({ extended: false, limit: FORM_BODY_LIMIT });

export const sparqlRouter = Router();

/** A refusal on the wire: `{error, code, ...}`, with `Retry-After` on a 503. */
function sendRefusal(res: Response, r: SparqlAnswerRefusal): void {
  if (r.retryAfterSeconds !== undefined) res.setHeader('Retry-After', String(r.retryAfterSeconds));
  res.status(r.status).json({
    error: r.error, code: r.code, ...(r.line !== undefined ? { line: r.line } : {}), ...(r.column !== undefined ? { column: r.column } : {}),
    ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}), ...(r.detail ?? {}),
  });
}

/** Parse a POST body with `parser`; a body past its limit is the act's `413 sparql_query_too_large`, never the parser's bare answer. */
function parsed(parser: express.RequestHandler) {
  return (req: Request, res: Response, next: NextFunction): void => {
    parser(req, res, (err?: unknown) => {
      if (!err) { next(); return; }
      const type = (err as { type?: unknown }).type;
      if (type === 'entity.too.large') {
        sendRefusal(res, { status: SPARQL_TOO_LARGE, code: SPARQL_QUERY_TOO_LARGE, error: `The query is longer than ${SPARQL_QUERY_MAX_BYTES} bytes` });
        return;
      }
      next(err);
    });
  };
}

const updateRefusal: SparqlAnswerRefusal = {
  status: SPARQL_BAD_REQUEST, code: SPARQL_UPDATE_NOT_HERE,
  error: 'This endpoint answers queries only: SPARQL Update is not offered here (the update door is planned as its own endpoint)',
};

/** The protocol's parameters, from where the request's method and media type put them; or the refusal of a body that is none. */
function protocolParameters(req: Request): Record<string, unknown> | SparqlAnswerRefusal {
  const url = req.query as Record<string, unknown>;
  if (req.method !== 'POST') return Object.hasOwn(url, 'update') ? updateRefusal : url;
  if (req.is(UPDATE_TYPE)) return updateRefusal;
  if (req.is(QUERY_TYPE)) return { ...url, query: typeof req.body === 'string' ? req.body : undefined };
  if (req.is(FORM_TYPE)) {
    const body = (req.body ?? {}) as Record<string, unknown>;
    return Object.hasOwn(body, 'update') ? updateRefusal : body;
  }
  return {
    status: SPARQL_UNSUPPORTED_MEDIA_TYPE_STATUS, code: SPARQL_UNSUPPORTED_MEDIA_TYPE,
    error: `A query is POSTed as ${QUERY_TYPE} or ${FORM_TYPE} (query=...)`,
  };
}

const isRefusal = (v: unknown): v is SparqlAnswerRefusal => typeof (v as SparqlAnswerRefusal | null)?.code === 'string' && typeof (v as SparqlAnswerRefusal).status === 'number';

/** The headers that say what the answer left out, each a list of member ids. */
function setLeftOutHeaders(res: Response, p: PreparedSparql): void {
  if (p.leftOut.length > 0) res.setHeader(MEMBERS_LEFT_OUT_HEADER, headerList(p.leftOut));
  if (p.filesWithheld.length > 0) res.setHeader(FILE_TRIPLES_WITHHELD_HEADER, headerList(p.filesWithheld));
}

async function answer(req: Request, res: Response): Promise<void> {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  res.setHeader('Vary', 'Accept');
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Access-Control-Expose-Headers', EXPOSED);
  const params = protocolParameters(req);
  if (isRefusal(params)) { sendRefusal(res, params); return; }
  const token = req.authToken as { id?: string; admin?: boolean; rights?: TokenRights | null } | undefined;
  const ended = new AbortController();
  res.once('close', () => { if (!res.writableFinished) ended.abort(); });
  const input: SparqlQueryInput = {
    spaceId, spaces: readSpacesOfRequest(req, spaceId), view: viewReadOfRequest(req, spaceId) !== undefined,
    query: params['query'], limit: params['limit'], defaultGraphUri: params['default-graph-uri'], namedGraphUri: params['named-graph-uri'],
    accept: req.headers['accept'], caller: token, callerKey: token?.id ?? req.ip ?? '', fingerprintOf: schemaFingerprintOf, signal: ended.signal,
  };
  try {
    const prepared = await prepareSparql(input);
    if (isRefusal(prepared)) { sendRefusal(res, prepared); return; }
    setLeftOutHeaders(res, prepared);
    if (req.method === 'HEAD') {
      res.status(SPARQL_ANSWERED).setHeader('Content-Type', prepared.contentType);
      res.end();
      return;
    }
    const answered = await answerSparql(input, prepared);
    if (isRefusal(answered)) {
      // A refusal of the run is audited by the counts of the query it ended, with its code as the outcome.
      if (answered.auditChanges) req.auditChangesExplicit = answered.auditChanges;
      sendRefusal(res, answered);
      return;
    }
    const rendered = renderSparql(prepared, answered.collected);
    if (isRefusal(rendered)) { sendRefusal(res, rendered); return; }
    req.auditChangesExplicit = answered.auditChanges;
    res.status(SPARQL_ANSWERED).setHeader('Content-Type', rendered.contentType);
    res.end(rendered.body);
  } catch (err) {
    // The caller went away: there is no one to answer, and the engine and the slot are already let go.
    if (err instanceof CallerGone) return;
    sendCaughtFailure(res, ROUTE, err);
  }
}

// GET (and HEAD) /api/brain/spaces/:spaceId/sparql?query=... - a query over a space or the caller's own view, by the SPARQL 1.1 Protocol.
sparqlRouter.get('/spaces/:spaceId/sparql', globalRateLimit, requireSpaceAuth, answer);
// POST /api/brain/spaces/:spaceId/sparql - the same query as an application/sparql-query body or an urlencoded form; a read.
sparqlRouter.post('/spaces/:spaceId/sparql', globalRateLimit, requireSpaceAuth, parsed(queryBody), parsed(formBody), answer);
