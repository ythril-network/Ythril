/**
 * One member's exchange of a network's spaces, one space at a time: the hold decides which spaces, each space's turn
 * enters the fence and is cancellable, and every watermark it writes asks the hold first (bundle-106, design v5 sections
 * 3.3, 3.3a, 3.4; VR6, VR13, W4, W9, X5, X9, X10).
 *
 * Moved out of `sync/engine.ts`, which is frozen by `no-new-god-files`: the per-space loop, the pull and the push lived there.
 *
 * ## The rules it holds
 *
 * - **One set.** The loop exchanges what `exchangeVerdicts` produced from the LIVE network, read after the governance pass
 *   (a deletion that passed in that pass has already removed its space), and asks `mayExchangeNow` again right before each
 *   space: the tick, the relay or an operator's cast can begin an act, or finish a wipe, between two turns.
 * - **A turn is cancellable.** A turn enters the fence (`enterSpaceTransfer`, which IS the hold's admission), hands its
 *   signal to every fetch, and asks `mayContinue()` between units; an act registered on the space aborts the signal, so the
 *   unit in flight is cut and the turn stops at its next unit. The transfer is released in a `finally`: a turn that throws
 *   leaks no count, and a leaked count would make every later act on the space wait for a transfer that no longer exists.
 * - **Held and declined are not failures.** A turn stopped by an act, or by a peer answering `423 space_held`, is a HELD
 *   space; `423 space_declined` is a DECLINED one, recorded on the member so it is not asked for again. Neither adds to
 *   `incomplete`, so neither moves the member's failure counter, and neither writes a watermark past where it stopped.
 * - **No mark for a space nobody asked about.** Each watermark write sits under `mayExchangeNow`: a space removed (the
 *   act cleared its marks) or newly held between the start of its exchange and the write is not written back.
 */
import { getConfig, saveConfigSoon, mutateConfig } from '../config/loader.js';
import type { NetworkConfig, NetworkMember } from '../config/types.js';
import type { SyncCounts, SyncSchemaRecording } from './history.js';
import { mergeSummaries, NOTHING_RECORDED, type RecordedSummary } from './arrival-recording.js';
import { log, peerList, peerText } from '../util/log.js';
import { resolveWatermark, type TransferOutcome } from './watermark.js';
import { pullFamily, type PullResult } from './pull-family.js';
import { pushFamily } from './push-family.js';
import { pushTombstones } from './tombstone-transfer.js';
import { pullSpaceTombstones } from './pull-space-tombstones.js';
import { refusedTransfers } from './push-refusals.js';
import { assertPositionsReady } from './positions-ready.js';
import { ownPositionMark } from './served-watermark.js';
import { syncItemsPulledTotal, syncPositionBehindTotal } from '../metrics/registry.js';
import { PositionsBuilding } from '../util/errors.js';
import { configuredSpaces } from '../spaces/space-lookup.js';
import { isDirectionalNetwork } from '../networks/network-spaces.js';
import { pullSpaceMetaFromUpstream } from './space-meta-pull.js';
import { LinkageCheck } from './linkage-check.js';
import { syncFiles } from './file-sync.js';
import { checkMerkleWithPeer } from './merkle-check.js';
import { recordFileMetaMerkleComparison, rereadFileMeta } from './file-meta-reread.js';
import { readMemberSpaceMark, setMemberSpaceMark } from './member-space-mark.js';
import { RereadSlot, beginFullReread, endFullReread } from './full-reread.js';
import { REPLICATED_FAMILIES, addCounts, countsOf, familiesNotComplete, zeroCounts, type PayloadKey } from './replicated-families.js';
import { arrivalStopReason, stopKindOfThrow } from './arrival-stop.js';
import { isStoreSide } from '../brain/store-failure.js';
import { storeIsNotAnswering } from '../db/store-condition.js';
import { isShuttingDown } from '../lifecycle.js';
import { reverseSpaceMap, localToRemote } from './space-map.js';
import { exchangeVerdicts, mayExchangeNow, enterSpaceTransfer, spaceHold } from './space-exchange-set.js';
import type { ExchangeTurn, TransferRefusal } from './held-answer.js';
import type { SpaceTransfer } from './space-transfer-fence.js';

/** Why a space was not exchanged with a member this cycle: the hold's reason, or the member's own refusal. */
export type HeldSpace = { spaceId: string; reason: string; /** The families of the space that are held, when the hold is theirs and not the space's (`edge_identity_building`: `['edges']`). */ families?: string[] };

/** What one member's exchange of a network's spaces moved, and what it did not move and why. */
export interface MemberExchange {
  pulled: SyncCounts;
  pushed: SyncCounts;
  incomplete: string[];
  /** A pull that stopped at the cycle's page cap, one entry per space: PARTIAL, not a failure — the member is catching up. */
  capped: string[];
  refused: string[];
  recorded: SyncSchemaRecording[];
  held: HeldSpace[];
  /** Local ids of the spaces the member declined (pub/sub, X10). */
  declined: string[];
  /**
   * What THIS instance failed to do, one entry per space and direction (bundle-39 D1): a page the peer delivered that could not land here, or this
   * instance's own store failing at the turn (`isStoreSide`). Never in `incomplete`: not the peer's failure, and not counted toward PEER UNREACHABLE.
   */
  localFaults: string[];
  /** Spaces whose turn shutdown stopped at a page boundary (bundle-39 D5): nothing failed, the member's outcome is `interrupted`. */
  interrupted: string[];
  /** The peer answered during the exchange (a page landed or was delivered): the member counter measures the peer, so it resets (D1 v2). */
  peerAnswered: boolean;
  /** This instance's store is not answering (`storeIsNotAnswering`): the cycle attempts no further member (v6 S6). */
  storeDown: boolean;
}

/** A member exchange that moved nothing yet. */
export const emptyExchange = (): MemberExchange => ({
  pulled: zeroCounts(), pushed: zeroCounts(), incomplete: [], capped: [], refused: [], recorded: [], held: [], declined: [],
  localFaults: [], interrupted: [], peerAnswered: false, storeDown: false,
});

/** The reason a turn the PEER held is listed under. */
const HELD_BY_THE_MEMBER = 'held by the member';
/** The reason a space THIS instance owes the positions of is listed under (its first carry or a repair has not finished). */
const POSITIONS_BUILDING_REASON = 'positions building';
/** The reason a family held (by this instance as a receiver, or by the peer that answered `edge_identity_building`) is listed under, beside the family's name. */
const FAMILY_HELD_REASON = 'edge identity rebuilding';

/** One turn: the fence's transfer, plus the first hold or decline a peer answered during it. */
class SpaceTurn implements ExchangeTurn {
  refusal: 'held' | 'declined' | null = null;
  constructor(private readonly transfer: SpaceTransfer) {}
  get signal(): AbortSignal { return this.transfer.signal; }
  mayContinue(): boolean { return this.refusal === null && this.transfer.mayContinue(); }
  // A `family-held` answer holds ONE family and is decided by the family's own transfer (`stopTransfer(..., 'held')`); it never ends the turn.
  refusedBy(verdict: TransferRefusal): void { if (verdict !== 'failed' && verdict !== 'family-held' && this.refusal === null) this.refusal = verdict; }
  /** Stopped by an act on the space (the signal) — as opposed to a peer's refusal. */
  get cut(): boolean { return !this.transfer.mayContinue(); }
}

/** Record that `member` declined network space `networkSpaceId` (X10): the loop leaves the pair out until the member announces it again. */
function recordDecline(networkId: string, memberId: string, networkSpaceId: string): void {
  mutateConfig((cfg) => {
    const member = cfg.networks.find(n => n.id === networkId)?.members.find(m => m.instanceId === memberId) as (NetworkMember & { declinedSpaces?: string[] }) | undefined;
    if (!member) return;
    const list = Array.isArray(member.declinedSpaces) ? member.declinedSpaces : [];
    if (!list.includes(networkSpaceId)) member.declinedSpaces = [...list, networkSpaceId];
  });
}

/**
 * Which ways data moves with `member` on `net`: both on a network with no direction, and on a directional one (braintree, pub/sub, where the
 * direction is stored from THIS instance's side) only the ways its direction names. The one reading of it for the held space's schema pull
 * and for the turn, so a held space's meta travels exactly when its records would have.
 */
function exchangeDirections(net: NetworkConfig, member: NetworkMember): { shouldPull: boolean; shouldPush: boolean } {
  const isDirectional = isDirectionalNetwork(net);
  return {
    shouldPull: !isDirectional || member.direction === 'both' || member.direction === 'pull',
    shouldPush: !isDirectional || member.direction === 'both' || member.direction === 'push',
  };
}

/**
 * Exchange every space of `net` the hold lets through with `member`. The governance pass has run; `net` is the network as read
 * at the start of the cycle, and the spaces are read from the LIVE config here.
 */
export async function exchangeSpacesWithMember(
  net: NetworkConfig, member: NetworkMember, headers: Record<string, string>, fetchOpts: () => RequestInit, batchFetchOpts: () => RequestInit,
): Promise<MemberExchange> {
  const out = emptyExchange();
  const liveNet = getConfig().networks.find(n => n.id === net.id) ?? net;
  const { exchange, held: heldNow, declined: declinedNow } = exchangeVerdicts(liveNet, member);
  out.held.push(...heldNow);
  out.declined.push(...declinedNow);
  // A held space's schema still travels: a wipe changes no schema, and a subscriber takes its types from its upstream (X17).
  if (exchangeDirections(liveNet, member).shouldPull) for (const h of heldNow) await pullSpaceMetaFromUpstream(liveNet, member, h.spaceId, localToRemote(liveNet, h.spaceId), fetchOpts);
  // FIRST match, as `localToRemote` answers (Q-133): a later key for the same space is an inbound alias a rename left behind.
  const toNetworkId = reverseSpaceMap(liveNet);
  // One space of this member may BEGIN a full re-read per cycle (`sync/full-reread.ts`); the rest go on as usual, their marks intact.
  const slot = new RereadSlot(net.id, liveNet.members.find(m => m.instanceId === member.instanceId) ?? member);
  for (const spaceId of exchange) {
    // Shutdown began, or this instance's store stopped answering: no further space starts (bundle-39 D5, v6 S6). The space is not exchanged and
    // nothing moved past it; its marks stay where they are.
    if (isShuttingDown()) { out.interrupted.push(spaceId); continue; }
    if (out.storeDown) continue;
    if (!mayExchangeNow(net.id, member.instanceId, spaceId)) {
      const reason = spaceHold(getConfig(), spaceId, member.instanceId, net.id);
      if (reason) out.held.push({ spaceId, reason });
      continue;
    }
    const turn = await exchangeSpaceWithMember(liveNet, member, spaceId, toNetworkId.get(spaceId) ?? spaceId, headers, fetchOpts, batchFetchOpts, slot);
    addCounts(out.pulled, turn.pulled); addCounts(out.pushed, turn.pushed);
    out.incomplete.push(...turn.incomplete); out.capped.push(...turn.capped); out.refused.push(...turn.refused); out.recorded.push(...turn.recorded);
    out.localFaults.push(...turn.localFaults); out.interrupted.push(...turn.interrupted);
    out.peerAnswered ||= turn.peerAnswered; out.storeDown ||= turn.storeDown;
    if (turn.held) out.held.push({ spaceId, reason: turn.held });
    // A hold that is ONE family's (the edges family while an edge identity index is rebuilt) is listed with the family's name, beside the other held spaces.
    if (turn.heldFamilies.length > 0) out.held.push({ spaceId, reason: `${turn.heldFamilies.join(', ')} held: ${FAMILY_HELD_REASON}`, families: turn.heldFamilies });
    if (turn.declined) {
      out.declined.push(spaceId);
      recordDecline(net.id, member.instanceId, toNetworkId.get(spaceId) ?? spaceId);
    }
  }
  return out;
}

type Turn = Omit<MemberExchange, 'held' | 'declined'> & { held?: string; declined?: boolean; heldFamilies: string[] };

/**
 * A throw that reached the turn: a hold, shutdown or THIS instance's store failing is written into `out` (true), anything else is the member's failure
 * and is rethrown by the caller (false). The store's own failure is `isStoreSide`, the predicate the doors answer 503 by (bundle-39 D1 v2 (ii)): a
 * Mongo stepdown during the positions read or a push's read is this instance's, never PEER UNREACHABLE.
 */
function turnThrowIsOurs(err: unknown, out: Turn, spaceId: string, direction: string): boolean {
  if (stopKindOfThrow(err) === 'closing') { out.interrupted.push(spaceId); return true; }
  if (!isStoreSide(err)) return false;
  out.localFaults.push(`space '${spaceId}' ${direction}: ${arrivalStopReason(err, spaceId)}`);
  if (storeIsNotAnswering(err)) out.storeDown = true;
  log.warn(`Sync turn for space '${peerText(spaceId)}': ${arrivalStopReason(err, spaceId)} — this instance's database, not the peer.`);
  return true;
}

/** One space's turn with one member: meta, records, file rows, files and merkle, in the fence, stopped by an act or a refusal. */
async function exchangeSpaceWithMember(
  net: NetworkConfig, member: NetworkMember, spaceId: string, remoteSpaceId: string,
  headers: Record<string, string>, fetchOpts: () => RequestInit, batchFetchOpts: () => RequestInit, slot: RereadSlot,
): Promise<Turn> {
  const { held: _held, declined: _declined, ...empty } = emptyExchange();
  const out: Turn = { ...empty, heldFamilies: [] };
  // Skip spaces that don't exist in local config — prevents orphan data and collection access for space ids that were
  // registered on the network but never created locally.
  if (!configuredSpaces().some(s => s.id === spaceId)) {
    log.warn(`Skipping sync for space '${peerText(spaceId)}' in network '${peerText(net.label)}': space not in local config`);
    return out;
  }
  const transfer = enterSpaceTransfer(spaceId, member.instanceId, net.id);
  if (!transfer) return { ...out, held: spaceHold(getConfig(), spaceId, member.instanceId, net.id) ?? 'act owed here' };
  const turn = new SpaceTurn(transfer);
  let building = false;
  // Push to this member if the direction allows it (push or both); pull if bidirectional, or for non-directional networks.
  // Braintree/pubsub with direction='push': parent/publisher pushes down, child/subscriber never pushes up.
  const { shouldPull, shouldPush } = exchangeDirections(net, member);
  // A full re-read this turn takes part in (begins, or continues): finished when every leg this turn runs reached the end, with no cycle cap and no early stop.
  let reread: 'begin' | 'continue' | undefined;
  let pullEnded = !shouldPull;
  let pushEnded = !shouldPush;
  let leg = 'receive';
  try {
    // A space that owes its positions is not exchanged (design rev 8 §3): the turn is HELD for the cycle and counts no failure. Asked here so no
    // transfer starts on rows that are not paged yet; the readers and the writers ask it again inside, for a space that began to owe meanwhile.
    await assertPositionsReady(spaceId);
    reread = slot.phaseOf(spaceId);
    if (reread === 'begin') {
      if (beginFullReread(net.id, member.instanceId, spaceId)) slot.begun(); else reread = undefined;
    }
    if (shouldPull) {
      await pullSpaceMetaFromUpstream(net, member, spaceId, remoteSpaceId, fetchOpts, turn); // F-39.1: only from upstream, never throws
      if (turn.mayContinue()) {
        const pc = await pullFromPeer(member, spaceId, remoteSpaceId, net.id, fetchOpts, batchFetchOpts, turn);
        addCounts(out.pulled, pc.counts);
        if (pc.recorded.records > 0) out.recorded.push({ spaceId, ...pc.recorded });
        legOutcome(out, spaceId, 'receive', pc, 'read up to the cycle\'s cap and continue next cycle');
        // A held family is a family not fetched, and a page that did not land here was not stored: a full re-read that ended here would never read
        // either again (S6, bundle-39 D1 v2).
        pullEnded = legEnded(pc) && turn.mayContinue();
      }
      // A drifted file row is behind the watermark the ordinary pull starts from; a merkle divergence owes it a re-read.
      if (turn.mayContinue() && !isShuttingDown()) await rereadFileMeta({ member, spaceId, remoteSpaceId, networkId: net.id, requestInit: batchFetchOpts, turn });
    }
    leg = 'push';
    if (shouldPush && turn.mayContinue()) {
      const pc = await pushToPeer(member, spaceId, remoteSpaceId, net.id, fetchOpts, batchFetchOpts, turn);
      addCounts(out.pushed, pc.counts);
      legOutcome(out, spaceId, 'push', pc, 'sent up to the cycle\'s bound and continue next cycle');
      if (pc.refused.length > 0) out.refused.push(`space '${spaceId}' push: ${pc.refused.join(', ')}`);
      pushEnded = legEnded(pc) && turn.mayContinue();
    }
    leg = 'files';
    // File manifest, tombstones and bytes — the same direction guards as above. A pulled file is processed where it is recorded. Not begun once shutdown has.
    if ((shouldPull || shouldPush) && turn.mayContinue() && !isShuttingDown()) {
      const fc = await syncFiles(member, spaceId, remoteSpaceId, net.id, headers, fetchOpts, shouldPull, shouldPush, turn);
      out.pulled.files += fc.pulledFiles; out.pushed.files += fc.pushedFiles;
    }
    // Merkle integrity check (opt-in: network.merkle === true); its verdict arms or clears the file-row re-read.
    if (net.merkle && turn.mayContinue() && !isShuttingDown()) {
      const verdict = await checkMerkleWithPeer(net, member, spaceId, remoteSpaceId, fetchOpts, turn);
      if (turn.mayContinue()) recordFileMetaMerkleComparison(member, spaceId, verdict);
    }
  } catch (err) {
    // A space that owes its positions: held, not this member's failure, and nothing was moved past it.
    if (err instanceof PositionsBuilding) building = true;
    // A unit cut by the act's signal, or a refusal the peer answered, ends the turn: that is a hold, not this member's failure. Shutdown and this
    // instance's own store are not the member's failure either (bundle-39 D1 v2, D5).
    else if (turn.mayContinue() && !turnThrowIsOurs(err, out, spaceId, leg)) throw err;
  } finally {
    transfer.release();
  }
  if (out.pulled.files + out.pushed.files > 0 || Object.values(out.pulled).some(n => n > 0) || Object.values(out.pushed).some(n => n > 0)) out.peerAnswered = true;
  if (reread !== undefined && !building && turn.refusal === null && !turn.cut && pullEnded && pushEnded && out.localFaults.length === 0) endFullReread(net.id, member.instanceId, spaceId);
  if (building) return { ...out, incomplete: [], capped: [], heldFamilies: [], held: POSITIONS_BUILDING_REASON };
  if (turn.refusal === 'declined') return { ...out, incomplete: [], capped: [], heldFamilies: [], declined: true };
  if (turn.refusal === 'held') return { ...out, incomplete: [], capped: [], heldFamilies: [], held: HELD_BY_THE_MEMBER };
  if (turn.cut) return { ...out, incomplete: [], capped: [], heldFamilies: [], held: 'act owed here' };
  return out;
}

/** What one leg (pull or push) of a turn reports beside its counts: each stop kind into its own list of the turn (bundle-39 D1, D5). */
type LegStops = { stoppedEarly: string[]; capped: string[]; held: string[]; local: string[]; closing: string[]; storeDown?: boolean };

/** File one leg's stops into the turn: errors into `incomplete`, caps into `capped`, pages this instance could not land into `localFaults`, shutdown into `interrupted`. */
function legOutcome(out: Turn, spaceId: string, leg: 'receive' | 'push', pc: LegStops, cappedWhy: string): void {
  if (pc.stoppedEarly.length > 0) out.incomplete.push(`space '${spaceId}' ${leg}: ${pc.stoppedEarly.join(', ')}`);
  if (pc.capped.length > 0) out.capped.push(`space '${spaceId}' ${leg}: ${pc.capped.join(', ')} ${cappedWhy}`);
  if (pc.local.length > 0) {
    out.localFaults.push(`space '${spaceId}' ${leg}: this instance could not land ${pc.local.join(', ')}; fetched again next cycle`);
    if (pc.storeDown) out.storeDown = true;
    out.peerAnswered = true;   // a page that failed to LAND was delivered: the peer answered
  }
  if (pc.closing.length > 0 && !out.interrupted.includes(spaceId)) out.interrupted.push(spaceId);
  for (const label of pc.held) if (!out.heldFamilies.includes(label)) out.heldFamilies.push(label);
}

/** A leg ran to the end: no stop of any kind. */
const legEnded = (pc: LegStops): boolean => [pc.stoppedEarly, pc.capped, pc.held, pc.local, pc.closing].every(l => l.length === 0);

// ── Pull (ingest from peer) ─────────────────────────────────────────────────

/** What one pull moved, and what it did not: the errors are a failed member, the capped are a pull that is still catching up. */
type PullCounts = LegStops & { counts: SyncCounts; recorded: RecordedSummary };

/**
 * The receive mark of `member` for `spaceId` on `networkId`, forgotten because the peer's positions went backwards (`head` below the mark): the pull
 * re-reads from 0 and sorts by id and version (D-48). Said once per cycle, counted, and written on this network's row only — the mark is per network.
 */
function forgetBehindMark(networkId: string, member: NetworkMember, spaceId: string, behind: { peerHead: number; startedFrom: number }): void {
  syncPositionBehindTotal.inc({ network: networkId });
  log.warn(`Pull from ${peerText(member.label ?? member.instanceId)} for space '${peerText(spaceId)}': the receive mark ${behind.startedFrom} is above the peer's head `
    + `${behind.peerHead} — its positions went backwards (a restore with the clock set back). The mark is forgotten and the space is read again from the start, `
    + 'skipping what is held by version.');
  // A mark write like every other: for a space nobody asked the hold about (removed, or newly held) nothing is written back.
  if (mayExchangeNow(networkId, member.instanceId, spaceId)) {
    const cfg = getConfig();
    if (setMemberSpaceMark(cfg, member.instanceId, spaceId, 'lastPosReceived', { networkId }, () => undefined)) saveConfigSoon(cfg);
  }
}

async function pullFromPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
  turn: ExchangeTurn,
): Promise<PullCounts> {
  /** Where this cycle's transfers begin and where the mark stands: the mark, until a peer whose positions went backwards says otherwise. */
  let from = readMemberSpaceMark(networkId, member.instanceId, spaceId, 'lastPosReceived') ?? 0;
  const forgetIfBehind = (behind: { peerHead: number; startedFrom: number } | undefined): void => {
    if (!behind || from === 0) return;
    forgetBehindMark(networkId, member, spaceId, behind);
    from = 0;
  };

  // Tombstones first, so deletions apply before anything that would re-upsert a deleted doc. They are a transfer of the same stream as the
  // families, under the same mark, and both directions live in `sync/tombstone-transfer.ts`; its own doc block says why they belong together.
  const tombstones = await pullSpaceTombstones({ member, spaceId, remoteSpaceId, networkId, since: from, requestInit: opts, turn });
  forgetIfBehind(tombstones.behind);

  /*
   * What lands in this space's transfer is checked for strict linkage ONCE, after every family (below) — page by
   * page, an edge to a chrono entry pulled later in the same cycle was recorded missing (bundle-30 I8).
   */
  const linkage = new LinkageCheck(spaceId, member.instanceId);

  /*
   * SEQUENTIAL, not `Promise.all`. Each transfer pages against the same peer and applies as it goes, so running them
   * together multiplies the concurrent load on the side of the cycle that is already slow, and interleaves the writes a
   * truncated transfer's mark has to reason about.
   *
   * EVERY BRAIN COLLECTION: `files` as the `filemeta` family (its metadata; the bytes arrive as blob plus manifest in
   * `syncFiles`), and `links` — a collection missing here is one a peer never sends us, and nothing reports that.
   */
  const pulled = {} as Record<PayloadKey, PullResult>;
  try {
    for (const family of REPLICATED_FAMILIES) {
      if (!turn.mayContinue()) break;
      pulled[family.payloadKey] = await pullFamily({ family, member, spaceId, remoteSpaceId, networkId, since: from, requestInit: batchOpts, linkage, turn });
      forgetIfBehind(pulled[family.payloadKey].behind);
      if (pulled[family.payloadKey].refused > 0) syncItemsPulledTotal.inc({ type: family.countKey, outcome: 'refused' }, pulled[family.payloadKey].refused);
    }
  } finally {
    /*
     * What landed is checked even when a fetch REJECTS part-way (bundle-30 I13): edges that landed before it are
     * re-served next cycle at an equal seq and plan as skipped, so they are never checked again. A family whose
     * transfer stopped early, or never ran, may still hold a target: its ends are not judged missing this cycle.
     */
    await linkage.run({ stillToCome: REPLICATED_FAMILIES
      .filter(f => pulled[f.payloadKey] === undefined || pulled[f.payloadKey].truncated).map(f => f.collection) });
  }
  const recorded = REPLICATED_FAMILIES.reduce((sum, f) => mergeSummaries(sum, pulled[f.payloadKey]?.recorded), NOTHING_RECORDED);
  const counts = countsOf(pulled, r => r.count);
  // A turn the act or the peer stopped moves no mark: the families it did not finish place the ceiling, and the turn is held.
  if (!turn.mayContinue()) return { counts, recorded, stoppedEarly: ['stopped by a hold'], capped: [], held: [], local: [], closing: [] };

  /*
   * ONE MARK, SEVEN TRANSFERS — the tombstones and the six families, in one stream. `resolveWatermark` takes the MINIMUM of what every transfer is
   * complete through, so a write that landed on the peer between two families' reads is above the mark; EVERY transfer is passed, since an omitted
   * one places no ceiling, and a cycle that moved only tombstones moves the mark (Q-394).
   * No counter bump here: an arrival moves no counter (D-19 B), and every record this pull received took its position as it landed.
   */
  const resolution = resolveWatermark({
    direction: 'receive', peerLabel: member.label ?? member.instanceId, spaceId,
    from,
    transfers: { tombstones, ...pulled },
    warn: log.warn,
  });
  const stoppedEarly = resolution.errored.map(label => `${label} stopped early`);

  // Persist the mark — unless the space was removed or newly held since its exchange began. The peer's position is the peer's own: it is
  // not capped by this instance's (only a mark of OUR stream is, `ownPositionMark`).
  if (resolution.at > from && turn.mayContinue() && mayExchangeNow(networkId, member.instanceId, spaceId)) {
    const freshCfg = getConfig();
    // This network's row only: the mark is how far THIS exchange read (decision 12).
    // Hot-path mark: coalesced async write — lost on crash, the next pull re-pulls from the older mark (idempotent by version).
    if (setMemberSpaceMark(freshCfg, member.instanceId, spaceId, 'lastPosReceived', { networkId }, current => (current !== undefined && current >= resolution.at ? null : resolution.at))) {
      saveConfigSoon(freshCfg);
    }
  }
  return { counts, recorded, stoppedEarly, capped: resolution.capped, held: resolution.held, local: resolution.local, closing: resolution.closing, storeDown: resolution.storeDown };
}

// ── Push (upload our changes to peer) ──────────────────────────────────────

/** What one push moved, and what it did not: `stoppedEarly` are faults, `capped` a push that is still catching up, `refused` what the peer discarded. */
type PushCounts = LegStops & { counts: SyncCounts; refused: string[] };

async function pushToPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
  turn: ExchangeTurn,
): Promise<PushCounts> {
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const from = readMemberSpaceMark(networkId, member.instanceId, spaceId, 'lastPosPushed') ?? 0;
  // What this network's push offers is its type's (`sync/push-selection.ts`): the transfers ask for it themselves.
  const net = freshNet ?? { type: 'closed' as const };

  // Tombstones first — paged, with no hard cap, since one would silently drop deletions after a long absence.
  const tombstones = await pushTombstones({ member, spaceId, remoteSpaceId, networkId, since: from, net, requestInit: opts, turn });

  // Only rows changed since the last push, read and sent in batches straight from MongoDB (`sync/push-family.ts`).
  // Sequential for the same reason as the pull; EVERY brain collection, `files` as the `filemeta` family and `links` included.
  // A family that stopped early travels on in the same cycle with the references after it, which still go (the push mark is ONE number, so a reference
  // held back would place no ceiling): each request says which target families stopped earlier, so the receiver does not judge them missing (bundle-39 D4).
  const pushed = {} as Record<PayloadKey, { pushed: number; refused: number } & TransferOutcome>;
  for (const family of REPLICATED_FAMILIES) {
    if (!turn.mayContinue()) break;
    pushed[family.payloadKey] = await pushFamily({
      family, member, spaceId, remoteSpaceId, networkId, since: from, net, requestInit: batchOpts, turn, incomplete: familiesNotComplete(pushed),
    });
  }
  const counts = countsOf(pushed, r => r.pushed);
  if (!turn.mayContinue()) return { counts, stoppedEarly: ['stopped by a hold'], capped: [], held: [], refused: [], local: [], closing: [] };

  // Same rule as the pull, same function and the same list: the mark is derived from the transfers (`sync/watermark.ts`), tombstones among them.
  const resolution = resolveWatermark({
    direction: 'push', peerLabel: member.label ?? member.instanceId, spaceId,
    from,
    transfers: { tombstones, ...pushed },
    warn: log.warn,
  });
  const refused = refusedTransfers(pushed); // Q-59: the peer answered, so this is not a failure — see runSyncForNetwork

  // What the cycle DECIDED beside what it found (X-20): a mark that moves while every transfer reported zero is the stall's shape.
  log.debug(`Push cycle to ${peerText(member.label ?? member.instanceId)} space '${peerText(spaceId)}': mark ${from} -> `
    + `${resolution.at}, pushed ${peerList(REPLICATED_FAMILIES.map(f => `${counts[f.countKey]} ${f.countKey}`), ', ')}`);

  // Persist the push mark, cut at this instance's own settled cap (`ownPositionMark`: it seeds the clock after a restart that lost the stored maximum,
  // so it can only ever be as high as a position this instance handed out) — unless the space was removed or newly held since its exchange began.
  if (resolution.at > from && turn.mayContinue()) {
    const own = await ownPositionMark(spaceId, resolution.at);
    if (own !== null && own > from && turn.mayContinue() && mayExchangeNow(networkId, member.instanceId, spaceId)) {
      const freshCfg = getConfig();
      // This network's row only (decision 12): a club push moving the same peer's braintree mark would never push the relayed rows there.
      // Hot-path mark: coalesced async write — lost on crash, the next push re-pushes from the older mark (idempotent by version).
      if (setMemberSpaceMark(freshCfg, member.instanceId, spaceId, 'lastPosPushed', { networkId }, current => (current !== undefined && current >= own ? null : own))) {
        saveConfigSoon(freshCfg);
      }
    }
  }
  return {
    counts, stoppedEarly: resolution.errored.map(label => `${label} stopped early`), capped: resolution.capped, held: resolution.held, refused,
    local: resolution.local, closing: resolution.closing, storeDown: resolution.storeDown,
  };
}
