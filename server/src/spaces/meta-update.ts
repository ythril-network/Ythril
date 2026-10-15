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
import { localToRemote } from '../sync/space-map.js';
import { replicatedMetaOf } from '../sync/replicated-meta.js';
import type { SpaceConfig, SpaceMeta, KnowledgeType, TypeSchema, DocExtractionMode, NetworkConfig } from '../config/types.js';
import { normalizeDocExtractionMode } from '../config/types.js';
import { getConfig, saveConfig, getSecrets, getDocumentProcessingConfig } from '../config/loader.js';
import { updateSpace, refuseRemovedDescription } from './spaces.js';
import { ensureTtlIndex } from '../brain/ttl.js';
import { peerSafeFetch } from '../sync/peer-fetch.js';
import { proposedMetaFields } from '../sync/meta-round-merge.js';
import { membersBehindNewKeys, type MemberSkew } from '../sync/meta-skew.js';
import { visibleNetworks } from '../auth/network-rights.js';
import { concludeRoundIfReady } from '../sync/governance.js';
import { openRoundHere } from '../networks/round-local-state.js';
import { makeSignedOwnCast } from '../util/signing.js';
import { log, NAME_QUOTED, peerList, peerText, refusalOfParse } from '../util/log.js';
import { v4 as uuidv4 } from 'uuid';
import { capDocExtractionMode } from '../files/converters/extraction-level.js';
import { checkMetaPrecondition, preconditionErrorBody } from './meta-precondition.js';
import { normaliseRecordTtl } from './record-ttl.js';
import {
  UpdateSpaceBody, findBrokenLibraryRefs, brokenRefsError, findWrongKindLibraryRefs, wrongKindRefsError, parseSpaceMeta,
  stripServerOwnedMeta, stripServerOwnedSpace,
} from './body-schemas.js';
import type { TypeSchemasZ, ParsedSpaceMeta } from './body-schemas.js';
import { mergeMetaFields, metaFieldKind } from './meta-fields.js';
import type { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { spaceForWire } from './space-for-wire.js';
// The trigger lives beside the sweep (bundle-30 `R5`): the effective-meta recompute fires it too.

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

  // Every field by its kind (`spaces/meta-fields.ts`), which is where `whenDuePasses` and `stampSkew` used to fall out of a
  // list of six: a scalar replaces when STATED (`!== undefined`, never truthiness — `suppressEmbeddings: false` is how an
  // operator turns suppression back off), an object replaces whole, and the types are merged below.
  //
  // typeSchemas — merge per-KT, per-type: incoming types add/update, existing untouched types preserved.
  // Under `replace` the payload is authoritative instead, so a type absent from it is deleted. Note the
  // guard is on `!== undefined`, so `replace` with `typeSchemas: {}` clears every type — which is the only
  // way to express "this space declares nothing" and has to be reachable.
  return mergeMetaFields(existingBase as Record<string, unknown>, incoming as Record<string, unknown>, (existingTs, incomingTs) => {
    if (typeSchemasMode === 'replace') return incomingTs;
    const had = (existingTs ?? {}) as Partial<Record<KnowledgeType, Record<string, TypeSchema>>>;
    const mergedTs: Partial<Record<KnowledgeType, Record<string, TypeSchema>>> = { ...had };
    for (const [kt, ktMap] of Object.entries(incomingTs as object) as [KnowledgeType, Record<string, TypeSchema> | undefined][]) {
      if (!ktMap) continue;
      mergedTs[kt] = { ...(had[kt] ?? {}), ...ktMap };
    }
    return mergedTs;
  }) as Omit<SpaceMeta, 'version' | 'updatedAt' | 'previousVersions'>;
}

/**
 * What a NETWORKED write proposes: the fields the request named and, inside the types, only the types it changed (R6-6).
 *
 * A round used to carry the merged meta the write was computed from — the space's EFFECTIVE meta, own definitions and every network's
 * layer — and conclusion then merged every one of those types into the proposer's own definitions and into the voted network's layer.
 * A one-type edit copied each other network's types into this network's layer, and the network's types into this instance's own
 * definitions, where they are served to every network the space is in ("nothing mixed is sent on"). So the round carries the edit
 * and nothing else; a member applies exactly that.
 *
 * `changedTypes` is `kind:Type` for each type whose definition differs from the base the write was merged over
 * (`typesAnEditChanges`), so a type the request merely repeated is not proposed again.
 *
 * It is the pick of "the fields a write named and the types it changed" out of ANY meta, so it also answers what those same parts HELD
 * before the write: handed the base the write was merged over it is the round's `metaBase` (R6-8), the values the conclusion measures
 * "did somebody change this field since the proposal" against. One walk, so what the round says it changed and what it was measured
 * against cannot be read from two places.
 */
export function proposalOf(merged: SpaceMeta, named: Partial<SpaceMeta> | undefined, changedTypes: readonly string[]): SpaceMeta {
  const out: Record<string, unknown> = {};
  const mergedFields = merged as Record<string, unknown>;
  for (const field of proposedMetaFields(named ?? {})) {
    if (metaFieldKind(field) !== 'per-type') { out[field] = mergedFields[field]; continue; }
    const types: Record<string, Record<string, unknown>> = {};
    const held = (mergedFields[field] ?? {}) as Record<string, Record<string, unknown> | undefined>;
    for (const ref of changedTypes) {
      const at = ref.indexOf(':');
      const kind = ref.slice(0, at), type = ref.slice(at + 1);
      const def = held[kind]?.[type];
      if (def !== undefined) (types[kind] ??= {})[type] = def;
    }
    out[field] = types;
  }
  return out as SpaceMeta;
}

/**
 * The types a `replace` would delete — `kind:Type` for each type in `base` that `incoming` leaves out — or none for a
 * merge. On a networked space those are exactly the types the edit does NOT remove (`Q-61`): a network round is
 * applied as a merge on every member and on the proposer (`applyMetaRound`), because deleting a type in a network can
 * break a member's customisation, its reuse of the type, or another network the space is in. Owner, 2026-09-26:
 * *"updates should be non-destructive"*. What was wrong was answering 200 as if the replace had happened.
 */
export function typesAReplaceWouldDrop(
  base: Partial<SpaceMeta>, incoming: Partial<SpaceMeta> | undefined, mode: 'merge' | 'replace',
): string[] {
  if (mode !== 'replace' || !incoming?.typeSchemas) return [];
  const out: string[] = [];
  for (const [kt, types] of Object.entries(base.typeSchemas ?? {}) as [string, Record<string, unknown> | undefined][]) {
    const keep = (incoming.typeSchemas as Record<string, Record<string, unknown> | undefined>)[kt] ?? {};
    for (const t of Object.keys(types ?? {})) if (!(t in keep)) out.push(`${kt}:${t}`);
  }
  return out.sort();
}

/** `kind:Type` in `incoming` whose definition differs from `base`'s — what an edit actually adds or changes. */
export function typesAnEditChanges(base: Partial<SpaceMeta>, incoming: Partial<SpaceMeta> | undefined): string[] {
  const out: string[] = [];
  for (const [kt, types] of Object.entries(incoming?.typeSchemas ?? {}) as [string, Record<string, unknown> | undefined][]) {
    const had = (base.typeSchemas as Record<string, Record<string, unknown> | undefined> | undefined)?.[kt] ?? {};
    for (const [t, def] of Object.entries(types ?? {})) if (!isDeepStrictEqual(had[t], def)) out.push(`${kt}:${t}`);
  }
  return out.sort();
}

/**
 * What both doors add to the answer when a networked edit was applied as a merge (`Q-61`): the flag, the kept types,
 * and one sentence. Spread into the REST body and the MCP structured content alike, so the two cannot word it apart.
 */
export function networkMergeNotice(outcome: MetaUpdateOutcome): Record<string, unknown> {
  if (outcome.outcome === 'not_found' || !outcome.keptTypes?.length) return {};
  return {
    appliedAsMerge: true,
    keptTypes: outcome.keptTypes,
    mergeNote: `This space is in a network, where a schema update is applied as a merge on every member and here: `
      + `${outcome.keptTypes.join(', ')} ${outcome.keptTypes.length === 1 ? 'was' : 'were'} left out of the replacement and ${outcome.keptTypes.length === 1 ? 'is' : 'are'} kept. `
      + `Where this instance has members below it in the network, the note it sends them when the round passes names the kept types; each member can retire a type locally.`,
  };
}

/** Who is asking, as the networks area reads a caller (`visibleNetworks`): the one reading of "may this token see this network". */
export type WriteCaller = Parameters<typeof visibleNetworks>[0];

/**
 * What both doors add to the answer of a write to a space in networks — the one spread, so the two cannot word it apart (R5-1, R6-7):
 * the merge notice (`networkMergeNotice`), `layers` (what became of the write in each network it reached, when that is more than one),
 * and `warnings` naming the members that may refuse a key an earlier release does not know.
 *
 * **A member's label is the networks area's to read, and a warning must not be the way round it.** The row names the members only of
 * networks the caller may see (`visibleNetworks`: `networks: read` on every space the network carries); for anyone else the row carries
 * the keys and how many members are behind, and no label and no id.
 */
export function networkWriteNotice(outcome: MetaUpdateOutcome, caller: WriteCaller): Record<string, unknown> {
  if (outcome.outcome === 'not_found') return {};
  const rows = outcome.skew?.length ? memberSkewWarnings(outcome.skew, caller) : [];
  return {
    ...networkMergeNotice(outcome),
    ...(outcome.layers ? { layers: outcome.layers } : {}),
    ...(rows.length ? { warnings: rows } : {}),
  };
}

/** The `warnings` rows for the members a write may be refused by — see {@link networkWriteNotice} for who is named. */
function memberSkewWarnings(skew: readonly MemberSkew[], caller: WriteCaller): Record<string, unknown>[] {
  const seen = new Set(visibleNetworks(caller, getConfig().networks).map(n => n.id));
  return skew.map(s => {
    const named = [...new Set(s.members.filter(m => seen.has(m.networkId)).map(m => peerText(m.label, { max: NAME_QUOTED })))];
    const unheard = s.members.filter(m => m.neverHeardFrom).length;
    return {
      code: 'members_may_refuse_new_keys',
      keys: s.keys,
      since: s.since,
      memberCount: s.members.length,
      ...(named.length > 0 ? { members: named } : {}),
      message: `${s.keys.join(', ')} ${s.keys.length === 1 ? 'is a key' : 'are keys'} only release ${s.since} and later read. `
        + `${s.members.length} member${s.members.length === 1 ? '' : 's'} of the network${s.members.length === 1 ? '' : 's'} carrying this space run an older release `
        + `or have not reported a version${unheard > 0 ? ` (${unheard} not yet heard from)` : ''}`
        + `${named.length > 0 ? `: ${peerList(named, ', ')}` : ''}, and refuse the whole schema layer carrying it until upgraded. `
        + 'The write is applied here regardless; upgrade every instance of the network.',
    };
  });
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
  /**
   * The merged meta to store, or `undefined` when the request touches no meta at all. Parsed (`Q-216`): the parts the request
   * changed went through the one body, and the rest is what the store already holds.
   */
  mergedMeta: ParsedSpaceMeta | undefined;
  /** What a networked write proposes — the changed fields and types only (R6-6); `undefined` with `mergedMeta`. */
  proposal: SpaceMeta | undefined;
  /** What those same fields and types held in the base the write was merged over (R6-8) — carried on the round, `undefined` with `mergedMeta`. */
  metaBase: SpaceMeta | undefined;
  /** Present only when `documentExtraction` was in the body; already capped to the instance ceiling. */
  documentExtraction: DocExtractionMode | undefined;
  hasDocExtraction: boolean;
  /** Present only when `recordTtlDays` was in the body; already merged over what was stored. */
  recordTtlDays: SpaceConfig['recordTtlDays'];
  hasRecordTtl: boolean;
  /** The audit change-list snapshot, taken before anything is applied. */
  audit: { before: Record<string, unknown>; after: Record<string, unknown> };
  /** The one network this proposes to, as its layer (`F-39.5`); absent, the edit is this instance's own. */
  targetNetwork?: string;
  /** `kind:Type` a `replace` leaves out of the base (`typesAReplaceWouldDrop`); kept if the space is networked. */
  droppedTypes: string[];
  /** `kind:Type` the edit adds or changes against the base (`typesAnEditChanges`). */
  changedTypes: string[];
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
    const refusal = refusalOfParse(parsed.error);
    log.warn(`space update refused: ${refusal.error}`);
    return { ok: false, refusal: { status: 400, body: refusal } };
  }


  // Validate any $ref values in the incoming meta against the instance schema library
  if (parsed.data.meta?.typeSchemas) {
    const brokenRefs = findBrokenLibraryRefs(parsed.data.meta.typeSchemas as z.infer<typeof TypeSchemasZ>);
    if (brokenRefs.length > 0) {
      return { ok: false, refusal: { status: 422, body: { error: brokenRefsError(brokenRefs) } } };
    }
    // And a reference to an entry of ANOTHER kind: its endpoints and functional would never apply (`Q-215`). Checked here, at the save of
    // the reference, against this instance's library — never inside the shared parse, because a peer's library is its own.
    const wrongKind = findWrongKindLibraryRefs(parsed.data.meta.typeSchemas as z.infer<typeof TypeSchemasZ>);
    if (wrongKind.length > 0) {
      return { ok: false, refusal: { status: 422, body: { error: wrongKindRefsError(wrongKind) } } };
    }
  }

  // Snapshot for the audit log's change list, taken BEFORE anything is applied. Handing the whole record
  // over is safe: `audit-changes.ts` reads only the fields allowlisted for `space.update` and never
  // touches the rest, so this cannot publish something by carrying it. The middleware only records it on
  // a <400 response, so a request rejected above logs no change — which is why every refusal returns before here.
  const scalarAudit = {
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

  // F-39.5: a proposal to one network is merged over THAT NETWORK's layer, not the space's effective meta — it is
  // the network's definition being changed. Only the meta may travel with it: a label, a quota or a TTL is this
  // instance's, and applying them beside a vote is the partial save a refusal exists to prevent.
  const targetNetwork = parsed.data.targetNetwork;
  let base: Partial<SpaceMeta> = space.meta ?? {};
  if (targetNetwork !== undefined) {
    const extra = Object.keys(parsed.data).filter(k => !['meta', 'typeSchemasMode', 'targetNetwork'].includes(k)
      && (parsed.data as Record<string, unknown>)[k] !== undefined);
    if (extra.length) {
      return { ok: false, refusal: { status: 400, body: { error: `targetNetwork proposes that network's schema only: send meta (and typeSchemasMode), not ${extra.join(', ')}` } } };
    }
    if (parsed.data.meta === undefined) {
      return { ok: false, refusal: { status: 400, body: { error: 'targetNetwork needs a meta to propose' } } };
    }
    const net = getConfig().networks.find(n => n.id === targetNetwork && n.spaces.includes(spaceId));
    if (!net) {
      return { ok: false, refusal: { status: 400, body: { error: `Network '${targetNetwork}' does not carry space '${spaceId}'` } } };
    }
    base = net.schemaLayers?.[spaceId] ?? {};
  }

  // Merge the incoming meta with the existing meta so that PATCH has true RFC-7396 semantics: scalar fields
  // overwrite, typeSchemas entries are added/updated, and types *not* mentioned in the body are preserved.
  // `typeSchemasMode: 'replace'` opts out of that last clause so a deletion can be expressed at all.
  // What is stored is PARSED (`Q-216`): the merged result is read against `base`, so the parts the request changed go through the one
  // body and every other part is, by construction, what the store already holds. The planner's own body parse above is for the
  // request's shape; this is the value a store accepts.
  let mergedMeta: ParsedSpaceMeta | undefined;
  if (parsed.data.meta !== undefined) {
    const minted = parseSpaceMeta(mergeSpaceMeta(base, parsed.data.meta, parsed.data.typeSchemasMode ?? 'merge'), { against: base });
    if (!minted.ok) return { ok: false, refusal: { status: 400, body: { error: minted.message } } };
    mergedMeta = minted.meta;
  }
  /*
   * What the audit log says about the schema (R6-13): the types, properties and rules as the edit LEAVES them against what it was merged
   * over. The body's `typeSchemas` is a fragment (a PATCH names only the types it replaces), so comparing it with the stored map would
   * record every type it did not mention as removed — the merged result is the after. An edit that carries no meta hands over neither
   * part, and the summariser reads that as "not touched".
   */
  const audit = mergedMeta === undefined ? scalarAudit : {
    before: { ...scalarAudit.before, typeSchemas: base.typeSchemas ?? {}, rules: base.rules ?? {} },
    after: { ...scalarAudit.after, typeSchemas: mergedMeta.typeSchemas ?? {}, rules: mergedMeta.rules ?? {} },
  };
  const changedTypes = typesAnEditChanges(base, parsed.data.meta as Partial<SpaceMeta> | undefined);

  return {
    ok: true,
    plan: {
      spaceId,
      space,
      data: parsed.data,
      mergedMeta,
      proposal: mergedMeta === undefined ? undefined : proposalOf(mergedMeta, parsed.data.meta as Partial<SpaceMeta> | undefined, changedTypes),
      metaBase: mergedMeta === undefined ? undefined : proposalOf(base as SpaceMeta, parsed.data.meta as Partial<SpaceMeta> | undefined, changedTypes),
      documentExtraction,
      hasDocExtraction,
      recordTtlDays,
      hasRecordTtl,
      audit,
      ...(targetNetwork !== undefined ? { targetNetwork } : {}),
      droppedTypes: typesAReplaceWouldDrop(base, parsed.data.meta as Partial<SpaceMeta> | undefined, parsed.data.typeSchemasMode ?? 'merge'),
      changedTypes,
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
  | ({ outcome: 'applied'; space: SpaceConfig; keptTypes?: string[] } & NetworkedWrite)
  | ({ outcome: 'vote_pending'; rounds: { networkId: string; networkLabel: string; roundId: string }[]; keptTypes?: string[] } & NetworkedWrite)
  | { outcome: 'not_found' };

/** What a write to a space in networks became in ONE of them: its round passed on this instance's own vote, or is open (R5-1). */
export interface LayerOutcome {
  networkId: string;
  networkLabel: string;
  outcome: 'applied' | 'vote_pending';
}

/**
 * What a networked write says beyond its single outcome — both parts present only when there is something to say:
 *
 * - `layers`: what became of the write in each network, when it reached MORE THAN ONE (one club's yes passes its round at once while a
 *   closed network waits for its members, so the single word said which of them was `vote_pending` by saying neither);
 * - `skew`: the members that may refuse a key an earlier release does not know, with their labels (`sync/meta-skew.ts`). Labels are the
 *   networks area's to read: {@link networkWriteNotice} puts them in the answer only for a caller who may.
 */
interface NetworkedWrite {
  layers?: LayerOutcome[];
  skew?: MemberSkew[];
}

/** The members of the networks a write reached that may refuse what it sets — as the outcome carries it, or nothing. */
function skewOf(plan: MetaUpdatePlan, reached: readonly NetworkConfig[]): Pick<NetworkedWrite, 'skew'> {
  const skew = membersBehindNewKeys(plan.proposal, reached);
  return skew.length > 0 ? { skew } : {};
}

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
  const { spaceId: id, space, data: patchData, mergedMeta, proposal } = plan;
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
    if (plan.recordTtlDays !== undefined) void ensureTtlIndex(id).catch(err => log.warn(`ensureTtlIndex ${peerText(id)}: ${peerText(err)}`));
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
    // F-39.5: a proposal to one network opens its round there alone; any other edit, on every network carrying it.
    const networkedIn = cfg.networks.filter(n => n.spaces.includes(id) && (plan.targetNetwork === undefined || n.id === plan.targetNetwork));
    if (networkedIn.length > 0) {
      const now = new Date().toISOString();
      const rounds: { networkId: string; networkLabel: string; roundId: string }[] = [];
      const layers: LayerOutcome[] = [];

      for (const net of networkedIn) {
        const roundId = uuidv4();
        const deadline = new Date(Date.now() + net.votingDeadlineHours * 3_600_000).toISOString();
        const opened = openRoundHere(net, {
          roundId,
          type: 'meta_change',
          subjectInstanceId: cfg.instanceId,
          subjectLabel: cfg.instanceLabel,
          subjectUrl: '',
          deadline,
          openedAt: now,
          votes: [],
          // The network's id for the space, so each member resolves it to its own local id (F-39.4).
          spaceId: localToRemote(net, id),
          // Only what this write CHANGED (R6-6): the fields it named and the types it changed, never the whole meta it was
          // merged over — which was the space's effective meta, and copied every other network's types into this network's layer.
          pendingMeta: proposal,
          // Provenance, so conclusion can apply just this patch rather than this whole snapshot. Rounds stay open
          // for `votingDeadlineHours`, so a second proposal landing before the first concludes is ordinary, and
          // without these two fields the later one reverts the earlier one's edit with no error anywhere. See
          // sync/meta-round-merge.ts.
          metaChangedFields: proposedMetaFields(patchData.meta ?? {}),
          baseMetaVersion: space.meta?.version ?? 0,
          // What those fields held, so a member's conclusion warns of an overwrite only for a field that moved from here (R6-8).
          ...(plan.metaBase !== undefined ? { metaBase: plan.metaBase } : {}),
          ...(plan.targetNetwork !== undefined ? { proposesLayer: true } : {}),
          // Q-61: what the change note says when the round passes (`sync/governance.ts`).
          ...(plan.changedTypes.length ? { changedTypes: plan.changedTypes } : {}),
          ...(plan.droppedTypes.length ? { keptTypes: plan.droppedTypes } : {}),
        });
        // The proposer is a voter like any member (S-7), so its yes is required — and cast for it here, SIGNED, because
        // a bare cast is taken only from the voter itself and a relayed copy of it would be dropped.
        opened.votes.push(makeSignedOwnCast(net.id, opened, cfg.instanceId, 'yes'));
        /*
         * Evaluated now, because the proposer's yes above may already be enough (`Q-49`).
         *
         * On club and pub/sub one yes passes a round, and a closed network with no other member needs only ours —
         * but nothing looked at the round until another vote arrived, so the change answered 202 and sat unapplied
         * until somebody cast the identical yes again or the deadline expired it. The round stays in the list
         * either way, concluded or not, so peers learn of it exactly as before.
         */
        const concluded = concludeRoundIfReady(net, opened);
        if (!concluded) rounds.push({ networkId: net.id, networkLabel: net.label, roundId });
        layers.push({ networkId: net.id, networkLabel: net.label, outcome: concluded ? 'applied' : 'vote_pending' });
      }
      const kept = plan.droppedTypes.length ? { keptTypes: plan.droppedTypes } : {};
      // What the write says of the networks it reached (R5-1, R6-8): per network, only where it reached more than one — on one the single
      // outcome says it all — and only what is KNOWN now. A round that later fails, or a layer that outranks the edit, is not in the answer:
      // `space_schema_layers` derives it. And the members that may refuse a key an earlier release does not know (R6-7).
      const reached = {
        ...(layers.length > 1 ? { layers } : {}),
        ...(skewOf(plan, networkedIn)),
      };

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
          }).catch(err => log.warn(`notify ${peerText(member.label)} of meta_change_pending: ${peerText(err)}`));
        }
      }

      if (rounds.length > 0) return { outcome: 'vote_pending', rounds, ...kept, ...reached };

      // Every round passed on the proposer's own vote, so the meta is already written by the conclusion — and swept by
      // it: the conclusion writes through `updateSpace`, which asks for the sweep (a second one here swept it twice).
      const applied = getConfig().spaces.find(s => s.id === id);
      if (!applied) return { outcome: 'not_found' };
      return { outcome: 'applied', space: applied, ...kept, ...reached };
    }
  }

  // `documentExtraction` and `recordTtlDays` are pulled OUT of the spread. Both were applied above from normalised
  // values, and letting the raw body through here overwrote that with itself — so a partial TTL write cleared the
  // four buckets it did not mention, and an all-cleared write stored five explicit nulls instead of nothing. Both
  // returned 200 and looked like they had worked; found by driving the UI.
  const { documentExtraction: _rawMode, recordTtlDays: _rawTtl, ...restPatch } = patchData;
  // F-39.2: a space in no network has no layer, so its own definitions ARE the edited meta — kept in step, or a stale
  // `ownMeta` would come back the next time a network sends this space a layer.
  const held = getConfig().spaces.find(s => s.id === id);
  if (held?.ownMeta && mergedMeta !== undefined) held.ownMeta = replicatedMetaOf(mergedMeta) as SpaceMeta;
  const updated = updateSpace(id, {
    ...restPatch,
    meta: mergedMeta,
    ...(plan.hasDocExtraction ? { documentExtraction: plan.documentExtraction } : {}),
  });
  // The stored vectors follow the flag, which is what the userguide has always said happens: `updateSpace` asks for
  // the sweep, not awaited — see `sweepAfterMetaWrite` for why a failure is logged rather than surfaced here.
  return updated ? { outcome: 'applied', space: updated } : { outcome: 'not_found' };
}

/**
 * A schema route's edit of a NETWORKED space, voted on as `PATCH /api/spaces/:id` votes on it (`Q-52`).
 *
 * `PUT /schema`, the per-type upsert and delete, and the schema library's apply wrote a networked space's schema at
 * once, while `PATCH` and MCP `schema_update` turned the same edit into a `meta_change` round — one edit, voted on
 * one door and not the others, and a way to change a shared space's schema without the network. This hands the
 * edit to the same planner. Returns `null` for a space in no network, where the route writes as before.
 *
 * @param typeSchemas the map the route would write — whole (`replace`) or the types it touches (`merge`)
 */
export async function voteOnSchemaEditIfNetworked(
  spaceId: string,
  typeSchemas: unknown,
  mode: 'merge' | 'replace',
  caller: WriteCaller,
): Promise<{ status: 202; body: Record<string, unknown> } | { status: number; body: Record<string, unknown> } | null> {
  const cfg = getConfig();
  if (!cfg.networks.some(n => n.spaces.includes(spaceId))) return null;
  const space = cfg.spaces.find(s => s.id === spaceId);
  const decision = planSpaceMetaUpdate({ spaceId, space, body: { meta: { typeSchemas }, typeSchemasMode: mode }, ifMatch: undefined });
  if (!decision.ok) return { status: decision.refusal.status, body: decision.refusal.body as Record<string, unknown> };
  const result = await applySpaceMetaUpdate(decision.plan);
  if (result.outcome === 'vote_pending') {
    return { status: 202, body: { status: 'vote_pending', rounds: result.rounds, message: 'Meta change requires network vote', ...networkWriteNotice(result, caller) } };
  }
  if (result.outcome === 'not_found') return { status: 404, body: { error: `Space '${spaceId}' not found` } };
  // Every round passed on this instance's own yes (a club organiser, a publisher, a lone member): applied already.
  return { status: 200, body: { space: spaceForWire(result.space), ...networkWriteNotice(result, caller) } };
}
