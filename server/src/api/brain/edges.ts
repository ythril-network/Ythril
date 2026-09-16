/**
 * Edge CRUD routes (/api/brain/spaces/:spaceId/edges).
 *
 * Split out of the api/brain.ts monolith (A17.3); handlers are unchanged.
 */
import { Router } from 'express';
import { shapeError } from '../../brain/write-shape.js';
import { assertRefsResolve, edgeEndpointKind, collectionForRefKind, endpointNameField } from '../../brain/entity-refs.js';
import { REF_KINDS } from '../../config/types-knowledge.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { requireSpaceAuth, denyReadOnly } from '../../auth/middleware.js';
import { unknownFieldWarnings } from './unknown-fields.js';
import { globalRateLimit } from '../../rate-limit/middleware.js';
import { listEdges, deleteEdge, upsertEdge, getEdgeById, updateEdgeById, EdgeSchemaViolation } from '../../brain/edges.js';
import { bulkDeleteEdges } from '../../brain/edge-bulk-delete.js';
import { EdgeIdentityTaken } from '../../brain/edge-rekey.js';
import { validateDeleteFields, applyDeleteFields as applyDeleteFieldsPaths } from '../../brain/delete-fields.js';
import { getConfig } from '../../config/loader.js';
import { col, asFilter } from '../../db/mongo.js';
import { parseLimit, parseSkip, unsupportedPageParam } from '../../util/pagination.js';
import { pageAcrossMembers } from '../../spaces/page-across-members.js';
import { countBrain, compareBySort, PROXY_PAGE_CEILING } from '../../brain/query.js';
import { memberSpacesForRequest } from '../../spaces/proxy-scoped.js';
import { parseSortParam, SORTABLE_FIELDS, toMongoSort } from '../../brain/list-sort.js';
import { resolveMemberSpaces, resolveWriteTarget, isProxySpace, isStrictLinkage, findFirstAcrossMembers, collectAcrossMembers } from '../../spaces/proxy.js';
import { validateEdge } from '../../spaces/schema-validation.js';
import { UUID_V4_RE, webhookToken, getSpaceMeta, ttlDaysFromBody, ttlDaysError, ifMatchFromRequest, preconditionFailedBody } from './_shared.js';
import { SchemaViolationError, type UpdateValidation } from '../../brain/write-validation.js';
import { resolveEntityIdsByName } from '../../brain/entities.js';
import { mergePropertiesOrKeep } from '../../brain/merge-fields.js';
import { parseRecordSuppression } from '../../brain/suppress-embeddings.js';
import { withoutListDiagnostics } from '../../brain/read-projection.js';
import { listDiagnosticsAsked } from './_shared.js';

export const edgesRouter = Router();


// POST /api/brain/spaces/:spaceId/edges — create/upsert an edge
/**
 * The body keys the edges create reads.
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
const EDGES_CREATE_BODY_KEYS = ['from', 'to', 'label', 'weight', 'type', 'description', 'properties', 'tags', 'fromKind', 'toKind'];
edgesRouter.post('/spaces/:spaceId/edges', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const { from, to, label, weight, type, description, properties, tags, fromKind, toKind } = req.body ?? {};
  if (!from || typeof from !== 'string') {
    res.status(400).json({ error: '`from` string required' });
    return;
  }
  // `from` is resolved below together with `to`, so both ends are reported at once rather than
  // making the caller fix one, retry, and discover the other.
  if (!to || typeof to !== 'string') {
    res.status(400).json({ error: '`to` string required' });
    return;
  }
  /*
   * The endpoint kinds are validated BEFORE strict linkage runs, and unconditionally — a kind that is not one
   * of the four is a malformed request in every space, strict or not, and letting it through would store a
   * value nothing can resolve.
   */
  for (const [field, value] of [['fromKind', fromKind], ['toKind', toKind]] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !(REF_KINDS as readonly string[]).includes(value)) {
      res.status(400).json({ error: `\`${field}\` must be one of: ${REF_KINDS.join(', ')}` });
      return;
    }
  }
  if (isStrictLinkage(wt.target)) {
    try {
      // Each endpoint is resolved in the collection its own kind names. Passing `'entity'` here regardless —
      // which is what this did — would refuse every file-ended edge with "expects entity IDs (UUID v4)".
      await assertRefsResolve(wt.target, 'from', edgeEndpointKind(fromKind as RefKind | undefined), [from as string]);
      await assertRefsResolve(wt.target, 'to', edgeEndpointKind(toKind as RefKind | undefined), [to as string]);
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
      return;
    }
  }
  if (!label || typeof label !== 'string') {
    res.status(400).json({ error: '`label` string required' });
    return;
  }
  if (weight !== undefined && typeof weight !== 'number') {
    res.status(400).json({ error: '`weight` must be a number' });
    return;
  }
  if (type !== undefined && typeof type !== 'string') {
    res.status(400).json({ error: '`type` must be a string' });
    return;
  }
  if (description !== undefined && typeof description !== 'string') {
    res.status(400).json({ error: '`description` must be a string' });
    return;
  }
  if (tags !== undefined && (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string'))) {
    res.status(400).json({ error: '`tags` must be an array of strings' });
    return;
  }
  const safeProps: Record<string, string | number | boolean> | undefined =
    properties != null && typeof properties === 'object' && !Array.isArray(properties)
      ? (properties as Record<string, string | number | boolean>)
      : undefined;
  const safeTags: string[] | undefined = Array.isArray(tags) ? tags : undefined;

  const ttlErr = ttlDaysError(req.body);
  if (ttlErr) { res.status(400).json({ error: ttlErr }); return; }
  // `W-14`..`W-22`: what a VALUE must look like, from the one table this door and its twin both read.
  // AFTER the checks above, so every refusal this door already made keeps its own wording; this catches
  // only what used to get through. Requiredness stays above — a create demands its fields, an update
  // must not.
  const shapeErr = shapeError('edge', req.body);
  if (shapeErr) { res.status(400).json({ error: shapeErr }); return; }

  // `waitForEmbedding` (default false): the vector is normally computed by the embedding queue
  // moments after this returns. Pass true when the caller will search for, scan, or compare what it
  // just wrote — none of those can see a record that has no vector yet.
  const waitForEmbedding = req.body?.waitForEmbedding;
  if (waitForEmbedding !== undefined && typeof waitForEmbedding !== 'boolean') {
    res.status(400).json({ error: '`waitForEmbedding` must be a boolean' });
    return;
  }
  /*
   * The schema check lives in `upsertEdge` now, not here.
   *
   * It sat at this route and at the MCP tool — one rule written twice, and reachable around both:
   * `api/contradictions.ts` and `brain/bulk.ts` called `upsertEdge` directly and were never checked. Owner's
   * ruling, 2026-08-29: the write function validates. `onValidation` hands the classification back so this
   * response keeps its exact shape without a second `findEdgeByTriplet`.
   */
  let check: UpdateValidation | undefined;
  let edge;
  try {
    const supCreate = parseRecordSuppression(req.body);
    if (!supCreate.ok) { res.status(400).json({ error: supCreate.error }); return; }
    const createSuppress = supCreate.value;
    edge = await upsertEdge(
      wt.target, from.trim(), to.trim(), label.trim(), weight, type?.trim(),
      typeof description === 'string' ? description : undefined, safeProps, safeTags,
      webhookToken(req), ttlDaysFromBody(req.body),
      {
        ...(waitForEmbedding === true ? { waitForEmbedding: true } : {}),
        // The record tier, which no create path stated until 2026-09-02 — see `dupeCheckOptsFromBody`, which
        // is where the other three routes get it. This one builds its options inline.
        ...(createSuppress !== undefined ? { suppressEmbeddings: createSuppress } : {}),
        ...(fromKind !== undefined ? { fromKind: fromKind as RefKind } : {}),
        ...(toKind !== undefined ? { toKind: toKind as RefKind } : {}),
        onValidation: c => { check = c; },
      },
    );
  } catch (err) {
    if (err instanceof EdgeSchemaViolation) {
      const c = err.check;
      res.status(400).json({ error: 'schema_violation', message: c.message, violations: c.all, introduced: c.introduced, preExisting: c.preExisting });
      return;
    }
    throw err;
  }
  const result: Record<string, unknown> = { ...edge };
  // The schema warnings a `warn` space produces, plus the keys this route did not understand — one
  // array, one shape. A second channel for the second kind would be worse than the silence it replaces.
  const warnings = [...(check?.warnings ?? []), ...unknownFieldWarnings(req.body, EDGES_CREATE_BODY_KEYS)];
  if (warnings.length > 0) result['warnings'] = warnings;
  res.status(201).json(result);
});


// GET /api/brain/spaces/:spaceId/edges
edgesRouter.get('/spaces/:spaceId/edges', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const limit = parseLimit(req.query['limit'], 50, 200);
  // A pagination name we do not have is a 400 naming the one we do.
  const badParam = unsupportedPageParam(req.query as Record<string, unknown>);
  if (badParam) { res.status(400).json(badParam); return; }
  const skip = parseSkip(req.query['skip']);
  const sortParse = parseSortParam(req.query['sort'], req.query['dir'], SORTABLE_FIELDS.edges);
  if ('error' in sortParse) {
    res.status(400).json({ error: sortParse.error });
    return;
  }
  const filter: { from?: string; to?: string; label?: string; type?: string; tag?: string; search?: string; description?: string; properties?: string; fromIds?: string[]; toIds?: string[] } = {};
  if (typeof req.query['from'] === 'string') filter.from = req.query['from'];
  if (typeof req.query['to'] === 'string') filter.to = req.query['to'];
  if (typeof req.query['label'] === 'string') filter.label = req.query['label'];
  if (typeof req.query['type'] === 'string') filter.type = req.query['type'];
  if (typeof req.query['tag'] === 'string') filter.tag = req.query['tag'];
  if (typeof req.query['search'] === 'string') filter.search = req.query['search'];
  if (typeof req.query['description'] === 'string') filter.description = req.query['description'];
  if (typeof req.query['properties'] === 'string') filter.properties = req.query['properties'];
  // The From/To columns show entity NAMES; edges store ids. Resolve per member — an id belongs to the
  // member that owns it, so resolving against another's entities would match nothing while looking fine.
  const fromName = typeof req.query['fromName'] === 'string' ? req.query['fromName'] : undefined;
  const toName = typeof req.query['toName'] === 'string' ? req.query['toName'] : undefined;
  const filterFor = async (mid: string) => {
    const perMember = { ...filter };
    if (fromName) perMember.fromIds = await resolveEntityIdsByName(mid, fromName);
    if (toName) perMember.toIds = await resolveEntityIdsByName(mid, toName);
    return perMember;
  };
  const members = memberSpacesForRequest(req, spaceId);
  const page = await pageAcrossMembers<Record<string, unknown>>({
    members, limit, skip, ceiling: PROXY_PAGE_CEILING,
    compare: compareBySort(sortParse.sort ? toMongoSort(sortParse.sort) : { createdAt: -1, _id: -1 }),
    readMember: async (mid, lim, sk) =>
      await listEdges(mid, await filterFor(mid), lim, sk, sortParse.sort) as unknown as Record<string, unknown>[],
  });
  if (!page.ok) { res.status(400).json({ error: page.error }); return; }
  // Names are resolved for the PAGE, not for a whole per-member fetch: enriching rows that the window discards is work
  // whose result is thrown away.
  const all = page.rows as unknown as Awaited<ReturnType<typeof listEdges>>;
  /*
   * Batch-resolve each endpoint's display name so the client shows a name rather than a raw id.
   *
   * Grouped BY KIND, one `$in` per kind that actually appears. It used to be a single lookup in
   * `${mid}_entities`, which was right while every endpoint was an entity and shows a bare UUID for a chrono
   * or fact endpoint now that they can be one. The kind also decides which FIELD is the name — an entity
   * has `name`, a chrono entry `title`, a fact `fact` — so one query could not have served them anyway.
   *
   * A file needs no lookup at all: its id IS its path, and `fromName` stays absent so the client falls back
   * to showing that path, which is what a reader wants to see.
   */
  const nameMap = new Map<string, string>();
  const byKind = new Map<'entity' | 'fact' | 'chrono', Set<string>>();
  for (const e of all) {
    for (const [id, kind] of [[e.from, edgeEndpointKind(e.fromKind)], [e.to, edgeEndpointKind(e.toKind)]] as const) {
      if (kind === 'file') continue;
      if (!byKind.has(kind)) byKind.set(kind, new Set());
      byKind.get(kind)!.add(id);
    }
  }
  for (const [kind, ids] of byKind) {
    if (ids.size === 0) continue;
    const field = endpointNameField(kind);
    const docs = await collectAcrossMembers(spaceId, mid =>
      col<Record<string, unknown>>(`${mid}_${collectionForRefKind(kind)}`)
        .find(asFilter<Record<string, unknown>>({ _id: { $in: [...ids] } }), { projection: { _id: 1, [field]: 1 } })
        .toArray());
    for (const d of docs) {
      const value = d[field];
      if (typeof value === 'string' && value.trim()) nameMap.set(String(d['_id']), value.trim());
    }
  }
  const enriched = all.map(e => ({ ...e, fromName: nameMap.get(e.from), toName: nameMap.get(e.to) }));
  let total = 0;
  for (const mid of members) total += await countBrain(mid, 'edges', await filterFor(mid));
  res.json({ edges: withoutListDiagnostics(enriched, listDiagnosticsAsked(req)),
    limit, skip, total, truncated: skip + enriched.length < total });
});


// GET /api/brain/spaces/:spaceId/edges/:id
edgesRouter.get('/spaces/:spaceId/edges/:id', globalRateLimit, requireSpaceAuth, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const doc = await findFirstAcrossMembers(spaceId, mid => getEdgeById(mid, id));
  if (doc) { res.json(doc); return; }
  res.status(404).json({ error: 'Edge not found' });
});


// DELETE /api/brain/spaces/:spaceId/edges/:id
edgesRouter.delete('/spaces/:spaceId/edges/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const deleted = await findFirstAcrossMembers(spaceId, mid => deleteEdge(mid, id, webhookToken(req)));
  if (deleted) { res.status(204).end(); return; }
  res.status(404).json({ error: 'Edge not found' });
});


// PATCH /api/brain/spaces/:spaceId/edges/:id — partial update an edge by ID
/**
 * The body keys the edges UPDATE reads.
 *
 * Its own list, not the create's: `deleteFields` is an update field and `id` is a path parameter
 * here. Copying the create's would produce an "unknown field" warning about a parameter that works,
 * which is what the drift check in
 * `an-update-answers-the-same-questions-a-create-does-db.test.js` exists to refuse.
 *
 * The shared write options — ttlDays, waitForEmbedding, the duplicate flags and the two suppression
 * spellings — are NOT listed: they are read by helpers, and live in `SHARED_WRITE_BODY_KEYS`.
 */
const EDGES_UPDATE_BODY_KEYS = ['label', 'description', 'tags', 'properties', 'weight', 'type', 'deleteFields', 'fromKind', 'toKind'];
edgesRouter.patch('/spaces/:spaceId/edges/:id', globalRateLimit, requireSpaceAuth, denyReadOnly, async (req, res) => {
  const spaceId = req.params['spaceId'] as string;
  const id = req.params['id'] as string;
  const cfg = getConfig();
  if (!cfg.spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  const wt = resolveWriteTarget(spaceId, req.query['targetSpace'] as string | undefined);
  if (!wt.ok) { res.status(400).json({ error: wt.error }); return; }
  const ifMatch = ifMatchFromRequest(req);
  if (!ifMatch.ok) { res.status(400).json({ error: ifMatch.error }); return; }
  const { label, description, tags, properties, weight, type, deleteFields, fromKind, toKind } = req.body ?? {};
  // Validate deleteFields
  const dfResult = validateDeleteFields(deleteFields);
  if (!dfResult.ok) { res.status(400).json({ error: dfResult.error }); return; }
  const ttlErr = ttlDaysError(req.body);
  if (ttlErr) { res.status(400).json({ error: ttlErr }); return; }
  // `W-14`..`W-22`: what a VALUE must look like, from the one table this door and its twin both read.
  // AFTER the checks above, so every refusal this door already made keeps its own wording; this catches
  // only what used to get through. Requiredness stays above — a create demands its fields, an update
  // must not.
  const shapeErr = shapeError('edge', req.body);
  if (shapeErr) { res.status(400).json({ error: shapeErr }); return; }
  const ttlDaysProvided = !!req.body && typeof req.body === 'object' && 'ttlDays' in req.body;
  const dfPaths: string[] | undefined = Array.isArray(deleteFields) && deleteFields.length > 0 ? deleteFields : undefined;
  const updates: { label?: string; description?: string; tags?: string[]; properties?: Record<string, string | number | boolean>; weight?: number; type?: string; suppressEmbeddings?: boolean; fromKind?: RefKind; toKind?: RefKind } = {};
  if (label !== undefined) {
    if (typeof label !== 'string' || !label.trim()) { res.status(400).json({ error: '`label` must be a non-empty string' }); return; }
    updates.label = label.trim();
  }
  if (description !== undefined) {
    if (typeof description !== 'string') { res.status(400).json({ error: '`description` must be a string' }); return; }
    updates.description = description;
  }
  if (tags !== undefined) {
    if (!Array.isArray(tags) || tags.some((t: unknown) => typeof t !== 'string')) { res.status(400).json({ error: '`tags` must be an array of strings' }); return; }
    updates.tags = tags;
  }
  if (properties !== undefined) {
    if (typeof properties !== 'object' || properties === null || Array.isArray(properties)) { res.status(400).json({ error: '`properties` must be a plain object' }); return; }
    updates.properties = properties as Record<string, string | number | boolean>;
  }
  if (weight !== undefined) {
    if (typeof weight !== 'number') { res.status(400).json({ error: '`weight` must be a number' }); return; }
    updates.weight = weight;
  }
  if (type !== undefined) {
    if (typeof type !== 'string') { res.status(400).json({ error: '`type` must be a string' }); return; }
    updates.type = type.trim();
  }
  // Correcting the kind of an endpoint, with the same refusal text and the same allowed set as the create
  // door — a `400` on one door and a silent default on the other makes the behaviour depend on which client
  // the caller picked.
  for (const [field, value] of [['fromKind', fromKind], ['toKind', toKind]] as const) {
    if (value === undefined) continue;
    if (typeof value !== 'string' || !(REF_KINDS as readonly string[]).includes(value)) {
      res.status(400).json({ error: `\`${field}\` must be one of: ${REF_KINDS.join(', ')}` });
      return;
    }
    updates[field] = value as RefKind;
  }
  /*
   * `W-17`: A CHANGED KIND RE-RESOLVES THE ENDPOINT IT DESCRIBES.
   *
   * The create door resolves each end in the collection its kind names. This door checked the kind ENUM
   * and stored it unresolved — so `PATCH {"fromKind": "file"}` on an entity-to-entity edge answered 200,
   * and the edge then claimed its `from` was a file path while holding an entity UUID.
   *
   * **It is invisible to every graph read**, because name enrichment and `traverse` both look in the
   * collection the kind names and find nothing there. The block above says it matches the create door
   * *"with the same refusal text and the same allowed set"*, which was true of the enum and silently not
   * of the resolution.
   *
   * The ENDPOINT comes from the stored edge, because this door does not accept `from`/`to`: an edge whose
   * end changed is a different relationship, and the way to make one is a delete and an upsert.
   */
  if (isStrictLinkage(wt.target) && (updates.fromKind !== undefined || updates.toKind !== undefined)) {
    const stored = await findFirstAcrossMembers(spaceId, async mid => await getEdgeById(mid, id));
    if (stored) {
      try {
        if (updates.fromKind !== undefined) {
          await assertRefsResolve(wt.target, 'from', updates.fromKind, [stored.from]);
        }
        if (updates.toKind !== undefined) {
          await assertRefsResolve(wt.target, 'to', updates.toKind, [stored.to]);
        }
      } catch (err) {
        res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
        return;
      }
    }
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
    // Validate the edge AS IT WILL BE, on every patch — not only when `deleteFields` is present. That
    // branch used to be the whole of update validation, so a patch that moved `label` outside the
    // allowlist wrote a value the same space rejects at create time. One read, shared with the audit
    // snapshot below.
    const existing = await getEdgeById(mid, id);
    if (!existing) continue;
    /*
     * The schema check moved into `updateEdgeById`, which validates the record it is about to store rather
     * than a rebuilt simulation of it. The 422 is preserved.
     */
    // Snapshot for the audit change list, from the read above — see the note in facts.ts.
    let updated;
    let updateCheck: UpdateValidation | undefined;
    try {
      updated = await updateEdgeById(mid, id, updates, dfPaths, webhookToken(req), ttlDaysFromBody(req.body), ifMatch.seq,
        c => { updateCheck = c; });
    } catch (err) {
      if (err instanceof SchemaViolationError) {
        res.status(422).json({
          error: 'schema_violation', message: err.check.message, violations: err.check.all,
          introduced: err.check.introduced, preExisting: err.check.preExisting,
        });
        return;
      }
      /*
       * A label change moves the edge onto the id its new identity derives, and that id may already be
       * taken by another edge. It is a CALLER error — they named a relationship that exists — so it is a
       * 409, not the 500 an unhandled throw would produce. `04b-graph-api.md` promises this is "refused with
       * an explanatory error rather than surfaced as an index violation"; without this the promise held on
       * the MCP door alone, where a thrown Error becomes the tool's own message.
       */
      if (err instanceof EdgeIdentityTaken) {
        res.status(409).json({ error: 'edge_identity_taken', message: err.message, existingId: err.existingId });
        return;
      }
      throw err;
    }
    if (updated) {
      req.auditSnapshots = { before: existing ?? {}, after: updated };
      // The `warnings` array an update response did not have — see the facts route, where the
      // reasoning is written out. A warn-mode space reported on a create and said nothing on an edit.
      const updateWarnings = [...(updateCheck?.warnings ?? []), ...unknownFieldWarnings(req.body, EDGES_UPDATE_BODY_KEYS)];
      res.json(updateWarnings.length > 0 ? { ...updated, warnings: updateWarnings } : updated);
      return;
    }
    // See the note in entities.ts: with a precondition in play, a write that matched nothing is a 412
    // and must not fall through to the next member space.
    if (ifMatch.seq !== undefined) {
      res.status(412).json(preconditionFailedBody('edge', (await getEdgeById(mid, id))?.seq));
      return;
    }
  }
  res.status(404).json({ error: 'Edge not found' });
});


