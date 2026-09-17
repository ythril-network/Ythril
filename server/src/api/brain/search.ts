/**
 * Read/analytics routes: stats, traverse, query, recall, find-similar, and reindex.
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { BRAIN_COLLECTIONS } from '../../config/types.js';
import { requireSpaceAuth, requireBodyScopedSpace, denyReadOnly, requireAuth } from '../../auth/middleware.js';
import { callTool } from '../../mcp/call-tool.js';
import { restToolCaller } from '../rest-tool-caller.js';
import { spacesWhereTokenMay } from '../../auth/reachable-spaces.js';
import type { TokenRights } from '../../config/rights-shape.js';
import { summariseActivity } from '../../metrics/space-activity-store.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { parseSortParam, toMongoSort, SORTABLE_FIELDS } from '../../brain/list-sort.js';
import { conveniencePredicate, conveniencesFrom } from '../../brain/list-conveniences.js';
import { decorateMemberRows, decoratePage } from '../../brain/list-decorations.js';
import { withoutListDiagnostics } from '../../brain/read-projection.js';
import { collectAcrossMembers } from '../../spaces/proxy.js';
import { pageAcrossMembers } from '../../spaces/page-across-members.js';
import { NotFoundError } from '../../util/errors.js';
import { countFacts } from '../../brain/fact.js';
import { getEmbedJobCounts } from '../../brain/embed-queue.js';
import {
  queryBrain, countBrain, QUERY_BODY_FIELDS, TRAVERSE_BODY_FIELDS, FIND_SIMILAR_BODY_FIELDS,
  unknownBodyFields, compareBySort, DEFAULT_QUERY_SORT, DEFAULT_QUERY_LIMIT, PROXY_PAGE_CEILING,
} from '../../brain/query.js';
import { findSimilar, type RecallKnowledgeType, type RecallResult } from '../../brain/recall.js';
import { type FilterExpression } from '../../brain/filter.js';
import { resolveEntityIdsByName } from '../../brain/entities.js';
import { attachedToEntityNamed } from '../../brain/entity-name-scope.js';
import { traverseGraph } from '../../brain/edges.js';
import { MAX_RECALL_TRAVERSE } from '../../brain/recall-seed-traversal.js';
import { buildGraphWithSpill, spillResultSet, countGraphNodes } from '../../brain/graph-spill.js';
import { parseTraverseOption } from '../../brain/traverse-option.js';
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
  withoutDiagnostics, RECALL_ENVELOPE_KEYS, rankOf,
} from '../../brain/recall-shape.js';
import { mapGraphNodes, graphNodeRecord } from '../../brain/recall-graph.js';
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

function stripContentIfAsked(results: RecallResult[], includeFileContent: boolean): RecallResult[] {
  if (includeFileContent) return results;
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
  /*
   * Refused on a collection it cannot mean, never ignored — a silently dropped flag is a caller who
   * believes they asked. Same rule and the same wording as the tool, for the same reason.
   */
  if (body['deriveStatus'] !== undefined && collection !== 'chrono') {
    res.status(400).json({ error: `\`deriveStatus\` applies to chrono only, not '${String(collection)}'. `
      + 'Only a chrono entry has a due moment for a status to be derived from.' });
    return;
  }
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
  const rawFilter: Record<string, unknown> =
    filter != null && typeof filter === 'object' && !Array.isArray(filter)
      ? (filter as Record<string, unknown>)
      : {};
  /*
   * The five list CONVENIENCES, through the module both doors call — never assembled here.
   *
   * Merged UNDER `$and` rather than assigned, because `search` produces an `$or` and so may the caller's
   * own predicate; assigning would replace theirs with ours and answer over the wrong set with nothing
   * said. The module refuses a collection that cannot honour them (`links` has no text of its own), so
   * this branch cannot be skipped by a caller who forgets it exists.
   */
  const merged = conveniencePredicate(String(collection), conveniencesFrom(body), rawFilter);
  if ('error' in merged) { res.status(400).json({ error: merged.error }); return; }
  const safeFilter = merged.predicate;
  const safeProjection: Record<string, unknown> | undefined =
    projection != null && typeof projection === 'object' && !Array.isArray(projection)
      ? (projection as Record<string, unknown>)
      : undefined;
  // The caller-facing page cap. It used to live inside `queryBrain`, where it also bounded the proxy merge's internal
  // fetch and silently truncated deep pages to nothing.
  // A DEFAULT, not a clamp: see `DEFAULT_QUERY_LIMIT`. What bounds the answer is the byte budget, the
  // `maxTimeMS` ceiling and — on a proxy space — `PROXY_PAGE_CEILING`, which refuses out loud.
  const safeLimit = typeof limit === 'number' ? limit : DEFAULT_QUERY_LIMIT;
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
      readMember: async (mid, lim, sk) => decorateMemberRows(String(collection), mid, await queryBrain(
        mid, collection as typeof validCollections[number],
        await withNameScope(mid), safeProjection, lim, safeMaxTimeMS, sk, order,
      ) as Array<Record<string, unknown>>),
    });
    if (!page.ok) { res.status(400).json({ error: page.error }); return; }
    /*
     * The two DECORATIONS the per-collection list routes apply and this one did not: an edge's endpoint
     * names, and a file's job step progress (joined per member above, before the page is merged and the
     * owner is forgotten). A decoration is not a parameter, so nothing compared the doors and nobody
     * reported the difference — see `brain/list-decorations.ts`.
     */
    const decorated = await decoratePage(String(collection), spaceId, page.rows,
      read => collectAcrossMembers(spaceId, read), { deriveStatus: body['deriveStatus'] === true });
    // And the same diagnostics projection the four list routes honour. Absent here, `includeDiagnostics`
    // was accepted by the body allowlist and did nothing, which is the silent no-op it exists to remove.
    const merged = withoutListDiagnostics(decorated, body['includeDiagnostics'] === true);

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
 * ## It holds no implementation any more, and that is the point
 *
 * This was four hundred lines answering the same question as the `recall` MCP tool, and the two stayed in
 * step because somebody checked both every time either changed. They had already drifted where nobody was
 * looking: a caller on `POST /api/recall` — the generic tool door added by `B-9`, same transport, same
 * capability — got a 25 000-character budget where this route gave 50 000, because the tool module chose
 * MCP's default itself. Same server, same parameters, half the answer, nothing saying why.
 *
 * So the capability lives in one place, `callTool` gates it for both doors, and what is left here is the
 * translation between this route's envelope and that one's. That is what every door is supposed to be.
 *
 * ## Why the route survives its own handler
 *
 * `POST /api/recall` returns the tool envelope — `{ok, text, data}` — and this one returns the search result
 * as the body, which is what every REST caller written against it reads. Keeping the older shape is a
 * deprecation question rather than a code question, and answering it by deleting the route would break
 * working integrations in a release that already breaks every public name. The two paths now differ in the
 * envelope alone.
 *
 * ## The parse, and why it is not a smell worth removing
 *
 * `recall` returns its result as JSON inside `content`, because that is what an MCP client reads. Parsing it
 * back here costs microseconds on an answer already bounded to tens of kilobytes, and it buys the one thing
 * this change is for: there is no second construction of the response object to fall out of step. A shared
 * builder returning the object, wrapped differently by each door, would be the same module count with an
 * extra type — and it would let a door quietly add a field, which is how the drift above started.
 *
 * ## Authorisation moved with the implementation
 *
 * `requireBodyScopedSpace` is gone from this route, not bypassed: `callTool` parses `space`, checks that
 * each named space exists and is reachable, and applies the `TOOL_RIGHTS` row for `recall` per space. One
 * set of rights rows for both doors is what `B-9` was for — a `ROUTE_RIGHTS` row here as well would be a
 * second answer to the same question, and the weaker one would win silently.
 */
searchRouter.post('/recall', globalRateLimit, requireAuth, statesRetryability, async (req, res) => {
  const outcome = await callTool({
    name: 'recall',
    args: (req.body ?? {}) as Record<string, unknown>,
    caller: restToolCaller(req),
  });
  const text = outcome.result.content.map(c => c.text).join('\n');
  if (outcome.result.isError) {
    /*
     * The refusal sentence is the tool's, word for word, under this route's own key — a door that rewords a
     * refusal makes the two surfaces disagree about what happened for callers comparing them.
     *
     * `structuredContent` is SPREAD, and leaving it out was a real loss when this route was first collapsed.
     * It is where `callTool` puts `retryable`, `storeSideFailure` and the driver's error code on a store
     * failure, and a REST caller who cannot tell "retry this" from "your query is wrong" is the defect
     * `_read-failure.ts` exists to prevent. `statesRetryability` above still fills the field in on the
     * refusals that carry no structured body at all, so it is on every failure either way.
     */
    res.status(outcome.status).json({ error: text, ...(outcome.result.structuredContent ?? {}) });
    return;
  }

  /*
   * Typed as the RANKING envelope, not as `RecallResult`. A hit is `{score, spaceId, type, record}` — the
   * record is nested, and only the ranking fields sit at the top level. Calling it a `RecallResult` would
   * compile (the ranking fields overlap) and would tell the next reader the record's fields are here.
   */
  const answer = JSON.parse(text) as {
    count?: number;
    results?: { score?: number; fusedScore?: number; rerankScore?: number }[];
  };
  /*
   * The space-activity signal, and it is NOT part of the response — which is why collapsing this route
   * dropped it silently and no comparison of the two bodies would have found it.
   *
   * `audit/middleware.ts` reads `req.recallOutcome` to record whether a recall ANSWERED and how well, and
   * that is what separates a space worth keeping from one that is merely asked a lot. The old handler
   * stashed it because it was the only code that knew; the tool knows now, and has no `req` to put it on.
   *
   * `rankOf` rather than `.score`, for the reason it exists: precedence is rerank > fused > vector, so on
   * an instance with a reranker `.score` is the one number that did NOT decide the result's position.
   */
  const top = answer.results?.[0];
  req.recallOutcome = {
    answered: (answer.count ?? 0) > 0,
    ...(top ? { topScore: rankOf(top) } : {}),
  };
  res.status(outcome.status).json(answer);
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

  // `traverse` and `includeFileContent`: MCP `find_similar` has implemented both since it shipped — the tool schema
  // advertises them and the handler reads them — while this route read neither. Same shape as the `includeFileContent`
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
  const includeFileContentRaw = body['includeFileContent'];
  if (includeFileContentRaw !== undefined && typeof includeFileContentRaw !== 'boolean') {
    res.status(400).json({ error: '`includeFileContent` must be a boolean' });
    return;
  }
  const safeIncludeFileContent = includeFileContentRaw !== false;
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
        stripContentIfAsked(result.results, safeIncludeFileContent), safeIncludeDiagnostics), safeProjection);
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
      stripContentIfAsked(result.results, safeIncludeFileContent), safeIncludeDiagnostics)
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
