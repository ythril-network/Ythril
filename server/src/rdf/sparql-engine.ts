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
 */
import { Readable } from 'node:stream';
import { QueryEngine } from '@comunica/query-sparql-rdfjs';
import { DataFactory } from 'n3';
import { MAX_PATTERN_LENGTH, hasReDoSRisk } from '../util/redos.js';
import {
  SPARQL_BAD_REQUEST, SPARQL_TOO_LARGE, SPARQL_FEDERATION_REFUSED, SPARQL_MALFORMED, SPARQL_PATTERN_REFUSED, SPARQL_QUERY_TOO_LARGE, SPARQL_UPDATE_NOT_HERE, SparqlRefusal, sparqlRefusalOf,
  timeoutRefusal,
} from './sparql-refusal.js';

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
/** The engine, made on first use. */
const engineOf = (): QueryEngine => (engine ??= new QueryEngine());

/** A fetch that refuses: the engine is never to reach the network. */
const refuseFetch = (): Promise<never> => Promise.reject(new Error('This server\'s SPARQL engine reads its own records only, never the network'));

/** The context the engine takes for a text and for an algebra. */
type TextContext = Parameters<QueryEngine['explain']>[1] & Parameters<QueryEngine['query']>[1];

/**
 * The context every query runs with. The source is the caller's RDF/JS source (the quad source), which the engine's source type, a union of
 * every source form it can identify, does not name: it is handed over as one.
 */
const contextFor = (source: unknown): TextContext => ({
  sources: [source], unionDefaultGraph: true, readOnly: true, fetch: refuseFetch, httpTimeout: 1, dereferenceFromNamed: false,
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

/** The first refusal anywhere in the algebra (operations and expressions alike), or null. */
function walkRefusal(root: unknown): { refusal: SparqlCheckRefusal } | null {
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
    if (typeof type === 'string' && UPDATE_OPERATIONS.has(type)) {
      return refused(SPARQL_BAD_REQUEST, SPARQL_UPDATE_NOT_HERE, 'This endpoint answers queries only: an update (INSERT, DELETE, LOAD, CLEAR, CREATE, DROP, ADD, MOVE, COPY) is not offered here');
    }
    const pattern = patternRefusal(node);
    if (pattern) return pattern;
    for (const value of Object.values(node)) if (isRecord(value)) stack.push(value);
  }
  return null;
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
  const refusal = walkRefusal(algebra);
  if (refusal) return refusal;
  return { algebra: withDataset(algebra, dataset) };
}

/** A row of a SELECT answer: each bound variable's term, by name. */
export type SparqlRow = Record<string, { termType: string; value: string }>;

/** A query's answer: its kind, and the ways to take it. */
export interface SparqlResult {
  kind: 'bindings' | 'boolean' | 'quads';
  /**
   * The answer collected: a SELECT's rows, an ASK's boolean, a CONSTRUCT's or DESCRIBE's quads. With `limit`, at most that many rows or
   * quads are read and the engine is stopped (a door asks for one more than it answers, to know there were more).
   */
  rows(limit?: number): Promise<SparqlRow[] | boolean | unknown[]>;
  /** Stop the engine and release its reads. */
  destroy(): void;
}

/** What the engine streams: an asynciterator, ended by `destroy`. */
interface EngineStream {
  on(event: string, listener: (arg: unknown) => void): unknown;
  destroy(cause?: Error): void;
}

/** The engine's error as the query's refusal: a source's own refusal (wrapped or not, or recorded by the source), else as it came. */
function refusalOf(err: unknown, source: unknown): unknown {
  const named = sparqlRefusalOf(err);
  if (named) return named;
  const recorded = isRecord(source) && typeof source['failure'] === 'function' ? (source['failure'] as () => unknown)() : null;
  return recorded instanceof SparqlRefusal ? recorded : err;
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

  /** Collect at most `limit` items of an engine stream, mapping each. */
  const collect = <T>(stream: EngineStream, limit: number, map: (item: unknown) => T): Promise<T[]> => new Promise((resolve, reject) => {
    if (ended) { reject(refusalOf(ended, source)); return; }
    streams.add(stream);
    const out: T[] = [];
    let done = false;
    const settle = (fn: () => void): void => { if (done) return; done = true; streams.delete(stream); finish(); fn(); };
    stream.on('data', (item) => {
      if (done) return;
      out.push(map(item));
      if (out.length >= limit) { settle(() => resolve(out)); stream.destroy(); }
    });
    stream.on('error', (err) => settle(() => reject(refusalOf(err, source))));
    stream.on('end', () => settle(() => resolve(out)));
  });

  const kind = oneRow ? 'boolean' : raw.resultType === 'bindings' ? 'bindings' : raw.resultType === 'boolean' ? 'boolean' : raw.resultType === 'quads' ? 'quads' : null;
  if (kind === null) { finish(); throw new SparqlRefusal(SPARQL_BAD_REQUEST,SPARQL_UPDATE_NOT_HERE, 'This endpoint answers queries only'); }
  return {
    kind,
    async rows(limit = Infinity) {
      try {
        if (oneRow) {
          if (raw.resultType !== 'bindings') throw new Error('The engine answered an ASK that is no stream of rows');
          return (await collect(await raw.execute() as unknown as EngineStream, 1, () => true)).length > 0;
        }
        if (raw.resultType === 'boolean') {
          // Not reached: an ASK runs as one row above. Kept so an engine form that is boolean and no ASK is not answered as rows.
          return await raw.execute();
        }
        if (raw.resultType === 'bindings') {
          const stream = await raw.execute();
          return await collect(stream as unknown as EngineStream, limit, (item) => {
            const row: SparqlRow = {};
            for (const [variable, term] of item as Iterable<[{ value: string }, { termType: string; value: string }]>) row[variable.value] = term;
            return row;
          });
        }
        if (raw.resultType === 'quads') {
          const stream = await raw.execute();
          return await collect(stream as unknown as EngineStream, limit, (item) => item);
        }
        return [];
      } catch (err) {
        throw refusalOf(err, source);
      } finally {
        finish();
      }
    },
    destroy() { end(new Error('The query was stopped')); finish(); },
  };
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
