/**
 * A space's schema as OWL and SHACL over REST (Q-751, design r4 §6): `GET /api/spaces/:id/schema-rdf[?format=turtle|jsonld]`, or the
 * `Accept` header (`text/turtle`, `application/ld+json`) when no `format` is given. Mounted at `/api/spaces` beside the spaces router, in
 * its own file as `spaces-schema-versions.ts` is.
 *
 * The document, the rung (`schema: read`, also the `ROUTE_RIGHTS` row), the refusals and their codes are `rdf/schema-export-act.ts`'s, the
 * act MCP `space_schema_rdf` runs, so the doors answer the same bytes. A personal view is answered as every schema door answers one: the
 * guard says it is a view, not a space. Every answer says `Vary: Accept`; the document is an attachment named `<space>-schema.<ext>`.
 *
 * The same path takes a POST (Q-754): the schema built from an RDF file, the twin of MCP `import_schema_rdf`, both running
 * `spaces/schema-rdf-import-act.ts`.
 */
import { Router, type Request, type Response } from 'express';
import { requireSpaceAuthScoped, requireSpaceAuthMfaScoped, denyReadOnly } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { rdfSchemaExportAct } from '../rdf/schema-export-act.js';
import type { TokenRights } from '../config/rights-shape.js';
import { EXPORT_OK, EXPORT_VARY } from '../export/export-statuses.js';
import { schemaFingerprintOf } from '../spaces/schema-stamp.js';
import { schemaRdfImportAct } from '../spaces/schema-rdf-import-act.js';
import { RDF_UPLOAD_PACE_CODES, rdfUploadCooldownRefusal } from '../rdf/rdf-document.js';
import { uploadCallerKey, uploadCooldown } from '../util/upload-cooldown.js';
import { sendRdfRefusal } from './rdf-upload-refusal.js';
import { peerBoundTo, peerTokenToolRefusal } from '../auth/peer-bound.js';
import { schemaConvertCallerOf } from '../spaces/schema-convert-terms.js';
import { answeredUnknownSpace } from './write-target-answer.js';
import { sendCaughtFailure } from './send-failure.js';

export const spaceSchemaRdfRouter = Router();

/** The schema import's path: `app.ts` marks it before the global body parsers, so none of them takes the body the act reads off the wire. */
export const SCHEMA_RDF_PATH = '/api/spaces/:id/schema-rdf';
const IMPORT_ROUTE = 'POST /api/spaces/:id/schema-rdf';
/** The status a peer-bound token's build is refused with. */
const FORBIDDEN = 403;
/** The callers this door refused for their upload's pace, answered 429 for one window (`util/upload-cooldown.ts`). */
const cooldown = uploadCooldown();
/** A refusal of the build, on HTTP (`rdf-upload-refusal.ts`: the closing set, the drain, `Retry-After`). */
const sendRefusal = sendRdfRefusal;

// GET (and HEAD) /api/spaces/:id/schema-rdf[?format=turtle|jsonld] - the schema of the space as an OWL ontology and SHACL shapes. A HEAD is
// judged and audited as this GET (`http/governed-method.ts`: its rights row, a `schema.rdf.export` row with `method: 'HEAD'`) and answered
// with its headers alone.
spaceSchemaRdfRouter.get('/:id/schema-rdf', globalRateLimit, requireSpaceAuthScoped('id'), (req, res) => {
  const spaceId = req.params['id'] as string;
  res.setHeader('Vary', EXPORT_VARY);
  res.setHeader('Access-Control-Expose-Headers', 'Content-Disposition');
  try {
    const r = rdfSchemaExportAct({
      spaceId, format: req.query['format'], accept: req.headers['accept'],
      caller: req.authToken as { admin?: boolean; rights?: TokenRights | null } | undefined, fingerprintOf: schemaFingerprintOf,
    });
    if (r.status !== EXPORT_OK) {
      res.status(r.status).json({ error: r.error, code: r.code, ...(r.detail ?? {}) });
      return;
    }
    const head = req.method === 'HEAD';
    if (!head) req.auditChangesExplicit = r.auditChanges;
    res.status(EXPORT_OK).setHeader('Content-Type', r.contentType);
    res.setHeader('Content-Disposition', r.disposition);
    // `end`, not `send`: `send` would add a charset parameter the registered media types do not take. A HEAD answer has no content.
    if (head) res.end();
    else res.end(r.text);
  } catch (err) {
    sendCaughtFailure(res, 'GET /api/spaces/:id/schema-rdf', err);
  }
});

// POST /api/spaces/:id/schema-rdf?mode=&from=&format=&sourceBase=&sourceVocab=&dryRun= - the space's type schemas built or extended from an
// RDF file of OWL, RDFS and SHACL, the twin of MCP `import_schema_rdf` (Q-754). The route's row asks `schema: write`, a dry run too;
// the act owns the parameters, the `admin` rung of a file with rules, the bounds and every refusal; this door hands it the body as it arrives (marked before the
// global parsers, `SCHEMA_RDF_PATH`) and puts the answer on HTTP. A schema write: the second factor and the read-only refusal, as PATCH has.
spaceSchemaRdfRouter.post('/:id/schema-rdf', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, async (req: Request, res: Response) => {
  const spaceId = req.params['id'] as string;
  if (answeredUnknownSpace(req, res, spaceId)) return;
  // The one set of what a peer-bound token may not call, asked by the tool's dispatcher too.
  const peerRefusal = peerTokenToolRefusal(peerBoundTo(req.authToken as object | undefined), 'import_schema_rdf');
  if (peerRefusal) { res.status(FORBIDDEN).json({ error: peerRefusal }); return; }
  const caller = uploadCallerKey(req);
  const wait = cooldown.retryAfterSeconds(caller);
  if (wait !== undefined) { sendRefusal(req, res, rdfUploadCooldownRefusal(wait, 'no schema was built')); return; }
  let answer;
  try {
    answer = await schemaRdfImportAct({
      spaceId,
      params: {
        format: req.query['format'], mode: req.query['mode'], from: req.query['from'], sourceBase: req.query['sourceBase'],
        sourceVocab: req.query['sourceVocab'], dryRun: req.query['dryRun'],
      },
      body: req, contentType: req.headers['content-type'], contentEncoding: req.headers['content-encoding'],
      caller: req.authToken as { id?: string; admin?: boolean; rights?: TokenRights | null } | undefined,
      rateKey: schemaConvertCallerOf(req).rateKey,
    });
  } catch (err) {
    sendCaughtFailure(res, IMPORT_ROUTE, err);
    return;
  }
  if (answer.kind === 'refused') {
    if (RDF_UPLOAD_PACE_CODES.has(answer.code)) cooldown.note(caller);
    sendRefusal(req, res, answer);
    return;
  }
  // Recorded only on a <400 answer: the planner's snapshot pair on a build, the counts alone on a dry run.
  req.auditSnapshots = answer.audit;
  res.status(answer.status).json(answer.body);
});
