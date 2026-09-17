/**
 * Chrono entry CRUD routes (/api/brain/spaces/:spaceId/chrono).
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { requestActor } from '../../auth/request-actor.js';
import { shapeError } from '../../brain/write-shape.js';
import { usesLinkRecords } from '../../brain/link-adjacency.js';
import { arrayWriteError } from '../../brain/array-write-refusal.js';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { unknownFieldWarnings } from './unknown-fields.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { createChrono, updateChrono, getChronoById, listChrono, deleteChrono, parseRecurrence, ChronoFilter } from '../../brain/chrono.js';
import { getConfig } from '../../config/loader.js';
import { parseLimit, parseSkip, unsupportedPageParam } from '../../util/pagination.js';
import { pageAcrossMembers } from '../../spaces/page-across-members.js';
import { countBrain, compareBySort, PROXY_PAGE_CEILING } from '../../brain/query.js';
import { memberSpacesForRequest } from '../../spaces/proxy-scoped.js';
import { entityDeleteBlockers } from '../../brain/entity-delete-guard.js';
import { parseSortParam, SORTABLE_FIELDS, toMongoSort } from '../../brain/list-sort.js';
import { resolveWriteTarget, isProxySpace, isStrictLinkage, findFirstAcrossMembers, collectAcrossMembers } from '../../spaces/proxy.js';
import { validateChrono, getAllowedChronoTypes } from '../../spaces/schema-validation.js';
import { validateDeleteFields } from '../../brain/delete-fields.js';
import { CHRONO_STATUSES } from '../../config/types.js';
import type { ChronoStatus } from '../../config/types.js';
import { UUID_V4_RE, webhookToken, getSpaceMeta, applyValidation, ttlDaysFromBody, ttlDaysError, dupeCheckOptsFromBody, ifMatchFromRequest, preconditionFailedBody } from './_shared.js';
import { SchemaViolationError, type UpdateValidation } from '../../brain/write-validation.js';
import { resolveEntityIdsByName } from '../../brain/entities.js';
import { attachedToEntityNamed } from '../../brain/entity-name-scope.js';
import { mergePropertiesOrKeep } from '../../brain/merge-fields.js';
import {
  parseRecordSuppression, RECORD_SUPPRESS_FIELD,
} from '../../brain/suppress-embeddings.js';
import { withoutListDiagnostics } from '../../brain/read-projection.js';
import { listDiagnosticsAsked } from './_shared.js';
import { connectionInputError, applyConnections, CONNECTION_BODY_KEYS } from '../../brain/write-connections.js';

export const chronoRouter = Router();


// ── Chrono CRUD ───────────────────────────────────────────────────────────────

// DERIVED. These five were written out here, in `brain/bulk.ts`, and in the shared write-shape table —
// three copies of one product fact, and the third had two of them wrong.
const CHRONO_STATUS_SET = new Set<ChronoStatus>(CHRONO_STATUSES);

// POST /api/brain/spaces/:spaceId/chrono — create a chrono entry
/**
 * The body keys the chrono create reads.
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
const CHRONO_CREATE_BODY_KEYS = ['title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'tags', 'entityIds', 'memoryIds', 'description', 'properties', 'recurrence', 'id',
  ...CONNECTION_BODY_KEYS];
chronoRouter.post('/spaces/:spaceId/chrono', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
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

  const { title, type, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  // `recurrence` was previously persisted straight from the request body with NO shape
  // check — unlike every sibling field — so an arbitrary object could be stored and later
  // read as a recurrence rule. Shared with MCP so both surfaces enforce the same shape.
  const recCheck = parseRecurrence(recurrence);
  if (!recCheck.ok) { res.status(400).json({ error: recCheck.error }); return; }
  const safeRecurrence = recCheck.value;
  if (!title || typeof title !== 'string') {
    res.status(400).json({ error: '`title` string required' }); return;
  }
  const meta = getSpaceMeta(wt.target);
  const allowedChronoTypes = getAllowedChronoTypes(meta);
  if (!type || !allowedChronoTypes.has(type)) {
    res.status(400).json({ error: `\`type\` must be one of: ${[...allowedChronoTypes].join(', ')}` }); return;
  }
  if (!startsAt || typeof startsAt !== 'string') {
    res.status(400).json({ error: '`startsAt` ISO8601 string required' }); return;
  }
  if (endsAt !== undefined && typeof endsAt !== 'string') {
    res.status(400).json({ error: '`endsAt` must be an ISO8601 string' }); return;
  }
  if (status !== undefined && !CHRONO_STATUS_SET.has(status)) {
    res.status(400).json({ error: '`status` must be one of: upcoming, active, completed, overdue, cancelled' }); return;
  }
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    res.status(400).json({ error: '`confidence` must be a number between 0 and 1' }); return;
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`tags` must be an array of strings' }); return;
  }
  if (entityIds !== undefined && (!Array.isArray(entityIds) || entityIds.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`entityIds` must be an array of strings' }); return;
  }
  if (entityIds !== undefined) {
    if (isStrictLinkage(wt.target)) {
      const invalidEIds = (entityIds as string[]).filter((id: string) => !UUID_V4_RE.test(id));
      if (invalidEIds.length > 0) { res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidEIds }); return; }
    }
  }
  if (memoryIds !== undefined && (!Array.isArray(memoryIds) || memoryIds.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`memoryIds` must be an array of strings' }); return;
  }
  if (memoryIds !== undefined) {
    if (isStrictLinkage(wt.target)) {
      const invalidMIds = (memoryIds as string[]).filter((id: string) => !UUID_V4_RE.test(id));
      if (invalidMIds.length > 0) { res.status(400).json({ error: '`memoryIds` must contain valid UUID v4 values (fact IDs), not names', invalid: invalidMIds }); return; }
    }
  }
  if (description !== undefined && typeof description !== 'string') {
    res.status(400).json({ error: '`description` must be a string' }); return;
  }
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    res.status(400).json({ error: '`properties` must be a plain object' }); return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;

  // A caller-supplied id becomes the sync identity of a record that replicates across networks, so it is held
  // to the same shape the rest of the API uses. (The entity route accepts any string here — pre-existing, and
  // tightening it would be a breaking change, so it is filed rather than copied.)
  const rawId: unknown = req.body?.['id'];
  if (rawId !== undefined && (typeof rawId !== 'string' || !UUID_V4_RE.test(rawId))) {
    res.status(400).json({ error: '`id` must be a UUID v4 when supplied. Omit it to have one generated, or reuse the same value to make a retry idempotent.' });
    return;
  }
  const safeId: string | undefined = typeof rawId === 'string' ? rawId : undefined;

  // Schema validation of the record this write will PRODUCE, not of the payload.
  //
  // A supplied id that already names an entry CONVERGES, and the converge branch stores
  // `mergeProperties(existing, incoming)` — so validating the payload alone checked a document that is not
  // the one written. It failed both ways: a required key present on the stored record and absent from the
  // request read as a violation and 400d a legitimate converge, while a violating key already stored was
  // never re-examined. Entities and edges have validated the merged form since their upserts were written;
  // this was the fourth path, and the id had to move above the check to make it possible.
  // The check moved into `createChrono`, so no caller can reach the collection around it — three copies of
  // this rule existed for create and two for update. The response shape is preserved by catching the refusal.
  let check: UpdateValidation | undefined;

  const ttlErr = ttlDaysError(req.body);
  if (ttlErr) { res.status(400).json({ error: ttlErr }); return; }
  // `W-14`..`W-22`: what a VALUE must look like, from the one table this door and its twin both read.
  // AFTER the checks above, so every refusal this door already made keeps its own wording; this catches
  // only what used to get through. Requiredness stays above — a create demands its fields, an update
  // must not.
  const shapeErr = shapeError('chrono', req.body);
  if (shapeErr) { res.status(400).json({ error: shapeErr }); return; }
  // `F-27`: the one-call write — links and labelled edges together. Shape here; existence at the writer.
  const connErr = connectionInputError(req.body);
  if (connErr) { res.status(400).json({ error: connErr }); return; }


  // `waitForEmbedding` (default false): the vector is normally computed by the embedding queue
  // moments after this returns. Pass true when the caller will search for, scan, or compare what it
  // just wrote — none of those can see a record that has no vector yet.
  const waitForEmbedding = req.body?.waitForEmbedding;
  if (waitForEmbedding !== undefined && typeof waitForEmbedding !== 'boolean') {
    res.status(400).json({ error: '`waitForEmbedding` must be a boolean' });
    return;
  }
  // Same insert-time check as the other two write paths, and the same shared reader — `createChrono`
  // already merges `similar` and `contradicts` into what it returns, so the spread below reports them.
  const dupe = dupeCheckOptsFromBody(req.body);
  if ('error' in dupe) { res.status(400).json({ error: dupe.error }); return; }
  const writeOpts = { ...dupe.opts, ...(waitForEmbedding === true ? { waitForEmbedding: true } : {}) };
  const embedOpts = Object.keys(writeOpts).length > 0 ? writeOpts : undefined;
  let entry;
  try {
    entry = await createChrono(wt.target, {
      title: title.trim(), type, startsAt, endsAt, status, confidence,
      tags, entityIds, memoryIds, description, properties: safeProps, recurrence: safeRecurrence,
      id: safeId,
    }, webhookToken(req), ttlDaysFromBody(req.body), { ...(embedOpts ?? {}), onValidation: c => { check = c; } });
  } catch (err) {
    if (err instanceof SchemaViolationError) {
      res.status(400).json({
        error: 'schema_violation', message: err.check.message, violations: err.check.all,
        introduced: err.check.introduced, preExisting: err.check.preExisting,
      });
      return;
    }
    throw err;
  }
  /*
   * `F-27`: the relationships this write asked for, in the same call.
   *
   * AFTER the record exists, because a relationship needs both ends and the `from` is what was just minted.
   * Links REPLACE per class and edges UPSERT — both semantics live in `applyConnections`, so no door has to
   * restate them and no two doors can disagree about them.
   */
  await applyConnections(wt.target, entry._id, 'chrono', req.body, entry.author, webhookToken(req));

  const result: Record<string, unknown> = { ...entry };
  // The schema warnings a `warn` space produces, plus the keys this route did not understand — one
  // array, one shape. A second channel for the second kind would be worse than the silence it replaces.
  const warnings = [...(check?.warnings ?? []), ...unknownFieldWarnings(req.body, CHRONO_CREATE_BODY_KEYS)];
  if (warnings.length > 0) result['warnings'] = warnings;
  res.status(201).json(result);
});


// PATCH /api/brain/spaces/:spaceId/chrono/:id — partial update a chrono entry by ID
/**
 * The body keys the chrono UPDATE reads.
 *
 * Its own list, not the create's: `deleteFields` is an update field and `id` is a path parameter
 * here. Copying the create's would produce an "unknown field" warning about a parameter that works,
 * which is what the drift check in
 * `an-update-answers-the-same-questions-a-create-does-db.test.js` exists to refuse.
 *
 * The shared write options — ttlDays, waitForEmbedding, the duplicate flags and the two suppression
 * spellings — are NOT listed: they are read by helpers, and live in `SHARED_WRITE_BODY_KEYS`.
 */
const CHRONO_UPDATE_BODY_KEYS = ['title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'tags', 'entityIds', 'memoryIds', 'description', 'properties', 'recurrence', 'deleteFields'];
chronoRouter.patch('/spaces/:spaceId/chrono/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
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

  const { title, type, startsAt, endsAt, status, confidence, tags, entityIds, memoryIds, description, properties, recurrence } = req.body ?? {};
  // `recurrence` was previously persisted straight from the request body with NO shape
  // check — unlike every sibling field — so an arbitrary object could be stored and later
  // read as a recurrence rule. Shared with MCP so both surfaces enforce the same shape.
  const recCheck = parseRecurrence(recurrence);
  if (!recCheck.ok) { res.status(400).json({ error: recCheck.error }); return; }
  const safeRecurrence = recCheck.value;
  if (status !== undefined && !CHRONO_STATUS_SET.has(status)) {
    res.status(400).json({ error: '`status` must be one of: upcoming, active, completed, overdue, cancelled' }); return;
  }
  if (type !== undefined) {
    const allowedChronoTypes = getAllowedChronoTypes(getSpaceMeta(wt.target));
    if (!allowedChronoTypes.has(type)) {
      res.status(400).json({ error: `\`type\` must be one of: ${[...allowedChronoTypes].join(', ')}` }); return;
    }
  }
  if (confidence !== undefined && (typeof confidence !== 'number' || confidence < 0 || confidence > 1)) {
    res.status(400).json({ error: '`confidence` must be a number between 0 and 1' }); return;
  }
  if (entityIds !== undefined && Array.isArray(entityIds) && isStrictLinkage(wt.target)) {
    const invalidEIds = entityIds.filter((id: string) => !UUID_V4_RE.test(id));
    if (invalidEIds.length > 0) { res.status(400).json({ error: '`entityIds` must contain valid UUID v4 values (entity IDs), not names', invalid: invalidEIds }); return; }
  }
  if (memoryIds !== undefined && Array.isArray(memoryIds) && isStrictLinkage(wt.target)) {
    const invalidMIds = memoryIds.filter((id: string) => !UUID_V4_RE.test(id));
    if (invalidMIds.length > 0) { res.status(400).json({ error: '`memoryIds` must contain valid UUID v4 values (fact IDs), not names', invalid: invalidMIds }); return; }
  }
  if (properties !== undefined && (typeof properties !== 'object' || properties === null || Array.isArray(properties))) {
    res.status(400).json({ error: '`properties` must be a plain object' }); return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;

  const ttlErr = ttlDaysError(req.body);
  if (ttlErr) { res.status(400).json({ error: ttlErr }); return; }
  // `W-14`..`W-22`: what a VALUE must look like, from the one table this door and its twin both read.
  // AFTER the checks above, so every refusal this door already made keeps its own wording; this catches
  // only what used to get through. Requiredness stays above — a create demands its fields, an update
  // must not.
  const shapeErr = shapeError('chrono', req.body);
  if (shapeErr) { res.status(400).json({ error: shapeErr }); return; }

  // A boolean, and the ONLY field a caller may send on its own — retiring a record from vector search is a
  // complete edit in itself. Chrono is the FOURTH type, and it was missed when the other three were swept:
  // the writer beneath has accepted the field from the start (and ends every toggle in an embed job that
  // handles both directions), while this handler destructured a fixed list that never contained it. So a
  // patch carrying only this flag was not refused — it answered 200 with an unchanged record, which is the
  // worse half of the same defect: the other three at least said "At least one field must be provided".
  const sup = parseRecordSuppression(req.body);
  if (!sup.ok) { res.status(400).json({ error: sup.error }); return; }
  const suppressEmbeddings = sup.value;

  // Nothing this handler recognises is an ERROR, not a 200 with an unchanged record. The three sibling
  // PATCH handlers have always answered `At least one field must be provided`; chrono answered success,
  // so a client could not tell a no-op from an applied change — which is exactly how the missing flag
  // above stayed invisible. Unknown keys are still dropped rather than named back (documented in the
  // integration guide); what is no longer possible is dropping ALL of them and calling it success.
  // Both spellings of the record tier, from the constants rather than as two literals. This list decides
  // whether the caller sent anything AT ALL, and it is a separate question from whether the value parses —
  // so naming only the new spelling here made a legacy-only PATCH answer `At least one field must be
  // provided` while `parseRecordSuppression` was perfectly willing to read it. Accepted by one half and
  // refused by the other is worse than not accepting it, and CI caught exactly that.
  const PATCHABLE_FIELDS = [
    'title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'tags', 'entityIds', 'memoryIds',
    'description', 'properties', 'recurrence', 'ttlDays', 'deleteFields',
    RECORD_SUPPRESS_FIELD,
  ];
  const body = req.body != null && typeof req.body === 'object' ? req.body as Record<string, unknown> : {};
  if (!PATCHABLE_FIELDS.some(f => f in body)) {
    res.status(400).json({ error: 'At least one field must be provided' });
    return;
  }

  // X-4: chrono was the one record type with no `deleteFields`, and its `properties` merge, so a key written
  // once could never be removed by any request. Validated here exactly as the three sibling routes do it —
  // same helper, same refusals, same 400 — because a fourth spelling of one rule is the defect this repo
  // produces most.
  const dfResult = validateDeleteFields(body['deleteFields']);
  if (!dfResult.ok) {
    res.status(400).json({ error: dfResult.error });
    return;
  }
  const dfPaths: string[] | undefined = Array.isArray(body['deleteFields']) && body['deleteFields'].length > 0
    ? body['deleteFields'] as string[]
    : undefined;

  // Snapshot for the audit change list — see the note in facts.ts. Read before the write, since
  // `updateChrono` returns only the new document.
  const prior = await findFirstAcrossMembers(wt.target, mid => getChronoById(mid, id));

  // Validate the entry AS IT WILL BE. This path had NO property validation at all — the `type` allowlist
  // above was the whole of it — so a patch could write a property the same space rejects at create time.
  // Merging first is what makes the check meaningful: a required property the patch does not mention is
  // present in the record and absent from the patch.
  /*
   * The check moved into `updateChrono`. This block simulated the merge — `mergePropertiesOrKeep` against
   * `prior`, twenty lines from the function that does the real one — and a simulation is the copy that
   * drifts, because nothing fails when it stops matching. It also could not see `deleteFields`, so a patch
   * that REMOVED a required property passed here and was written.
   *
   * The 422 is preserved: this route has always answered 422 where the create answers 400.
   */
  let updated;
  let updateCheck: UpdateValidation | undefined;
  try {
    updated = await findFirstAcrossMembers(wt.target, mid => updateChrono(mid, id, {
      title, type, startsAt, endsAt, status, confidence,
      tags, entityIds, memoryIds, description, properties: safeProps, recurrence: safeRecurrence,
      suppressEmbeddings,
    }, dfPaths, webhookToken(req), ttlDaysFromBody(req.body), ifMatch.seq, c => { updateCheck = c; }));
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
    req.auditSnapshots = { before: prior ?? {}, after: updated };
    // The `warnings` array an update response did not have — see the facts route, where the
    // reasoning is written out. A warn-mode space reported on a create and said nothing on an edit.
    const updateWarnings = [...(updateCheck?.warnings ?? []), ...unknownFieldWarnings(req.body, CHRONO_UPDATE_BODY_KEYS)];
    res.json(updateWarnings.length > 0 ? { ...updated, warnings: updateWarnings } : updated);
    return;
  }
  // `prior` proves the entry was there when this handler read it, so a write that matched nothing was
  // stopped by the precondition rather than by the entry being absent. Without `prior` the honest answer
  // is still 404. Same rule as the other three routes, expressed against this one's `findFirstAcrossMembers`
  // shape rather than a loop.
  if (ifMatch.seq !== undefined && prior) {
    const current = await findFirstAcrossMembers(wt.target, mid => getChronoById(mid, id));
    res.status(412).json(preconditionFailedBody('chrono entry', current?.seq));
    return;
  }
  res.status(404).json({ error: 'Chrono entry not found' });
});


// GET /api/brain/spaces/:spaceId/chrono/:id
chronoRouter.get('/spaces/:spaceId/chrono/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const doc = await findFirstAcrossMembers(spaceId, mid => getChronoById(mid, id));
  if (doc) { res.json(doc); return; }
  res.status(404).json({ error: 'Chrono entry not found' });
});


// GET /api/brain/spaces/:spaceId/chrono
chronoRouter.get('/spaces/:spaceId/chrono', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = parseLimit(req.query['limit'], 50, 500);
  // A pagination name we do not have is a 400 naming the one we do — the fleet integrator paged with `offset`, which was accepted
  // and ignored, and summed 67 identical pages into a count 67x the truth.
  const badParam = unsupportedPageParam(req.query as Record<string, unknown>);
  if (badParam) { res.status(400).json(badParam); return; }
  const skip = parseSkip(req.query['skip']);
  const sortParse = parseSortParam(req.query['sort'], req.query['dir'], SORTABLE_FIELDS.chrono);
  if ('error' in sortParse) {
    res.status(400).json({ error: sortParse.error });
    return;
  }
  const filter: ChronoFilter = {};
  if (typeof req.query['status'] === 'string') filter.status = req.query['status'];
  if (typeof req.query['type'] === 'string') filter.type = req.query['type'];

  // tags — comma-separated or repeated — AND semantics
  if (Array.isArray(req.query['tags'])) {
    filter.tags = (req.query['tags'] as string[]).flatMap(t => t.split(',').map(s => s.trim())).filter(Boolean);
  } else if (typeof req.query['tags'] === 'string') {
    filter.tags = req.query['tags'].split(',').map(s => s.trim()).filter(Boolean);
  } else if (typeof req.query['tag'] === 'string') {
    // Singular `?tag=` is the UI's search box: substring, not an exact set.
    filter.tagLike = req.query['tag'];
  }
  if (typeof req.query['description'] === 'string') filter.descriptionLike = req.query['description'];
  if (typeof req.query['properties'] === 'string') filter.propertiesLike = req.query['properties'];

  // tagsAny — comma-separated or repeated — OR semantics
  if (Array.isArray(req.query['tagsAny'])) {
    filter.tagsAny = (req.query['tagsAny'] as string[]).flatMap(t => t.split(',').map(s => s.trim())).filter(Boolean);
  } else if (typeof req.query['tagsAny'] === 'string') {
    filter.tagsAny = req.query['tagsAny'].split(',').map(s => s.trim()).filter(Boolean);
  }

  if (typeof req.query['after'] === 'string') filter.after = req.query['after'];
  if (typeof req.query['before'] === 'string') filter.before = req.query['before'];
  if (typeof req.query['search'] === 'string') filter.search = req.query['search'];

  // The Entities column shows entity NAMES; records store ids. Resolved per member for the same reason
  // as edges: an id belongs to the member that owns it. An empty resolution filters to nothing, which is
  // correct — "no entity by that name" must not fall back to showing everything.
  const entityName = typeof req.query['entityName'] === 'string' ? req.query['entityName'] : undefined;
  const filterFor = async (mid: string): Promise<Record<string, unknown>> => {
    const perMember: Record<string, unknown> = { ...filter };
    // BOTH shapes, through the shared predicate. Reading the array alone missed every record written
    // with `linkEntities` — the form the guide leads with — and answered with an empty list, which
    // reads as "there are none" rather than "this filter cannot see them".
    if (entityName) Object.assign(perMember, await attachedToEntityNamed(mid, 'chrono', entityName));
    return perMember;
  };
  const members = memberSpacesForRequest(req, spaceId);
  const page = await pageAcrossMembers<Record<string, unknown>>({
    members, limit, skip, ceiling: PROXY_PAGE_CEILING,
    compare: compareBySort(sortParse.sort ? toMongoSort(sortParse.sort) : { createdAt: -1, _id: -1 }),
    readMember: async (mid, lim, sk) => await listChrono(mid, await filterFor(mid), lim, sk, sortParse.sort) as unknown as Record<string, unknown>[],
  });
  if (!page.ok) { res.status(400).json({ error: page.error }); return; }
  let total = 0;
  for (const mid of members) total += await countBrain(mid, 'chrono', await filterFor(mid));
  res.json({ chrono: withoutListDiagnostics(page.rows, listDiagnosticsAsked(req)),
    limit, skip, total, truncated: skip + page.rows.length < total });
});


// DELETE /api/brain/spaces/:spaceId/chrono/:id
chronoRouter.delete('/spaces/:spaceId/chrono/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  /*
   * `M-2`: what points at this chrono entry can be SEEN now, so under strict linkage it can also block.
   *
   * Until the three unread link fields gained readers, deleting a record another one named was never refused
   * — the reference existed, was stored and replicated, and nothing could see it. The naming record was then
   * left pointing at something that does not exist, which is the outcome `strictLinkage` is bought to
   * prevent. Here the naming record is a FILE, through `file.chronoIds`.
   *
   * ONE guard for both doors, and the same one entities use. `409` and not `404`: the record IS there.
   */
  for (const mid of memberSpacesForRequest(req, spaceId)) {
    const block = await entityDeleteBlockers(mid, id, 'chrono');
    if (block) {
      res.status(409).json({ error: block.message, backlinks: block.blocking, references: block.backlinks });
      return;
    }
    if (await deleteChrono(mid, id, webhookToken(req))) { res.status(204).end(); return; }
  }
  res.status(404).json({ error: 'Chrono entry not found' });
});


