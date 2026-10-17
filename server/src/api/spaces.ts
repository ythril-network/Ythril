import { Router } from 'express';
import { voteOnSchemaEditIfNetworked, type WriteCaller } from '../spaces/meta-update.js';
import { commitOwnMetaEdit, withType, withoutType } from '../spaces/effective-meta.js';
import { registerReembedRoute } from './spaces-reembed.js';
import { registerActivityResetRoute } from './spaces-activity.js';
import { registerFileStampReportRoute } from './spaces-file-stamp-report.js';
import {
  requireAuth, requireSpaceAuthScoped, requireSpaceAuthMfaScoped, requireAdminMfa, requireAdminMfaScoped,
  requireAdminOrSpaceAdminMfaScoped, denyReadOnly, requireCreateSpacesMfa,
} from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { editorScopeFor } from '../auth/editor-scope.js';
import { getConfig, saveConfig, getDocumentProcessingConfig, getMediaEmbeddingConfig, getStorageConfig } from '../config/loader.js';
import { proposeRound, ownSpaceRoundInProgress, actsLocallyOn } from '../networks/propose-round.js';
import { networksHolding } from '../spaces/wipe-vote.js';
import { awaitDoorRounds, openedRound, repeatedRound } from '../spaces/door-acts.js';
import { deleteSpaceLocally, deletionAnswer } from '../spaces/space-deletion.js';
import { localToRemote } from '../sync/space-map.js';
import { spaceForWire } from '../spaces/space-for-wire.js';
import { renameSpaceAct } from '../spaces/rename.js';
import { reorderSpaces, unknownWriteFieldsToReport, spaceActPendingField } from '../spaces/spaces.js';
import { checkMetaPrecondition, preconditionErrorBody } from '../spaces/meta-precondition.js';
import { gatherCompletenessFacts, scoreCompleteness } from '../spaces/completeness.js';
import { measureUsage, usageIsComplete } from '../quota/quota.js';
import { measureSpaceUsage } from '../spaces/space-usage.js';
import { col } from '../db/mongo.js';
import { memberSpacesForRequest } from '../spaces/proxy-scoped.js';
import { isProxy } from '../spaces/proxy.js';
import { spaceMetaAnswer, META_RESOLVE_DEFAULT } from '../spaces/space-meta-answer.js';
import { isNetworkSyncing } from '../sync/engine.js';
import { spaceNetworkInfo } from '../spaces/network-status.js';
import { z } from 'zod';
import { log, refusalOfParse } from '../util/log.js';
import { reconcileSpaceSearchIndexes } from '../spaces/search-index-presence.js';
import { searchReadinessSnapshot, isSearchDown } from '../spaces/search-readiness.js';
import type { SpaceMeta, KnowledgeType } from '../config/types.js';
import { KNOWLEDGE_TYPES } from '../config/types.js';
import { writeFile as writeSpaceFile } from '../files/files.js';
import {
  TypeSchemasZ,
  findBrokenLibraryRefs, findWrongKindLibraryRefs, wrongKindRefsError,
  parseTypeSchema, withTypeSchemas,
  DeleteSpaceBody, RenameSpaceBody, ReorderSpacesBody, PutSchemaBody,
} from '../spaces/body-schemas.js';
import { requireSettingsFields, singleTypeEditBody } from '../auth/require-settings-fields.js';
import { planSpaceMetaUpdate, applySpaceMetaUpdate, networkWriteNotice } from '../spaces/meta-update.js';
import { refuseFaceWidthChange } from '../spaces/face-width-change.js';
import { planSpaceCreate, applySpaceCreate } from '../spaces/space-create.js';
import { spaceCollection } from '../db/space-collection.js';
import type { TokenRights } from '../config/rights-shape.js';
import { sendCaughtFailure, sendStoreFailure } from './send-failure.js';

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
    // Only the collections holding a record get indexes rebuilt; an empty one needs none (Q-165).
    await reconcileSpaceSearchIndexes(spaceId, { waitForReady: false, force: true });
    res.json({ ok: true, spaceId, status: 'rebuilding' });
  } catch (err) {
    sendCaughtFailure(res, `POST /api/spaces/${spaceId}/rebuild-indexes`, err, { error: err instanceof Error ? err.message : String(err) });
  }
});

registerReembedRoute(spacesRouter);
registerActivityResetRoute(spacesRouter);
registerFileStampReportRoute(spacesRouter);

// PATCH /api/spaces/:id/rename
spacesRouter.patch('/:id/rename', globalRateLimit, requireAdminOrSpaceAdminMfaScoped('id'), async (req, res) => {
  const oldId = req.params['id'] as string;
  const parsed = RenameSpaceBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(refusalOfParse(parsed.error));
    return;
  }
  // The rename IS the change, so the snapshot is just the two ids. Set before the attempt and only read
  // by the audit middleware on a <400 response, so a failed rename records nothing.
  req.auditSnapshots = { before: { id: oldId }, after: { id: parsed.data.newId } };

  // One mapping from a failed rename to its status, shared with the `space_rename` tool (Q-139).
  const r = await renameSpaceAct(oldId, parsed.data);
  if (r.status === 200) { res.json({ space: spaceForWire(r.space) }); return; }
  res.status(r.status).json(r.code ? { error: r.error, code: r.code } : { error: r.error });
});

// POST /api/spaces/reorder
spacesRouter.post('/reorder', globalRateLimit, requireAdminMfa, (req, res) => {
  const parsed = ReorderSpacesBody.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json(refusalOfParse(parsed.error));
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
    ...(isProxy(space) ? { proxyFor: space.proxyFor } : {}),
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

  // Optional per-space entity/fact/edge/chrono counts (?counts=true)
  const includeCounts = req.query['counts'] === 'true';
  let countsBySpaceId: Record<string, { facts: number; entities: number; edges: number; chrono: number }> = {};
  if (includeCounts) {
    const countResults = await Promise.allSettled(
      visibleSpaces.map(async s => {
        const memberIds = memberSpacesForRequest(req, s.id);
        const perMember = await Promise.all(memberIds.map(async mid => ({
          facts: await col(spaceCollection(mid, 'facts')).countDocuments(),
          entities: await col(spaceCollection(mid, 'entities')).countDocuments(),
          edges:    await col(spaceCollection(mid, 'edges')).countDocuments(),
          chrono:   await col(spaceCollection(mid, 'chrono')).countDocuments(),
        })));
        return {
          id: s.id,
          counts: {
            facts: perMember.reduce((n, c) => n + c.facts, 0),
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

  // Read once per request; applied per space below, inside the per-token visible-spaces map, so a scoped token is
  // told about its own spaces only. Derived, never stored and never replicated: it would be stale the moment
  // search returned.
  const search = searchReadinessSnapshot();
  const searchDown = isSearchDown(search);
  const spaces = visibleSpaces.map((space) => {
    const { id, label, builtIn, folders, maxGiB, flex, proxyFor, meta, dupeRules, dupeMergeSurvivor, dupeRulesOnInsert, recordTtlDays, documentExtraction, imageAnalysis, audioAnalysis, videoAnalysis, textAnalysis, indexStatus } = space;
    // Q-320: THIS instance's answer to an unknown write field, read back like the neighbouring settings — `'refuse'`, absent when warn.
    const unknownWriteFields = unknownWriteFieldsToReport(space);
    const actPending = spaceActPendingField(cfg, id, req.authToken as Parameters<typeof spaceActPendingField>[2]);
    return {
    id, label, builtIn, folders, maxGiB, flex, ...(actPending ? { actPending } : {}),
    usageGiB: usageBySpaceId.get(id)?.usageGiB ?? 0,
    // Present only when the figure is a FLOOR. An absent field means the measurement was whole, which is the
    // same convention the storage metric uses — a caller that ignores this field is not silently misled about
    // a healthy space, only about an unreadable one, and that is the case worth a field.
    ...((usageBySpaceId.get(id)?.incomplete.length ?? 0) > 0
      ? { usageIncomplete: usageBySpaceId.get(id)!.incomplete }
      : {}),
    ...(indexStatus ? { indexStatus } : {}),
    // A space that is `building` because database search is not answering (Q-113): it is not failing and it is not
    // slow, it is waiting. Says so, and since when, so the badge can say why it is not moving.
    ...(searchDown && indexStatus === 'building'
      ? { indexWaiting: true, ...(search.since !== null ? { indexWaitingSince: new Date(search.since).toISOString() } : {}) }
      : {}),
    ...(isProxy(space) ? { proxyFor } : {}),
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
    ...(unknownWriteFields ? { unknownWriteFields } : {}),
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
// decided by `planSpaceCreate`, so an MCP `save_space` reaches the same rules instead of a weaker copy of them
// (B-2). What stays here is turning an outcome into a status.
//
// `space-create-contract.test.js` pins that chain, including that a refusal leaves NO SPACE BEHIND, and it was proven
// against this handler before the move.
// The createSpaces right, not instance admin (Q-134): the one predicate every creating door asks. MFA stays — it is a
// per-token policy, not an admin property.
spacesRouter.post('/', globalRateLimit, requireCreateSpacesMfa, async (req, res) => {
  const decision = planSpaceCreate(req.body);
  if (!decision.ok) {
    res.status(decision.refusal.status).json(decision.refusal.body);
    return;
  }

  const result = await applySpaceCreate(decision.plan, { tokenId: req.authToken?.id ?? null });
  if (result.outcome === 'conflict') {
    res.status(409).json({ error: result.error });
    return;
  }
  if (result.outcome === 'failed') {
    res.status(500).json({ error: result.error });
    return;
  }
  res.status(201).json({ space: spaceForWire(result.space) });
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
    res.status(202).json({ status: 'vote_pending', rounds: result.rounds, message: 'Meta change requires network vote', ...networkWriteNotice(result, req.authToken as WriteCaller) });
    return;
  }
  res.json({ space: spaceForWire(result.space), ...networkWriteNotice(result, req.authToken as WriteCaller) });
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
    res.status(400).json(refusalOfParse(parsed.error));
    return;
  }

  // Validate any $ref values against the instance schema library
  const brokenRefs = findBrokenLibraryRefs(parsed.data.typeSchemas as z.infer<typeof TypeSchemasZ>);
  if (brokenRefs.length > 0) {
    res.status(422).json({ error: `Schema library ${brokenRefs.length === 1 ? 'entry' : 'entries'} not found: ${brokenRefs.join(', ')}. Create ${brokenRefs.length === 1 ? 'it' : 'them'} via POST /api/schema-library before referencing.` });
    return;
  }
  // And a reference to an entry filed under ANOTHER kind (`Q-215`): its fields would never apply.
  const wrongKind = findWrongKindLibraryRefs(parsed.data.typeSchemas as z.infer<typeof TypeSchemasZ>);
  if (wrongKind.length > 0) {
    res.status(422).json({ error: wrongKindRefsError(wrongKind) });
    return;
  }

  // Write a backup of the previous schema before replacing it
  // Q-52: a networked space's schema is the network's to decide, as on PATCH — this answers 202 with the round.
  const voted = await voteOnSchemaEditIfNetworked(id, parsed.data.typeSchemas, 'replace', req.authToken as WriteCaller);
  if (voted) { res.status(voted.status).json(voted.body); return; }
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

  // Replace the entire typeSchemas (full-replace semantics), through the own definitions (F-39.2) so a space whose
  // meta is rebuilt from network layers keeps the edit.
  const updated = commitOwnMetaEdit(id, base => withTypeSchemas(base, parsed.data.typeSchemas));
  if (!updated) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }
  // Full-replace: `previousTypeSchemas` was read before the write, so this is a true before/after. The
  // audit layer summarises it as type and property-key NAMES — a schema replacement that recorded
  // nothing was the whole gap here.
  req.auditSnapshots = {
    before: { typeSchemas: previousTypeSchemas ?? {} },
    after: { typeSchemas: updated.meta?.typeSchemas ?? {} },
  };
  res.json({ space: spaceForWire(updated) });
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

  // `resolve` (default `META_RESOLVE_DEFAULT`, the same on MCP): a library type carries its `$ref` AND its definition,
  // and a round trip keeps the reference (`Q-168`). `?resolve=0|false` (anything but `1`/`true`, as before) returns the
  // stored form alone. The one answer, for both doors, is `spaceMetaAnswer` (`Q-95`).
  const q = req.query['resolve'];
  const resolveRefs = q === undefined ? META_RESOLVE_DEFAULT : (q === '1' || q === 'true');
  res.json(await spaceMetaAnswer({ spaceId: id, space, memberIds: memberSpacesForRequest(req, id), resolveRefs }));
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

/**
 * The refusal, built from the vocabulary rather than spelling it out.
 *
 * Three routes below wrote `Must be one of: entity, fact, edge, chrono` by hand, and the check beside each
 * of them reads `KNOWLEDGE_TYPES`. They agree today and they are two copies of one fact: the release that
 * renamed `memory` to `fact` had to find all three, and the next change to the vocabulary will have to find
 * them again — with nothing failing if it misses one, because a 400 nobody asserts on is just a 400.
 */
const knowledgeTypeRefusal = (got: string) =>
  `Invalid knowledgeType '${got}'. Must be one of: ${KNOWLEDGE_TYPES.join(', ')}`;
const MAX_TYPES_PER_KIND = 200;

// GET /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName
spacesRouter.get('/:id/meta/typeSchemas/:knowledgeType/:typeName', globalRateLimit, requireSpaceAuthScoped('id'), (req, res) => {
  const { id, knowledgeType, typeName } = req.params as { id: string; knowledgeType: string; typeName: string };

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: knowledgeTypeRefusal(knowledgeType) });
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
spacesRouter.put('/:id/meta/typeSchemas/:knowledgeType/:typeName', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly,
  requireSettingsFields('id', singleTypeEditBody), async (req, res) => {
  const { id, knowledgeType, typeName } = req.params as { id: string; knowledgeType: string; typeName: string };

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: knowledgeTypeRefusal(knowledgeType) });
    return;
  }

  // Parsed WITH the collection it is filed under (`Q-215`): `TypeSchemaZ` alone cannot see it, so `endpoints` on an entity type
  // was stored by this door while every other door refused it.
  const parsed = parseTypeSchema(knowledgeType as KnowledgeType, typeName, req.body ?? {});
  if (!parsed.ok) {
    res.status(400).json(parsed.refusal);
    return;
  }

  // Validate any $ref against the instance schema library before writing
  if ('$ref' in parsed.schema) {
    const brokenRefs = findBrokenLibraryRefs({ [knowledgeType]: { _check: parsed.schema } });
    if (brokenRefs.length > 0) {
      res.status(422).json({ error: `Schema library ${brokenRefs.length === 1 ? 'entry' : 'entries'} not found: ${brokenRefs.join(', ')}. Create ${brokenRefs.length === 1 ? 'it' : 'them'} via POST /api/schema-library before referencing.` });
      return;
    }
    const wrongKind = findWrongKindLibraryRefs({ [knowledgeType]: { [typeName]: parsed.schema } });
    if (wrongKind.length > 0) {
      res.status(422).json({ error: wrongKindRefsError(wrongKind) });
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

  // Q-52: a networked space's schema is the network's to decide, as on PATCH — this answers 202 with the round.
  const voted = await voteOnSchemaEditIfNetworked(id, { [kt]: { [typeName]: parsed.schema } }, 'merge', req.authToken as WriteCaller);
  if (voted) { res.status(voted.status).json(voted.body); return; }
  // Merge the new type definition in, through the own definitions (F-39.2) so a layered space keeps the edit.
  const updated = commitOwnMetaEdit(id, base => withType(base, kt, typeName, parsed.schema));
  if (!updated) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // A single-type upsert is audited under the same `space.schema.update` operation as the full replace,
  // so it needs the same snapshot shape. Without it the granular route — the one the Schema tab actually
  // uses — was the silent half of an already-silent pair.
  req.auditSnapshots = {
    before: { typeSchemas: existingMeta.typeSchemas ?? {} },
    after: { typeSchemas: updated.meta?.typeSchemas ?? {} },
  };

  res.json({ knowledgeType: kt, typeName, schema: parsed.schema });
});

// DELETE /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName — remove a single type definition
spacesRouter.delete('/:id/meta/typeSchemas/:knowledgeType/:typeName', globalRateLimit, requireSpaceAuthMfaScoped('id'), denyReadOnly, async (req, res) => {
  const { id, knowledgeType, typeName } = req.params as { id: string; knowledgeType: string; typeName: string };

  if (!VALID_KNOWLEDGE_TYPES.has(knowledgeType)) {
    res.status(400).json({ error: knowledgeTypeRefusal(knowledgeType) });
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

  // Q-52: a networked space's schema is the network's to decide, as on PATCH — this answers 202 with the round.
  const voted = await voteOnSchemaEditIfNetworked(id, withoutType(existingMeta, kt, typeName).typeSchemas, 'replace', req.authToken as WriteCaller);
  if (voted) { res.status(voted.status).json(voted.body); return; }
  // Through the own definitions (F-39.2). A type a network layer defines comes back at the next recompute: a
  // replicated schema is additive, so only the network can take its own type away.
  const updated = commitOwnMetaEdit(id, base => withoutType(base, kt, typeName));
  if (!updated) {
    res.status(404).json({ error: `Space '${id}' not found` });
    return;
  }

  // Deleting a type is the change most worth having in the log: it silently widens what the space
  // accepts from then on, and the definition it removed is not recoverable from the entry alone.
  req.auditSnapshots = {
    before: { typeSchemas: existingMeta.typeSchemas ?? {} },
    after: { typeSchemas: updated.meta?.typeSchemas ?? {} },
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
 * be refused. The one thing a reader may not do is RUN rules it could not save: a check (either mode) with a proposed `meta` whose
 * rules differ from the stored ones is a 403 (`refusalOfUnsavableRules`, inside the door module), because a rule is
 * evaluated on the event loop; the refusal comes before the heavy-call rail is charged.
 *
 * **The second factor STAYS.** `space-admin-reaches-its-own-space-settings.test.js` pins MFA on the widened
 * routes as deliberate, the reported defect is the rung rather than the factor, and loosening more than was
 * broken on an auth path is not a bargain worth taking.
 */
spacesRouter.post('/:id/validate-schema', globalRateLimit, requireSpaceAuthMfaScoped('id'), async (req, res) => {
  const id = req.params['id'] as string;
  /*
   * F-46 (R6-12): the one sequence both doors run (`spaces/schema-validate-door.ts`) — `sample` mode, the stored-data walk paged by
   * `after` / `nextAfter` with a fixed projection, values only for a caller who may read the space's knowledge, the heavy-call rail
   * and the single flight. This door adds what it has always answered in stored mode: the meta it checked (the MCP tool never echoes
   * it). The dynamic import keeps the validators out of this module's load, as the inline scan's import did.
   */
  const { beginSchemaValidate } = await import('../spaces/schema-validate-door.js');
  const rights = (req.authToken as { rights?: TokenRights } | undefined)?.rights;
  const outcome = await beginSchemaValidate({
    spaceId: id,
    memberIds: memberSpacesForRequest(req, id),
    body: req.body ?? {},
    rights,
    callerKey: (req.authToken as { id?: string } | undefined)?.id ?? req.ip ?? 'unknown',
    transport: 'rest',
  });
  if (outcome.status !== 200) { res.status(outcome.status).json(outcome.body ?? { error: outcome.error }); return; }
  const { spaceId, ...answer } = outcome.answer;
  res.json(outcome.mode === 'stored' ? { spaceId, meta: outcome.meta, ...answer } : outcome.answer);
});

// DELETE /api/spaces/:id — requires { "confirm": true } on every space, networked or not (R4).
//
// Solo space (not in any network, or only in pub/sub networks this instance subscribes to, D-40): deleted here, 204.
// Networked space: a space_deletion round opens on every network that votes on it (`proposeRound`, which casts this
// instance's yes, settles it and tells the members). Where that yes decides — a club, a pub/sub this instance publishes,
// a network where it is the only member — the space leaves the network in this request; the local copy goes once no
// network carries it. 200 when that happened, 202 while a round is still open somewhere. A repeat while a round is open
// or its act is under way answers that round (`repeated: true`); a 404 after a delete means it is done.
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

  const holding = networksHolding(id, cfg);
  const voting = holding.filter(n => !actsLocallyOn(n));
  const body = DeleteSpaceBody.safeParse(req.body);
  if (!body.success || !body.data.confirm) {
    res.status(400).json({
      error: voting.length === 0
        ? 'This space is not in any network. Send { "confirm": true } to delete it permanently.'
        : 'Send { "confirm": true } to delete this space. It is in a network: on a club or pub/sub network, or where this instance is the only member, the deletion acts at once.',
    });
    return;
  }
  const where = `DELETE /api/spaces/${id}`;
  try {
    const now = Date.now();
    const opened = voting.length === 0 ? [deleteSpaceLocally(id, holding)] : voting.map((net) => {
      const prior = ownSpaceRoundInProgress(net, { roundType: 'space_deletion', localSpaceId: id }, now, cfg);
      return prior ? repeatedRound(net, cfg, prior, now) : openedRound(proposeRound(net, cfg, {
        type: 'space_deletion', subjectInstanceId: cfg.instanceId, subjectLabel: cfg.instanceLabel, subjectUrl: '', spaceId: id,
        // The network's id for it (Q-133): a member that calls the space something else resolves this one.
        networkSpaceId: localToRemote(net, id),
      }, { now }));
    });
    if (voting.length > 0) saveConfig(cfg);
    const answer = deletionAnswer(await awaitDoorRounds(opened), id, voting.length === 0, where);
    if (answer.store) sendStoreFailure(res, answer.store, answer.body ?? undefined);
    else if (answer.body === null) res.status(204).end();
    else res.status(answer.status).json(answer.body);
  } catch (err) {
    sendCaughtFailure(res, where, err, { error: 'The deletion did not complete; see the log.' });
  }
});
