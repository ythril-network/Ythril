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
 * precondition, then the body, then the schema-library refs, then — once the merge has said what the schema becomes — the
 * conversion steps held to the schema before and after it (`Q-745`; a step is held to the schema the edit LEAVES, so it
 * cannot be asked sooner, and a plan with a bad step is never returned). A precondition evaluated after validation is not a
 * precondition — it reports a body problem for a write that was never allowed to be applied, and the caller hits
 * the real conflict on their second attempt instead of their first. And a rejected write must change NOTHING,
 * which is why the audit snapshot is returned in the plan rather than taken as we go.
 */
import { localToRemote } from '../sync/space-map.js';
import { replicatedMetaOf, effectiveMeta } from '../sync/replicated-meta.js';
import { layersFor } from './network-layers.js';
import { inlineResolvableRefs } from './schema-validation.js';
import { conversionStepIssues, CONVERSION_STEPS_MAX, type ConvertRecords, type ConversionMeta } from '@ythril-network/schema/internal';
import type { SpaceConfig, SpaceMeta, DocExtractionMode, NetworkConfig, Config } from '../config/types.js';
import { normalizeDocExtractionMode } from '../config/types.js';
import { getConfig, saveConfig, getDocumentProcessingConfig } from '../config/loader.js';
import { updateSpace, refuseRemovedDescription, unknownWriteFieldsMode } from './spaces.js';
import { ensureTtlIndexes } from './space-indexes.js';
import { proposedMetaFields } from '../sync/meta-round-merge.js';
import { membersBehindNewKeys, membersBehindRoundType, type MemberSkew } from '../sync/meta-skew.js';
import { visibleNetworks } from '../auth/network-rights.js';
import { proposeRound } from '../networks/propose-round.js';
import { log, NAME_QUOTED, peerList, peerText, refusalOfParse } from '../util/log.js';
import { capDocExtractionMode } from '../files/converters/extraction-level.js';
import { checkMetaPrecondition, preconditionErrorBody } from './meta-precondition.js';
import { normaliseRecordTtl } from './record-ttl.js';
import {
  UpdateSpaceBody, libraryRefRefusal, parseSpaceMeta,
  stripServerOwnedMeta, stripServerOwnedSpace,
} from './body-schemas.js';
import type { TypeSchemasZ, ParsedSpaceMeta } from './body-schemas.js';
import { metaFieldKind } from './meta-fields.js';
import type { z } from 'zod';
import { isDeepStrictEqual } from 'node:util';
import { spaceForWire } from './space-for-wire.js';
import { lostSpaceAnswer } from './unknown-space.js';
import {
  startSchemaConvertInTurn, roundConvertStartOf, schemaConvertTypes, roundStepIssue, type SchemaConvertStarted, type SchemaConvertTypeRef,
} from '../sync/governance.js';
import { parseMetaRound, type MetaRoundProposal } from '../sync/meta-round-merge.js';
import type { ConversionStep } from '@ythril-network/schema/internal';
import { heldRebaseRounds, rdfBaseConflictOf, RDF_BASE_STANDS_STATUS, settleRdf, sharedRdfBaseRefusal, type RebaseProposal, type RdfRefusalStatus } from './rdf-settle.js';
import type { TokenRights } from '../config/rights-shape.js';
import { storeMovedRdf } from './rdf-store.js';
import type { RdfSetting } from '@ythril-network/schema';
import { termClashes } from '../rdf/term-iri.js';
import { getPublicBaseUrl, publicBaseUrlIsFallback } from '../config/public-url.js';
import { rebaseRoundUnapplied, roundIsOpen } from '../networks/round-state.js';
import { roundAnswer, roundDecided, type RoundAnswer } from '../networks/vote-acts.js';
// The trigger lives beside the sweep (bundle-30 `R5`): the effective-meta recompute fires it too.

// The merge a write makes, and the base it is merged over, live with the rights check's copy of the same question (`meta-write-base.ts`).
import { mergeSpaceMeta, metaWriteBase } from './meta-write-base.js';
import { assertSchemaWritable } from './schema-write-gate.js';
export { mergeSpaceMeta };

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

/**
 * What both doors add to the answer of a save that carried `convertRecords` (`Q-745`, `Q-746`, design 2.2): `convert`, spread beside
 * {@link networkWriteNotice} at the same places on REST and MCP, so the two cannot say it apart. Nothing for a save that chose no conversion.
 *
 * - `started`: the run was started (or joined the run already going) on this instance, toward `toFp`;
 * - `after_vote`: the save opened a vote that has not passed here; each member starts its run when the round passes there;
 * - `nothing`: the save changed no type a run reaches, so there is nothing to convert;
 * - `not_started`: the schema was saved and the run could not be started (`error` says why): the save is not undone.
 */
export function convertNotice(outcome: MetaUpdateOutcome): Record<string, unknown> {
  if (outcome.outcome === 'not_found' || outcome.convertRun === undefined) return {};
  return { convert: outcome.convertRun };
}

/** The `warnings` rows for the members a write may be refused by — see {@link networkWriteNotice} for who is named. */
function memberSkewWarnings(skew: readonly MemberSkew[], caller: WriteCaller): Record<string, unknown>[] {
  const seen = new Set(visibleNetworks(caller, getConfig().networks).map(n => n.id));
  return skew.map(s => {
    const named = [...new Set(s.members.filter(m => seen.has(m.networkId)).map(m => peerText(m.label, { max: NAME_QUOTED })))];
    const unheard = s.members.filter(m => m.neverHeardFrom).length;
    const count = `${s.members.length} member${s.members.length === 1 ? '' : 's'}`;
    const behind = `${count} of the network${s.members.length === 1 ? '' : 's'} carrying this space run an older release `
      + `or have not reported a version${unheard > 0 ? ` (${unheard} not yet heard from)` : ''}${named.length > 0 ? `: ${peerList(named, ', ')}` : ''}`;
    // A round is not a key: an older member does not refuse a layer, it neither votes on the round nor applies it.
    if (s.round !== undefined) {
      return {
        code: 'members_may_not_read_round',
        keys: s.keys,
        since: s.since,
        memberCount: s.members.length,
        ...(named.length > 0 ? { members: named } : {}),
        message: `A ${s.round} round is only read by release ${s.since} and later. ${behind}, and neither vote on it nor apply it: on closed and `
          + 'braintree networks the round cannot pass until they upgrade, and on democratic ones their missing yes counts against the majority. '
          + 'The round is open regardless; upgrade every instance of the network.',
      };
    }
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
  status: 400 | 404 | 410 | 412 | 422 | RdfRefusalStatus;
  /** `step` is the index of the conversion step a `bad_conversion_step` refusal names (`Q-745`). */
  body: { error: string; code?: string; expectedVersion?: number; currentVersion?: number; step?: number };
};

/** The status of a body the planner refuses for what it says, a conversion step's refusals among them. */
const BAD_BODY = 400 as const;
/** The status of a schema whose terms would share one RDF address (Q-748): understood, and not storable. */
const TERM_CLASH_STATUS = 422 as const;

/**
 * The refusal of a body whose `convertRecords` does not parse, said as `bad_conversion_step` with the index of the step (`Q-745`), or `undefined` when
 * the failure is not all under `convertRecords` (a body with another fault too keeps its one generic answer, which names every path).
 *
 * The parse refuses a step that is not a step (an unknown op, a missing field) and a list over the bound before the planner can hold any step to the
 * schema, so without this the same mistake answered by two codes depending on which check saw it first. A list over the bound names the first step
 * past it, as `conversionStepIssues` does; a failure with no step in its path (an unknown key of `convertRecords`) names no step.
 */
function badConversionStepRefusal(refusal: { error: string; issues: readonly { path: readonly string[] }[] }): MetaUpdateRefusal | undefined {
  const { issues } = refusal;
  if (issues.length === 0 || !issues.every(i => i.path[0] === 'convertRecords')) return undefined;
  const [, member, index] = issues[0]!.path;
  const at = member !== 'steps' ? NaN : index === undefined ? CONVERSION_STEPS_MAX : Number(index);
  return { status: BAD_BODY, body: { ...refusal, code: 'bad_conversion_step', ...(Number.isInteger(at) ? { step: at } : {}) } };
}

/**
 * The RDF setting of a door's write, settled by the one rule (`rdf-settle.ts`, Q-748), written back into `data.meta` so the merge stores the
 * settled value and never the sent one. A networked rebase leaves `data.meta` without `rdf` (nothing moves here; the round carries it) and
 * must be the request's only change: a rebase lands at its round's deadline, and a write that carried it with other edits would answer one
 * outcome for two acts that land at different times.
 */
function settleRdfOfWrite(space: SpaceConfig, data: z.infer<typeof UpdateSpaceBody>, rights: TokenRights | null | undefined):
  { ok: true; proposeRebase?: RebaseProposal; acceptRdf?: RdfSetting } | { ok: false; refusal: MetaUpdateRefusal } {
  const meta = data.meta as (Partial<SpaceMeta> & { rdf?: SpaceMeta['rdf'] & { rebase?: true } }) | undefined;
  if (meta?.rdf === undefined) return { ok: true };
  if (data.targetNetwork !== undefined) {
    return { ok: false, refusal: { status: BAD_BODY, body: { error: 'rdf is this space\'s own setting and is not proposed to one network\'s layer: send it without targetNetwork', code: 'rdf_not_a_layer_field' } } };
  }
  const cfg = getConfig();
  const networked = cfg.networks.some(n => n.spaces.includes(space.id));
  const offeredBases = rdfBaseConflictOf(cfg, space.id)?.offered ?? [];
  const settled = settleRdf(space.meta?.rdf, meta.rdf, 'local', {
    spaceId: space.id, networked, offeredBases, ...(publicBaseUrlIsFallback() ? {} : { publicBaseUrl: getPublicBaseUrl() }),
  });
  if (!settled.ok) return { ok: false, refusal: { status: settled.status, body: { error: settled.error, code: settled.code } } };
  // A base another space of this instance holds with RDF on is refused here, at the save (bundle-269 slice F; the exports keep their own
  // refusal for a pair that exists). Asked of the base the write leaves: a networked rebase leaves the stored one and PROPOSES the new, which
  // is the one a vote would make this space's, so it is the one held to this.
  const shared = sharedRdfBaseRefusal(cfg, space.id, space.meta?.rdf,
    settled.proposeRebase ? { enabled: settled.rdf?.enabled, base: settled.proposeRebase.base } : settled.rdf, rights);
  if (shared) return { ok: false, refusal: { status: shared.status, body: { error: shared.error, code: shared.code } } };
  // One rebase at a time (review finding 1): a round opened while another is held would take the same epoch, and only one can land. The
  // identical repeat of this instance's own proposal is not a second rebase: the apply answers the round in progress.
  const next = settled.proposeRebase;
  const pending = next && heldRebaseRounds(cfg, space.id, Date.now())
    .find(r => !(r.proposedHere === true && r.rebase?.base === next.base && r.rebase?.vocab === next.vocab));
  if (pending) {
    return { ok: false, refusal: { status: RDF_BASE_STANDS_STATUS, body: { code: 'rdf_rebase_pending',
      error: `a rebase of this space to ${pending.rebase?.base ?? 'another base'} is already held (round ${pending.roundId}, deadline ${pending.deadline}): `
        + 'one rebase at a time; send this one after that round has landed, been vetoed or expired' } } };
  }
  if (settled.proposeRebase || settled.acceptedOffer) {
    const others = [...Object.keys(meta).filter(k => k !== 'rdf'), ...Object.keys(data).filter(k => k !== 'meta' && (data as Record<string, unknown>)[k] !== undefined)];
    if (others.length > 0) {
      return { ok: false, refusal: { status: BAD_BODY, body: { error: `a rebase of a shared space is voted on alone and lands at its round's deadline: send rdf by itself, and ${others.join(', ')} in another write`, code: 'rdf_rebase_alone' } } };
    }
    delete data.meta;
    return settled.acceptedOffer ? { ok: true, acceptRdf: settled.rdf! } : { ok: true, proposeRebase: settled.proposeRebase! };
  }
  if (settled.rdf === undefined) delete meta.rdf; else meta.rdf = settled.rdf;
  return { ok: true };
}

/**
 * Take over the base a peer of a voted network offered at a higher epoch (Q-748; owner, 2026-11-19): this instance's own setting, stored here
 * alone with no round (the network already moved), and the space's recorded conflicts forgotten. `null` when the space is gone.
 */
function acceptOfferedRdf(cfg: Config, spaceId: string, rdf: RdfSetting): SpaceConfig | null {
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space || !storeMovedRdf(cfg, space, rdf)) return null;
  saveConfig(cfg);
  return space;
}

/**
 * The effective meta of `space` once an edit has landed (`Q-745`): the schema a conversion step is held to AFTER the change, as the stamp reads a
 * schema — own definitions laid under each network's layer (`effectiveMeta`).
 *
 * - An edit to this instance's own definitions replaces them with the merged meta; on a space in a network a `replace` is applied as a MERGE on every
 *   member, because deleting a type in a network can break another member (`typesAReplaceWouldDrop`), so the types it leaves out are still there.
 * - An edit to ONE network's layer (`targetNetwork`) replaces that layer and leaves the own definitions as they are.
 */
function effectiveMetaAfterEdit(cfg: Config, space: SpaceConfig, edit: {
  base: Partial<SpaceMeta>; incoming: Partial<SpaceMeta>; mode: 'merge' | 'replace'; merged: ParsedSpaceMeta; targetNetwork: string | undefined;
}): SpaceMeta {
  const layers = layersFor(cfg, space.id);
  if (edit.targetNetwork !== undefined) {
    const replaced = { networkId: edit.targetNetwork, meta: edit.merged };
    const among = layers.some(l => l.networkId === edit.targetNetwork)
      ? layers.map(l => (l.networkId === edit.targetNetwork ? replaced : l)) : [...layers, replaced];
    return effectiveMeta(space.ownMeta ?? space.meta, among);
  }
  const networked = cfg.networks.some(n => n.spaces.includes(space.id));
  const own = networked && edit.mode === 'replace' ? mergeSpaceMeta(edit.base, edit.incoming, 'merge') : edit.merged;
  return effectiveMeta(own as SpaceMeta, layers);
}

/**
 * The refusal (422 `rdf_term_clash`) of a schema edit that would give two terms of an RDF space one address, both named (Q-748 rule 5), or
 * undefined. Asked of the schema the space RUNS after the edit, resolved as the resolver names it: its own definitions laid under each
 * network's layer, so an own type cannot take an address a layer's type already has (the review's suspicion, proven). A space with RDF off
 * names nothing, so nothing is asked, and the config (the layers, the library's namespaces) is read only for a space with RDF on.
 *
 * The one check every schema write asks before it stores: the planner, and the routes that write named types through `commitOwnMetaEdit`
 * ({@link termClashRefusalOfOwnTypeEdit}), which stored a clash the planner refused until they asked it (Q-754).
 */
export function termClashRefusalAfterEdit(space: SpaceConfig, edit: {
  base: Partial<SpaceMeta>; incoming: Partial<SpaceMeta>; mode: 'merge' | 'replace'; merged: ParsedSpaceMeta; targetNetwork: string | undefined;
}): MetaUpdateRefusal | undefined {
  const runs = edit.merged.rdf?.enabled === true || space.meta?.rdf?.enabled === true ? effectiveMetaAfterEdit(getConfig(), space, edit) : undefined;
  if (runs?.rdf?.enabled !== true || !runs.rdf.base) return undefined;
  const clashes = termClashes(inlineResolvableRefs(runs), Object.values(getConfig().schemaLibraryNamespaces ?? {}));
  if (clashes.length === 0) return undefined;
  return { status: TERM_CLASH_STATUS, body: { error: `two terms of this space would have one RDF address: ${clashes.map(c => c.message).join('; ')}`, code: 'rdf_term_clash' } };
}

/**
 * {@link termClashRefusalAfterEdit} for a write of named types to this instance's own definitions (`PUT /api/spaces/:id/schema` in `replace`: the
 * map replaces the stored one; the per-type upsert in `merge`: its type is laid over it), merged over the base the planner merges over. A map the
 * store's parse refuses is answered by the route's own parse, never here: undefined.
 */
export function termClashRefusalOfOwnTypeEdit(space: SpaceConfig, typeSchemas: SpaceMeta['typeSchemas'], mode: 'merge' | 'replace'): MetaUpdateRefusal | undefined {
  const base: Partial<SpaceMeta> = metaWriteBase(space, undefined, []) ?? {};
  const incoming: Partial<SpaceMeta> = { typeSchemas };
  const minted = parseSpaceMeta(mergeSpaceMeta(base, incoming, mode), { against: base });
  if (!minted.ok) return undefined;
  return termClashRefusalAfterEdit(space, { base, incoming, mode, merged: minted.meta, targetNetwork: undefined });
}

/**
 * The effective meta of `space` on the proposer once the round a networked edit opens has passed here (`Q-745`, lens sweep S2): the schema a
 * conversion step is held to as the proposer's own conclusion holds it (`planPassedMetaChange`), so the save refuses exactly what that conclusion
 * would refuse.
 *
 * - The own definitions: the merged meta for an own edit (a networked `replace` read as a merge), unchanged for a proposal to one network.
 * - Each network the round reaches whose layer the conclusion writes (a proposal to a network always; an own edit where this instance holds a layer
 *   of that network) has that layer replaced by what the conclusion stores there: the round parsed over it (`parseMetaRound`), which replaces each
 *   type the round carries by name. A layer that unparseable round would leave is kept as it is (the conclusion refuses the round whole then).
 */
function effectiveMetaAfterRound(cfg: Config, space: SpaceConfig, reached: readonly NetworkConfig[], edit: {
  base: Partial<SpaceMeta>; incoming: Partial<SpaceMeta>; mode: 'merge' | 'replace'; merged: ParsedSpaceMeta; targetNetwork: string | undefined;
}, round: MetaRoundProposal): SpaceMeta {
  const own = edit.targetNetwork !== undefined ? (space.ownMeta ?? space.meta) : (edit.mode === 'replace' ? mergeSpaceMeta(edit.base, edit.incoming, 'merge') : edit.merged);
  const layers = layersFor(cfg, space.id);
  const after = new Map(layers.map(l => [l.networkId, l.meta]));
  for (const net of reached) {
    const held = net.schemaLayers?.[space.id];
    if (edit.targetNetwork === undefined && held === undefined) continue;
    const parsed = parseMetaRound(held ?? {}, round);
    if (parsed.ok) after.set(net.id, parsed.meta);
  }
  const among = [...layers.map(l => ({ networkId: l.networkId, meta: after.get(l.networkId)! })),
    ...[...after.entries()].filter(([id]) => !layers.some(l => l.networkId === id)).map(([networkId, meta]) => ({ networkId, meta }))];
  return effectiveMeta(own as SpaceMeta, among);
}

/**
 * `metaBase` with the definition, resolved, of each type a type step of `steps` moves records out of, taken from `held` (the effective meta before
 * the edit) where `metaBase` does not already carry it (`Q-745`, lens sweep B1). A round's before-schema held only the types the edit changed, and a
 * type step's source is one it leaves alone; a member that never held the proposer's own definitions then refused the step. Nothing is added for
 * steps with no type step, so a round without one carries what it always did; `metaBase` is signed by no cast (`sig` and `bsig` cover the round's
 * type and target, `csig` the steps), so an older member reads the extra type as one more type of the base, which only the types the round changes
 * are compared against.
 */
function withTypeStepSources(metaBase: SpaceMeta, held: SpaceMeta | undefined, steps: readonly ConversionStep[]): SpaceMeta {
  const sources = steps.flatMap(s => (s.op === 'renameType' || s.op === 'splitType' ? [[s.kind, s.from] as const] : []));
  if (sources.length === 0) return metaBase;
  const known = (inlineResolvableRefs(held ?? {}).typeSchemas ?? {}) as Record<string, Record<string, unknown> | undefined>;
  const carried = { ...((metaBase.typeSchemas ?? {}) as Record<string, Record<string, unknown> | undefined>) };
  for (const [kind, from] of sources) {
    const def = known[kind]?.[from];
    if (def === undefined || carried[kind]?.[from] !== undefined) continue;
    carried[kind] = { ...(carried[kind] ?? {}), [from]: def };
  }
  return { ...metaBase, typeSchemas: carried as SpaceMeta['typeSchemas'] };
}

/** A meta as a conversion step reads it: resolved, library `$ref`s inlined as the fingerprint takes them. */
const resolvedForSteps = (meta: Partial<SpaceMeta> | undefined): ConversionMeta => inlineResolvableRefs(meta ?? {}) as ConversionMeta;

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
  /**
   * What the caller chose to do with the records already stored, once its steps were held to the schema before and after the edit (`Q-745`):
   * conversion steps, or `{}` to stamp only. Absent when the request named none. Never part of the meta stored: a round carries it beside the meta,
   * and the outcome hands it on ({@link ConvertCarried}).
   */
  convertRecords?: ConvertRecords;
  /** Q-748: a networked space's rebase, opened as a `space_rebase` round on every network carrying the space; nothing else is in the write. */
  rebaseProposal?: RebaseProposal;
  /** Q-748: a voted network's offered base, accepted here alone at its epoch (no round); clears the space's recorded conflicts. */
  acceptRdf?: RdfSetting;
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
  /** Who writes: what decides which other space a `rdf_base_shared` refusal may name (`schema: read` on it, or instance administration). */
  caller?: { rights?: TokenRights | null };
}): MetaUpdateDecision {
  const { spaceId, space, body, ifMatch } = input;

  if (!space) return { ok: false, refusal: lostSpaceAnswer(null, spaceId) };

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
    log.warn(`space update refused: ${peerText(refusal.error)}`);
    return { ok: false, refusal: badConversionStepRefusal(refusal) ?? { status: 400, body: refusal } };
  }
  // A conversion step is held to a schema, and a request with no meta has no schema to hold it to: refused here, before anything else is read.
  if (parsed.data.convertRecords !== undefined && parsed.data.meta === undefined) {
    return { ok: false, refusal: { status: BAD_BODY, body: {
      error: 'convertRecords goes with a schema change: send it with a meta (a conversion step is held to the schema before and after the change)',
      code: 'convert_needs_meta',
    } } };
  }

  // Q-748: the RDF setting is settled by its one rule before anything is merged — an omission keeps the stored value, the base is frozen,
  // and on a networked space a rebase is a `space_rebase` round of its own, never a field of a settings round.
  const rdfSettled = settleRdfOfWrite(space, parsed.data, input.caller?.rights);
  if (!rdfSettled.ok) return { ok: false, refusal: rdfSettled.refusal };
  const rebaseProposal = rdfSettled.proposeRebase;
  const acceptRdf = rdfSettled.acceptRdf;

  // Validate any $ref values in the incoming meta against the instance schema library: an entry that does not exist, or one of ANOTHER
  // kind, whose endpoints and functional would never apply (`Q-215`). Checked here, at the save of the reference, against this
  // instance's library — never inside the shared parse, because a peer's library is its own. The one refusal is the package's.
  const refRefusal = libraryRefRefusal(parsed.data.meta?.typeSchemas as z.infer<typeof TypeSchemasZ> | undefined);
  if (refRefusal) return { ok: false, refusal: { status: 422, body: { error: refRefusal.message } } };

  // Snapshot for the audit log's change list, taken BEFORE anything is applied. Handing the whole record
  // over is safe: `audit-changes.ts` reads only the fields allowlisted for `space.update` and never
  // touches the rest, so this cannot publish something by carrying it. The middleware only records it on
  // a <400 response, so a request rejected above logs no change — which is why every refusal returns before here.
  const audit = {
    before: { ...space, ...space.meta } as Record<string, unknown>,
    after: { ...space, ...space.meta, ...parsed.data, ...(parsed.data.meta ?? {}) } as Record<string, unknown>,
  };
  // `unknownWriteFields` (Q-320): both sides go through the one reader, so absent, `'warn'`, `''` and `null` are ONE state and a PATCH that
  // changes nothing records nothing (`audit-changes.ts` skips equal sides). Left to the spread above, the cleared forms would read as
  // a change from `refuse` to `''` or `null`, and a no-op PATCH of `'warn'` on a space that already warns would record a change from nothing.
  // An accepted offer took `meta` out of the write (it lands alone): its names are the after side, and it moves every address the space gives
  // out, so it is held to the term-clash rule on the meta it leaves, as any other base move (review finding 7).
  if (acceptRdf !== undefined) {
    audit.after['rdf'] = acceptRdf;
    const clashes = termClashes(inlineResolvableRefs({ ...(space.meta ?? {}), rdf: acceptRdf } as SpaceMeta), Object.values(getConfig().schemaLibraryNamespaces ?? {}));
    if (clashes.length > 0) {
      return { ok: false, refusal: { status: TERM_CLASH_STATUS, body: { error: `accepting this base would give two terms of this space one RDF address: ${clashes.map(c => c.message).join('; ')}`, code: 'rdf_term_clash' } } };
    }
  }
  audit.before['unknownWriteFields'] = unknownWriteFieldsMode(space);
  audit.after['unknownWriteFields'] = parsed.data.unknownWriteFields === undefined
    ? unknownWriteFieldsMode(space)
    : unknownWriteFieldsMode({ unknownWriteFields: parsed.data.unknownWriteFields });

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
  // The definitions this write changes are THIS INSTANCE'S OWN (`ownMeta`, once a network layer exists; `meta` is all its own until then):
  // `space.meta` is the effective meta, own laid under each layer, and a type both define is the union of the two there. Merged over the
  // union, an edit of one property of such a type would take the network's properties into the proposal, and from there into this
  // instance's own definitions, where they are sent on to every other network the space is in (the editor loads the own definitions for the
  // same reason: `GET /api/spaces` answers the effective meta, `GET /api/spaces/:id/schema-layers` the own one).
  // The networks are read only for a write that targets one: a write to the own definitions asks nothing of the config.
  const writeBase = metaWriteBase(space, targetNetwork, targetNetwork === undefined ? [] : getConfig().networks);
  if (targetNetwork !== undefined) {
    const extra = Object.keys(parsed.data).filter(k => !['meta', 'typeSchemasMode', 'targetNetwork', 'convertRecords'].includes(k)
      && (parsed.data as Record<string, unknown>)[k] !== undefined);
    if (extra.length) {
      return { ok: false, refusal: { status: 400, body: { error: `targetNetwork proposes that network's schema only: send meta (and typeSchemasMode), not ${extra.join(', ')}` } } };
    }
    if (parsed.data.meta === undefined) {
      return { ok: false, refusal: { status: 400, body: { error: 'targetNetwork needs a meta to propose' } } };
    }
    if (!writeBase) {
      return { ok: false, refusal: { status: 400, body: { error: `Network '${targetNetwork}' does not carry space '${spaceId}'` } } };
    }
  }
  const base: Partial<SpaceMeta> = writeBase ?? {};

  // Merge the incoming meta with the existing meta so that PATCH has true RFC-7396 semantics: scalar fields
  // overwrite, typeSchemas entries are added/updated (a type the body names is replaced whole, its other properties dropped),
  // and types *not* mentioned in the body are preserved.
  // `typeSchemasMode: 'replace'` opts out of that last clause so a deletion can be expressed at all.
  // What is stored is PARSED (`Q-216`): the merged result is read against `base`, so the parts the request changed go through the one
  // body and every other part is, by construction, what the store already holds. The planner's own body parse above is for the
  // request's shape; this is the value a store accepts.
  let mergedMeta: ParsedSpaceMeta | undefined;
  if (parsed.data.meta !== undefined) {
    const minted = parseSpaceMeta(mergeSpaceMeta(base, parsed.data.meta, parsed.data.typeSchemasMode ?? 'merge'), { against: base });
    if (!minted.ok) return { ok: false, refusal: { status: 400, body: { error: minted.message } } };
    mergedMeta = minted.meta;
    const clash = termClashRefusalAfterEdit(space, {
      base, incoming: parsed.data.meta as Partial<SpaceMeta>, mode: parsed.data.typeSchemasMode ?? 'merge', merged: mergedMeta, targetNetwork,
    });
    if (clash) return { ok: false, refusal: clash };
  }
  /*
   * What the audit log says about the schema (R6-13): the types, properties and rules as the edit LEAVES them against what it was merged
   * over. The body's `typeSchemas` is a fragment (a PATCH names only the types it replaces), so comparing it with the stored map would
   * record every type it did not mention as removed — the merged result is the after. An edit that carries no meta hands over neither
   * part, and the summariser reads that as "not touched".
   */
  if (mergedMeta !== undefined) {
    audit.before['typeSchemas'] = base.typeSchemas ?? {};
    audit.before['rules'] = base.rules ?? {};
    audit.after['typeSchemas'] = mergedMeta.typeSchemas ?? {};
    audit.after['rules'] = mergedMeta.rules ?? {};
  }
  const changedTypes = typesAnEditChanges(base, parsed.data.meta as Partial<SpaceMeta> | undefined);

  // `Q-745`: the steps, held to the schema BEFORE the edit (what the space runs now) and the schema AFTER it (what the merge above leaves, laid under
  // the networks' layers). Here, after the merge and before the plan is returned, because a step is held to the schema the edit leaves, and a save that
  // stored first and found the step wrong later would leave the new schema with no conversion — or, on a network, a round carrying the bad step to every
  // member. `{}` has no step and reads nothing. The first refusal answers; the refusal names the step.
  const convertRecords = parsed.data.convertRecords;
  const steps = convertRecords?.steps ?? [];
  const named = parsed.data.meta as Partial<SpaceMeta> | undefined;
  const proposal = mergedMeta === undefined ? undefined : proposalOf(mergedMeta, named, changedTypes);
  // The round's before-schema: what the changed types held, and (B1) the definition of each type a type step moves records OUT of, which the edit
  // leaves alone: a member that never held the proposer's own definitions holds no definition of it, and refused the step for that.
  const metaBase = mergedMeta === undefined ? undefined : withTypeStepSources(proposalOf(base as SpaceMeta, named, changedTypes), space.meta, steps);
  if (steps.length > 0 && mergedMeta !== undefined) {
    const cfg = getConfig();
    const edit = { base, incoming: parsed.data.meta as Partial<SpaceMeta>, mode: parsed.data.typeSchemasMode ?? 'merge' as const, merged: mergedMeta, targetNetwork };
    const reached = cfg.networks.filter(n => n.spaces.includes(space.id) && (targetNetwork === undefined || n.id === targetNetwork));
    // A networked save is held to what its round carries, by the check every member makes of it (`roundStepIssue`, S2/S3): one check, one pair. A
    // space in no network has no round: its steps are held to its effective schema before the edit and after it.
    const issue = reached.length > 0
      ? roundStepIssue(steps, { metaBase, pendingMeta: proposal, changedTypes }, {
        before: resolvedForSteps(space.meta),
        after: resolvedForSteps(effectiveMetaAfterRound(cfg, space, reached, edit, {
          pendingMeta: proposal!, metaChangedFields: proposedMetaFields(named ?? {}), baseMetaVersion: space.meta?.version ?? 0, ...(metaBase ? { metaBase } : {}),
        })),
      })
      : conversionStepIssues(steps, resolvedForSteps(space.meta), resolvedForSteps(effectiveMetaAfterEdit(cfg, space, edit)))[0];
    if (issue) {
      return { ok: false, refusal: { status: BAD_BODY, body: {
        error: `convertRecords.steps[${issue.step}]: ${issue.message}`, code: 'bad_conversion_step', step: issue.step,
      } } };
    }
  }

  return {
    ok: true,
    plan: {
      spaceId,
      space,
      data: parsed.data,
      mergedMeta,
      proposal,
      metaBase,
      documentExtraction,
      hasDocExtraction,
      recordTtlDays,
      hasRecordTtl,
      audit,
      ...(targetNetwork !== undefined ? { targetNetwork } : {}),
      droppedTypes: typesAReplaceWouldDrop(base, parsed.data.meta as Partial<SpaceMeta> | undefined, parsed.data.typeSchemasMode ?? 'merge'),
      changedTypes,
      ...(convertRecords !== undefined ? { convertRecords } : {}),
      ...(rebaseProposal !== undefined ? { rebaseProposal } : {}),
      ...(acceptRdf !== undefined ? { acceptRdf } : {}),
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
  | ({ outcome: 'applied'; space: SpaceConfig; keptTypes?: string[] } & NetworkedWrite & ConvertCarried & ConvertStarted)
  | ({ outcome: 'vote_pending'; rounds: RoundAnswer[]; keptTypes?: string[] } & NetworkedWrite & ConvertCarried & ConvertStarted)
  | { outcome: 'not_found' };

/** What became of the run a save that carried `convertRecords` asked for, as both doors answer it ({@link convertNotice}). */
export interface ConvertRunNotice {
  state: 'started' | 'after_vote' | 'nothing' | 'not_started';
  /** The types the save converts (`typesToConvert`), whatever else an unfinished run it joined still had to do. */
  types: { kind: string; type: string }[];
  /** The fingerprint the started run converts toward. */
  toFp?: string;
  /** Why the run was not started (`not_started`). */
  error?: string;
}

/** The longest the words of a run not started are kept on the answer. */
const NOT_STARTED_TEXT_MAX = 300;

/** The outcome's {@link ConvertRunNotice}: present only when the save carried `convertRecords`. */
interface ConvertStarted { convertRun?: ConvertRunNotice }

/** The types a save's run reaches, as `typesToConvert` names them; a failure to ask (the run never wired) is said as a run not started. */
function saveConvertTypes(plan: MetaUpdatePlan, inNetwork: boolean, rulesBefore: unknown, rulesAfter: unknown): SchemaConvertTypeRef[] | ConvertRunNotice {
  try {
    return schemaConvertTypes({
      changedTypes: plan.changedTypes, droppedTypes: plan.droppedTypes, inNetwork, rulesBefore, rulesAfter, steps: plan.convertRecords?.steps ?? [],
    });
  } catch (err) {
    return { state: 'not_started', types: [], error: peerText(err instanceof Error ? err.message : String(err), { max: NOT_STARTED_TEXT_MAX }) };
  }
}

/** A start's answer as the notice says it: started toward its fingerprint, nothing to convert, or not started and why. */
function noticeOfStart(started: SchemaConvertStarted, reached: readonly SchemaConvertTypeRef[]): ConvertRunNotice {
  const types = reached.map(t => ({ kind: t.kind, type: t.type }));
  if (!started.ok) return { state: 'not_started', types, error: started.error };
  if (started.run === null) return { state: 'nothing', types };
  return { state: 'started', types, toFp: started.run.toFp };
}

/**
 * The run of a save to a space in NO network (`Q-746`, design 2.2, 5.1): started once the schema is stored (`updated` is the space as the save
 * left it), source `write`, the checked steps, the types `typesToConvert` names with the dropped types counted (nothing keeps a type a solo
 * replace leaves out). A start that fails is said on the answer; the save stays.
 */
async function convertRunOfSave(plan: MetaUpdatePlan, before: SpaceMeta | undefined, updated: SpaceConfig): Promise<ConvertStarted> {
  if (plan.convertRecords === undefined) return {};
  const types = saveConvertTypes(plan, false, before?.rules, updated.meta?.rules);
  if (!Array.isArray(types)) return { convertRun: types };
  const started = await startSchemaConvertInTurn({
    spaceId: plan.spaceId, types, steps: [...(plan.convertRecords.steps ?? [])], source: { kind: 'write' }, before: resolvedForSteps(before),
  });
  return { convertRun: noticeOfStart(started, types) };
}

/**
 * The run of a NETWORKED save (`Q-746`, design 4.1): a round that passed here on this instance's own yes started it, source `round`, when its stores
 * were written (`passedMetaChange`), so the save reads what those starts answered (`roundConvertStartOf`) and starts no second run beside them. A
 * save whose rounds are all open answers `after_vote`: each member starts its run when the round passes there.
 */
async function convertRunOfRounds(plan: MetaUpdatePlan, before: SpaceMeta | undefined, starts: readonly Promise<SchemaConvertStarted>[], allPassed: boolean): Promise<ConvertStarted> {
  if (plan.convertRecords === undefined) return {};
  const types = saveConvertTypes(plan, true, before?.rules, plan.mergedMeta?.rules);
  if (!Array.isArray(types)) return { convertRun: types };
  if (starts.length === 0) {
    const named = types.map(t => ({ kind: t.kind, type: t.type }));
    return { convertRun: allPassed
      ? { state: 'not_started', types: named, error: 'the round passed here and started no run: this instance could not read the schema it proposes' }
      : { state: 'after_vote', types: named } };
  }
  const answers = await Promise.all(starts);
  const started = answers.find(a => a.ok && a.run !== null) ?? answers.find(a => !a.ok) ?? answers[0]!;
  return { convertRun: noticeOfStart(started, types) };
}

/**
 * What a save that chose a conversion hands on to the run that is started from it (`Q-745`): the steps it checked, the types the edit changed and the
 * types a `replace` left out (kept on a networked space). Present only when the request carried `convertRecords`. The run is started from this by the
 * one place that starts it; nothing here calls anything, so the checked steps and the types they apply to are what a later step reads and never
 * something it derives again from the request.
 */
export interface ConvertCarried {
  convert?: { convertRecords: ConvertRecords; changedTypes: string[]; droppedTypes: string[] };
}

/** The {@link ConvertCarried} of a plan: nothing for a plan that chose no conversion. */
function convertCarriedBy(plan: MetaUpdatePlan): ConvertCarried {
  return plan.convertRecords === undefined ? {}
    : { convert: { convertRecords: plan.convertRecords, changedTypes: plan.changedTypes, droppedTypes: plan.droppedTypes } };
}

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
  // Before anything is written, the local settings included: a space an RDF import holds takes no schema write (amendment A3).
  if (mergedMeta !== undefined || proposal !== undefined) assertSchemaWritable(id);
  const cfg = getConfig();
  // The effective schema before anything is written: what a run's split steps read their declared properties from, and its rules' before.
  const metaBefore = space.meta;

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
    // The sweep's indexes (the declaration's `SWEEP_INDEXES`): each failed one is said with the index named, and the sweep tries again.
    if (plan.recordTtlDays !== undefined) void ensureTtlIndexes(id).catch(err => log.warn(`TTL sweep indexes of space '${peerText(id)}': ${peerText(err)}`));
  }

  // `M-2`: the conversion marker. Local like the two above and applied here for the same reason plus one of
  // its own — it says what has been done to the data on THIS disk, so a network vote could carry one
  // instance's finished conversion onto peers that have converted nothing.
  if (patchData.completeLinkage !== undefined) {
    updateSpace(id, { completeLinkage: patchData.completeLinkage });
  }

  // `unknownWriteFields` (Q-320): this instance's answer to a top-level field a brain write does not take. Local like the three above,
  // and for their reason: it is never replicated, so a vote has nothing to carry and a networked PATCH that also changes the meta would
  // answer `vote_pending` and drop it silently. `!== undefined`, not truthiness: `null` and `''` are the clear, and `updateSpace` removes
  // the key for them and never stores `'warn'`. Applied HERE and taken out of the spread below (`storablePatch`), so one site writes it.
  if (patchData.unknownWriteFields !== undefined) {
    updateSpace(id, { unknownWriteFields: patchData.unknownWriteFields });
  }

  // Already capped to the instance ceiling by the planner.
  if (plan.hasDocExtraction) {
    updateSpace(id, { documentExtraction: plan.documentExtraction });
  }

  // Q-748: a shared space's rebase is a `space_rebase` round on every network carrying it, carrying the new `{ base, vocab, epoch }` (bound
  // by every cast's `bsig`), landed at its deadline by the expiry tick (`applyOwedRebaseRounds`); nothing moves now. A round of this
  // instance's own for the same space and base that is open or still to land is answered again, so a repeated request opens no duplicate.
  // Q-748: the admin takes over the base a peer of a voted network offered at a higher epoch: this instance's own setting, written here alone.
  if (plan.acceptRdf !== undefined) {
    const accepted = acceptOfferedRdf(cfg, id, plan.acceptRdf);
    if (!accepted) return { outcome: 'not_found' };
    return { outcome: 'applied', space: accepted };
  }
  if (plan.rebaseProposal !== undefined) {
    const rebase = plan.rebaseProposal;
    const now = Date.now();
    const rounds: RoundAnswer[] = [];
    const reached = cfg.networks.filter(n => n.spaces.includes(id));
    for (const net of reached) {
      const spaceId = localToRemote(net, id);
      const held = net.pendingRounds.find(r => r.proposedHere === true && r.type === 'space_rebase' && r.spaceId === spaceId
        && r.rebase?.base === rebase.base && (roundIsOpen(r, now) || rebaseRoundUnapplied(r)));
      if (held) { rounds.push(roundAnswer(net, held, roundDecided(held))); continue; }
      rounds.push(proposeRound(net, cfg, {
        type: 'space_rebase', subjectInstanceId: cfg.instanceId, subjectLabel: cfg.instanceLabel, subjectUrl: '', spaceId, rebase: { ...rebase },
      }, { now }).answer);
    }
    saveConfig(cfg);
    // The members that cannot read the round, named as every write that sets what an earlier release cannot read names them (lens finding 10).
    const behind = membersBehindRoundType('space_rebase', reached);
    return { outcome: 'vote_pending', rounds, ...(behind.length > 0 ? { skew: behind } : {}) };
  }

  // Network voting: a networked space PROPOSES a meta change rather than applying it.
  if (mergedMeta !== undefined) {
    // F-39.5: a proposal to one network opens its round there alone; any other edit, on every network carrying it.
    const networkedIn = cfg.networks.filter(n => n.spaces.includes(id) && (plan.targetNetwork === undefined || n.id === plan.targetNetwork));
    if (networkedIn.length > 0) {
      const rounds: RoundAnswer[] = [];
      const layers: LayerOutcome[] = [];
      // The runs the rounds that passed at once started here, read while they are being made (`roundConvertStartOf`).
      const convertStarts: Promise<SchemaConvertStarted>[] = [];

      for (const net of networkedIn) {
        /*
         * Opened, signed and EVALUATED through the one open path (`proposeRound`), because the proposer's yes may already be
         * enough (`Q-49`): on club and pub/sub one yes passes a round, and a closed network with no other member needs only ours.
         * The round stays in the list either way, concluded or not, so peers learn of it exactly as before — and the members are
         * told `meta_change_pending` from the same module every opener tells them through.
         */
        const { decided, answer } = proposeRound(net, cfg, {
          type: 'meta_change',
          subjectInstanceId: cfg.instanceId,
          subjectLabel: cfg.instanceLabel,
          subjectUrl: '',
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
          // `Q-745`: the choice made with the change travels with it, so every member decides for itself what to do with its own records. Bound to
          // this instance by the `csig` the open path signs over it (`makeSignedOwnCast`); a round that chose nothing carries no key and no `csig`.
          ...(plan.convertRecords !== undefined ? { convertRecords: plan.convertRecords } : {}),
        });
        const concluded = decided === 'passed';
        if (!concluded) rounds.push(answer);
        const convertStart = concluded ? roundConvertStartOf(answer.roundId) : undefined;
        if (convertStart) convertStarts.push(convertStart);
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

      const convertRun = await convertRunOfRounds(plan, metaBefore, convertStarts, rounds.length === 0);
      if (rounds.length > 0) return { outcome: 'vote_pending', rounds, ...kept, ...reached, ...convertCarriedBy(plan), ...convertRun };

      // Every round passed on the proposer's own vote, so the meta is already written by the conclusion — and swept by
      // it: the conclusion writes through `updateSpace`, which asks for the sweep (a second one here swept it twice).
      const applied = getConfig().spaces.find(s => s.id === id);
      if (!applied) return { outcome: 'not_found' };
      return { outcome: 'applied', space: applied, ...kept, ...reached, ...convertCarriedBy(plan), ...convertRun };
    }
  }

  // `documentExtraction` and `recordTtlDays` are pulled OUT of the spread. Both were applied above from normalised
  // values, and letting the raw body through here overwrote that with itself — so a partial TTL write cleared the
  // four buckets it did not mention, and an all-cleared write stored five explicit nulls instead of nothing. Both
  // returned 200 and looked like they had worked; found by driving the UI.
  // `unknownWriteFields` was applied above for every request, so it leaves the spread too: exactly one site writes it. `convertRecords` leaves it
  // as well, and for the opposite reason: it is never applied as a setting at all (the choice made with the change, carried by the outcome and a
  // network's round), so nothing of it may reach the space. Each of them leaves in this ONE destructure, whatever its spelling:
  // `record-ttl-buckets.test.js` holds the RULE (a partial TTL write through `applySpaceMetaUpdate` never clears a bucket it did not name), not this text.
  const {
    documentExtraction: _rawMode, recordTtlDays: _rawTtl, unknownWriteFields: _rawUnknownWriteFields, convertRecords: _heldOutOfTheSpace, ...storablePatch
  } = patchData;
  // F-39.2: a space in no network has no layer, so its own definitions ARE the edited meta — kept in step, or a stale
  // `ownMeta` would come back the next time a network sends this space a layer.
  const held = getConfig().spaces.find(s => s.id === id);
  if (held?.ownMeta && mergedMeta !== undefined) held.ownMeta = replicatedMetaOf(mergedMeta) as SpaceMeta;
  const updated = updateSpace(id, {
    ...storablePatch,
    meta: mergedMeta,
    ...(plan.hasDocExtraction ? { documentExtraction: plan.documentExtraction } : {}),
  });
  // The stored vectors follow the flag, which is what the userguide has always said happens: `updateSpace` asks for
  // the sweep, not awaited — see `sweepAfterMetaWrite` for why a failure is logged rather than surfaced here.
  if (!updated) return { outcome: 'not_found' };
  // `Q-746`: the run the save chose, started now that the schema it converts toward is the one stored, and never for a save that was refused.
  return { outcome: 'applied', space: updated, ...convertCarriedBy(plan), ...(await convertRunOfSave(plan, metaBefore, updated)) };
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
  if (result.outcome === 'not_found') { const lost = lostSpaceAnswer(null, spaceId); return { status: lost.status, body: lost.body }; }
  // Every round passed on this instance's own yes (a club organiser, a publisher, a lone member): applied already.
  return { status: 200, body: { space: spaceForWire(result.space), ...networkWriteNotice(result, caller) } };
}
