/**
 * Memory CRUD routes (/api/brain/spaces/:spaceId/memories).
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { requestActor } from '../../auth/request-actor.js';
import { shapeError } from '../../brain/write-shape.js';
import { entityDeleteBlockers } from '../../brain/entity-delete-guard.js';
import { usesLinkRecords } from '../../brain/link-adjacency.js';
import { arrayWriteError } from '../../brain/array-write-refusal.js';
import { connectionInputError, applyConnections, CONNECTION_BODY_KEYS } from '../../brain/write-connections.js';
import { assertRefsResolve } from '../../brain/entity-refs.js';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { unknownFieldWarnings } from './unknown-fields.js';
import { globalRateLimit, bulkWipeRateLimit } from '../../rate-limit/middleware.js';
import { listMemories, deleteMemory, bulkDeleteMemories, remember, updateMemory } from '../../brain/memory.js';
import { validateDeleteFields, applyDeleteFields as applyDeleteFieldsPaths } from '../../brain/delete-fields.js';
import { getConfig } from '../../config/loader.js';
import { col, asFilter } from '../../db/mongo.js';
import { parseLimit, parseSkip, unsupportedPageParam } from '../../util/pagination.js';
import { pageAcrossMembers } from '../../spaces/page-across-members.js';
import { memberSpacesForRequest } from '../../spaces/proxy-scoped.js';
import { countBrain, compareBySort, PROXY_PAGE_CEILING } from '../../brain/query.js';
import { parseSortParam, SORTABLE_FIELDS, toMongoSort } from '../../brain/list-sort.js';
import { checkQuota, QuotaError } from '../../quota/quota.js';
import { resolveMemberSpaces, resolveWriteTarget, isProxySpace, isStrictLinkage, findFirstAcrossMembers, collectAcrossMembers } from '../../spaces/proxy.js';
import { validateMemory } from '../../spaces/schema-validation.js';
import type { FactDoc } from '../../config/types.js';
import { UUID_V4_RE, webhookToken, getSpaceMeta, applyValidation, buildMemoryFilter, ttlDaysFromBody, ttlDaysError, dupeCheckOptsFromBody, ifMatchFromRequest, preconditionFailedBody } from './_shared.js';
import { SchemaViolationError, type UpdateValidation } from '../../brain/write-validation.js';
import { resolveEntityIdsByName } from '../../brain/entities.js';
import { mergePropertiesOrKeep } from '../../brain/merge-fields.js';
import { parseRecordSuppression } from '../../brain/suppress-embeddings.js';
import { withoutListDiagnostics } from '../../brain/read-projection.js';
import { listDiagnosticsAsked } from './_shared.js';

export const memoriesRouter = Router();

// POST /api/brain/spaces/:spaceId/memories — create a memory
/**
 * The body keys the memories create reads.
 *
 * Declared so the route can say what it did NOT understand — see `unknownFieldWarnings`. It is a
 * second list beside the destructure below, which is exactly the kind of pair that drifts, so
 * `a-create-says-which-fields-it-did-not-understand.test.js` requires every destructured name to
 * appear here. A field added below and not here would produce an "unknown field" warning about a
 * parameter that works.
 *
 * The shared write options — ttlDays, waitForEmbedding, the duplicate flags and the two suppression
 * spellings — are NOT listed: they are read by helpers, and live in `SHARED_WRITE_BODY_KEYS`.
 */
// `LINK_INPUT_NAMES` spread rather than listed: a fifth kind gets its field here on the day it is declared,
// and a caller using a real field must never be told it is unknown.
const MEMORIES_CREATE_BODY_KEYS = ['fact', 'tags', 'entityIds', 'description', 'properties', 'type', 'id',
  ...CONNECTION_BODY_KEYS];
memoriesRouter.post('/spaces/:spaceId/memories', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  // Proxy space: resolve target space for write
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  // `M-2`: on a converted space the six arrays are no longer a write surface — see `arrayWriteError`.
  // Checked against the WRITE TARGET, which on a proxy is the member space that will hold the record: the
  // proxy itself holds nothing and its own marker would answer for a space it never writes to.
  const linkArrErr = arrayWriteError({ converted: usesLinkRecords(wt.target), spaceId: wt.target, body: req.body,
    actor: requestActor(req) });
  if (linkArrErr) { res.status(400).json({ error: linkArrErr }); return; }
  const targetSpace = wt.target;
  const { fact, tags = [], entityIds = [], description, properties, type: memoryType } = req.body ?? {};
  if (!fact || typeof fact !== 'string') {
    res.status(400).json({ error: '`fact` string required' });
    return;
  }
  if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) {
    res.status(400).json({ error: '`tags` must be an array of strings' });
    return;
  }
  if ((fact as string).length > 50_000) {
    res.status(400).json({ error: '`fact` must not exceed 50 000 characters' });
    return;
  }
  // Quota check — reject with 507 if brain hard limit exceeded
  let quotaResult;
  try {
    quotaResult = await checkQuota('brain');
  } catch (err) {
    if (err instanceof QuotaError) {
      res.status(507).json({ error: err.message, storageExceeded: true });
      return;
    }
    throw err;
  }
  const safeDesc: string | undefined = typeof description === 'string' ? description : undefined;
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;
  const safeEntityIds: string[] = Array.isArray(entityIds) ? entityIds : [];
  // Every id must be a UUID v4 AND name an entity that exists. Format alone was never enough: a
  // syntactically perfect id pointing at nothing stores exactly as silently as a name did, and the
  // dangling link only shows up later as a traversal that comes back empty.
  if (isStrictLinkage(wt.target)) {
    try {
      await assertRefsResolve(wt.target, 'entityIds', 'entity', safeEntityIds);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }
  const safeTags: string[] = Array.isArray(tags) ? tags : [];

  // Schema validation
  const safeMemoryType: string | undefined = typeof memoryType === 'string' ? memoryType : undefined;
  const meta = getSpaceMeta(wt.target);
  const violations = validateMemory(meta ?? {}, { type: safeMemoryType, properties: safeProps });
  const validation = applyValidation(meta, violations);
  if (validation.blocked) {
    res.status(400).json({ error: 'schema_violation', violations: validation.warnings });
    return;
  }

  // Persist through the shared remember() so REST and MCP produce identical records: the same
  // embed-text derivation (properties folded as `key value` via propsEmbedText, entity names
  // resolved consistently), the `matchedText` source string, the author, insert-time duplicate-
  // rule evaluation, and the memory.created webhook. Previously inlined here, which had drifted
  // into three bugs: values-only property embedding, no `matchedText`, and no dupe-rule firing.
  const ttlErr = ttlDaysError(req.body);
  if (ttlErr) { res.status(400).json({ error: ttlErr }); return; }
  // `W-14`..`W-22`: what a VALUE must look like, from the one table this door and its twin both read.
  // AFTER the checks above, so every refusal this door already made keeps its own wording; this catches
  // only what used to get through. Requiredness stays above — a create demands its fields, an update
  // must not.
  const shapeErr = shapeError('fact', req.body);
  if (shapeErr) { res.status(400).json({ error: shapeErr }); return; }

  // `F-27`: the one-call write. Shape and well-formedness here; existence is the writer's job, in one query.
  // `F-27`: the one-call write — links and labelled edges together. Shape here; existence at the writer.
  const connErr = connectionInputError(req.body);
  if (connErr) { res.status(400).json({ error: connErr }); return; }

  // A caller-supplied id becomes the sync identity of a record that replicates across networks, so it is held
  // to the same shape the rest of the API uses. (The entity route accepts any string here — pre-existing, and
  // tightening it would be a breaking change, so it is filed rather than copied.)
  const rawId: unknown = req.body?.['id'];
  if (rawId !== undefined && (typeof rawId !== 'string' || !UUID_V4_RE.test(rawId))) {
    res.status(400).json({ error: '`id` must be a UUID v4 when supplied. Omit it to have one generated, or reuse the same value to make a retry idempotent.' });
    return;
  }
  const safeId: string | undefined = typeof rawId === 'string' ? rawId : undefined;

  // `waitForEmbedding` (default false): the vector is normally computed by the embedding queue moments
  // after this returns, so the write no longer pays the model latency. Pass true when the caller will
  // search for what it just wrote, or when a failure to embed should fail the write.
  const waitForEmbedding = req.body?.waitForEmbedding;
  if (waitForEmbedding !== undefined && typeof waitForEmbedding !== 'boolean') {
    res.status(400).json({ error: '`waitForEmbedding` must be a boolean' });
    return;
  }
  // The insert-time near-duplicate / contradiction check MCP's `remember` has always taken. `remember`
  // already merges `similar` and `contradicts` into what it returns, so the spread below reports them with
  // no further work — the only thing missing on this surface was reading the flags off the body.
  const dupe = dupeCheckOptsFromBody(req.body);
  if ('error' in dupe) { res.status(400).json({ error: dupe.error }); return; }
  const writeOpts = { ...dupe.opts, ...(waitForEmbedding === true ? { waitForEmbedding: true } : {}) };

  const doc = await remember(
    targetSpace, fact, safeEntityIds, safeTags, safeDesc, safeProps,
    safeMemoryType, Object.keys(writeOpts).length > 0 ? writeOpts : undefined,
    webhookToken(req), ttlDaysFromBody(req.body), safeId,
  );

  /*
   * `F-27`: the relationships this write asked for, in the same call.
   *
   * AFTER the record exists, because a relationship needs both ends and the `from` is what was just minted.
   * Links REPLACE per class and edges UPSERT — both semantics live in `applyConnections`, so no door has to
   * restate them and no two doors can disagree about them.
   */
  await applyConnections(targetSpace, doc._id, 'fact', req.body, doc.author, webhookToken(req));
  const body: Record<string, unknown> = { ...doc };
  if (quotaResult?.softBreached) body['storageWarning'] = true;
  // The schema warnings a `warn` space produces, plus the keys this route did not understand — one
  // array, one shape. A second channel for the second kind would be worse than the silence it replaces.
  const warnings = [...validation.warnings, ...unknownFieldWarnings(req.body, MEMORIES_CREATE_BODY_KEYS)];
  if (warnings.length > 0) body['warnings'] = warnings;
  res.status(201).json(body);
});


// GET /api/brain/spaces/:spaceId/memories/:id — get single memory
memoriesRouter.get('/spaces/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const doc = await findFirstAcrossMembers(spaceId,
    mid => col<FactDoc>(`${mid}_facts`).findOne(asFilter<FactDoc>({ _id: id })));
  if (doc) { res.json(doc); return; }
  res.status(404).json({ error: 'Memory not found' });
});


// GET /api/brain/spaces/:spaceId/memories
memoriesRouter.get('/spaces/:spaceId/memories', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  // A pagination name we do not have is a 400 naming the one we do. The fleet integrator paged this endpoint with `offset`, which was
  // accepted and ignored, and summed 67 identical pages into a count 67x the truth.
  const badParam = unsupportedPageParam(req.query as Record<string, unknown>);
  if (badParam) { res.status(400).json(badParam); return; }

  const limit = parseLimit(req.query['limit'], 100, 500);
  const skip = parseSkip(req.query['skip']);
  const sortParse = parseSortParam(req.query['sort'], req.query['dir'], SORTABLE_FIELDS.facts);
  if ('error' in sortParse) {
    res.status(400).json({ error: sortParse.error });
    return;
  }
  const filter = buildMemoryFilter(req.query as Record<string, unknown>);
  // The Entities column shows entity NAMES; records store ids. Resolved per member for the same reason
  // as edges: an id belongs to the member that owns it. An empty resolution filters to nothing, which is
  // correct — "no entity by that name" must not fall back to showing everything.
  const entityName = typeof req.query['entityName'] === 'string' ? req.query['entityName'] : undefined;
  // Paged through the shared helper, so a proxy space's page is the page of the MERGED set rather than `skip` rows
  // dropped from each member. Same function `/query` and the embed-job listing use.
  const members = memberSpacesForRequest(req, spaceId);
  const filterFor = async (mid: string): Promise<Record<string, unknown>> => {
    const perMember: Record<string, unknown> = { ...filter };
    if (entityName) perMember['entityIds'] = { $in: await resolveEntityIdsByName(mid, entityName) };
    return perMember;
  };
  const page = await pageAcrossMembers<Record<string, unknown>>({
    members, limit, skip, ceiling: PROXY_PAGE_CEILING,
    // The comparator is built FROM the sort handed to MongoDB, so a proxy merge cannot order by a different rule.
    compare: compareBySort(sortParse.sort ? toMongoSort(sortParse.sort) : { createdAt: -1, _id: -1 }),
    readMember: async (mid, lim, sk) =>
      await listMemories(mid, await filterFor(mid), lim, sk, sortParse.sort) as Record<string, unknown>[],
  });
  if (!page.ok) { res.status(400).json({ error: page.error }); return; }

  // `total` is the whole match, and it is the ONE thing the fleet integrator said they would take if we only did one: a caller
  // compares what it summed against what the server counted and stops. Without it, 67 identical pages summed to a
  // plausible number with nothing in any response contradicting it.
  let total = 0;
  for (const mid of members) total += await countBrain(mid, 'facts', await filterFor(mid));

  res.json({
    facts: withoutListDiagnostics(page.rows, listDiagnosticsAsked(req)), limit, skip, total,
    // Explicit rather than left to be derived from `total`: their third ask, and a caller that knows it received a
    // partial page does not need to work out whether it did.
    truncated: skip + page.rows.length < total,
  });
});


// DELETE /api/brain/spaces/:spaceId/memories/:id
memoriesRouter.delete('/spaces/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  /*
   * `M-2`: what points at this record can be SEEN now, so under strict linkage it can also block.
   *
   * Until the three unread link fields gained readers, deleting a memory that another record named was
   * never refused — the reference existed, was stored and replicated, and nothing could see it. The naming
   * record was then left pointing at something that does not exist, which is the outcome `strictLinkage` is
   * bought to prevent.
   *
   * ONE guard for both doors, and the same one entities use: the sentence and the rows come from
   * `entityDeleteBlockers`, and each door decides only how to report them.
   *
   * `409` and not `404`: the record IS there, and the caller needs to know which references to clear.
   */
  for (const mid of memberSpacesForRequest(req, spaceId)) {
    const block = await entityDeleteBlockers(mid, id, 'fact');
    if (block) {
      res.status(409).json({ error: block.message, backlinks: block.blocking, references: block.backlinks });
      return;
    }
    if (await deleteMemory(mid, id, webhookToken(req))) { res.status(204).end(); return; }
  }
  res.status(404).json({ error: 'Memory not found' });
});


// PATCH /api/brain/spaces/:spaceId/memories/:id — partial update a memory (long-form)
/**
 * The body keys the memories UPDATE reads.
 *
 * Its own list, not the create's: `deleteFields` is an update field and `id` is a path parameter
 * here. Copying the create's would produce an "unknown field" warning about a parameter that works,
 * which is what the drift check in
 * `an-update-answers-the-same-questions-a-create-does-db.test.js` exists to refuse.
 *
 * The shared write options — ttlDays, waitForEmbedding, the duplicate flags and the two suppression
 * spellings — are NOT listed: they are read by helpers, and live in `SHARED_WRITE_BODY_KEYS`.
 */
const MEMORIES_UPDATE_BODY_KEYS = ['fact', 'tags', 'entityIds', 'description', 'properties', 'deleteFields', 'type'];
memoriesRouter.patch('/spaces/:spaceId/memories/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  // `M-2`: on a converted space the six arrays are no longer a write surface — see `arrayWriteError`.
  // Checked against the WRITE TARGET, which on a proxy is the member space that will hold the record: the
  // proxy itself holds nothing and its own marker would answer for a space it never writes to.
  const linkArrErr = arrayWriteError({ converted: usesLinkRecords(wt.target), spaceId: wt.target, body: req.body,
    actor: requestActor(req) });
  if (linkArrErr) { res.status(400).json({ error: linkArrErr }); return; }
  const ifMatch = ifMatchFromRequest(req);
  if (!ifMatch.ok) { res.status(400).json({ error: ifMatch.error }); return; }
  const { fact, tags, entityIds, description, properties, deleteFields, type: memoryType } = req.body ?? {};
  // Validate deleteFields
  const dfResult = validateDeleteFields(deleteFields);
  if (!dfResult.ok) { res.status(400).json({ error: dfResult.error }); return; }
  const ttlErr = ttlDaysError(req.body);
  if (ttlErr) { res.status(400).json({ error: ttlErr }); return; }
  // `W-14`..`W-22`: what a VALUE must look like, from the one table this door and its twin both read.
  // AFTER the checks above, so every refusal this door already made keeps its own wording; this catches
  // only what used to get through. Requiredness stays above — a create demands its fields, an update
  // must not.
  const shapeErr = shapeError('fact', req.body);
  if (shapeErr) { res.status(400).json({ error: shapeErr }); return; }

  // `F-27`: the one-call write. Shape and well-formedness here; existence is the writer's job, in one query.
  // `F-27`: the one-call write — links and labelled edges together. Shape here; existence at the writer.
  const connErr = connectionInputError(req.body);
  if (connErr) { res.status(400).json({ error: connErr }); return; }
  const ttlDaysProvided = !!req.body && typeof req.body === 'object' && 'ttlDays' in req.body;
  const dfPaths: string[] | undefined = Array.isArray(deleteFields) && deleteFields.length > 0 ? deleteFields : undefined;
  const updates: { fact?: string; type?: string; tags?: string[]; entityIds?: string[]; description?: string; properties?: Record<string, string | number | boolean>; suppressEmbeddings?: boolean } = {};
  // `type` was accepted on CREATE and silently DROPPED here: this handler never destructured it, so a caller PATCHing
  // a memory's type got 200 and no change. `updateMemory` has always accepted it and writes `$set.type`, so the field
  // was plumbed the whole way down and lost at the door. An empty string CLEARS it, which is how the UI unsets a type —
  // the store distinguishes `undefined` (leave alone) from `''` (write empty), and this route must preserve that.
  if (memoryType !== undefined) {
    if (typeof memoryType !== 'string') { res.status(400).json({ error: '`type` must be a string' }); return; }
    updates.type = memoryType.trim();
  }
  if (fact !== undefined) {
    if (typeof fact !== 'string' || !fact.trim()) { res.status(400).json({ error: '`fact` must be a non-empty string' }); return; }
    updates.fact = fact;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`tags` must be an array of strings' }); return; }
    updates.tags = tags;
  }
  if (entityIds !== undefined) {
    if (!Array.isArray(entityIds) || entityIds.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`entityIds` must be an array of strings' }); return; }
    /*
     * `W-16`: EXISTENCE, not just shape — the same `assertRefsResolve` the create route, `remember` and
     * `update_fact` all call. This door alone ran `UUID_V4_RE.test` and stopped, so a syntactically
     * perfect id pointing at nothing was stored.
     *
     * The create route's own comment is the argument: *"a syntactically perfect id pointing at nothing
     * stores exactly as silently as a name did, and the dangling link only shows up later as a traversal
     * that comes back empty."* That was written about this route's sibling, three hundred lines up.
     */
    if (isStrictLinkage(wt.target)) {
      try {
        await assertRefsResolve(wt.target, 'entityIds', 'entity', entityIds as string[]);
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
    updates.entityIds = entityIds;
  }
  if (description !== undefined) {
    if (typeof description !== 'string') { res.status(400).json({ error: '`description` must be a string' }); return; }
    updates.description = description;
  }
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) { res.status(400).json({ error: '`properties` must be a plain object' }); return; }
    updates.properties = properties as Record<string, string | number | boolean>;
  }
  // A boolean, and the ONLY field a caller may send on its own — retiring a record from vector search is a
  // complete edit in itself. It was wired into the update functions and into no PATCH handler, so it
  // shipped unreachable over REST; a caller sending it alone was told they had sent no fields at all.
  const sup = parseRecordSuppression(req.body);
  if (!sup.ok) { res.status(400).json({ error: sup.error }); return; }
  if (sup.value !== undefined) updates.suppressEmbeddings = sup.value;
  if (Object.keys(updates).length === 0 && !dfPaths && !ttlDaysProvided) { res.status(400).json({ error: 'At least one field must be provided' }); return; }
  const memberIds = resolveMemberSpaces(wt.target);
  for (const mid of memberIds) {
    // Validate the record AS IT WILL BE, on every patch — not only when `deleteFields` is present.
    //
    // That branch used to be the whole of update validation, so any other patch wrote values the same
    // space rejects at create time. Merging first is what makes the check meaningful: a required property
    // the patch does not mention is present in the record and absent from the patch, so validating the
    // fragment answers a question nobody asked.
    //
    // The read this needs is the same one the audit snapshot below needed, so it is done once and shared
    // rather than issued twice per patch.
    const existing = await listMemories(mid, { _id: id }, 1, 0);
    if (existing.length === 0) continue;
    /*
     * The schema check moved into `updateMemory`.
     *
     * This block SIMULATED the merge — `mergePropertiesOrKeep` plus a throwaway `applyDeleteFieldsPaths` —
     * and validated that. Two implementations of "what will this record look like", twenty lines apart, and
     * the simulation is the one that drifts: it was validating the wrong `type` on a re-type for months while
     * the entity route next door did it correctly. The writer validates the record it is actually about to
     * store, so there is nothing left here to get wrong.
     *
     * The 422 is preserved: this route has always answered 422 where the create answers 400.
     */
    let updated;
    let check: UpdateValidation | undefined;
    try {
      updated = await updateMemory(mid, id, updates, dfPaths, webhookToken(req), ttlDaysFromBody(req.body), ifMatch.seq,
        c => { check = c; });
    } catch (err) {
      if (err instanceof SchemaViolationError) {
        res.status(422).json({
          error: 'schema_violation', message: err.check.message, violations: err.check.all,
          introduced: err.check.introduced, preExisting: err.check.preExisting,
        });
        return;
      }
      throw err;
    }
    if (updated) {
      req.auditSnapshots = { before: existing[0] ?? {}, after: updated };
      /*
       * The `warnings` array an update response did not have.
       *
       * A `warn`-mode space reported its violations on a CREATE and said nothing on an update — the writer
       * computed the classification and handed it back through `onValidation`, and this route never took
       * it. So the same edit was described differently depending on whether the record already existed.
       *
       * The unknown-field rows ride in the same array, in the same shape, for the reason the creates give:
       * two warning channels on one response would be worse than the silence they replace.
       */
      const warnings = [...(check?.warnings ?? []), ...unknownFieldWarnings(req.body, MEMORIES_UPDATE_BODY_KEYS)];
      res.json(warnings.length > 0 ? { ...updated, warnings } : updated);
      return;
    }
    // See the note in entities.ts: with a precondition in play, a write that matched nothing is a 412
    // and must not fall through to the next member space.
    if (ifMatch.seq !== undefined) {
      res.status(412).json(preconditionFailedBody('fact', (await listMemories(mid, { _id: id }, 1, 0))[0]?.seq));
      return;
    }
  }
  res.status(404).json({ error: 'Memory not found' });
});


// DELETE /api/brain/spaces/:spaceId/memories — bulk wipe (long-form)
memoriesRouter.delete('/spaces/:spaceId/memories', bulkWipeRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  if (isProxySpace(spaceId)) {
    res.status(400).json({ error: 'Bulk wipe not supported on proxy spaces — target member spaces individually' });
    return;
  }
  if (req.body?.confirm !== true) {
    res.status(400).json({ error: '`confirm: true` required in request body' });
    return;
  }
  const deleted = await bulkDeleteMemories(spaceId);
  res.json({ deleted });
});
