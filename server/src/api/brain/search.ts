/**
 * Read/analytics routes: stats, traverse, query, recall, find-similar, and reindex.
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { BRAIN_COLLECTIONS } from '../../config/types.js';
import { requireSpaceAuth, requireBodyScopedSpace, denyReadOnly } from '../../auth/middleware.js';
import { spacesWhereTokenMay } from '../../auth/reachable-spaces.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { summariseActivity } from '../../metrics/space-activity-store.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { parseSortParam, toMongoSort, SORTABLE_FIELDS } from '../../brain/list-sort.js';
import { pageAcrossMembers } from '../../spaces/page-across-members.js';
import { NotFoundError } from '../../util/errors.js';
import { countFacts } from '../../brain/fact.js';
import { getEmbedJobCounts } from '../../brain/embed-queue.js';
import {
  queryBrain, countBrain, QUERY_BODY_FIELDS, TRAVERSE_BODY_FIELDS, RECALL_BODY_FIELDS, FIND_SIMILAR_BODY_FIELDS,
  unknownBodyFields, compareBySort, DEFAULT_QUERY_SORT, QUERY_PAGE_MAX, PROXY_PAGE_CEILING,
} from '../../brain/query.js';
import { findSimilar, recall, type RecallKnowledgeType, type RecallResult } from '../../brain/recall.js';
import { type FilterExpression } from '../../brain/filter.js';
import { resolveEntityIdsByName } from '../../brain/entities.js';
import { attachedToEntityNamed } from '../../brain/entity-name-scope.js';
import { resolveRecallFilter } from '../../brain/recall-filter.js';
import { traverseGraph } from '../../brain/edges.js';
import { MAX_RECALL_TRAVERSE } from '../../brain/recall-seed-traversal.js';
import { buildGraphWithSpill, spillResultSet, countGraphNodes } from '../../brain/graph-spill.js';
import { parseTraverseOption, echoTraverse } from '../../brain/traverse-option.js';
import { embed } from '../../brain/embedding.js';
import { getConfig } from '../../config/loader.js';
import { col, asFilter } from '../../db/mongo.js';
import { needsReindex } from '../../spaces/_shared.js';
import { planReindex, startReindex } from '../../brain/reindex.js';
import { log } from '../../util/log.js';
import { memberSpacesForRequestAcross, memberSpacesForRequest } from '../../spaces/proxy-scoped.js';
import type { FactDoc, EntityDoc, EdgeDoc, ChronoEntry, FileMetaDoc } from '../../config/types.js';
import { RECORD_TYPES } from '../../config/types.js';
import { reindexInProgress } from '../../metrics/registry.js';
import { UUID_V4_RE } from './_shared.js';
import {
  rankOf, byRankThenId, mergeRecallResults, withoutDiagnostics, RECALL_ENVELOPE_KEYS,
} from '../../brain/recall-shape.js';
import { mapGraphNodes, graphNodeRecord } from '../../brain/recall-graph.js';
import { stripRecordMeta } from '../../brain/recall-record-meta.js';
import { applyProjection, normaliseProjection, type NormalisedProjection } from '../../brain/projection.js';
import { resolveBudget, resolvePaging, budgetedEnvelope, applyBudget, budgetFields, type BudgetRequest } from '../../brain/result-budget.js';
import { sendReadFailure, statesRetryability } from './_read-failure.js';
import { spaceCollection } from '../../db/space-collection.js';

/**
 * The most graph nodes one response may expand to, however large `topK` is.
 *
 * The formula `topK * (traverse + 1) * 4` is what shapes a normal answer, and it is shared with recall's
 * own traverse so the two cannot drift. This constant is the absolute bound beside it, needed since
 * `P-34` removed the ceiling on `topK`: the byte budget stops an oversized walk being RETURNED, and this
 * stops it being WALKED.
 */
const MAX_GRAPH_NODES = 5000;

export const searchRouter = Router();

/** Guard so only one reindex job runs at a time per process. */
let reindexJobRunning = false;


// GET /api/brain/spaces/:spaceId/stats
searchRouter.get('/spaces/:spaceId/stats', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const memberIds = memberSpacesForRequest(req, spaceId);
  const counts = await Promise.all(memberIds.map(async mid => ({
    facts: await countFacts(mid),
    entities: await col(spaceCollection(mid, 'entities')).countDocuments(),
    edges: await col(spaceCollection(mid, 'edges')).countDocuments(),
    chrono: await col(spaceCollection(mid, 'chrono')).countDocuments(),
    // Exclude chunk records (parentFileId set) — count only top-level file records
    files: await col(spaceCollection(mid, 'files')).countDocuments({ parentFileId: { $exists: false } }),
    // How much of the above is not searchable YET. Writes no longer wait for the embedding model, so a
    // record can exist and be absent from recall for a moment — and a caller asking "is this space ready"
    // could not tell that from "the model is down and nothing has embedded for an hour". Same shape as the
    // defect the queue fixed: a state the system knew about and never reported.
    embedQueue: await getEmbedJobCounts(mid),
  })));
  const facts = counts.reduce((s, c) => s + c.facts, 0);
  const entities = counts.reduce((s, c) => s + c.entities, 0);
  const edges = counts.reduce((s, c) => s + c.edges, 0);
  const chrono = counts.reduce((s, c) => s + c.chrono, 0);
  const files = counts.reduce((s, c) => s + c.files, 0);
  // Summed across members like everything else here, so a proxy space reports its members' backlog rather
  // than a zero that would read as "nothing pending".
  const embedQueue = {
    pending: counts.reduce((s, c) => s + c.embedQueue.pending, 0),
    processing: counts.reduce((s, c) => s + c.embedQueue.processing, 0),
    failed: counts.reduce((s, c) => s + c.embedQueue.failed, 0),
  };
  res.json({ spaceId, facts, entities, edges, chrono, files, embedQueue });
});


/**
 * GET /api/brain/spaces/:spaceId/activity — is this space earning its keep?
 *
 * Demand and payoff together, because either alone misleads: a space asked five hundred times that answers
 * nothing is not popular, and a space with a perfect answer rate that nobody queries is not useful either.
 *
 * Scoped to the requested space in the aggregation itself — a space-scoped token must not learn how heavily
 * every other space is used. The cross-space comparison lives on the admin route, behind admin auth.
 *
 * A proxy space reports its MEMBERS' activity summed, matching `stats` above: the calls arrive addressed to the
 * proxy, but the useful answer is what its members are doing.
 */
searchRouter.get('/spaces/:spaceId/activity', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  // Clamped rather than rejected: this is a dashboard window, and an out-of-range value has an obviously
  // correct interpretation. 90 days is the bucket retention — asking for more would silently return less.
  const raw = Number(req.query['hours'] ?? 24);
  const hours = Number.isFinite(raw) ? Math.max(1, Math.min(90 * 24, Math.floor(raw))) : 24;

  const memberIds = memberSpacesForRequest(req, spaceId);
  const rows = (await Promise.all(memberIds.map(mid => summariseActivity(hours, Date.now(), mid)))).flat();
  res.json({ spaceId, hours, spaces: rows });
});


/**
 * Drop the passage body from file chunks when the caller asked not to receive it.
 *
 * A file result's `content` is the largest field a recall returns, and it is returned `topK` times. Omitting
 * it leaves everything a caller needs to decide WHICH passage to fetch — path, heading, chunk index, tags —
 * which is the two-phase flow MCP callers have had all along.
 *
 * Only `content`, and only on file results: the flag is about the passage body, not about thinning a result.
 * Copies rather than mutating, because `seeds` is also handed to the traverse builder and to the audit
 * outcome — deleting a field in place would change what those saw.
 */
/**
 * Apply a caller's projection to flat recall results, keeping the envelope.
 *
 * `RECALL_ENVELOPE_KEYS` is why this is not just `applyProjection`: a REST result flattens the record and the
 * ranking envelope into one object, so projecting `{name: 1}` without this would drop the `score` the search
 * was for. On MCP the same parameter reaches only `record`, which is the same rule expressed against a shape
 * that already separates them.
 */
function projectResults(results: RecallResult[], norm: NormalisedProjection | undefined): unknown[] {
  if (!norm) return results;
  return results.map(r => {
    const src = r as unknown as Record<string, unknown>;
    const out = applyProjection(src, norm);
    for (const k of RECALL_ENVELOPE_KEYS) if (k in src) out[k] = src[k];
    return out;
  });
}

/** Read and validate `projection` from a recall-shaped body. Shared by both routes so they cannot diverge. */
function projectionFromBody(body: unknown): { ok: true; norm: NormalisedProjection | undefined } | { ok: false; error: string } {
  const raw = (body as { projection?: unknown } | null | undefined)?.projection;
  if (raw === undefined || raw === null) return { ok: true, norm: undefined };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, error: '`projection` must be a plain object mapping field paths to 1 or 0' };
  }
  return { ok: true, norm: normaliseProjection(raw as Record<string, unknown>) };
}

function stripContentIfAsked(results: RecallResult[], includeContent: boolean): RecallResult[] {
  if (includeContent) return results;
  return results.map(r => {
    if (r.type !== 'file' || r.content === undefined) return r;
    const { content: _dropped, ...rest } = r;
    return rest as RecallResult;
  });
}

// POST /api/brain/spaces/:spaceId/traverse — graph traversal (BFS)
searchRouter.post('/spaces/:spaceId/traverse', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  // Same refusal as /query, for the same reason: a mistyped `maxDepth` here returns a shallower graph with a 200.
  const badTraverse = unknownBodyFields((req.body ?? {}) as Record<string, unknown>, TRAVERSE_BODY_FIELDS);
  if (badTraverse) { res.status(400).json(badTraverse); return; }
  const { startId, direction, edgeLabels, maxDepth, limit } = req.body ?? {};
  if (!startId || typeof startId !== 'string') {
    res.status(400).json({ error: '`startId` string required' });
    return;
  }
  const validDirections = new Set(['outbound', 'inbound', 'both']);
  const effectiveDirection: 'outbound' | 'inbound' | 'both' =
    typeof direction === 'string' && validDirections.has(direction)
      ? (direction as 'outbound' | 'inbound' | 'both')
      : 'outbound';
  const effectiveEdgeLabels: string[] | undefined =
    Array.isArray(edgeLabels) && edgeLabels.every((l: unknown) => typeof l === 'string')
      ? edgeLabels
      : undefined;
  if (edgeLabels !== undefined && !Array.isArray(edgeLabels)) {
    res.status(400).json({ error: '`edgeLabels` must be an array of strings' });
    return;
  }
  const rawDepth = typeof maxDepth === 'number' ? maxDepth : 3;
  const effectiveDepth = Math.min(Math.max(1, rawDepth), 10);
  const rawLimit = typeof limit === 'number' ? limit : 100;
  const effectiveLimit = Math.min(Math.max(1, rawLimit), 1000);

  // What the answer CONTAINS, as three flags rather than one. Chrono entries are reachable by default; a
  // client that assumed every node is an entity opts out. Facts are opt-IN — they are usually the most
  // numerous record type and every node counts against `limit`, so on by default they would truncate away the
  // entities the caller traversed for. Edges are always FOLLOWED (they are the graph); the flag only decides
  // whether the edge list rides along in the response.
  //
  // Each is rejected rather than coerced: `includeChrono: "false"` is a truthy string, and a flag that
  // silently turns itself on is worse than one that errors.
  const inclusions = { includeChrono: true, includeMemories: false, includeFiles: false, includeEdges: true };
  for (const flag of Object.keys(inclusions) as (keyof typeof inclusions)[]) {
    const raw = (req.body as Record<string, unknown>)[flag];
    if (raw === undefined) continue;
    if (typeof raw !== 'boolean') {
      res.status(400).json({ error: `\`${flag}\` must be a boolean` });
      return;
    }
    inclusions[flag] = raw;
  }

  const memberIds = memberSpacesForRequest(req, spaceId);
  const result = await traverseGraph(memberIds, startId.trim(), effectiveDirection, effectiveEdgeLabels, effectiveDepth, effectiveLimit,
    inclusions.includeChrono, inclusions.includeMemories, inclusions.includeFiles, inclusions.includeEdges);
  res.json(result);
});


// POST /api/brain/spaces/:spaceId/query — structured query with filter/projection
//
// ## Two defects, one shape
//
// The fleet integrator, 2026-08-12T1410Z: `skip` was accepted at 200 and silently ignored, and *"it cost us a fabricated number"* —
// a paged sweep re-read page one every time and was counted as if it had advanced. Their report names `skip`; the defect
// is the PERMISSIVE BODY. Honouring one key would have left every other unknown key doing the same thing.
//
// So both halves are here: the body is strict, and `skip` is real. MCP's `query` tool already declared
// `additionalProperties: false` and so already refused unknown keys — REST was the weaker of the two surfaces for the
// same rule, which is this repo's most repeated defect class.
/*
 * POST /api/brain/filter — structured predicate read, across one space or every space you can read.
 *
 * The space moved out of the path at 5.0 for the same reason as `recall`: a path segment cannot be omitted,
 * so the route had no way to express "everything I can reach". The fan-out itself is not new — this already
 * paged across the members of a proxy space, and an omitted space is the same walk over a different list.
 */
searchRouter.post('/filter', globalRateLimit, requireBodyScopedSpace('knowledge', 'read'), statesRetryability, async (req, res) => {
  const authorised = req.authorisedSpaces ?? [];
  const namedSpace = req.resolvedSpaceId;
  const spaceId = namedSpace ?? authorised[0] ?? '';
  // Resolved before anything is read, so a bad `maxBytes` is a 400 rather than a query that runs first.
  const budget = resolveBudget(req.body as BudgetRequest);
  if (!budget.ok) { res.status(400).json({ error: budget.error }); return; }

  const body = (req.body ?? {}) as Record<string, unknown>;
  const bad = unknownBodyFields(body, QUERY_BODY_FIELDS);
  if (bad) { res.status(400).json(bad); return; }

  const { collection, filter, projection, limit, maxTimeMS, skip } = body;

  /*
   * The NAME conveniences, same three the per-collection list routes take and the tool declares.
   *
   * They are here because a parameter on one door and not the other is the defect this repo pays most
   * for — a caller reads the tool schema, switches door, and gets a 400 for a documented argument. The
   * gate that caught it names that outcome exactly: *"a tool argument its route drops is a 200 with the
   * value silently missing"*, and it is a 400 here only because this route refuses unknown fields.
   */
  const nameArg = (k: string): string | undefined =>
    typeof body[k] === 'string' && (body[k] as string).trim() ? (body[k] as string) : undefined;
  const entityName = nameArg('entityName');
  const fromName = nameArg('fromName');
  const toName = nameArg('toName');
  const validCollections = BRAIN_COLLECTIONS;
  if (!validCollections.includes(collection as typeof validCollections[number])) {
    res.status(400).json({ error: `collection must be one of: ${validCollections.join(', ')}` });
    return;
  }
  /*
   * Refused on a collection they cannot mean, never ignored — word for word what the tool answers, because
   * a caller comparing the two doors should not have to work out that two wordings mean the same thing.
   */
  const ENTITY_LINKED: readonly string[] = ['facts', 'chrono'];
  if (entityName && !ENTITY_LINKED.includes(collection as string)) {
    res.status(400).json({ error: `entityName applies to ${ENTITY_LINKED.join(' and ')} only, not `
      + `'${String(collection)}'. For entities themselves use filter: { name: ... }; for edges use `
      + 'fromName or toName.' });
    return;
  }
  if ((fromName || toName) && collection !== 'edges') {
    res.status(400).json({ error: `${fromName ? 'fromName' : 'toName'} applies to edges only, not `
      + `'${String(collection)}'. For facts and chrono use entityName.` });
    return;
  }
  const safeFilter: Record<string, unknown> =
    filter != null && typeof filter === 'object' && !Array.isArray(filter)
      ? (filter as Record<string, unknown>)
      : {};
  const safeProjection: Record<string, unknown> | undefined =
    projection != null && typeof projection === 'object' && !Array.isArray(projection)
      ? (projection as Record<string, unknown>)
      : undefined;
  // The caller-facing page cap. It used to live inside `queryBrain`, where it also bounded the proxy merge's internal
  // fetch and silently truncated deep pages to nothing.
  const safeLimit = Math.min(typeof limit === 'number' ? limit : 20, QUERY_PAGE_MAX);
  const safeMaxTimeMS = typeof maxTimeMS === 'number' ? maxTimeMS : 5000;

  // A non-integer or negative `skip` is refused rather than floored to 0. Silently reading it as "start from the
  // beginning" is the same failure they reported: a page that is not the page asked for, returned with a 200.
  if (skip !== undefined && (typeof skip !== 'number' || !Number.isInteger(skip) || skip < 0)) {
    res.status(400).json({ error: 'skip must be a non-negative integer' });
    return;
  }
  const safeSkip = typeof skip === 'number' ? skip : 0;

  // Same `sort`/`dir` the brain LIST endpoints take, with the same allowlist and the same 400 text — a caller who knows
  // one knows the other, and inventing an object form here would have been a second way to say one thing.
  // `toMongoSort` appends `_id`, which is what keeps a caller-chosen order total and therefore pageable.
  const sortParse = parseSortParam(body['sort'], body['dir'], SORTABLE_FIELDS[collection as keyof typeof SORTABLE_FIELDS]);
  if ('error' in sortParse) { res.status(400).json({ error: sortParse.error }); return; }
  const order = sortParse.sort ? toMongoSort(sortParse.sort) : DEFAULT_QUERY_SORT;

  /*
   * Names resolved PER MEMBER, through the shared predicate.
   *
   * An id belongs to the space that owns it, so resolving against one member and querying another matches
   * nothing while looking correct. `attachedToEntityNamed` also covers BOTH link shapes — the legacy array
   * and the link records — which a hand-written `entityIds: { $in: ids }` here would not (`B-10`).
   */
  const withNameScope = async (mid: string): Promise<Record<string, unknown>> => {
    if (!entityName && !fromName && !toName) return safeFilter;
    const per: Record<string, unknown> = { ...safeFilter };
    if (entityName) {
      Object.assign(per, await attachedToEntityNamed(mid, collection === 'chrono' ? 'chrono' : 'fact', entityName));
    }
    if (fromName) per['from'] = { $in: await resolveEntityIdsByName(mid, fromName) };
    if (toName) per['to'] = { $in: await resolveEntityIdsByName(mid, toName) };
    return per;
  };

  try {
    // One paging rule, shared with the embed-job listing. It used to be inline here, and being inline is how it shipped
    // a window capped at 100 that sliced deep pages to nothing — see `spaces/page-across-members.ts`.
    // A NAMED space may be a proxy and resolves to its members; an omitted one is already the list the
    // guard authorised — every space where this token actually holds `knowledge: read`, which is a stricter
    // question than reach.
    const members = namedSpace ? memberSpacesForRequest(req, namedSpace) : memberSpacesForRequestAcross(req, authorised);
    const page = await pageAcrossMembers({
      members,
      limit: safeLimit,
      skip: safeSkip,
      ceiling: PROXY_PAGE_CEILING,
      compare: compareBySort(order),
      /** The caller's predicate, plus whatever the names resolve to IN THIS MEMBER. */
      readMember: async (mid, lim, sk) => queryBrain(
        mid, collection as typeof validCollections[number],
        await withNameScope(mid), safeProjection, lim, safeMaxTimeMS, sk, order,
      ),
    });
    if (!page.ok) { res.status(400).json({ error: page.error }); return; }
    const merged = page.rows;

    let total = 0;
    for (const mid of members) {
      total += await countBrain(mid, collection as typeof validCollections[number], safeFilter, safeMaxTimeMS);
    }

    /*
     * THE SIZE CEILING, which this route did not have.
     *
     * `limit` caps ROWS and says nothing about how big one is: a hundred file records or a hundred entities
     * with long descriptions had no bound at all, on the read route a fleet actually pages through.
     *
     * The offset is passed so `nextSkip` is ABSOLUTE. `/query` already has a real `skip`, so a continuation
     * computed from the page alone would send a caller back to the start of page two for ever — a paging loop
     * that never advances, which is the exact defect this route was reported for in the first place.
     */
    const budgeted = applyBudget(merged, { chars: budget.chars, bytes: budget.bytes });

    /*
     * `count` MEANS DIFFERENT THINGS ON THESE TWO ROUTES, and that collision is worth naming.
     *
     * On the recall paths `count` is the TOTAL number of matches, so `budgetFields` reports it as such. On
     * `/query` it has always been the PAGE — documented that way, with `total` beside it for the whole match.
     * Spreading the accounting fields wholesale therefore overwrote a documented meaning with a different one:
     * a caller asking for `limit: 3` got `count: 12`, which is exactly the fabricated-number defect this route
     * was reported for.
     *
     * Stripped by NAME rather than fixed by spread order. Ordering works and is one careless reorder away from
     * silently coming back.
     */
    const { count: _budgetTotal, ...budgetAccounting } = budgetFields(budgeted, total, { chars: budget.chars, bytes: budget.bytes }, safeSkip);

    res.json({
      results: budgeted.returned, collection,
      /*
       * `count` is this page and `total` is the whole match — both, because renaming `count` would break every
       * caller that already reads it and dropping it would break them silently.
       *
       * `count` is the number RETURNED, so it still equals `results.length` when the budget bit. A caller
       * reading either one is right; a caller who read `count` and then iterated `results` would otherwise be
       * told a number that did not match what they were holding.
       */
      count: budgeted.returned.length, total, limit: safeLimit, skip: safeSkip,
      ...budgetAccounting,
      ...(sortParse.sort ? { sort: sortParse.sort.field, dir: sortParse.sort.dir === 1 ? 'asc' : 'desc' } : {}),
    });
  } catch (err: unknown) {
    // A store failure is not a client error. See `brain/store-failure.ts` — this used to answer 400 for every
    // throw, which told fourteen personas not to retry a condition that cleared in seconds.
    sendReadFailure(res, err);
  }
});


/*
 * POST /api/brain/recall — meaning-ranked search, across one space or across every space you can read.
 *
 * ## The space is a parameter, not a path segment, and that is the whole reason this route moved
 *
 * Owner ruling, 2026-09-15: *"filter should also be able to read cross space"* and *"in that case the route
 * has to change and space moved to parameter."* A path segment cannot be omitted, so `/spaces/:spaceId/recall`
 * could never express "search everything I can reach" — MCP's `recall` has taken an optional space since it
 * shipped, and REST callers had to point at a proxy space or make one call per space and merge by hand.
 *
 * ## Authorisation happens ONCE, in the guard, and this handler acts on what it returned
 *
 * `requireBodyScopedSpace` resolves `req.body.space` and hands back `req.authorisedSpaces`. This handler
 * never reads `req.body.space` again: a second reading is the defect the guard exists to prevent, because
 * the two readings are spelled identically and nothing in a diff shows that the value acted on is not the
 * value that was checked.
 */
searchRouter.post('/recall', globalRateLimit, requireBodyScopedSpace('knowledge', 'read'), statesRetryability, async (req, res) => {
  // Resolved and authorised by the guard. A named space narrows to itself; an omitted one means every space
  // this token may read, which is the case a path segment could not express.
  const authorised = req.authorisedSpaces ?? [];
  const namedSpace = req.resolvedSpaceId;
  const spaceId = namedSpace ?? authorised[0] ?? '';
  // A mistyped `minScore` on recall silently returns the unfiltered ranking, which reads as a working search.
  const badRecall = unknownBodyFields((req.body ?? {}) as Record<string, unknown>, RECALL_BODY_FIELDS);
  if (badRecall) { res.status(400).json(badRecall); return; }
  const { query, topK, types, minScore, filter, traverse, tags, minPerType, maxPerType, maxTimeMS } = req.body ?? {};
  if (!query || typeof query !== 'string' || !query.trim()) {
    res.status(400).json({ error: 'query must be a non-empty string' });
    return;
  }
  /*
   * NO CEILING ON `topK`, AT EITHER DOOR — owner's ruling on `P-34`, 2026-09-04: *"why do we need a cap?
   * Only thing that matters is we only get full records and it warns when anything is truncated … And yes
   * same treatment at both doors."*
   *
   * Both of those hold and were checked rather than assumed: `applyBudget` emits whole records only, and
   * `truncated` is on EVERY response whether it bit or not, with `nextSkip` when it did. So the answer was
   * never what a cap protected.
   *
   * This door clamped silently to 100 while MCP declared no maximum, so `topK: 500` returned 100 through
   * one door and 500 through the other. A clamp is the worst of the three options: the caller is told
   * nothing and believes they have the top 500.
   *
   * What a cap DID bound is WORK, and two internal figures scale off `topK` — the per-type over-fetch and
   * the traversal node cap. Both now carry their own absolute ceiling, which is where such a bound
   * belongs: an enormous `topK` costs a bounded amount of work instead of being refused or quietly
   * rewritten.
   */
  const safeTopK = typeof topK === 'number' ? Math.max(topK, 1) : 10;
  const safeTypes = Array.isArray(types) ? types.filter((t: unknown): t is RecallKnowledgeType => typeof t === 'string') : undefined;
  const safeMinScore = typeof minScore === 'number' ? minScore : undefined;

  // `tags` and `minPerType` are supported by recall() but were previously hardcoded to
  // undefined here, so they were reachable only via MCP / the internal function.
  let safeTags: string[] | undefined;
  if (tags != null) {
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) {
      res.status(400).json({ error: 'tags must be an array of strings' });
      return;
    }
    safeTags = (tags as string[]).filter(t => t.trim().length > 0);
    if (safeTags.length === 0) safeTags = undefined;
  }

  // Per-type minimums: guarantee at least N hits of a given knowledge type. Each value
  // is clamped to [0, topK] — asking for more of a type than the total result size is
  // meaningless, and an unbounded value would widen the underlying per-type searches.
  let safeMinPerType: Partial<Record<RecallKnowledgeType, number>> | undefined;
  if (minPerType != null) {
    if (typeof minPerType !== 'object' || Array.isArray(minPerType)) {
      res.status(400).json({ error: 'minPerType must be an object mapping knowledge type -> minimum count' });
      return;
    }
    const acc: Partial<Record<RecallKnowledgeType, number>> = {};
    for (const [key, raw] of Object.entries(minPerType as Record<string, unknown>)) {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 0) {
        res.status(400).json({ error: `minPerType.${key} must be a non-negative integer` });
        return;
      }
      acc[key as RecallKnowledgeType] = Math.min(raw, safeTopK);
    }
    if (Object.keys(acc).length > 0) safeMinPerType = acc;
  }

  // Per-type MAXIMUMS: the ceiling to the floor above (their top ask, A-L6-1). One long file chunk should
  // not be able to crowd out four one-line principles that would have answered the query more cheaply.
  //
  // A ceiling of 0 is REFUSED rather than accepted as "none of this type". It would work, and it would be a
  // second confusing way to spell `types` — with the difference that `types` says so in the parameter name.
  let safeMaxPerType: Partial<Record<RecallKnowledgeType, number>> | undefined;
  if (maxPerType != null) {
    if (typeof maxPerType !== 'object' || Array.isArray(maxPerType)) {
      res.status(400).json({ error: 'maxPerType must be an object mapping knowledge type -> maximum count' });
      return;
    }
    const acc: Partial<Record<RecallKnowledgeType, number>> = {};
    for (const [key, raw] of Object.entries(maxPerType as Record<string, unknown>)) {
      if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
        res.status(400).json({ error: `maxPerType.${key} must be an integer of at least 1 (use \`types\` to exclude a knowledge type entirely)` });
        return;
      }
      acc[key as RecallKnowledgeType] = Math.min(raw, safeTopK);
    }
    if (Object.keys(acc).length > 0) safeMaxPerType = acc;
  }

  // Per-call deadline. It can only LOWER `RECALL_BUDGET_MS`, never raise it — letting a request body extend
  // the operator's ceiling is a denial-of-service lever. Clamped rather than refused, because a caller asking
  // for 60 s on a 25 s instance wants "as long as you allow", and an error there teaches nothing.
  let safeMaxTimeMS: number | undefined;
  if (maxTimeMS != null) {
    if (typeof maxTimeMS !== 'number' || !Number.isInteger(maxTimeMS) || maxTimeMS < 1) {
      res.status(400).json({ error: '`maxTimeMS` must be a positive integer (milliseconds)' });
      return;
    }
    safeMaxTimeMS = maxTimeMS;
  }

  // A floor above its own ceiling is REFUSED, not silently resolved.
  //
  // Floor-wins and ceiling-wins are both defensible, which is exactly why the caller has to say which they
  // meant. Picking one here would answer 200 to a request that cannot be satisfied as written — the failure
  // shape this release spent four fixes on, in config form.
  if (safeMinPerType && safeMaxPerType) {
    for (const [t, floor] of Object.entries(safeMinPerType) as [RecallKnowledgeType, number][]) {
      const ceiling = safeMaxPerType[t];
      if (ceiling !== undefined && floor > ceiling) {
        res.status(400).json({
          error: `minPerType.${t} (${floor}) is greater than maxPerType.${t} (${ceiling}) — the two contradict, so neither can be applied`,
        });
        return;
      }
    }
  }

  // Graph-traversal expansion: a depth, or a whole traversal minus its start node — the results ARE the start
  // nodes. `traverse: 2` still means what it always meant; `{ depth, edgeLabels, direction }` narrows it the way
  // the standalone `/traverse` route always could and this one could not. See `brain/traverse-option.ts`.
  //
  // Rejected rather than clamped or coerced, in every direction: a depth past the cap, a string where a number
  // belongs, an unknown key inside the object. Each of those silently downgraded returns a SHALLOWER OR WIDER
  // GRAPH WITH A 200, which is the defect shape `/traverse` and `/query` already refuse unknown fields for.
  const parsedTraverse = parseTraverseOption(traverse, MAX_RECALL_TRAVERSE);
  if (!parsedTraverse.ok) {
    res.status(400).json({ error: parsedTraverse.error });
    return;
  }
  const traverseOpt = parsedTraverse.value;
  const safeTraverse = traverseOpt.depth;

  // EITHER grammar. The operator-object form is passed through untouched so it keeps the native pre-filter path; a raw
  // MongoDB filter is validated with the same parser `query` uses and goes down the exhaustive path.
  // One channel: `recall` takes either grammar in the same parameter, so there is nothing here to keep in step.
  const resolved = resolveRecallFilter(filter);
  if (!resolved.ok) {
    res.status(400).json({ error: resolved.error });
    return;
  }
  const safeFilter = resolved.kind === 'expression' ? resolved.expression
    : resolved.kind === 'mongo' ? resolved.filter
      : undefined;

  try {
    // A NAMED space may be a proxy, so it resolves to its members and is narrowed to this request's reach.
    // An omitted one is already that list: the guard filtered every reachable space to the ones where this
    // token actually holds `knowledge: read`, which is a stricter question than reach and the reason the
    // guard returns spaces rather than a boolean.
    const memberIds = namedSpace ? memberSpacesForRequest(req, namedSpace) : memberSpacesForRequestAcross(req, authorised);
    // One collector across every member, deduped by `recall` itself, so a proxy space reports "the answer is
    // partial" once rather than once per member.
    // Opt-in scan of the newest records, for the case the index has not caught up yet. Rejected rather
    // than coerced: `includeFreshWrites: "false"` is truthy, and an opt-in that silently turns itself on is
    // worse than one that errors.
    const includeFreshRaw = (req.body as { includeFreshWrites?: unknown }).includeFreshWrites;
    if (includeFreshRaw !== undefined && typeof includeFreshRaw !== 'boolean') {
      res.status(400).json({ error: '`includeFreshWrites` must be a boolean' });
      return;
    }
    const safeIncludeFresh = includeFreshRaw === true;

    // `includeContent: false` drops the passage BODY from file chunks, leaving where they are and what they
    // are about. MCP `recall` has had this since it shipped; REST had no way to ask for it, and an integrator
    // pointed out the asymmetry — the same two-surfaces-one-rule shape as four defects fixed the day before.
    //
    // Why it is worth a flag: a passage body is by far the largest field a result carries, and every field is
    // paid for `topK` times. Dropping it turns one expensive call into a cheap two-phase flow — recall to
    // find WHERE something is, then read only the chunk you chose. Default true, so no existing caller
    // changes; only an explicit `false` opts out, and a non-boolean is refused rather than coerced.
    const includeContentRaw = (req.body as { includeContent?: unknown }).includeContent;
    if (includeContentRaw !== undefined && typeof includeContentRaw !== 'boolean') {
      res.status(400).json({ error: '`includeContent` must be a boolean' });
      return;
    }
    const safeIncludeContent = includeContentRaw !== false;

    // `includeDiagnostics` (default FALSE) restores the three RECORD fields a recall result carries for the
    // system rather than for the caller: `matchedText`, `embeddingModel` and `seq`.
    //
    // IT NO LONGER GOVERNS THE PER-STAGE SCORES. `lexicalScore`/`fusedScore`/`rerankScore` are unconditional
    // on both doors: precedence in a fused recall is `rerankScore > fusedScore > score`, so gating them meant
    // the number that DECIDED a result's position was the one a caller could not read — while `minScore`
    // filters on `score` alone. Three floats are not a cost and do not belong behind a cost flag.
    //
    // This door used to return all six unconditionally while MCP returned none, and neither said so. Owner
    // ruled 2026-08-16 that the two surfaces match and that the fields are off by default on both — so this
    // is a BREAKING change to the REST response, and deliberately: `matchedText` is the pre-embedding source
    // string, which for a file chunk is the passage a SECOND time, so the old default sent a large field
    // nobody had asked for `topK` times.
    /*
     * `includeRecordMeta` (default FALSE) restores `createdAt`, `updatedAt` and the link-id arrays.
     *
     * They describe where a record SITS rather than what it says, and measured on a real corpus they were
     * most of the answer: 30% of a recall response was content, the rest this. `createdAt` is the worst of
     * them because it reads as when the remembered thing happened, which is not what it means.
     *
     * Refused rather than coerced, like every other flag here.
     */
    const includeMetaRaw = (req.body as { includeRecordMeta?: unknown }).includeRecordMeta;
    if (includeMetaRaw !== undefined && typeof includeMetaRaw !== 'boolean') {
      res.status(400).json({ error: '`includeRecordMeta` must be a boolean' });
      return;
    }
    const safeIncludeRecordMeta = includeMetaRaw === true;

    const includeDiagRaw = (req.body as { includeDiagnostics?: unknown }).includeDiagnostics;
    if (includeDiagRaw !== undefined && typeof includeDiagRaw !== 'boolean') {
      res.status(400).json({ error: '`includeDiagnostics` must be a boolean' });
      return;
    }
    const safeIncludeDiagnostics = includeDiagRaw === true;

    // `projection`, the same grammar `/query` takes and the same reading of it — see `brain/projection.ts`.
    // The canary operator measured the cost of its absence: 100,547 characters for ~1.5 KB of wanted data.
    const projParse = projectionFromBody(req.body);
    if (!projParse.ok) { res.status(400).json({ error: projParse.error }); return; }
    const safeProjection = projParse.norm;

    // The byte budget (X-17), replacing the record cap that collapsed a large answer to three inline records
    // plus a whole-set dump — a shape that roughly DOUBLED the caller's cost rather than reducing it.
    const budget = resolveBudget(req.body as BudgetRequest);
    if (!budget.ok) { res.status(400).json({ error: budget.error }); return; }
    // `skip` (clause 6a) and `remainderDump` (6b), resolved together and by ONE function for both doors —
    // a `skip` that 400s here and silently floors to zero on MCP would make the behaviour depend on which
    // client the caller happened to pick, which is the parity defect `CLAUDE.md` calls the half that hides.
    const paging = resolvePaging(req.body as { skip?: unknown; remainderDump?: unknown });
    if (!paging.ok) { res.status(400).json({ error: paging.error }); return; }

    const degraded: string[] = [];
    const all = (await Promise.all(
      memberIds.map(mid => recall(mid, query.trim(), safeTopK, safeTags, safeTypes, safeMinPerType, safeMinScore, safeFilter, { maxPerType: safeMaxPerType, maxTimeMS: safeMaxTimeMS, degraded, includeFreshWrites: safeIncludeFresh })),
    )).flat();
    // rankOf, NOT `.score`. `recall()` has already ordered each space's results by the best signal it
    // has — cross-encoder, then RRF fusion, then vector similarity. Re-sorting the merged list by raw
    // vector score here silently threw both away, so hybrid ranking and reranking were undone at the
    // last step on every REST recall — including a single-space one, which still passes through this
    // merge with one member.
    all.sort(byRankThenId);
    // A proxy space fans out to N members, and each one honoured `maxPerType` for itself — so without this
    // second pass a ceiling of 2 across three members would return six. The ceiling describes the ANSWER,
    // so it is enforced where the answer is assembled, using the same function rather than a second cap
    // loop. `minScore` is not re-applied: each member already filtered on it.
    const seeds = safeMaxPerType
      ? mergeRecallResults([], all, safeTopK, undefined, safeMaxPerType)
      : all.slice(0, safeTopK);

    // Tell the per-space counters whether this recall actually answered, and how good the best hit was.
    //
    // This is the difference between "this space is asked a lot" and "this space is useful": a space queried
    // five hundred times that returns nothing is not popular, and in a call count the two are identical. Only
    // this handler knows what came back, so it hands the outcome to the audit middleware, which owns the
    // duration and the space attribution.
    //
    // `rankOf` rather than `.score` for the same reason the sort above uses it — it is the best signal
    // available for the result, after reranking and fusion.
    req.recallOutcome = {
      answered: seeds.length > 0,
      ...(seeds.length > 0 ? { topScore: rankOf(seeds[0]!) } : {}),
    };

    if (safeTraverse === 0) {
      // `degraded` is present only when something degraded. An empty array on every healthy response is
      // noise, and a field that is almost always empty is a field readers learn to skip — which is exactly
      // when it needs to be noticed. The requester asked for the flag in the BODY rather than only a status,
      // because a 200 that is quietly short is indistinguishable from a 200 that found everything.
      // A large answer spills even with NO traversal: `topK: 100` is 100 records, and this branch used to
      // return all of them because the spill lived in the graph branch alone. That was the bug the E2E caught —
      // the rule is about the size of the result set, not about whether a graph is attached.
      const plain = projectResults(
        withoutDiagnostics(stripContentIfAsked(seeds, safeIncludeContent), safeIncludeDiagnostics),
        safeProjection);
      const plainBudgeted = await budgetedEnvelope({
        results: plain,
        budget,
        skip: paging.skip,
        remainderDump: paging.remainderDump,
        spillRemainder: remainder => spillResultSet({
          memberSpaceId: seeds[0]?.spaceId ?? spaceId,
          results: remainder,
          request: { query: query.trim(), topK: safeTopK, traverse: 0, types: safeTypes ?? null },
        }),
      });
      res.json({
        results: plainBudgeted.results,
        ...plainBudgeted.fields,
        ...(degraded.length > 0 ? { degraded } : {}),
      });
      return;
    }

    // Graph-augmented recall: expand seeds along edges, cap the traversed NODES, and nest each one under the
    // seed that reached it. `count` is the number of MATCHES — it used to be matches plus neighbours, so a
    // caller asking for `topK: 1` was told `count: 6` and could not use the number they page on.
    const totalCap = safeTopK * (safeTraverse + 1) * 4;
    // The cap is now the SPILL point rather than the truncation point: past it the whole neighbourhood is
    // written to the space's `_tmp/` and the response carries an authenticated download link. A short graph
    // reads as "this record has few relationships", which is a wrong conclusion about the DATA.
    const { graph, spill, truncated: graphTruncated } = await buildGraphWithSpill(
      memberIds,
      seeds.map(s => ({ _id: s._id, spaceId: s.spaceId })),
      safeTraverse,
      Math.max(0, totalCap - seeds.length),
      traverseOpt,
    );
    // The flag applies here too. A caller who asked not to be sent passage bodies did not stop meaning it
    // because they also asked for graph expansion — and an option that silently lapses on one code path is
    // the same shape of defect as one that reaches only one surface.
    // Through `mapGraphNodes` rather than attaching `graph.bySeed` raw. It was the raw attach that let the
    // whole edge document — vector included, until the projection added beside this change — reach a REST
    // caller while MCP's copy of the same tree went through a shaping function. One nesting implementation
    // is the point of that function; this door had been going round it.
    const withGraph = withoutDiagnostics(stripContentIfAsked(seeds, safeIncludeContent), safeIncludeDiagnostics)
      .map(s => {
        const nested = mapGraphNodes(
          graph.bySeed.get(s._id), graphNodeRecord, safeIncludeDiagnostics, safeProjection);
        return nested ? { ...s, _graph: nested } : s;
      });
    // Storage bookkeeping is opt-in, and it goes BEFORE the byte budget is measured — trimming after
    // would shrink the response without letting the caller spend what it saved on more evidence, which is
    // the whole point of the change.
    const results = projectResults(withGraph as RecallResult[], safeProjection)
      .map(r => stripRecordMeta(r as object, { includeRecordMeta: safeIncludeRecordMeta }));
    // `graphNodes` reports what `count` used to conflate: how much graph came back. Two numbers, each meaning
    // one thing, rather than one number meaning whichever the reader assumes.
    // The WHOLE result set spills, not the graph alone: `topK: 100, traverse: 2` is a large answer even when
    // every graph inside it is complete, and a caller cannot page a recall. Past the threshold the response
    // carries a SAMPLE — three matches — and the link to all of it. Embeddings are stripped from the file.
    const budgeted = await budgetedEnvelope({
      results,
      budget,
      skip: paging.skip,
      remainderDump: paging.remainderDump,
      spillRemainder: remainder => spillResultSet({
        memberSpaceId: seeds[0]?.spaceId ?? spaceId,
        results: remainder,
        request: { query: query.trim(), topK: safeTopK, traverse: safeTraverse, types: safeTypes ?? null },
      }),
    });
    res.json({
      results: budgeted.results,
      ...budgeted.fields,
      traverseDepth: safeTraverse,
      // What the server actually walked. A number when nothing was narrowed — so an existing caller's assertion
      // still holds — and the object when it was, because a narrowing the response does not mention is one the
      // caller cannot verify was applied.
      traverse: echoTraverse(traverseOpt),
      // Counted from the payload actually being sent, not from what the traversal REACHED.
      //
      // `graph.nodes` is the total across every seed the walk visited — including seeds the byte budget then
      // evicted, so the number described an answer the caller did not receive. The integration guide already
      // said this field is "how many traversed nodes came back", which was simply false.
      //
      // `countGraphNodes` walks the emitted structure, so it is correct for both doors' shapes by
      // construction — flat with `_graph` alongside on REST, nested under `record` on MCP — and it is the
      // same function the spill file uses to describe itself, for the same reason: a count passed in
      // alongside a payload can describe a different set of records than the payload does.
      graphNodes: countGraphNodes(budgeted.results),
      ...(graphTruncated ? { graphTruncated: true } : {}),
      ...(spill ? { graphComplete: spill } : {}),
      ...(degraded.length > 0 ? { degraded } : {}),
    });
  } catch (err: unknown) {
    // A store failure is not a client error. See `brain/store-failure.ts` — this used to answer 400 for every
    // throw, which told fourteen personas not to retry a condition that cleared in seconds.
    sendReadFailure(res, err);
  }
});


/*
 * POST /api/brain/similar — vector similarity to an entry that already exists.
 *
 * The space moved out of the path at 5.0 with the rest of the search family. Here it has a narrower job
 * than on `recall`: it says WHERE THE SEED ENTRY IS, not where to search. Omit it and the entry is located
 * across every space this token can read.
 */
const VALID_ENTRY_TYPES = new Set<string>(RECORD_TYPES);

searchRouter.post('/similar', globalRateLimit, requireBodyScopedSpace('knowledge', 'read'), statesRetryability, async (req, res) => {
  const authorised = req.authorisedSpaces ?? [];
  const namedSpace = req.resolvedSpaceId;
  const spaceId = namedSpace ?? authorised[0] ?? '';

  const body = (req.body ?? {}) as Record<string, unknown>;
  // `crossSpace` is ALLOWED here, permanently, so this refusal does not reject a body that is correct.
  //
  // THE REASON RECORDED HERE WAS ABOUT TO EXPIRE, AND CHECKING IT FOUND A BETTER ONE. It read: the space
  // arrives in the PATH, so "omit the space" cannot be expressed, and `crossSpace: true` is REST's only
  // route to a cross-space find_similar. At 5.0 the space moved into the body and omitting it became
  // expressible — which by that reasoning would have retired the flag.
  //
  // It does not, because the two are not the same question HERE. On `recall` the space says where to
  // search. On this route it says where the SEED ENTRY lives, and the search is a separate axis: naming a
  // space to locate the entry and then looking for similar records in every other space is a real request,
  // and omission cannot express it — omitting the space locates the entry anywhere too.
  //
  // So the flag stays, and the tool's schema description still correctly says "Not slated for removal".
  // The earlier version of this comment said "deprecated … before we have removed it", which pointed the
  // next reader at a change that must not happen.
  //
  // Refusing a key we still accept elsewhere would in any case be a worse contract than the permissive body
  // it replaces.
  const badSimilar = unknownBodyFields(body, FIND_SIMILAR_BODY_FIELDS);
  if (badSimilar) { res.status(400).json(badSimilar); return; }
  const entryId = typeof body['entryId'] === 'string' ? body['entryId'].trim() : '';
  const entryType = typeof body['entryType'] === 'string' ? body['entryType'].trim() : '';
  const topK = typeof body['topK'] === 'number' ? Math.min(Math.max(body['topK'], 1), 100) : 10;
  const minScore = typeof body['minScore'] === 'number' ? body['minScore'] : undefined;
  const crossSpace = body['crossSpace'] === true;
  const targetTypes = Array.isArray(body['targetTypes'])
    ? (body['targetTypes'] as unknown[]).filter((t): t is RecallKnowledgeType => typeof t === 'string' && VALID_ENTRY_TYPES.has(t))
    : undefined;

  // `traverse` and `includeContent`: MCP `find_similar` has implemented both since it shipped — the tool schema
  // advertises them and the handler reads them — while this route read neither. Same shape as the `includeContent`
  // asymmetry an integrator reported on `recall`, one route over.
  //
  // Strictness is what made it visible: before the body was strict, sending `traverse: 2` here returned an unexpanded
  // answer with a 200. It is a 400 now, which is better and still wrong — the parameter is supposed to work.
  //
  // Validated by the SAME parser recall uses, so the two routes cannot disagree about what a bad value is —
  // and so `find_similar` gained the object form in the same commit rather than a release later. A parameter
  // that means one thing on one search and another on the next is the asymmetry this comment is about.
  const parsedFsTraverse = parseTraverseOption(body['traverse'], MAX_RECALL_TRAVERSE);
  if (!parsedFsTraverse.ok) {
    res.status(400).json({ error: parsedFsTraverse.error });
    return;
  }
  const fsTraverseOpt = parsedFsTraverse.value;
  const safeTraverse = fsTraverseOpt.depth;
  const includeContentRaw = body['includeContent'];
  if (includeContentRaw !== undefined && typeof includeContentRaw !== 'boolean') {
    res.status(400).json({ error: '`includeContent` must be a boolean' });
    return;
  }
  const safeIncludeContent = includeContentRaw !== false;
  // The same flag, on the same rule: find-similar returns recall RESULTS, so it carried the same six
  // system fields REST's recall did while MCP's `find_similar` — which builds its records through
  // `toRecallRecord` — has never sent any of them. Fixing recall alone would leave the identical
  // asymmetry one route to the left.
  const similarDiagRaw = body['includeDiagnostics'];
  if (similarDiagRaw !== undefined && typeof similarDiagRaw !== 'boolean') {
    res.status(400).json({ error: '`includeDiagnostics` must be a boolean' });
    return;
  }
  const safeIncludeDiagnostics = similarDiagRaw === true;

  // Same parameter, same parser. find-similar returns recall RESULTS, so a projection that reached one route
  // and not the other would be the asymmetry this whole area has spent two releases removing.
  const simProjParse = projectionFromBody(body);
  if (!simProjParse.ok) { res.status(400).json({ error: simProjParse.error }); return; }
  const safeProjection = simProjParse.norm;

  // Same budget, same resolver. find-similar returns recall RESULTS, so a cap that applied to one route and
  // not the other would be the asymmetry this area has spent three releases removing.
  const budget = resolveBudget(body as BudgetRequest);
  const paging = resolvePaging(body as { skip?: unknown; remainderDump?: unknown });
  if (!budget.ok) { res.status(400).json({ error: budget.error }); return; }
  if (!paging.ok) { res.status(400).json({ error: paging.error }); return; }


  if (!entryId || !UUID_V4_RE.test(entryId)) {
    res.status(400).json({ error: 'entryId must be a valid UUID v4' });
    return;
  }
  if (!VALID_ENTRY_TYPES.has(entryType)) {
    res.status(400).json({ error: `entryType must be one of: ${[...VALID_ENTRY_TYPES].join(', ')}` });
    return;
  }

  // Determine cross-space search scope
  let crossSpaceIds: string[] | undefined;
  if (crossSpace) {
    // THE MATRIX DECIDES THE CROSS-SPACE SET. There is no fallback, and this line said there was one —
    // *"with the legacy allowlist only as a fallback"* — directly above the paragraph explaining that the
    // allowlist read was the defect and is gone. `spacesWhereTokenMay` returns `[]` for a record with no
    // matrix, deliberately.
    //
    // This read the allowlist alone, and `spaces` is `undefined` on every token minted since the matrix —
    // the rights editor writes `rights.perSpace` and nothing writes that array. So `!tokenSpaces` was true
    // for a modern token and the filter kept EVERY space: a cross-space recall from a token scoped to one
    // space searched the whole instance. Same shape as the sync-scope hole, one route over, and the same
    // fix — `spacesWhereTokenMay` makes the absent/empty distinction explicitly instead of by truthiness.
    //
    // `knowledge: read` because that is what a recall is. A token holding files-only in a space has no
    // business having its records ranked here.
    crossSpaceIds = spacesWhereTokenMay(
      (req.authToken as { rights?: TokenRights } | undefined)?.rights,
      'knowledge',
      'read',
    );
  }

  try {
    const result = await findSimilar(
      spaceId,
      entryId,
      entryType as RecallKnowledgeType,
      topK,
      targetTypes,
      minScore,
      crossSpaceIds,
    );
    if (safeTraverse === 0) {
      const plainItems = projectResults(withoutDiagnostics(
        stripContentIfAsked(result.results, safeIncludeContent), safeIncludeDiagnostics), safeProjection);
      const plainItemsBudgeted = await budgetedEnvelope({
        results: plainItems,
        budget,
        skip: paging.skip,
        remainderDump: paging.remainderDump,
        spillRemainder: remainder => spillResultSet({
          memberSpaceId: result.results[0]?.spaceId ?? spaceId,
          results: remainder,
          request: { entryId, entryType, topK, traverse: 0 },
        }),
      });
      res.json({
        ...result,
        results: plainItemsBudgeted.results,
        ...plainItemsBudgeted.fields,
      });
      return;
    }

    // Graph-augmented: expand the similar matches along edges. Deliberately the SAME builder, cap formula and
    // envelope `recall`'s traverse uses — a caller who can read one response can read the other, and a second
    // copy of the shape is how the two would drift.
    const traverseSpaces = crossSpaceIds ?? [spaceId];
    // Bounded absolutely as well as by `topK`, which no longer has a ceiling of its own (`P-34`). The
    // formula is what shapes a NORMAL answer; the constant is what stops an enormous `topK` turning a
    // graph walk into an unbounded one. `MAX_GRAPH_NODES` is shared with recall's traverse so the two
    // cannot drift — the comment above says that is the point.
    const totalCap = Math.min(topK * (safeTraverse + 1) * 4, MAX_GRAPH_NODES);
    const { graph, spill, truncated: graphTruncated } = await buildGraphWithSpill(
      traverseSpaces,
      result.results.map(r => ({ _id: r._id, spaceId: r.spaceId })),
      safeTraverse,
      Math.max(0, totalCap - result.results.length),
      fsTraverseOpt,
    );
    const itemsWithGraph = withoutDiagnostics(
      stripContentIfAsked(result.results, safeIncludeContent), safeIncludeDiagnostics)
      .map(r => {
        const nested = mapGraphNodes(
          graph.bySeed.get(r._id), graphNodeRecord, safeIncludeDiagnostics, safeProjection);
        return nested ? { ...r, _graph: nested } : r;
      });
    const items = projectResults(itemsWithGraph as RecallResult[], safeProjection);
    const itemsBudgeted = await budgetedEnvelope({
      results: items,
      budget,
      skip: paging.skip,
      remainderDump: paging.remainderDump,
      spillRemainder: remainder => spillResultSet({
        memberSpaceId: result.results[0]?.spaceId ?? spaceId,
        results: remainder,
        request: { entryId, entryType, topK, traverse: safeTraverse },
      }),
    });
    res.json({
      source: result.source,
      results: itemsBudgeted.results,
      ...itemsBudgeted.fields,
      traverseDepth: safeTraverse,
      // Counted from the payload actually being sent, not from what the traversal REACHED.
      //
      // `graph.nodes` is the total across every seed the walk visited — including seeds the byte budget then
      // evicted, so the number described an answer the caller did not receive. The integration guide already
      // said this field is "how many traversed nodes came back", which was simply false.
      //
      // `countGraphNodes` walks the emitted structure, so it is correct for both doors' shapes by
      // construction — flat with `_graph` alongside on REST, nested under `record` on MCP — and it is the
      // same function the spill file uses to describe itself, for the same reason: a count passed in
      // alongside a payload can describe a different set of records than the payload does.
      graphNodes: countGraphNodes(itemsBudgeted.results),
      ...(graphTruncated ? { graphTruncated: true } : {}),
      ...(spill ? { graphComplete: spill } : {}),
    });
  } catch (err: unknown) {
    if (err instanceof NotFoundError) {
      res.status(404).json({ error: err.message });
    } else {
      sendReadFailure(res, err);
    }
  }
});


searchRouter.get('/spaces/:spaceId/reindex-status', globalRateLimit, requireSpaceAuth, (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const memberIds = memberSpacesForRequest(req, spaceId);
  const needs = memberIds.some(mid => needsReindex(mid));
  res.json({ spaceId, needsReindex: needs });
});


// POST /api/brain/spaces/:spaceId/reindex
// Re-embeds all facts in a space using the currently configured model.
// Long-running: may take minutes for large spaces. Progress is logged server-side.
// POST /api/brain/spaces/:spaceId/reindex
//
// Every refusal -- 404, the proxy 400, the single-job 409 -- and the work itself live in `brain/reindex.ts`, so an
// MCP tool reaches the same rules and the same guard instead of a weaker copy of them (B-2). What stays here is
// resolving the member spaces from the REQUEST (which is where the token's scope is known) and turning a refusal into
// a status.
//
// The response is sent as soon as the job is SCHEDULED, with zeroed counters. That is deliberate and pinned:
// `reindex-contract.test.js` asserts the shape, because awaiting the work here would answer the same 200 and turn a
// multi-minute job into a request timeout.
searchRouter.post('/spaces/:spaceId/reindex', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const space = getConfig().spaces.find(s => s.id === spaceId);

  const decision = planReindex({ spaceId, space, memberIds: memberSpacesForRequest(req, spaceId) });
  if (!decision.ok) {
    res.status(decision.refusal.status).json(decision.refusal.body);
    return;
  }

  startReindex(decision.plan);
  res.json({ spaceId, reindexed: 0, errors: 0, status: 'started' });
});
