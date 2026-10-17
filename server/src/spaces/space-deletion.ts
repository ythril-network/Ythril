/**
 * The operator's deletion of a space (`DELETE /api/spaces/:id`) — the local half and what the door answers (bundle-106, design v5
 * §2.2, §2.4, §2.9, D10, D-40). The networked half opens its rounds in the route itself (`proposeRound`), and both halves are waited for
 * through `awaitDoorRounds`, as the wipe doors are.
 *
 * ## What it prevents
 *
 * A retried networked DELETE took the solo path once its space had left the network, called `removeSpace` beside the deletion that was
 * still removing the own copy, and answered `204` — and a pub/sub subscriber's deletion opened a round its publisher then adopted. Here:
 * a deletion that stands for the space is JOINED (or answered, when it is owed and its retry is ahead); a subscriber leaves the network
 * on its own record, dismisses the space there, and removes its own copy (D-40); and the answers come from one function, in our words.
 */
import { getConfig, saveConfig } from '../config/loader.js';
import type { NetworkConfig } from '../config/types.js';
import { localToRemote } from '../sync/space-map.js';
import { removeSpaceFromNetwork } from '../networks/network-spaces.js';

import { registerOwnSpaceAct, spaceActsOfSpace } from './space-act-runner.js';
import { localAct, type DoorEnd, type DoorRound } from './door-acts.js';
import { queuedActBody, spaceActFailureAnswer } from './space-act-failure.js';
import type { StoreFailureAnswer } from '../brain/store-failure.js';

/**
 * The deletion no vote decides, as the door waits for it: leave each pub/sub network this instance subscribes to on its own record
 * (the network space dismissed there, so it is not proposed again), then remove the own copy through the runner — joining a deletion
 * of it that already stands.
 */
export function deleteSpaceLocally(spaceId: string, subscribed: readonly NetworkConfig[]): DoorRound {
  for (const net of subscribed) {
    const networkSpaceId = localToRemote(net, spaceId);
    removeSpaceFromNetwork(net.id, spaceId, 'a subscriber deleted its own copy (D-40)');
    const cfg = getConfig();
    const live = cfg.networks.find(n => n.id === net.id);
    if (live && !(live.dismissedSpaces ?? []).includes(networkSpaceId)) {
      live.dismissedSpaces = [...(live.dismissedSpaces ?? []), networkSpaceId];
      saveConfig(cfg);
    }
  }
  // A deletion of it that already stands — any network's, or this instance's own — is joined: a retried DELETE never removes beside it.
  const standing = spaceActsOfSpace(getConfig(), spaceId).find(e => e.kind === 'delete');
  return localAct(standing, () => registerOwnSpaceAct({ kind: 'delete', localId: spaceId }));
}

/** What the door answers: a status and a body, `null` body for a `204`, or a store outage's answer for `sendStoreFailure`. */
export interface DeletionAnswer { status: number; body: Record<string, unknown> | null; store?: StoreFailureAnswer }

/**
 * The DELETE door's answer to what its rounds came to (`local`: no vote decided it). A local deletion that completed is `204`, as an
 * unnetworked delete always was; one that joined a deletion already standing answers that one, `200` `repeated`. A networked deletion
 * answers `200 deleted` once every round passed and its act completed, and `202` while a round is still open somewhere — the local copy
 * goes only when no network carries the space.
 */
export function deletionAnswer(end: DoorEnd, spaceId: string, local: boolean, where: string): DeletionAnswer {
  // An unnetworked deletion is not a vote: when it did not finish, its answer names the change and never a vote that passed (`space-act-failure.ts`).
  const decidedBy = local ? 'local' as const : end.rounds;
  const rounds = local ? [] : end.rounds;
  const repeated = 'repeated' in end && end.repeated ? { repeated: true } : {};
  switch (end.kind) {
    case 'pending': return { status: 202, body: { status: 'vote_pending', rounds, ...repeated } };
    case 'queued': return { status: 202, body: queuedActBody(end, decidedBy) };
    case 'failed': {
      const answer = spaceActFailureAnswer(end.cause, decidedBy, where);
      return { status: answer.status, body: answer.body, ...(answer.store ? { store: answer.store } : {}) };
    }
    case 'done': {
      if (local && !repeated.repeated) return { status: 204, body: null };
      if (end.open) return { status: 202, body: { status: 'vote_pending', rounds } };
      const removedHere = !getConfig().spaces.some(s => s.id === spaceId);
      return { status: 200, body: { status: 'deleted', rounds, removedHere, ...repeated } };
    }
  }
}
