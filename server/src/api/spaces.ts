import { Router } from 'express';
import { registerReembedRoute } from './spaces-reembed.js';
import { registerActivityResetRoute } from './spaces-activity.js';
import {
  requireAuth, requireSpaceAuthScoped, requireSpaceAuthMfaScoped, requireAdmin, requireAdminMfa, requireAdminMfaScoped,
  requireAdminOrSpaceAdminMfaScoped, isInstanceAdmin, denyReadOnly,
} from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { editorScopeFor } from '../auth/editor-scope.js';
import { getConfig, saveConfig, getSecrets, getSchemaLibrary, getDocumentProcessingConfig, getMediaEmbeddingConfig, getStorageConfig } from '../config/loader.js';
import { capDocExtractionMode } from '../files/converters/extraction-level.js';
import { slugify, SPACE_PURPOSE_MAX, needsReindex } from '../spaces/_shared.js';
import { createSpace, removeSpace } from '../spaces/lifecycle.js';
import { renameSpace } from '../spaces/rename.js';
import { updateSpace, reorderSpaces } from '../spaces/spaces.js';
import { checkMetaPrecondition, preconditionErrorBody } from '../spaces/meta-precondition.js';
import { gatherCompletenessFacts, scoreCompleteness } from '../spaces/completeness.js';
import { ensureTtlIndex } from '../brain/ttl.js';
import { measureUsage, usageIsComplete } from '../quota/quota.js';
import { measureSpaceUsage } from '../spaces/space-usage.js';
import { col } from '../db/mongo.js';
import { memberSpacesForRequest } from '../spaces/proxy-scoped.js';
import { isNetworkSyncing } from '../sync/engine.js';
import { spaceNetworkInfo } from '../spaces/network-status.js';
import { z } from 'zod';
import { v4 as uuidv4 } from 'uuid';
import { log } from '../util/log.js';
import { buildSpaceVectorIndexes } from '../spaces/vector-index.js';
import { isSsrfSafeUrl, SSRF_SAFE_MESSAGE } from '../util/ssrf.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { proposedMetaFields } from '../sync/meta-round-merge.js';
import type { SpaceMeta, KnowledgeType, TypeSchema } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';
import { DOC_EXTRACTION_MODES_IN, IMAGE_LEVELS, AUDIO_LEVELS, VIDEO_LEVELS, TEXT_LEVELS, normalizeDocExtractionMode } from '../config/types.js';
import { writeFile as writeSpaceFile } from '../files/files.js';
import {
  TypeSchemaZ, TypeSchemasZ, SpaceMetaBody, SERVER_OWNED_META_FIELDS,
  stripServerOwnedMeta, findBrokenLibraryRefs, brokenRefsError,
  CreateSpaceBody, DeleteSpaceBody, RenameSpaceBody, ReorderSpacesBody, PutSchemaBody,
} from '../spaces/body-schemas.js';
import { requireSettingsFields } from '../auth/require-settings-fields.js';
import { planSpaceMetaUpdate, applySpaceMetaUpdate } from '../spaces/meta-update.js';
import { refuseFaceWidthChange } from '../spaces/face-width-change.js';
import { planSpaceCreate, applySpaceCreate } from '../spaces/space-create.js';
import { validateStoredEdges } from '../spaces/validate-stored-edges.js';

export const spacesRouter = Router();

// POST /api/spaces/:id/rebuild-indexes
//
// The repair operation for "semantic recall returns nothing". Until this existed there was NO way to
// recreate a space's vector search indexes: `POST .../reindex` only re-embeds documents, so an operator
// could reindex the entire space, watch every record be processed, and still get zero results. The only
// paths that ever built an index were creating a space and — by accident — editing its type schemas.
//
// Restoring a backup used to leave exactly that state (the restore drops collections, which destroys
// their indexes); that is now repaired automatically, but a manual lever still matters for any other
// way an index can go missing, and for verifying a recovery.
//
// Deliberately `force`: the caller is here because something is wrong, so the "definition already
// matches" shortcut is not to be trusted — a stale entry that mongot has not yet collected would make
// the repair silently do nothing.
spacesRouter.post('/:id/rebuild-indexes', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, async (req, res) => {
  const spaceId = req.params['id'] as string;
  if (!getConfig().spaces.some(s => s.id === spaceId)) {
    res.status(404).json({ error: `Space '${spaceId}' not found` });
    return;
  }
  try {
    // Not awaiting READY: a rebuild over a large space takes minutes and would time out the request.
    // Recall returns empty until the build completes — that gap is why this lives in the danger zone.
    await buildSpaceVectorIndexes(spaceId, false, { force: true });
    res.json({ ok: true, spaceId, status: 'rebuilding' });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    log.error(`POST /api/spaces/${spaceId}/rebuild-indexes: ${err}`);
    res.status(500).json({ error: msg });
  }
});

registerReembedRoute(spacesRouter);
registerActivityResetRoute(spacesRouter);

// PATCH /api/spaces/:id/rename
spacesRouter.patch('/:id/rename', globalRateLimit, requireAdminOrSpaceAdminMfaScoped('id'), async (req, res) => {
  const oldId = req.params['id'] as string;
  const parsed = RenameSpaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // The rename IS the change, so the snapshot is just the two ids. Set before the attempt and only read
  // by the audit middleware on a <400 response, so a failed rename records nothing.
  req.auditSnapshots = { before: { id: oldId }, after: { id: parsed.data.newId } };

  try {
    const space = await renameSpace(oldId, parsed.data.newId);
    res.json({ space });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes('not found')) {
      res.status(404).json({ error: msg });
    } else if (msg.includes('already exists')) {
      res.status(409).json({ error: msg });
    } else if (msg.includes('built-in')) {
      res.status(400).json({ error: msg });
    } else {
      res.status(500).json({ error: msg });
    }
  }
});

// POST /api/spaces/reorder
spacesRouter.post('/reorder', globalRateLimit, requireAdminMfa, (req, res) => {
  const parsed = ReorderSpacesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }
  const reordered = reorderSpaces(parsed.data.ids);
  if (!reordered) {
    res.status(400).json({ error: 'One or more space IDs not found' });
    return;
  }
  res.json({ spaces: reordered.map(space => ({
    id: space.id, label: space.label, builtIn: space.builtIn, folders: space.folders,
    maxGiB: space.maxGiB, flex: space.flex,
    ...(space.proxyFor ? { proxyFor: space.proxyFor } : {}),
  })) });
});

// GET /api/spaces
spacesRouter.get('/', globalRateLimit, requireAuth, async (req, res) => {
  const cfg = getConfig();

  /**
   * Respect token space-scope: a scoped token sees only the spaces it reaches. The MATRIX decides.
   *
   * This asked `'spaces' in req.authToken`, which stopped being true for every PAT the moment the field was
   * deleted — so the guard silently became "unrestricted" and the listing showed every space on the instance
   * to a token scoped to one. That is the fourth instance of one shape this release, and the first I caused
   * rather than found: a legacy read that answers "no restriction" once the thing it reads is gone.
   *
   * `editorScopeFor` is the resolution every other scope decision uses — matrix first, the allowlist only
   * for a record carrying no matrix, and `undefined` for genuinely unrestricted.
   */
  const tokenSpaces = editorScopeFor(req.authToken);
  const visibleSpaces = tokenSpaces
    ? cfg.spaces.filter(s => tokenSpaces.includes(s.id))
    : cfg.spaces;

  /*
   * Per-space file usage, through the shared measurement — so MCP's `list_spaces` reports the same figures from
   * the same code rather than not reporting them at all, which is what it did while `help()` told callers to
   * look here for them.
   *
   * The old comment said "falls back to 0 on error", and that fallback was the defect: a space whose files
   * directory the process cannot list showed 0 GiB used, which is also what an empty space shows. The Brain
   * overview's usage bar then read 0% against a quota that was being approached. `incomplete` is what separates
   * a total from a floor.
   */
  const usageBySpaceId = await measureSpaceUsage(visibleSpaces.map(sp => sp.id));

  // Optional per-space entity/memory/edge/chrono counts (?counts=true)
  const includeCounts = req.query['counts'] === 'true';
  let countsBySpaceId: Record<string, { memories: number; entities: number; edges: number; chrono: number }> = {};
  if (includeCounts) {
    const countResults = await Promise.allSettled(
      visibleSpaces.map(async s => {
        const memberIds = memberSpacesForRequest(req, s.id);
        const perMember = await Promise.all(memberIds.map(async mid => ({
          memories: await col(`${mid}_memories`).countDocuments(),
          entities: await col(`${mid}_entities`).countDocuments(),
          edges:    await col(`${mid}_edges`).countDocuments(),
          chrono:   await col(`${mid}_chrono`).countDocuments(),
        })));
        return {
          id: s.id,
          counts: {
            memories: perMember.reduce((n, c) => n + c.memories, 0),
            entities: perMember.reduce((n, c) => n + c.entities, 0),
            edges:    perMember.reduce((n, c) => n + c.edges, 0),
            chrono:   perMember.reduce((n, c) => n + c.chrono, 0),
          },
        };
      }),
    );
    for (const r of countResults) {
      if (r.status === 'fulfilled') countsBySpaceId[r.value.id] = r.value.counts;
    }
  }

  const spaces = visibleSpaces.map((space, idx) => {
    const { id, label, builtIn, folders, maxGiB, flex, proxyFor, meta, dupeRules, dupeMergeSurvivor, dupeRulesOnInsert, recordTtlDays, documentExtraction, imageAnalysis, audioAnalysis, videoAnalysis, textAnalysis, indexStatus } = space;
    return {
    id, label, builtIn, folders, maxGiB, flex,
    usageGiB: usageBySpaceId.get(id)?.usageGiB ?? 0,
    // Present only when the figure is a FLOOR. An absent field means the measurement was whole, which is the
    // same convention the storage metric uses — a caller that ignores this field is not silently misled about
    // a healthy space, only about an unreadable one, and that is the case worth a field.
    ...((usageBySpaceId.get(id)?.incomplete.length ?? 0) > 0
      ? { usageIncomplete: usageBySpaceId.get(id)!.incomplete }
      : {}),
    ...(indexStatus ? { indexStatus } : {}),
    ...(proxyFor ? { proxyFor } : {}),
    // Network membership + status for the Brain space-chip indicator (F8).
    ...(spaceNetworkInfo(cfg.networks, id, isNetworkSyncing, cfg.instanceId) ?? {}),
    ...(meta ? { meta: { ...meta, previousVersions: undefined } } : {}),
    ...(dupeRules ? { dupeRules } : {}),
    ...(dupeMergeSurvivor ? { dupeMergeSurvivor } : {}),
    ...(dupeRulesOnInsert ? { dupeRulesOnInsert } : {}),
    ...(recordTtlDays ? { recordTtlDays } : {}),
    ...(documentExtraction ? { documentExtraction } : {}),
    // Only present when the space overrides the instance — an absent field means 'follows the
    // instance', which the UI renders differently from an explicit choice.
    ...(imageAnalysis ? { imageAnalysis } : {}),
    ...(audioAnalysis ? { audioAnalysis } : {}),
    ...(videoAnalysis ? { videoAnalysis } : {}),
    ...(textAnalysis ? { textAnalysis } : {}),
    ...(includeCounts && countsBySpaceId[id] ? { counts: countsBySpaceId[id] } : {}),
    };
  });
  // Include storage usage summary when quota is configured
  // Resolved, not raw: `getStorageConfig()` applies the env pins, and `lockedByInfra` is what lets the
  // Settings page render a host-imposed limit read-only instead of as something the tenant may edit.
  const resolvedStorage = getStorageConfig();
  let storage: {
    usageGiB?: { files: number; brain: number; total: number };
    limits?: ReturnType<typeof getStorageConfig>;
    usageIncomplete?: { files: string[]; brain: string[] };
  } | undefined;
  if (resolvedStorage) {
    try {
      const usage = await measureUsage();
      storage = {
        usageGiB: usage,
        limits: resolvedStorage,
        // The instance-wide figure carries the same distinction as the per-space one: a refused `dbStats` or an
        // unlistable directory makes these totals a floor, and a hard limit compared against a floor can only
        // under-report. Absent when the measurement was whole.
        ...(usageIsComplete(usage) ? {} : { usageIncomplete: usage.incomplete }),
      };
    } catch {
      // Non-fatal: storage summary omitted on measurement error
    }
  }
  // The instance document-extraction ceiling — the most any space may do. The client uses it to offer
  // only the extraction modes a space could actually reach, so the per-space dropdown can't propose a
  // level the runtime would silently cap. 'auto' means the instance imposes no policy limit.
  const docExtractionCeiling = getDocumentProcessingConfig().mode ?? 'auto';
  // The per-class media-analysis ceilings — the highest level any space may pick for each class.
  // Same contract as docExtractionCeiling: the client offers only levels within each ceiling so a
  // per-space picker can't propose a level the runtime would silently cap. 'auto' = no policy limit.
  // (Config keys images/audio/video/text; the image class is exposed singular to match the space field.)
  const mediaLevels = getMediaEmbeddingConfig().levels ?? {};
  const mediaCeilings = {
    image: mediaLevels.images ?? 'auto',
    audio: mediaLevels.audio ?? 'auto',
    video: mediaLevels.video ?? 'auto',
    text: mediaLevels.text ?? 'auto',
  };
  res.json({ spaces, docExtractionCeiling, mediaCeilings, ...(storage ? { storage } : {}) });
});

// POST /api/spaces
// Every refusal — the parse, the two proxy checks, the schema-library `$ref` — and the strict-posture seeding are
// decided by `planSpaceCreate`, so an MCP `create_space` reaches the same rules instead of a weaker copy of them
// (B-2). What stays here is turning an outcome into a status.
//
// `space-create-contract.test.js` pins that chain, including that a refusal leaves NO SPACE BEHIND, and it was proven
// against this handler before the move.
spacesRouter.post('/', globalRateLimit, requireAdminMfa, async (req, res) => {
  const decision = planSpaceCreate(req.body);
  if (!decision.ok) {
    res.status(decision.refusal.status).json(decision.refusal.body);
    return;
  }

  const result = await applySpaceCreate(decision.plan);
  if (result.outcome === 'conflict') {
    res.status(409).json({ error: result.error });
    return;
  }
  if (result.outcome === 'failed') {
    res.status(500).json({ error: result.error });
    return;
  }
  res.status(201).json({ space: result.space });
});

// PATCH /api/spaces/:id
//
// Every refusal, and every value that has to be normalised before it is stored, is decided by
// `planSpaceMetaUpdate` — so an MCP tool can reach the same rules instead of a weaker copy of them (B-2). What
// stays here is the WRITE and how it is reported: the local settings, the network vote's 202, the peer notify.
//
// `space-meta-update-contract.test.js` pins the chain the planner now owns, including its ORDER, and it was proven
// against this handler before the move.
/*
 * The settings door, and the ONE place its twenty-two fields are authorised.
 *
 * The guard chain is the rung guard rather than `requireAdminOrSpaceAdminMfaScoped`, because most of this body no
 * longer needs the whole space: a `files` writer may set a media level, a `dataQuality` writer may tune a
 * duplicate rule. So that guard answers reach, scope and the second factor, and `requireSettingsFields`
 * answers WHICH FIELDS — see `auth/space-field-rights.ts` for the table and for why it is a table.
 *
 * That means this route FAILS OPEN if a field has no row, which is why the table is asserted total against
 * the zod schemas and why the helper refuses an unknown field rather than allowing it. Two independent
 * answers to one question, deliberately: one fails the build, the other fails the request.
 *
 * The hand-written `maxGiB` check that used to stand here is gone. It said exactly what one row of the
 * table says, and one rule with two implementations is the defect this repository produces most.
 */
spacesRouter.patch('/:id', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly,
  requireSettingsFields('id'), async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);

  // The face gallery's width is refused by STATE, not by surface — it is accepted on this body and declined
  // when the space holds descriptors or its index is already built at another width. Checked HERE rather than
  // in the planner because the planner is synchronous by design and this needs two database reads; the maxGiB
  // guard above sits in the same place for the same reason. See `spaces/face-width-change.ts` for the whole
  // account, including why it is a 409 and not a 400.
  if (space && req.body?.faceDescriptorDims !== undefined
      && typeof req.body.faceDescriptorDims === 'number') {
    const refusal = await refuseFaceWidthChange(id, req.body.faceDescriptorDims, space.faceDescriptorDims);
    if (refusal) {
      res.status(refusal.status).json({ error: refusal.reason });
      return;
    }
  }

  const decision = planSpaceMetaUpdate({ spaceId: id, space, body: req.body, ifMatch: req.get('If-Match') });
  if (!decision.ok) {
    res.status(decision.refusal.status).json(decision.refusal.body);
    return;
  }
  // The audit middleware records this only on a <400 response, so a request the planner refused above logs no
  // change. The snapshot pair was taken before anything was applied, which is what makes the change list honest.
  req.auditSnapshots = decision.plan.audit;

  const result = await applySpaceMetaUpdate(decision.plan);
  if (result.outcome === 'not_found') {
    // Only reachable if the space was deleted between the plan and the write.
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }
  if (result.outcome === 'vote_pending') {
    res.status(202).json({ status: 'vote_pending', rounds: result.rounds, message: 'Meta change requires network vote' });
    return;
  }
  res.json({ space: result.space });
});

// PUT /api/spaces/:id/schema — full replacement of the space's typeSchemas.
// Unlike PATCH (which merges types), this completely overwrites `meta.typeSchemas`
// with the supplied value.  Before applying, the previous schema is written to a
// timestamped JSON backup file inside the space so it can be recovered or re-imported.
spacesRouter.put('/:id/schema', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // Optimistic concurrency: honour If-Match against the current meta version, if the client sent one.
  // Checked BEFORE the schema backup is written — a rejected write must leave no trace on disk.
  const schemaPrecondition = checkMetaPrecondition(req.get('If-Match'), space.meta?.version ?? 0);
  if (!schemaPrecondition.ok) {
    res.status(schemaPrecondition.status).json(preconditionErrorBody(schemaPrecondition));
    return;
  }

  const parsed = PutSchemaBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Validate any $ref values against the instance schema library
  const brokenRefs = findBrokenLibraryRefs(parsed.data.typeSchemas as z.infer<typeof TypeSchemasZ>);
  if (brokenRefs.length > 0) {
    res.status(422).json({ error: `Schema library ${brokenRefs.length === 1 ? 'entry' : 'entries'} not found: ${brokenRefs.join(', ')}. Create ${brokenRefs.length === 1 ? 'it' : 'them'} via POST /api/schema-library before referencing.` });
    return;
  }

  // Write a backup of the previous schema before replacing it
  const previousTypeSchemas = space.meta?.typeSchemas;
  if (previousTypeSchemas && Object.keys(previousTypeSchemas).length > 0) {
    try {
      const backupTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const backupContent = JSON.stringify({ typeSchemas: previousTypeSchemas }, null, 2);
      await writeSpaceFile(id, `_schema-backup-${backupTimestamp}.json`, backupContent);
    } catch (err) {
      log.warn(`PUT /${id}/schema: could not write schema backup: ${err}`);
      // Non-fatal — proceed with replacement
    }
  }

  // Re-read AFTER the backup write. `space` was found before `await writeSpaceFile` above, and a
  // config reload during that write orphans it — the spread below would then carry the PRE-reload
  // meta, so any concurrent edit to this space's purpose / usageNotes / validationMode is silently
  // dropped on a schema save. Same class as the invite finalize path and #353; cheap to avoid.
  const freshSpace = getConfig().spaces.find(s => s.id === id);
  if (!freshSpace) {
    res.status(409).json({ error: `Space '${id}' was removed while the schema backup was being written` });
    return;
  }

  // Replace the entire typeSchemas (full-replace semantics)
  const newMeta: SpaceMeta = {
    ...(freshSpace.meta ?? {}),
    typeSchemas: parsed.data.typeSchemas as SpaceMeta['typeSchemas'],
  };

  const updated = updateSpace(id, { meta: newMeta });
  if (!updated) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }
  // Full-replace: `previousTypeSchemas` was read before the write, so this is a true before/after. The
  // audit layer summarises it as type and property-key NAMES — a schema replacement that recorded
  // nothing was the whole gap here.
  req.auditSnapshots = {
    before: { typeSchemas: previousTypeSchemas ?? {} },
    after: { typeSchemas: newMeta.typeSchemas ?? {} },
  };
  res.json({ space: updated });
});

// GET /api/spaces/:id/meta — read the meta block with derived stats
spacesRouter.get('/:id/meta', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // With `?resolve=1`, expand library `$ref` types to their effective schema (propertySchemas from the
  // linked library entry) so consumers like the brain entry forms — which pre-fill properties from the
  // selected type — see the real fields, not a bare `{ $ref }`. Default (raw) is preserved for the
  // edit/round-trip view and existing callers that verify the stored `$ref`.
  const resolveRefs = req.query['resolve'] === '1' || req.query['resolve'] === 'true';
  const rawMeta = space.meta ?? {};
  const meta = resolveRefs
    ? (await import('../spaces/schema-validation.js')).resolveMetaRefs(rawMeta)
    : rawMeta;
  const memberIds = memberSpacesForRequest(req, id);
  const counts = await Promise.all(memberIds.map(async mid => ({
    memories: await col(`${mid}_memories`).countDocuments(),
    entities: await col(`${mid}_entities`).countDocuments(),
    edges: await col(`${mid}_edges`).countDocuments(),
    chrono: await col(`${mid}_chrono`).countDocuments(),
    files: await col(`${mid}_files`).countDocuments(),
  })));

  const stats = {
    memories: counts.reduce((s, c) => s + c.memories, 0),
    entities: counts.reduce((s, c) => s + c.entities, 0),
    edges: counts.reduce((s, c) => s + c.edges, 0),
    chrono: counts.reduce((s, c) => s + c.chrono, 0),
    files: counts.reduce((s, c) => s + c.files, 0),
  };

  // Reindex state travels with the meta on BOTH doors. The `reindex` tool's own description tells a caller to
  // "poll `get_space_meta` or the REST reindex-status route" after starting a job — and `get_space_meta` did not
  // carry it, so for an MCP-only client (Claude Desktop, any agent with no HTTP door) the sentence named
  // something unreachable. A schema description is read while arguments are being constructed; one that points
  // at a door the reader does not have is worse than silence.
  //
  // `.some()` over the members, matching `GET /reindex-status`: a proxy needs a reindex when any member does.
  const reindexNeeded = memberIds.some(mid => needsReindex(mid));

  // Strip previousVersions from public response (available via dedicated endpoint if needed)
  // (`needsReindex` is attached where the response is assembled, just below.)
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { previousVersions: _pv, ...metaPublic } = meta;

  res.json({
    spaceId: id,
    spaceName: space.label,
    ...metaPublic,
    stats,
    needsReindex: reindexNeeded,
  });
});

// GET /api/spaces/:id/completeness — how much of what this space declared it would hold, it holds.
//
// Separate from `/meta` rather than folded into its `stats`: `/meta` is read on every schema edit and
// must stay cheap, while this walks the collections. Read-only, so no audit entry — the
// audit-route-coverage gate is about mutating verbs.
spacesRouter.get('/:id/completeness', globalRateLimit, requireSpaceAuthScoped('id'), async (req, res) => {
  const id = req.params['id'] as string;
  const space = getConfig().spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }
  const facts = await gatherCompletenessFacts(memberSpacesForRequest(req, id));
  res.json(scoreCompleteness(id, space.meta ?? {}, facts));
});

// ── Granular type schema CRUD ─────────────────────────────────────────────────

const VALID_KNOWLEDGE_TYPES = new Set<string>(KNOWLEDGE_TYPES);
const MAX_TYPES_PER_KIND = 200;

// GET /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName
spacesRouter.get('/:id/meta/typeSchemas/:knowledgeType/:typeName', globalRateLimit, requireSpaceAuthScoped('id'), (req, res) => {
  const { id, knowledgeType, typeName } = req.params as { id: string; knowledgeType: string; typeName: string };

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: `Invalid knowledgeType '${knowledgeType}'. Must be one of: entity, memory, edge, chrono` });
    return;
  }

  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  const kt = knowledgeType as KnowledgeType;
  const typeMap = space.meta?.typeSchemas?.[kt] ?? {};
  if (!(typeName in typeMap)) {
    res.status(404).json({ error: `Type '${typeName}' not found in typeSchemas.${kt}` });
    return;
  }

  res.json({ knowledgeType: kt, typeName, schema: typeMap[typeName] ?? {} });
});

// PUT /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName — upsert a single type definition
spacesRouter.put('/:id/meta/typeSchemas/:knowledgeType/:typeName', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, (req, res) => {
  const { id, knowledgeType, typeName } = req.params as { id: string; knowledgeType: string; typeName: string };

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: `Invalid knowledgeType '${knowledgeType}'. Must be one of: entity, memory, edge, chrono` });
    return;
  }

  const parsed = TypeSchemaZ.safeParse(req.body ?? {});
  if (!parsed.success) {
    res.status(400).json({ error: parsed.error.message });
    return;
  }

  // Validate any $ref against the instance schema library before writing
  if ('$ref' in parsed.data) {
    const brokenRefs = findBrokenLibraryRefs({ [knowledgeType]: { _check: parsed.data } });
    if (brokenRefs.length > 0) {
      res.status(422).json({ error: `Schema library ${brokenRefs.length === 1 ? 'entry' : 'entries'} not found: ${brokenRefs.join(', ')}. Create ${brokenRefs.length === 1 ? 'it' : 'them'} via POST /api/schema-library before referencing.` });
      return;
    }
  }

  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // Same optimistic-concurrency contract as PATCH /:id — this writes meta too.
  const upsertPrecondition = checkMetaPrecondition(req.get('If-Match'), space.meta?.version ?? 0);
  if (!upsertPrecondition.ok) {
    res.status(upsertPrecondition.status).json(preconditionErrorBody(upsertPrecondition));
    return;
  }

  const kt = knowledgeType as KnowledgeType;
  const existingMeta: SpaceMeta = space.meta ?? {};
  const existingKtMap: Record<string, import('../config/types.js').TypeSchema> = { ...(existingMeta.typeSchemas?.[kt] ?? {}) };

  // Enforce max 200 types per knowledge type (only for new types)
  const isNew = !(typeName in existingKtMap);
  if (isNew && Object.keys(existingKtMap).length >= MAX_TYPES_PER_KIND) {
    res.status(400).json({
      error: `Max ${MAX_TYPES_PER_KIND} type definitions per knowledge type reached for '${kt}'. Remove unused types before adding new ones.`,
    });
    return;
  }

  // Merge the new type definition into the existing map
  existingKtMap[typeName] = parsed.data;

  const updatedMeta: SpaceMeta = {
    ...existingMeta,
    typeSchemas: {
      ...existingMeta.typeSchemas,
      [kt]: existingKtMap,
    },
  };

  const updated = updateSpace(id, { meta: updatedMeta });
  if (!updated) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // A single-type upsert is audited under the same `space.schema.update` operation as the full replace,
  // so it needs the same snapshot shape. Without it the granular route — the one the Schema tab actually
  // uses — was the silent half of an already-silent pair.
  req.auditSnapshots = {
    before: { typeSchemas: existingMeta.typeSchemas ?? {} },
    after: { typeSchemas: updatedMeta.typeSchemas ?? {} },
  };

  res.json({ knowledgeType: kt, typeName, schema: parsed.data });
});

// DELETE /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName — remove a single type definition
spacesRouter.delete('/:id/meta/typeSchemas/:knowledgeType/:typeName', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, (req, res) => {
  const { id, knowledgeType, typeName } = req.params as { id: string; knowledgeType: string; typeName: string };

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: `Invalid knowledgeType '${knowledgeType}'. Must be one of: entity, memory, edge, chrono` });
    return;
  }

  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // Same optimistic-concurrency contract as PATCH /:id — removing a type is a meta write.
  const deletePrecondition = checkMetaPrecondition(req.get('If-Match'), space.meta?.version ?? 0);
  if (!deletePrecondition.ok) {
    res.status(deletePrecondition.status).json(preconditionErrorBody(deletePrecondition));
    return;
  }

  const kt = knowledgeType as KnowledgeType;
  const existingMeta: SpaceMeta = space.meta ?? {};
  const existingKtMap = existingMeta.typeSchemas?.[kt] ?? {};

  if (!(typeName in existingKtMap)) {
    res.status(404).json({ error: `Type '${typeName}' not found in typeSchemas.${kt}` });
    return;
  }

  // Build updated map without the deleted type
  const updatedKtMap: Record<string, import('../config/types.js').TypeSchema> = {};
  for (const [k, v] of Object.entries(existingKtMap)) {
    if (k !== typeName) updatedKtMap[k] = v;
  }

  const updatedTypeSchemas = { ...existingMeta.typeSchemas, [kt]: updatedKtMap };

  const updatedMeta: SpaceMeta = {
    ...existingMeta,
    typeSchemas: updatedTypeSchemas,
  };

  const updated = updateSpace(id, { meta: updatedMeta });
  if (!updated) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // Deleting a type is the change most worth having in the log: it silently widens what the space
  // accepts from then on, and the definition it removed is not recoverable from the entry alone.
  req.auditSnapshots = {
    before: { typeSchemas: existingMeta.typeSchemas ?? {} },
    after: { typeSchemas: updatedTypeSchemas },
  };

  res.status(204).end();
});

/*
 * POST /api/spaces/:id/validate-schema — dry-run validation of existing data.
 *
 * `requireSpaceAuthMfaScoped` — the area rung on this space plus the second factor — because this route's
 * `ROUTE_RIGHTS` row says `schema` / `read` and until now it demanded far more: `requireAdminOrSpaceAdminMfaScoped` admits
 * only an instance administrator or a SPACE administrator — `admin` on all four areas — so the rung the
 * panel advertised was never enough.
 *
 * Reported by the canary operator 2026-09-08T1400Z, and it cost them an afternoon twice: they granted
 * SCHEMA exactly as the panel asked, got `Admin token required`, read that as INSTANCE admin, and concluded
 * the route was instance-only. Their own words: the mapping "is enforced for at least one row and not for
 * another" — `/meta`, same area and one call apart, honoured the rung and answered 200.
 *
 * A DRY RUN is the right thing to sit at `read`: it writes nothing, stores nothing and reports what would
 * be refused.
 *
 * **The second factor STAYS.** `space-admin-reaches-its-own-space-settings.test.js` pins MFA on the widened
 * routes as deliberate, the reported defect is the rung rather than the factor, and loosening more than was
 * broken on an auth path is not a bargain worth taking.
 */
spacesRouter.post('/:id/validate-schema', globalRateLimit, requireSpaceAuthMfaScoped('id'), async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();
  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // Use the provided meta for dry-run, or fall back to the space's current meta.
  //
  // This endpoint has stripped the server-owned housekeeping fields since it was written — which is why it
  // accepted a round-tripped `GET` body while the PATCH above rejected it. Now both use the one helper, so
  // the two cannot drift apart again: a future field added to SERVER_OWNED_META_FIELDS reaches both, where
  // this inline destructure would have needed remembering.
  const parsedMeta = SpaceMetaBody.safeParse(stripServerOwnedMeta(req.body?.meta ?? space.meta ?? {}));
  if (!parsedMeta.success) {
    res.status(400).json({ error: parsedMeta.error.message });
    return;
  }
  const dryMeta = parsedMeta.data as SpaceMeta;

  // Import validation functions dynamically to avoid circular deps
  const { validateEntity, validateEdge, validateMemory, validateChrono, resolveMetaRefs } = await import('../spaces/schema-validation.js');
  const resolvedMeta = resolveMetaRefs(dryMeta);

  const violations: Array<{ collection: string; _id: string; violations: Array<{ field: string; value: unknown; reason: string }> }> = [];
  const memberIds = memberSpacesForRequest(req, id);
  const SCAN_LIMIT = 10_000;

  for (const mid of memberIds) {
    // Entities
    const entities = await col(`${mid}_entities`).find({}).limit(SCAN_LIMIT).toArray();
    for (const ent of entities) {
      const doc = ent as unknown as { _id: string; name?: string; type?: string; properties?: Record<string, unknown> };
      const v = validateEntity(resolvedMeta, doc);
      if (v.length) violations.push({ collection: 'entities', _id: String(doc._id), violations: v });
    }

    // Edges need two lookups the document cannot supply — see `validateStoredEdges`, which also
    // explains why they live in a module of their own rather than here.
    violations.push(...await validateStoredEdges(mid, resolvedMeta, SCAN_LIMIT));

    // Memories
    const memories = await col(`${mid}_memories`).find({}).limit(SCAN_LIMIT).toArray();
    for (const mem of memories) {
      const doc = mem as unknown as { _id: string; properties?: Record<string, unknown> };
      const v = validateMemory(resolvedMeta, doc);
      if (v.length) violations.push({ collection: 'memories', _id: String(doc._id), violations: v });
    }

    // Chrono
    const chronoEntries = await col(`${mid}_chrono`).find({}).limit(SCAN_LIMIT).toArray();
    for (const ch of chronoEntries) {
      const doc = ch as unknown as { _id: string; properties?: Record<string, unknown> };
      const v = validateChrono(resolvedMeta, doc);
      if (v.length) violations.push({ collection: 'chrono', _id: String(doc._id), violations: v });
    }
  }

  res.json({
    spaceId: id,
    meta: dryMeta,
    totalViolations: violations.length,
    violations: violations.slice(0, 500), // cap response size
  });
});

// DELETE /api/spaces/:id
//
// Solo space (not in any network): requires { "confirm": true } body to guard against accidents.
// Networked space: opens a space_deletion vote round on every network that includes this space,
// casts this instance's own yes vote immediately, notifies all peers, and returns 202.
// The space is only deleted once the vote passes on each network.
spacesRouter.delete('/:id', globalRateLimit, requireAdminMfaScoped('id'), async (req, res) => {
  const id = req.params['id'] as string;
  const cfg = getConfig();

  const space = cfg.spaces.find(s => s.id === id);
  if (!space) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  if (space.builtIn) {
    res.status(400).json({ error: `Space '${id}' is a built-in space and cannot be deleted` });
    return;
  }

  const networkedIn = cfg.networks.filter(n => n.spaces.includes(id));

  // ── Solo path ─────────────────────────────────────────────────────────────
  if (networkedIn.length === 0) {
    const body = DeleteSpaceBody.safeParse(req.body);
    if (!body.success || !body.data.confirm) {
      res.status(400).json({
        error: 'This space is not in any network. Send { "confirm": true } to delete it permanently.',
      });
      return;
    }
    const ok = await removeSpace(id).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
      return null;
    });
    if (ok === null) return; // error already sent
    if (!ok) { res.status(404).json({ error: `Space '${id}' not found` }); return; }
    res.status(204).end();
    return;
  }

  // ── Networked path ────────────────────────────────────────────────────────
  // Open a space_deletion vote round on every network that contains this space.
  // This instance votes yes immediately; deletion happens once each round passes.
  const rounds: { networkId: string; networkLabel: string; roundId: string }[] = [];
  const now = new Date().toISOString();

  for (const net of networkedIn) {
    const roundId = uuidv4();
    const deadline = new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString();
    net.pendingRounds.push({
      roundId,
      type: 'space_deletion',
      subjectInstanceId: cfg.instanceId,
      subjectLabel: cfg.instanceLabel,
      subjectUrl: '',       // not meaningful for space deletion
      deadline,
      openedAt: now,
      votes: [{ instanceId: cfg.instanceId, vote: 'yes', castAt: now }],
      spaceId: id,
    });
    rounds.push({ networkId: net.id, networkLabel: net.label, roundId });
  }
  saveConfig(cfg);

  // Notify all peers (best-effort — failures are logged but don't abort the response)
  const secrets = getSecrets();
  for (const net of networkedIn) {
    for (const member of net.members) {
      const peerToken = secrets.peerTokens[member.instanceId];
      if (!peerToken) continue;
      peerSafeFetch(`${member.url}/api/notify`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${peerToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          networkId: net.id,
          instanceId: cfg.instanceId,
          event: 'space_deletion_pending',
          data: { spaceId: id, spaceLabel: space.label },
        }),
        signal: AbortSignal.timeout(5_000),
      }).catch(err => log.warn(`notify ${member.label} of space_deletion_pending: ${err}`));
    }
  }

  res.status(202).json({ status: 'vote_pending', rounds });
});
