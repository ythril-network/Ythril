/**
 * The RDF export of a SPARQL view (bundle-273, Q-762): the page `export-act.ts` answers for the caller's own view that carries a CONSTRUCT.
 *
 * ## What it prevents
 *
 * - **A read as someone else.** The CONSTRUCT runs over the members the door's guard accepted for the CALLER, each read through a quad source
 *   that asks the caller's rights again (`createQuadSource`): never as the view's owner had them, never as the instance.
 * - **A cut answer.** A CONSTRUCT past its cap (`VIEW_CONSTRUCT_MAX_STATEMENTS`), any other bound of the run, and a page whose document passes
 *   the caller's budget are refused and nothing of the statements is sent: the cap with `view_construct_too_large`, any other bound of the run
 *   (records read, bytes) with the code the SPARQL endpoint answers it with, a page past the budget with `rdf_export_budget_exceeded`; a store
 *   or a deadline that does not answer is the export's own `503 rdf_export_incomplete`. A REST whole export (no page parameter) has no budget.
 * - **A run that outlives its caller.** The caller's signal (the REST response closing, the MCP connection ending) stops the CONSTRUCT and the
 *   reads under it, so the export slot is free as soon as the caller is gone, not at `sparql.timeoutMs`.
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
import { RDF_KIND_COLLECTIONS, type RdfMembers } from './rdf-members.js';
import { rdfContentDisposition, RDF_MEDIA_TYPES } from './export-format.js';
import { constructStatements, VIEW_CONSTRUCT_TOO_LARGE_STATUS } from './view-construct.js';
import type { Quad, EdgeDetails } from './literals.js';
import type { RdfRecordKind } from './record-triples.js';
import type { RdfFormat, RdfWriter } from './serialize.js';
import type { ResolvedBudget } from '../brain/result-budget.js';
import type { RdfCaller, FingerprintOf } from './rdf-space-state.js';
import type { RdfExportPage, RdfExportRefusal, RdfExportSummary } from './export-shapes.js';

/** The code of a store that did not answer, the export's own (`RDF_EXPORT_INCOMPLETE` in `export-act.ts`, which imports this module). */
const RDF_EXPORT_INCOMPLETE = 'rdf_export_incomplete';
/**
 * The code of a page whose document passes the caller's budget: raising `maxChars` or `maxBytes` (or asking for the whole REST export) answers
 * it, which is what tells it from `view_construct_too_large`, a CONSTRUCT that is past its cap whatever the budget.
 */
export const RDF_EXPORT_BUDGET_EXCEEDED = 'rdf_export_budget_exceeded';

/**
 * The document's end, written by the export act's own ending (the one every RDF export closes with, so the export screen reads this one as
 * whole): given the writer that wrote the statements and the count of records the CONSTRUCT read.
 */
export type ConstructEnding = (writer: RdfWriter, records: number) => string;

/** What the export act judged before the run: the members, the format, the budget and the slot. */
export interface ConstructPageInput {
  input: { spaceId: string; caller: RdfCaller | undefined; fingerprintOf: FingerprintOf; whole?: boolean | undefined; signal?: AbortSignal | undefined };
  exported: { space: string }[];
  withoutRdf: string[];
  inConflict: string[];
  format: RdfFormat;
  edgeDetails: EdgeDetails;
  budget: ResolvedBudget;
  files: (space: string) => boolean;
  slot: ExportSlot;
  /** The members as resolved for this caller: the CONSTRUCT's source reuses them, never resolves them again (Q-976). */
  scope?: RdfMembers;
}

/** The page of a SPARQL view's export, or its refusal. @throws what is no refusal of the run (a fault of the server) */
export async function constructPage(p: ConstructPageInput, construct: string, ending: ConstructEnding): Promise<RdfExportPage | RdfExportRefusal> {
  const members = p.exported.map(e => e.space);
  const { timeoutMs, maxResultBytes } = sparqlLimits(getConfig());
  const deadline = Date.now() + timeoutMs;
  let made: Quad[];
  let recordsRead = 0;
  const { signal } = p.input;
  try {
    made = await readAcrossSwaps(
      recordsFor => createQuadSource({ members, caller: p.input.caller, fingerprintOf: p.input.fingerprintOf, resolved: p.scope },
        { deadline, ...(signal ? { signal } : {}), ...(recordsFor.length > 0 ? { recordsFor } : {}) }),
      async source => {
        const statements = (await constructStatements(construct, source, { deadline, maxBytes: maxResultBytes, ...(signal ? { signal } : {}) })).map(fromRdfJs);
        recordsRead = source.recordsRead();
        return statements;
      },
    );
  } catch (err) {
    // A caller that went away is answered by nobody: the run ended on its signal, and the refusal below is what the audit row records.
    if (signal?.aborted) return { status: EXPORT_UNAVAILABLE, code: RDF_EXPORT_INCOMPLETE, retryAfterSeconds: EXPORT_RETRY_AFTER_SECONDS, error: 'The caller went away before the export was made' };
    const refused = sparqlRefusalOf(err);
    if (!refused) throw err;
    if (refused.status === EXPORT_UNAVAILABLE) {
      return { status: EXPORT_UNAVAILABLE, code: RDF_EXPORT_INCOMPLETE, retryAfterSeconds: refused.retryAfterSeconds ?? EXPORT_RETRY_AFTER_SECONDS, error: refused.message };
    }
    // The cap (`view_construct_too_large`), the read bounds (`sparql_too_much_read`, `sparql_answer_too_large`) and a stored query no door can run
    // (`view_sparql_invalid`, `view_sparql_not_construct`) are answered with their own status and code, as the SPARQL endpoint and the view's Linked
    // Data address answer them: one cause is one answer on every door. Every status a run refuses with is one of the export's own.
    return { status: refused.status as RdfExportRefusal['status'], code: refused.code, error: refused.message };
  }
  const rendered = renderGraph(p.format, made, writer => ending(writer, recordsRead));
  if ('code' in rendered) return { status: EXPORT_CONFLICT, code: rendered.code, error: rendered.error };
  const chars = rendered.body.length;
  const bytes = Buffer.byteLength(rendered.body, 'utf8');
  const budgetChars = p.budget.stated?.chars ?? p.budget.chars;
  const budgetBytes = p.budget.stated ? p.budget.stated.bytes : p.budget.bytes;
  if (p.input.whole !== true && (chars > budgetChars || (budgetBytes !== null && bytes > budgetBytes))) {
    return {
      status: VIEW_CONSTRUCT_TOO_LARGE_STATUS, code: RDF_EXPORT_BUDGET_EXCEEDED,
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
