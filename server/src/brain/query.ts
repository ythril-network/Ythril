/**
 * Structured read-only query (`queryBrain`) — the operator-whitelisted Mongo query surface.
 *
 * Split out of brain/memory.ts (A17.4). This is the raw-Mongo query path behind REST /query and the
 * MCP `query` tool; distinct from the recall filter DSL in filter.ts. Includes the operator
 * whitelist, the ReDoS-safe sanitiser, and the projection guard that never lets `embedding` out.
 */
import { col } from '../db/mongo.js';
import { BUDGET_REQUEST_FIELDS } from './result-budget.js';
import { BRAIN_COLLECTIONS, type BrainCollection } from '../config/types.js';
import { hasReDoSRisk, MAX_PATTERN_LENGTH } from '../util/redos.js';
import { normaliseProjection, toMongoProjection } from './projection.js';

// Allowed top-level query operators for the structured query tool
const ALLOWED_OPERATORS = new Set([
  '$eq', '$ne', '$gt', '$gte', '$lt', '$lte', '$in', '$nin',
  '$and', '$or', '$nor', '$not', '$exists', '$type', '$regex', '$options',
  '$all', '$elemMatch', '$size', '$mod',
]);

// Valid MongoDB regex flags (i=case-insensitive, m=multiline, s=dotAll, x=extended)
const VALID_OPTIONS_RE = /^[imsx]+$/;

/**
 * Exported so `recall` can validate a raw-Mongo filter with the SAME parser, allowlist and depth cap `query` uses.
 *
 * The fleet integrator, 2026-08-13T1035Z §2: recall's filter is one operator object per key, ANDed, while query's takes
 * `$or`/`$and`/`$not`/`$regex`/`$elemMatch` nested to depth 8 — so a caller wanting meaning-ranking AND a real predicate
 * had to make two calls. Two filter languages against one store is a fork of the same policy, and the narrower one keeps
 * being the reason a caller reaches for the wrong tool.
 *
 * One parser, not two similar ones.
 */
export function sanitizeFilter(filter: unknown, depth = 0): unknown {
  if (depth > 8) throw new Error('Filter too deeply nested');
  if (Array.isArray(filter)) return filter.map(v => sanitizeFilter(v, depth + 1));
  if (filter !== null && typeof filter === 'object') {
    const entries = Object.entries(filter as Record<string, unknown>);
    const out: Record<string, unknown> = {};
    for (const [key, val] of entries) {
      if (key.startsWith('$') && !ALLOWED_OPERATORS.has(key)) {
        throw new Error(`Operator '${key}' is not allowed in queries`);
      }
      // $regex must be a plain string and pass the shared ReDoS heuristic —
      // a catastrophic pattern would otherwise pin Mongo CPU for the full
      // maxTimeMS budget per call (multiplied per member space on proxies).
      if (key === '$regex') {
        if (typeof val !== 'string') {
          throw new Error("'$regex' must be a string pattern");
        }
        if (val.length > MAX_PATTERN_LENGTH) {
          throw new Error(`'$regex' pattern exceeds ${MAX_PATTERN_LENGTH} characters`);
        }
        if (hasReDoSRisk(val)) {
          throw new Error("'$regex' pattern rejected: potential catastrophic backtracking (nested or alternating quantifiers)");
        }
      }
      out[key] = sanitizeFilter(val, depth + 1);
    }
    // $options must only appear alongside $regex and contain valid flags
    if ('$options' in out) {
      if (!('$regex' in out)) {
        throw new Error("'$options' is only allowed alongside '$regex'");
      }
      if (typeof out['$options'] !== 'string' || !VALID_OPTIONS_RE.test(out['$options'] as string)) {
        throw new Error("'$options' must be a string of valid regex flags (i, m, s, x)");
      }
    }
    return out;
  }
  return filter;
}

const ALLOWED_COLLECTIONS = new Set<string>(BRAIN_COLLECTIONS);

/**
 * The body keys `POST /api/brain/spaces/:id/query` accepts, as a VALUE so the route can refuse everything else.
 *
 * The fleet integrator sent `skip`, got a 200, and got page one back — *"it cost us a fabricated number"*. A permissive body is the
 * defect; `skip` was only how they found it. This set lives beside `queryBrain` rather than in the router so that adding
 * a parameter to the query and forgetting to allow it in the body is one edit rather than two.
 */
export const QUERY_BODY_FIELDS: ReadonlySet<string> = new Set([
  'collection', 'filter', 'projection', 'limit', 'skip', 'sort', 'dir', 'maxTimeMS',
  /*
   * The size budget, which this route had none of: `limit` caps ROWS and says nothing about how big one is,
   * so a page of file records had no ceiling on the one read route a fleet actually pages through.
   *
   * `remainderDump` is deliberately NOT here. On `recall` it writes the tail to a file because a ranked answer
   * has no other continuation; `/query` pages for real — `skip` is a database skip over a total order — so
   * `nextSkip` is the whole answer and a file would be a write on a read path nobody needs. Accepting the flag
   * and ignoring it would be the silent-drop defect this body was made strict to prevent.
   */
  ...BUDGET_REQUEST_FIELDS,
]);

/**
 * The other three brain READ routes that take a body, and had the same permissive-body defect `/query` was reported
 * for. The fleet integrator found it on `/query` because that is the one they were paging; `traverse`, `recall` and `find-similar`
 * dropped unknown keys just as silently, and a mistyped `topK` or `minScore` there produces a wrong answer with a 200
 * exactly the same way.
 *
 * Listed as data so `brain-read-bodies-are-strict.test.js` can assert BY SHAPE that every read route on the search
 * router refuses unknown keys, rather than checking the one key that was reported.
 */
export const TRAVERSE_BODY_FIELDS: ReadonlySet<string> = new Set([
  'startId', 'direction', 'edgeLabels', 'maxDepth', 'limit',
  'includeChrono', 'includeMemories', 'includeFiles', 'includeEdges',
]);

export const RECALL_BODY_FIELDS: ReadonlySet<string> = new Set([
  'query', 'topK', 'types', 'minScore', 'filter', 'traverse', 'tags',
  'minPerType', 'maxPerType', 'maxTimeMS',
  // NOT on the destructuring line — these two are read 120 lines further down the handler as
  // `(req.body as {...}).includeFreshWrites` / `.includeContent`. The first version of this set was built from the
  // destructuring alone and refused both, which `recall-fresh-writes.test.js` caught immediately.
  //
  // That is the standing hazard of making a body strict: the allowed set has to be the keys the handler READS, and a
  // handler that reads its body in two places will be described by whichever place you looked at. Grep for `req.body`
  // across the whole handler, not for the destructure.
  'includeFreshWrites', 'includeContent', 'includeDiagnostics', 'includeRecordMeta', 'projection',
  // `maxChars` is the ceiling that carries the defaults, and `maxBytes` now means real UTF-8 bytes — both
  // apply when both are set. See `result-budget.ts`.
  ...BUDGET_REQUEST_FIELDS, 'skip', 'remainderDump',

]);

export const FIND_SIMILAR_BODY_FIELDS: ReadonlySet<string> = new Set([
  'entryId', 'entryType', 'topK', 'minScore', 'targetTypes', 'crossSpace',
  // `traverse` and `includeContent` were on the MCP tool's schema and read by its handler while this route read
  // neither. Found by the gate that compares every declared surface against these sets, not by a report — the
  // strict body turned a silently-ignored parameter into a 400, which is how it surfaced at all.
  'traverse', 'includeContent', 'includeDiagnostics', 'projection',
  ...BUDGET_REQUEST_FIELDS,
  'skip', 'remainderDump',
]);

/**
 * The refusal itself, in one place so all four routes phrase it identically.
 *
 * Returns the offending keys, or `null` when the body is clean. The keys are NAMED: `{"error":"unknown field"}` sends a
 * caller reading their own request looking for which one, and the entire value of refusing is to shorten that search to
 * zero. `unrecognized_keys` matches the shape the spaces routes already return, so a client that already handles that
 * one needs no new branch.
 */
export function unknownBodyFields(
  body: Record<string, unknown>,
  allowed: ReadonlySet<string>,
): { error: string; unrecognized_keys: string[] } | null {
  const unknown = Object.keys(body).filter(k => !allowed.has(k));
  if (unknown.length === 0) return null;
  return {
    error: `Unknown field(s): ${unknown.join(', ')}. Allowed: ${[...allowed].join(', ')}`,
    unrecognized_keys: unknown,
  };
}

/**
 * The caller-facing page cap for `/query`, and the ceiling on a PROXY space's merged window.
 *
 * A proxy page needs `skip + limit` rows from EACH member, so a deep page on a fleet multiplies. The ceiling makes that
 * cost bounded and, more importantly, makes exceeding it an explicit 400 naming the limit — the alternative, which shipped
 * in 2.8.0, was an empty page for any `skip` past the window while `total` reported the true count.
 *
 * A single space is not subject to it: `skip` goes to MongoDB and is correct at any depth.
 */
export const QUERY_PAGE_MAX = 100;
export const PROXY_PAGE_CEILING = 1000;

/**
 * The default result order, as DATA so the same value can go to MongoDB and to the merge comparator.
 *
 * `_id` last is not decoration: it makes the order TOTAL, which is what lets `skip` page without a row drifting between
 * pages and being seen twice or missed. Any caller-supplied sort gets `_id` appended for the same reason — see
 * `toMongoSort` in list-sort.ts, which has always done this for the list endpoints.
 */
export const DEFAULT_QUERY_SORT: Record<string, 1 | -1> = {
  seq: -1, updatedAt: -1, createdAt: -1, _id: -1,
};

/**
 * A comparator for a given sort document, for merging pages across the members of a proxy space.
 *
 * Built FROM the sort that was handed to MongoDB rather than written out separately. The previous version hardcoded the
 * default keys, which was correct only for as long as `/query` had no `sort` parameter: the moment a caller could choose
 * an order, a proxy space would have merged its members by the OLD one and returned a page in an order it did not ask
 * for — a wrong answer with a 200, which is the defect class this route was just fixed for.
 */
export function compareBySort(sort: Record<string, 1 | -1>): (a: unknown, b: unknown) => number {
  const keys = Object.entries(sort);
  return (a, b) => {
    const A = a as Record<string, unknown>;
    const B = b as Record<string, unknown>;
    for (const [key, dir] of keys) {
      const av = A[key];
      const bv = B[key];
      if (av === bv) continue;
      // A record missing the key sorts LAST in either direction: `undefined` must not win a descending sort, or a
      // partially projected document would lead a page it has no claim to.
      if (av === undefined || av === null) return 1;
      if (bv === undefined || bv === null) return -1;
      return (av > bv ? -1 : 1) * (dir === -1 ? 1 : -1);
    }
    return 0;
  };
}

/** The default order, as a comparator. Kept as a named export because most callers want exactly this. */
export const compareQueryOrder = compareBySort(DEFAULT_QUERY_SORT);

/** Structured read-only query (operator whitelist enforced) */
export async function queryBrain(
  spaceId: string,
  collectionName: BrainCollection,
  filter: Record<string, unknown>,
  projection?: Record<string, unknown>,
  limit = 20,
  maxTimeMS = 5000,
  /**
   * Rows to discard before the page. The fleet integrator reported `skip` being accepted at 200 and silently ignored on
   * `POST /query`, which cost them a fabricated number: a paged sweep re-read page one every time and was counted as
   * if it had advanced. A wrong number that looks right is worse than an error, so this parameter is honoured here
   * rather than validated at the door and dropped.
   *
   * Paging is only meaningful because the sort below is TOTAL — `_id` breaks every tie — so no row can drift between
   * pages and be seen twice or missed.
   */
  skip = 0,
  /**
   * Order to apply, defaulting to `DEFAULT_QUERY_SORT`. Passed in rather than chosen here so the caller can hand the
   * SAME value to `compareBySort` when merging a proxy space's members — two expressions of one order is the drift this
   * codebase keeps paying for.
   */
  sort: Record<string, 1 | -1> = DEFAULT_QUERY_SORT,
) {
  if (!ALLOWED_COLLECTIONS.has(collectionName)) {
    throw new Error(`Unknown collection '${collectionName}'`);
  }
  const safeFilter = sanitizeFilter(filter) as Record<string, never>;
  const safeMaxTime = Math.min(maxTimeMS, 10_000);
  const collName = `${spaceId}_${collectionName}`;
  const cursor = col(collName)
    .find(safeFilter)
    .maxTimeMS(safeMaxTime)
    // Deterministic newest-first ordering by default, which keeps recent writes visible under the default limit even
    // when historical datasets grow large. Every order ends in `_id`, so it is total and pageable.
    .sort(sort)
    // Skip BEFORE limit, which is the order the driver applies regardless of call order — spelled out here because
    // the reverse reading (limit the page, then drop rows from it) would silently return short pages.
    .skip(Math.max(Math.floor(skip) || 0, 0))
    // Clamped by the CALLERS (both routes cap the caller-facing page at 100) rather than here, because the proxy merge
    // legitimately needs a larger internal fetch: to return rows [skip, skip+limit) of a MERGED set it must read
    // skip+limit from each member. Clamping at 100 here is what made every page past row 100 come back EMPTY while
    // `total` reported the true count — a wrong answer that looked right, shipped in 2.8.0 and caught by auditing the
    // surface rather than by any test, because the tests tiled 12 and 25 rows entirely inside the window.
    //
    // A floor of 1 so a computed 0 cannot mean "no rows"; the ceiling is the callers' business and is documented there.
    .limit(Math.max(1, Math.floor(limit)))
    // The embedding vector is never returned. This is MERGED with the caller's
    // projection rather than applied as a second `.project()` — a second call
    // replaces the first in the MongoDB driver, which previously discarded the
    // caller's projection entirely.
    .project(mergeEmbeddingExclusion(projection) as Record<string, never>);
  return cursor.toArray();
}

/**
 * How many documents the filter matches, ignoring `limit` and `skip`.
 *
 * The fleet integrator had to fabricate a number because `count` on the response is the PAGE length: a caller sweeping with `skip`
 * cannot tell a short last page from a truncated one without an extra request that returns nothing. This is the number
 * they were computing by hand.
 *
 * Same `sanitizeFilter` and same deadline as the read, so a filter that is safe to query is safe to count and a count
 * cannot outlive the query it belongs to.
 */
export async function countBrain(
  spaceId: string,
  collectionName: BrainCollection,
  filter: Record<string, unknown>,
  maxTimeMS = 5000,
): Promise<number> {
  if (!ALLOWED_COLLECTIONS.has(collectionName)) {
    throw new Error(`Unknown collection '${collectionName}'`);
  }
  return await col(`${spaceId}_${collectionName}`).countDocuments(
    sanitizeFilter(filter) as Record<string, never>,
    { maxTimeMS: Math.min(maxTimeMS, 10_000) },
  );
}

/**
 * Merge the mandatory `embedding` exclusion with a caller-supplied projection.
 *
 * MongoDB forbids mixing inclusion and exclusion (except for `_id`), so we
 * cannot blindly add `embedding: 0` to an inclusion projection:
 *  - No projection → `{ embedding: 0 }`.
 *  - Inclusion projection (`{ field: 1 }`) → embedding is already excluded by
 *    omission; we just strip any explicit `embedding: 1` so the vector can never
 *    be opted back in.
 *  - Exclusion projection (`{ field: 0 }`) → add `embedding: 0`.
 */
export function mergeEmbeddingExclusion(
  projection?: Record<string, unknown>,
): Record<string, 0 | 1> {
  // The reading of the caller's intent moved to `brain/projection.ts` when `recall` gained a projection of
  // its own, so that both doors decide inclusion-versus-exclusion, `_id`'s special case and dotted paths the
  // same way. This function keeps its name and its contract — a Mongo projection with the vector excluded —
  // because it has callers, and because the Mongo form is genuinely this file's business.
  //
  // The rule that is not negotiable and is now enforced in one place: an explicit `embedding: 1` is stripped
  // rather than honoured, so the vector cannot be projected back in from either door.
  return toMongoProjection(normaliseProjection(projection));
}
