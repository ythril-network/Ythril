/**
 * Emptying a space of its data is a GOVERNED act when the space belongs to a network — and since bundle-106 a wipe the proposer's own
 * yes decides acts in the request that proposed it.
 *
 * ## The ruling, and the defect it closes
 *
 * Owner, 2026-08-16: *"thats a voting thing."* Filed as X-5. `wipeSpace` deletes the documents and their tombstones and writes none, and
 * tombstones are this codebase's only way of telling a peer a record is gone — so a local wipe of a shared space was undone by the next
 * sync. A wipe every member agreed to needs no tombstone: the peers are wiping too.
 *
 * ## Why this is one module rather than a branch in each door
 *
 * REST (`POST /api/admin/spaces/:spaceId/wipe`) and the tool (`delete_space_data`, both doors) wipe. A second copy of "is this space
 * governed, open a round on every network that holds it, wait for what passed, and say what happened" is the defect this repo produces
 * most. Both doors validate their own input (the admin route keeps its copy, OQ-8) and then call {@link wipeSpaceAsRequested}; neither
 * decides anything itself.
 *
 * ## What a wipe does now (design v5 §1, §2.2, §2.9)
 *
 * - In each network holding the space a round opens through `proposeRound`, which casts this instance's yes and SETTLES it: on a club,
 *   a pub/sub this instance publishes, or a network where it is the only member, that yes passes the round and the act registers at once.
 * - A network where this instance is a pub/sub SUBSCRIBER opens no round: its wipe is local, and its copy refills from the publisher (D-40).
 * - A repeat of the same wipe while its round is open, or its act owed or running, answers that round and opens no other (W1).
 * - The door waits for what passed within its budget and answers `wiped`, `vote_pending`, `queued` or the failure — never the driver's text.
 */
import { getConfig, saveConfig } from '../config/loader.js';
import type { Config, NetworkConfig } from '../config/types.js';
import { localToRemote } from '../sync/space-map.js';
import { proposeRound, ownSpaceRoundInProgress } from '../networks/propose-round.js';
import { actsLocallyOn } from '../networks/network-role.js';
import type { RoundAnswer } from '../networks/vote-acts.js';
import type { SettledSpaceRound } from '../networks/round-conclusion.js';
import { canonicalWipeTypes, registerOwnSpaceAct, spaceActJoinedBy } from './space-act-runner.js';
import { wipeResultOf, wipeTypesOf, type WipeCollectionType, type WipeResult } from './lifecycle.js';
import { awaitDoorRounds, localAct, openedRound, repeatedRound, type DoorRound } from './door-acts.js';
import type { ActRounds } from './space-act-failure.js';

/**
 * Networks that carry this space. Exported so a caller can report "which networks" without re-deriving it — the wipe
 * vote, and the deletion authority, which asks it of a config it was handed (`cfg`) rather than the live one.
 */
export function networksHolding(spaceId: string, cfg?: Pick<Config, 'networks'>): NetworkConfig[] {
  return (cfg ?? getConfig()).networks.filter(n => n.spaces.includes(spaceId));
}

/**
 * Open (or repeat) the wipe rounds of `spaceId` — one per network that votes on it — and save. `types` is read through
 * {@link wipeTypesOf}; the round stores it only when it is a subset, so an absent `wipeTypes` keeps meaning every collection, and the
 * signature covers the canonical list. A subscriber's pub/sub network opens nothing (D-40). `[]` when no network votes on it.
 */
export function openSpaceWipeRounds(spaceId: string, types: readonly WipeCollectionType[]): DoorRound[] {
  const cfg = getConfig();
  const now = Date.now();
  const covered = wipeTypesOf(types);
  if (covered === 'refused') throw new Error(`'${String(types)}' is not a set of collections a wipe covers`);
  const stored = canonicalWipeTypes(covered);
  const voting = networksHolding(spaceId, cfg).filter(n => !actsLocallyOn(n));
  if (voting.length === 0) return [];
  const opened = voting.map((net) => {
    const prior = ownSpaceRoundInProgress(net, { roundType: 'space_wipe', localSpaceId: spaceId, types: stored }, now, cfg);
    if (prior) return repeatedRound(net, cfg, prior, now);
    return openedRound(proposeRound(net, cfg, {
      type: 'space_wipe', subjectInstanceId: cfg.instanceId, subjectLabel: cfg.instanceLabel,
      subjectUrl: '',   // not meaningful for a wipe, as for space_deletion
      spaceId,
      // The network's id for it (Q-133): a member that calls the space something else resolves this one.
      networkSpaceId: localToRemote(net, spaceId),
      ...(stored ? { wipeTypes: [...stored] } : {}),
    }, { now }));
  });
  saveConfig(cfg);
  return opened;
}

/** What a wipe a door asked for came to — each door renders it. */
export type WipeOutcome =
  /** No round passed: nothing has been wiped yet. `repeated` when the open round was this instance's earlier one. */
  | { status: 'vote_pending'; rounds: RoundAnswer[]; repeated?: true }
  /** Wiped here — by a round that passed, or locally (unnetworked, or a subscriber's own copy: `refills`). No counts on a repeat. */
  | { status: 'wiped'; rounds?: RoundAnswer[]; deleted?: WipeResult; repeated?: true; refills?: true }
  /** Passed; this instance's act is running (the budget ended first) or owed and retried at `retryAt`. `local`: no vote decided it (a wipe an unnetworked space or a subscriber's own copy asked for). */
  | { status: 'passed'; queued: true; rounds: RoundAnswer[]; retryAt?: string; repeated?: true; local?: true }
  /** Passed; this instance's act failed. Answered through `spaceActFailureAnswer`. `local` as above. */
  | { status: 'failed'; rounds: RoundAnswer[]; cause: unknown; local?: true };

/**
 * The case a queued or failed outcome is answered in: `'local'` when no vote decided the wipe, else the rounds that did. The one place
 * a door reads it, so none of them says the vote's words about a wipe nobody voted on (`space-act-failure.ts`).
 */
export function decidedBy(outcome: Extract<WipeOutcome, { status: 'passed' | 'failed' }>): ActRounds {
  return outcome.local ? 'local' : outcome.rounds;
}

/**
 * Wipe `spaceId` (the doors have validated it and read `types` through {@link wipeTypesOf}) as the operator asked: open the rounds a vote
 * decides, or act locally, wait for what passed within the door's budget, and say what happened. Throws only `SpaceActsClosedError`
 * (shutdown: the doors answer `503`).
 */
export async function wipeSpaceAsRequested(spaceId: string, types: readonly WipeCollectionType[]): Promise<WipeOutcome> {
  const opened = openSpaceWipeRounds(spaceId, types);
  const local = opened.length === 0;
  const end = await awaitDoorRounds(local ? [wipeLocally(spaceId, types)] : opened);
  const refills = local && networksHolding(spaceId).some(actsLocallyOn) ? { refills: true as const } : {};
  // An unnetworked wipe has no round to show; its one "round" is the act itself.
  const rounds = local ? [] : end.rounds;
  const repeated = 'repeated' in end && end.repeated ? { repeated: true as const } : {};
  const noVote = local ? { local: true as const } : {};
  switch (end.kind) {
    case 'pending': return { status: 'vote_pending', rounds, ...repeated };
    case 'queued': return { status: 'passed', queued: true, rounds, ...(end.retryAt ? { retryAt: end.retryAt } : {}), ...repeated, ...noVote };
    case 'failed': return { status: 'failed', rounds, cause: end.cause, ...noVote };
    case 'done': return { status: 'wiped', ...(local ? {} : { rounds }), ...(repeated.repeated ? repeated : { deleted: deletedBy(end.results) }), ...refills };
  }
}

/**
 * A wipe no vote decides — unnetworked, or a subscriber's own copy, which refills from its publisher — as a door waits for it: through
 * the runner like any act, joining one that stands with the same key (its door repeat answers it, X9).
 */
function wipeLocally(spaceId: string, types: readonly WipeCollectionType[]): DoorRound {
  const stored = canonicalWipeTypes(types);
  const request = { kind: 'wipe' as const, localId: spaceId, ...(stored ? { types: stored } : {}) };
  return localAct(spaceActJoinedBy(getConfig(), request), () => registerOwnSpaceAct(request));
}

/** The deleted counts summed over the acts that ran: two networks passing at once join one act; a second act on an emptied space adds zeroes. */
function deletedBy(results: readonly SettledSpaceRound[]): WipeResult {
  const deleted = wipeResultOf();
  for (const r of results) {
    const counts = 'counts' in r ? r.counts : undefined;
    for (const k of Object.keys(deleted) as (keyof WipeResult)[]) deleted[k] += counts?.[k] ?? 0;
  }
  return deleted;
}

export { wipeTypesOf };
