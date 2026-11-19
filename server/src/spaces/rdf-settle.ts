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
import type { RdfBaseConflict, RdfSetting } from '@ythril-network/schema';
import type { NetworkConfig, VoteRound } from '../config/types.js';
import { defaultBaseFor, defaultVocabFor } from '../rdf/term-iri.js';
import { remoteToLocal } from '../sync/space-map.js';
import { rebaseRoundUnapplied } from '../networks/round-state.js';

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
  }
  | { ok: false; status: 400 | 409; code: 'rdf_base_needed' | 'rdf_base_frozen' | 'rdf_base_unchanged'; error: string };

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
        return { ok: false, status: 400, code: 'rdf_base_needed', error: 'RDF needs a base address for this space, and this instance has no public URL: '
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
      return { ok: false, status: 409, code: 'rdf_base_unchanged', error: `rdf.rebase asks for a new base, and ${sent.base ?? stored.base} is the base this space already has: send a different rdf.base` };
    }
    return { ok: true, rdf: clean({ ...stored, enabled }) };
  }
  if (sent.rebase !== true || !baseMoves) {
    const offered = baseMoves ? sent.base! : sent.vocab!;
    const held = baseMoves ? stored.base : heldVocab;
    return { ok: false, status: 409, code: 'rdf_base_frozen', error: `this space's RDF ${baseMoves ? 'base' : 'vocab'} is ${held} and is not changed by an ordinary write (${offered} was sent): `
      + (baseMoves ? 'send rdf.rebase: true with the new base to change it deliberately; every address the space gave out changes with it' : 'the vocab moves only with the base: send a new rdf.base with rdf.rebase: true') };
  }
  const next: RebaseProposal = { base: sent.base!, vocab: sent.vocab ?? defaultVocabFor(sent.base!), epoch: epoch + 1 };
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
