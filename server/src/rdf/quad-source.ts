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
 * - **A cursor held after its reader left.** Destroying a match stream closes every cursor it holds at once.
 * - **A false empty.** `countQuads` answers from estimates, and the engine skips a pattern it is told is empty: it answers 0 only when no
 *   find can answer the pattern at all, at least 1 otherwise, and a count it cannot make throws, never 0.
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
 * A match's stream: started on the first read, it pulls from the query's generator as the reader takes, and closes every cursor it holds
 * the moment it is destroyed.
 */
class MatchStream extends Readable {
  private pumping = false;
  /** The read of the generator in flight, if any: a find may be starting inside it. */
  private inflight: Promise<unknown> | null = null;
  constructor(private readonly quads: AsyncGenerator<N3.Quad, void, undefined>, private readonly cursors: Set<FindCursor<Document>>) {
    super({ objectMode: true });
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
      if (!this.destroyed) this.destroy(err as Error);
    }
  }

  /**
   * Close every cursor now, and again once a read in flight has settled: a cursor whose first batch was still on its way when it was closed
   * has no server id yet, so that close kills nothing and the cursor would stay open on the server until its idle timeout (seen in
   * `a-quad-source-read-is-bounded-db`: one batch of 101 rows handed out, never killed).
   */
  override _destroy(err: Error | null, callback: (error?: Error | null) => void): void {
    const closeAll = (): Promise<unknown> => Promise.all([...this.cursors].map(c => c.close().catch(() => undefined)));
    const settled = this.inflight ? this.inflight.then(() => undefined, () => undefined) : Promise.resolve();
    void closeAll()
      .then(() => settled)
      .then(closeAll)
      .then(() => { this.cursors.clear(); return this.quads.return(undefined).catch(() => undefined); })
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
    if (isStoreSide(err)) {
      const f = classifyReadFailure(err);
      return new SparqlRefusal(SPARQL_UNAVAILABLE, SPARQL_STORE_UNAVAILABLE, f.error, f.retryAfterSeconds ?? SPARQL_RETRY_AFTER_SECONDS);
    }
    return err;
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
  async function* rowsOf(member: RdfMember, find: CandidateFind, cursors: Set<FindCursor<Document>>): AsyncGenerator<Document, void, undefined> {
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
    const cursor = col<Document>(query.collection).find(query.filter, { projection: query.projection, limit: query.limit, maxTimeMS: findMs() });
    cursors.add(cursor);
    try {
      let sinceYield = 0;
      for await (const doc of cursor) {
        checkCaller();
        countRead();
        yield doc;
        if (++sinceYield >= ROWS_PER_YIELD) { sinceYield = 0; await yieldToEventLoop(); }
      }
    } finally {
      cursors.delete(cursor);
      await cursor.close().catch(() => undefined);
    }
  }

  /** Every statement of `pattern`, member by member, find by find. */
  async function* quadsOf(pattern: QuadPattern, cursors: Set<FindCursor<Document>>): AsyncGenerator<N3.Quad, void, undefined> {
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
      const cursors = new Set<FindCursor<Document>>();
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
        return fail(err);
      }
    },
    leftOut: () => leftOut.map(({ space, code, status }) => ({ space, code, status })),
    filesWithheld: () => members.filter(m => !m.files).map(m => m.space),
    recordsRead: () => read,
    failure: () => failed,
  };
}

export type { PatternTerm };
