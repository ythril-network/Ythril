/**
 * May this space be exchanged with this member now (bundle-106, design v5 section 3.3, VR2, VR3, X1, X15, W10).
 *
 * ## The one answer
 *
 * After one side applied a wipe of a space and before the other has, an exchange of that space brings the wiped data back:
 * the manifest diff downloads every file the other side lists, a merkle divergence re-reads its file rows from seq 0, and
 * records above the receive mark are pulled and kept after the other side's wipe deleted them. The data loop, every inbound
 * door, the watermark writes, the fence's admission and a peer token's search or tool call ask {@link spaceHold} and
 * nothing else. A space `s` is held with member M while:
 *
 * - **(a) an act stands for `s` here** (`spaceActStands`, the one standing predicate) - every member, any network;
 * - **(b) this instance applied a passed wipe of `s`** (in ANY network) and, in the network in question, no wipe round of
 *   `s` covering it records M as having concluded it (`peersConcluded`, written by `recordPeerConcluded`);
 * - **(c) M concluded and finished a wipe of `s` that is still open here.**
 *
 * A request that names a network is judged for that network; one that names none (the file routes) is judged across
 * every network that carries `s` and lists M, and is held if held in any of them - the cost of the "any" form is that a
 * member in two networks is held in both while one of them owes. A peer listed in no such network has no evidence to
 * offer, so (a) and (b) hold it.
 *
 * ## What a hand-written copy drops
 *
 * - **Totality.** The rounds read here came from peers. Every round is read inside its own `try`, through the fields it
 *   declares; a round that cannot be read answers `'evidence unknown'` for its space (held), said once per network and
 *   round, and never fails a cycle or a request.
 * - **The index.** Rebuilt once per config write generation ({@link holdIndex}), so the question asked on every inbound
 *   request, every loop step and every peer-token search is a map lookup, not a walk over every adopted round.
 *
 * Bounds, stated: the hold ends when the act completes here (a), when M's completed conclusion is observed (b, c), or when
 * this instance prunes the round - at most `votingDeadlineHours` after the wipe. A peer on an older release never serves the
 * conclusion signal, so with it the hold runs to the prune.
 */
import { getConfig, configWriteGeneration, isConfigLoaded } from '../config/loader.js';
import type { Config, NetworkConfig, NetworkMember, VoteRound } from '../config/types.js';
import { spaceActStands } from '../spaces/space-act-runner.js';
import { openSpaceTransfer, type SpaceTransfer } from './space-transfer-fence.js';
import { roundSpaceLocalId, localToRemote } from './space-map.js';
import { spaceActApplied } from '../networks/round-state.js';
import { warnOnce } from '../util/warn-once.js';
import { log, peerText } from '../util/log.js';

export type HoldReason = 'act owed here' | 'peer has not concluded' | 'peer concluded first' | 'evidence unknown';

/** The wipe types a round covers: a set, or every type when the round names none. */
type Covered = ReadonlySet<string> | 'all';

interface NetEvidence {
  /** Wipe rounds of the space in this network, with the members recorded as having concluded each. */
  evidence: { types: Covered; peers: ReadonlySet<string> }[];
  /** Members that concluded a wipe of the space that is still open here. */
  concludedFirst: Set<string>;
  /** A wipe round of the space in this network could not be read. */
  unknown: boolean;
}

interface SpaceEvidence {
  /** Passed wipes of the space this instance applied, in any network. */
  applied: Covered[];
  byNet: Map<string, NetEvidence>;
}

export interface HoldIndex {
  readonly bySpace: ReadonlyMap<string, SpaceEvidence>;
}

const unreadableRound = warnOnce<string>({ max: 500 });

/**
 * The covered types of a round, read totally: anything but an array of strings covers every type (the safe side).
 * Kept apart from `coveredKey` (`networks/propose-round.ts`) on purpose: that one compares two wipes for EQUALITY and may read an unreadable list as
 * itself, while the hold asks SUPERSET over what a peer served and must fail safe toward holding.
 */
function coveredOf(wipeTypes: unknown): Covered {
  if (!Array.isArray(wipeTypes) || wipeTypes.length === 0 || !wipeTypes.every(t => typeof t === 'string')) return 'all';
  return new Set(wipeTypes as string[]);
}

/** Does `x` cover every type `applied` covers? */
function covers(x: Covered, applied: Covered): boolean {
  if (x === 'all') return true;
  if (applied === 'all') return false;
  for (const t of applied) if (!x.has(t)) return false;
  return true;
}

function netEvidence(space: SpaceEvidence, netId: string): NetEvidence {
  let e = space.byNet.get(netId);
  if (!e) { e = { evidence: [], concludedFirst: new Set(), unknown: false }; space.byNet.set(netId, e); }
  return e;
}

function spaceOf(map: Map<string, SpaceEvidence>, localId: string): SpaceEvidence {
  let s = map.get(localId);
  if (!s) { s = { applied: [], byNet: new Map() }; map.set(localId, s); }
  return s;
}

function buildIndex(cfg: Config): HoldIndex {
  const bySpace = new Map<string, SpaceEvidence>();
  for (const net of cfg.networks ?? []) {
    for (const round of net.pendingRounds ?? []) {
      const raw = round as VoteRound & { peersConcluded?: unknown };
      if (raw?.type !== 'space_wipe') continue;
      // A space named by anything but a string cannot be attributed to a space here: it holds nothing, and it is said once.
      if ((raw.spaceId !== undefined && typeof raw.spaceId !== 'string') || (raw.networkSpaceId !== undefined && typeof raw.networkSpaceId !== 'string')) {
        unreadableRound(`${net.id} ${String(raw.roundId)}`, () => log.warn(`Hold: a wipe round of network ${peerText(net.id)} names no readable space (round ${peerText(String(raw.roundId))}); it holds nothing`));
        continue;
      }
      let localId: string | null = null;
      try {
        localId = roundSpaceLocalId(net, raw);
        if (!localId) continue;
        const types = coveredOf(raw.wipeTypes);
        const peers = new Set(Array.isArray(raw.peersConcluded) ? raw.peersConcluded.filter((p): p is string => typeof p === 'string') : []);
        const space = spaceOf(bySpace, localId);
        const e = netEvidence(space, net.id);
        e.evidence.push({ types, peers });
        if (spaceActApplied(raw)) space.applied.push(types);
        if (raw.concluded !== true) for (const p of peers) e.concludedFirst.add(p);
      } catch (err) {
        unreadableRound(`${net.id} ${String(raw.roundId)}`, () => log.warn(`Hold: a wipe round of network ${peerText(net.id)} could not be read (round ${peerText(String(raw.roundId))}): ${peerText(err)}; its space is held as evidence unknown`));
        if (localId) netEvidence(spaceOf(bySpace, localId), net.id).unknown = true;
      }
    }
  }
  return { bySpace };
}

let memo: { cfg: Config; generation: number; index: HoldIndex } | null = null;

/** The hold's index over `cfg`: the same object while nothing was written, a new one after a config write (X15). */
export function holdIndex(cfg: Config): HoldIndex {
  const generation = configWriteGeneration();
  if (memo && memo.cfg === cfg && memo.generation === generation) return memo.index;
  const index = buildIndex(cfg);
  memo = { cfg, generation, index };
  return index;
}

/** The networks a request for `localSpaceId` from `peerId` is judged in: the one it names, or every one carrying the space and listing the peer. */
function networksJudged(cfg: Config, localSpaceId: string, peerId: string, networkId: string | undefined): NetworkConfig[] {
  const named = networkId ? cfg.networks.find(n => n.id === networkId) : undefined;
  if (named) return [named];
  return cfg.networks.filter(n => n.spaces.includes(localSpaceId) && n.members.some(m => m.instanceId === peerId));
}

/**
 * `null` when `localSpaceId` may be exchanged with `peerId` (in `networkId`, or in every network when none is named);
 * otherwise why not. THE answer every exchange asks. Never throws: a failure to read is `'evidence unknown'`, held.
 */
export function spaceHold(cfg: Config, localSpaceId: string, peerId: string, networkId?: string): HoldReason | null {
  try {
    if (spaceActStands(cfg, localSpaceId)) return 'act owed here';
    const space = holdIndex(cfg).bySpace.get(localSpaceId);
    if (!space) return null;
    const nets = networksJudged(cfg, localSpaceId, peerId, networkId);
    for (const net of nets) {
      const e = space.byNet.get(net.id);
      if (e?.unknown) return 'evidence unknown';
      if (e?.concludedFirst.has(peerId)) return 'peer concluded first';
    }
    if (space.applied.length === 0) return null;
    if (nets.length === 0) return 'peer has not concluded';
    for (const net of nets) {
      const evidence = space.byNet.get(net.id)?.evidence ?? [];
      const unanswered = space.applied.some(a => !evidence.some(x => x.peers.has(peerId) && covers(x.types, a)));
      if (unanswered) return 'peer has not concluded';
    }
    return null;
  } catch (err) {
    unreadableRound(`hold ${localSpaceId}`, () => log.warn(`Hold for space ${peerText(localSpaceId)} could not be evaluated: ${peerText(err)}; held as evidence unknown`));
    return 'evidence unknown';
  }
}

/** A space a network carries that the member left (pub/sub, X10): recorded on the member by its network id, never requested. */
function declinedBy(net: NetworkConfig, member: NetworkMember, localSpaceId: string): boolean {
  const declined = (member as NetworkMember & { declinedSpaces?: unknown }).declinedSpaces;
  return Array.isArray(declined) && declined.includes(localToRemote(net, localSpaceId));
}

/**
 * Lift the declines `memberId` announces again (design v5 section 2.9 v5 (1), amendment AM2): a member that announces a space it
 * once declined carries it again, so the publisher asks for it again. ONE question - which declined ids this member carries
 * again - asked where a member's self-record ARRIVES (the announce route and the gossip read of the member's answer), inside that
 * site's own write. `adoptAnnouncedSpaces` is not the place: it adopts only from an upstream, and a decliner is a subscriber.
 * Reads the announced list totally (anything but strings is ignored). Returns whether the record changed.
 */
export function liftDeclinesFromAnnounce(net: NetworkConfig, memberId: string, announcedSpaces: unknown): boolean {
  if (!Array.isArray(announcedSpaces)) return false;
  const member = net.members.find(m => m.instanceId === memberId) as (NetworkMember & { declinedSpaces?: string[] }) | undefined;
  const declined = member?.declinedSpaces;
  if (!member || !Array.isArray(declined) || declined.length === 0) return false;
  const announced = new Set(announcedSpaces.filter((s): s is string => typeof s === 'string'));
  const kept = declined.filter(id => !announced.has(id));
  if (kept.length === declined.length) return false;
  if (kept.length > 0) member.declinedSpaces = kept; else delete member.declinedSpaces;
  return true;
}

/**
 * The spaces of `net` (the LIVE network, read after the governance pass) to exchange with `member` this cycle, the held ones
 * with why, and the ones the member declined (left out without a request, and never counted as held).
 */
export function exchangeVerdicts(net: NetworkConfig, member: NetworkMember): {
  exchange: string[]; held: { spaceId: string; reason: HoldReason }[]; declined: string[];
} {
  const cfg = getConfig();
  const exchange: string[] = []; const held: { spaceId: string; reason: HoldReason }[] = []; const declined: string[] = [];
  for (const spaceId of net.spaces) {
    if (declinedBy(net, member, spaceId)) { declined.push(spaceId); continue; }
    const reason = spaceHold(cfg, spaceId, member.instanceId, net.id);
    if (reason) held.push({ spaceId, reason }); else exchange.push(spaceId);
  }
  return { exchange, held, declined };
}

/**
 * Held (member, space) pairs per network, from the live config: what `ythril_space_exchange_held` reports. A declined pair is
 * not held - its alert would start and never end (X10).
 */
export function heldExchangePairs(): Map<string, number> {
  const out = new Map<string, number>();
  if (!isConfigLoaded()) return out;
  for (const net of getConfig().networks ?? []) {
    // A scrape reads whatever the config holds: a network whose members or spaces are not a list counts nothing, and stops nothing.
    if (!Array.isArray(net?.members) || !Array.isArray(net.spaces)) continue;
    let pairs = 0;
    for (const member of net.members) pairs += exchangeVerdicts(net, member).held.length;
    out.set(net.id, pairs);
  }
  return out;
}

/** Is `localSpaceId` carried by network `networkId` in the LIVE config, not declined by `peerId`, and not held with it? */
export function mayExchangeNow(networkId: string, peerId: string, localSpaceId: string): boolean {
  const cfg = getConfig();
  const net = cfg.networks.find(n => n.id === networkId);
  if (!net || !net.spaces.includes(localSpaceId)) return false;
  const member = net.members.find(m => m.instanceId === peerId);
  if (member && declinedBy(net, member, localSpaceId)) return false;
  return spaceHold(cfg, localSpaceId, peerId, networkId) === null;
}

/**
 * The spaces a search that NAMED none may fan out over for the caller: `spaces` less every one held for `peerId`. A caller bound to no
 * peer (the operator's own tooling) is never held and gets `spaces` whole.
 *
 * What it prevents: a held space refused when a peer names it but searched, record by record, when the peer names nothing — the fan-out
 * of the rights middleware and of the tool dispatch each spelled the filter, and a door that dropped it let the one refusal be walked
 * around. A space the caller NAMED never reaches here held: its door refuses it first.
 */
export function withoutHeldFor(spaces: readonly string[], peerId: string | undefined): string[] {
  if (!peerId) return [...spaces];
  const cfg = getConfig();
  return spaces.filter(s => !spaceHold(cfg, s, peerId));
}

/**
 * Admit one exchange of `localSpaceId` with `peerId` (or, for no peer, a transfer only an act can stop) and count it in the
 * fence; `null` when the space is held. The admission IS the hold: one predicate, not a second one.
 */
export function enterSpaceTransfer(localSpaceId: string, peerId: string | null, networkId?: string): SpaceTransfer | null {
  const cfg = getConfig();
  const held = peerId ? spaceHold(cfg, localSpaceId, peerId, networkId) : (spaceActStands(cfg, localSpaceId) ? 'act owed here' : null);
  if (held) return null;
  return openSpaceTransfer(localSpaceId);
}
