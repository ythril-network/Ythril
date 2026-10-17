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
import { log, peerText } from '../util/log.js';
import { resolveWatermark, type TransferOutcome } from './watermark.js';
import { pullFamily, type PullResult } from './pull-family.js';
import { pushFamily } from './push-family.js';
import { pushTombstones } from './tombstone-transfer.js';
import { pullSpaceTombstones } from './pull-space-tombstones.js';
import { refusedTransfers } from './push-refusals.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { isDirectionalNetwork } from '../networks/network-spaces.js';
import { pullSpaceMetaFromUpstream } from './space-meta-pull.js';
import { LinkageCheck } from './linkage-check.js';
import { syncFiles } from './file-sync.js';
import { checkMerkleWithPeer } from './merkle-check.js';
import { recordFileMetaMerkleComparison, rereadFileMeta } from './file-meta-reread.js';
import { readMemberSpaceMark } from './member-space-mark.js';
import { REPLICATED_FAMILIES, type PayloadKey } from './replicated-families.js';
import { reverseSpaceMap, localToRemote } from './space-map.js';
import { exchangeVerdicts, mayExchangeNow, enterSpaceTransfer, spaceHold } from './space-exchange-set.js';
import type { ExchangeTurn, TransferVerdict } from './held-answer.js';
import type { SpaceTransfer } from './space-transfer-fence.js';

const zero = (): SyncCounts => ({ facts: 0, entities: 0, edges: 0, files: 0, chrono: 0, links: 0 });

/** Why a space was not exchanged with a member this cycle: the hold's reason, or the member's own refusal. */
export type HeldSpace = { spaceId: string; reason: string };

/** What one member's exchange of a network's spaces moved, and what it did not move and why. */
export interface MemberExchange {
  pulled: SyncCounts;
  pushed: SyncCounts;
  incomplete: string[];
  refused: string[];
  recorded: SyncSchemaRecording[];
  held: HeldSpace[];
  /** Local ids of the spaces the member declined (pub/sub, X10). */
  declined: string[];
}

/** The reason a turn the PEER held is listed under. */
const HELD_BY_THE_MEMBER = 'held by the member';

/** One turn: the fence's transfer, plus the first hold or decline a peer answered during it. */
class SpaceTurn implements ExchangeTurn {
  refusal: 'held' | 'declined' | null = null;
  constructor(private readonly transfer: SpaceTransfer) {}
  get signal(): AbortSignal { return this.transfer.signal; }
  mayContinue(): boolean { return this.refusal === null && this.transfer.mayContinue(); }
  refusedBy(verdict: TransferVerdict): void { if (verdict !== 'failed' && this.refusal === null) this.refusal = verdict; }
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
 * Exchange every space of `net` the hold lets through with `member`. The governance pass has run; `net` is the network as read
 * at the start of the cycle, and the spaces are read from the LIVE config here.
 */
export async function exchangeSpacesWithMember(
  net: NetworkConfig, member: NetworkMember, headers: Record<string, string>, fetchOpts: () => RequestInit, batchFetchOpts: () => RequestInit,
): Promise<MemberExchange> {
  const out: MemberExchange = { pulled: zero(), pushed: zero(), incomplete: [], refused: [], recorded: [], held: [], declined: [] };
  const liveNet = getConfig().networks.find(n => n.id === net.id) ?? net;
  const { exchange, held: heldNow, declined: declinedNow } = exchangeVerdicts(liveNet, member);
  out.held.push(...heldNow);
  out.declined.push(...declinedNow);
  const isDirectional = isDirectionalNetwork(liveNet);
  const shouldPull = !isDirectional || member.direction === 'both' || member.direction === 'pull';
  // A held space's schema still travels: a wipe changes no schema, and a subscriber takes its types from its upstream (X17).
  if (shouldPull) for (const h of heldNow) await pullSpaceMetaFromUpstream(liveNet, member, h.spaceId, localToRemote(liveNet, h.spaceId), fetchOpts);
  // FIRST match, as `localToRemote` answers (Q-133): a later key for the same space is an inbound alias a rename left behind.
  const toNetworkId = reverseSpaceMap(liveNet);
  for (const spaceId of exchange) {
    if (!mayExchangeNow(net.id, member.instanceId, spaceId)) {
      const reason = spaceHold(getConfig(), spaceId, member.instanceId, net.id);
      if (reason) out.held.push({ spaceId, reason });
      continue;
    }
    const turn = await exchangeSpaceWithMember(liveNet, member, spaceId, toNetworkId.get(spaceId) ?? spaceId, headers, fetchOpts, batchFetchOpts);
    for (const k of Object.keys(out.pulled) as (keyof SyncCounts)[]) { out.pulled[k] += turn.pulled[k]; out.pushed[k] += turn.pushed[k]; }
    out.incomplete.push(...turn.incomplete); out.refused.push(...turn.refused); out.recorded.push(...turn.recorded);
    if (turn.held) out.held.push({ spaceId, reason: turn.held });
    if (turn.declined) {
      out.declined.push(spaceId);
      recordDecline(net.id, member.instanceId, toNetworkId.get(spaceId) ?? spaceId);
    }
  }
  return out;
}

type Turn = Omit<MemberExchange, 'held' | 'declined'> & { held?: string; declined?: boolean };

/** One space's turn with one member: meta, records, file rows, files and merkle, in the fence, stopped by an act or a refusal. */
async function exchangeSpaceWithMember(
  net: NetworkConfig, member: NetworkMember, spaceId: string, remoteSpaceId: string,
  headers: Record<string, string>, fetchOpts: () => RequestInit, batchFetchOpts: () => RequestInit,
): Promise<Turn> {
  const out: Turn = { pulled: zero(), pushed: zero(), incomplete: [], refused: [], recorded: [] };
  // Skip spaces that don't exist in local config — prevents orphan data and collection access for space ids that were
  // registered on the network but never created locally.
  if (!concreteSpaces().some(s => s.id === spaceId)) {
    log.warn(`Skipping sync for space '${peerText(spaceId)}' in network '${peerText(net.label)}': space not in local config`);
    return out;
  }
  const transfer = enterSpaceTransfer(spaceId, member.instanceId, net.id);
  if (!transfer) return { ...out, held: spaceHold(getConfig(), spaceId, member.instanceId, net.id) ?? 'act owed here' };
  const turn = new SpaceTurn(transfer);
  // Push to this member if the direction allows it (push or both); pull if bidirectional, or for non-directional networks.
  // Braintree/pubsub with direction='push': parent/publisher pushes down, child/subscriber never pushes up.
  const isDirectional = isDirectionalNetwork(net);
  const shouldPull = !isDirectional || member.direction === 'both' || member.direction === 'pull';
  const shouldPush = !isDirectional || member.direction === 'both' || member.direction === 'push';
  try {
    if (shouldPull) {
      await pullSpaceMetaFromUpstream(net, member, spaceId, remoteSpaceId, fetchOpts, turn); // F-39.1: only from upstream, never throws
      if (turn.mayContinue()) {
        const pc = await pullFromPeer(member, spaceId, remoteSpaceId, net.id, fetchOpts, batchFetchOpts, turn);
        out.pulled.facts += pc.facts; out.pulled.entities += pc.entities; out.pulled.edges += pc.edges; out.pulled.chrono += pc.chrono; out.pulled.links += pc.links;
        if (pc.recorded.records > 0) out.recorded.push({ spaceId, ...pc.recorded });
        if (pc.stoppedEarly.length > 0) out.incomplete.push(`space '${spaceId}' receive: ${pc.stoppedEarly.join(', ')} stopped early`);
      }
      // A drifted file row is behind the watermark the ordinary pull starts from; a merkle divergence owes it a re-read.
      if (turn.mayContinue()) await rereadFileMeta({ member, spaceId, remoteSpaceId, networkId: net.id, requestInit: batchFetchOpts, turn });
    }
    if (shouldPush && turn.mayContinue()) {
      const pc = await pushToPeer(member, spaceId, remoteSpaceId, net.id, fetchOpts, batchFetchOpts, turn);
      out.pushed.facts += pc.facts; out.pushed.entities += pc.entities; out.pushed.edges += pc.edges; out.pushed.chrono += pc.chrono; out.pushed.links += pc.links;
      if (pc.stoppedEarly.length > 0) out.incomplete.push(`space '${spaceId}' push: ${pc.stoppedEarly.join(', ')} stopped early`);
      if (pc.refused.length > 0) out.refused.push(`space '${spaceId}' push: ${pc.refused.join(', ')}`);
    }
    // File manifest, tombstones and bytes — the same direction guards as above. A pulled file is processed where it is recorded.
    if ((shouldPull || shouldPush) && turn.mayContinue()) {
      const fc = await syncFiles(member, spaceId, remoteSpaceId, net.id, headers, fetchOpts, shouldPull, shouldPush, turn);
      out.pulled.files += fc.pulledFiles; out.pushed.files += fc.pushedFiles;
    }
    // Merkle integrity check (opt-in: network.merkle === true); its verdict arms or clears the file-row re-read.
    if (net.merkle && turn.mayContinue()) {
      const verdict = await checkMerkleWithPeer(net, member, spaceId, remoteSpaceId, fetchOpts, turn);
      if (turn.mayContinue()) recordFileMetaMerkleComparison(member, spaceId, verdict);
    }
  } catch (err) {
    // A unit cut by the act's signal, or a refusal the peer answered, ends the turn: that is a hold, not this member's failure.
    if (turn.mayContinue()) throw err;
  } finally {
    transfer.release();
  }
  if (turn.refusal === 'declined') return { ...out, incomplete: [], declined: true };
  if (turn.refusal === 'held') return { ...out, incomplete: [], held: HELD_BY_THE_MEMBER };
  if (turn.cut) return { ...out, incomplete: [], held: 'act owed here' };
  return out;
}

// ── Pull (ingest from peer) ─────────────────────────────────────────────────

async function pullFromPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
  turn: ExchangeTurn,
): Promise<{ facts: number; entities: number; edges: number; chrono: number; links: number; stoppedEarly: string[]; recorded: RecordedSummary }> {
  const sinceSeq = readMemberSpaceMark(networkId, member.instanceId, spaceId, 'lastSeqReceived') ?? 0;

  // Tombstones first, so deletions apply before anything that would re-upsert a deleted doc. Both directions
  // live in `sync/tombstone-transfer.ts`; its own doc block says why they belong together.
  const tombstones = await pullSpaceTombstones({ member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit: opts, turn });

  /*
   * What lands in this space's transfer is checked for strict linkage ONCE, after every family (below) — page by
   * page, an edge to a chrono entry pulled later in the same cycle was recorded missing (bundle-30 I8).
   */
  const linkage = new LinkageCheck(spaceId, member.instanceId);

  /*
   * SEQUENTIAL, not `Promise.all`. Each transfer pages against the same peer and applies as it goes, so running them
   * together multiplies the concurrent load on the side of the cycle that is already slow, and interleaves the writes a
   * truncated transfer's watermark has to reason about.
   *
   * EVERY BRAIN COLLECTION: `files` as the `filemeta` family (its metadata; the bytes arrive as blob plus manifest in
   * `syncFiles`), and `links` — a collection missing here is one a peer never sends us, and nothing reports that.
   */
  const pulled = {} as Record<PayloadKey, PullResult>;
  try {
    for (const family of REPLICATED_FAMILIES) {
      if (!turn.mayContinue()) break;
      pulled[family.payloadKey] = await pullFamily({ family, member, spaceId, remoteSpaceId, networkId, sinceSeq, requestInit: batchOpts, linkage, turn });
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
  const countOf = (k: PayloadKey): number => pulled[k]?.count ?? 0;
  const recorded = REPLICATED_FAMILIES.reduce((sum, f) => mergeSummaries(sum, pulled[f.payloadKey]?.recorded), NOTHING_RECORDED);
  const counts = { facts: countOf('facts'), entities: countOf('entities'), edges: countOf('edges'), chrono: countOf('chrono'), links: countOf('links'), recorded };
  // A turn the act or the peer stopped moves no watermark: the families it did not finish place the ceiling, and the turn is held.
  if (!turn.mayContinue()) return { ...counts, stoppedEarly: ['stopped by a hold'] };

  /*
   * ONE WATERMARK, FIVE TRANSFERS — so the max is only safe if all five finished. `resolveWatermark` lowers the ceiling to
   * whatever the stopped transfers can actually vouch for; EVERY transfer is passed, since an omitted one places no ceiling.
   * No counter bump here: every record this pull received was bumped over by the page accept, per page.
   */
  const stoppedEarly: string[] = [];
  const highestSeq = resolveWatermark({
    heldBack: stoppedEarly, direction: 'receive', peerLabel: member.label ?? member.instanceId, spaceId,
    from: sinceSeq,
    transfers: pulled,
    // Bounds the advance, never raises it: a tombstone seq is not a position in the data stream.
    alsoCheck: { tombstones },
    seqOf: (t) => t.highSeq,
    warn: log.warn,
  });

  // Persist the high-water mark — unless the space was removed or newly held since its exchange began.
  if (highestSeq > sinceSeq && turn.mayContinue() && mayExchangeNow(networkId, member.instanceId, spaceId)) {
    const freshCfg = getConfig();
    const m = freshCfg.networks.find(n => n.id === networkId)?.members.find(x => x.instanceId === member.instanceId);
    if (m) {
      m.lastSeqReceived ??= {};
      m.lastSeqReceived[spaceId] = highestSeq;
      // Hot-path watermark: coalesced async write — lost on crash, the next pull re-pulls from the older mark (idempotent by seq).
      saveConfigSoon(freshCfg);
    }
  }
  return { ...counts, stoppedEarly };
}

// ── Push (upload our changes to peer) ──────────────────────────────────────

async function pushToPeer(
  member: NetworkMember,
  spaceId: string,
  remoteSpaceId: string,
  networkId: string,
  opts: () => RequestInit,
  batchOpts: () => RequestInit,
  turn: ExchangeTurn,
): Promise<{ facts: number; entities: number; edges: number; chrono: number; links: number; stoppedEarly: string[]; refused: string[] }> {
  const cfg = getConfig();
  const freshNet = cfg.networks.find(n => n.id === networkId);
  const lastSeqPushed = readMemberSpaceMark(networkId, member.instanceId, spaceId, 'lastSeqPushed') ?? 0;

  // Tombstones first — paged, with no hard cap, since one would silently drop deletions after a long absence.
  const tombstones = await pushTombstones({ member, spaceId, remoteSpaceId, networkId, lastSeqPushed, requestInit: opts, turn });

  // Only docs changed since the last push, read and sent in batches straight from MongoDB (`sync/push-family.ts`). Braintree
  // nodes relay docs from all peers; other topologies push only their own authored docs, so foreign docs do not pollute
  // peers' watermarks.
  const ownedFilter = isDirectionalNetwork(freshNet) ? {} : { 'author.instanceId': cfg.instanceId };

  // Sequential for the same reason as the pull; EVERY brain collection, `files` as the `filemeta` family and `links` included.
  const pushed = {} as Record<PayloadKey, { pushed: number; maxSeq: number; refused: number } & TransferOutcome>;
  for (const family of REPLICATED_FAMILIES) {
    if (!turn.mayContinue()) break;
    pushed[family.payloadKey] = await pushFamily({
      family, member, spaceId, remoteSpaceId, networkId, lastSeqPushed, owned: ownedFilter, instanceId: cfg.instanceId, requestInit: batchOpts, turn,
    });
  }
  const countOf = (k: PayloadKey): number => pushed[k]?.pushed ?? 0;
  const counts = { facts: countOf('facts'), entities: countOf('entities'), edges: countOf('edges'), chrono: countOf('chrono'), links: countOf('links') };
  if (!turn.mayContinue()) return { ...counts, stoppedEarly: ['stopped by a hold'], refused: [] };

  // Same rule as the pull, same function and the same list: the candidate is derived from the transfers (`sync/watermark.ts`).
  const stoppedEarly: string[] = [];
  const maxSeqPushed = resolveWatermark({
    heldBack: stoppedEarly, direction: 'push', peerLabel: member.label ?? member.instanceId, spaceId,
    from: lastSeqPushed,
    transfers: pushed,
    alsoCheck: { tombstones },
    seqOf: (t) => t.maxSeq,
    warn: log.warn,
  });
  const refused = refusedTransfers(pushed); // Q-59: the peer answered, so this is not a failure — see runSyncForNetwork

  // What the cycle DECIDED beside what it found (X-20): a mark that moves while every transfer reported zero is the stall's shape.
  log.debug(`Push cycle to ${peerText(member.label ?? member.instanceId)} space '${peerText(spaceId)}': watermark ${lastSeqPushed} -> `
    + `${maxSeqPushed}, pushed ${counts.facts}m/${counts.entities}e/${counts.edges}g/${counts.chrono}c/${counts.links}l`);

  // Persist the push high-water mark — unless the space was removed or newly held since its exchange began.
  if (maxSeqPushed > lastSeqPushed && turn.mayContinue() && mayExchangeNow(networkId, member.instanceId, spaceId)) {
    const freshCfg = getConfig();
    const m = freshCfg.networks.find(n => n.id === networkId)?.members.find(x => x.instanceId === member.instanceId);
    if (m) {
      m.lastSeqPushed ??= {};
      m.lastSeqPushed[spaceId] = maxSeqPushed;
      // Hot-path watermark: coalesced async write — lost on crash, the next push re-pushes from the older mark (idempotent by seq).
      saveConfigSoon(freshCfg);
    }
  }
  return { ...counts, stoppedEarly, refused };
}

