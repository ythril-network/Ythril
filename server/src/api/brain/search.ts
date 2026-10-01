/**
 * Read/analytics routes: stats, traverse, query, recall, find-similar, and reindex.
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { requireSpaceAuth, denyReadOnly, requireAuth } from '../../auth/middleware.js';
import { callTool } from '../../mcp/call-tool.js';
import { restToolCaller } from '../rest-tool-caller.js';
import { summariseActivity } from '../../metrics/space-activity-store.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { countFacts } from '../../brain/fact.js';
import { getEmbedJobCounts } from '../../brain/embed-queue.js';
import { getConfig } from '../../config/loader.js';
import { col } from '../../db/mongo.js';
import { planReindex, startReindex, reindexStateFor } from '../../brain/reindex.js';
import { memberSpacesForRequest } from '../../spaces/proxy-scoped.js';
import { rankOf } from '../../brain/recall-shape.js';
import { statesRetryability } from './_read-failure.js';
import { spaceCollection } from '../../db/space-collection.js';

/*
 * `MAX_GRAPH_NODES` lived here, private to this file, with a comment saying recall shared it. It did not: only
 * this route applied it, and here `topK <= 100` meant it could never bind. The bounds on a graph walk are now
 * `brain/search-bounds.ts`, and every door — this one included — reaches them through `traversedAnswer`.
 */

export const searchRouter = Router();


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


// POST /api/brain/spaces/:spaceId/traverse — graph traversal (BFS)
searchRouter.post('/spaces/:spaceId/traverse', globalRateLimit, requireSpaceAuth, statesRetryability, async (req, res) => {
  /*
   * The `graph_traverse` tool's answer, as `/recall` and `/similar` give their tools' (`Q-109`). This route validated
   * its own body and CLAMPED where the tool refuses: a `maxDepth` over 10 or a `limit` over 1000 became the ceiling,
   * a bad `direction` became `outbound`, and a non-string `edgeLabels` entry was read as ALL labels — a widening.
   * One capability, two sets of caps by door. The space stays in the path because a walk starts from one record,
   * which lives in exactly one space; it is handed to the tool as `space`.
   */
  const outcome = await callTool({
    name: 'graph_traverse',
    args: { ...((req.body ?? {}) as Record<string, unknown>), space: req.params['spaceId'] as string },
    caller: restToolCaller(req),
  });
  const text = outcome.result.content.map(c => c.text).join('\n');
  if (outcome.result.isError) {
    res.status(outcome.status).json({ error: text, ...(outcome.result.structuredContent ?? {}) });
    return;
  }
  res.status(outcome.status).json(JSON.parse(text));
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
searchRouter.post('/similar', globalRateLimit, requireAuth, statesRetryability, async (req, res) => {
  /*
   * The `similar` tool's answer, as `/recall` gives the `recall` tool's (`Q-89`). This route built its own: flat hits
   * and the whole source record, while the tool answered `{score, spaceId, type, record}` per hit and `source` as
   * `{type, id, summary}` — one capability, two shapes by door. Owner ruling 2026-09-29: REST takes the nested
   * shape, as a breaking change named in the CHANGELOG.
   *
   * `crossSpace` stays a real parameter here: `space` says where the SEED entry lives, and searching every other
   * space from a seed in one is a request that omitting `space` cannot express.
   */
  const outcome = await callTool({
    name: 'similar',
    args: (req.body ?? {}) as Record<string, unknown>,
    caller: restToolCaller(req),
  });
  const text = outcome.result.content.map(c => c.text).join('\n');
  if (outcome.result.isError) {
    res.status(outcome.status).json({ error: text, ...(outcome.result.structuredContent ?? {}) });
    return;
  }
  res.status(outcome.status).json(JSON.parse(text));
});


// `reindexRun` is the progress of a running reindex, from the same function `space_meta` answers with on both doors.
searchRouter.get('/spaces/:spaceId/reindex-status', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const state = await reindexStateFor(memberSpacesForRequest(req, spaceId));
  res.json({ spaceId, ...state });
});


// POST /api/brain/spaces/:spaceId/reindex
//
// Every refusal -- 404, the proxy 400, the per-space 409 -- and the run itself live in `brain/reindex.ts`, so an
// MCP tool reaches the same rules instead of a weaker copy of them (B-2). What stays here is resolving the member
// spaces from the REQUEST (which is where the token's scope is known) and turning a refusal into a status.
//
// The response is sent as soon as the run is RECORDED, with zeroed counters (kept for older clients; progress is
// `reindexRun` on reindex-status). Awaiting the rebuild here would turn a multi-minute job into a request timeout.
searchRouter.post('/spaces/:spaceId/reindex', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const space = getConfig().spaces.find(s => s.id === spaceId);

  const decision = await planReindex({ spaceId, space, memberIds: memberSpacesForRequest(req, spaceId) });
  if (!decision.ok) {
    res.status(decision.refusal.status).json(decision.refusal.body);
    return;
  }

  await startReindex(decision.plan);
  res.json({ spaceId, reindexed: 0, errors: 0, status: 'started' });
});
