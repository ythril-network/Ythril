/**
 * The one rule for a space's RDF setting: the base is set once and moves only deliberately (Q-748, design r4 §4.1; owner, 2026-11-18).
 *
 * ## What it prevents
 *
 * The base is the one part of the RDF work that cannot change after release without breaking every address already given out. `meta.rdf` is
 * written by five paths (a door's PATCH and `schema_update`, a passed settings round, a network's layer, the effective-meta recompute, a
 * passed `space_rebase` round), and each merges a meta key by replacing it whole. Any one of them left to its merge would move the base by
 * accident: a settings round carrying another member's base, an older peer's wholesale round that knows no `rdf` and so erases it, a
 * precedence swap putting another network's layer on top. So every one of them asks {@link settleRdf}, and the decision lives here once.
 *
 * ## The rule, per source
 *
 * - `local` (a door): an omitted field is filled from what is stored, and a sent `baseEpoch` is overwritten by the stored one. The first
 *   enable takes `<public url>/ld/<space>/` (no public URL: 400 `rdf_base_needed`, there is no fallback). A different base or vocab is 409
 *   `rdf_base_frozen` naming both, unless `rebase: true`: then, on a space in no network, the base moves and the epoch goes up by one; on a
 *   networked space nothing moves here and a `space_rebase` round is proposed (`proposeRebase`), applied at its deadline. The vocab moves
 *   only with the base.
 * - `settings-round`, `layer`: what arrives never moves a stored base, at any epoch. No `rdf` keeps the stored one. Nothing stored adopts
 *   what arrives (the first enable of a shared space). A different base at a higher epoch for which a passed rebase round is still to land
 *   here is early, and quiet; any other different base at the same or a higher epoch is a named conflict; a lower epoch is a stale copy.
 * - `rebase-round`: a passed round at its deadline sets base, vocab and epoch, once.
 *
 * Pure: the public URL, whether the space is networked and the epochs of the held rounds are handed in.
 */
import { z } from 'zod';
import { BaseIriZ, RDF_BASE_EPOCH_MAX, type RdfBaseConflict, type RdfSetting } from '@ythril-network/schema';
import type { NetworkConfig, SpaceConfig, VoteRound } from '../config/types.js';
import { defaultBaseFor, defaultVocabFor } from '../rdf/term-iri.js';
import { localToRemote, remoteToLocal } from '../sync/space-map.js';
import { rebaseRoundHeld, rebaseRoundUnapplied } from '../networks/round-state.js';

/** Who is writing the setting. */
export type RdfSource = 'local' | 'settings-round' | 'layer' | 'rebase-round';

/** What a writer sends: the setting, and on a door the write-only `rebase` flag. A rebase round sends `{ base, vocab, epoch }`. */
export type RdfIncoming = (Partial<RdfSetting> & { rebase?: true }) | { base: string; vocab: string; epoch: number };

/** What a writer needs that the setting itself does not say. */
export interface RdfSettleContext {
  /** The space's id, for the default base. */
  spaceId?: string;
  /** The operator's public URL; absent when only the loopback fallback exists. */
  publicBaseUrl?: string;
  /** The space is carried by at least one network: a rebase is a round, never a write. */
  networked?: boolean;
  /** The epochs of passed `space_rebase` rounds held here and not yet applied: a layer that already carries one is early, not a conflict. */
  heldRebaseEpochs?: ReadonlySet<number>;
  /** The network a layer or round came from, named in a conflict. */
  networkId?: string;
  /** The bases peers offer at a higher epoch (the recorded conflicts of the space): a networked rebase to one of them accepts it. */
  offeredBases?: readonly { base: string; epoch: number }[];
}

/** A rebase a networked door proposes as a `space_rebase` round. */
export interface RebaseProposal { base: string; vocab: string; epoch: number }

export type RdfSettled =
  | {
    ok: true;
    /** The setting to store (`undefined`: none). */
    rdf: RdfSetting | undefined;
    /** The base moved now: what from, to and at which epoch (audited by the caller). */
    rebased?: { from: string; to: string; epoch: number };
    /** A networked door's rebase, to open as a round. */
    proposeRebase?: RebaseProposal;
    /** A base offered that no round explains. */
    conflict?: RdfBaseConflict;
    /** A networked door's rebase took over a base a peer offered at a higher epoch (`offeredBases`): it lands here alone, no round. */
    acceptedOffer?: true;
  }
  | { ok: false; status: RdfRefusalStatus; code: 'rdf_base_needed' | 'rdf_base_frozen' | 'rdf_base_unchanged'; error: string };

/** The statuses of the setting's refusals: a base that cannot be made is a request the caller fixes; a base that stands is a conflict. */
export const RDF_BASE_NEEDED_STATUS = 400 as const;
export const RDF_BASE_STANDS_STATUS = 409 as const;
export type RdfRefusalStatus = typeof RDF_BASE_NEEDED_STATUS | typeof RDF_BASE_STANDS_STATUS;

/** The setting as stored, with no write-only flag and no undefined keys. */
function clean(r: { enabled?: boolean; base?: string; vocab?: string; baseEpoch?: number }): RdfSetting {
  return {
    enabled: r.enabled === true,
    ...(r.base !== undefined ? { base: r.base } : {}),
    ...(r.vocab !== undefined ? { vocab: r.vocab } : {}),
    ...(r.baseEpoch !== undefined ? { baseEpoch: r.baseEpoch } : {}),
  };
}

/** The local space a `space_rebase` round of `net` is about (the round names it by the NETWORK's id), or `undefined` when not carried there. */
export function rebaseRoundSpaceOf(net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>, round: Pick<VoteRound, 'spaceId'>): string | undefined {
  if (typeof round.spaceId !== 'string') return undefined;
  const local = remoteToLocal(net as NetworkConfig, round.spaceId);
  return net.spaces.includes(local) ? local : undefined;
}

/**
 * The epochs of the passed rebase rounds held for `localSpaceId` and not yet applied here ({@link RdfSettleContext.heldRebaseEpochs}): a layer
 * that already carries one of them is early, not a conflict. Read from the networks handed in, nothing else.
 */
export function heldRebaseEpochs(cfg: { networks: readonly NetworkConfig[] }, localSpaceId: string): Set<number> {
  const out = new Set<number>();
  for (const net of cfg.networks) {
    for (const r of net.pendingRounds ?? []) {
      if (rebaseRoundUnapplied(r) && r.rebase && rebaseRoundSpaceOf(net, r) === localSpaceId) out.add(r.rebase.epoch);
    }
  }
  return out;
}

/**
 * Every `space_rebase` round for `localSpaceId` held here at `now` (open, or passed and still to land), over every network, whoever proposed it
 * (`rebaseRoundHeld`). A door refuses another rebase of the space while one is held (`rdf_rebase_pending`).
 */
export function heldRebaseRounds(cfg: { networks: readonly NetworkConfig[] }, localSpaceId: string, now: number): VoteRound[] {
  return cfg.networks.flatMap(net => (net.pendingRounds ?? []).filter(r => rebaseRoundHeld(r, now) && rebaseRoundSpaceOf(net, r) === localSpaceId));
}

/**
 * The conflict a network's layer makes with the base a space holds, or `undefined`: the settle of the layer's `rdf` (source `layer`) over
 * `held`, with the network named and the epochs of the rebase rounds held for the space. Pure.
 */
export function layerRdfConflict(held: RdfSetting | undefined, layer: unknown, ctx: Pick<RdfSettleContext, 'networkId' | 'heldRebaseEpochs'>): RdfBaseConflict | undefined {
  const offered = layer && typeof layer === 'object' ? (layer as { rdf?: unknown }).rdf : undefined;
  if (!offered || typeof offered !== 'object') return undefined;
  const settled = settleRdf(held, offered as RdfSetting, 'layer', ctx);
  return settled.ok ? settled.conflict : undefined;
}

/**
 * The base conflict that stands for `localSpaceId`, merged over every network holding one, or `undefined`. THE reading the RDF doors ask
 * (409 `rdf_base_conflict`, slice D); written only by the effective-meta recompute and cleared by a landed rebase.
 */
export function rdfBaseConflictOf(cfg: { networks: readonly NetworkConfig[] }, localSpaceId: string): RdfBaseConflict | undefined {
  const all = cfg.networks.map(n => n.rdfBaseConflicts?.[localSpaceId]).filter((c): c is RdfBaseConflict => c !== undefined);
  if (all.length === 0) return undefined;
  return { held: all[0]!.held, offered: all.flatMap(c => c.offered) };
}

/** The most spaces one served `rdfBases` map may name: far above any network's spaces, and a bound on what a peer can make this instance read. */
export const SERVED_RDF_BASES_MAX = 1_000;
/** The longest network space id a served `rdfBases` key may be. */
const SERVED_SPACE_KEY_MAX = 200;

/** One space's base as a member serves it beside its vote list: read by the setting's own validators, never taken as it came. */
const ServedRdfBaseZ = z.object({ base: BaseIriZ, baseEpoch: z.number().int().min(0).max(RDF_BASE_EPOCH_MAX) }).strip();

/** The network types whose members exchange `rdfBases`: the voted ones, which pull no schema layer (pub/sub and braintree have the layer). */
const VOTED_NETWORK_TYPES: ReadonlySet<string> = new Set(['closed', 'club', 'democratic']);

/**
 * What this member serves a peer of `net` beside its vote list (Q-748; owner, 2026-11-19, "tell it, do not move it"): each space `net` carries
 * here with RDF on, under the NETWORK's id for it, as `{ base, baseEpoch }`. Nothing for a space with RDF off.
 */
export function servedRdfBasesOf(net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>, spaces: readonly SpaceConfig[]): Record<string, { base: string; baseEpoch: number }> {
  const out: Record<string, { base: string; baseEpoch: number }> = {};
  for (const local of net.spaces) {
    const rdf = spaces.find(s => s.id === local)?.meta?.rdf;
    if (rdf?.enabled !== true || !rdf.base) continue;
    out[localToRemote(net as NetworkConfig, local)] = { base: rdf.base, baseEpoch: rdf.baseEpoch ?? 0 };
  }
  return out;
}

/**
 * Compare what a peer of the voted network `net` serves (`served`, its `rdfBases`, untrusted) with the bases this member holds, and record or
 * clear the conflicts beside `net` (`rdfBaseConflicts`). Mutates `net`; returns whether it changed anything. Never throws.
 *
 * - A HIGHER epoch with another base, for a space this member carries with RDF on, records a conflict naming `net`. Nothing lands: the admin
 *   accepts the offered base (or a rebase round lands) and the conflict clears.
 * - A lower or equal epoch changes nothing; a conflict whose offered epoch the member's own has reached is cleared.
 * - What is served is read by the setting's validators and bounded first; an entry no door would accept is left out, and a list that is not
 *   one (an older build serves none) is nothing.
 * - Pub/sub and braintree are left to their layers.
 */
export function takeServedRdfBases(net: NetworkConfig, spaces: readonly SpaceConfig[], served: unknown): boolean {
  if (!VOTED_NETWORK_TYPES.has(net.type)) return false;
  const entries = served && typeof served === 'object' && !Array.isArray(served) ? Object.entries(served as Record<string, unknown>) : [];
  if (entries.length > SERVED_RDF_BASES_MAX) return false;
  let changed = false;
  const conflicts = { ...(net.rdfBaseConflicts ?? {}) };
  for (const local of net.spaces) {
    const held = spaces.find(s => s.id === local)?.meta?.rdf;
    if (held?.enabled !== true || !held.base) continue;
    const heldEpoch = held.baseEpoch ?? 0;
    const recorded = conflicts[local];
    if (recorded && recorded.offered.every(o => o.epoch <= heldEpoch)) { delete conflicts[local]; changed = true; }
    const key = localToRemote(net, local);
    const raw = key.length <= SERVED_SPACE_KEY_MAX ? entries.find(([k]) => k === key)?.[1] : undefined;
    if (raw === undefined) continue;
    // A value no door would accept is left out, unsaid: an older or a hostile peer's text is never quoted back.
    const offer = ServedRdfBaseZ.safeParse(raw);
    if (!offer.success) continue;
    if (offer.data.baseEpoch <= heldEpoch || offer.data.base === held.base) continue;
    const next: RdfBaseConflict = { held: { base: held.base, epoch: heldEpoch }, offered: [{ networkId: net.id, base: offer.data.base, epoch: offer.data.baseEpoch }] };
    if (JSON.stringify(conflicts[local]) === JSON.stringify(next)) continue;
    conflicts[local] = next;
    changed = true;
  }
  if (changed) net.rdfBaseConflicts = Object.keys(conflicts).length > 0 ? conflicts : undefined;
  return changed;
}

/** Settle `incoming` against `stored` for `source`. Never throws. */
export function settleRdf(stored: RdfSetting | undefined, incoming: RdfIncoming | undefined, source: RdfSource, ctx: RdfSettleContext = {}): RdfSettled {
  if (incoming === undefined) return { ok: true, rdf: stored };
  if (source === 'rebase-round') return settleRound(stored, incoming as RebaseProposal);
  const sent = incoming as Partial<RdfSetting> & { rebase?: true };
  return source === 'local' ? settleLocal(stored, sent, ctx) : settleArriving(stored, sent, ctx);
}

function settleRound(stored: RdfSetting | undefined, round: RebaseProposal): RdfSettled {
  if ((stored?.baseEpoch ?? -1) >= round.epoch) return { ok: true, rdf: stored };
  const rdf = clean({ enabled: stored?.enabled ?? true, base: round.base, vocab: round.vocab, baseEpoch: round.epoch });
  return { ok: true, rdf, ...(stored?.base ? { rebased: { from: stored.base, to: round.base, epoch: round.epoch } } : {}) };
}

function settleLocal(stored: RdfSetting | undefined, sent: Partial<RdfSetting> & { rebase?: true }, ctx: RdfSettleContext): RdfSettled {
  const enabled = sent.enabled ?? stored?.enabled ?? false;
  if (!stored?.base) {
    // The first set: a sent base is taken; an enable without one takes the instance's public address, and there is no fallback.
    let base = sent.base;
    if (base === undefined && enabled) {
      if (!ctx.publicBaseUrl || ctx.spaceId === undefined) {
        return { ok: false, status: RDF_BASE_NEEDED_STATUS, code: 'rdf_base_needed', error: 'RDF needs a base address for this space, and this instance has no public URL: '
          + 'set the instance\'s publicUrl (or PUBLIC_BASE_URL), or send meta.rdf.base with the address the space\'s records should have (ending in "/")' };
      }
      base = defaultBaseFor(ctx.publicBaseUrl, ctx.spaceId);
    }
    if (base === undefined) return { ok: true, rdf: clean({ enabled }) };
    return { ok: true, rdf: clean({ enabled, base, vocab: sent.vocab ?? defaultVocabFor(base), baseEpoch: 0 }) };
  }
  const epoch = stored.baseEpoch ?? 0;
  const heldVocab = stored.vocab ?? defaultVocabFor(stored.base);
  const baseMoves = sent.base !== undefined && sent.base !== stored.base;
  const vocabMoves = sent.vocab !== undefined && sent.vocab !== heldVocab;
  if (!baseMoves && !vocabMoves) {
    if (sent.rebase === true) {
      return { ok: false, status: RDF_BASE_STANDS_STATUS, code: 'rdf_base_unchanged', error: `rdf.rebase asks for a new base, and ${sent.base ?? stored.base} is the base this space already has: send a different rdf.base` };
    }
    return { ok: true, rdf: clean({ ...stored, enabled }) };
  }
  if (sent.rebase !== true || !baseMoves) {
    const offered = baseMoves ? sent.base! : sent.vocab!;
    const held = baseMoves ? stored.base : heldVocab;
    return { ok: false, status: RDF_BASE_STANDS_STATUS, code: 'rdf_base_frozen', error: `this space's RDF ${baseMoves ? 'base' : 'vocab'} is ${held} and is not changed by an ordinary write (${offered} was sent): `
      + (baseMoves ? 'send rdf.rebase: true with the new base to change it deliberately; every address the space gave out changes with it' : 'the vocab moves only with the base: send a new rdf.base with rdf.rebase: true') };
  }
  const next: RebaseProposal = { base: sent.base!, vocab: sent.vocab ?? defaultVocabFor(sent.base!), epoch: epoch + 1 };
  // A base a peer of a voted network offers at a higher epoch (a recorded conflict) is ACCEPTED here, at its epoch, with no round: the network
  // already moved, this member missed it, and its admin is taking it over (owner, 2026-11-19: "tell it, do not move it").
  const offer = ctx.networked ? ctx.offeredBases?.find(o => o.base === next.base && o.epoch > epoch) : undefined;
  if (offer) {
    return {
      ok: true, acceptedOffer: true,
      rdf: clean({ enabled, base: next.base, vocab: next.vocab, baseEpoch: offer.epoch }),
      rebased: { from: stored.base, to: next.base, epoch: offer.epoch },
    };
  }
  if (ctx.networked) return { ok: true, rdf: clean({ ...stored, enabled }), proposeRebase: next };
  return {
    ok: true,
    rdf: clean({ enabled, base: next.base, vocab: next.vocab, baseEpoch: next.epoch }),
    rebased: { from: stored.base, to: next.base, epoch: next.epoch },
  };
}

function settleArriving(stored: RdfSetting | undefined, sent: Partial<RdfSetting>, ctx: RdfSettleContext): RdfSettled {
  if (!stored?.base) return { ok: true, rdf: clean({ ...sent, enabled: sent.enabled ?? stored?.enabled ?? false }) };
  const kept = clean({ ...stored, enabled: sent.enabled ?? stored.enabled });
  if (sent.base === undefined || sent.base === stored.base) return { ok: true, rdf: kept };
  const heldEpoch = stored.baseEpoch ?? 0;
  const offeredEpoch = sent.baseEpoch ?? 0;
  if (offeredEpoch < heldEpoch) return { ok: true, rdf: kept };
  if (offeredEpoch > heldEpoch && ctx.heldRebaseEpochs?.has(offeredEpoch)) return { ok: true, rdf: kept };
  return {
    ok: true, rdf: kept,
    conflict: { held: { base: stored.base, epoch: heldEpoch }, offered: [{ ...(ctx.networkId ? { networkId: ctx.networkId } : {}), base: sent.base, epoch: offeredEpoch }] },
  };
}
