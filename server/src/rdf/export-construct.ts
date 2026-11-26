/**
 * The RDF export of a SPARQL view (bundle-273, Q-762): the page `export-act.ts` answers for the caller's own view that carries a CONSTRUCT.
 *
 * ## What it prevents
 *
 * - **A read as someone else.** The CONSTRUCT runs over the members the door's guard accepted for the CALLER, each read through a quad source
 *   that asks the caller's rights again (`createQuadSource`): never as the view's owner had them, never as the instance.
 * - **A cut answer.** A CONSTRUCT past its cap (`VIEW_CONSTRUCT_MAX_STATEMENTS`), any other bound of the run, and a page whose document passes
 *   the caller's budget are refused with `view_construct_too_large` and nothing of the statements; a store or a deadline that does not answer
 *   is the export's own `503 rdf_export_incomplete`. A REST whole export (no page parameter) has no budget.
 */
import { getConfig } from '../config/loader.js';
import { sparqlLimits } from '../config/sparql-limits.js';
import { EXPORT_OK, EXPORT_CONFLICT, EXPORT_UNAVAILABLE } from '../export/export-statuses.js';
import { EXPORT_RETRY_AFTER_SECONDS, type ExportSlot } from '../export/export-slots.js';
import { createQuadSource } from './quad-source.js';
import { readAcrossSwaps } from './read-across-swaps.js';
import { renderGraph } from './graph-render.js';
import { fromRdfJs } from './rdf-js-terms.js';
import { sparqlRefusalOf } from './sparql-refusal.js';
import { RDF_KIND_COLLECTIONS } from './rdf-members.js';
import { rdfContentDisposition, RDF_MEDIA_TYPES } from './export-format.js';
import { constructStatements, VIEW_CONSTRUCT_TOO_LARGE, VIEW_CONSTRUCT_TOO_LARGE_STATUS } from './view-construct.js';
import type { Quad, EdgeDetails } from './literals.js';
import type { RdfRecordKind } from './record-triples.js';
import type { RdfFormat } from './serialize.js';
import type { ResolvedBudget } from '../brain/result-budget.js';
import type { RdfCaller, FingerprintOf } from './rdf-space-state.js';
import type { RdfExportPage, RdfExportRefusal, RdfExportSummary } from './export-shapes.js';

/** The code of a store that did not answer, the export's own (`RDF_EXPORT_INCOMPLETE` in `export-act.ts`, which imports this module). */
const RDF_EXPORT_INCOMPLETE = 'rdf_export_incomplete';

/** What the export act judged before the run: the members, the format, the budget and the slot. */
export interface ConstructPageInput {
  input: { spaceId: string; caller: RdfCaller | undefined; fingerprintOf: FingerprintOf; whole?: boolean | undefined };
  exported: { space: string }[];
  withoutRdf: string[];
  inConflict: string[];
  format: RdfFormat;
  edgeDetails: EdgeDetails;
  budget: ResolvedBudget;
  files: (space: string) => boolean;
  slot: ExportSlot;
}

/** The page of a SPARQL view's export, or its refusal. @throws what is no refusal of the run (a fault of the server) */
export async function constructPage(p: ConstructPageInput, construct: string): Promise<RdfExportPage | RdfExportRefusal> {
  const members = p.exported.map(e => e.space);
  const { timeoutMs, maxResultBytes } = sparqlLimits(getConfig());
  const deadline = Date.now() + timeoutMs;
  let made: Quad[];
  let recordsRead = 0;
  try {
    made = await readAcrossSwaps(
      recordsFor => createQuadSource({ members, caller: p.input.caller, fingerprintOf: p.input.fingerprintOf },
        { deadline, ...(recordsFor.length > 0 ? { recordsFor } : {}) }),
      async source => {
        const statements = (await constructStatements(construct, source, { deadline, maxBytes: maxResultBytes })).map(fromRdfJs);
        recordsRead = source.recordsRead();
        return statements;
      },
    );
  } catch (err) {
    const refused = sparqlRefusalOf(err);
    if (!refused) throw err;
    if (refused.status === EXPORT_UNAVAILABLE) {
      return { status: EXPORT_UNAVAILABLE, code: RDF_EXPORT_INCOMPLETE, retryAfterSeconds: refused.retryAfterSeconds ?? EXPORT_RETRY_AFTER_SECONDS, error: refused.message };
    }
    // The cap, and every other bound of the run (records read, bytes): the statements are not answered, and the words say which bound.
    return { status: VIEW_CONSTRUCT_TOO_LARGE_STATUS, code: VIEW_CONSTRUCT_TOO_LARGE, error: refused.message };
  }
  const rendered = renderGraph(p.format, made);
  if ('code' in rendered) return { status: EXPORT_CONFLICT, code: rendered.code, error: rendered.error };
  const chars = rendered.body.length;
  const bytes = Buffer.byteLength(rendered.body, 'utf8');
  const budgetChars = p.budget.stated?.chars ?? p.budget.chars;
  const budgetBytes = p.budget.stated ? p.budget.stated.bytes : p.budget.bytes;
  if (p.input.whole !== true && (chars > budgetChars || (budgetBytes !== null && bytes > budgetBytes))) {
    return {
      status: VIEW_CONSTRUCT_TOO_LARGE_STATUS, code: VIEW_CONSTRUCT_TOO_LARGE,
      error: `The view's CONSTRUCT is ${chars} characters (${bytes} bytes) as ${p.format}, more than this page's budget of ${budgetChars} characters`
        + `${budgetBytes !== null ? ` or ${budgetBytes} bytes` : ''}; a SPARQL view's export is one document: raise maxChars or maxBytes, or narrow the query`,
    };
  }
  const counts = Object.fromEntries(RDF_KIND_COLLECTIONS.map(w => [w.kind, 0])) as Record<RdfRecordKind, number>;
  const summary: RdfExportSummary = {
    space: p.input.spaceId, members,
    ...(p.withoutRdf.length > 0 ? { membersWithoutRdf: [...p.withoutRdf] } : {}),
    ...(p.inConflict.length > 0 ? { membersInConflict: [...p.inConflict] } : {}),
    format: p.format, mediaType: RDF_MEDIA_TYPES[p.format], edgeDetails: p.edgeDetails, version: null,
    records: 0, counts, complete: true, statements: made.length,
    skippedValues: { count: 0, named: [], unnamed: 0 },
    fileTriplesWithheld: p.exported.some(e => !p.files(e.space)), truncated: false, budgetChars, budgetBytes, charsReturned: chars, bytesReturned: bytes,
  };
  return {
    status: EXPORT_OK, kind: 'page', chunks: [rendered.body], summary, slot: p.slot,
    contentType: rendered.contentType,
    disposition: rdfContentDisposition(p.input.spaceId, p.format),
    skippedRecords: [],
    auditChanges: [
      { field: 'format', to: p.format }, { field: 'members', to: members.join(',') }, { field: 'records', to: recordsRead },
      { field: 'statements', to: made.length }, { field: 'complete', to: true }, { field: 'fileTriplesWithheld', to: summary.fileTriplesWithheld },
    ],
    viewMembers: members,
  };
}
