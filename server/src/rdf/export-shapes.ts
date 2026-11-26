/**
 * The shapes of what the records export answers (`export-act.ts`): a page, its summary and a refusal. A module of types alone, so the
 * modules that build a page (`export-act.ts`, and `export-construct.ts` for a SPARQL view) share them without importing each other.
 */
import type { EXPORT_OK, EXPORT_BAD_REQUEST, EXPORT_FORBIDDEN, EXPORT_NOT_ACCEPTABLE, EXPORT_CONFLICT, EXPORT_BUSY, EXPORT_UNAVAILABLE } from '../export/export-statuses.js';
import type { ExportSlot } from '../export/export-slots.js';
import type { EdgeDetails } from './literals.js';
import type { RdfRecordKind, SkippedValue } from './record-triples.js';
import type { RdfFormat } from './serialize.js';
import type { VIEW_CONSTRUCT_TOO_LARGE_STATUS } from './view-construct.js';

/** One left-out value, with the space it was read in. */
export interface NamedSkippedValue extends SkippedValue { space: string }

/** What a page says about itself: the summary MCP answers in `structuredContent` and as its second block. */
export interface RdfExportSummary {
  space: string;
  members: string[];
  membersWithoutRdf?: string[];
  membersInConflict?: string[];
  format: RdfFormat;
  mediaType: string;
  edgeDetails: EdgeDetails;
  version: string | null;
  records: number;
  counts: Record<RdfRecordKind, number>;
  /** The statements a SPARQL view's CONSTRUCT made (Q-762): its export reads no record as such, so `records` and `counts` are 0. */
  statements?: number;
  /** Whether the document is whole, as its `ythril:complete` says: true on every page answered; `nextAfter` says whether more is left. */
  complete: boolean;
  nextAfter?: string;
  skippedValues: { count: number; named: NamedSkippedValue[]; unnamed: number };
  fileTriplesWithheld: boolean;
  truncated: boolean;
  budgetChars: number;
  budgetBytes: number | null;
  charsReturned: number;
  bytesReturned: number;
  budgetBoundBy?: string[];
}

/**
 * A view's members the caller reads that the export leaves out, by why: RDF off (`withoutRdf`), or names not settled (`inConflict`: a
 * contested or shared base, a term clash, an address no document can carry). Only members the guard accepted for the caller are ever here.
 */
export interface MembersLeftOut { withoutRdf: string[]; inConflict: string[] }

/** A finished page: its text in pieces, its summary, what each door puts on its wire, and the slot to release when it is sent. */
export interface RdfExportPage {
  status: typeof EXPORT_OK;
  kind: 'page';
  chunks: string[];
  summary: RdfExportSummary;
  contentType: string;
  disposition: string;
  /** The records the named left-out values belong to, each once (the REST door spells them into its trailer). */
  skippedRecords: string[];
  /** The audit row's changes (scalars only, cut to the operation's allowlist by the middleware). */
  auditChanges: Array<{ field: string; to: string | number | boolean }>;
  /** The view's members, for `Ythril-View-Members`; absent for a space. */
  viewMembers?: string[];
  slot: ExportSlot;
}

export interface RdfExportRefusal {
  status: typeof EXPORT_BAD_REQUEST | typeof EXPORT_FORBIDDEN | typeof EXPORT_NOT_ACCEPTABLE | typeof EXPORT_CONFLICT | typeof EXPORT_BUSY | typeof EXPORT_UNAVAILABLE
    | typeof VIEW_CONSTRUCT_TOO_LARGE_STATUS;
  error: string;
  code: string;
  detail?: Record<string, unknown>;
  retryAfterSeconds?: number;
}
