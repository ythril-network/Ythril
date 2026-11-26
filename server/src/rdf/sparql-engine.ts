/**
 * The one SPARQL engine of the server and the check every query passes before it runs (bundle-271, Q-756; design §1.3, r2 R2.1-R2.5, R4.1).
 * The endpoint (Q-757) and the Linked Data reads (Q-758) call it; they put its answer on their wire.
 *
 * ## What it prevents
 *
 * - **A query that makes the server fetch.** Comunica 5.5.0 ships an HTTP actor family and a SERVICE executor, so a `SERVICE <http://...>`,
 *   a `LOAD` or a dataset it dereferences would make the server request an address a caller chose. Three walls:
 *   1. {@link checkSparqlAlgebra} parses the text once, with the engine's own parser, and walks the whole algebra (every operation and every
 *      expression, EXISTS, subqueries, OPTIONAL, MINUS, UNION included): any SERVICE, SILENT or with a variable target, is
 *      `400 sparql_federation_refused`; any update, LOAD included, `400 sparql_update_not_here`. The algebra it hands back is what runs,
 *      never the text again.
 *   2. FROM, FROM NAMED and the protocol's `default-graph-uri` / `named-graph-uri` only restrict the dataset: an outside graph holds
 *      nothing, so its answer is empty, never a refusal that would say which graphs exist (`dereferenceFromNamed` is off).
 *   3. {@link runSparql} runs the engine with a fetch that refuses, an HTTP timeout of 1 ms and `readOnly`; the engine's HTTP bus has no
 *      actor ({@link httpBusActors}, held by `a-sparql-query-never-reaches-the-network`).
 * - **A text or a pattern the server cannot bound.** The text is refused past {@link SPARQL_QUERY_MAX_BYTES} UTF-8 bytes before it is
 *   parsed; `REGEX` and `REPLACE` run a caller's pattern on every row, so a pattern or flags that are no literal, a pattern longer than
 *   `MAX_PATTERN_LENGTH` or one `hasReDoSRisk` flags is `400 sparql_pattern_refused`.
 * - **A query that runs past its deadline.** The answer's reader is ended with `503 sparql_timeout` when the deadline passes, whatever the
 *   engine is doing; the quad source bounds every find by the same deadline.
 * - **The query in an answer.** A parse error names its line and column, never the text.
 * - **An engine per query.** One engine per process, made on first use; each query gets its own context.
 *
 * ## The update path (bundle-272, Q-965; design f, r2 R11, vet-1 S4)
 *
 * {@link checkSparqlUpdateAlgebra} and {@link runSparqlUpdatePart} are the update path's check and runner, beside the query's. They share
 * every wall above: the text cap, the one parse, the one walk (SERVICE refused, the REGEX and REPLACE check, the node bound), the refusing
 * fetch, the 1 ms HTTP timeout, the deadline and the abort. What differs is said once each:
 * - **An allowlist, not a denylist.** The update check admits the update operations `compositeupdate` and `deleteinsert` only: CLEAR, DROP,
 *   CREATE, ADD, MOVE, COPY and LOAD, and any GRAPH, USING, WITH or `using-graph-uri` naming a graph other than the space's own, are
 *   `400 sparql_graph_management_refused`; a text that is no update is `400 sparql_not_an_update`. The runner runs one `deleteinsert` at a
 *   time and refuses any other operation, so a composite reaches the engine only part by part.
 * - **`readOnly` stays on the query path.** The update context is the one without it, and it names its destination (the change set store),
 *   so the engine never writes into the source it reads. The query context keeps `readOnly`, so an update's algebra handed to
 *   {@link runSparql} is refused by the engine and writes nothing.
 */
import { Readable } from 'node:stream';
import { QueryEngine } from '@comunica/query-sparql-rdfjs';
import { DataFactory } from 'n3';
import { MAX_PATTERN_LENGTH, hasReDoSRisk } from '../util/redos.js';
import { offerBatchBindJoin } from './batch-bind-join.js';
import type { RdfJsLike } from './rdf-js-terms.js';
import { ByteMeter, rowBytes, termBytes } from './answer-size.js';
import {
  SPARQL_BAD_REQUEST, SPARQL_TOO_LARGE, SPARQL_FEDERATION_REFUSED, SPARQL_MALFORMED, SPARQL_PATTERN_REFUSED, SPARQL_QUERY_TOO_LARGE, SPARQL_UPDATE_NOT_HERE, SparqlRefusal, sparqlRefusalOf,
  timeoutRefusal,
} from './sparql-refusal.js';
import { SPARQL_GRAPH_MANAGEMENT_REFUSED, SPARQL_NOT_AN_UPDATE, graphManagementRefusal } from './change-set-store.js';

/** The longest query text, in UTF-8 bytes. */
export const SPARQL_QUERY_MAX_BYTES = 64 * 1024;

/** A parsed query, as the engine runs it. */
export type SparqlAlgebra = Exclude<Parameters<QueryEngine['query']>[0], string>;

/** A query refused before it ran: its status, its code, the words, and for a parse error where the parser stopped. */
export interface SparqlCheckRefusal { status: number; code: string; error: string; line?: number; column?: number }

/** The dataset the SPARQL protocol's parameters name (`default-graph-uri`, `named-graph-uri`), which replaces the query's FROM. */
export interface SparqlProtocolDataset { defaultGraphUri?: readonly string[]; namedGraphUri?: readonly string[] }

/** The algebra operations that change data: an update, LOAD included. */
const UPDATE_OPERATIONS: ReadonlySet<string> = new Set(['compositeupdate', 'deleteinsert', 'load', 'clear', 'create', 'drop', 'add', 'move', 'copy']);
/** The most algebra nodes the walk visits: a 64 KiB text parses to far fewer. */
const WALK_NODES_MAX = 1_000_000;

let engine: QueryEngine | null = null;
/** The engine, made on first use, with the batched bind join offered beside its own (`batch-bind-join.ts`, design-r2 R8). */
const engineOf = (): QueryEngine => {
  if (engine) return engine;
  const made = new QueryEngine();
  offerBatchBindJoin(made);
  engine = made;
  return made;
};

/** A fetch that refuses: the engine is never to reach the network. */
const refuseFetch = (): Promise<never> => Promise.reject(new Error('This server\'s SPARQL engine reads its own records only, never the network'));

/** The context the engine takes for a text and for an algebra. */
type TextContext = Parameters<QueryEngine['explain']>[1] & Parameters<QueryEngine['query']>[1];

/** The walls every context carries, the query's and the update's alike: a fetch that refuses, a 1 ms HTTP timeout, no dereferenced FROM NAMED. */
const NETWORK_WALLS = Object.freeze({ fetch: refuseFetch, httpTimeout: 1, dereferenceFromNamed: false });

/**
 * The context every query runs with. The source is the caller's RDF/JS source (the quad source), which the engine's source type, a union of
 * every source form it can identify, does not name: it is handed over as one.
 */
const contextFor = (source: unknown): TextContext => ({
  sources: [source], unionDefaultGraph: true, readOnly: true, ...NETWORK_WALLS,
}) as unknown as TextContext;

/**
 * The context an update part runs with: the query's, without `readOnly`, writing into `destination` (the change set store). Only
 * {@link runSparqlUpdatePart} takes it.
 */
const updateContextFor = (source: unknown, destination: unknown): TextContext => ({
  sources: [source], destination, unionDefaultGraph: true, ...NETWORK_WALLS,
}) as unknown as TextContext;

/** A source that holds nothing, for the parse alone. */
const EMPTY_SOURCE = { match: (): Readable => Readable.from([]) };

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object';

const refused = (status: number, code: string, error: string): { refusal: SparqlCheckRefusal } => ({ refusal: { status, code, error } });

/** Where a parse error stopped, from the parser's own words (`Parse error on line N`, the line, then a caret under the column). */
function parsePosition(message: string): { line?: number; column?: number } {
  const line = /Parse error on line (\d+)/.exec(message);
  const caret = message.split('\n').find(l => /^-*\^$/.test(l));
  return {
    ...(line ? { line: Number(line[1]) } : {}),
    ...(caret !== undefined ? { column: caret.indexOf('^') + 1 } : {}),
  };
}

/**
 * The refusal of a text the parser threw on: where it stopped, as two numbers read from the parser's words, and nothing else of them (the
 * words repeat the query's line, which the caller may not want in a body or a log).
 */
function malformedRefusal(err: unknown): SparqlCheckRefusal {
  const where = parsePosition(err instanceof Error ? err.message : '');
  const line = where.line !== undefined ? ` at line ${Number(where.line)}` : '';
  const column = where.line !== undefined && where.column !== undefined ? `, column ${Number(where.column)}` : '';
  return {
    status: SPARQL_BAD_REQUEST, code: SPARQL_MALFORMED, error: `The query does not parse as SPARQL 1.1${line}${column}`,
    ...(where.line !== undefined ? { line: where.line } : {}), ...(where.column !== undefined ? { column: where.column } : {}),
  };
}

/** The literal text of a term expression, or null when the argument is anything else (a variable, a call). */
function literalOf(arg: unknown): string | null {
  if (!isRecord(arg) || arg['type'] !== 'expression' || arg['subType'] !== 'term') return null;
  const term = arg['term'];
  return isRecord(term) && term['termType'] === 'Literal' && typeof term['value'] === 'string' ? term['value'] : null;
}

/** The refusal of a REGEX or REPLACE the server cannot bound, or null. */
function patternRefusal(node: Record<string, unknown>): { refusal: SparqlCheckRefusal } | null {
  if (node['type'] !== 'expression' || node['subType'] !== 'operator') return null;
  const op = String(node['operator']).toLowerCase();
  if (op !== 'regex' && op !== 'replace') return null;
  const args = Array.isArray(node['args']) ? node['args'] : [];
  const pattern = literalOf(args[1]);
  const flags = op === 'regex' ? args[2] : args[3];
  const what = op.toUpperCase();
  if (pattern === null) return refused(SPARQL_BAD_REQUEST, SPARQL_PATTERN_REFUSED, `${what} takes its pattern as a literal here, never from a variable or a function`);
  if (flags !== undefined && literalOf(flags) === null) return refused(SPARQL_BAD_REQUEST, SPARQL_PATTERN_REFUSED, `${what} takes its flags as a literal here, never from a variable or a function`);
  if (pattern.length > MAX_PATTERN_LENGTH) return refused(SPARQL_BAD_REQUEST, SPARQL_PATTERN_REFUSED, `${what} takes a pattern of at most ${MAX_PATTERN_LENGTH} characters`);
  if (hasReDoSRisk(pattern)) return refused(SPARQL_BAD_REQUEST, SPARQL_PATTERN_REFUSED, `${what}'s pattern has a nested or overlapping quantifier, which can take time exponential in the text it reads`);
  return null;
}

/** What a path refuses of one algebra node beyond the walls every path shares, or null. */
type NodeRule = (node: Record<string, unknown>) => { refusal: SparqlCheckRefusal } | null;

/** The query path's rule: every update operation, LOAD included, is refused. */
const queryNodeRule: NodeRule = (node) => {
  const type = node['type'];
  if (typeof type === 'string' && UPDATE_OPERATIONS.has(type)) {
    return refused(SPARQL_BAD_REQUEST, SPARQL_UPDATE_NOT_HERE, 'This endpoint answers queries only: an update (INSERT, DELETE, LOAD, CLEAR, CREATE, DROP, ADD, MOVE, COPY) is not offered here');
  }
  return null;
};

/** The update operations the update path runs: INSERT DATA, DELETE DATA, DELETE/INSERT and their composites. */
const UPDATE_OPERATIONS_ADMITTED: ReadonlySet<string> = new Set(['compositeupdate', 'deleteinsert']);

/** The graph names one algebra node carries: a GRAPH's name, a pattern's or a template quad's graph, a FROM's (USING's) lists. */
function graphNamesOf(node: Record<string, unknown>): unknown[] {
  const names: unknown[] = [node['graph']];
  if (node['type'] === 'graph') names.push(node['name']);
  if (node['type'] === 'from') {
    for (const key of ['default', 'named']) if (Array.isArray(node[key])) names.push(...(node[key] as unknown[]));
  }
  return names;
}

/** The update path's rule for the space whose graph is `ownGraph`: the allowlist of operations, and no graph named but the space's own. */
const updateNodeRule = (ownGraph: string): NodeRule => (node) => {
  const type = node['type'];
  if (typeof type === 'string' && UPDATE_OPERATIONS.has(type) && !UPDATE_OPERATIONS_ADMITTED.has(type)) {
    return refused(SPARQL_BAD_REQUEST, SPARQL_GRAPH_MANAGEMENT_REFUSED, 'An Update changes statements only: CLEAR, DROP, CREATE, ADD, MOVE, COPY and LOAD are not offered');
  }
  for (const name of graphNamesOf(node)) {
    if (isRecord(name) && name['termType'] === 'NamedNode' && name['value'] !== ownGraph) {
      return refused(SPARQL_BAD_REQUEST, SPARQL_GRAPH_MANAGEMENT_REFUSED, 'An Update reads and changes its own space\'s graph only: GRAPH, USING and WITH may name no other graph');
    }
  }
  return null;
};

/** The first refusal anywhere in the algebra (operations and expressions alike), by the walls every path shares and the path's `rule`, or null. */
function walkRefusal(root: unknown, rule: NodeRule): { refusal: SparqlCheckRefusal } | null {
  const stack: unknown[] = [root];
  const seen = new Set<object>();
  let visited = 0;
  while (stack.length > 0) {
    const node = stack.pop();
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);
    if (++visited > WALK_NODES_MAX) return refused(SPARQL_TOO_LARGE, SPARQL_QUERY_TOO_LARGE, 'The query is too large to check');
    const type = node['type'];
    if (type === 'service') return refused(SPARQL_BAD_REQUEST, SPARQL_FEDERATION_REFUSED, 'SERVICE is not offered: this endpoint answers from this server\'s own records and never queries another');
    const own = rule(node);
    if (own) return own;
    const pattern = patternRefusal(node);
    if (pattern) return pattern;
    for (const value of Object.values(node)) if (isRecord(value)) stack.push(value);
  }
  return null;
}

/** The algebra of `text`, parsed once with the engine's own parser and walked whole under `rule`; or the refusal. Never runs anything. */
async function parsedAndWalked(text: string, rule: NodeRule): Promise<{ algebra: SparqlAlgebra } | { refusal: SparqlCheckRefusal }> {
  if (Buffer.byteLength(text, 'utf8') > SPARQL_QUERY_MAX_BYTES) {
    return refused(SPARQL_TOO_LARGE, SPARQL_QUERY_TOO_LARGE, `The query is longer than ${SPARQL_QUERY_MAX_BYTES} bytes`);
  }
  let algebra: SparqlAlgebra;
  try {
    const explained = await engineOf().explain(text, contextFor(EMPTY_SOURCE), 'parsed');
    algebra = explained.data as SparqlAlgebra;
  } catch (err) {
    return { refusal: malformedRefusal(err) };
  }
  const refusal = walkRefusal(algebra, rule);
  if (refusal) return refusal;
  return { algebra };
}

/** The algebra with the protocol's dataset in place of the query's FROM and FROM NAMED, when the protocol names one. */
function withDataset(algebra: SparqlAlgebra, dataset: SparqlProtocolDataset): SparqlAlgebra {
  const defaults = dataset.defaultGraphUri ?? [];
  const named = dataset.namedGraphUri ?? [];
  if (defaults.length === 0 && named.length === 0) return algebra;
  const node: unknown = algebra;
  const input = isRecord(node) && node['type'] === 'from' && isRecord(node['input']) ? node['input'] : algebra;
  const from = { type: 'from', input, default: defaults.map(g => DataFactory.namedNode(g)), named: named.map(g => DataFactory.namedNode(g)) };
  // The algebra's FROM node, as the parser builds it (`toAlgebra`): the engine's operation type is an interface with no `from` fields of
  // its own, so the node is handed over as one.
  return from as unknown as SparqlAlgebra;
}

/**
 * The algebra of `text`, parsed once with the engine's own parser and checked whole, with the protocol's dataset applied; or the refusal.
 * Never runs anything.
 */
export async function checkSparqlAlgebra(text: string, dataset: SparqlProtocolDataset = {}): Promise<{ algebra: SparqlAlgebra } | { refusal: SparqlCheckRefusal }> {
  const checked = await parsedAndWalked(text, queryNodeRule);
  if ('refusal' in checked) return checked;
  return { algebra: withDataset(checked.algebra, dataset) };
}

/** The dataset the SPARQL protocol's update parameters name (`using-graph-uri`, `using-named-graph-uri`). */
export interface SparqlUpdateDataset { defaultGraphUri?: readonly string[]; namedGraphUri?: readonly string[] }

/**
 * The algebra of the Update `text` for the space whose graph is `ownGraph`, parsed once and checked whole by the walls every path shares
 * and the update path's allowlist; or the refusal. `using` is the protocol's dataset: a graph it names other than `ownGraph` is refused, and
 * `ownGraph` itself is the whole dataset already. Never runs anything.
 */
export async function checkSparqlUpdateAlgebra(text: string, ownGraph: string, using: SparqlUpdateDataset = {}): Promise<{ algebra: SparqlAlgebra } | { refusal: SparqlCheckRefusal }> {
  if ([...(using.defaultGraphUri ?? []), ...(using.namedGraphUri ?? [])].some(g => g !== ownGraph)) {
    return refused(SPARQL_BAD_REQUEST, SPARQL_GRAPH_MANAGEMENT_REFUSED, 'An Update reads its own space\'s graph only: using-graph-uri and using-named-graph-uri may name no other graph');
  }
  const checked = await parsedAndWalked(text, updateNodeRule(ownGraph));
  if ('refusal' in checked) return checked;
  const root: unknown = checked.algebra;
  if (!isRecord(root) || typeof root['type'] !== 'string' || !UPDATE_OPERATIONS_ADMITTED.has(root['type'])) {
    return refused(SPARQL_BAD_REQUEST, SPARQL_NOT_AN_UPDATE, 'This is the update path: a query (SELECT, ASK, CONSTRUCT, DESCRIBE) is asked at the query endpoint');
  }
  return checked;
}

/** A row of a SELECT answer: each bound variable's term, by name. */
export type SparqlRow = Record<string, RdfJsLike>;

/**
 * A query's answer, typed by its kind (so a door narrows by `kind` and never casts): a SELECT's rows, an ASK's boolean, a CONSTRUCT's or
 * DESCRIBE's quads. With `limit`, at most that many rows or quads are read and the engine is stopped (a door asks for one more than it
 * answers, to know there were more). `destroy` stops the engine and releases its reads.
 */
export type SparqlResult =
  | { kind: 'bindings'; rows(limit?: number, maxBytes?: number): Promise<SparqlRow[]>; destroy(): void }
  | { kind: 'boolean'; rows(): Promise<boolean>; destroy(): void }
  | { kind: 'quads'; rows(limit?: number, maxBytes?: number): Promise<RdfJsLike[]>; destroy(): void };

/** What the engine streams: an asynciterator, ended by `destroy`. */
interface EngineStream {
  on(event: string, listener: (arg: unknown) => void): unknown;
  destroy(cause?: Error): void;
}

/** The engine's error as the query's refusal: a source's own refusal (wrapped or not, or recorded by the source), else as it came. */
function refusalOf(err: unknown, source: unknown): unknown {
  const named = sparqlRefusalOf(err);
  if (named) return named;
  return recordedRefusal(source) ?? err;
}

/**
 * The refusal the source recorded for this query, or null. A source's failed read ends its stream with no error (an error raised into the
 * engine's iterators reaches one that no longer listens, and is an uncaught exception that stops the process), so a result stream that
 * ends is asked this before its rows are answered: a query whose source failed never answers a short result as a whole one.
 */
function recordedRefusal(source: unknown): SparqlRefusal | null {
  const recorded = isRecord(source) && typeof source['failure'] === 'function' ? (source['failure'] as () => unknown)() : null;
  return recorded instanceof SparqlRefusal ? recorded : null;
}

/**
 * What ended the source's reads, if anything, as `{ error }`: its recorded refusal, else the defect it recorded (an error that is no
 * refusal, which the source ended its stream without raising, for the same reason). The result stream that ends rejects with it, so the
 * act answers it as it answers any error of the engine: a defect is the generic 500, never a short result answered as a whole one.
 */
export function recordedEnd(source: unknown): { error: unknown } | null {
  const refusal = recordedRefusal(source);
  if (refusal) return { error: refusal };
  const defect = isRecord(source) && typeof source['defect'] === 'function' ? (source['defect'] as () => unknown)() : null;
  return isRecord(defect) && 'error' in defect ? { error: defect['error'] } : null;
}

/**
 * The algebra of an ASK as the SELECT of at most one row (its ASK node replaced by a slice of length 1), or null when `algebra` is no ASK.
 * The engine answers an ASK with one promise that nothing can end; a stream of at most one row is read through {@link runSparql}'s
 * `collect`, so the deadline and the caller's abort destroy it like any other read.
 */
function askAsOneRow(algebra: SparqlAlgebra): SparqlAlgebra | null {
  const node: unknown = algebra;
  if (!isRecord(node)) return null;
  if (node['type'] === 'ask') return { type: 'slice', input: node['input'], start: 0, length: 1 } as unknown as SparqlAlgebra;
  if (node['type'] === 'from' && isRecord(node['input'])) {
    const inner = askAsOneRow(node['input'] as unknown as SparqlAlgebra);
    return inner ? { ...node, input: inner } as unknown as SparqlAlgebra : null;
  }
  return null;
}

/** What ends a query that its caller left. */
const callerLeft = (): Error => new Error('The query was ended by its caller');

/**
 * Run `algebra` (from {@link checkSparqlAlgebra}) over `source` (an RDF/JS source: the quad source) by `deadline` (epoch milliseconds); a
 * `signal` that aborts ends it, one already aborted ends it before the engine starts. The engine is the process's one engine, with a
 * context that cannot reach the network. Every form is read as a stream the deadline and the abort destroy (an ASK as a SELECT of one row).
 */
export async function runSparql(algebra: SparqlAlgebra, source: unknown, opts: { deadline: number; signal?: AbortSignal }): Promise<SparqlResult> {
  if (opts.deadline - Date.now() <= 0) throw timeoutRefusal();
  if (opts.signal?.aborted) throw callerLeft();
  const context = contextFor(source);
  const streams = new Set<EngineStream>();
  let ended: Error | null = null;
  const end = (cause: Error): void => {
    ended ??= cause;
    for (const s of streams) s.destroy(cause);
  };
  // Armed before the engine plans, so a deadline or an abort that comes while it plans is seen by the first read.
  let timer: NodeJS.Timeout | null = setTimeout(() => end(timeoutRefusal()), Math.max(0, opts.deadline - Date.now()));
  timer.unref();
  const onAbort = (): void => end(callerLeft());
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  const finish = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    opts.signal?.removeEventListener('abort', onAbort);
  };
  const oneRow = askAsOneRow(algebra);
  let raw: Awaited<ReturnType<QueryEngine['query']>>;
  try {
    raw = await engineOf().query(oneRow ?? algebra, context);
  } catch (err) {
    finish();
    throw refusalOf(err, source);
  }

  /**
   * Collect at most `limit` items of an engine stream, mapping each; with `bytes` (the bytes one mapped item holds, and the bound), the read
   * ends with `413 sparql_answer_too_large` when the items together pass the bound, and the stream is destroyed (lens-2 P1).
   */
  const collect = <T>(stream: EngineStream, limit: number, map: (item: unknown) => T, bytes?: { of: (item: T) => number; max: number }): Promise<T[]> => new Promise((resolve, reject) => {
    const meter = bytes ? new ByteMeter(bytes.max) : null;
    // A stream the engine opened after the query ended (the deadline or an abort landed while it planned) is closed here: `end` destroyed only
    // the streams it knew, and this one holds the source's cursors.
    if (ended) { stream.destroy(); reject(refusalOf(ended, source)); return; }
    streams.add(stream);
    const out: T[] = [];
    let done = false;
    const settle = (fn: () => void): void => { if (done) return; done = true; streams.delete(stream); finish(); fn(); };
    stream.on('data', (item) => {
      if (done) return;
      const mapped = map(item);
      out.push(mapped);
      if (meter && bytes) {
        try { meter.add(bytes.of(mapped)); } catch (err) { settle(() => reject(err)); stream.destroy(); return; }
      }
      if (out.length >= limit) { settle(() => resolve(out)); stream.destroy(); }
    });
    stream.on('error', (err) => settle(() => reject(refusalOf(err, source))));
    stream.on('end', () => settle(() => {
      const failed = recordedEnd(source);
      if (failed) reject(failed.error); else resolve(out);
    }));
    // A stream that closes with no end and no error ends the read too, as a failure: its rows are a short answer, never a whole one.
    stream.on('close', () => settle(() => reject(refusalOf(ended ?? recordedEnd(source)?.error ?? new Error('The result stream closed before it ended'), source))));
  });

  /** `read` as the one reading of the result: a failure is the query's refusal, and the deadline's timer and the abort's listener are let go. */
  const guarded = <A extends unknown[], T>(read: (...args: A) => Promise<T>) => async (...args: A): Promise<T> => {
    try {
      return await read(...args);
    } catch (err) {
      throw refusalOf(err, source);
    } finally {
      finish();
    }
  };
  const destroy = (): void => { end(new Error('The query was stopped')); finish(); };

  if (oneRow) {
    return {
      kind: 'boolean', destroy,
      rows: guarded(async () => {
        if (raw.resultType !== 'bindings') throw new Error('The engine answered an ASK that is no stream of rows');
        return (await collect(await raw.execute() as unknown as EngineStream, 1, () => true)).length > 0;
      }),
    };
  }
  if (raw.resultType === 'bindings') {
    const bindings = raw;
    return {
      kind: 'bindings', destroy,
      rows: guarded(async (limit = Infinity, maxBytes = Infinity) => collect(await bindings.execute() as unknown as EngineStream, limit, (item): SparqlRow => {
        const row: SparqlRow = {};
        for (const [variable, term] of item as Iterable<[{ value: string }, RdfJsLike]>) row[variable.value] = term;
        return row;
      }, { of: rowBytes, max: maxBytes })),
    };
  }
  if (raw.resultType === 'quads') {
    const quads = raw;
    return {
      kind: 'quads', destroy,
      rows: guarded(async (limit = Infinity, maxBytes = Infinity) => collect(await quads.execute() as unknown as EngineStream, limit, (item) => item as RdfJsLike, { of: termBytes, max: maxBytes })),
    };
  }
  if (raw.resultType === 'boolean') {
    // Not reached: an ASK runs as one row above. Kept so an engine form that is boolean and no ASK is not answered as rows.
    const boolean = raw;
    return { kind: 'boolean', destroy, rows: guarded(async () => boolean.execute()) };
  }
  finish();
  throw new SparqlRefusal(SPARQL_BAD_REQUEST, SPARQL_UPDATE_NOT_HERE, 'This endpoint answers queries only');
}

/** The change set an update part writes into: an RDF/JS store whose writes still to come `end` stops. */
export interface UpdateDestination { end(cause: Error): void }

/**
 * Run one update part (a `deleteinsert` from {@link checkSparqlUpdateAlgebra}; any other operation is refused) over `source`, writing its
 * DELETE and INSERT into `destination`, by `deadline`; a `signal` that aborts ends it. The context is the query's walls without `readOnly`.
 * The part ends when the engine has handed the destination every statement; the deadline and the abort end it sooner, the destination
 * refusing every statement after. A source whose read failed ended its streams early, so its recorded refusal or defect is the part's
 * failure, never a short change set answered as a whole one.
 */
export async function runSparqlUpdatePart(part: SparqlAlgebra, source: unknown, destination: UpdateDestination, opts: { deadline: number; signal?: AbortSignal }): Promise<void> {
  const node: unknown = part;
  if (!isRecord(node) || node['type'] !== 'deleteinsert') throw graphManagementRefusal('An update operation other than INSERT DATA, DELETE DATA and DELETE/INSERT');
  if (opts.deadline - Date.now() <= 0) throw timeoutRefusal();
  if (opts.signal?.aborted) throw callerLeft();
  let stop: ((cause: Error) => void) | null = null;
  const stopped = new Promise<never>((_resolve, reject) => {
    stop = (cause) => { destination.end(cause); reject(cause); };
  });
  stopped.catch(() => undefined);
  const timer = setTimeout(() => stop?.(timeoutRefusal()), Math.max(0, opts.deadline - Date.now()));
  timer.unref();
  const onAbort = (): void => stop?.(callerLeft());
  opts.signal?.addEventListener('abort', onAbort, { once: true });
  try {
    const planned = engineOf().query(part, updateContextFor(source, destination));
    // A plan that fails after the deadline or the abort won the race rejects with nobody waiting: it is let go here, never unhandled.
    planned.catch(() => undefined);
    const raw = await Promise.race([planned, stopped]);
    if (raw.resultType !== 'void') throw new Error(`The engine answered an update part with ${String(raw.resultType)}, not with its changes`);
    const executed = raw.execute();
    executed.catch(() => undefined);
    await Promise.race([executed, stopped]);
  } catch (err) {
    throw refusalOf(err, source);
  } finally {
    clearTimeout(timer);
    opts.signal?.removeEventListener('abort', onAbort);
  }
  const failed = recordedEnd(source);
  if (failed) throw failed.error;
}

/**
 * The HTTP buses of the engine and the actors subscribed to them, found by walking the engine's object graph: the gate that the engine
 * cannot fetch, even for a query past the algebra walk.
 */
export function httpBusActors(): { buses: string[]; actors: string[] } {
  const buses: string[] = [];
  const actors: string[] = [];
  const stack: unknown[] = [engineOf()];
  const seen = new Set<object>();
  while (stack.length > 0 && seen.size < WALK_NODES_MAX) {
    const node = stack.pop();
    if (!isRecord(node) || seen.has(node)) continue;
    seen.add(node);
    const name = node['name'];
    if (typeof name === 'string' && Array.isArray(node['actors']) && /\/bus-http\//.test(name)) {
      if (!buses.includes(name)) buses.push(name);
      for (const actor of node['actors']) if (isRecord(actor)) actors.push(String(actor['name']));
    }
    for (const value of Object.values(node)) if (isRecord(value)) stack.push(value);
  }
  return { buses, actors };
}
