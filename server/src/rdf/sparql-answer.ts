/**
 * A SPARQL query from its parameters to a whole answer: the one act `GET/POST /api/brain/spaces/:spaceId/sparql` and MCP `sparql_query` run
 * (bundle-271, Q-757; design §2, r2 R1.2, R2.2, R3.1, R3.2, R3.5, R3.6, R4.6, R5). Each door only puts the answer on its wire.
 *
 * ## What it prevents
 *
 * - **Two doors that differ.** Parameters (`query`, `limit`, `default-graph-uri`, `named-graph-uri`), their refusals and codes, the members
 *   read, the bounds and the bytes of an answer are decided here; the doors hand in what the protocol put where (URL, body, `Accept`).
 * - **A short answer that looks whole.** An answer is collected in full before anything is answered, at most `maxResults + 1` rows (a lower
 *   `limit` lowers the bound): one more than the bound is `413 sparql_too_many_results` with no row of it, so every refusal is a clean status.
 *   Each query runs once: the answer is written here from the rows the engine handed over, never by asking the engine to serialise it again.
 * - **A graph answer that writes what the query never constructed.** CONSTRUCT and DESCRIBE statements are written by the export's writer
 *   (`createRdfWriter`, its IRIREF guard and its `VERSION "1.2"` rule) in a format chosen by the export's chooser; a TSV term is written with
 *   every character an IRI cannot hold escaped. A term no document can carry is `409 rdf_unwritable`, naming no part of it.
 * - **A read outside the caller's scope, and one it is not told about.** The members are the spaces the door's guard accepted; a member with
 *   RDF off or unsettled names is left out and named (`leftOut`), the file statements of a member without `files: read` are withheld and the
 *   member named (`filesWithheld`); a space read alone in that state answers the export's own refusal for it.
 * - **Queries that crowd the instance.** A query runs in a slot of family `sparql` (`util/slots.ts`), released when the answer is collected
 *   or the caller goes (the door's `signal`), whichever is first; a caller with no slot is `503 sparql_busy`.
 * - **The query in a trace.** No refusal, log line or audit field carries the text: a log line names the code and the member count, the audit
 *   row the form, length, members, records read, rows and outcome.
 */
import { z } from 'zod';
import { getConfig } from '../config/loader.js';
import { queryInt } from '../brain/result-budget.js';
import { sparqlLimits, SPARQL_LIMIT_BOUNDS } from '../config/sparql-limits.js';
import { takeSlot, SLOT_FAMILIES } from '../util/slots.js';
import { log, peerText, NAME_QUOTED, refusalOfParse } from '../util/log.js';
import { MAX_SPACE_IDS } from '../util/request-bounds.js';
import { preferredByAccept } from '../http/accept-weigh.js';
import { EXPORT_CONFLICT } from '../export/export-statuses.js';
import { checkSparqlAlgebra, runSparql, type SparqlAlgebra, type SparqlResult } from './sparql-engine.js';
import {
  SPARQL_REFUSAL_CODES, SPARQL_BAD_REQUEST, SPARQL_TOO_LARGE, SPARQL_UNAVAILABLE, SPARQL_BUSY, SPARQL_TOO_MANY_RESULTS, sparqlRefusalOf,
} from './sparql-refusal.js';
import { createQuadSource } from './quad-source.js';
import { rdfMembers } from './rdf-members.js';
import { fromRdfJs } from './rdf-js-terms.js';
import { createRdfWriter, rdfVersionOf, RdfWriteError, type RdfFormat } from './serialize.js';
import { chooseRdfFormat, rdfContentType, RDF_FORMAT_NOT_ACCEPTABLE } from './export-format.js';
import type { Quad } from './literals.js';
import { RDF_NOT_ENABLED, RDF_BASE_SHARED, RDF_UNWRITABLE, type RdfCaller, type FingerprintOf } from './rdf-space-state.js';

/** No `query`, or more than one. */
export const SPARQL_NO_QUERY = 'sparql_no_query';
/** A `limit` that is no whole number from 1 to `sparql.maxResults`. */
export const SPARQL_BAD_LIMIT = 'sparql_bad_limit';
/** A `default-graph-uri` or `named-graph-uri` that is no text. */
export const SPARQL_BAD_DATASET = 'sparql_bad_dataset';
/** An `Accept` naming no format a SELECT or ASK answers in. */
export const SPARQL_NOT_ACCEPTABLE = 'sparql_not_acceptable';
/** A POST body of a media type the protocol does not define for a query. */
export const SPARQL_UNSUPPORTED_MEDIA_TYPE = 'sparql_unsupported_media_type';
/** The statuses of the door refusals this module adds. */
export const SPARQL_NOT_ACCEPTABLE_STATUS = 406;
export const SPARQL_UNSUPPORTED_MEDIA_TYPE_STATUS = 415;

/**
 * Every code the endpoint answers: the SPARQL refusals, the door's own, the member state of a space read alone, and the export's chooser
 * and writer that graph answers share. Held to the sources and the guide by `every-code-the-sparql-endpoint-answers-is-listed`.
 */
export const SPARQL_ENDPOINT_CODES: readonly string[] = Object.freeze([
  ...SPARQL_REFUSAL_CODES, SPARQL_NO_QUERY, SPARQL_BAD_LIMIT, SPARQL_BAD_DATASET, SPARQL_NOT_ACCEPTABLE, SPARQL_UNSUPPORTED_MEDIA_TYPE,
  RDF_NOT_ENABLED, 'rdf_base_conflict', RDF_BASE_SHARED, 'rdf_term_clash', RDF_UNWRITABLE, RDF_FORMAT_NOT_ACCEPTABLE,
]);

/** What an answer says it left out, as MCP's `warnings` name it (REST says the same in headers). */
export const SPARQL_MEMBERS_LEFT_OUT = 'members_left_out';
export const SPARQL_FILE_TRIPLES_WITHHELD = 'file_triples_withheld';
export const SPARQL_WARNING_CODES: readonly string[] = Object.freeze([SPARQL_MEMBERS_LEFT_OUT, SPARQL_FILE_TRIPLES_WITHHELD]);

/** The four query forms. */
export type SparqlForm = 'select' | 'ask' | 'construct' | 'describe';

/** The result formats a SELECT or ASK answers in, in preference order; `application/json` is answered as SPARQL results JSON. */
export const SPARQL_RESULT_TYPES = Object.freeze(['application/sparql-results+json', 'application/json', 'text/csv', 'text/tab-separated-values'] as const);
type ResultType = (typeof SPARQL_RESULT_TYPES)[number];
/** The graph formats a CONSTRUCT or DESCRIBE answers in, as the export offers them for one graph (r2 R3.2: no N-Triples, no TriG). */
export const SPARQL_GRAPH_FORMATS: readonly RdfFormat[] = Object.freeze(['turtle', 'nquads', 'jsonld']);
const JSON_TYPE = 'application/sparql-results+json';

/** A refusal: its status, code and words, a parse error's position, and the wait a 503 tells. */
export interface SparqlAnswerRefusal {
  status: number; code: string; error: string; line?: number; column?: number; retryAfterSeconds?: number; detail?: Record<string, unknown>;
}

/** What a door hands the act. */
export interface SparqlQueryInput {
  /** The space or view id the caller named. */
  spaceId: string;
  /** The spaces the door's guard accepted: the space, or the view's readable members. */
  spaces: readonly string[];
  /** The caller named its own view. */
  view: boolean;
  query: unknown;
  limit: unknown;
  defaultGraphUri: unknown;
  namedGraphUri: unknown;
  /** The REST `Accept` header; absent on MCP (results JSON, a graph in Turtle). */
  accept: string | undefined;
  caller: RdfCaller | undefined;
  /** Who the slot counts against: the token's id, or the address of a caller with none. */
  callerKey: string;
  fingerprintOf: FingerprintOf;
  /** Aborts when the caller goes away. */
  signal?: AbortSignal;
}

/** The parameters, the members and the format of a query, judged before anything runs. */
export interface PreparedSparql {
  algebra: SparqlAlgebra;
  form: SparqlForm;
  vars: string[];
  length: number;
  bound: number;
  /** The members the source reads; and those left out, with the code each answers alone. */
  members: string[];
  leftOut: string[];
  filesWithheld: string[];
  /** The negotiated answer: a result type, or a graph format. */
  resultType: ResultType | null;
  graphFormat: RdfFormat | null;
  /** The Content-Type a GET answers with (a graph's version parameter is known only once its statements are). */
  contentType: string;
}

/** A row of a SELECT as SPARQL results JSON writes it: each bound variable's term. */
export type JsonTerm =
  | { type: 'uri' | 'bnode'; value: string }
  | { type: 'literal'; value: string; 'xml:lang'?: string; datatype?: string }
  | { type: 'triple'; value: { subject: JsonTerm; predicate: JsonTerm; object: JsonTerm } };
export type JsonRow = Record<string, JsonTerm>;

/** A collected answer, before it is written. */
export type SparqlCollected =
  | { form: 'select'; vars: string[]; rows: JsonRow[] }
  | { form: 'ask'; boolean: boolean }
  | { form: 'construct' | 'describe'; quads: Quad[] };

/** A collected answer and what the door says about it. */
export interface SparqlAnswer {
  prepared: PreparedSparql;
  collected: SparqlCollected;
  rows: number;
  recordsRead: number;
  /** The audit row's `changes`. */
  auditChanges: Array<{ field: string; to: string | number | boolean }>;
}

const XSD_STRING = 'http://www.w3.org/2001/XMLSchema#string';
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';
const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';
/** The algebra nodes a query form is wrapped in. */
const WRAPPERS: ReadonlySet<string> = new Set(['from', 'slice', 'distinct', 'reduced', 'orderby']);
/** The most wrappers a query form is looked for under: a parsed query has a handful. */
const WRAPPER_DEPTH_MAX = 64;
/** A UCHAR escape (`\uXXXX`): the code unit in hexadecimal, four digits. */
const HEX = 16;
const UCHAR_DIGITS = 4;

/** The form of a parsed query and, for a SELECT, its projected variables in order. */
export function formOf(algebra: unknown): { form: SparqlForm; vars: string[] } {
  let node: unknown = algebra;
  for (let depth = 0; depth < WRAPPER_DEPTH_MAX && isRecord(node); depth++) {
    const type = node['type'];
    if (type === 'ask') return { form: 'ask', vars: [] };
    if (type === 'construct') return { form: 'construct', vars: [] };
    if (type === 'describe') return { form: 'describe', vars: [] };
    if (type === 'project') {
      const vars = Array.isArray(node['variables']) ? node['variables'].filter(isRecord).map(v => String(v['value'])) : [];
      return { form: 'select', vars };
    }
    if (typeof type === 'string' && WRAPPERS.has(type)) { node = node['input']; continue; }
    break;
  }
  return { form: 'select', vars: [] };
}

/** A protocol parameter that may repeat: absent, one text or several; anything else is null (refused). */
function texts(v: unknown): string[] | null {
  if (v === undefined) return [];
  if (typeof v === 'string') return [v];
  if (Array.isArray(v) && v.every(x => typeof x === 'string')) return v as string[];
  return null;
}

const refusal = (status: number, code: string, error: string, extra: Partial<SparqlAnswerRefusal> = {}): SparqlAnswerRefusal => ({ status, code, error, ...extra });

/** Log one refusal: its code and the member count, never the query. */
function said(r: SparqlAnswerRefusal, members: number): SparqlAnswerRefusal {
  log.warn(`SPARQL query refused (${peerText(r.code, { max: NAME_QUOTED })}, status ${r.status}) over ${members} member(s)`);
  return r;
}

/**
 * The parameters both doors take, after the door's spelling is read (a URL's `limit` as a number, a lone graph IRI as a list of one). The
 * ceiling of `limit` is `sparql.maxResults`, read live, so it is judged beside this schema. NOT strict: a key it does not name is dropped.
 */
export const SparqlQueryParams = z.object({
  // Optional here as on the tool: an absent query is refused by its own code below, the same on both doors.
  query: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(SPARQL_LIMIT_BOUNDS.maxResults.max).optional(),
  // A graph is a member space's: at most as many as a request may name spaces.
  'default-graph-uri': z.array(z.string()).max(MAX_SPACE_IDS).optional(),
  'named-graph-uri': z.array(z.string()).max(MAX_SPACE_IDS).optional(),
});

/** The code a parameter's refusal answers. */
const PARAM_CODES: Readonly<Record<string, string>> = {
  query: SPARQL_NO_QUERY, limit: SPARQL_BAD_LIMIT, 'default-graph-uri': SPARQL_BAD_DATASET, 'named-graph-uri': SPARQL_BAD_DATASET,
};
const PARAM_WORDS: Readonly<Record<string, string>> = {
  [SPARQL_NO_QUERY]: 'Send the query as exactly one `query` parameter (or as the body of an application/sparql-query POST)',
  [SPARQL_BAD_DATASET]: 'default-graph-uri and named-graph-uri each take one or more IRIs as text',
};

/** Judge the parameters, parse and check the query, read the members and negotiate the answer; runs nothing. */
export async function prepareSparql(input: SparqlQueryInput): Promise<PreparedSparql | SparqlAnswerRefusal> {
  const n = input.spaces.length;
  const { maxResults } = sparqlLimits(getConfig());
  const limitWords = `limit must be a whole number from 1 to ${maxResults} (sparql.maxResults)`;
  const parsed = SparqlQueryParams.safeParse({
    query: typeof input.query === 'string' && input.query.trim() === '' ? undefined : input.query, limit: queryInt(input.limit),
    'default-graph-uri': texts(input.defaultGraphUri) ?? input.defaultGraphUri, 'named-graph-uri': texts(input.namedGraphUri) ?? input.namedGraphUri,
  });
  if (!parsed.success) {
    const code = PARAM_CODES[String(refusalOfParse(parsed.error).issues[0]?.path[0] ?? 'query')] ?? SPARQL_NO_QUERY;
    return said(refusal(SPARQL_BAD_REQUEST, code, PARAM_WORDS[code] ?? limitWords), n);
  }
  const { query: q, limit } = parsed.data;
  if (q === undefined) return said(refusal(SPARQL_BAD_REQUEST, SPARQL_NO_QUERY, PARAM_WORDS[SPARQL_NO_QUERY]!), n);
  if (limit !== undefined && limit > maxResults) return said(refusal(SPARQL_BAD_REQUEST, SPARQL_BAD_LIMIT, limitWords), n);
  const bound = limit ?? maxResults;
  const defaults = parsed.data['default-graph-uri'] ?? [];
  const named = parsed.data['named-graph-uri'] ?? [];
  const checked = await checkSparqlAlgebra(q, {
    ...(defaults.length > 0 ? { defaultGraphUri: defaults } : {}), ...(named.length > 0 ? { namedGraphUri: named } : {}),
  });
  if ('refusal' in checked) {
    const r = checked.refusal;
    return said(refusal(r.status, r.code, r.error, { ...(r.line !== undefined ? { line: r.line } : {}), ...(r.column !== undefined ? { column: r.column } : {}) }), n);
  }
  const { form, vars } = formOf(checked.algebra);
  const graph = form === 'construct' || form === 'describe';
  let resultType: ResultType | null = null;
  let graphFormat: RdfFormat | null = null;
  let contentType: string;
  if (graph) {
    const choice = chooseRdfFormat({ accept: input.accept, members: 1, offered: SPARQL_GRAPH_FORMATS });
    if (!choice.ok) return said(refusal(choice.status, choice.code, choice.error, { detail: { formats: choice.formats } }), n);
    graphFormat = choice.format;
    contentType = rdfContentType(choice.format, undefined);
  } else {
    const pick = preferredByAccept(input.accept, SPARQL_RESULT_TYPES);
    if (pick.kind === 'none') {
      return said(refusal(SPARQL_NOT_ACCEPTABLE_STATUS, SPARQL_NOT_ACCEPTABLE, `Accept names none of the formats a ${form.toUpperCase()} answers in: ${SPARQL_RESULT_TYPES.join(', ')}`), n);
    }
    resultType = pick.kind === 'chosen' ? pick.mediaType : JSON_TYPE;
    contentType = resultType === 'application/json' ? JSON_TYPE : resultType;
  }
  const scope = rdfMembers(input.spaces, input.caller, input.fingerprintOf);
  const first = scope.leftOut[0];
  if (!input.view && first && scope.members.length === 0) {
    return said(refusal(first.status, first.code, first.error, first.detail ? { detail: first.detail } : {}), n);
  }
  return {
    algebra: checked.algebra, form, vars, length: Buffer.byteLength(q, 'utf8'), bound,
    members: scope.members.map(m => m.space), leftOut: scope.leftOut.map(l => l.space),
    filesWithheld: scope.members.filter(m => !m.files).map(m => m.space),
    resultType, graphFormat, contentType,
  };
}

/** An RDF/JS term as SPARQL results JSON writes it. */
function jsonTerm(t: { termType: string; value: string; language?: string; datatype?: { value: string }; subject?: unknown; predicate?: unknown; object?: unknown }): JsonTerm {
  switch (t.termType) {
    case 'NamedNode': return { type: 'uri', value: t.value };
    case 'BlankNode': return { type: 'bnode', value: t.value };
    case 'Quad': return { type: 'triple', value: { subject: jsonTerm(t.subject as never), predicate: jsonTerm(t.predicate as never), object: jsonTerm(t.object as never) } };
    default: {
      if (t.language) return { type: 'literal', value: t.value, 'xml:lang': t.language };
      const dt = t.datatype?.value;
      return dt && dt !== XSD_STRING && dt !== RDF_LANG_STRING ? { type: 'literal', value: t.value, datatype: dt } : { type: 'literal', value: t.value };
    }
  }
}

/** The answer to a query the door has judged: run once, collected whole up to the bound, in a slot. */
export async function answerSparql(input: SparqlQueryInput, p: PreparedSparql): Promise<SparqlAnswer | SparqlAnswerRefusal> {
  const n = input.spaces.length;
  const slot = takeSlot('sparql', input.callerKey);
  if (!slot) {
    const { retryAfterSeconds, instance, perCaller } = SLOT_FAMILIES.sparql;
    return said(refusal(SPARQL_UNAVAILABLE, SPARQL_BUSY,
      `A query is already running for this caller, or as many as the instance runs at once (${instance}, ${perCaller} per caller): try again when it ends`,
      { retryAfterSeconds }), n);
  }
  let result: SparqlResult | null = null;
  let onAbort: (() => void) | null = null;
  try {
    const { timeoutMs } = sparqlLimits(getConfig());
    const deadline = Date.now() + timeoutMs;
    const source = createQuadSource({ members: input.spaces, caller: input.caller, fingerprintOf: input.fingerprintOf }, { deadline, ...(input.signal ? { signal: input.signal } : {}) });
    if (input.signal?.aborted) throw new CallerGone();
    result = await runSparql(p.algebra, source, { deadline, ...(input.signal ? { signal: input.signal } : {}) });
    const running = result;
    // The engine's own reader ends on the abort too; the answer is not left waiting on it, and the engine is stopped here at once.
    const gone = new Promise<never>((_, reject) => {
      onAbort = () => { running.destroy(); reject(new CallerGone()); };
      if (input.signal?.aborted) onAbort(); else input.signal?.addEventListener('abort', onAbort, { once: true });
    });
    gone.catch(() => { /* raced below */ });
    const taken = await Promise.race([running.rows(p.bound + 1), gone]);
    let collected: SparqlCollected;
    let rows: number;
    if (typeof taken === 'boolean') {
      collected = { form: 'ask', boolean: taken };
      rows = 1;
    } else {
      if (taken.length > p.bound) {
        return said(refusal(SPARQL_TOO_LARGE, SPARQL_TOO_MANY_RESULTS,
          `The answer holds more than ${p.bound} ${p.form === 'select' ? 'rows' : 'statements'} (sparql.maxResults, or the limit you sent), so none of it is answered: narrow the query or add LIMIT`), n);
      }
      rows = taken.length;
      if (p.form === 'select') {
        const vars = p.vars.length > 0 ? p.vars : [...new Set((taken as Array<Record<string, unknown>>).flatMap(r => Object.keys(r)))];
        collected = { form: 'select', vars, rows: (taken as Array<Record<string, never>>).map(r => Object.fromEntries(Object.entries(r).map(([k, t]) => [k, jsonTerm(t)]))) };
      } else {
        const quads: Quad[] = [];
        try {
          for (const q of taken) quads.push(fromRdfJs(q as never));
        } catch {
          return said(unwritable(), n);
        }
        collected = { form: p.form === 'describe' ? 'describe' : 'construct', quads };
      }
    }
    const recordsRead = source.recordsRead();
    return {
      prepared: p, collected, rows, recordsRead,
      auditChanges: [
        { field: 'form', to: p.form }, { field: 'length', to: p.length }, { field: 'members', to: p.members.length },
        { field: 'recordsRead', to: recordsRead }, { field: 'rows', to: rows }, { field: 'outcome', to: 'answered' },
      ],
    };
  } catch (err) {
    if (err instanceof CallerGone) throw err;
    const named = sparqlRefusalOf(err);
    if (named) {
      return said(refusal(named.status, named.code, named.message, named.retryAfterSeconds !== undefined ? { retryAfterSeconds: named.retryAfterSeconds } : {}), n);
    }
    if (input.signal?.aborted) throw new CallerGone();
    throw err;
  } finally {
    if (onAbort) input.signal?.removeEventListener('abort', onAbort);
    result?.destroy();
    slot.release();
  }
}

/** The caller went away before the answer was collected: nothing is answered. */
export class CallerGone extends Error {
  constructor() { super('The caller went away before the answer was collected'); this.name = 'CallerGone'; }
}

/** The refusal of an answer holding a term no document can carry; it names no part of the term (the term may be the query's text). */
export const unwritable = (): SparqlAnswerRefusal => refusal(EXPORT_CONFLICT, RDF_UNWRITABLE,
  'The answer holds a term no document of this format can carry (an IRI with a character an IRI cannot hold, or a triple term in JSON-LD): ask for another format, or construct other terms');

/** A rendered answer: its Content-Type and its bytes. */
export interface RenderedAnswer { contentType: string; body: string }

/** Write a collected answer in the negotiated format (`p.resultType` or `p.graphFormat`). */
export function renderSparql(p: PreparedSparql, c: SparqlCollected): RenderedAnswer | SparqlAnswerRefusal {
  if ('quads' in c) return renderGraph(p.graphFormat ?? 'turtle', c.quads);
  const type = p.resultType ?? JSON_TYPE;
  if (type === 'text/csv') return { contentType: 'text/csv; charset=utf-8', body: c.form === 'ask' ? askLines(c.boolean) : csvOf(c.vars, c.rows) };
  if (type === 'text/tab-separated-values') return { contentType: 'text/tab-separated-values; charset=utf-8', body: c.form === 'ask' ? askLines(c.boolean) : tsvOf(c.vars, c.rows) };
  return { contentType: JSON_TYPE, body: JSON.stringify(resultsJson(c)) };
}

/** The SPARQL results JSON body of a SELECT or ASK: `{head, results}` or `{head, boolean}`, no key of its own. */
export function resultsJson(c: Extract<SparqlCollected, { form: 'select' | 'ask' }>): Record<string, unknown> {
  return c.form === 'ask' ? { head: {}, boolean: c.boolean } : { head: { vars: c.vars }, results: { bindings: c.rows } };
}

/** An ASK in CSV or TSV: a header row and `true` or `false`. */
const askLines = (b: boolean): string => `_askResult\r\n${String(b)}\r\n`;

/** A CSV field (RFC 4180): quoted when it holds a quote, a comma or a line break. */
const csvField = (s: string): string => (/[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s);
/** A term's CSV value (SPARQL 1.1 CSV: the plain value, a blank node as `_:id`). */
function csvValue(t: JsonTerm | undefined): string {
  if (!t) return '';
  if (t.type === 'bnode') return `_:${t.value}`;
  if (t.type === 'triple') return `<< ${tsvTerm(t.value.subject)} ${tsvTerm(t.value.predicate)} ${tsvTerm(t.value.object)} >>`;
  return t.value;
}
function csvOf(vars: string[], rows: JsonRow[]): string {
  const lines = [vars.map(csvField).join(',')];
  for (const r of rows) lines.push(vars.map(v => csvField(csvValue(r[v]))).join(','));
  return `${lines.join('\r\n')}\r\n`;
}

/** An IRI as Turtle writes it, every character an IRIREF cannot hold escaped (`\uXXXX`), so no IRI ends early. */
function iriRef(value: string): string {
  return `<${value.replace(/[\u0000- <>"{}|^`\\]/g, ch => `\\u${ch.charCodeAt(0).toString(HEX).toUpperCase().padStart(UCHAR_DIGITS, '0')}`)}>`;
}
/** A literal's text as Turtle writes it. */
const quoted = (s: string): string => `"${s.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n').replace(/\r/g, '\\r').replace(/\t/g, '\\t')}"`;
/** A term as SPARQL 1.1 TSV writes it: Turtle syntax. */
function tsvTerm(t: JsonTerm | undefined): string {
  if (!t) return '';
  switch (t.type) {
    case 'uri': return iriRef(t.value);
    case 'bnode': return `_:${t.value.replace(/[^\w-]/g, '_')}`;
    case 'triple': return `<<( ${tsvTerm(t.value.subject)} ${tsvTerm(t.value.predicate)} ${tsvTerm(t.value.object)} )>>`;
    default: {
      const lang = t['xml:lang'];
      if (lang) return `${quoted(t.value)}@${lang.replace(/[^A-Za-z\d-]/g, '')}`;
      return t.datatype ? `${quoted(t.value)}^^${iriRef(t.datatype)}` : quoted(t.value);
    }
  }
}
function tsvOf(vars: string[], rows: JsonRow[]): string {
  const lines = [vars.map(v => `?${v}`).join('\t')];
  for (const r of rows) lines.push(vars.map(v => tsvTerm(r[v])).join('\t'));
  return `${lines.join('\n')}\n`;
}

/** Does a statement hold a triple term (only an object can)? */
export const holdsTriple = (q: Quad): boolean => q.object.kind === 'triple';

/** A graph answer by the export's writer: RDF 1.2 (announced) only when a statement holds a triple term. */
export function renderGraph(format: RdfFormat, quads: readonly Quad[]): RenderedAnswer | SparqlAnswerRefusal {
  const edgeDetails = quads.some(holdsTriple) ? 'rdf12' : 'reification';
  try {
    const writer = createRdfWriter(format, { edgeDetails });
    const body = writer.open() + writer.write({ quads }) + writer.close();
    return { contentType: rdfContentType(format, rdfVersionOf(format, edgeDetails)), body };
  } catch (err) {
    if (err instanceof RdfWriteError) return unwritable();
    throw err;
  }
}

/** The member ids a door names in a header: percent-encoded (a header value is Latin-1), joined. */
export const headerList = (ids: readonly string[]): string => ids.map(encodeURIComponent).join(', ');
