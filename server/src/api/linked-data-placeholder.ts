/**
 * Record addresses under `/ld/` answer `404` with an RFC 9457 problem body (Q-750, design r4 §5.4 [N9]; standards review row 12).
 *
 * ## What it prevents
 *
 * Every address an RDF export writes starts with `<public url>/ld/<space>/` (the default base, `term-iri.ts`). Without this route such an
 * address fell through to the single-page app and answered `200` with `index.html`, so a tool that followed a record's name took a web page
 * for the record. The addresses are names for now: nothing resolves them yet. `404` says so (RFC 9110: `501` would mean the method is not
 * recognised), and a later resolvable address can answer `200` or `303` without breaking any client. The body says where the data is.
 *
 * Unauthenticated and reading nothing: it answers the same to every caller and says nothing of any space.
 */
import { Router } from 'express';

/** Mounted by `app.ts` at `/ld`, before the single-page app. */
export const linkedDataPlaceholderRouter = Router();

linkedDataPlaceholderRouter.use((_req, res) => {
  res.status(404).type('application/problem+json').send(JSON.stringify({
    type: 'about:blank',
    title: 'Not a resolvable address yet',
    status: 404,
    detail: 'Addresses under /ld/ are names for now: Ythril does not resolve them yet. A space\'s records are exported as RDF by '
      + 'GET /api/brain/spaces/{spaceId}/export/rdf (MCP export_rdf), and its schema by GET /api/spaces/{spaceId}/schema-rdf (MCP space_schema_rdf).',
  }));
});
