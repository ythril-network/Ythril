/**
 * A space's schema as OWL and SHACL over REST (Q-751, design r4 §6): `GET /api/spaces/:id/schema-rdf[?format=turtle|jsonld]`, or the
 * `Accept` header (`text/turtle`, `application/ld+json`) when no `format` is given. Mounted at `/api/spaces` beside the spaces router, in
 * its own file as `spaces-schema-versions.ts` is.
 *
 * The document, the rung (`schema: read`, also the `ROUTE_RIGHTS` row), the refusals and their codes are `rdf/schema-export-act.ts`'s, the
 * act MCP `space_schema_rdf` runs, so the doors answer the same bytes. A personal view is answered as every schema door answers one: the
 * guard says it is a view, not a space. Every answer says `Vary: Accept`; the document is an attachment named `<space>-schema.<ext>`.
 */
import { Router } from 'express';
import { requireSpaceAuthScoped } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { rdfSchemaExportAct } from '../rdf/schema-export-act.js';
import type { TokenRights } from '../config/rights-shape.js';
import { EXPORT_OK, EXPORT_VARY } from '../export/export-statuses.js';
import { schemaFingerprintOf } from '../spaces/schema-stamp.js';
import { sendCaughtFailure } from './send-failure.js';
import { headAskedAsGet } from '../export/export-head.js';

export const spaceSchemaRdfRouter = Router();

// GET (and HEAD) /api/spaces/:id/schema-rdf[?format=turtle|jsonld] - the schema of the space as an OWL ontology and SHACL shapes. A HEAD is
// asked the GET's rights (`headAskedAsGet`: the inventory keys on the method and has no HEAD row) and answered with its headers, unaudited.
spaceSchemaRdfRouter.get('/:id/schema-rdf', globalRateLimit, headAskedAsGet(requireSpaceAuthScoped('id')), (req, res) => {
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
