/**
 * The reads a seed walk makes, and the ORDER each one comes back in — stated, so it can be reproduced.
 *
 * ## What it prevents (Q-136)
 *
 * `row-graphs.ts` walks a page's rows together: one edge read and one record read per hop for a whole window
 * of rows, each row keeping its own visited set and paths (`walk-in-step.ts`). That only returns what the rows
 * would have returned alone if every row gets, from the shared read, EXACTLY what its own read would have
 * handed it — the same documents in the same order. Order is not cosmetic here: the first edge into a node
 * decides which parent it is nested under, and the order edges and routes are met in is the order the answer
 * lists them.
 *
 * The walk's reads carry no sort, so their order was whatever the index the plan used reads in. That order is
 * a fact about the indexes, and this module writes it down:
 *
 * - **edges** (`edgeReadOrder`) — outbound reads `{from, to, label, fromKind, toKind}` in key order; inbound
 *   reads `{to}`, ties in record order; both is the union of the two, the outbound half first. So an edge
 *   whose `from` is on the frontier comes first in key order, and the rest follow by `to` and record id.
 * - **records by id** (`byStoredId`) — in `_id` order, which is what the `_id` index reads.
 *
 * The per-seed walk sorts what its own read returned into that order and the shared walk sorts each row's
 * share into it, so the two agree by construction rather than by the planner happening to pick the same plan
 * twice. On the indexes a space is built with, the per-seed sort changes nothing — the differential test
 * (`a-batched-row-walk-is-the-per-seed-walk-db.test.js`) walks with the unsorted reads as well and asserts it.
 *
 * Mongo compares strings by their UTF-8 bytes, which is code-point order. JavaScript's `<` compares UTF-16
 * units, which disagrees above U+D7FF — so `storedStringOrder` maps the units first rather than trusting `<`.
 */
import { col, asFilter } from '../db/mongo.js';
import { NEVER_RETURNED_PROJECTION } from './read-projection.js';
import type { EdgeDoc } from '../config/types.js';

/** Milliseconds a read may still take, from the walk's deadline. Throws once it is spent; `undefined` is unbounded. */
export type TimeLeft = () => number | undefined;

/**
 * Records of one collection by id, with every never-returned field projected away. `extra` narrows the query
 * itself (a `spaceId`, a scope); it is part of the question, so two reads with different `extra` are different
 * reads.
 */
export type RecordsById = <T extends { _id: string }>(
  collection: string, ids: readonly string[], extra?: Record<string, unknown>, timeLeft?: TimeLeft,
) => Promise<T[]>;

/** The read-order key a query exposes when asked: `showRecordId` puts it on the document as `$recordId`. */
export const RECORD_ID = '$recordId';

/** An edge as the walk's read returns it, before its record id is stripped. */
export type RankedEdge = EdgeDoc & { [RECORD_ID]?: unknown };

/**
 * The records `ids` name, in the database's own order. The one query both the per-seed walk and the shared one
 * make; the order is imposed by the caller, never assumed here.
 *
 * An empty id list reads nothing — but still asks the deadline, so a spent walk stops at the same step whether
 * or not the step had anything to fetch.
 */
export const readRecordsById: RecordsById = async <T extends { _id: string }>(
  collection: string, ids: readonly string[], extra?: Record<string, unknown>, timeLeft?: TimeLeft,
): Promise<T[]> => {
  const ms = timeLeft?.();
  if (ids.length === 0) return [];
  const cursor = col<T>(collection)
    .find(asFilter<T>({ _id: { $in: [...ids] }, ...(extra ?? {}) }))
    .project(NEVER_RETURNED_PROJECTION);
  if (ms !== undefined) cursor.maxTimeMS(ms);
  return await cursor.toArray() as T[];
};

/** Mongo's order for two stored strings: code point, which UTF-16 `<` is not above U+D7FF. */
export function storedStringOrder(a: string, b: string): number {
  if (a === b) return 0;
  const n = Math.min(a.length, b.length);
  for (let i = 0; i < n; i++) {
    let x = a.charCodeAt(i);
    let y = b.charCodeAt(i);
    if (x === y) continue;
    // A surrogate is part of a code point above U+FFFF, so it sorts after every unit from U+E000 up.
    x = x >= 0xE000 ? x - 0x800 : x >= 0xD800 ? x + 0x2000 : x;
    y = y >= 0xE000 ? y - 0x800 : y >= 0xD800 ? y + 0x2000 : y;
    return x - y;
  }
  return a.length - b.length;
}

/**
 * One index key field, in Mongo's order: an absent value is indexed as null, and null sorts before a string.
 * The key fields read here are strings or absent; anything else is compared as its string form.
 */
function keyOrder(a: unknown, b: unknown): number {
  const an = a === undefined || a === null;
  const bn = b === undefined || b === null;
  if (an || bn) return an === bn ? 0 : an ? -1 : 1;
  return storedStringOrder(String(a), String(b));
}

/** A record id as a bigint, whatever width the driver decoded it to. */
function recordIdOf(doc: object): bigint {
  const v = (doc as Record<string, unknown>)[RECORD_ID];
  if (typeof v === 'bigint') return v;
  if (typeof v === 'number') return BigInt(v);
  if (v !== undefined && v !== null) return BigInt(String(v));
  return 0n;
}

function recordIdOrder(a: object, b: object): number {
  const x = recordIdOf(a);
  const y = recordIdOf(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** Records in `_id` order — what the `_id` index reads. */
export function byStoredId(a: { _id: string }, b: { _id: string }): number {
  return keyOrder(a._id, b._id);
}

/** Which way a walk reads edges. Absent is `both`, as `frontierEdgeQuery` reads it. */
export type EdgeDirection = 'outbound' | 'inbound' | 'both';

/** Whether an edge is one this frontier's edge read returns — the predicate `frontierEdgeQuery` states. */
export function edgeTouchesFrontier(edge: EdgeDoc, frontier: ReadonlySet<string>, direction: EdgeDirection): boolean {
  if (direction === 'outbound') return frontier.has(edge.from);
  if (direction === 'inbound') return frontier.has(edge.to);
  return frontier.has(edge.from) || frontier.has(edge.to);
}

/**
 * The order a frontier's edge read returns edges in — see the module docblock. Needs each edge's `$recordId`
 * for the one tie the key cannot break: several edges into one node read through `{to}`.
 */
export function edgeReadOrder(frontier: ReadonlySet<string>, direction: EdgeDirection) {
  /** 0: read through the `{from, …}` key. 1: read through `{to}`. */
  const half = (e: EdgeDoc): 0 | 1 => direction === 'inbound' ? 1
    : direction === 'outbound' ? 0 : frontier.has(e.from) ? 0 : 1;
  return (a: RankedEdge, b: RankedEdge): number => {
    const ha = half(a);
    const hb = half(b);
    if (ha !== hb) return ha - hb;
    if (ha === 0) {
      return keyOrder(a.from, b.from) || keyOrder(a.to, b.to) || keyOrder(a.label, b.label)
        || keyOrder(a.fromKind, b.fromKind) || keyOrder(a.toKind, b.toKind) || recordIdOrder(a, b);
    }
    return keyOrder(a.to, b.to) || recordIdOrder(a, b);
  };
}

/** Drop the read-order key the edge read asked for, so no answer carries it. Mutates, and returns, `edge`. */
export function withoutRecordId(edge: RankedEdge): EdgeDoc {
  delete edge[RECORD_ID];
  return edge;
}
