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
import type { TokenRights } from '../config/rights-shape.js';
import { holdsRung } from '../auth/reachable-spaces.js';
import { idKeysetPage, type IdPage, type IdPageSpec } from '../db/id-keyset-page.js';
import { spaceCollection } from '../db/space-collection.js';
import type { BrainCollection } from '../config/types-knowledge.js';
import { LIVE_FILE_ROW, NOT_A_FEED_MARKER } from '../files/live-file-row.js';
import { budgetCeilingZ, defaultBudgetChars, queryInt, resolveBudget, budgetBoundBy, type ResolvedBudget } from '../brain/result-budget.js';
import { storeFailureAnswer } from '../brain/store-failure.js';
import { refusalOfParse } from '../util/log.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';
import { takeExportSlot, EXPORT_RETRY_AFTER_SECONDS, type ExportSlot } from '../export/export-slots.js';
import {
  EXPORT_OK, EXPORT_BAD_REQUEST, EXPORT_FORBIDDEN, EXPORT_NOT_ACCEPTABLE, EXPORT_CONFLICT, EXPORT_BUSY, EXPORT_UNAVAILABLE,
} from '../export/export-statuses.js';
import { blank, iri, plain, quad, stdIri, typed, xsd, type Quad, type EdgeDetails, type LeftOutReason } from './literals.js';
import { RDF_READ_FIELDS, SKIPPED_VALUES_NAMED_MAX, recordTriples, createSkippedLog, type RdfRecordKind, type SkippedValue } from './record-triples.js';
import { graphIri, prefixesFor, recordAddressable, recordIri, versionIri } from './term-iri.js';
import { createRdfWriter, type RdfFormat } from './serialize.js';
import { chooseRdfFormat, rdfContentDisposition, rdfContentType, RDF_MEDIA_TYPES, RDF_BAD_FORMAT } from './export-format.js';
import { rdfSpaceState, RDF_NOT_ENABLED, type RdfCaller, type FingerprintOf } from './rdf-space-state.js';
import { ythrilIri } from './ythril-vocabulary.js';

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

export const RDF_BAD_EDGE_DETAILS = 'rdf_bad_edge_details';
export const RDF_BAD_AFTER = 'rdf_bad_after';
export const RDF_BAD_LIMIT = 'rdf_bad_limit';
export const RDF_BAD_BUDGET = 'rdf_bad_budget';
export const RDF_EXPORT_RUNG = 'rdf_export_rung';
export const RDF_EXPORT_BUSY = 'rdf_export_busy';
export const RDF_EXPORT_INCOMPLETE = 'rdf_export_incomplete';

/** Every refusal code the records export answers, for the tool's description and the guide. */
export const RDF_EXPORT_REFUSAL_CODES: readonly string[] = Object.freeze([
  RDF_BAD_FORMAT, 'rdf_format_not_acceptable', RDF_BAD_EDGE_DETAILS, RDF_BAD_AFTER, RDF_BAD_LIMIT, RDF_BAD_BUDGET, RDF_EXPORT_RUNG,
  RDF_NOT_ENABLED, 'rdf_base_conflict', RDF_EXPORT_BUSY, RDF_EXPORT_INCOMPLETE,
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

/** A finished page: its text in pieces, its summary, what each door puts on its wire, and the slot to release when it is sent. */
export interface RdfExportPage {
  status: typeof EXPORT_OK;
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

export type RdfExportOutcome = RdfExportPage | RdfExportRefusal;

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

/** How long a REST reader may take nothing before its export is cut and its slot freed, in milliseconds. */
const IDLE_MS_DEFAULT = 60_000;
let idleMs = IDLE_MS_DEFAULT;
/** The idle bound the REST door applies now. */
export const rdfExportIdleMs = (): number => idleMs;
/** Replace the idle bound (a test that waits for it); `null` restores it. */
export function setRdfExportIdleMsForTest(ms: number | null): void { idleMs = ms ?? IDLE_MS_DEFAULT; }

const mayRead = (rights: TokenRights | null | undefined, space: string, area: 'knowledge' | 'files'): boolean =>
  !!rights && (rights.instanceAdmin === true || holdsRung(rights, space, area, 'read'));

/** A REST query value or a tool argument as the parameters take it: numbers from their strings, everything else as it is. */
function paramsOf(raw: Record<string, unknown>): Record<string, unknown> {
  return {
    format: raw['format'], edgeDetails: raw['edgeDetails'], after: raw['after'], limit: queryInt(raw['limit']),
    maxChars: queryInt(raw['maxChars']), maxBytes: queryInt(raw['maxBytes']), maxTokens: queryInt(raw['maxTokens']),
  };
}

/** Run the export of one page. Never throws for a caller's mistake; a fault that is not the store's is thrown to the door. */
export async function rdfExportAct(input: RdfExportInput): Promise<RdfExportOutcome> {
  const { spaceId, caller, transport } = input;
  const rights = caller?.rights ?? undefined;
  const parsed = RdfExportParams.safeParse(paramsOf(input.params));
  if (!parsed.success) {
    const refusal = refusalOfParse(parsed.error);
    const field = String(refusal.issues[0]?.path[0] ?? '');
    return { status: EXPORT_BAD_REQUEST, error: refusal.error, code: FIELD_CODES[field] ?? RDF_BAD_LIMIT };
  }
  const view = input.viewMembers !== undefined;
  if (!view && !mayRead(rights, spaceId, 'knowledge')) {
    return { status: EXPORT_FORBIDDEN, error: `Exporting the records of a space needs knowledge: read on it, which this token does not hold on '${spaceId}'`, code: RDF_EXPORT_RUNG };
  }
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

  const slot = takeExportSlot(input.callerKey);
  if (!slot) {
    return {
      status: EXPORT_BUSY, code: RDF_EXPORT_BUSY, retryAfterSeconds: EXPORT_RETRY_AFTER_SECONDS,
      error: 'An export is already running for this token, or as many exports as the instance runs at once: try again when it ends',
    };
  }
  try {
    return await buildPage({
      input, exported, withoutRdf, inConflict, format, edgeDetails, cursor, budget: resolved, limit: parsed.data.limit,
      after: parsed.data.after, files: (m) => mayRead(rights, m, 'files'), slot, view,
    });
  } catch (err) {
    slot.release();
    const store = storeFailureAnswer(err, `export_rdf '${spaceId}'`);
    if (store && store.status === EXPORT_UNAVAILABLE) {
      return {
        status: EXPORT_UNAVAILABLE, code: RDF_EXPORT_INCOMPLETE, retryAfterSeconds: store.retryAfterSeconds ?? EXPORT_RETRY_AFTER_SECONDS,
        error: 'The store did not answer a page of this export in time, so nothing of the page was sent: try again (from the same after)',
      };
    }
    throw err;
  }
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

/** Whether any record is left after `from` (the rest of its kind, then the kinds and members after it): one key read per collection at most. */
async function anyAfter(p: PageInput, from: Cursor): Promise<boolean> {
  const m0 = p.exported.findIndex(e => e.space === from.space);
  for (let m = m0; m < p.exported.length; m++) {
    const space = p.exported[m]!.space;
    const k0 = m === m0 ? WALK.findIndex(w => w.kind === from.kind) : 0;
    for (let k = k0; k < WALK.length; k++) {
      const { kind, collection } = WALK[k]!;
      if (kind === 'file' && !p.files(space)) continue;
      const page = await readPage({ collection: spaceCollection(space, collection), filter: filterOf(kind), projection: { _id: 1 }, size: 1, maxTimeMS: PAGE_READ_MS },
        m === m0 && k === k0 ? from.last : undefined);
      if (page.rows.length > 0) return true;
    }
  }
  return false;
}

const filterOf = (kind: RdfRecordKind): Record<string, unknown> => (kind === 'file' ? { ...LIVE_FILE_ROW, ...NOT_A_FEED_MARKER } : {});
const projectionOf = (kind: RdfRecordKind): Record<string, 1> => Object.fromEntries(RDF_READ_FIELDS[kind].map(f => [f, 1 as const]));

async function buildPage(p: PageInput): Promise<RdfExportPage> {
  const cfg = getConfig();
  const namespaces = Object.values(cfg.schemaLibraryNamespaces ?? {});
  const prefixes: Record<string, string> = {};
  for (const e of p.exported) for (const [name, ns] of Object.entries(prefixesFor(e.meta, namespaces))) if (!Object.hasOwn(prefixes, name)) prefixes[name] = ns;
  const writer = createRdfWriter(p.format, { prefixes, edgeDetails: p.edgeDetails });
  const head = writer.open();
  const body: string[] = [];
  let chars = head.length;
  let bytes = Buffer.byteLength(head, 'utf8');
  let records = 0;
  const counts = Object.fromEntries(WALK.map(w => [w.kind, 0])) as Record<RdfRecordKind, number>;
  const skipped = createSkippedLog();
  const named: NamedSkippedValue[] = [];
  const agentsSeen = new Set<string>();
  const graphsOnPage: { space: string; meta: SpaceMeta; fingerprint: string }[] = [];
  let withheld = false;
  let next: Cursor | undefined;
  let refused: { chars: boolean; bytes: boolean } | null = null;
  let stoppedAt: Cursor | undefined;

  const m0 = p.cursor ? p.exported.findIndex(e => e.space === p.cursor!.space) : 0;
  walk: for (let m = m0; m < p.exported.length; m++) {
    const member = p.exported[m]!;
    const graph = p.format === 'turtle' ? undefined : graphIri(member.meta);
    const k0 = p.cursor && m === m0 ? WALK.findIndex(w => w.kind === p.cursor!.kind) : 0;
    for (let k = k0; k < WALK.length; k++) {
      const { kind, collection } = WALK[k]!;
      if (kind === 'file' && !p.files(member.space)) { withheld = true; continue; }
      let afterId = p.cursor && m === m0 && k === k0 ? p.cursor.last : undefined;
      let previous = afterId ?? '';
      for (;;) {
        const page = await readPage({ collection: spaceCollection(member.space, collection), filter: filterOf(kind), projection: projectionOf(kind), size: READ_PAGE, maxTimeMS: PAGE_READ_MS }, afterId);
        for (const doc of page.rows) {
          const id = String(doc._id);
          const form = recordTriples(member.meta, kind, doc, { edgeDetails: p.edgeDetails, agentsSeen });
          if (form.leftOut !== undefined || form.quads.length === 0) { previous = id; continue; }
          const text = writer.write({ ...(graph ? { graph } : {}), quads: form.quads });
          const addBytes = Buffer.byteLength(text, 'utf8');
          const overChars = chars + text.length > p.budget.chars;
          const overBytes = p.budget.bytes !== null && bytes + addBytes > p.budget.bytes;
          // The record that does not fit is not this page's: the next page starts at it. The first record is always admitted whole.
          if (records > 0 && (overChars || overBytes)) {
            refused = { chars: overChars, bytes: overBytes };
            next = { space: member.space, kind, last: previous };
            break walk;
          }
          body.push(text);
          chars += text.length;
          bytes += addBytes;
          records++;
          counts[kind]++;
          if (!graphsOnPage.includes(member)) graphsOnPage.push(member);
          skipped.add(form.counts.skippedValues);
          for (const v of form.counts.skippedValues) if (named.length < SKIPPED_VALUES_NAMED_MAX) named.push({ ...v, space: member.space });
          previous = id;
          if (p.limit !== undefined && records >= p.limit) { stoppedAt = { space: member.space, kind, last: id }; break walk; }
        }
        await yieldToEventLoop();
        if (page.end || page.last === undefined) break;
        afterId = page.last;
      }
    }
  }
  if (stoppedAt && await anyAfter(p, stoppedAt)) next = stoppedAt;
  // A view whose later members were not reached still withholds their file statements on the pages that reach them; this page says only
  // what it read.
  const complete = next === undefined;
  const nextAfter = next ? encodeCursor(next) : undefined;
  const summaryOfSkipped = skipped.summary();
  const namedFirst = named.slice(0, summaryOfSkipped.named.length);

  // The description graph and the closing comment: what this file holds, how the page ended.
  const reportId = `urn:ythril:export-report:${createHash('sha256').update(head).update(body.join('')).update('\u0000').update(p.after ?? '').digest('hex')}`;
  const report = iri(reportId);
  const quads: Quad[] = [quad(report, stdIri('rdf', 'type'), iri(ythrilIri('ExportReport')))];
  quads.push(quad(report, iri(ythrilIri('recordCount')), typed(String(records), xsd('integer'))));
  quads.push(quad(report, iri(ythrilIri('complete')), typed(String(complete), xsd('boolean'))));
  if (nextAfter) quads.push(quad(report, iri(ythrilIri('nextAfter')), plain(nextAfter)));
  quads.push(quad(report, iri(ythrilIri('leftOutCount')), typed(String(summaryOfSkipped.count), xsd('integer'))));
  if (withheld) quads.push(quad(report, iri(ythrilIri('fileTriplesWithheld')), typed('true', xsd('boolean'))));
  namedFirst.forEach((v, i) => {
    const node = blank(`left-out-${i}`);
    quads.push(quad(report, iri(ythrilIri('leftOutValue')), node));
    const member = p.exported.find(e => e.space === v.space)!;
    if (v.kind !== 'link' && recordAddressable(v.kind, v.recordId)) quads.push(quad(node, iri(ythrilIri('leftOutRecord')), iri(recordIri(member.meta, v.kind, v.recordId))));
    quads.push(quad(node, iri(ythrilIri('leftOutKey')), plain(v.key)));
    quads.push(quad(node, iri(ythrilIri('leftOutReason')), plain(REASON_WORDS[v.reason])));
  });
  const shapes: string[] = [];
  for (const g of graphsOnPage) {
    const graphName = iri(graphIri(g.meta));
    const shapesAt = versionIri(g.meta, g.fingerprint);
    shapes.push(shapesAt);
    quads.push(quad(report, stdIri('dcterms', 'hasPart'), graphName));
    quads.push(quad(graphName, stdIri('dcterms', 'isPartOf'), report));
    quads.push(quad(graphName, stdIri('sh', 'shapesGraph'), iri(shapesAt)));
  }
  const tail = p.format === 'turtle' ? '' : writer.write({ graph: reportId, quads });
  const names = namedFirst.map(v => `${v.recordId} (${v.key}: ${REASON_WORDS[v.reason]})`);
  if (summaryOfSkipped.unnamed > 0) names.push(`and ${summaryOfSkipped.unnamed} more`);
  const comment = [
    `ythril-export: ${records} records on this page`,
    complete ? 'complete, nothing is left' : `more after this page (after=${nextAfter})`,
    `${summaryOfSkipped.count} property values left out${names.length > 0 ? `: ${names.join(', ')}` : ''}`,
    ...(withheld ? ['file statements withheld (files: read is needed)'] : []),
    ...(shapes.length > 0 ? [`shapes: ${shapes.map(s => `<${s}>`).join(' ')}`] : []),
  ].join('; ');
  const chunks = [head, ...body, tail, writer.close(comment)];

  const budgetChars = p.budget.stated?.chars ?? p.budget.chars;
  const budgetBytes = p.budget.stated ? p.budget.stated.bytes : p.budget.bytes;
  const summary: RdfExportSummary = {
    space: p.input.spaceId, members: p.exported.map(e => e.space),
    ...(p.withoutRdf.length > 0 ? { membersWithoutRdf: [...p.withoutRdf] } : {}),
    ...(p.inConflict.length > 0 ? { membersInConflict: [...p.inConflict] } : {}),
    format: p.format, mediaType: RDF_MEDIA_TYPES[p.format], edgeDetails: p.edgeDetails, version: writer.version ?? null,
    records, counts, complete, ...(nextAfter ? { nextAfter } : {}),
    skippedValues: { count: summaryOfSkipped.count, named: namedFirst, unnamed: summaryOfSkipped.unnamed },
    fileTriplesWithheld: withheld, truncated: refused !== null, budgetChars, budgetBytes, charsReturned: chars, bytesReturned: bytes,
    ...(refused ? { budgetBoundBy: budgetBoundBy(refused, p.budget) } : {}),
  };
  const auditNamed = names.join(', ');
  return {
    status: EXPORT_OK, chunks, summary, slot: p.slot,
    contentType: rdfContentType(p.format, writer.version),
    disposition: rdfContentDisposition(p.input.spaceId, p.format),
    skippedRecords: [...new Set(namedFirst.map(v => v.recordId))],
    auditChanges: [
      { field: 'format', to: p.format }, { field: 'edgeDetails', to: p.edgeDetails }, { field: 'members', to: summary.members.join(',') },
      { field: 'records', to: records }, { field: 'complete', to: complete }, { field: 'skippedValues', to: summaryOfSkipped.count },
      ...(auditNamed ? [{ field: 'skippedNamed', to: auditNamed.length > AUDIT_NAMED_MAX ? `${auditNamed.slice(0, AUDIT_NAMED_MAX)}...` : auditNamed }] : []),
      { field: 'fileTriplesWithheld', to: withheld },
      ...(p.after ? [{ field: 'after', to: p.after }] : []),
      ...(nextAfter ? [{ field: 'nextAfter', to: nextAfter }] : []),
    ],
    ...(p.view ? { viewMembers: summary.members } : {}),
  };
}
