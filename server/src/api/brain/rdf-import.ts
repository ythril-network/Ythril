/**
 * The RDF import over REST: `POST /api/brain/spaces/:spaceId/import/rdf[?format=&dryRun=&blankNodes=&sourceBase=&sourceVocab=&graphBase=&schema=&from=]`
 * with the document as the body (its media type in `Content-Type`, plain or `Content-Encoding: gzip`), and its status at
 * `GET /api/brain/spaces/:spaceId/import/rdf/:importId` (bundle-270, slice S6, Q-753). The twins of MCP `import_rdf` and `import_rdf_status`.
 *
 * ## What it prevents
 *
 * Both doors run `spaces/rdf-import-act.ts`, which owns the parameters, the bounds, every refusal and its code, the act and the report; this
 * door only hands it the body as it arrives (never buffered: the act reads it into its spool under its bounds) and puts the answer on HTTP:
 * `200` with the report, `202` with `Location` while the act runs past the door's budget, the act's refusals with their status and code.
 * The rung (`knowledge: write`, for a dry run too) is the route's guard's (`ROUTE_RIGHTS`); an id that is not a configured space, a view's
 * included, is answered by the one existence rule before anything is read. The audit row (`rdf.import`) takes the report's counts, never a
 * value of the file.
 */
import { Router, type NextFunction, type Request, type Response } from 'express';
import { requireSpaceAuth, requireSpaceAuthMfaScoped, denyReadOnly } from '../../auth/middleware.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { answeredUnknownSpace } from '../write-target-answer.js';
import { sendCaughtFailure } from '../send-failure.js';
import {
  RDF_IMPORT_UPLOAD_STALLED, rdfImportAct, rdfImportAuditChanges, rdfImportStatusAct, runningBodyOf, type RdfImportRefusal,
} from '../../spaces/rdf-import-act.js';
import { peerBoundTo, peerTokenToolRefusal } from '../../auth/peer-bound.js';
import type { TokenRights } from '../../config/rights-shape.js';

export const rdfImportRouter = Router();

const ROUTE = 'POST /api/brain/spaces/:spaceId/import/rdf';
/** The import's path: `app.ts` marks it before the global body parsers, so that none of them takes the body the act reads off the wire itself. */
export const RDF_IMPORT_PATH = '/api/brain/spaces/:spaceId/import/rdf';
/** The status a peer-bound token's import is refused with. */
const FORBIDDEN = 403;
const STATUS_ROUTE = 'GET /api/brain/spaces/:spaceId/import/rdf/:importId';

/** A refusal of the act, with what more it carries. */
function sendRefusal(res: Response, r: RdfImportRefusal): void {
  // A sender that stalled still holds its end open: the answer ends the connection, or the sender keeps the socket (the tool has no upload to stall).
  if (r.code === RDF_IMPORT_UPLOAD_STALLED) res.setHeader('Connection', 'close');
  res.status(r.status).json({ error: r.error, code: r.code, ...(r.detail ?? {}) });
}

/** The second factor's guard of a schema write, on this route's `spaceId`. */
const requireSpaceAuthMfa = requireSpaceAuthMfaScoped('spaceId');

/**
 * The route's guard: an import that builds a schema from the file (`schema` set and not `none`, Q-955) writes the space's type schemas, so it
 * asks the second factor where the token needs one, as `PATCH /api/spaces/:id` and the schema door do; an import of data alone asks what it
 * always asked. The parameter is read here only to pick the guard; the act judges it.
 */
function requireImportAuth(req: Request, res: Response, next: NextFunction): void {
  const schema = req.query['schema'];
  const buildsSchema = schema !== undefined && schema !== 'none';
  if (buildsSchema) void requireSpaceAuthMfa(req, res, next);
  else void requireSpaceAuth(req, res, next);
}

// POST /api/brain/spaces/:spaceId/import/rdf - an RDF document into the space, all or nothing.
rdfImportRouter.post('/spaces/:spaceId/import/rdf', globalRateLimit, requireImportAuth, denyReadOnly, async (req: Request, res: Response) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  const token = req.authToken as { id?: string; admin?: boolean; rights?: TokenRights | null } | undefined;
  // The one set of what a peer-bound token may not call (the tool's twin asks it too): the import registers a space act, which stops the
  // transfers of its space, and a request a peer's token made is one of them.
  const peerRefusal = peerTokenToolRefusal(peerBoundTo(req.authToken as object | undefined), 'import_rdf');
  if (peerRefusal) { res.status(FORBIDDEN).json({ error: peerRefusal }); return; }
  let answer;
  try {
    answer = await rdfImportAct({
      spaceId,
      params: {
        format: req.query['format'], dryRun: req.query['dryRun'], blankNodes: req.query['blankNodes'], sourceBase: req.query['sourceBase'],
        sourceVocab: req.query['sourceVocab'], graphBase: req.query['graphBase'], schema: req.query['schema'], from: req.query['from'],
      },
      body: req, contentType: req.headers['content-type'], contentEncoding: req.headers['content-encoding'],
      caller: token,
    });
  } catch (err) {
    sendCaughtFailure(res, ROUTE, err);
    return;
  }
  if (answer.kind === 'report') {
    req.auditChangesExplicit = rdfImportAuditChanges(answer.report);
    res.status(answer.status).json(answer.report);
    return;
  }
  if (answer.kind === 'running') {
    res.setHeader('Location', answer.location);
    res.status(answer.status).json(runningBodyOf(answer));
    return;
  }
  const report = answer.detail?.['report'];
  if (report && typeof report === 'object') req.auditChangesExplicit = rdfImportAuditChanges(report as Parameters<typeof rdfImportAuditChanges>[0]);
  sendRefusal(res, answer);
});

// GET /api/brain/spaces/:spaceId/import/rdf/:importId - what an import of this space did or is doing.
rdfImportRouter.get('/spaces/:spaceId/import/rdf/:importId', globalRateLimit, requireSpaceAuth, async (req: Request, res: Response) => {
  const spaceId = req.params['spaceId'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  let answer;
  try {
    answer = await rdfImportStatusAct({ spaceId, params: { importId: req.params['importId'] } });
  } catch (err) {
    sendCaughtFailure(res, STATUS_ROUTE, err);
    return;
  }
  if (answer.kind === 'refused') {
    sendRefusal(res, answer);
    return;
  }
  res.status(answer.status).json(answer.report);
});
