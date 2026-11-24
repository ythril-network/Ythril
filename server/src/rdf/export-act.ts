/**
 * The records export as RDF, from a request to a finished page: the one act `GET /api/brain/spaces/:spaceId/export/rdf` and MCP `export_rdf`
 * run (Q-750, design r4 §5.4-§5.5; owner and parent decisions of 2026-11-19). Each door only puts the page on its wire.
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** Parameters, defaults, bounds, refusals and their codes, the page boundaries and the bytes are decided here:
 *   `format` (or the REST `Accept`, `export-format.ts`), `edgeDetails`, `after`, `limit` and the size ceilings. The byte budget's default is
 *   the door's (`defaultBudgetChars`, the one sanctioned divergence) and is disclosed in the answer.
 * - **An export that reveals what the caller cannot read** (parent, 2026-11-19). A personal view's members are the ones its guard accepted
 *   for this caller (`viewReadMembers`, decided once at the door, as for `recall` and `filter`): a member the caller cannot read never reaches
 *   this act, so nothing of it (graph, name, count) can be written. File statements need `files: read` on their space; without it they are
 *   left out and the answer says only that some were withheld. An edge or a link is written with its ends as `filter` shows them at
 *   `knowledge: read`: its ends are records of the same space.
 * - **A page that is not one.** Records are read by keyset (member, kind, `_id`) through the one `_id` pager, so a record written during the
 *   walk is wholly in or wholly out and none is read twice. A page ends at `limit` records or at the budget, the first record whole; whether
 *   records are left is known before the page is answered (one key read beyond it), so REST can say `Link: rel="next"` before its status
 *   line. A page is built whole before any byte is sent, so a store that fails mid-page is a `503 rdf_export_incomplete` with nothing sent,
 *   never a truncated document that looks whole; and memory holds one page, at most the largest budget, never the space.
 * - **A silent drop.** A value the record form leaves out (decision record 23) is counted and the first ones named, in the closing comment,
 *   the report node and the summary; the door adds the REST trailers and the audit row.
 * - **A file that does not say what it is.** TriG, N-Quads and JSON-LD end with a description graph: a `ythril:ExportReport` node that
 *   `dcterms:hasPart` each record graph of the page (each `dcterms:isPartOf` it), each record graph naming its shapes with SHACL's
 *   `sh:shapesGraph` (the schema at the exported version, the address the schema export writes and every record's `dcterms:conformsTo`
 *   names), plus how the page ended. Turtle has one graph, the data graph the shapes check, so it says the same in its closing comment
 *   rather than mixing statements about the file into the records.
 * - **Exports that crowd the instance.** A page runs in an export slot (`export/export-slots.ts`), released by the door when it is done.
 */
import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { SpaceMeta } from '@ythril-network/schema';
import { getConfig } from '../config/loader.js';
import { mayReadArea } from '../auth/reachable-spaces.js';
import { idKeysetPage, type IdPage, type IdPageSpec } from '../db/id-keyset-page.js';
import { spaceCollection } from '../db/space-collection.js';
import type { BrainCollection } from '../config/types-knowledge.js';
import { LIVE_FILE_ROW, NOT_A_FEED_MARKER } from '../files/live-file-row.js';
import { budgetCeilingZ, defaultBudgetChars, queryInt, resolveBudget, budgetBoundBy, type ResolvedBudget } from '../brain/result-budget.js';
import { storeFailureAnswer } from '../brain/store-failure.js';
import { log, refusalOfParse, peerText, NAME_QUOTED } from '../util/log.js';
import { SAY_ONCE_WINDOW_MS, warnOnce } from '../util/warn-once.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';
import { takeExportSlot, EXPORT_RETRY_AFTER_SECONDS, EXPORT_SLOTS_INSTANCE, EXPORT_SLOTS_PER_CALLER, type ExportSlot } from '../export/export-slots.js';
import {
  EXPORT_OK, EXPORT_BAD_REQUEST, EXPORT_FORBIDDEN, EXPORT_NOT_ACCEPTABLE, EXPORT_CONFLICT, EXPORT_BUSY, EXPORT_UNAVAILABLE,
} from '../export/export-statuses.js';
import { blank, iri, plain, quad, stdIri, typed, xsd, type Quad, type EdgeDetails, type LeftOutReason } from './literals.js';
import { RDF_READ_FIELDS, SKIPPED_VALUES_NAMED_MAX, recordTriples, createSkippedLog, type RdfRecordKind, type SkippedValue } from './record-triples.js';
import { graphIri, prefixesFor, recordAddressable, recordIri, versionIri } from './term-iri.js';
import { createRdfWriter, rdfVersionOf, RdfWriteError, type RdfFormat } from './serialize.js';
import { chooseRdfFormat, rdfContentDisposition, rdfContentType, RDF_MEDIA_TYPES, RDF_BAD_FORMAT } from './export-format.js';
import {
  rdfSpaceState, RDF_BASE_SHARED, RDF_NOT_ENABLED, RDF_UNWRITABLE, RdfUnwritable, unwritableRefusal, type RdfCaller, type FingerprintOf,
} from './rdf-space-state.js';
import { ythrilIri } from './ythril-vocabulary.js';
import { MIN_TRANSFER_BYTES_PER_SECOND } from '../util/pace-window.js';

/** The most records one page holds. */
export const RDF_EXPORT_LIMIT_MAX = 10_000;
/** The longest `after` a caller can send back: a cursor this export made is far shorter. */
export const RDF_EXPORT_CURSOR_MAX = 2048;
/** Records read per database round trip. */
const READ_PAGE = 200;
/** The server deadline of one database round trip, in milliseconds: past it the page is refused, never cut. */
const PAGE_READ_MS = 30_000;
/** The longest list of named values the audit row keeps, in characters. */
const AUDIT_NAMED_MAX = 2_000;
/** The most left-out values the summary names one by one (the document names as many as its budget leaves room for); the rest are counted. */
export const SUMMARY_NAMED_MAX = 10;
/** The longest record id or key the summary repeats, in characters. */
const SUMMARY_TEXT_MAX = 100;
/** What a summary may take, in characters, with its named values held to {@link SUMMARY_NAMED_MAX} and {@link SUMMARY_TEXT_MAX}. */
const SUMMARY_RESERVE_CHARS = 2_500;
/** MCP carries the summary twice: its second text block and `structuredContent`. */
const SUMMARY_CARRIAGES = 2;
/** The smallest document a page holds whatever the budget: the first record is always whole. */
const MIN_DOCUMENT_CHARS = 1_000;
/** The share of a page's budget kept for its ending (the report node and the closing comment): one part in this many. */
const ENDING_SHARE = 4;
/** The least kept for the ending, in characters: a report node without named values and its comment. */
const ENDING_RESERVE_MIN = 3_000;
/** How much the named list of an ending that does not fit shrinks per try: halved. */
const ENDING_SHRINK = 2;

export const RDF_BAD_EDGE_DETAILS = 'rdf_bad_edge_details';
export const RDF_BAD_AFTER = 'rdf_bad_after';
export const RDF_BAD_LIMIT = 'rdf_bad_limit';
export const RDF_BAD_BUDGET = 'rdf_bad_budget';
export const RDF_EXPORT_BUSY = 'rdf_export_busy';
export const RDF_EXPORT_INCOMPLETE = 'rdf_export_incomplete';

/** Every refusal code the records export answers, for the tool's description and the guide. */
export const RDF_EXPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  RDF_BAD_FORMAT, 'rdf_format_not_acceptable', RDF_BAD_EDGE_DETAILS, RDF_BAD_AFTER, RDF_BAD_LIMIT, RDF_BAD_BUDGET,
  RDF_NOT_ENABLED, 'rdf_base_conflict', RDF_BASE_SHARED, 'rdf_term_clash', RDF_UNWRITABLE, RDF_EXPORT_BUSY, RDF_EXPORT_INCOMPLETE,
]);

/** The edge forms, by their parameter value. */
export const RDF_EDGE_DETAILS: readonly EdgeDetails[] = Object.freeze(['rdf12', 'reification']);

/**
 * The parameters both doors take (`format` is judged by `chooseRdfFormat`, beside the `Accept` header). NOT strict: a key this export does
 * not take is dropped, never followed.
 */
export const RdfExportParams = z.object({
  format: z.enum(['turtle', 'trig', 'nquads', 'jsonld']).optional(),
  edgeDetails: z.enum(['rdf12', 'reification']).optional(),
  after: z.string().min(1).max(RDF_EXPORT_CURSOR_MAX).optional(),
  limit: z.number().int().min(1).max(RDF_EXPORT_LIMIT_MAX).optional(),
  maxChars: budgetCeilingZ().optional(),
  maxBytes: budgetCeilingZ().optional(),
  maxTokens: budgetCeilingZ().optional(),
});

const FIELD_CODES: Readonly<Record<string, string>> = {
  format: RDF_BAD_FORMAT,
  edgeDetails: RDF_BAD_EDGE_DETAILS, after: RDF_BAD_AFTER, limit: RDF_BAD_LIMIT, maxChars: RDF_BAD_BUDGET, maxBytes: RDF_BAD_BUDGET, maxTokens: RDF_BAD_BUDGET,
};

/** The kinds a member is walked in, each with its collection. */
const WALK: ReadonlyArray<{ kind: RdfRecordKind; collection: BrainCollection }> = [
  { kind: 'entity', collection: 'entities' }, { kind: 'fact', collection: 'facts' }, { kind: 'chrono', collection: 'chrono' },
  { kind: 'edge', collection: 'edges' }, { kind: 'link', collection: 'links' }, { kind: 'file', collection: 'files' },
];

/** The words of each reason a value is left out, in the closing comment and the report node. */
const REASON_WORDS: Readonly<Record<LeftOutReason, string>> = {
  'not-a-plain-value': 'not a plain value',
  'does-not-fit-its-declared-type': 'does not fit its declared type',
  'key-has-no-address': 'a key with no address',
};

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
  status: typeof EXPORT_BAD_REQUEST | typeof EXPORT_FORBIDDEN | typeof EXPORT_NOT_ACCEPTABLE | typeof EXPORT_CONFLICT | typeof EXPORT_BUSY | typeof EXPORT_UNAVAILABLE;
  error: string;
  code: string;
  detail?: Record<string, unknown>;
  retryAfterSeconds?: number;
}

/**
 * The whole scope as one stream (REST with no `limit`, `after` or size ceiling): the text a store page at a time, the slot to release when
 * it ends, and how it stands. A stream that cannot finish ends so that no reader takes it for a whole file (`INCOMPLETE_LINE`).
 */
export interface RdfExportStream {
  status: typeof EXPORT_OK;
  kind: 'stream';
  contentType: string;
  disposition: string;
  viewMembers?: string[];
  /** The view's read members left out, RDF off and names not settled (as the summary's `membersWithoutRdf`, `membersInConflict`). */
  membersLeftOut: MembersLeftOut;
  /** Some member's file statements are left out (no `files: read` there): known before the first record. */
  fileTriplesWithheld: boolean;
  slot: ExportSlot;
  /** The first chunk (the start of the document and the first store page), or the refusal of a store that failed before any byte. */
  begin(): Promise<{ ok: true; first: string } | RdfExportRefusal>;
  /** The chunks after the first, a store page each, then the ending. */
  rest(): AsyncGenerator<string, void, undefined>;
  /** End the stream now, for `reason`: the incomplete ending to write last (the door stops asking `rest`). */
  abandon(reason: string): string;
  /** How the stream stands now: `complete` only once the last chunk was handed out; the audit row's changes; the trailers' parts. */
  state(): { complete: boolean; incomplete?: string; auditChanges: RdfExportPage['auditChanges']; skippedCount: number; skippedRecords: string[] };
}

export type RdfExportOutcome = RdfExportPage | RdfExportStream | RdfExportRefusal;

export interface RdfExportInput {
  /** The space or the caller's own view the call names. */
  spaceId: string;
  /** The members the door's guard accepted for the caller's own view (`viewReadOfRequest` / `viewReadOfCall`); absent for a space. */
  viewMembers?: readonly string[] | undefined;
  /** The caller's parameters as sent (a REST query's strings are read as their numbers). */
  params: Record<string, unknown>;
  /** The REST `Accept` header; MCP has none. */
  accept?: string | undefined;
  /** Who asks: its rights decide the rungs, and which networks a refusal may name. */
  caller: RdfCaller | undefined;
  /** Who a slot counts against: the calling token's id, or the address of a caller with none. */
  callerKey: string;
  transport: 'mcp' | 'rest';
  /** The door's `schemaFingerprintOf` (`rdf-space-state.ts` says why it is handed in). */
  fingerprintOf: FingerprintOf;
  /**
   * The whole scope in one answer, streamed (the REST route when the caller names no `limit`, `after` or size ceiling: what a standard RDF
   * tool, which follows no `Link`, is given). Absent: one bounded page.
   */
  whole?: boolean;
}

/** A position in the walk: a member space, a kind, the last `_id` read. Opaque to the caller. */
interface Cursor { space: string; kind: RdfRecordKind; last: string }
/** The parts of a cursor's text: the member space, the kind, the last `_id`. */
const CURSOR_PARTS = 3;
const encodeCursor = (c: Cursor): string => Buffer.from(JSON.stringify([c.space, c.kind, c.last]), 'utf8').toString('base64url');
function decodeCursor(text: string, members: readonly string[]): Cursor | null {
  try {
    const v: unknown = JSON.parse(Buffer.from(text, 'base64url').toString('utf8'));
    if (!Array.isArray(v) || v.length !== CURSOR_PARTS ||!v.every(x => typeof x === 'string')) return null;
    const [space, kind, last] = v as [string, string, string];
    if (!members.includes(space) || !WALK.some(w => w.kind === kind)) return null;
    return { space, kind: kind as RdfRecordKind, last };
  } catch {
    return null;
  }
}

type PageReader = (spec: IdPageSpec, after: string | undefined) => Promise<IdPage<{ _id: string } & Record<string, unknown>>>;
const defaultReader: PageReader = (spec, after) => idKeysetPage(spec, after);
let readPage: PageReader = defaultReader;
/** Replace how a page of records is read (a test plants a store that times out); `null` restores the store. */
export function setRdfExportPageReaderForTest(reader: PageReader | null): void { readPage = reader ?? defaultReader; }

/**
 * The least rate a whole export's reader must keep while the export waits on it (bundle-269 review, finding 9; first drive, finding 7): a
 * reader taking a little at a time meets the idle bound for ever, and two such readers held the instance's two slots. The product's other
 * long downloads (the audit-log export, the space backup) have no such bound because an administrator alone reaches them and nothing caps
 * how many run; this one any reader of a space reaches, and two run at once. How it is measured, and what cannot be: `export/export-reader-pace.ts`.
 * The figure is the one an import's sender is held to too (`util/pace-window.ts`, Q-953), so the guides state one rate.
 */
export const RDF_EXPORT_MIN_BYTES_PER_SECOND = MIN_TRANSFER_BYTES_PER_SECOND;
/**
 * How much waiting on the reader one judgement of {@link RDF_EXPORT_MIN_BYTES_PER_SECOND} covers at least, in milliseconds. Five minutes,
 * not one (the second drive, finding A): the kernel shows a reader's progress only in steps of about a third of its send buffer (about
 * 1.4 MiB at Linux's default ceiling), and a reader at the rate must be able to make one inside the idle bound, which is this window.
 */
export const RDF_EXPORT_RATE_WINDOW_MS = 300_000;
let rate = { windowMs: RDF_EXPORT_RATE_WINDOW_MS, minBytesPerSecond: RDF_EXPORT_MIN_BYTES_PER_SECOND };
/** The rate rule the REST door applies now. */
export const rdfExportRate = (): Readonly<typeof rate> => rate;
/** Replace the rate rule (a test that needs it to bind at once); `null` restores it. */
export function setRdfExportRateForTest(r: { windowMs: number; minBytesPerSecond: number } | null): void {
  rate = r ?? { windowMs: RDF_EXPORT_RATE_WINDOW_MS, minBytesPerSecond: RDF_EXPORT_MIN_BYTES_PER_SECOND };
}

/** How long a REST reader may take nothing before it is judged (a whole export: too slow; a page: cut), in milliseconds: the window. */
const IDLE_MS_DEFAULT = RDF_EXPORT_RATE_WINDOW_MS;
let idleMs = IDLE_MS_DEFAULT;
/** The idle bound the REST door applies now. */
export const rdfExportIdleMs = (): number => idleMs;
/** How many idle bounds a reader judged too slow is given to take the incomplete ending before its connection is cut. */
const ENDING_WAIT_IDLE_BOUNDS = 6;
/**
 * How long a reader judged too slow is given to take the incomplete ending (half an hour in production): the ending reaches the kernel once
 * the reader frees one more step of the send buffer, so a reader still taking about 1 KiB a second gets it; one taking less, or nothing, is
 * cut after it. The slot is already free.
 */
export const rdfExportEndingWaitMs = (): number => idleMs * ENDING_WAIT_IDLE_BOUNDS;
/** Replace the idle bound (a test that waits for it); `null` restores it. */
export function setRdfExportIdleMsForTest(ms: number | null): void { idleMs = ms ?? IDLE_MS_DEFAULT; }

/** A REST query value or a tool argument as the parameters take it: numbers from their strings, everything else as it is. */
function paramsOf(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    format: raw['format'], edgeDetails: raw['edgeDetails'], after: raw['after'], limit: queryInt(raw['limit']),
    maxChars: queryInt(raw['maxChars']), maxBytes: queryInt(raw['maxBytes']), maxTokens: queryInt(raw['maxTokens']),
  };
}

/** What an export is, judged before any slot is taken or any record read: the scope, the format and the bounds, or the refusal. */
type PreparedExport = Omit<PageInput, 'slot' | 'input'>;

/**
 * The headers a `GET` of the export would answer, for a REST `HEAD` (RFC 9110 §9.3.2): the same parameters, scope, format and refusals,
 * decided without taking a slot, reading a record or writing an audit row. The headers that only the walk can know (`Link`, the budget
 * used, the trailers) are left out, as the RFC allows for a value determined while the content is generated.
 */
export function rdfExportHeadAct(input: Omit<RdfExportInput, 'whole'>):
  | { status: typeof EXPORT_OK; contentType: string; disposition: string; viewMembers?: string[]; membersLeftOut: MembersLeftOut; fileTriplesWithheld: boolean }
  | RdfExportRefusal {
  const prepared = prepareExport(input);
  if ('error' in prepared) return prepared;
  return {
    status: EXPORT_OK,
    contentType: rdfContentType(prepared.format, rdfVersionOf(prepared.format, prepared.edgeDetails)),
    disposition: rdfContentDisposition(input.spaceId, prepared.format),
    ...(prepared.view ? { viewMembers: prepared.exported.map(e => e.space) } : {}),
    membersLeftOut: { withoutRdf: [...prepared.withoutRdf], inConflict: [...prepared.inConflict] },
    fileTriplesWithheld: prepared.exported.some(e => !prepared.files(e.space)),
  };
}

/** A refusal for want of a slot, said once per space and window (a client that retries every second must not fill the log). */
export const rdfExportBusySaid = warnOnce<string>({ max: 50, every: SAY_ONCE_WINDOW_MS });

/** Run the export of one page. Never throws for a caller's mistake; a fault that is not the store's is thrown to the door. */
export async function rdfExportAct(input: RdfExportInput): Promise<RdfExportOutcome> {
  const prepared = prepareExport(input);
  if ('error' in prepared) return prepared;
  const slot = takeExportSlot(input.callerKey);
  if (!slot) {
    // One line per space and window, naming the space and the rule and holding no record (lens finding 8): without it the refusal left only
    // the audit row, and an operator saw nothing of a caller that kept being turned away.
    rdfExportBusySaid(input.spaceId, () => log.warn(`RDF export of space ${peerText(input.spaceId, { max: NAME_QUOTED })} refused: no export slot is free `
      + `(the instance runs ${EXPORT_SLOTS_INSTANCE} at once and ${EXPORT_SLOTS_PER_CALLER} per caller); the caller is told to retry in ${EXPORT_RETRY_AFTER_SECONDS} s`));
    return {
      status: EXPORT_BUSY, code: RDF_EXPORT_BUSY, retryAfterSeconds: EXPORT_RETRY_AFTER_SECONDS,
      error: 'An export is already running for this token, or as many exports as the instance runs at once: try again when it ends',
    };
  }
  const p: PageInput = { ...prepared, input, slot };
  // The slot is the door's from the moment an answer is handed over, and released here on EVERY other exit: a throw of the walk's
  // constructor, of a page, of anything before the hand-over (bundle-269 review, finding 1: a stream that failed to start held its slot for
  // good).
  let handedOver = false;
  try {
    const answer = input.whole === true ? streamWhole(p) : await buildPage(p);
    handedOver = true;
    return answer;
  } catch (err) {
    return refusalOfStore(err, input.spaceId);
  } finally {
    if (!handedOver) slot.release();
  }
}

/** The parameters, the scope's members, the format and the bounds of an export, or the refusal a caller gets for them. */
function prepareExport(input: Omit<RdfExportInput, 'whole'>): PreparedExport | RdfExportRefusal {
  const { spaceId, caller, transport } = input;
  const rights = caller?.rights ?? undefined;
  const parsed = RdfExportParams.safeParse(paramsOf(input.params));
  if (!parsed.success) {
    const refusal = refusalOfParse(parsed.error);
    const field = String(refusal.issues[0]?.path[0] ?? '');
    return { status: EXPORT_BAD_REQUEST, error: refusal.error, code: FIELD_CODES[field] ?? RDF_BAD_LIMIT };
  }
  // The rung (`knowledge: read`) is asked before this act on every door: the route's guard (`ROUTE_RIGHTS`) and the dispatcher (`TOOL_RIGHTS`)
  // answer a token without it with their 403, which is the refusal a caller gets (bundle-269 review, suspicion a: a code of this act's own
  // there was never reached).
  const view = input.viewMembers !== undefined;
  const cfg = getConfig();
  const members = view ? [...input.viewMembers!] : [spaceId];
  const exported: { space: string; meta: SpaceMeta; fingerprint: string }[] = [];
  const withoutRdf: string[] = [];
  const inConflict: string[] = [];
  let firstRefusal: RdfExportRefusal | null = null;
  for (const m of members) {
    const state = rdfSpaceState(cfg, m, caller, input.fingerprintOf);
    if (state.ok) { exported.push({ space: m, meta: state.meta, fingerprint: state.fingerprint }); continue; }
    firstRefusal ??= { status: state.status, error: state.error, code: state.code, ...(state.detail ? { detail: state.detail } : {}) };
    (state.code === RDF_NOT_ENABLED ? withoutRdf : inConflict).push(m);
  }
  if (firstRefusal && exported.length === 0) return firstRefusal;

  const choice = chooseRdfFormat({ format: parsed.data.format, accept: input.accept, members: exported.length });
  if (!choice.ok) return { status: choice.status, error: choice.error, code: choice.code, detail: { formats: choice.formats } };
  const format = choice.format;
  if (format === 'jsonld' && parsed.data.edgeDetails === 'rdf12') {
    return { status: EXPORT_BAD_REQUEST, error: 'JSON-LD 1.1 has no triple term, so it carries edge details only in the classic form: leave edgeDetails out or send reification', code: RDF_BAD_EDGE_DETAILS };
  }
  const edgeDetails: EdgeDetails = parsed.data.edgeDetails ?? (format === 'jsonld' ? 'reification' : 'rdf12');
  const cursor = parsed.data.after === undefined ? null : decodeCursor(parsed.data.after, exported.map(e => e.space));
  if (parsed.data.after !== undefined && !cursor) {
    return { status: EXPORT_BAD_REQUEST, error: 'after: not a cursor this export gave (pass the nextAfter of the previous page, or the after of its Link)', code: RDF_BAD_AFTER };
  }
  const resolved = resolveBudget(parsed.data, defaultBudgetChars(transport), 1);
  if (!resolved.ok) return { status: EXPORT_BAD_REQUEST, error: resolved.error, code: RDF_BAD_BUDGET };
  return {
    exported, withoutRdf, inConflict, format, edgeDetails, cursor, budget: resolved, limit: parsed.data.limit,
    after: parsed.data.after, files: (m) => mayReadArea(rights, m, 'files'), view,
  };
}

/**
 * The refusal of a fault met before any byte of an answer was sent: a stored address no document can carry is `409 rdf_unwritable` naming
 * what holds it; a store that did not answer is the 503; any other fault is thrown to the door.
 */
function refusalOfStore(err: unknown, spaceId: string): RdfExportRefusal {
  if (err instanceof RdfUnwritable) return unwritableRefusal(err);
  if (err instanceof RdfWriteError) return unwritableRefusal(new RdfUnwritable(`The export of '${spaceId}'`, err.value));
  const store = storeFailureAnswer(err, `export_rdf '${spaceId}'`);
  if (store && store.status === EXPORT_UNAVAILABLE) {
    return {
      status: EXPORT_UNAVAILABLE, code: RDF_EXPORT_INCOMPLETE, retryAfterSeconds: store.retryAfterSeconds ?? EXPORT_RETRY_AFTER_SECONDS,
      error: 'The store did not answer a page of this export in time, so nothing of it was sent: try again (from the same after)',
    };
  }
  throw err;
}

interface PageInput {
  input: RdfExportInput;
  exported: { space: string; meta: SpaceMeta; fingerprint: string }[];
  withoutRdf: string[];
  inConflict: string[];
  format: RdfFormat;
  edgeDetails: EdgeDetails;
  cursor: Cursor | null;
  budget: ResolvedBudget;
  limit: number | undefined;
  after: string | undefined;
  files: (space: string) => boolean;
  slot: ExportSlot;
  view: boolean;
}

/**
 * Whether a record of the export is left after `from`: asked of the walk itself, so a row the walk leaves out (a fork row, an edge or a link
 * with no addressable end) never makes a page promise a next page that holds nothing (bundle-269 review, finding 4). It stops at the first
 * record it would export; reading past rows that are left out costs what the next page would have cost.
 */
async function anyAfter(p: PageInput, from: Cursor): Promise<boolean> {
  const steps = new ExportWalk(p).steps(from);
  try {
    for await (const s of steps) if (s.type === 'record') return true;
    return false;
  } finally {
    await steps.return();
  }
}

const filterOf = (kind: RdfRecordKind): Record<string, unknown> => (kind === 'file' ? { ...LIVE_FILE_ROW, ...NOT_A_FEED_MARKER } : {});
const projectionOf = (kind: RdfRecordKind): Record<string, 1> => Object.fromEntries(RDF_READ_FIELDS[kind].map(f => [f, 1 as const]));

/** One member of the scope, with the names its records are built from. */
type Member = { space: string; meta: SpaceMeta; fingerprint: string };

/** One step of the walk: a record's text (not yet counted), or the end of a store page. */
type WalkStep =
  | { type: 'record'; member: Member; kind: RdfRecordKind; id: string; previous: string; text: string; skipped: SkippedValue[] }
  | { type: 'page' };

/**
 * The last line of an export that could not finish, in Turtle, TriG and N-Quads: no grammar of the three lets a statement start with `!`, so
 * every parser refuses the file instead of taking a short one for whole (none of the four formats defines an end-of-document mark or a
 * checksum to use instead). A JSON-LD document that could not finish is left unterminated, which no JSON parser accepts.
 */
export const INCOMPLETE_LINE = '!ythril-export-incomplete\n';

/** Why the export of a view with no member the caller reads holds no records. */
const EMPTY_VIEW_WORDS = 'no member of this view is one you may read, so it holds no records';

/**
 * What one answer has read and written, and the writer that spells it: the one walk the bounded page and the whole stream share, so the two
 * cannot read, count, name or end differently.
 */
class ExportWalk {
  readonly writer: ReturnType<typeof createRdfWriter>;
  readonly head: string;
  records = 0;
  chars: number;
  bytes: number;
  readonly counts = Object.fromEntries(WALK.map(w => [w.kind, 0])) as Record<RdfRecordKind, number>;
  readonly skipped = createSkippedLog();
  readonly named: NamedSkippedValue[] = [];
  readonly graphs: Member[] = [];
  withheld = false;
  private readonly agentsSeen = new Set<string>();

  constructor(readonly p: PageInput) {
    const namespaces = Object.values(getConfig().schemaLibraryNamespaces ?? {});
    const prefixes: Record<string, string> = {};
    for (const e of p.exported) for (const [name, ns] of Object.entries(prefixesFor(e.meta, namespaces))) if (!Object.hasOwn(prefixes, name)) prefixes[name] = ns;
    try {
      this.writer = createRdfWriter(p.format, { prefixes, edgeDetails: p.edgeDetails });
      this.head = this.writer.open();
    } catch (err) {
      // The prefixes are the base, the vocab and the library namespaces the space's terms use: one of them holds the address.
      if (err instanceof RdfWriteError) throw new RdfUnwritable('The RDF setting of the space (meta.rdf.base or meta.rdf.vocab) or a library namespace its terms use', err.value);
      throw err;
    }
    this.chars = this.head.length;
    this.bytes = Buffer.byteLength(this.head, 'utf8');
  }

  /** Every record after `from` in walk order (member, kind, `_id`), its text written but not counted, one store page at a time. */
  async *steps(from: Cursor | null): AsyncGenerator<WalkStep, void, undefined> {
    const { p } = this;
    const m0 = from ? p.exported.findIndex(e => e.space === from.space) : 0;
    for (let m = m0; m < p.exported.length; m++) {
      const member = p.exported[m]!;
      const graph = p.format === 'turtle' ? undefined : graphIri(member.meta);
      const k0 = from && m === m0 ? WALK.findIndex(w => w.kind === from.kind) : 0;
      for (let k = k0; k < WALK.length; k++) {
        const { kind, collection } = WALK[k]!;
        if (kind === 'file' && !p.files(member.space)) { this.withheld = true; continue; }
        let afterId = from && m === m0 && k === k0 ? from.last : undefined;
        let previous = afterId ?? '';
        for (;;) {
          const page = await readPage({ collection: spaceCollection(member.space, collection), filter: filterOf(kind), projection: projectionOf(kind), size: READ_PAGE, maxTimeMS: PAGE_READ_MS }, afterId);
          for (const doc of page.rows) {
            const id = String(doc._id);
            const form = recordTriples(member.meta, kind, doc, { edgeDetails: p.edgeDetails, agentsSeen: this.agentsSeen });
            if (form.leftOut !== undefined || form.quads.length === 0) { previous = id; continue; }
            let text: string;
            try {
              text = this.writer.write({ ...(graph ? { graph } : {}), quads: form.quads });
            } catch (err) {
              if (err instanceof RdfWriteError) throw new RdfUnwritable(`The ${kind} '${peerText(id, { max: NAME_QUOTED })}' of space '${member.space}' (or a term of its type)`, err.value);
              throw err;
            }
            yield { type: 'record', member, kind, id, previous, text, skipped: form.counts.skippedValues };
            previous = id;
          }
          yield { type: 'page' };
          await yieldToEventLoop();
          if (page.end || page.last === undefined) break;
          afterId = page.last;
        }
      }
    }
  }

  /** Count a record this answer carries. */
  take(s: Extract<WalkStep, { type: 'record' }>): void {
    this.chars += s.text.length;
    this.bytes += Buffer.byteLength(s.text, 'utf8');
    this.records++;
    this.counts[s.kind]++;
    if (!this.graphs.includes(s.member)) this.graphs.push(s.member);
    this.skipped.add(s.skipped);
    for (const v of s.skipped) if (this.named.length < SKIPPED_VALUES_NAMED_MAX) this.named.push({ ...v, space: s.member.space });
  }

  /** The values left out so far: their count, the first named (at most `limit`), the words of each. */
  leftOut(limit = SKIPPED_VALUES_NAMED_MAX): { count: number; unnamed: number; named: NamedSkippedValue[]; words: string[] } {
    const s = this.skipped.summary();
    const named = this.named.slice(0, Math.min(s.named.length, limit));
    const unnamed = s.count - named.length;
    const words = named.map(v => `${v.recordId} (${v.key}: ${REASON_WORDS[v.reason]})`);
    if (unnamed > 0) words.push(`and ${unnamed} more`);
    return { count: s.count, unnamed, named, words };
  }

  /**
   * The report's address: a digest of what the document is (the member spaces exported, each one's schema version, where in the walk it
   * starts and where it ends), never of its bytes, so one page answered in all four formats has one report address (bundle-269 drive,
   * finding 12). Not the view's own id: a view and a view of the members it reads answer the same document, and a member left unread
   * leaves no trace in it.
   */
  private report(nextAfter: string | undefined): string {
    const { p } = this;
    const what = JSON.stringify([p.exported.map(e => [e.space, e.fingerprint]), p.after ?? '', nextAfter ?? '']);
    return `urn:ythril:export-report:${createHash('sha256').update(what).digest('hex')}`;
  }

  /**
   * The end of the document: the description graph (TriG, N-Quads, JSON-LD) and the closing comment of a whole answer, or of one that could
   * not finish (`incomplete`, the reason in words): then the report says `complete false` where it can still be written validly (TriG,
   * N-Quads), the comment says why, and {@link INCOMPLETE_LINE} makes every parser refuse the file; a JSON-LD document is left unterminated.
   * `ythril:complete` says the DOCUMENT is whole: a page with more after it is whole as a page and says `complete true` with its
   * `ythril:nextAfter` (drive, finding 12: `complete false` on such a page read as a broken file). `o.complete` here only words the
   * closing comment (nothing left, or more after this page); the summary's and the audit row's `complete` are the document's, as this.
   */
  ending(o: { complete: boolean; whole: boolean; nextAfter?: string | undefined; incomplete?: string; namedLimit?: number }): string {
    const { p } = this;
    const left = this.leftOut(o.namedLimit);
    if (o.incomplete !== undefined && p.format === 'jsonld') return '';
    const reportId = this.report(o.nextAfter);
    const report = iri(reportId);
    const quads: Quad[] = [quad(report, stdIri('rdf', 'type'), iri(ythrilIri('ExportReport')))];
    quads.push(quad(report, iri(ythrilIri('recordCount')), typed(String(this.records), xsd('integer'))));
    quads.push(quad(report, iri(ythrilIri('complete')), typed(String(o.incomplete === undefined), xsd('boolean'))));
    if (o.nextAfter) quads.push(quad(report, iri(ythrilIri('nextAfter')), plain(o.nextAfter)));
    quads.push(quad(report, iri(ythrilIri('leftOutCount')), typed(String(left.count), xsd('integer'))));
    if (this.withheld) quads.push(quad(report, iri(ythrilIri('fileTriplesWithheld')), typed('true', xsd('boolean'))));
    left.named.forEach((v, i) => {
      const node = blank(`left-out-${i}`);
      quads.push(quad(report, iri(ythrilIri('leftOutValue')), node));
      const member = p.exported.find(e => e.space === v.space)!;
      if (v.kind !== 'link' && recordAddressable(v.kind, v.recordId)) quads.push(quad(node, iri(ythrilIri('leftOutRecord')), iri(recordIri(member.meta, v.kind, v.recordId))));
      quads.push(quad(node, iri(ythrilIri('leftOutKey')), plain(v.key)));
      quads.push(quad(node, iri(ythrilIri('leftOutReason')), plain(REASON_WORDS[v.reason])));
    });
    const shapes: string[] = [];
    for (const g of this.graphs) {
      const graphName = iri(graphIri(g.meta));
      const shapesAt = versionIri(g.meta, g.fingerprint);
      shapes.push(shapesAt);
      quads.push(quad(report, stdIri('dcterms', 'hasPart'), graphName));
      quads.push(quad(graphName, stdIri('dcterms', 'isPartOf'), report));
      quads.push(quad(graphName, stdIri('sh', 'shapesGraph'), iri(shapesAt)));
    }
    // A view with no member the caller reads holds nothing, and says why, in standard terms (bundle-269 drive, finding 11).
    const empty = p.view && p.exported.length === 0 ? EMPTY_VIEW_WORDS : undefined;
    if (empty) quads.push(quad(report, stdIri('rdfs', 'comment'), plain(empty)));
    const tail = p.format === 'turtle' ? '' : this.writer.write({ graph: reportId, quads });
    const how = o.incomplete !== undefined ? `INCOMPLETE, the export could not finish: ${o.incomplete}`
      : o.complete ? 'complete, nothing is left' : `more after this page (after=${o.nextAfter})`;
    const comment = [
      `ythril-export: ${this.records} records${o.whole ? '' : ' on this page'}`, how,
      `${left.count} property values left out${left.words.length > 0 ? `: ${left.words.join(', ')}` : ''}`,
      ...(this.withheld ? ['file statements withheld (files: read is needed)'] : []),
      // Only members the guard accepted for the caller are ever named (the no-trace rule), as MCP names them in the summary.
      ...(p.withoutRdf.length > 0 ? [`members left out, RDF off: ${p.withoutRdf.join(', ')}`] : []),
      ...(p.inConflict.length > 0 ? [`members left out, RDF names not settled: ${p.inConflict.join(', ')}`] : []),
      ...(empty ? [empty] : []),
      ...(shapes.length > 0 ? [`shapes: ${shapes.map(s => `<${s}>`).join(' ')}`] : []),
    ].join('; ');
    if (o.incomplete !== undefined) return `${tail}# ${comment.replace(/[\r\n]/g, ' ')}\n${INCOMPLETE_LINE}`;
    return tail + this.writer.close(comment);
  }

  /** The audit row's changes as the answer stands. */
  auditChanges(complete: boolean, nextAfter?: string): RdfExportPage['auditChanges'] {
    const { p } = this;
    const left = this.leftOut();
    const named = left.words.join(', ');
    return [
      { field: 'format', to: p.format }, { field: 'edgeDetails', to: p.edgeDetails }, { field: 'members', to: p.exported.map(e => e.space).join(',') },
      { field: 'records', to: this.records }, { field: 'complete', to: complete }, { field: 'skippedValues', to: left.count },
      ...(named ? [{ field: 'skippedNamed', to: named.length > AUDIT_NAMED_MAX ? `${named.slice(0, AUDIT_NAMED_MAX)}...` : named }] : []),
      { field: 'fileTriplesWithheld', to: this.withheld },
      ...(p.after ? [{ field: 'after', to: p.after }] : []),
      ...(nextAfter ? [{ field: 'nextAfter', to: nextAfter }] : []),
    ];
  }
}

/**
 * One bounded page: `limit` records or the byte budget, whichever ends it first, and whether records are left after it. A page of two or
 * more records never exceeds its ceiling, its ending included: an ending that does not fit even with no value named (a long cursor it states
 * twice, bundle-269 drive finding 8) makes the page be built again with as many records as leave room for it (`cap`, the ceiling that cut
 * it in `cappedBy`). Only a page of one record may exceed it, since a record is never cut.
 */
async function buildPage(p: PageInput, cap?: number, cappedBy?: { chars: boolean; bytes: boolean }): Promise<RdfExportPage> {
  const w = new ExportWalk(p);
  const body: string[] = [];
  let next: Cursor | undefined;
  let refused: { chars: boolean; bytes: boolean } | null = null;
  let stoppedAt: Cursor | undefined;
  // What the document may hold (on MCP the summary rides twice beside it, so its bounded size is set aside), and the part of that kept for
  // the ending, so the records never leave the report and the closing comment outside the budget (bundle-269 review, finding 3).
  const carried = p.input.transport === 'mcp' ? SUMMARY_CARRIAGES * SUMMARY_RESERVE_CHARS : 0;
  const doc = { chars: Math.max(MIN_DOCUMENT_CHARS, p.budget.chars - carried), bytes: p.budget.bytes === null ? null : Math.max(MIN_DOCUMENT_CHARS, p.budget.bytes - carried) };
  const reserve = (n: number): number => Math.max(Math.floor(n / ENDING_SHARE), ENDING_RESERVE_MIN);
  for await (const s of w.steps(p.cursor)) {
    if (s.type !== 'record') continue;
    const overChars = w.chars + s.text.length > doc.chars - reserve(doc.chars);
    const overBytes = doc.bytes !== null && w.bytes + Buffer.byteLength(s.text, 'utf8') > doc.bytes - reserve(doc.bytes);
    const capped = cap !== undefined && w.records >= cap;
    // The record that does not fit is not this page's: the next page starts at it. The first record is always admitted whole.
    if (w.records > 0 && (overChars || overBytes || capped)) {
      refused = capped && cappedBy ? cappedBy : { chars: overChars, bytes: overBytes };
      next = { space: s.member.space, kind: s.kind, last: s.previous };
      break;
    }
    body.push(s.text);
    w.take(s);
    if (p.limit !== undefined && w.records >= p.limit) { stoppedAt = { space: s.member.space, kind: s.kind, last: s.id }; break; }
  }
  if (stoppedAt && await anyAfter(p, stoppedAt)) next = stoppedAt;
  /** Nothing of the scope is left after this page (it words the closing comment; the summary's `complete` is the document's). */
  const complete = next === undefined;
  const nextAfter = next ? encodeCursor(next) : undefined;
  // The ending names as many left-out values as fit what is left of the budget; the rest are counted ("and N more").
  let namedLimit = SKIPPED_VALUES_NAMED_MAX;
  let ending = w.ending({ complete, whole: false, nextAfter, namedLimit });
  const fits = (text: string): boolean => w.chars + text.length <= doc.chars && (doc.bytes === null || w.bytes + Buffer.byteLength(text, 'utf8') <= doc.bytes);
  while (!fits(ending) && namedLimit > 0) {
    namedLimit = Math.floor(namedLimit / ENDING_SHRINK);
    ending = w.ending({ complete, whole: false, nextAfter, namedLimit });
  }
  if (!fits(ending) && w.records > 1) {
    const room = { chars: doc.chars - w.head.length - ending.length, bytes: doc.bytes === null ? null : doc.bytes - Buffer.byteLength(w.head + ending, 'utf8') };
    const by = { chars: w.chars + ending.length > doc.chars, bytes: doc.bytes !== null && w.bytes + Buffer.byteLength(ending, 'utf8') > doc.bytes };
    // As many records as leave room for this ending, and always fewer than now, so the page shrinks to one record at the most.
    return buildPage(p, Math.max(1, Math.min(recordsThatFit(body, room), w.records - 1)), by);
  }
  const chunks = [w.head, ...body, ending];
  const sentChars = chunks.reduce((n, c) => n + c.length, 0);
  const sentBytes = chunks.reduce((n, c) => n + Buffer.byteLength(c, 'utf8'), 0);
  const left = w.leftOut(namedLimit);
  const summaryNamed = left.named.slice(0, SUMMARY_NAMED_MAX).map(v => ({ ...v, recordId: v.recordId.slice(0, SUMMARY_TEXT_MAX), key: v.key.slice(0, SUMMARY_TEXT_MAX) }));
  const budgetChars = p.budget.stated?.chars ?? p.budget.chars;
  const budgetBytes = p.budget.stated ? p.budget.stated.bytes : p.budget.bytes;
  const summary: RdfExportSummary = {
    space: p.input.spaceId, members: p.exported.map(e => e.space),
    ...(p.withoutRdf.length > 0 ? { membersWithoutRdf: [...p.withoutRdf] } : {}),
    ...(p.inConflict.length > 0 ? { membersInConflict: [...p.inConflict] } : {}),
    format: p.format, mediaType: RDF_MEDIA_TYPES[p.format], edgeDetails: p.edgeDetails, version: w.writer.version ?? null,
    // `complete` is the document's own `ythril:complete` (the vocabulary: whether this document is whole), never "nothing left": a page
    // is built whole or refused, so it is true on every page; `nextAfter` says more is left (the second drive, finding B).
    records: w.records, counts: w.counts, complete: true, ...(nextAfter ? { nextAfter } : {}),
    skippedValues: { count: left.count, named: summaryNamed, unnamed: left.count - summaryNamed.length },
    fileTriplesWithheld: w.withheld, truncated: refused !== null, budgetChars, budgetBytes, charsReturned: sentChars, bytesReturned: sentBytes,
    ...(refused ? { budgetBoundBy: budgetBoundBy(refused, p.budget) } : {}),
  };
  return {
    status: EXPORT_OK, kind: 'page', chunks, summary, slot: p.slot,
    contentType: rdfContentType(p.format, w.writer.version),
    disposition: rdfContentDisposition(p.input.spaceId, p.format),
    skippedRecords: [...new Set(left.named.map(v => v.recordId))],
    auditChanges: w.auditChanges(true, nextAfter),
    ...(p.view ? { viewMembers: summary.members } : {}),
  };
}

/** How many of `body`'s records, from the first, fit in `room` (characters, and bytes when a byte ceiling is stated). */
function recordsThatFit(body: readonly string[], room: { chars: number; bytes: number | null }): number {
  let chars = 0;
  let bytes = 0;
  let n = 0;
  for (const text of body) {
    chars += text.length;
    bytes += Buffer.byteLength(text, 'utf8');
    if (chars > room.chars || (room.bytes !== null && bytes > room.bytes)) break;
    n++;
  }
  return n;
}

let chunkObserver: ((chars: number) => void) | null = null;
/** Watch the size of each chunk a whole export hands out (a test that pins the stream to one store page at a time); `null` stops. */
export function setRdfExportChunkObserverForTest(observer: ((chars: number) => void) | null): void { chunkObserver = observer; }

/**
 * The whole scope as one stream, a store page per chunk: nothing holds more than one page of records, the slot is the door's to release
 * when the stream ends, and a stream that cannot finish ends with {@link ExportWalk.ending}'s incomplete form.
 */
function streamWhole(p: PageInput): RdfExportStream {
  const w = new ExportWalk(p);
  const steps = w.steps(null);
  let complete = false;
  let incomplete: string | undefined;
  let buffered = w.head;
  /** The text up to the end of the next store page, or `null` when the walk is over. */
  const nextChunk = async (): Promise<string | null> => {
    for (;;) {
      const s = await steps.next();
      if (s.done) return null;
      if (s.value.type === 'record') { w.take(s.value); buffered += s.value.text; continue; }
      if (buffered === '') continue;
      const out = buffered;
      buffered = '';
      return out;
    }
  };
  const hand = (text: string): string => { chunkObserver?.(text.length); return text; };
  async function* rest(): AsyncGenerator<string, void, undefined> {
    try {
      for (;;) {
        const chunk = await nextChunk();
        if (chunk === null) break;
        yield hand(chunk);
      }
    } catch (err) {
      // Mid-stream: the status line is sent, so the document itself must say it is not whole.
      incomplete = err instanceof RdfUnwritable ? `${RDF_UNWRITABLE}: ${unwritableRefusal(err).error}`
        : storeFailureAnswer(err, `export_rdf '${p.input.spaceId}'`)?.status === EXPORT_UNAVAILABLE
          ? 'the store did not answer a page in time' : 'a fault of the server while reading';
      yield hand(buffered + w.ending({ complete: false, whole: true, incomplete }));
      return;
    }
    const end = buffered + w.ending({ complete: true, whole: true });
    complete = true;
    yield hand(end);
  }
  const files = p.exported.some(e => !p.files(e.space));
  return {
    status: EXPORT_OK, kind: 'stream', slot: p.slot, fileTriplesWithheld: files,
    membersLeftOut: { withoutRdf: [...p.withoutRdf], inConflict: [...p.inConflict] },
    contentType: rdfContentType(p.format, w.writer.version),
    disposition: rdfContentDisposition(p.input.spaceId, p.format),
    ...(p.view ? { viewMembers: p.exported.map(e => e.space) } : {}),
    async begin() {
      try {
        const first = await nextChunk();
        return { ok: true, first: hand(first ?? '') };
      } catch (err) {
        p.slot.release();
        return refusalOfStore(err, p.input.spaceId);
      }
    },
    rest,
    abandon(reason: string) {
      // Whatever page was half read is not sent: the ending says the export could not finish, and why.
      incomplete = reason;
      return hand(w.ending({ complete: false, whole: true, incomplete: reason }));
    },
    state: () => ({
      complete, ...(incomplete !== undefined ? { incomplete } : {}), auditChanges: w.auditChanges(complete),
      skippedCount: w.leftOut().count, skippedRecords: [...new Set(w.leftOut().named.map(v => v.recordId))],
    }),
  };
}
