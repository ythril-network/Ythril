/**
 * Walk several recall rows at once, each exactly as it would walk alone — one read per kind per hop, not one
 * per row.
 *
 * ## What it prevents (Q-136)
 *
 * `row-graphs.ts` walked each result row on its own through `traverseFromSeeds`, so a page of rows cost about
 * two queries per hop PER ROW: its edges, its records, and its link scan. Recall is a read the owner waits on,
 * and those round trips — not the index lookups — were the time. Here a window of rows is walked in step: the
 * walks run together, and whenever every one of them is waiting on a read, the reads are answered at once —
 * ONE query per kind for the whole window, over the union of their frontiers, each row handed its own share.
 *
 * ## Why every row is still exactly its own walk
 *
 * The walk is not rewritten here. Each row runs the one `traverseFromSeeds`, with its own visited set, paths,
 * alternate routes and self-loops; only its READS are answered from a shared query. So a row's graph is its
 * per-seed graph as long as each read hands back exactly what that row's own read would have — the same
 * documents in the same order. The rules that make that so:
 *
 * - **A row's share is its own predicate.** The shared edge read is `frontierEdgeQuery` over the union of the
 *   frontiers; a row's share is the edges its own frontier touches, by the same predicate
 *   (`edgeTouchesFrontier`), sorted into the order its own read returns (`walk-reads.ts`). Link rows are the
 *   same, and keep the shared read's order: each link read has exactly one index it can use, whose order a
 *   filtered share keeps — so a link share cut at the row's own limit is the row's own read, capped or not.
 * - **A row whose EDGE share would fill its cap is read ALONE.** The per-seed edge read takes a `limit` with a
 *   `+ 1` probe, and which edges a capped read keeps is whichever its plan yields first for THAT frontier. The
 *   both-way read is a union of two indexes, and a planner can prefer another index than the one the stated
 *   order describes — so past the cap, the stated order is not trusted to pick the same edges. A row whose
 *   share is larger than its own `limit` is answered by its own query for that read, and rejoins the window at
 *   its next read. Correctness beats batching: a hub row costs what it always did, and every other row in its
 *   window still shares.
 * - **A shared read that fills its own bound answers nobody.** Its limit is the sum of the rows' limits, plus
 *   the probe; when it comes back full, a share cannot be known to be whole, so every row in it reads alone.
 * - **Every row gets its own documents.** A record read once in a call is kept (`RecordCache`) and each row is
 *   handed a copy decoded from the stored bytes, so no two rows share an object — nothing a later step does to
 *   one row's answer can reach another's.
 * - **The deadline is the call's one deadline.** A shared read carries the least time any of its rows has left,
 *   and a read the deadline stops fails every row waiting on it, each exactly as its own read would have.
 *
 * What the cache trades: a record written DURING one call is seen as it was when the call first read it, where
 * a per-seed walk might have read the newer version for a later row. One call, one reading of each record.
 */
import { BSON } from 'mongodb';
import { readFrontierEdges, perSeedReads, type WalkReads } from './recall-seed-traversal.js';
import {
  readRecordsById, edgeReadOrder, edgeTouchesFrontier, byStoredId, withoutRecordId,
  type RankedEdge, type TimeLeft,
} from './walk-reads.js';
import { docsFromCollection, type LinkEnd, type LinkClass } from './link-adjacency.js';
import { STORED_LINK_READS } from './link-frontier.js';
import type { TraverseNarrowing } from './frontier-query.js';
import type { EdgeDoc } from '../config/types.js';

/**
 * Every record one call has read, per question: `question → id → record`, or `null` for an id the question
 * found nothing for. A question is a collection plus the narrowing and projection it was read with, so a
 * record read under one filter is never handed out under another.
 */
export type RecordCache = Map<string, Map<string, object | null>>;

export function newRecordCache(): RecordCache {
  return new Map();
}

interface Waiting<R> { step: number; resolve(value: R): void; reject(err: unknown): void }

type EdgeAsk = Waiting<EdgeDoc[]> & {
  op: 'edges'; spaceId: string; frontier: readonly string[]; narrowing: TraverseNarrowing | undefined;
  limit: number; timeLeft: TimeLeft;
};
type LinkAsk = Waiting<LinkEnd[]> & {
  op: 'linksPointingAt' | 'linksStartingFrom'; spaceId: string; ids: readonly string[]; limit: number | undefined;
};
type RecordAsk = Waiting<object[]> & {
  op: 'records'; question: string; ids: readonly string[]; timeLeft: TimeLeft | undefined;
  read: (ids: readonly string[], maxTimeMS: number | undefined) => Promise<Array<{ _id: string }>>;
};
type Ask = EdgeAsk | LinkAsk | RecordAsk;
/** An ask before it has anyone waiting on it — each kind keeps its own fields. */
type Question = Ask extends infer A ? A extends Ask ? Omit<A, 'step' | 'resolve' | 'reject'> : never : never;

/** Which asks one query can answer together. */
function groupOf(ask: Ask): string {
  if (ask.op === 'edges') {
    return `edges|${ask.spaceId}|${JSON.stringify([ask.narrowing?.direction ?? 'both', ask.narrowing?.edgeLabels ?? []])}`;
  }
  if (ask.op === 'records') return `records|${ask.question}`;
  return `${ask.op}|${ask.spaceId}`;
}

/** A document as its own object again, decoded from its bytes — what a fresh read of it would have produced. */
function copyOf<T extends object>(doc: T): T {
  return BSON.deserialize(BSON.serialize(doc)) as T;
}

/** Resolve an ask from its own per-seed read — the answer when a share cannot be known to be exact. */
async function alone<R>(ask: Waiting<R>, read: () => Promise<R>): Promise<void> {
  try { ask.resolve(await read()); } catch (err) { ask.reject(err); }
}

/** The least time any ask has left. One throwing means the call's deadline is spent, for all of them. */
function leastTimeLeft(clocks: ReadonlyArray<TimeLeft | undefined>): number | undefined {
  let least: number | undefined;
  for (const clock of clocks) {
    const ms = clock?.();
    if (ms !== undefined) least = least === undefined ? ms : Math.min(least, ms);
  }
  return least;
}

async function answerEdges(asks: EdgeAsk[]): Promise<void> {
  const first = asks[0]!;
  const readAlone = (a: EdgeAsk) => alone(a, () =>
    perSeedReads.edgesTouching(a.spaceId, a.frontier, a.narrowing, a.limit, a.timeLeft));
  if (asks.length === 1) return readAlone(first);
  const direction = first.narrowing?.direction ?? 'both';
  const bound = asks.reduce((n, a) => n + a.limit, 0);
  const union = [...new Set(asks.flatMap(a => a.frontier))];
  // The bound is the sum of the rows' own, with the probe: a full read cannot say whether any share is whole.
  const rows = await readFrontierEdges(first.spaceId, union, first.narrowing, bound + 1,
    leastTimeLeft(asks.map(a => a.timeLeft)));
  const whole = rows.length <= bound;
  const shares = asks.map((a): RankedEdge[] | null => {
    if (!whole) return null;
    const frontier = new Set(a.frontier);
    const share = rows.filter(e => edgeTouchesFrontier(e, frontier, direction));
    // Past its own limit, which documents this row's capped read keeps is the index's choice for ITS frontier.
    return share.length > a.limit ? null : share.sort(edgeReadOrder(frontier, direction));
  });
  for (const e of rows) withoutRecordId(e);
  const handedOut = new Set<object>();
  const own = (e: EdgeDoc): EdgeDoc => {
    if (!handedOut.has(e)) { handedOut.add(e); return e; }
    return copyOf(e);
  };
  await Promise.all(asks.map((a, i) => {
    const share = shares[i];
    if (share === null || share === undefined) return readAlone(a);
    a.resolve(share.map(own));
    return undefined;
  }));
}

async function answerLinks(asks: LinkAsk[]): Promise<void> {
  const first = asks[0]!;
  const read = STORED_LINK_READS[first.op];
  const readAlone = (a: LinkAsk) => alone(a, () => read(a.spaceId, a.ids, a.limit));
  if (asks.length === 1) return readAlone(first);
  const bound = asks.some(a => a.limit === undefined) ? undefined : asks.reduce((n, a) => n + (a.limit ?? 0), 0);
  const union = [...new Set(asks.flatMap(a => a.ids))];
  const rows = await read(first.spaceId, union, bound === undefined ? undefined : bound + 1);
  const whole = bound === undefined || rows.length <= bound;
  const end = (r: LinkEnd): string => first.op === 'linksPointingAt' ? r.to : r.from;
  await Promise.all(asks.map(a => {
    if (!whole) return readAlone(a);
    const ids = new Set(a.ids);
    // The shared read's own order, kept: a link read has one index it can use, so a share of it is in the order
    // the row's own read returns — and cut at the row's own limit, it IS that read, capped or not. (Unlike an
    // edge read, whose union interleaves two indexes; see `answerEdges`.)
    const share = rows.filter(r => ids.has(end(r)));
    a.resolve(a.limit === undefined ? share : share.slice(0, a.limit));
    return undefined;
  }));
}

async function answerRecords(asks: RecordAsk[], cache: RecordCache): Promise<void> {
  const first = asks[0]!;
  let known = cache.get(first.question);
  if (!known) { known = new Map(); cache.set(first.question, known); }
  const ms = leastTimeLeft(asks.map(a => a.timeLeft));
  const missing = [...new Set(asks.flatMap(a => a.ids))].filter(id => !known.has(id));
  if (missing.length > 0) {
    const docs = await first.read(missing, ms);
    for (const id of missing) known.set(id, null);
    for (const d of docs) known.set(d._id, d);
  }
  for (const a of asks) {
    const found: Array<{ _id: string }> = [];
    for (const id of new Set(a.ids)) {
      const doc = known.get(id);
      if (doc) found.push(copyOf(doc as { _id: string }));
    }
    a.resolve(found.sort(byStoredId));
  }
}

/** Every waiting ask answered — one query per group, and a failure fails only the asks it would have failed. */
async function answerAll(asks: Ask[], cache: RecordCache): Promise<void> {
  const groups = new Map<string, Ask[]>();
  for (const a of asks) {
    const key = groupOf(a);
    const g = groups.get(key);
    if (g) g.push(a); else groups.set(key, [a]);
  }
  await Promise.all([...groups.values()].map(async group => {
    try {
      const kind = group[0]!.op;
      if (kind === 'edges') await answerEdges(group as EdgeAsk[]);
      else if (kind === 'records') await answerRecords(group as RecordAsk[], cache);
      else await answerLinks(group as LinkAsk[]);
    } catch (err) {
      // A shared read failed — the deadline, most often. Every ask still waiting on it fails with it; an ask
      // already answered ignores the second settle, as a promise does.
      for (const a of group) a.reject(err);
    }
  }));
}

/**
 * Where an ask falls in its walk: the hop, then the read's place within a hop. A walk reads in this order every
 * hop — its edges, then the links pointing at its frontier, then the records those name, then the records its
 * edges reached — so answering the EARLIEST waiting step first keeps the window in step: a walk that has no
 * link records to fetch this hop waits at its entity read for the one that has, and they share it.
 */
const STEP_OF: Record<Ask['op'] | 'docs', number> = {
  edges: 0, linksStartingFrom: 1, linksPointingAt: 1, docs: 2, records: 3,
};

/**
 * Run `walks` in step: each gets a `WalkReads` whose reads are held until every walk still running is waiting
 * on one, and then the earliest step waiting is answered together. Returns one promise per walk, in order; a
 * walk's failure is its own.
 */
export function walkInStep<T>(
  walks: ReadonlyArray<(reads: WalkReads) => Promise<T>>,
  cache: RecordCache,
): Promise<T>[] {
  let running = walks.length;
  let waiting: Ask[] = [];
  const answerIfAllWaiting = (): void => {
    if (running === 0 || waiting.length < running) return;
    const earliest = Math.min(...waiting.map(a => a.step));
    const now = waiting.filter(a => a.step === earliest);
    waiting = waiting.filter(a => a.step !== earliest);
    void answerAll(now, cache);
  };

  /** One walk's reads. Its hop count is its own, which is what places each of its asks in the window. */
  const readsFor = (): WalkReads => {
    let hop = 0;
    const ask = <R>(a: Question, step: number): Promise<R> => new Promise<R>((resolve, reject) => {
      waiting.push({ ...a, step: hop * 10 + step, resolve, reject } as Ask);
      answerIfAllWaiting();
    });
    const records = (question: string, read: RecordAsk['read'], ids: readonly string[], step: number,
      timeLeft?: TimeLeft) => ask<object[]>({ op: 'records', question, read, ids, timeLeft }, step);
    return {
      edgesTouching: (spaceId, frontier, narrowing, limit, timeLeft) => {
        hop++;
        return ask<EdgeDoc[]>({ op: 'edges', spaceId, frontier, narrowing, limit, timeLeft }, STEP_OF.edges);
      },
      linksPointingAt: (spaceId, ids, limit) =>
        ask<LinkEnd[]>({ op: 'linksPointingAt', spaceId, ids, limit }, STEP_OF.linksPointingAt),
      linksStartingFrom: (spaceId, ids, limit) =>
        ask<LinkEnd[]>({ op: 'linksStartingFrom', spaceId, ids, limit }, STEP_OF.linksStartingFrom),
      recordsById: async <R extends { _id: string }>(
        collection: string, ids: readonly string[], extra?: Record<string, unknown>, timeLeft?: TimeLeft,
      ) => await records(`byId|${collection}|${JSON.stringify(extra ?? {})}`,
        (missing, maxTimeMS) => readRecordsById(collection, missing, extra, () => maxTimeMS), ids,
        STEP_OF.records, timeLeft) as R[],
      docsFromCollection: async <R extends { _id: string }>(
        spaceId: string, collection: LinkClass['collection'], ids: readonly string[],
        projection?: Record<string, 1>, extra?: Record<string, unknown>,
      ) => await records(`links|${spaceId}|${collection}|${JSON.stringify([projection ?? null, extra ?? null])}`,
        missing => docsFromCollection(spaceId, collection, missing, projection, extra), ids, STEP_OF.docs) as R[],
    };
  };

  return walks.map(walk => (async () => await walk(readsFor()))().finally(() => {
    running--;
    answerIfAllWaiting();
  }));
}
