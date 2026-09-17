/**
 * Structured read-only query (`queryBrain`) — the operator-whitelisted Mongo query surface.
 *
 * Split out of brain/fact.ts (A17.4). This is the raw-Mongo query path behind REST /query and the
 * MCP `query` tool; distinct from the recall filter DSL in filter.ts. Holds the query builder, the paging
 * rules and the projection guard that never lets `embedding` out — the operator refusals and the ReDoS
 * guard moved to `brain/filter-sanitizer.ts`, which both filter grammars now share.
 */
import { col } from '../db/mongo.js';
import { BUDGET_REQUEST_FIELDS } from './result-budget.js';
import { BRAIN_COLLECTIONS, type BrainCollection } from '../config/types.js';
import { normaliseProjection, toMongoProjection } from './projection.js';
import { sanitizeFilter } from './filter-sanitizer.js';
import { CONVENIENCE_KEYS } from './list-conveniences.js';

/*
 * Re-exported, not re-implemented. Several callers and gates import `sanitizeFilter` from here because this
 * is where it lived; repointing all of them in the same change would bury the move in unrelated diff. The
 * module is the definition, this is an alias, and there is one implementation either way.
 */
export { sanitizeFilter };

/*
 * THE SANITIZER MOVED to `brain/filter-sanitizer.ts`, and this note is here because it was the reason to
 * open this file.
 *
 * It was the operator refusals, the ReDoS guard and the depth cap, living beside the query builder that
 * happened to be their first caller — while the key-shape guard for the OTHER filter grammar lived in
 * `brain/filter.ts`. One rule, two files, and each grammar protected by a different subset of it.
 *
 * Owner, 2026-09-17: *"add the sanitizer and make it a real module."* It is also where value coercion
 * will go — casting a string `_id` to an `ObjectId`, for one — because the walk is the only place that
 * sees every value in context.
 */

const ALLOWED_COLLECTIONS = new Set<string>(BRAIN_COLLECTIONS);

/**
 * The body keys `POST /api/brain/spaces/:id/query` accepts, as a VALUE so the route can refuse everything else.
 *
 * The fleet integrator sent `skip`, got a 200, and got page one back — *"it cost us a fabricated number"*. A permissive body is the
 * defect; `skip` was only how they found it. This set lives beside `queryBrain` rather than in the router so that adding
 * a parameter to the query and forgetting to allow it in the body is one edit rather than two.
 */
export const QUERY_BODY_FIELDS: ReadonlySet<string> = new Set([
  // `space` is a BODY field since 5.0, and omitting it reads across every space the token may read.
  // The fan-out is not new — this route already paged across the members of a proxy space.
  'space',
  'collection', 'filter', 'projection', 'limit', 'skip', 'sort', 'dir', 'maxTimeMS',
  /*
   * The NAME conveniences, which are a JOIN rather than part of the predicate: the caller gives a name
   * and the server resolves it to ids, per member space, before filtering. A client cannot express
   * them in `filter` — ids belong to the space that owns them — which is why they are arguments.
   *
   * Added here and to the tool in one change, because a parameter on one door and not the other is the
   * defect this repo pays most for.
   */
  'entityName', 'fromName', 'toName',
  /*
   * The five list CONVENIENCES, spread from the module rather than spelled here — one list, so a
   * sixth name cannot reach the tool and miss this set. The nine per-collection list routes have
   * always taken them and `filter` did not, which is a capability the browser had and an agent did
   * not. See `brain/list-conveniences.ts` for what each means and what it refuses.
   */
  ...CONVENIENCE_KEYS,
  /*
   * The diagnostics projection the four per-collection list routes honour. It was missing here, so a
   * caller asking this door for diagnostics got a 400 for a parameter its twin accepts — and adding it
   * without wiring the projection would have been the worse half: a 200 with the flag doing nothing.
   */
  'includeDiagnostics',
  /*
   * Present a chrono entry's DERIVED status rather than the stored one. Opt-in and default OFF, so this
   * door answers exactly as it did — the list route derives unconditionally, and that difference used to
   * be settled by WHICH DOOR a caller picked rather than by anything they could ask for.
   */
  'deriveStatus',
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

/*
 * `RECALL_BODY_FIELDS` WAS HERE, AND IT WAS DELETED RATHER THAN LEFT UNUSED.
 *
 * `POST /api/brain/recall` keeps no key list any more: it hands its whole body to `callTool`, which
 * validates against the `recall` tool's published `inputSchema` and its `additionalProperties: false`.
 * That is stricter than this set ever was, and it cannot fall behind a parameter added to the tool,
 * because it IS the tool's parameters.
 *
 * The note is here because the list looked harmless once it stopped being read. It gated no request and
 * still read like the contract: `client-bodies-match-server.test.js` was comparing the Angular client
 * against it, so the client could have drifted from what the server enforces while a green gate said the
 * two agreed. A list nothing consults is not dead weight, it is a second answer nobody is checking.
 */
export const FIND_SIMILAR_BODY_FIELDS: ReadonlySet<string> = new Set([
  // `space` is a BODY field since 5.0. It has a NARROWER job here than on recall: it says where the SEED
  // ENTRY lives, not where to search. Omit it and the entry is located across every readable space;
  // `crossSpace` is the separate axis that widens the SEARCH, which is why both exist.
  'space',
  'entryId', 'entryType', 'topK', 'minScore', 'targetTypes', 'crossSpace',
  // `traverse` and `includeFileContent` were on the MCP tool's schema and read by its handler while this route read
  // neither. Found by the gate that compares every declared surface against these sets, not by a report — the
  // strict body turned a silently-ignored parameter into a 400, which is how it surfaced at all.
  'traverse', 'includeFileContent', 'includeDiagnostics', 'projection',
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
 * How many rows `filter` returns when the caller does not say — A DEFAULT, NOT A CAP.
 *
 * Owner, 2026-09-17: *"cap should be a parameter and default to 200"*. It WAS a hard clamp of 100, applied
 * silently: a caller asking for 200 got 100 back, with `total` and `truncated` making it read as a correct
 * short page. That mattered because `filter` is replacing the nine per-collection list routes, which cap at
 * 200 (`edges`, `files`) and 500 (`facts`, `entities`, `chrono`) — so the replacement returned LESS than
 * every door it replaces, and the three it replaces did not agree with each other either.
 *
 * **What actually bounds an answer, now that the row count does not.** The clamp was never the protection:
 *   - the BYTE budget (`maxChars` / `maxBytes`) trims the page and says so, with `nextSkip` to continue;
 *   - `maxTimeMS`, hard-capped at 10 000, bounds the query's duration whatever `limit` says;
 *   - on a PROXY space `skip + limit` must stay under `PROXY_PAGE_CEILING`, which is an explicit 400 naming
 *     the limit rather than a silent trim.
 *
 * So an absurd `limit` is refused loudly on a proxy, bounded in time on a single space, and trimmed with
 * disclosure either way. A silent clamp added nothing those three do not do, and hid the one thing they
 * report.
 */
export const DEFAULT_QUERY_LIMIT = 200;

/**
 * The ceiling on a PROXY space's merged window.
 *
 * A proxy page needs `skip + limit` rows from EACH member, so a deep page on a fleet multiplies. The ceiling makes that
 * cost bounded and, more importantly, makes exceeding it an explicit 400 naming the limit — the alternative, which shipped
 * in 2.8.0, was an empty page for any `skip` past the window while `total` reported the true count.
 *
 * A single space is not subject to it: `skip` goes to MongoDB and is correct at any depth.
 */
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
