/**
 * The read side of a space's triple index (bundle-273, Q-764 S3; design-r2 R1, R8): whether a query may read a member from its index now,
 * and the reads themselves, pattern by pattern or a join's bindings a hundred at a time.
 *
 * ## The question it answers
 *
 * "May this query read this member from its index, and if so, which statements match?" The quad source (`quad-source.ts`) asks it once
 * per member and query ({@link indexVerdict}); a member the verdict refuses is read from its records, which answer the same statements.
 *
 * ## When a member is read from its index (contract row 1)
 *
 * All of: the index has a state row and a build id (a rebuild wrote it: the follower reads by position and never reads a record without a
 * `pos`, so an index no rebuild wrote may miss records and is never read, finding G1), its `status` is `ready`, its `formKey` is the key of the member's form now, and the barrier holds: no
 * visible record or tombstone of the space stands above `appliedPos` (R1: a write that committed above a held floor counts, so a query never
 * sees an acknowledged write's old statements) and no journal row is outstanding (`hasOutstandingJournalRows`, every row, done or not).
 * When only the barrier fails and the lag is at most {@link CATCH_UP_MAX_LAG} records, the follower runs once, within
 * {@link CATCH_UP_SHARE} of the time the query has left, and the barrier is asked again. Otherwise the member is read from its records and
 * a follower run is started that the query does not wait for.
 *
 * ## One command for a ready member (bundle-378, Q-976 S2, contract row 2)
 *
 * The verdict reads the state row and the barrier in ONE command ({@link barrierRead}): an aggregate of the state row that looks up, in the
 * same command, the highest `pos` of each record collection and of the tombstones (a descending read of the `(pos, _id)` index, one row
 * each) and whether the journal holds a row. A member is ready when each highest `pos` is at or below `appliedPos` and the journal is
 * empty; only a member that is not ready pays more (the exact lag count, for the catch-up decision).
 *
 * The state row alone cannot keep the barrier, so the second half of the read stays, inside the same command. Nothing in the state row
 * moves when a record is written: the follower moves it after the write, and a write is acknowledged even when its follower did not run
 * (another process holds the lease, the store failed under the follower) and before an unpositioned write's journal row is cleared. Only
 * the records and the journal show such a write. The highest position answers exactly what the old count asked (a row above `appliedPos`
 * exists if and only if the highest one is above it), so a write acknowledged before the query started is either applied (its position
 * is at or below `appliedPos`) or seen (above it, or its journal row is there). The state row's write counter (`writes`, `store.ts`) is
 * not part of the barrier: it says when the index changed, never when the records did; it keys the planner's counts ({@link IndexRead.estimate}).
 *
 * ## What it prevents
 *
 * - **An answer the records would not give.** A statement is read only where the verdict holds; a term is turned back into the RDF/JS
 *   term the records path writes (`toRdfJsTerm` over the stored key), and a bound literal is looked up under every key the record form
 *   may store it by (a plain string with and without `xsd:string`).
 * - **A statement a caller may not read.** Without `files: read` on the member, only rows a knowledge or link record states (`nK > 0`).
 * - **An unbounded read.** Every quad row read counts against `sparql.maxIndexRowsRead`; the row after the cap ends the query with
 *   `413 sparql_too_much_read`. Every find carries a server deadline inside the query's.
 * - **A find per binding.** {@link IndexRead.matchMany} answers up to {@link IndexRead.BATCH} patterns with one find of `rdf_quads`, and
 *   the ids of the rows read are turned into terms by one find of `rdf_terms` per page, through a cache that lives as long as the query.
 * - **A batch that holds millions of rows (P1).** That one find is read in pages of at most {@link ROWS_PER_CALL} rows; a page is fitted to
 *   the patterns and let go, so a join step holds one page, never the cap. The cap counts every page of every call.
 */
import { Binary, type Document } from 'mongodb';
import { DataFactory } from 'n3';
import type * as N3 from 'n3';
import type { SpaceMeta } from '@ythril-network/schema';
import { col, asFilter } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { log, peerText } from '../../util/log.js';
import { warnOnce, SAY_ONCE_WINDOW_MS } from '../../util/warn-once.js';
import { inChunks } from '../../util/chunks.js';
import { yieldToEventLoop } from '../../util/yield-to-event-loop.js';
import { xsd, type Term } from '../literals.js';
import { toRdfJsTerm, type RdfJsTerm } from '../rdf-js-terms.js';
import { RDF_KIND_COLLECTIONS } from '../rdf-members.js';
import { isBound, type PatternSlot, type PatternTerm } from '../quad-candidates.js';
import { IDS_PER_FIND, MAX_TERM_ID, idsOfStoredKeys, storedKeyOf, type TermRow } from './terms.js';
import { formKeyOf, packStatement, readTripleIndexState, type TripleIndexState } from './store.js';

/** The most records a member may lag behind for a query to wait for its follower. */
export const CATCH_UP_MAX_LAG = 2_000;
/** The share of the time a query has left that it waits for a follower to catch up. */
export const CATCH_UP_SHARE = 0.25;
/** The longest server deadline one find carries, in milliseconds. */
const FIND_MAX_MS = 10_000;
/** Quad rows a streamed match turns into terms at once. */
const ROWS_PER_PAGE = 1_000;
/**
 * The most quad rows a batched read holds at once (P1): the one find of a batch is read in pages of this many rows, each fitted to the
 * patterns and let go, so a join step never holds the millions of rows `sparql.maxIndexRowsRead` allows. Every row of every page counts
 * against that cap. A reader's `rowsPerCall` option overrides it.
 */
export const ROWS_PER_CALL = 100_000;
/**
 * The rows of a streamed match's first page, each next page this factor larger up to {@link ROWS_PER_PAGE}. The engine opens the large side
 * of a join before the batch join drops it unread, and a first page of the full size read and counted a thousand rows nobody asked for.
 */
const FIRST_PAGE_ROWS = 100;
const PAGE_GROWTH = 2;
/** The most entries a query's term cache holds per space and kind: past it a term is looked up again when asked for again (finding G6). */
export const CACHE_TERMS_MAX = 200_000;
/** The row-against-pattern tests of a batched read between two `check()` calls (and a turn of the event loop). */
const FILTER_TESTS_PER_CHECK = 10_000;
const RDF_LANG_STRING = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#langString';

/** Why a member is read from its records, or that it is read from its index (with the build and the write counter it was ready at). */
export type IndexVerdict = { read: 'index'; buildId: string; writes: number } | { read: 'records'; why: 'absent' | 'unbuilt' | 'stale' | 'other-form' | 'catching-up' | 'lagging' | 'journal' };

/** The build and the write counter a member was read at: what a kept planning count is keyed by ({@link IndexRead.estimate}). */
export interface IndexStamp { buildId: string; writes: number }

/**
 * The build `spaceId`'s index is now (`null`: none, or a state no rebuild wrote). A query pins it in its verdict and
 * asks again at its end (design-r2 R5): another answer means a rebuild swapped the collections it read.
 */
export async function indexBuildOf(spaceId: string): Promise<string | null> {
  return (await readTripleIndexState(spaceId))?.buildId ?? null;
}

/**
 * How a query asks the follower to catch a space up: registered by the application at its start (`follow.ts` `followRecordWrites`), as the
 * follower's other wakes are, so a read door never calls a writer itself. Unregistered (a process that runs no follower), a member that is
 * behind is read from its records.
 */
let catchUp: ((spaceId: string) => Promise<void>) | null = null;
export function catchUpTripleIndexWith(fn: (spaceId: string) => Promise<void>): void { catchUp = fn; }
const caughtUpNow = (spaceId: string): Promise<void> => (catchUp ? catchUp(spaceId) : Promise.reject(new Error('no follower runs in this process')));

/** A follower run started by a query that does not wait for it: its failure is said once per window and space. */
const followFailed = warnOnce<string>({ every: SAY_ONCE_WINDOW_MS });
function followInBackground(spaceId: string): void {
  if (!catchUp) return;
  caughtUpNow(spaceId).catch((err: unknown) => followFailed(spaceId,
    () => log.warn(`Triple index of space '${peerText(spaceId)}': the follower a query started failed; the next write runs it again: ${peerText(String(err))}`)));
}

/** The time a store call may take: what is left of `deadline`, at most {@link FIND_MAX_MS}, at least 1 ms. */
const msLeft = (deadline: number): number => Math.max(1, Math.min(FIND_MAX_MS, Math.ceil(deadline - Date.now())));

/**
 * How many visible records and tombstones of `spaceId` stand above `appliedPos`, counted up to `CATCH_UP_MAX_LAG + 1`: the barrier's
 * positioned half, which the drift verify (`verify.ts`) asks too.
 */
export async function lagOf(spaceId: string, appliedPos: number, deadline: number): Promise<number> {
  const parts = [...RDF_KIND_COLLECTIONS.map(k => k.collection), 'tombstones' as const];
  let lag = 0;
  for (const part of parts) {
    lag += await col(spaceCollection(spaceId, part)).countDocuments(asFilter({ pos: { $gt: appliedPos } }), { limit: CATCH_UP_MAX_LAG + 1 - lag, maxTimeMS: msLeft(deadline) });
    if (lag > CATCH_UP_MAX_LAG) break;
  }
  return lag;
}

/** The record collections and the tombstones: what the follower reads by position, so what the barrier reads. */
const POSITIONED_PARTS = [...RDF_KIND_COLLECTIONS.map(k => k.collection), 'tombstones' as const];

/** What the verdict's one command reads: the state row, whether a positioned row stands above its `appliedPos`, whether the journal holds a row. */
interface BarrierRead { state: TripleIndexState; above: boolean; journal: boolean }

/**
 * The state row of `spaceId`'s index and its barrier, in one command (the module docblock): `null` when there is no state row. Each part's
 * highest `pos` is one row read down the `(pos, _id)` index; a highest `pos` that is not a number (no position stored is no row above it in
 * the old count either, but a value of another type is not trusted) counts as above, so the doubt sends the member to its records.
 */
async function barrierRead(spaceId: string, deadline: number): Promise<BarrierRead | null> {
  const highest = POSITIONED_PARTS.map((part, i) => ({
    $lookup: { from: spaceCollection(spaceId, part), pipeline: [{ $sort: { pos: -1 } }, { $limit: 1 }, { $project: { _id: 0, pos: 1 } }], as: `top${i}` },
  }));
  const rows = await col<Document>(spaceCollection(spaceId, 'rdfState')).aggregate([
    { $match: { _id: 'state' } },
    ...highest,
    { $lookup: { from: spaceCollection(spaceId, 'rdfDirty'), pipeline: [{ $limit: 1 }, { $project: { _id: 1 } }], as: 'journal' } },
  ], { maxTimeMS: msLeft(deadline) }).toArray();
  const row = rows[0];
  if (row === undefined) return null;
  const state = row as unknown as TripleIndexState;
  const above = POSITIONED_PARTS.some((_part, i) => {
    const top = (row[`top${i}`] as Array<{ pos?: unknown }> | undefined)?.[0];
    if (top === undefined || top.pos === undefined || top.pos === null) return false;
    return typeof top.pos !== 'number' || top.pos > state.appliedPos;
  });
  return { state, above, journal: (row['journal'] as unknown[] | undefined ?? []).length > 0 };
}

/** The verdict without catching up: index, or the reason not, with the lag when only the barrier failed. */
async function verdictNow(spaceId: string, meta: SpaceMeta, deadline: number): Promise<{ verdict: IndexVerdict; lag: number }> {
  const read = await barrierRead(spaceId, deadline);
  if (read === null) return { verdict: { read: 'records', why: 'absent' }, lag: Infinity };
  const { state } = read;
  // G1: the follower reads by position, so it never reads a record without a `pos`; only a rebuild reads every row. An index no rebuild wrote
  // is never served, whatever its status says, and the upkeep (`verify.ts`, reason `missing`) builds it.
  if (typeof state.buildId !== 'string') return { verdict: { read: 'records', why: 'unbuilt' }, lag: Infinity };
  if (state.status === 'stale') return { verdict: { read: 'records', why: 'stale' }, lag: Infinity };
  if (state.formKey !== formKeyOf(meta)) return { verdict: { read: 'records', why: 'other-form' }, lag: Infinity };
  // Behind: the exact lag (bounded) decides whether the query waits for the follower. Read only for a member that is not ready.
  const lag = read.above ? await lagOf(spaceId, state.appliedPos, deadline) : 0;
  if (lag > 0) return { verdict: { read: 'records', why: 'lagging' }, lag };
  if (read.journal) return { verdict: { read: 'records', why: 'journal' }, lag: 1 };
  if (state.status !== 'ready') return { verdict: { read: 'records', why: 'catching-up' }, lag: 1 };
  return { verdict: { read: 'index', buildId: state.buildId, writes: state.writes ?? 0 }, lag: 0 };
}

/**
 * Whether a query with `deadline` may read `spaceId` (of form `meta`) from its index now (the module docblock gives the rule). Never throws
 * for the index's sake: a store error is the caller's, as any read's.
 */
export async function indexVerdict(spaceId: string, meta: SpaceMeta, deadline: number): Promise<IndexVerdict> {
  const first = await verdictNow(spaceId, meta, deadline);
  if (first.verdict.read === 'index') return first.verdict;
  const why = first.verdict.why;
  if (why === 'stale' || why === 'unbuilt' || why === 'other-form' || first.lag > CATCH_UP_MAX_LAG) {
    if (why !== 'stale' && why !== 'unbuilt') followInBackground(spaceId);
    return first.verdict;
  }
  const wait = Math.max(0, (deadline - Date.now()) * CATCH_UP_SHARE);
  let timer: NodeJS.Timeout | undefined;
  const caughtUp = await Promise.race([
    caughtUpNow(spaceId).then(() => true, () => false),
    new Promise<boolean>((resolve) => { timer = setTimeout(() => resolve(false), wait); timer.unref(); }),
  ]);
  if (timer) clearTimeout(timer);
  if (!caughtUp) return first.verdict;
  const second = await verdictNow(spaceId, meta, deadline);
  if (second.verdict.read !== 'index') followInBackground(spaceId);
  return second.verdict;
}

/** The stored keys a ground term may be stored by (a plain string with and without `xsd:string`), or none for a term no record writes. */
export function keysOfTerm(t: PatternTerm): string[] {
  switch (t.termType) {
    case 'NamedNode': return [`I${t.value}`];
    case 'Literal': {
      const lang = t.language ?? '';
      const dt = t.datatype?.value ?? '';
      if (lang !== '') return [`L${JSON.stringify([t.value, '', lang])}`, `L${JSON.stringify([t.value, RDF_LANG_STRING, lang])}`];
      if (dt === '' || dt === xsd('string')) return [`L${JSON.stringify([t.value, '', ''])}`, `L${JSON.stringify([t.value, xsd('string'), ''])}`];
      return [`L${JSON.stringify([t.value, dt, ''])}`];
    }
    case 'Quad': {
      if (!t.subject || !t.predicate || !t.object || !isGround(t)) return [];
      const out: string[] = [];
      for (const s of keysOfTerm(t.subject)) for (const p of keysOfTerm(t.predicate)) for (const o of keysOfTerm(t.object)) out.push(`T${JSON.stringify([s, p, o])}`);
      return out;
    }
    default: return [];
  }
}

/** A slot holds no variable anywhere (a triple term's parts included). */
function isGround(t: PatternTerm): boolean {
  if (t.termType === 'Variable') return false;
  if (t.termType !== 'Quad') return true;
  return [t.subject, t.predicate, t.object].every(x => x !== undefined && isGround(x));
}

/** The record term a stored key stands for. */
function termOfKey(key: string): Term {
  const body = key.slice(1);
  switch (key[0]) {
    case 'I': return { kind: 'iri', value: body };
    case 'L': {
      const [value, datatype, language] = JSON.parse(body) as [string, string, string];
      return { kind: 'literal', value, ...(datatype ? { datatype } : {}), ...(language ? { language } : {}) };
    }
    case 'T': {
      const [s, p, o] = (JSON.parse(body) as [string, string, string]).map(termOfKey) as [Term, Term, Term];
      if ((s.kind !== 'iri' && s.kind !== 'blank') || p.kind !== 'iri') throw new Error('the triple index holds a triple term with a subject or predicate no record writes');
      return { kind: 'triple', subject: s, predicate: p, object: o };
    }
    default: throw new Error('the triple index holds a term key of no known kind');
  }
}

/** A row of `rdf_quads` as read. */
interface QuadRow { s: number; p: number; o: number }
/** One pattern's alternatives per slot: `null` is free; an array the ids it may take (empty: the pattern matches nothing). */
type Slots = [number[] | null, number[] | null, number[] | null];

const MIN_ID = 0;
const bin = (s: number, p: number, o: number): Binary => new Binary(packStatement(s, p, o));

/** The filter of one combination of ids (each `undefined` free), on the index that serves it; the drift verify's term lookup too (`verify.ts`). */
export function filterOf(s: number | undefined, p: number | undefined, o: number | undefined): Document {
  if (s !== undefined && p !== undefined && o !== undefined) return { _id: bin(s, p, o) };
  if (s !== undefined && p !== undefined) return { _id: { $gte: bin(s, p, MIN_ID), $lte: bin(s, p, MAX_TERM_ID) } };
  if (s !== undefined && o !== undefined) return { o, s };
  if (s !== undefined) return { _id: { $gte: bin(s, MIN_ID, MIN_ID), $lte: bin(s, MAX_TERM_ID, MAX_TERM_ID) } };
  if (p !== undefined && o !== undefined) return { p, o };
  if (p !== undefined) return { p };
  if (o !== undefined) return { o };
  return {};
}

/** The filters of every combination of a pattern's alternatives. */
function filtersOf([subjects, predicates, objects]: Slots): Document[] {
  const alts = (x: number[] | null): Array<number | undefined> => (x === null ? [undefined] : x);
  const out: Document[] = [];
  for (const s of alts(subjects)) for (const p of alts(predicates)) for (const o of alts(objects)) out.push(filterOf(s, p, o));
  return out;
}

/** Does the row fit the slots? */
const rowFits = (row: QuadRow, [s, p, o]: Slots): boolean =>
  (s === null || s.includes(row.s)) && (p === null || p.includes(row.p)) && (o === null || o.includes(row.o));

/** What one query's index reads need from the quad source: its deadline, its row cap, and its own checks. */
export interface IndexReadOptions {
  /** The most quad rows the query may read; the next one throws `tooMuch()`. */
  cap: number;
  deadline: number;
  /** Throws when the query must stop (its caller left, its deadline passed). */
  check(): void;
  /** The refusal the read of row cap+1 throws. */
  tooMuch(): Error;
  /** The most entries each of a space's two term caches holds ({@link CACHE_TERMS_MAX} when absent); a term past it is looked up again. */
  cacheTermsMax?: number;
  /** The most quad rows a batched read holds at once ({@link ROWS_PER_CALL} when absent). */
  rowsPerCall?: number;
}

/** One query's reads of the indexes of its members: the term caches and the row count live as long as the query. */
export class IndexRead {
  /** The most patterns one find answers. */
  static readonly BATCH = 100;
  private readonly idCache = new Map<string, Map<string, number | null>>();
  private readonly termCache = new Map<string, Map<number, RdfJsTerm>>();
  private read = 0;
  private peak = 0;
  private readonly cacheMax: number;
  private readonly rowsPerCall: number;
  constructor(private readonly opts: IndexReadOptions) {
    this.cacheMax = opts.cacheTermsMax ?? CACHE_TERMS_MAX;
    this.rowsPerCall = opts.rowsPerCall ?? ROWS_PER_CALL;
    if (!Number.isInteger(this.rowsPerCall) || this.rowsPerCall < 1) throw new Error(`rowsPerCall must be a positive integer, got ${this.rowsPerCall}`);
  }

  /** Quad rows read so far. */
  rowsRead(): number { return this.read; }

  /** The most quad rows a batched read of this reader held at once (never more than `rowsPerCall`). */
  peakRowsHeld(): number { return this.peak; }

  private ids(space: string): Map<string, number | null> {
    let m = this.idCache.get(space);
    if (!m) { m = new Map(); this.idCache.set(space, m); }
    return m;
  }

  private terms(space: string): Map<number, RdfJsTerm> {
    let m = this.termCache.get(space);
    if (!m) { m = new Map(); this.termCache.set(space, m); }
    return m;
  }

  /** The ids of every stored key of `keys` in `space` (absent keys map to null), looked up once per query. */
  private async lookUpKeys(space: string, keys: readonly string[]): Promise<Map<string, number | null>> {
    const cache = this.ids(space);
    // The answer is the call's own map, so a cache that stopped growing (G6) never takes a key away from the pattern asking for it.
    const found = new Map<string, number | null>();
    const missing: string[] = [];
    for (const k of new Set(keys.map(storedKeyOf))) {
      const hit = cache.get(k);
      if (hit !== undefined) found.set(k, hit); else missing.push(k);
    }
    const ids = await idsOfStoredKeys(spaceCollection(space, 'rdfTerms'), missing, { beforeFind: () => this.opts.check(), findMs: () => msLeft(this.opts.deadline) });
    for (const k of missing) {
      const id = ids.get(k) ?? null;
      found.set(k, id);
      if (cache.size < this.cacheMax) cache.set(k, id);
    }
    return found;
  }

  /** The slots of a pattern, its bound terms looked up already (`found`): an unground triple term is free (the caller filters by its parts). */
  private slotsOf(found: ReadonlyMap<string, number | null>, terms: readonly [PatternSlot, PatternSlot, PatternSlot]): Slots {
    return terms.map((t): number[] | null => {
      if (!isBound(t) || (t.termType === 'Quad' && !isGround(t))) return null;
      return keysOfTerm(t).map(k => found.get(storedKeyOf(k))).filter((id): id is number => typeof id === 'number');
    }) as Slots;
  }

  /** The RDF/JS terms of `ids` in `space`, read by one find per thousand ids not in the query's cache. The answer is the call's own map. */
  private async termsOf(space: string, ids: Iterable<number>): Promise<Map<number, RdfJsTerm>> {
    const cache = this.terms(space);
    const result = new Map<number, RdfJsTerm>();
    const missing: number[] = [];
    for (const id of new Set(ids)) {
      const hit = cache.get(id);
      if (hit !== undefined) result.set(id, hit); else missing.push(id);
    }
    for (const chunk of inChunks(missing, IDS_PER_FIND)) {
      this.opts.check();
      const rows = await col<TermRow>(spaceCollection(space, 'rdfTerms')).find(asFilter<TermRow>({ _id: { $in: chunk } }), { projection: { _id: 1, k: 1, v: 1 }, maxTimeMS: msLeft(this.opts.deadline) }).toArray();
      // A term read here is known by its key too: a later batch binding it (a join's next side) needs no lookup of it.
      const keys = this.ids(space);
      for (const row of rows) {
        const term = toRdfJsTerm(termOfKey(row.v ?? row.k));
        result.set(row._id, term);
        if (cache.size < this.cacheMax) cache.set(row._id, term);
        if (keys.size < this.cacheMax) keys.set(row.k, row._id);
      }
    }
    return result;
  }

  /**
   * The rows of `filters` (one find; an `$or` when several) in pages of at most `rowsPerCall` rows, each row counted against the cap as it is
   * read. A page is handed to `onPage` and let go before the next one is read, so no more than a page is held (P1). The count is the whole
   * call's: the cap ends a read whose pages add up past it.
   */
  private async rowsInPages(space: string, files: boolean, filters: readonly Document[], onPage: (rows: QuadRow[]) => Promise<void>): Promise<void> {
    if (filters.length === 0) return;
    this.opts.check();
    const where: Document = filters.length === 1 ? { ...filters[0] } : { $or: filters };
    const filter = files ? where : { $and: [where, { nK: { $gt: 0 } }] };
    const left = this.opts.cap - this.read + 1;
    const cursor = col<QuadRow & Document>(spaceCollection(space, 'rdfQuads')).find(asFilter(filter), { projection: { _id: 0, s: 1, p: 1, o: 1 }, limit: left, maxTimeMS: msLeft(this.opts.deadline), batchSize: ROWS_PER_PAGE });
    let page: QuadRow[] = [];
    try {
      for await (const row of cursor) {
        this.read++;
        if (this.read > this.opts.cap) throw this.opts.tooMuch();
        page.push({ s: row.s, p: row.p, o: row.o });
        if (page.length % ROWS_PER_PAGE === 0) this.opts.check();
        if (page.length < this.rowsPerCall) continue;
        this.peak = Math.max(this.peak, page.length);
        await onPage(page);
        page = [];
      }
      if (page.length > 0) {
        this.peak = Math.max(this.peak, page.length);
        await onPage(page);
      }
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }

  /** The quads of `rows` in `graph`, their ids turned into terms. */
  private async quadsOf(space: string, graph: N3.NamedNode, rows: readonly QuadRow[]): Promise<N3.Quad[]> {
    const terms = await this.termsOf(space, rows.flatMap(r => [r.s, r.p, r.o]));
    return rows.map((r) => {
      const [s, p, o] = [terms.get(r.s), terms.get(r.p), terms.get(r.o)];
      if (!s || !p || !o) throw new Error(`the triple index of space '${space}' holds a statement whose term is in no dictionary row`);
      return DataFactory.quad(s as N3.Quad_Subject, p as N3.Quad_Predicate, o as unknown as N3.Quad_Object, graph);
    });
  }

  /**
   * Every statement of `space` (read into `graph`) that matches the bound terms of the pattern, streamed a page of rows at a time from one
   * find. A slot left free here (an unbound one, an unground triple term) is matched by the caller.
   */
  async *match(space: string, files: boolean, graph: N3.NamedNode, terms: readonly [PatternSlot, PatternSlot, PatternSlot]): AsyncGenerator<N3.Quad, void, undefined> {
    const bound = terms.filter((t): t is PatternTerm => isBound(t) && isGround(t)).flatMap(keysOfTerm);
    const found = await this.lookUpKeys(space, bound);
    const slots = this.slotsOf(found, terms);
    if (!slots.every(x => x === null || x.length > 0)) return;
    const filters = filtersOf(slots);
    const where: Document = filters.length === 1 ? filters[0]! : { $or: filters };
    this.opts.check();
    const cursor = col<QuadRow & Document>(spaceCollection(space, 'rdfQuads')).find(asFilter(files ? where : { $and: [where, { nK: { $gt: 0 } }] }), {
      projection: { _id: 0, s: 1, p: 1, o: 1 }, limit: this.opts.cap - this.read + 1, maxTimeMS: msLeft(this.opts.deadline), batchSize: ROWS_PER_PAGE,
    });
    try {
      let page: QuadRow[] = [];
      let pageRows = FIRST_PAGE_ROWS;
      for await (const row of cursor) {
        this.read++;
        if (this.read > this.opts.cap) throw this.opts.tooMuch();
        page.push({ s: row.s, p: row.p, o: row.o });
        if (page.length < pageRows) continue;
        this.opts.check();
        yield* await this.quadsOf(space, graph, page);
        page = [];
        pageRows = Math.min(pageRows * PAGE_GROWTH, ROWS_PER_PAGE);
      }
      if (page.length > 0) yield* await this.quadsOf(space, graph, page);
    } finally {
      await cursor.close().catch(() => undefined);
    }
  }

  /**
   * The statements of each of `patterns` (at most {@link IndexRead.BATCH}) in `space`: one lookup of every bound term, one find of
   * `rdf_quads` for them all, and one lookup of the terms the rows hold. Answers per pattern, in order.
   */
  async matchMany(space: string, files: boolean, graph: N3.NamedNode, patterns: ReadonlyArray<readonly [PatternSlot, PatternSlot, PatternSlot]>): Promise<N3.Quad[][]> {
    if (patterns.length > IndexRead.BATCH) throw new Error(`one index read answers at most ${IndexRead.BATCH} patterns`);
    const bound = patterns.flatMap(p => p.filter((t): t is PatternTerm => isBound(t) && isGround(t)).flatMap(keysOfTerm));
    const found = await this.lookUpKeys(space, bound);
    const slots = patterns.map(p => this.slotsOf(found, p));
    const live = slots.filter(s => s.every(x => x === null || x.length > 0));
    const filters = live.flatMap(filtersOf);
    const answers: N3.Quad[][] = slots.map(() => []);
    // Rows times patterns tests: the loop checks for a caller that left, and gives the event loop a turn, as the reads do (finding G6).
    let tested = 0;
    const fitPage = async (rows: QuadRow[]): Promise<void> => {
      const quads = await this.quadsOf(space, graph, rows);
      for (let k = 0; k < slots.length; k++) {
        const s = slots[k]!;
        if (!s.every(x => x === null || x.length > 0)) continue;
        for (let i = 0; i < rows.length; i++) {
          if (rowFits(rows[i]!, s)) answers[k]!.push(quads[i]!);
          if (++tested % FILTER_TESTS_PER_CHECK === 0) { this.opts.check(); await yieldToEventLoop(); }
        }
      }
    };
    // A free pattern reads every row: no other filter narrows it.
    await this.rowsInPages(space, files, filters.some(f => Object.keys(f).length === 0) ? [{}] : dedupe(filters), fitPage);
    return answers;
  }

  /**
   * An estimate of the statements of a pattern in `space`, for the engine's planner: a count bounded by the cap, kept in this process under
   * the index's build and write counter (`at`, from the verdict) and reused while they are the same ({@link keptCount}). A count is a true
   * count of the index at a counter at or after `at`; the quad source never answers the engine 0 for a pattern a find can answer.
   */
  async estimate(space: string, files: boolean, terms: readonly [PatternSlot, PatternSlot, PatternSlot], at: IndexStamp): Promise<number> {
    const key = JSON.stringify([space, at.buildId, at.writes, files, terms.map(t => (!isBound(t) || (t.termType === 'Quad' && !isGround(t)) ? null : keysOfTerm(t)))]);
    const kept = keptCount(key);
    if (kept !== undefined) return kept;
    const n = await this.countNow(space, files, terms);
    keepCount(key, n);
    return n;
  }

  /** The count of a pattern's statements in `space` now: a term lookup and one count of `rdf_quads`. */
  private async countNow(space: string, files: boolean, terms: readonly [PatternSlot, PatternSlot, PatternSlot]): Promise<number> {
    const bound = terms.filter((t): t is PatternTerm => isBound(t) && isGround(t)).flatMap(keysOfTerm);
    const found = await this.lookUpKeys(space, bound);
    const slots = this.slotsOf(found, terms);
    if (!slots.every(x => x === null || x.length > 0)) return 0;
    const filters = filtersOf(slots);
    const where: Document = filters.length === 1 ? filters[0]! : { $or: filters };
    const coll = col<Document>(spaceCollection(space, 'rdfQuads'));
    if (files && Object.keys(where).length === 0) return coll.estimatedDocumentCount({ maxTimeMS: msLeft(this.opts.deadline) });
    return coll.countDocuments(asFilter(files ? where : { $and: [where, { nK: { $gt: 0 } }] }), { limit: this.opts.cap, maxTimeMS: msLeft(this.opts.deadline) });
  }
}

/** The most planning counts this process keeps; past it the least recently used goes. */
export const KEPT_COUNTS_MAX = 10_000;
/**
 * The planning counts of every query in this process, by space, build, write counter, files right and the pattern's bound keys (bundle-378,
 * Q-976 S2, contract row 3). The write counter rises in every write that changes the index (`store.ts`), so a count is never reused for
 * an index that changed after it; a rebuild has another build id. A space deleted and made again starts another build. What it prevents:
 * a term lookup and a count of `rdf_quads` per free pattern per query, most of a small query's planning.
 */
const keptCounts = new Map<string, number>();
function keptCount(key: string): number | undefined {
  const n = keptCounts.get(key);
  if (n === undefined) return undefined;
  keptCounts.delete(key);
  keptCounts.set(key, n);
  return n;
}
function keepCount(key: string, n: number): void {
  keptCounts.delete(key);
  keptCounts.set(key, n);
  while (keptCounts.size > KEPT_COUNTS_MAX) keptCounts.delete(keptCounts.keys().next().value as string);
}

/** Filters once each (two bindings of one join may ask the same lookup). */
function dedupe(filters: readonly Document[]): Document[] {
  const seen = new Map<string, Document>();
  for (const f of filters) seen.set(JSON.stringify(f), f);
  return [...seen.values()];
}
