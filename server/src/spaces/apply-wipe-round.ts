/**
 * What a concluded SPACE round does here — a deletion, a wipe or an addition — decided once, for every place a round concludes.
 *
 * ## One function, every settle site, on purpose
 *
 * A round concludes through an operator's own cast, a peer's relayed cast, the gossip pass, the expiry tick, the retry and — since
 * bundle-106 — the open path, where the proposer's own yes may decide it (`networks/round-conclusion.ts`, `settleRounds`). Written out at
 * each, a change to some of them left the others doing the old thing; so every one hands its rounds here.
 *
 * ## Decided is not applied (design v5 §2.1)
 *
 * A passed deletion or wipe is DECIDED in the settle's synchronous call and APPLIED by the space-act runner: the act is REGISTERED on the
 * config the caller saves (its entry closes the space to writes and holds it from exchanges from that write on), and it runs after the
 * caller's save. `appliedHere` is the second moment — this instance has nothing left to do — and is written by {@link settleSpaceAct}
 * alone: by the runner's completion, or here for a round with nothing to do here. Marking a round applied BEFORE its act ran was how a
 * crash between the two lost the act; never marking a round with nothing to do here was how a wipe of a space held only as an offer
 * emptied the space the day it was accepted (Q-520).
 *
 * ## Veto counting matches `space_deletion` exactly
 *
 * A single veto stops it. That is deliberately stricter than a majority: a member that does not want its copy of a space emptied is not
 * outvoted, because the wipe is irreversible on their instance too.
 *
 * ## Which space, and when — `spaceRoundAction` (`S-9`), asked only through `spaceActTarget`
 *
 * A deletion or wipe acts only on a round that PASSED — `concluded` alone includes a round that expired without enough yes — on the space
 * the round names mapped to this instance's id AND carried by the network the round belongs to, and once. `appliedHere` is local state —
 * adopting or serving a round strips it.
 */
import { log, peerText } from '../util/log.js';
import type { Config, NetworkConfig, VoteRound } from '../config/types.js';
import type { WipeCollectionType } from './lifecycle.js';
import { getConfig, saveConfig, configWriteGeneration } from '../config/loader.js';
import { networkSpaceKey, roundSpaceLocalId } from '../sync/space-map.js';
import { registerSpaceAct, runSpaceAct, spaceActDueAt, spaceActOfRound, type SpaceActRequest, type SpaceRoundSettled } from './space-act-runner.js';
import { applySpaceAdditionRound, forgetPendingOffer, type AdditionSettled } from '../networks/network-spaces.js';
import { auditRoundEffect, ROUND_ADDITION_RETIRED_OPERATION } from '../networks/round-audit.js';
import { roundPassedUnvetoed, spaceActOwed, spaceAdditionOwed } from '../networks/round-state.js';

/** What a concluded space round does here, if anything. */
export type SpaceRoundAction =
  | { kind: 'delete'; localId: string }
  | { kind: 'wipe'; localId: string; types?: WipeCollectionType[] };

/** The decision, pure: a passed, unvetoed, not-yet-applied deletion or wipe of a space this network carries. */
export function spaceRoundAction(
  net: Pick<NetworkConfig, 'spaces' | 'spaceMap'>,
  round: Pick<VoteRound, 'type' | 'spaceId' | 'networkSpaceId' | 'concluded' | 'passed' | 'votes' | 'wipeTypes'> & { appliedHere?: boolean },
): SpaceRoundAction | null {
  // Passed, unvetoed (a single veto stops it) and not yet applied here: the round's one owed predicate.
  if (!spaceActOwed(round) || !round.spaceId) return null;
  const localId = roundSpaceLocalId(net, round);
  if (!localId) return null;
  if (round.type === 'space_deletion') return { kind: 'delete', localId };
  // The types the members VOTED for, never a fresh default. A round approved for `files` must not conclude
  // by emptying the knowledge graph, which is what resolving this at conclusion time would risk.
  const types = round.wipeTypes as WipeCollectionType[] | undefined;
  return { kind: 'wipe', localId, ...(types ? { types } : {}) };
}

/**
 * What a concluded, passed, unvetoed deletion or wipe does HERE (design v5 §2.1, X7): the act to register, or `'not-carried'` — this
 * instance has nothing to do for it, and it is settled at once so it can never act on a space added here later (Q-520).
 *
 * The only reader of the three ways a round finds its space, in this order: (1) a deletion this instance proposed and recorded its own
 * space for (`actLocalId`) while that space is still here — after its network half ran the round resolves to no network space, and the
 * own copy must still go (REL F5); (2) the network space the round names, carried here (`spaceRoundAction`); (3) neither.
 */
export function spaceActTarget(
  net: NetworkConfig, round: VoteRound, cfg: Pick<Config, 'spaces'> = getConfig(),
): { act: SpaceActRequest } | 'not-carried' {
  const viaRound = { networkId: net.id, roundId: round.roundId };
  if (round.type === 'space_deletion' && round.proposedHere && round.actLocalId && cfg.spaces.some(s => s.id === round.actLocalId)) {
    return { act: { kind: 'delete', localId: round.actLocalId, networkId: net.id, round: viaRound } };
  }
  const action = spaceRoundAction(net, round);
  if (!action) return 'not-carried';
  if (action.kind === 'delete') return { act: { kind: 'delete', localId: action.localId, networkId: net.id, round: viaRound } };
  return { act: { kind: 'wipe', localId: action.localId, ...(action.types ? { types: action.types } : {}), round: viaRound } };
}

/**
 * How a concluded space round came to need nothing more from this instance:
 * - `completed` — its act ran here (the runner's completion);
 * - `absent` — the space it names is gone here, so there is nothing to act on;
 * - `not-carried` — this instance does not carry the space the round names;
 * - `superseded` — an addition retired by a later deletion of the same network space.
 */
export type SpaceActSettlement = 'completed' | 'absent' | 'not-carried' | 'superseded';

/**
 * Mark `round` of `net` as needing nothing more here — THE writer of `appliedHere` (design v5 §2.1, W23).
 *
 * `appliedHere` is what stops a round being acted on again: gossip hands every held round back on every changed pass. Written in
 * more than one place, one copy marked a round applied BEFORE its act ran, and a crash between the two lost the act; another never
 * marked it at all, and the act ran again on a space re-created under the same name. So every settlement goes through here, and the
 * caller makes it part of the SAME config write as whatever completed the act (the runner removes its entry in that write).
 *
 * Mutates `round` in place — it must be the round held by the config the caller saves, found by network and round id inside that
 * caller's `mutateConfig`, never one read before an await.
 */
export function settleSpaceAct(net: Pick<NetworkConfig, 'id'>, round: VoteRound, how: SpaceActSettlement): void {
  const local = round as VoteRound & { appliedHere?: boolean };
  if (local.appliedHere === true) return;
  local.appliedHere = true;
  if (how !== 'completed') {
    log.info(`${round.type} round ${peerText(round.roundId)} of network ${peerText(net.id)} settled here: ${how}`);
  }
}

/**
 * Save `cfg` — the live config a settle changed — when nothing has been saved since generation `generation`: the caller of a settle
 * saves synchronously after it, and this is the net under a caller that did not (a test reading state, a pass that only marked). A
 * marking left only in memory is lost by the next reload from disk (`mutateConfig`), which any background writer makes. A config
 * object that is not the live one is the caller's alone, and is left to it. Never throws.
 */
export function saveIfUnsaved(cfg: Config, generation: number, what: string): void {
  if (configWriteGeneration() !== generation || cfg !== getConfig()) return;
  try { saveConfig(cfg); } catch (err) { log.error(`${peerText(what)} could not be saved: ${peerText(err)}`); }
}

/** What one settle of space rounds came to. */
export interface SpaceRoundsApplied {
  /** Every act it started and every addition it applied; never rejects. */
  settled: Promise<(SpaceRoundSettled | AdditionSettled)[]>;
  /** It changed the config object it was handed (a registration, a settlement, a forgotten offer): the caller saves. */
  wrote: boolean;
  /** The act entries it starts once the caller has saved — a door that waits for them releases each when it has answered. */
  acts: string[];
  /** Rounds whose settlement threw; the others are unaffected. */
  failed: { round: VoteRound; cause: unknown }[];
}

const passedOf = (r: VoteRound, type: VoteRound['type']): boolean => r.type === type && roundPassedUnvetoed(r);

/** Was `deletion` opened at or after `addition`? By instant, not by string; an undatable side counts as yes — the safe side re-creates nothing. */
function openedAtOrAfter(deletion: VoteRound, addition: VoteRound): boolean {
  const d = Date.parse(deletion.openedAt);
  const a = Date.parse(addition.openedAt);
  return Number.isNaN(d) || Number.isNaN(a) || d >= a;
}

/**
 * Apply every space-scoped effect of `rounds` — deletion, wipe and addition — on `net`, part of `cfg`, which the caller saves.
 *
 * Three phases over the call's rounds, so the outcome never depends on the order a peer served them in or on a deferral (§2.3):
 * 1. **retire** every passed addition (of this call or held on the network) that a passed, unvetoed deletion of the same network space
 *    (`networkSpaceKey`) opened at or after it supersedes — marked through {@link settleSpaceAct}, logged and audited. A space added and
 *    deleted within one voting window came back on the proposer at the next changed gossip pass; a late adopter served both in one page
 *    let the addition land after the deletion.
 * 2. **deletions and wipes**: a deletion forgets the pending offer of its network space on every instance (VR12); each asks
 *    {@link spaceActTarget} — `'not-carried'` settles in this call, an act is REGISTERED (or joins the entry that already carries its
 *    round) and is started after the caller's save, unless it is owed and its `retryAt` is still ahead.
 * 3. **additions** that remain are applied (deferred a tick, inside `applySpaceAdditionRound`).
 *
 * `opts.waiter`: the caller is a door that awaits the acts (the proposer); their completion is then its to tell, not the audit log's.
 * Never throws: a round whose settlement throws is reported in `failed` and the others go on.
 */
export function applyConcludedSpaceRounds(
  net: NetworkConfig, cfg: Config, rounds: readonly VoteRound[], via: string, opts: { now?: number; waiter?: boolean } = {},
): SpaceRoundsApplied {
  const now = opts.now ?? Date.now();
  const generation = configWriteGeneration();
  const failed: SpaceRoundsApplied['failed'] = [];
  const set = [...new Set(rounds)];
  const known = [...new Set([...set, ...net.pendingRounds])];
  let wrote = false;

  // Phase 1 — retire superseded additions, before any act of this call forgets an alias (`networkSpaceKey` reads the alias table).
  const deletions = known.filter(r => passedOf(r, 'space_deletion'));
  for (const addition of known.filter(spaceAdditionOwed)) {
    try {
      const key = networkSpaceKey(net, addition);
      const by = deletions.find(d => networkSpaceKey(net, d) === key && openedAtOrAfter(d, addition));
      if (!key || !by) continue;
      settleSpaceAct(net, addition, 'superseded');
      wrote = true;
      log.info(`space_addition round ${peerText(addition.roundId)} of network ${peerText(net.id)} retired by space_deletion round ${peerText(by.roundId)} (${peerText(via)}): '${peerText(key)}' is not added back`);
      auditRoundEffect(ROUND_ADDITION_RETIRED_OPERATION, net.id, addition.roundId, roundSpaceLocalId(net, addition));
    } catch (cause) {
      failed.push({ round: addition, cause });
    }
  }

  // Phase 2 — deletions and wipes.
  const start = new Set<string>();
  for (const round of set) {
    if (!spaceActOwed(round)) continue;
    try {
      if (round.type === 'space_deletion') {
        const key = networkSpaceKey(net, round);
        if (key && forgetPendingOffer(net, key)) wrote = true;
      }
      // Already carried by an entry (a pass before this one registered it, or a rename moved its space): that entry is the act.
      const standing = spaceActOfRound(cfg, net.id, round.roundId);
      if (standing) {
        if (spaceActDueAt(standing, now)) start.add(standing.id);
        continue;
      }
      const target = spaceActTarget(net, round, cfg);
      if (target === 'not-carried') {
        settleSpaceAct(net, round, 'not-carried');
        wrote = true;
        continue;
      }
      if (round.type === 'space_deletion' && round.proposedHere && round.actLocalId !== target.act.localId) {
        round.actLocalId = target.act.localId;
      }
      const { entry } = registerSpaceAct(cfg, target.act, now);
      wrote = true;
      if (spaceActDueAt(entry, now)) start.add(entry.id);
    } catch (cause) {
      failed.push({ round, cause });
    }
  }

  // Phase 3 — the additions that remain.
  const additions: Promise<AdditionSettled>[] = [];
  for (const round of set) {
    try {
      // `applySpaceAdditionRound` answers null for a round that is no addition or is not owed (`spaceAdditionOwed`).
      const applied = applySpaceAdditionRound(net, round, via);
      if (applied) additions.push(applied);
    } catch (cause) {
      failed.push({ round, cause });
    }
  }

  for (const { round, cause } of failed) {
    log.error(`${round.type} round ${peerText(round.roundId)} of network ${peerText(net.id)} could not be settled (${peerText(via)}): ${peerText(cause)}`);
  }

  const acts = [...start];
  const started: Promise<SpaceRoundSettled[]> = !wrote && acts.length === 0 ? Promise.resolve([]) : new Promise(resolve => setImmediate(() => {
    // The acts run on what is on disk (the runner re-reads its entry through `mutateConfig`), so they start after the caller's save —
    // and a caller that saved nothing has its registration saved here, or the runner's first write would read the entry away.
    // What this call wrote is saved here too when its caller saved nothing: any other writer's reload would read it away.
    saveIfUnsaved(cfg, generation, `the space rounds of network ${peerText(net.id)}`);
    resolve(Promise.all(acts.map(id => runSpaceAct(id, { waiter: opts.waiter === true, via }))));
  }));

  return {
    settled: Promise.all([started, Promise.all(additions)]).then(([a, b]) => [...a, ...b]),
    wrote, acts, failed,
  };
}
