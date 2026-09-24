/**
 * The decision half of a space update: every refusal, and the values a caller must end up writing.
 *
 * ## Why this is a function and not a route
 *
 * Five capabilities were reachable over REST and not over MCP, and the principle behind the report is the one this
 * file serves: *"the rights matrix decides what a token may do; the surface should not also decide whether it
 * can."* Two of the five were thin wrappers over an existing function. This one is not — `updateSpace()` exists,
 * but `PATCH /api/spaces/:id` wraps it in a chain of refusals, and a tool that called `updateSpace()` directly
 * would skip all of them. That is the *two surfaces, one rule, one weaker* defect being reintroduced by the fix
 * for it.
 *
 * So the chain lives here, and both surfaces call it. What a caller still owns is the WRITE — `updateSpace`, the
 * network vote, the peer notify — because those differ in how they are reported, not in whether they are allowed.
 *
 * ## The split: decisions here, side effects at the caller
 *
 * Nothing in this file writes config, opens a vote or touches a peer. It reads config (the extraction ceiling, the
 * schema library) and returns either a refusal or a plan. That is what makes the refusal chain testable without
 * standing up Docker, and it is why the plan carries `recordTtlDays` and `documentExtraction` already normalised:
 * those are decisions with config reads in them, and leaving them at the call site is how the second surface ends
 * up storing a value the first one would have capped.
 *
 * ## The ORDER is part of the contract, not an implementation detail
 *
 * `space-meta-update-contract.test.js` pins it, because a refactor loses it silently. Existence, then the
 * precondition, then the body, then the schema-library refs. A precondition evaluated after validation is not a
 * precondition — it reports a body problem for a write that was never allowed to be applied, and the caller hits
 * the real conflict on their second attempt instead of their first. And a rejected write must change NOTHING,
 * which is why the audit snapshot is returned in the plan rather than taken as we go.
 */
import type { SpaceConfig, SpaceMeta, KnowledgeType, TypeSchema, DocExtractionMode } from '../config/types.js';
import { normalizeDocExtractionMode } from '../config/types.js';
import { getConfig, saveConfig, getSecrets, getDocumentProcessingConfig } from '../config/loader.js';
import { updateSpace, refuseRemovedDescription } from './spaces.js';
import { ensureTtlIndex } from '../brain/ttl.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { proposedMetaFields } from '../sync/meta-round-merge.js';
import { concludeRoundIfReady } from '../sync/governance.js';
import { log } from '../util/log.js';
import { v4 as uuidv4 } from 'uuid';
import { capDocExtractionMode } from '../files/converters/extraction-level.js';
import { checkMetaPrecondition, preconditionErrorBody } from './meta-precondition.js';
import { normaliseRecordTtl } from './record-ttl.js';
import { UpdateSpaceBody, findBrokenLibraryRefs, brokenRefsError, stripServerOwnedMeta, stripServerOwnedSpace } from './body-schemas.js';
import type { TypeSchemasZ } from './body-schemas.js';
import type { z } from 'zod';
import { sweepSuppressedVectors } from '../brain/suppression-sweep.js';

/**
 * Deep-merge an incoming PATCH `meta` payload into the existing SpaceMeta.
 *
 * - Scalar fields (purpose, usageNotes, validationMode,
 *   strictLinkage) overwrite the existing value when present in `incoming`.
 * - `typeSchemas` is merged per-knowledge-type, then per-type-name:
 *   types present in `incoming` are added or updated; types *not* mentioned
 *   in the request body are left untouched.
 *
 * The `version`, `updatedAt`, and `previousVersions` housekeeping fields are
 * intentionally omitted from the return value — `updateSpace()` re-adds them.
 *
 * Exported for testing as well as for the planner. The merge/replace decision is pure and is where a deletion was
 * silently lost for as long as it was; a unit test that reaches it directly is worth more than one that has to
 * stand up Docker and a network to observe the same branch.
 */
export function mergeSpaceMeta(
  existing: SpaceMeta,
  incoming: Partial<SpaceMeta>,
  typeSchemasMode: 'merge' | 'replace' = 'merge',
): Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'> {
  // Spread the existing base (drop housekeeping fields that updateSpace re-adds)
  const { version: _v, updatedAt: _u, previousVersions: _pv, ...existingBase } = existing;
  const merged: Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'> = { ...existingBase };

  // Scalar fields — replace if present in incoming
  if (incoming.purpose !== undefined) merged.purpose = incoming.purpose;
  if (incoming.usageNotes !== undefined) merged.usageNotes = incoming.usageNotes;
  if (incoming.validationMode !== undefined) merged.validationMode = incoming.validationMode;
  if (incoming.strictLinkage !== undefined) merged.strictLinkage = incoming.strictLinkage;
  // Guarded on `!== undefined`, not on truthiness. `suppressEmbeddings: false` is how an operator turns
  // suppression back OFF, and a truthy guard would drop that patch and leave the space suppressed while
  // answering 200 — the flag reporting one thing and the write path doing another.
  if (incoming.suppressEmbeddings !== undefined) merged.suppressEmbeddings = incoming.suppressEmbeddings;

  // typeSchemas — merge per-KT, per-type: incoming types add/update, existing untouched types preserved.
  // Under `replace` the payload is authoritative instead, so a type absent from it is deleted. Note the
  // guard is on `!== undefined`, so `replace` with `typeSchemas: {}` clears every type — which is the only
  // way to express "this space declares nothing" and has to be reachable.
  if (incoming.typeSchemas !== undefined && typeSchemasMode === 'replace') {
    merged.typeSchemas = incoming.typeSchemas;
  } else if (incoming.typeSchemas !== undefined) {
    const existingTs = existingBase.typeSchemas ?? {};
    const mergedTs: Partial<Record<KnowledgeType, Record<string, TypeSchema>>> = { ...existingTs };
    for (const [kt, ktMap] of Object.entries(incoming.typeSchemas) as
        [KnowledgeType, Record<string, TypeSchema> | undefined][]) {
      if (!ktMap) continue;
      mergedTs[kt] = { ...(existingTs[kt] ?? {}), ...ktMap };
    }
    merged.typeSchemas = mergedTs;
  }

  return merged;
}

/**
 * A refusal, carrying the HTTP status.
 *
 * The status is part of the contract rather than something each surface re-derives: five distinct numbers, and a
 * caller branching on them cannot tell a stale precondition from a malformed one if two collapse into one. An MCP
 * tool maps these to its own error shape; it does not decide them.
 */
export type MetaUpdateRefusal = {
  status: 400 | 404 | 412 | 422;
  body: { error: string; expectedVersion?: number; currentVersion?: number };
};

/** What a caller must write, with every decision already made. */
export type MetaUpdatePlan = {
  spaceId: string;
  /**
   * The space the plan was built against.
   *
   * Returned rather than left to the caller to re-narrow: the caller looked it up as possibly-undefined, the 404
   * above is what rules that out, and handing back the record is how the type says so. A caller re-asserting
   * non-undefined with `!` would be claiming exactly what this function decided.
   */
  space: SpaceConfig;
  /** The parsed body, with `description` already rewritten into `meta.purpose`. */
  data: z.infer<typeof UpdateSpaceBody>;
  /** The merged meta to store, or `undefined` when the request touches no meta at all. */
  mergedMeta: SpaceMeta | undefined;
  /** Present only when `documentExtraction` was in the body; already capped to the instance ceiling. */
  documentExtraction: DocExtractionMode | undefined;
  hasDocExtraction: boolean;
  /** Present only when `recordTtlDays` was in the body; already merged over what was stored. */
  recordTtlDays: SpaceConfig['recordTtlDays'];
  hasRecordTtl: boolean;
  /** The audit change-list snapshot, taken before anything is applied. */
  audit: { before: Record<string, unknown>; after: Record<string, unknown> };
};

export type MetaUpdateDecision =
  | { ok: false; refusal: MetaUpdateRefusal }
  | { ok: true; plan: MetaUpdatePlan };

/**
 * Decide a space update: refuse it, or return everything needed to apply it.
 *
 * `space` is passed in rather than looked up so the caller keeps ownership of how it resolves a space id — the MCP
 * side already holds a resolved space, and a second lookup here would be a second place for the two surfaces to
 * disagree about what "not found" means.
 */
export function planSpaceMetaUpdate(input: {
  spaceId: string;
  space: SpaceConfig | undefined;
  body: unknown;
  ifMatch: string | undefined;
}): MetaUpdateDecision {
  const { spaceId, space, body, ifMatch } = input;

  if (!space) {
    return { ok: false, refusal: { status: 404, body: { error: `Space '${spaceId}' not found` } } };
  }

  const removed = refuseRemovedDescription(body);
  if (removed) return { ok: false, refusal: removed };

  // Optimistic concurrency: honour If-Match against the current meta version, if the client sent one.
  // Runs before validation, the audit snapshot and every side effect — a rejected write must change
  // nothing and record nothing.
  const precondition = checkMetaPrecondition(ifMatch, space.meta?.version ?? 0);
  if (!precondition.ok) {
    return { ok: false, refusal: { status: precondition.status, body: preconditionErrorBody(precondition) } };
  }

  // Accept what we emit: a caller who GETs a space, edits one field and PATCHes it back is doing the obvious
  // thing, and `version`/`updatedAt`/`previousVersions`/`needsReindex` come straight out of our own response.
  // Stripped, not rejected — and ONLY those, so `.strict()` still catches a typo like `validationMdoe`, which
  // someone would otherwise believe had turned validation on. See SERVER_OWNED_META_FIELDS.
  //
  // Both levels are stripped now, because the top-level body became `.strict()` (owner ruling P-4, A,
  // 2026-08-15). Before that it silently dropped everything it did not declare, so only `meta` needed a
  // strip; strictness without this would turn the very round-trip the meta strip exists to protect into a
  // 400 one level up. Strip THEN be strict — never either alone.
  const stripped = stripServerOwnedSpace(body, { forUpdate: true });
  const bodyForParse = stripped != null && typeof stripped === 'object' && !Array.isArray(stripped)
    ? { ...(stripped as Record<string, unknown>), ...('meta' in (stripped as object) ? { meta: stripServerOwnedMeta((stripped as { meta?: unknown }).meta) } : {}) }
    : stripped;

  const parsed = UpdateSpaceBody.safeParse(bodyForParse);
  if (!parsed.success) {
    return { ok: false, refusal: { status: 400, body: { error: parsed.error.message } } };
  }


  // Validate any $ref values in the incoming meta against the instance schema library
  if (parsed.data.meta?.typeSchemas) {
    const brokenRefs = findBrokenLibraryRefs(parsed.data.meta.typeSchemas as z.infer<typeof TypeSchemasZ>);
    if (brokenRefs.length > 0) {
      return { ok: false, refusal: { status: 422, body: { error: brokenRefsError(brokenRefs) } } };
    }
  }

  // Snapshot for the audit log's change list, taken BEFORE anything is applied. Handing the whole record
  // over is safe: `audit-changes.ts` reads only the fields allowlisted for `space.update` and never
  // touches the rest, so this cannot publish something by carrying it. The middleware only records it on
  // a <400 response, so a request rejected above logs no change — which is why every refusal returns before here.
  const audit = {
    before: { ...space, ...space.meta } as Record<string, unknown>,
    after: { ...space, ...space.meta, ...parsed.data, ...(parsed.data.meta ?? {}) } as Record<string, unknown>,
  };

  // Record TTL (F10): a PARTIAL object MERGES over the stored windows, so `{"chrono":90}` does not silently clear
  // the other four. That is the opposite of the `typeSchemas` rule, and deliberately so: there a named type is a
  // whole definition the caller holds, here each bucket is one independent number. `hasRecordTtl` gates the write
  // so a CLEAR is applied rather than skipped as if the field were absent.
  //
  // The guard is written as the `!== undefined` comparison rather than as `hasRecordTtl ? …`, because only the
  // comparison NARROWS the type — a boolean const does not, and `normaliseRecordTtl` does not accept `undefined`.
  const hasRecordTtl = parsed.data.recordTtlDays !== undefined;
  const recordTtlDays = parsed.data.recordTtlDays !== undefined
    ? normaliseRecordTtl(space.recordTtlDays, parsed.data.recordTtlDays)
    : undefined;

  // A space may pick any extraction mode up to the instance ceiling and nothing beyond. The client only
  // offers valid options, but an API caller (or a space whose stored value predates a lowered ceiling)
  // could still send more — so cap it here rather than store a value the runtime would only clamp later
  // anyway. Distinguish field ABSENT (leave the override alone) from an explicit value: `null`/legacy
  // clears it (stored as undefined), `auto` follows the ceiling, a concrete mode is capped to the ceiling.
  const hasDocExtraction = parsed.data.documentExtraction !== undefined;
  const documentExtraction: DocExtractionMode | undefined = !hasDocExtraction
    ? undefined
    : (() => {
        const requested = normalizeDocExtractionMode(parsed.data.documentExtraction);
        if (!requested || requested === 'auto') return requested;  // null (clear → undefined) / auto pass through
        return capDocExtractionMode(getDocumentProcessingConfig().mode ?? 'auto', requested);
      })();

  // Merge the incoming meta with the existing meta so that PATCH has true RFC-7396 semantics: scalar fields
  // overwrite, typeSchemas entries are added/updated, and types *not* mentioned in the body are preserved.
  // `typeSchemasMode: 'replace'` opts out of that last clause so a deletion can be expressed at all.
  const mergedMeta: SpaceMeta | undefined =
    parsed.data.meta !== undefined
      ? mergeSpaceMeta(space.meta ?? {}, parsed.data.meta, parsed.data.typeSchemasMode ?? 'merge') as SpaceMeta
      : undefined;

  return {
    ok: true,
    plan: {
      spaceId,
      space,
      data: parsed.data,
      mergedMeta,
      documentExtraction,
      hasDocExtraction,
      recordTtlDays,
      hasRecordTtl,
      audit,
    },
  };
}

/**
 * What actually happened, in terms both surfaces can report.
 *
 * `vote_pending` is neither a failure nor a success: the space belongs to a network that votes on meta changes, so
 * the change is proposed rather than applied. REST answers 202 for it; the MCP tool says so in words. Collapsing it
 * into "ok" would tell an agent its schema was written when it was not.
 */
export type MetaUpdateOutcome =
  | { outcome: 'applied'; space: SpaceConfig }
  | { outcome: 'vote_pending'; rounds: { networkId: string; networkLabel: string; roundId: string }[] }
  | { outcome: 'not_found' };

/**
 * Apply a plan: the local settings, then either the network vote or the write.
 *
 * ## Why this exists now and not with the planner
 *
 * It was left out of the extraction deliberately — an interface with one caller is designed against a guess. The
 * second caller is `schema_update`, and it settled two things one caller could not:
 *
 *  - **the vote branch belongs in here, not at the call site.** A tool that skipped it would let an agent write meta
 *    directly in a space whose network votes on exactly that. That is a governance bypass, not a missing feature.
 *  - **the outcome is a value, not a status code.** REST maps `vote_pending` to 202 and MCP maps it to a sentence;
 *    neither of them decides what it means.
 *
 * Side effects only. Every refusal already happened in `planSpaceMetaUpdate`, which is why the only failure here is
 * `not_found` — the one thing that can change between planning and writing.
 */
export async function applySpaceMetaUpdate(plan: MetaUpdatePlan): Promise<MetaUpdateOutcome> {
  const { spaceId: id, space, data: patchData, mergedMeta } = plan;
  const cfg = getConfig();

  // Duplicate rules are local (never governed) — applied now, so they are not silently dropped when a meta change
  // on the same request opens a network vote below.
  if (patchData.dupeRules !== undefined || patchData.dupeMergeSurvivor !== undefined || patchData.dupeRulesOnInsert !== undefined) {
    updateSpace(id, { dupeRules: patchData.dupeRules, dupeMergeSurvivor: patchData.dupeMergeSurvivor, dupeRulesOnInsert: patchData.dupeRulesOnInsert });
  }

  // Record TTL (F10) is a local operational setting, like dupe rules — applied immediately, never voted. The value
  // arrives already MERGED over what was stored, so a partial write does not clear the buckets it did not mention;
  // `hasRecordTtl` gates the write so a CLEAR is applied rather than skipped as if the field were absent.
  if (plan.hasRecordTtl) {
    updateSpace(id, { recordTtlDays: plan.recordTtlDays });
    if (plan.recordTtlDays !== undefined) void ensureTtlIndex(id).catch(err => log.warn(`ensureTtlIndex ${id}: ${err}`));
  }

  // `M-2`: the conversion marker. Local like the two above and applied here for the same reason plus one of
  // its own — it says what has been done to the data on THIS disk, so a network vote could carry one
  // instance's finished conversion onto peers that have converted nothing.
  if (patchData.completeLinkage !== undefined) {
    updateSpace(id, { completeLinkage: patchData.completeLinkage });
  }

  // Already capped to the instance ceiling by the planner.
  if (plan.hasDocExtraction) {
    updateSpace(id, { documentExtraction: plan.documentExtraction });
  }

  // Network voting: a networked space PROPOSES a meta change rather than applying it.
  if (mergedMeta !== undefined) {
    const networkedIn = cfg.networks.filter(n => n.spaces.includes(id));
    if (networkedIn.length > 0) {
      const now = new Date().toISOString();
      const rounds: { networkId: string; networkLabel: string; roundId: string }[] = [];

      for (const net of networkedIn) {
        const roundId = uuidv4();
        const deadline = new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString();
        net.pendingRounds.push({
          roundId,
          type: 'meta_change',
          subjectInstanceId: cfg.instanceId,
          subjectLabel: cfg.instanceLabel,
          subjectUrl: '',
          deadline,
          openedAt: now,
          votes: [{ instanceId: cfg.instanceId, vote: 'yes', castAt: now }],
          spaceId: id,
          pendingMeta: mergedMeta,
          // Provenance, so conclusion can apply just this patch rather than this whole snapshot. Rounds stay open
          // for `votingDeadlineHours`, so a second proposal landing before the first concludes is ordinary, and
          // without these two fields the later one reverts the earlier one's edit with no error anywhere. See
          // sync/meta-round-merge.ts.
          metaChangedFields: proposedMetaFields(patchData.meta ?? {}),
          baseMetaVersion: space.meta?.version ?? 0,
        });
        /*
         * Evaluated now, because the proposer's yes above may already be enough (`Q-49`).
         *
         * On club and pub/sub one yes passes a round, and a closed network with no other member needs only ours —
         * but nothing looked at the round until another vote arrived, so the change answered 202 and sat unapplied
         * until somebody cast the identical yes again or the deadline expired it. The round stays in the list
         * either way, concluded or not, so peers learn of it exactly as before.
         */
        const opened = net.pendingRounds[net.pendingRounds.length - 1]!;
        if (!concludeRoundIfReady(net, opened)) rounds.push({ networkId: net.id, networkLabel: net.label, roundId });
      }

      // Non-meta updates apply immediately (label, maxGiB). `description` is not among them: the planner rewrote it
      // into `meta.purpose`, so it travels with the rest of the meta and is voted on.
      const nonMetaUpdates: { label?: string; maxGiB?: number | null; faceDescriptorDims?: number } = {};
      if (patchData.label !== undefined) nonMetaUpdates.label = patchData.label;
      if (patchData.maxGiB !== undefined) nonMetaUpdates.maxGiB = patchData.maxGiB;
      // `faceDescriptorDims` belongs here for the same reason `maxGiB` does: it configures THIS instance's
      // index, not the shared meaning of the space, so it is not a thing peers vote on. Omitting it would have
      // made a width change silently vanish whenever the same PATCH also touched meta on a networked space —
      // a 202 for two edits, one of which never happened.
      if (patchData.faceDescriptorDims !== undefined) {
        nonMetaUpdates.faceDescriptorDims = patchData.faceDescriptorDims;
      }
      if (Object.keys(nonMetaUpdates).length > 0) updateSpace(id, nonMetaUpdates);
      else saveConfig(cfg);

      // Notify peers (best-effort).
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
              event: 'meta_change_pending',
              data: { spaceId: id, spaceLabel: space.label },
            }),
            signal: AbortSignal.timeout(5_000),
          }).catch(err => log.warn(`notify ${member.label} of meta_change_pending: ${err}`));
        }
      }

      if (rounds.length > 0) return { outcome: 'vote_pending', rounds };

      // Every round passed on the proposer's own vote, so the meta is already written by the conclusion.
      const applied = getConfig().spaces.find(s => s.id === id);
      if (!applied) return { outcome: 'not_found' };
      void sweepSuppressedVectors(id, applied.meta as SpaceMeta)
        .catch(err => log.warn(`Suppression sweep failed for ${id}: ${err instanceof Error ? err.message : String(err)}`));
      return { outcome: 'applied', space: applied };
    }
  }

  // `documentExtraction` and `recordTtlDays` are pulled OUT of the spread. Both were applied above from normalised
  // values, and letting the raw body through here overwrote that with itself — so a partial TTL write cleared the
  // four buckets it did not mention, and an all-cleared write stored five explicit nulls instead of nothing. Both
  // returned 200 and looked like they had worked; found by driving the UI.
  const { documentExtraction: _rawMode, recordTtlDays: _rawTtl, ...restPatch } = patchData;
  const updated = updateSpace(id, {
    ...restPatch,
    meta: mergedMeta,
    ...(plan.hasDocExtraction ? { documentExtraction: plan.documentExtraction } : {}),
  });
  /*
   * The stored vectors follow the flag, which is what the userguide has always said happens.
   *
   * Not awaited: this runs on every meta write and a space may hold many records, so blocking the PATCH on it
   * would make an unrelated `purpose` edit feel slow. The sweep is idempotent and local — the vector does not
   * replicate — so a failure costs nothing beyond the next meta write repeating it, which is why a rejection
   * is logged rather than surfaced to the caller who was not asking about embeddings.
   */
  if (updated) {
    void sweepSuppressedVectors(id, mergedMeta as SpaceMeta)
      .catch(err => log.warn(`Suppression sweep failed for ${id}: ${err instanceof Error ? err.message : String(err)}`));
  }
  return updated ? { outcome: 'applied', space: updated } : { outcome: 'not_found' };
}
