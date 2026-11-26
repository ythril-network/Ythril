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
import { takeSlot } from '../util/slots.js';
import { log, peerText, NAME_QUOTED, refusalOfParse } from '../util/log.js';
import { MAX_SPACE_IDS } from '../util/request-bounds.js';
import { preferredByAccept } from '../http/accept-weigh.js';
import { checkSparqlAlgebra, runSparql, type SparqlAlgebra, type SparqlResult } from './sparql-engine.js';
import {
  SPARQL_REFUSAL_CODES, SPARQL_BAD_REQUEST, SPARQL_TOO_LARGE, SPARQL_TOO_MANY_RESULTS, busyRefusal, sparqlRefusalOf,
} from './sparql-refusal.js';
import { renderGraph, unwritable, type RenderedAnswer } from './graph-render.js';
import { createQuadSource } from './quad-source.js';
import { readAcrossSwaps } from './read-across-swaps.js';
import { rdfMembers } from './rdf-members.js';
import { fromRdfJs, type RdfJsLike } from './rdf-js-terms.js';
import type { RdfFormat } from './serialize.js';
import { chooseRdfFormat, rdfContentType, RDF_FORMAT_NOT_ACCEPTABLE } from './export-format.js';
import type { Quad } from './literals.js';
import { RDF_NOT_ENABLED, RDF_BASE_SHARED, RDF_BASE_NESTED, RDF_UNWRITABLE, type RdfCaller, type FingerprintOf } from './rdf-space-state.js';

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
  RDF_NOT_ENABLED, 'rdf_base_conflict', RDF_BASE_SHARED, RDF_BASE_NESTED, 'rdf_term_clash', RDF_UNWRITABLE, RDF_FORMAT_NOT_ACCEPTABLE,
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

/** The audit row's `changes` of a query: counts and the outcome, never the text. */
export type SparqlAuditChanges = Array<{ field: string; to: string | number | boolean }>;

/**
 * A refusal: its status, code and words, a parse error's position, and the wait a 503 tells. A refusal of the run itself (a bound, a slot, an
 * unwritable term) carries the audit changes of the query it ended, with its code as the outcome; a refusal of the parameters has none.
 */
export interface SparqlAnswerRefusal {
  status: number; code: string; error: string; line?: number; column?: number; retryAfterSeconds?: number; detail?: Record<string, unknown>;
  auditChanges?: SparqlAuditChanges;
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
  auditChanges: SparqlAuditChanges;
}

/** The audit changes of a query on any path: its form, length, member count, records read, rows answered and how it ended. */
function auditChangesOf(who: { form: string; length: number; members: number }, recordsRead: number, rows: number, outcome: string): SparqlAuditChanges {
  return [
    { field: 'form', to: who.form }, { field: 'length', to: who.length }, { field: 'members', to: who.members },
    { field: 'recordsRead', to: recordsRead }, { field: 'rows', to: rows }, { field: 'outcome', to: outcome },
  ];
}

/** What a judged query says about itself in its audit row. */
const countsOf = (p: PreparedSparql): { form: string; length: number; members: number } => ({ form: p.form, length: p.length, members: p.members.length });

/** The outcome of a query that was answered. */
export const SPARQL_OUTCOME_ANSWERED = 'answered';
/** The outcome of a query the engine failed on with an error nothing maps (it has no code: the answer is the app's generic 500). */
export const SPARQL_OUTCOME_ENGINE_FAILED = 'engine_failed';

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
function refusalLogged(r: SparqlAnswerRefusal, members: number): SparqlAnswerRefusal {
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

/**
 * Judge the parameters, parse and check the query, read the members and negotiate the answer; runs nothing. A refusal carries the audit
 * changes of the query it refused (lens-3 audit counts): its length and the members the guard accepted, nothing read, and its code as the
 * outcome; the form is `unknown`, as no refusal of the parameters is sure of one.
 */
export async function prepareSparql(input: SparqlQueryInput): Promise<PreparedSparql | SparqlAnswerRefusal> {
  const judged = await judgeSparql(input);
  if (!isSparqlRefusal(judged)) return judged;
  const length = typeof input.query === 'string' ? Buffer.byteLength(input.query, 'utf8') : 0;
  return { ...judged, auditChanges: auditChangesOf({ form: 'unknown', length, members: input.spaces.length }, 0, 0, judged.code) };
}

async function judgeSparql(input: SparqlQueryInput): Promise<PreparedSparql | SparqlAnswerRefusal> {
  const n = input.spaces.length;
  const { maxResults } = sparqlLimits(getConfig());
  const limitWords = `limit must be a whole number from 1 to ${maxResults} (sparql.maxResults)`;
  const parsed = SparqlQueryParams.safeParse({
    query: typeof input.query === 'string' && input.query.trim() === '' ? undefined : input.query, limit: queryInt(input.limit),
    'default-graph-uri': texts(input.defaultGraphUri) ?? input.defaultGraphUri, 'named-graph-uri': texts(input.namedGraphUri) ?? input.namedGraphUri,
  });
  if (!parsed.success) {
    const code = PARAM_CODES[String(refusalOfParse(parsed.error).issues[0]?.path[0] ?? 'query')] ?? SPARQL_NO_QUERY;
    return refusalLogged(refusal(SPARQL_BAD_REQUEST, code, PARAM_WORDS[code] ?? limitWords), n);
  }
  const { query: q, limit } = parsed.data;
  if (q === undefined) return refusalLogged(refusal(SPARQL_BAD_REQUEST, SPARQL_NO_QUERY, PARAM_WORDS[SPARQL_NO_QUERY]!), n);
  if (limit !== undefined && limit > maxResults) return refusalLogged(refusal(SPARQL_BAD_REQUEST, SPARQL_BAD_LIMIT, limitWords), n);
  const bound = limit ?? maxResults;
  const defaults = parsed.data['default-graph-uri'] ?? [];
  const named = parsed.data['named-graph-uri'] ?? [];
  const checked = await checkSparqlAlgebra(q, {
    ...(defaults.length > 0 ? { defaultGraphUri: defaults } : {}), ...(named.length > 0 ? { namedGraphUri: named } : {}),
  });
  if ('refusal' in checked) {
    const r = checked.refusal;
    return refusalLogged(refusal(r.status, r.code, r.error, { ...(r.line !== undefined ? { line: r.line } : {}), ...(r.column !== undefined ? { column: r.column } : {}) }), n);
  }
  const { form, vars } = formOf(checked.algebra);
  const graph = form === 'construct' || form === 'describe';
  let resultType: ResultType | null = null;
  let graphFormat: RdfFormat | null = null;
  let contentType: string;
  if (graph) {
    const choice = chooseRdfFormat({ accept: input.accept, members: 1, offered: SPARQL_GRAPH_FORMATS });
    if (!choice.ok) return refusalLogged(refusal(choice.status, choice.code, choice.error, { detail: { formats: choice.formats } }), n);
    graphFormat = choice.format;
    contentType = rdfContentType(choice.format, undefined);
  } else {
    const pick = preferredByAccept(input.accept, SPARQL_RESULT_TYPES);
    if (pick.kind === 'none') {
      return refusalLogged(refusal(SPARQL_NOT_ACCEPTABLE_STATUS, SPARQL_NOT_ACCEPTABLE, `Accept names none of the formats a ${form.toUpperCase()} answers in: ${SPARQL_RESULT_TYPES.join(', ')}`), n);
    }
    resultType = pick.kind === 'chosen' ? pick.mediaType : JSON_TYPE;
    contentType = resultType === 'application/json' ? JSON_TYPE : resultType;
  }
  const scope = rdfMembers(input.spaces, input.caller, input.fingerprintOf);
  const first = scope.leftOut[0];
  if (!input.view && first && scope.members.length === 0) {
    return refusalLogged(refusal(first.status, first.code, first.error, first.detail ? { detail: first.detail } : {}), n);
  }
  return {
    algebra: checked.algebra, form, vars, length: Buffer.byteLength(q, 'utf8'), bound,
    members: scope.members.map(m => m.space), leftOut: scope.leftOut.map(l => l.space),
    filesWithheld: scope.members.filter(m => !m.files).map(m => m.space),
    resultType, graphFormat, contentType,
  };
}

/** An RDF/JS term as SPARQL results JSON writes it. */
function jsonTerm(t: RdfJsLike): JsonTerm {
  switch (t.termType) {
    case 'NamedNode': return { type: 'uri', value: t.value };
    case 'BlankNode': return { type: 'bnode', value: t.value };
    case 'Quad': return { type: 'triple', value: { subject: jsonTerm(t.subject!), predicate: jsonTerm(t.predicate!), object: jsonTerm(t.object!) } };
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
  let source: ReturnType<typeof createQuadSource> | null = null;
  /** Every refusal of the run is logged and carries the audit changes of the query it ended: the counts so far, no row answered, its code. */
  const refuseRun = (r: SparqlAnswerRefusal): SparqlAnswerRefusal => refusalLogged({ ...r, auditChanges: auditChangesOf(countsOf(p), source?.recordsRead() ?? 0, 0, r.code) }, n);
  const slot = takeSlot('sparql', input.callerKey);
  if (!slot) {
    const { status, code, error, retryAfterSeconds } = busyRefusal('sparql');
    return refuseRun(refusal(status, code, error, { retryAfterSeconds }));
  }
  let result: SparqlResult | null = null;
  let onAbort: (() => void) | null = null;
  try {
    const { timeoutMs, maxResultBytes } = sparqlLimits(getConfig());
    const deadline = Date.now() + timeoutMs;
    // R5 (design-r2): a member read from an index that a rebuild swapped while the query ran is read again from its records.
    const open = (recordsFor: readonly string[]): ReturnType<typeof createQuadSource> => {
      startOver();
      source = createQuadSource({ members: input.spaces, caller: input.caller, fingerprintOf: input.fingerprintOf },
        { deadline, ...(recordsFor.length > 0 ? { recordsFor } : {}), ...(input.signal ? { signal: input.signal } : {}) });
      return source;
    };
    return await readAcrossSwaps(open, made => answerOnce(made, deadline, maxResultBytes), err => err instanceof CallerGone);
  } catch (err) {
    if (err instanceof CallerGone) throw err;
    const named = sparqlRefusalOf(err);
    if (named) {
      return refuseRun(refusal(named.status, named.code, named.message, named.retryAfterSeconds !== undefined ? { retryAfterSeconds: named.retryAfterSeconds } : {}));
    }
    if (input.signal?.aborted) throw new CallerGone();
    // An error nothing here maps: only its class goes on. Its message may hold the query's text (an engine names the function or the IRI it
    // met), and a thrown error is logged by whoever catches it, so what is thrown is a fixed sentence and the class.
    // Set inside `open`, which the compiler's narrowing of this scope does not see.
    const read = (source as ReturnType<typeof createQuadSource> | null)?.recordsRead() ?? 0;
    throw new SparqlEngineFailure(err, auditChangesOf(countsOf(p), read, 0, SPARQL_OUTCOME_ENGINE_FAILED));
  } finally {
    if (onAbort) input.signal?.removeEventListener('abort', onAbort);
    // Set inside `answerOnce`, which the compiler's narrowing of this scope does not see.
    (result as SparqlResult | null)?.destroy();
    slot.release();
  }

  /** Before a run: the engine of a run given up for it stopped and its abort listener taken off (none before the first). */
  function startOver(): void {
    if (onAbort) input.signal?.removeEventListener('abort', onAbort);
    onAbort = null;
    result?.destroy();
    result = null;
  }

  /** One run of the query over `made`, collected whole up to the bound. */
  async function answerOnce(made: ReturnType<typeof createQuadSource>, deadline: number, maxResultBytes: number): Promise<SparqlAnswer | SparqlAnswerRefusal> {
    if (input.signal?.aborted) throw new CallerGone();
    result = await runSparql(p.algebra, made, { deadline, ...(input.signal ? { signal: input.signal } : {}) });
    const running = result;
    // The engine's own reader ends on the abort too; the answer is not left waiting on it, and the engine is stopped here at once.
    const gone = new Promise<never>((_, reject) => {
      onAbort = () => { running.destroy(); reject(new CallerGone()); };
      if (input.signal?.aborted) onAbort(); else input.signal?.addEventListener('abort', onAbort, { once: true });
    });
    gone.catch(() => { /* raced below */ });
    const tooMany = (): SparqlAnswerRefusal => refuseRun(refusal(SPARQL_TOO_LARGE, SPARQL_TOO_MANY_RESULTS,
      `The answer holds more than ${p.bound} ${p.form === 'select' ? 'rows' : 'statements'} (sparql.maxResults, or the limit you sent), so none of it is answered: narrow the query or add LIMIT`));
    let collected: SparqlCollected;
    let rows: number;
    if (running.kind === 'boolean') {
      collected = { form: 'ask', boolean: await Promise.race([running.rows(), gone]) };
      rows = 1;
    } else if (running.kind === 'bindings') {
      const taken = await Promise.race([running.rows(p.bound + 1, maxResultBytes), gone]);
      if (taken.length > p.bound) return tooMany();
      rows = taken.length;
      const vars = p.vars.length > 0 ? p.vars : [...new Set(taken.flatMap(r => Object.keys(r)))];
      collected = { form: 'select', vars, rows: taken.map(r => Object.fromEntries(Object.entries(r).map(([k, t]) => [k, jsonTerm(t)]))) };
    } else {
      const taken = await Promise.race([running.rows(p.bound + 1, maxResultBytes), gone]);
      if (taken.length > p.bound) return tooMany();
      rows = taken.length;
      const quads: Quad[] = [];
      try {
        for (const q of taken) quads.push(fromRdfJs(q));
      } catch {
        return refuseRun(unwritable());
      }
      collected = { form: p.form === 'describe' ? 'describe' : 'construct', quads };
    }
    const recordsRead = made.recordsRead();
    return { prepared: p, collected, rows, recordsRead, auditChanges: auditChangesOf(countsOf(p), recordsRead, rows, SPARQL_OUTCOME_ANSWERED) };
  }
}

/** The most of an error class's name a failure repeats: a class name is an identifier, and anything else is not one. */
const CLASS_NAME = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * An engine error nothing maps, as the act throws it: a fixed sentence and the error's class name, no message, no stack and no cause (each
 * may hold text of the query, which no log line, error body or audit row carries).
 */
export class SparqlEngineFailure extends Error {
  /** The audit changes of the query it ended: its counts so far, and `engine_failed` as the outcome. */
  readonly auditChanges: SparqlAuditChanges;
  constructor(cause: unknown, auditChanges: SparqlAuditChanges) {
    const name = cause instanceof Error && CLASS_NAME.test(cause.constructor.name) ? cause.constructor.name : 'a non-Error value';
    super(`The SPARQL engine failed with an error of class ${name}; its message is not kept, as it may hold the query`);
    this.name = 'SparqlEngineFailure';
    this.auditChanges = auditChanges;
  }
}

/** The caller went away before the answer was collected: nothing is answered. */
export class CallerGone extends Error {
  constructor() { super('The caller went away before the answer was collected'); this.name = 'CallerGone'; }
}

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

/** Is `v` a refusal of this act (a status and a code), as `prepareSparql` and `answerSparql` answer one? The one check both doors make. */
export const isSparqlRefusal = (v: unknown): v is SparqlAnswerRefusal =>
  typeof (v as SparqlAnswerRefusal | null)?.code === 'string' && typeof (v as SparqlAnswerRefusal).status === 'number';

/** The `{ error, code, ... }` body a refusal is answered with, on the wire of either door: a parse error's position, the wait of a 503, the detail. */
export function sparqlRefusalBody(r: SparqlAnswerRefusal): Record<string, unknown> {
  return {
    error: r.error, code: r.code, ...(r.line !== undefined ? { line: r.line } : {}), ...(r.column !== undefined ? { column: r.column } : {}),
    ...(r.retryAfterSeconds !== undefined ? { retryAfterSeconds: r.retryAfterSeconds } : {}), ...(r.detail ?? {}),
  };
}

/** The member ids a door names in a header: percent-encoded (a header value is Latin-1), joined. */
export const headerList = (ids: readonly string[]): string => ids.map(encodeURIComponent).join(', ');
