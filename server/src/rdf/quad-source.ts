/**
 * The RDF/JS quad source over a caller's records: what a SPARQL query and a Linked Data read are answered from, read at query time from the
 * record collections, never from a copy (bundle-271, Q-756; design §0, §1.1-§1.3, r2 R1, R3.3, R4).
 *
 * ## How a pattern is answered
 *
 * For each member the planner (`quad-candidates.ts`) names the finds that can produce the pattern's statements; each find's rows go through
 * the export's own mapper (`recordTriples`, so a statement here is the statement the export writes), become RDF/JS quads in the member's
 * graph, and are filtered to the pattern. The answer streams; finds start on the first read.
 *
 * ## What it prevents
 *
 * - **A read outside the caller's scope or rights.** The members are the spaces the door's guard accepted, read through `rdfMembers`: a
 *   member with RDF off or unsettled names is left out and named ({@link QuadSource.leftOut}), and without `files: read` the file kind is
 *   never read ({@link QuadSource.filesWithheld}).
 * - **An unbounded read.** One counter of records read per query, shared by every match: the read of record cap+1 ends the stream with
 *   `413 sparql_too_much_read`, never a normal end. Every find carries a server deadline inside the query's (`maxTimeMS`, at most 10 s);
 *   past the query's deadline a read ends with `503 sparql_timeout`. A narrowed find is limited to cap+1 rows; a walk pages by `_id`.
 * - **A cursor held after its reader left.** Destroying a match stream closes every cursor it holds at once, and one whose find has not
 *   answered yet the moment it answers ({@link HeldCursors}).
 * - **An error event nobody listens for.** A match stream carries an error listener of its own from construction, so a refusal raised on it
 *   after its reader let it go (the deadline's, an abort's) is never an uncaught exception, which the server answers by ending the process.
 * - **A refusal for a read the consumer ended.** A read still on its way when its stream is destroyed ends with the driver's own error;
 *   that is no failure of the store and never the query's (`failure()` stays empty, the query's other matches read on).
 * - **A false empty.** `countQuads` answers from estimates, and the engine skips a pattern it is told is empty: it answers 0 only when no
 *   find can answer the pattern at all, at least 1 otherwise, and a count it cannot make answers 1 and ends the
 *   query's reads with the refusal it recorded: it never answers 0 and never rejects (the engine's handler for a rejected count raises an
 *   unhandled rejection).
 * - **A statement twice.** An agent's statements are written once per member and match (`agentsSeen`), an edge statement once per
 *   (from, label, to); no whole-quad set is kept.
 */
import { Readable } from 'node:stream';
import type { Document, FindCursor } from 'mongodb';
import { DataFactory } from 'n3';
import type * as N3 from 'n3';
import { getConfig } from '../config/loader.js';
import { sparqlLimits } from '../config/sparql-limits.js';
import { col } from '../db/mongo.js';
import { idKeysetPage } from '../db/id-keyset-page.js';
import { isMaxTimeExpired } from '../db/max-time.js';
import { spaceCollection } from '../db/space-collection.js';
import { classifyReadFailure, isStoreSide } from '../brain/store-failure.js';
import { yieldToEventLoop } from '../util/yield-to-event-loop.js';
import { log, peerText } from '../util/log.js';
import { RDF_READ_FIELDS, recordTriples, type RdfRecordKind } from './record-triples.js';
import { recordIri, graphIri } from './term-iri.js';
import { xsd } from './literals.js';
import { rdfKindCollection, rdfMembers, rdfRowFilter, type RdfMember } from './rdf-members.js';
import { isBound, quadCandidates, type CandidateFind, type PatternSlot, type PatternTerm, type QuadPattern } from './quad-candidates.js';
import { toRdfJs } from './rdf-js-terms.js';
import { SPARQL_RETRY_AFTER_SECONDS, SPARQL_STORE_UNAVAILABLE, SPARQL_UNAVAILABLE, SparqlRefusal, sparqlRefusalOf, timeoutRefusal, tooMuchReadRefusal } from './sparql-refusal.js';
import type { RdfCaller, FingerprintOf } from './rdf-space-state.js';

/** The longest server deadline one find carries, in milliseconds, whatever time the query has left (as `brain/query.ts`). */
export const QUAD_FIND_MAX_MS = 10_000;
/** Rows per walk page. */
export const QUAD_WALK_PAGE = 200;
/** Rows a narrowed find hands over between two yields to the event loop. */
const ROWS_PER_YIELD = 200;
/** The most counts one query caches. */
const COUNT_CACHE_MAX = 10_000;
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/** Who reads, and which spaces: the spaces the door's guard accepted (one space, or a view's readable members). */
export interface QuadScope {
  members: readonly string[];
  caller: RdfCaller | undefined;
  /** The door's schema fingerprint (`rdf-space-state.ts` says why it is handed in); the stamp's own when absent. */
  fingerprintOf?: FingerprintOf;
}

export interface QuadSourceOptions {
  /** When the query must be done, in epoch milliseconds. */
  deadline: number;
  /** The most records the query may read; `sparql.maxRecordsRead` when absent. */
  maxRecordsRead?: number;
  /** `false`: every pattern walks every kind (the answer each narrowing rule is held to). Default true. */
  narrow?: boolean;
  /** Ends every read when the caller goes away. */
  signal?: AbortSignal;
}

/** An RDF/JS source (`match`, `countQuads`) and what the door must say about how it read. */
export interface QuadSource {
  match(subject?: PatternSlot, predicate?: PatternSlot, object?: PatternSlot, graph?: PatternSlot): Readable;
  countQuads(subject?: PatternSlot, predicate?: PatternSlot, object?: PatternSlot, graph?: PatternSlot): Promise<number>;
  /** The members the caller reads that are not read as RDF, with the code and status the export answers for each. */
  leftOut(): { space: string; code: string; status: number }[];
  /** The members whose file statements are withheld (no `files: read` there). */
  filesWithheld(): string[];
  /** Records read so far, every match together. */
  recordsRead(): number;
  /** The first refusal a read of this query met (it ends every later read too), or null. */
  failure(): SparqlRefusal | null;
}

/** The query one find sends: where, which rows, which fields, in what order and how many. */
export interface CandidateQuery {
  collection: string;
  filter: Record<string, unknown>;
  projection: Record<string, 1>;
  /** A walk is read page by page by the one `_id` pager (`idKeysetPage`), `limit` rows a page; a narrowed find in one cursor of `limit` rows. */
  walk: boolean;
  limit: number;
}

const projectionOf = (kind: RdfRecordKind): Record<string, 1> => Object.fromEntries(RDF_READ_FIELDS[kind].map(f => [f, 1 as const]));

/** The query `find` sends in `space`: a walk's page (by `_id`) or a narrowed find (limited to `cap + 1` rows, so the cap read is seen). */
export function candidateQuery(space: string, find: CandidateFind, cap: number): CandidateQuery {
  const collection = spaceCollection(space, rdfKindCollection(find.kind));
  const row = rdfRowFilter(find.kind);
  if (find.walk) return { collection, filter: row, projection: projectionOf(find.kind), walk: true, limit: QUAD_WALK_PAGE };
  return { collection, filter: { ...find.filter, ...row }, projection: projectionOf(find.kind), walk: false, limit: cap + 1 };
}

/** A driver's error class name or code name is an identifier; anything else is not logged. */
const IDENTIFIER = /^[A-Za-z_$][\w$]{0,63}$/;

/**
 * The `503 sparql_store_unavailable` a failed read of the store answers, or null for an error that is no store failure. The cause is kept in the
 * log (lens-3 O2): one line with the error's class and the driver's `code` and `codeName`, never its message, which may hold the filter the
 * read failed on (ids, values, a space's name). Without it the answer said the store did not answer, and nothing said why.
 */
export function storeFailureRefusal(err: unknown): SparqlRefusal | null {
  if (!isStoreSide(err)) return null;
  const { code, codeName } = (err ?? {}) as { code?: unknown; codeName?: unknown };
  // Each name enters the line through `peerText`, as every steerable value does (the identifier test narrows what may be said; the renderer bounds it).
  const named = err instanceof Error && IDENTIFIER.test(err.constructor.name) ? peerText(err.constructor.name) : 'a non-Error value';
  const codeText = typeof code === 'number' && Number.isSafeInteger(code) ? `, code ${code}` : '';
  const codeNameText = typeof codeName === 'string' && IDENTIFIER.test(codeName) ? `, ${peerText(codeName)}` : '';
  log.warn(`SPARQL read failed on the store (${named}${codeText}${codeNameText})`);
  const f = classifyReadFailure(err);
  return new SparqlRefusal(SPARQL_UNAVAILABLE, SPARQL_STORE_UNAVAILABLE, f.error, f.retryAfterSeconds ?? SPARQL_RETRY_AFTER_SECONDS);
}

/** The datatype a literal is compared by. */
const datatypeOf = (t: { language?: string; datatype?: { value: string } }): string => (t.language ? RDF_LANG_STRING : t.datatype?.value ?? xsd('string'));

/** The parts of an RDF/JS value a pattern is compared with. */
interface ValueTerm { termType: string; value: string; language?: string; datatype?: { value: string }; subject?: ValueTerm; predicate?: ValueTerm; object?: ValueTerm }

/** Does the value `v` fit the pattern slot `p` (unbound fits anything; a triple term is compared by its parts, variables inside it free)? */
function fits(p: PatternSlot, v: ValueTerm | undefined): boolean {
  if (!isBound(p)) return true;
  if (v === undefined || p.termType !== v.termType) return false;
  if (p.termType === 'Literal') return p.value === v.value && (p.language ?? '') === (v.language ?? '') && datatypeOf(p) === datatypeOf(v);
  if (p.termType === 'Quad') return fits(p.subject, v.subject) && fits(p.predicate, v.predicate) && fits(p.object, v.object);
  return p.value === v.value;
}

/** A read the caller ended. */
class ReadAborted extends Error {
  constructor() { super('The read was ended by its caller'); this.name = 'ReadAborted'; }
}

/**
 * The cursors one match holds, and the one rule for closing them: a cursor is closed the moment its stream is destroyed, but a cursor whose
 * find has not answered yet is closed when it answers.
 *
 * ## What it prevents
 *
 * A cursor closed while its find is still on its way to the server. The driver ends the cursor's session on that close and has no server id
 * to kill, so when the first batch arrives the cursor holds a server cursor that nothing can kill any more (a second `close` finds the session
 * ended): it stays open until the server's idle timeout (seen in `a-quad-source-read-is-bounded-db`: one batch of 101 rows handed out, never
 * killed). Here the close of a pending cursor waits for its answer ({@link HeldCursors.answered}), and no find starts after the destroy
 * ({@link HeldCursors.open}).
 */
class HeldCursors {
  private readonly held = new Set<FindCursor<Document>>();
  private readonly pending = new Set<FindCursor<Document>>();
  private gone = false;

  /**
   * True from the moment the consumer destroyed the stream, set before anything is closed. A read that ends after it is the consumer's doing
   * (a session ended under a batch in flight), never a failure of the store: {@link quadsOf} asks it before it records a failure.
   */
  get destroyedByConsumer(): boolean { return this.gone; }

  /** Start no find once the stream is destroyed: a read already past its caller ends here. */
  open(): void { if (this.gone) throw new ReadAborted(); }

  /** A find starts: its cursor is held, with its first answer still to come. */
  hold(cursor: FindCursor<Document>): void { this.held.add(cursor); this.pending.add(cursor); }

  /** The find's first batch has arrived. True when the stream was destroyed meanwhile: the cursor has its server id now and is closed here, at once. */
  async answered(cursor: FindCursor<Document>): Promise<boolean> {
    this.pending.delete(cursor);
    if (!this.gone) return false;
    await cursor.close().catch(() => undefined);
    return true;
  }

  /** The find is over; its cursor is closed by the caller. */
  release(cursor: FindCursor<Document>): void { this.held.delete(cursor); this.pending.delete(cursor); }

  /** The stream is destroyed: every cursor that has its answer is closed now; one without is closed when it answers. */
  async destroy(): Promise<void> {
    this.gone = true;
    await Promise.all([...this.held].filter(c => !this.pending.has(c)).map(c => c.close().catch(() => undefined)));
  }
}

/**
 * A match's stream: started on the first read, it pulls from the query's generator as the reader takes, and closes every cursor it holds
 * the moment it is destroyed.
 */
class MatchStream extends Readable {
  private pumping = false;
  /** The read of the generator in flight, if any: a find may be starting inside it. */
  private inflight: Promise<unknown> | null = null;
  constructor(private readonly quads: AsyncGenerator<N3.Quad, void, undefined>, private readonly cursors: HeldCursors) {
    super({ objectMode: true });
    // An error event nobody listens for is an uncaught exception, and the server's handler ends the process on one. The reader of this stream
    // (the engine) takes its errors through its own listener and, once it has destroyed the stream, may have let it go before a late error
    // (the deadline's refusal, a read that ended after its consumer left) is raised. This listener is there from construction, so no
    // error of this stream, whenever raised and whoever destroyed it, reaches the process: the query's refusal tells the caller, never an event.
    this.on('error', () => undefined);
  }

  override _read(): void {
    if (this.pumping) return;
    this.pumping = true;
    void this.pump();
  }

  private async pump(): Promise<void> {
    try {
      for (;;) {
        const pending = this.quads.next();
        this.inflight = pending;
        const next = await pending;
        this.inflight = null;
        if (this.destroyed) return;
        if (next.done) { this.push(null); return; }
        if (!this.push(next.value)) { this.pumping = false; return; }
      }
    } catch (err) {
      this.inflight = null;
      if (this.destroyed) return;
      // A read that failed (a refusal `fail` recorded as the query's failure, or one its consumer ended) ends this stream without an error:
      // the engine's iterators forward an error from one to the next, and one that has let go of its source meanwhile (the deadline's own
      // end) has no listener, so the error is an uncaught exception that stops the process. The query's answer carries the failure from
      // `failure()` (the engine asks it when the result ends) or from the deadline's own end, never from an event of this stream.
      // An error that is none of those is a defect of the source itself and is raised as it is.
      if (err instanceof SparqlRefusal || err instanceof ReadAborted) this.push(null);
      else this.destroy(err as Error);
    }
  }

  /**
   * Close every cursor now; one whose find was still on its way is closed when its first batch arrives ({@link HeldCursors}), which the
   * read in flight does before it settles, and `close` is emitted after that.
   */
  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    const settled = this.inflight ? this.inflight.then(() => undefined, () => undefined) : Promise.resolve();
    void this.cursors.destroy()
      .then(() => settled)
      .then(() => this.quads.return(undefined).catch(() => undefined))
      .then(() => callback(err), () => callback(err));
  }
}

/** The quad source of `scope` for one query. */
export function createQuadSource(scope: QuadScope, opts: QuadSourceOptions): QuadSource {
  const { members, leftOut } = rdfMembers(scope.members, scope.caller, scope.fingerprintOf);
  const cap = opts.maxRecordsRead ?? sparqlLimits(getConfig()).maxRecordsRead;
  const narrow = opts.narrow !== false;
  const graphs = new Map(members.map(m => [m.space, DataFactory.namedNode(graphIri(m.meta))]));
  const counts = new Map<string, number>();
  let read = 0;
  let failed: SparqlRefusal | null = null;

  /** The time a find may take: what the query has left, at most {@link QUAD_FIND_MAX_MS}; past the deadline, the timeout. */
  const findMs = (): number => {
    const left = opts.deadline - Date.now();
    if (left <= 0) throw timeoutRefusal();
    return Math.min(QUAD_FIND_MAX_MS, Math.ceil(left));
  };
  const checkCaller = (): void => { if (opts.signal?.aborted) throw new ReadAborted(); };
  /** Count one record read; the read of record cap+1 ends the query. */
  const countRead = (): void => {
    read++;
    if (read > cap) throw tooMuchReadRefusal(cap);
  };
  /** The refusal a failed read answers: the query's own, the deadline's, or the store's (503); anything else is no store failure and is thrown as it is. */
  const failureOf = (err: unknown): unknown => {
    const named = sparqlRefusalOf(err);
    if (named) return named;
    if (isMaxTimeExpired(err)) return timeoutRefusal();
    return storeFailureRefusal(err) ?? err;
  };
  const fail = (err: unknown): never => {
    const mapped = failureOf(err);
    if (mapped instanceof SparqlRefusal && !failed) failed = mapped;
    throw mapped;
  };

  /** The finds of `pattern` in `member` the caller may read. */
  const findsOf = (pattern: QuadPattern, member: RdfMember): CandidateFind[] =>
    quadCandidates(pattern, member, narrow).filter(f => f.kind !== 'file' || member.files);

  /** The rows of one find, each counted as it is read. */
  async function* rowsOf(member: RdfMember, find: CandidateFind, cursors: HeldCursors): AsyncGenerator<Document, void, undefined> {
    const query = candidateQuery(member.space, find, cap);
    if (find.walk) {
      let after: string | undefined;
      for (;;) {
        checkCaller();
        const page = await idKeysetPage<{ _id: string } & Document>({ collection: query.collection, filter: query.filter, projection: query.projection, size: query.limit, maxTimeMS: findMs() }, after);
        for (const doc of page.rows) { countRead(); yield doc; }
        await yieldToEventLoop();
        if (page.end || page.last === undefined) return;
        after = page.last;
      }
    }
    cursors.open();
    const cursor = col<Document>(query.collection).find(query.filter, { projection: query.projection, limit: query.limit, maxTimeMS: findMs() });
    cursors.hold(cursor);
    try {
      // The find's first answer is awaited here: a stream destroyed while it was on its way closes this cursor once it has its server id.
      await cursor.hasNext();
      if (await cursors.answered(cursor)) return;
      let sinceYield = 0;
      for await (const doc of cursor) {
        checkCaller();
        countRead();
        yield doc;
        if (++sinceYield >= ROWS_PER_YIELD) { sinceYield = 0; await yieldToEventLoop(); }
      }
    } finally {
      cursors.release(cursor);
      await cursor.close().catch(() => undefined);
    }
  }

  /** Every statement of `pattern`, member by member, find by find. */
  async function* quadsOf(pattern: QuadPattern, cursors: HeldCursors): AsyncGenerator<N3.Quad, void, undefined> {
    try {
      if (failed) throw failed;
      const [s, p, o, g] = pattern;
      for (const member of members) {
        const graph = graphs.get(member.space)!;
        if (!fits(g, graph)) continue;
        const agentsSeen = new Set<string>();
        const statements = new Set<string>();
        for (const find of findsOf(pattern, member)) {
          for await (const doc of rowsOf(member, find, cursors)) {
            const form = recordTriples(member.meta, find.kind, doc, { edgeDetails: 'rdf12', agentsSeen });
            if (form.leftOut !== undefined) continue;
            const own = find.kind === 'edge' ? recordIri(member.meta, 'edge', String(doc['_id'])) : null;
            for (const q of form.quads) {
              const quad = toRdfJs(q, graph.value);
              if (!(fits(s, quad.subject) && fits(p, quad.predicate) && fits(o, quad.object))) continue;
              if (own !== null && quad.subject.value !== own) {
                // An edge statement `<from> <label> <to>`: two edges of one label between one pair state it once.
                const key = `${quad.subject.value} ${quad.predicate.value} ${quad.object.value}`;
                if (statements.has(key)) continue;
                statements.add(key);
              }
              yield quad;
            }
          }
        }
      }
    } catch (err) {
      // A read that ends because its consumer left is no failure of the store, and is never the query's (the next match must read on).
      if (cursors.destroyedByConsumer) throw new ReadAborted();
      fail(err);
    }
  }

  /** One estimate of a find's rows, cached for the query. */
  async function estimate(member: RdfMember, find: CandidateFind): Promise<number> {
    const query = candidateQuery(member.space, find, cap);
    const key = JSON.stringify([query.collection, find.walk ? null : query.filter]);
    const cached = counts.get(key);
    if (cached !== undefined) return cached;
    const c = col<Document>(query.collection);
    const n = find.walk
      ? await c.estimatedDocumentCount({ maxTimeMS: findMs() })
      : await c.countDocuments(query.filter, { limit: cap, maxTimeMS: findMs() });
    if (counts.size < COUNT_CACHE_MAX) counts.set(key, n);
    return n;
  }

  return {
    match(s, p, o, g) {
      const cursors = new HeldCursors();
      return new MatchStream(quadsOf([s, p, o, g], cursors), cursors);
    },
    async countQuads(s, p, o, g) {
      try {
        if (failed) throw failed;
        const pattern: QuadPattern = [s, p, o, g];
        let any = false;
        let sum = 0;
        for (const member of members) {
          if (!fits(g, graphs.get(member.space)!)) continue;
          const finds = findsOf(pattern, member);
          if (finds.length === 0) continue;
          any = true;
          // A bound subject or object names few statements: the engine is told 1, with no store call.
          if (isBound(s) || isBound(o)) continue;
          findMs();
          for (const find of finds) sum += await estimate(member, find);
        }
        if (!any) return 0;
        if (isBound(s) || isBound(o)) return 1;
        return Math.max(1, sum);
      } catch (err) {
        // The engine takes this promise with a `.catch` that destroys an iterator nobody listens to, which raises an unhandled rejection
        // per count: a count never rejects. The failure is the query's (`fail` records it, and every read ends with it), and the engine is
        // told 1, the one answer that skips no pattern.
        try { fail(err); } catch { /* recorded by `fail` when it is a refusal */ }
        return 1;
      }
    },
    leftOut: () => leftOut.map(({ space, code, status }) => ({ space, code, status })),
    filesWithheld: () => members.filter(m => !m.files).map(m => m.space),
    recordsRead: () => read,
    failure: () => failed,
  };
}

export type { PatternTerm };
