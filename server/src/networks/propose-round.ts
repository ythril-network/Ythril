/**
 * This instance proposes a round on a network — what did proposing it decide here? The ONE open path (bundle-106, design v5 §1.1-§1.3,
 * R1, D-36), and the two questions every space-act door asks before it opens one.
 *
 * ## What it prevents
 *
 * A round opened with a quorum already in it that nobody evaluated (Q-453): nine sites built a round, eleven stored one, some cast the
 * proposer's yes, and two of them — the deletion and the wipe — never evaluated it, so on a network where the proposer's yes decides
 * (a club, a pub/sub, a network where this instance is the only member) the round stayed open until its deadline and expired. And a
 * round evaluated at open whose result each opener applied by its own hand: a space added without its alias, a join admitted without its
 * introductions. `proposeRound` completes, stores, signs, settles and tells — each opener builds only what its round is ABOUT.
 * `every-round-is-opened-and-settled-by-one-function` holds that nothing else calls `openRoundHere`.
 *
 * ## The proposer's yes is part of proposing (D-36 = C)
 *
 * Always cast, for every round type, signed: owner, 2026-09-25 (*"of course a proposer votes yes … set it automatically"*) and
 * 2026-10-15 (*"the proposer counts as a yes on every join and every removal"*). A parameter every caller passed the same value was a
 * flag nobody could read a difference from. A braintree removal's yes from a node outside the ancestor set decides nothing — the pass
 * rule counts only the ancestors — so it is cast for one rule, not behind a branch.
 */
import { v4 as uuidv4 } from 'uuid';
import type { Config, NetworkConfig, VoteRound } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { makeSignedOwnCast } from '../util/signing.js';
import { localToRemote, networkSpaceKey, remoteToLocal } from '../sync/space-map.js';
import { queueGeneratedNote } from '../sync/change-notes.js';
import { canonicalWipeTypes, spaceActOfRound, type SpaceRoundSettled } from '../spaces/space-act-runner.js';
import type { SpaceActEntry } from '../config/types.js';
import { openRoundHere } from './round-local-state.js';
import { roundIsOpen, spaceActOwed } from './round-state.js';
import { settleRounds, type SettledSpaceRound } from './round-conclusion.js';
import { notifyMembersToPull, type RoundNoticeSnapshot } from './notify-members.js';
import { networkRole } from './network-role.js';
import { roundAnswer, roundDecided, type RoundAnswer, type RoundDecided } from './vote-acts.js';

/** What an opener hands over: only what the round is ABOUT. The open path completes the id, the dates and the votes. */
export type RoundProposal = Omit<VoteRound, 'roundId' | 'openedAt' | 'deadline' | 'votes'>;

/** What proposing a round decided here. Not saved — the caller saves (several openers open one round per network and save once). */
export interface Proposed {
  round: VoteRound;
  decided: RoundDecided;
  /** The round as every opening door answers it, computed before any act ran (a deletion's space still resolves). */
  answer: RoundAnswer;
  /** The acts the settle started; awaited by a door after its save. Never rejects. */
  settled: Promise<SettledSpaceRound[]>;
  /** The act entries the door awaits; it releases each when it has answered. */
  acts: string[];
  failed: { round: VoteRound; cause: unknown }[];
}

/**
 * Propose `proposal` on `net` (part of `cfg`, which the caller saves), with one `now`: complete the round, store it, cast this
 * instance's signed yes, settle it through the `'proposer'` via, and tell the members to pull it — from a snapshot taken before
 * anything acted, deferred past the caller's save.
 */
export function proposeRound(net: NetworkConfig, cfg: Config, proposal: RoundProposal, opts: { now?: number } = {}): Proposed {
  const now = opts.now ?? Date.now();
  const round: VoteRound = {
    ...proposal,
    roundId: uuidv4(),
    openedAt: new Date(now).toISOString(),
    deadline: new Date(now + net.votingDeadlineHours * 3_600_000).toISOString(),
    votes: [],
  };
  // 0. Who to tell, before anything acts: a deletion takes the space out of the network, and its removal drops the label.
  // An addition and a schema change name the space by the NETWORK's id; a deletion and a wipe by this instance's own.
  const namesNetworkId = round.type === 'space_addition' || round.type === 'meta_change';
  const spaceKey = namesNetworkId ? round.spaceId : networkSpaceKey(net, round) ?? undefined;
  const localSpace = round.spaceId === undefined ? undefined : namesNetworkId ? remoteToLocal(net, round.spaceId) : round.spaceId;
  const snapshot: RoundNoticeSnapshot = {
    networkId: net.id, label: net.label, roundId: round.roundId, type: round.type,
    ...(spaceKey ? { spaceId: spaceKey } : {}),
    spaceLabel: cfg.spaces.find(s => s.id === localSpace)?.label ?? spaceKey,
    ...(round.type === 'space_wipe' && round.wipeTypes ? { types: round.wipeTypes } : {}),
    members: net.members.map(m => ({ instanceId: m.instanceId, url: m.url, label: m.label })),
  };
  // 0b. The publisher's notice of a deletion or wipe, queued while the network still carries the space (X10, INT S4): its delivery
  // reads no carried list, so it still reaches the members after the space left.
  if ((round.type === 'space_deletion' || round.type === 'space_wipe') && localSpace !== undefined && net.type === 'pubsub'
    && networkRole(net, cfg.instanceId).role === 'publisher') {
    void queueGeneratedNote(net.id, publisherNotice(cfg, net, round.type, snapshot.spaceLabel ?? localSpace), [localSpace]);
  }
  // 1-3. Store it, then sign this instance's yes over the round as stored.
  openRoundHere(net, round);
  round.votes.push(makeSignedOwnCast(net.id, round, cfg.instanceId, 'yes'));
  // 4. Settle it: the proposer's yes may already decide it.
  const out = settleRounds(net, cfg, [round], 'proposer', now);
  const decided = roundDecided(round);
  // 5. Tell the members, past the caller's save.
  void notifyMembersToPull(snapshot);
  return { round, decided, answer: roundAnswer(net, round, decided), settled: out.settled, acts: out.acts, failed: out.failed };
}

/** The change note a publisher queues for its subscribers when it deletes or wipes a space (D-40, D-41's member alternative). */
function publisherNotice(cfg: Pick<Config, 'instanceLabel'>, net: NetworkConfig, type: 'space_deletion' | 'space_wipe', label: string): string {
  return type === 'space_deletion'
    ? `${cfg.instanceLabel} deleted the space '${label}' from '${net.label}'. Your copy stays as a local space of yours; to stop receiving from this network you may leave it.`
    : `${cfg.instanceLabel} wiped the space '${label}' in '${net.label}'. Your copy was wiped too; you may leave the network.`;
}

/**
 * Does this instance act on its own on `net` — a pub/sub subscriber, whose deletion or wipe of a space is a LOCAL act (D-40): it opens
 * no round, tells the publisher nothing, and is answered as an unnetworked one. The one reading of "subscriber" the doors ask.
 */
export function actsLocallyOn(net: NetworkConfig): boolean {
  return net.type === 'pubsub' && networkRole(net).role === 'subscriber';
}

/** This instance's own round a door would repeat, and where its act stands. */
export interface RoundInProgress {
  round: VoteRound;
  /** `open`: still voting. `running`: its act is registered, waiting or running. `queued`: owed, its retry still ahead. `due`: owed, due now. */
  state: 'open' | 'running' | 'queued' | 'due';
  entry?: SpaceActEntry;
}

/**
 * Does this instance already have a round in progress for the same act — its OWN round of the same kind, network space and (a wipe) the
 * same covered types, that is open, or whose act is owed or under way (design v5 §2.2 (1), W1, X9)? A round whose act COMPLETED never
 * counts: wipe, write, wipe again is a new request. So a second click on a `202` answers the open round and opens no duplicate, and a
 * door retry of an owed act before its `retryAt` starts nothing.
 */
export function ownSpaceRoundInProgress(
  net: NetworkConfig, ask: { roundType: 'space_deletion' | 'space_wipe'; localSpaceId: string; types?: readonly string[] }, now: number,
  cfg: Config = getConfig(),
): RoundInProgress | null {
  const key = localToRemote(net, ask.localSpaceId);
  const covers = coveredKey(ask.types);
  for (const round of net.pendingRounds) {
    if (round.proposedHere !== true || round.type !== ask.roundType || networkSpaceKey(net, round) !== key) continue;
    if (ask.roundType === 'space_wipe' && coveredKey(round.wipeTypes) !== covers) continue;
    if (roundIsOpen(round, now)) return { round, state: 'open' };
    if (!spaceActOwed(round)) continue;
    const entry = spaceActOfRound(cfg, net.id, round.roundId);
    if (!entry) return { round, state: 'due' };
    if (entry.state !== 'owed') return { round, state: 'running', entry };
    const queued = entry.retryAt !== undefined && Date.parse(entry.retryAt) > now;
    return { round, state: queued ? 'queued' : 'due', entry };
  }
  return null;
}

/** A wipe's covered set as one comparable string: canonical, all of them = `*`. A list no canonicalising accepts compares as itself. */
function coveredKey(types: readonly string[] | undefined): string {
  try { return canonicalWipeTypes(types)?.join(',') ?? '*'; } catch { return [...(types ?? [])].sort().join(','); }
}

/** The SpaceRoundSettled type, re-exported for the doors that read a run's answer beside the rounds. */
export type { SpaceRoundSettled };
