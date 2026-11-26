/**
 * The schema a joiner of a voted network takes from the member it joined through, within one deadline (`Q-966`).
 *
 * A club, closed or democratic network has no upstream to pull a schema from, so the join asks the inviter for each joined space's schema and
 * keeps it as that network's layer before the join answers (`fetchNetworkLayer`, the one fetch the heal uses too). Through the door every build
 * since F-39.1 serves, with the token the inviter just gave: no field in the handshake, so an older inviter answers as before.
 *
 * ## What it prevents
 *
 * The first version asked one space after another, ten seconds each, for up to a thousand spaces, and the join answered only when the last
 * was done: an inviter that took the handshake and then stopped answering held the joiner's request for hours. The fetches now run four at a
 * time and share ONE deadline. What the deadline cuts off is not lost: a space whose layer was not taken holds no seeded mark, and the heal
 * takes it at the first cycle (`pullNetworkSchema`). The count of what was cut off is answered, and said once in the log, not per space; so are the refusals, one line with their count and reasons.
 */
import { log, peerText } from '../util/log.js';
import { fetchNetworkLayer } from './space-meta-pull.js';
import { shutdownBoundSignal } from './held-answer.js';
import { FETCH_TIMEOUT_MS } from './peer-timeouts.js';
import { LAYER_REFUSAL_FIRST_MS } from './layer-refusals.js';

/** How many distinct reasons the one refusal line names. */
const MAX_REASONS_SAID = 3;

/** The time the join gives all of its schema fetches together. */
export const JOIN_LAYERS_DEADLINE_MS = 15_000;
/** How many of them are in flight at once. */
export const JOIN_LAYERS_CONCURRENCY = 4;

export async function takeLayersAtJoin(args: {
  networkId: string; peerUrl: string; from: string; memberId: string;
  entries: ReadonlyArray<{ networkId: string; localId: string }>; headers: Record<string, string>;
  deadlineMs?: number; concurrency?: number;
}): Promise<{ cutOff: number }> {
  const { networkId, peerUrl, from, memberId, entries, headers, deadlineMs = JOIN_LAYERS_DEADLINE_MS, concurrency = JOIN_LAYERS_CONCURRENCY } = args;
  const deadline = AbortSignal.timeout(deadlineMs);
  const queue = [...entries];
  let finished = 0;
  // The reasons of the refusals, kept apart from the log: one line says them all, however many spaces the join carries.
  const refusals = new Map<string, number>();
  const worker = async (): Promise<void> => {
    for (let entry = queue.shift(); entry !== undefined && !deadline.aborted; entry = queue.shift()) {
      const signal = shutdownBoundSignal(AbortSignal.any([deadline, AbortSignal.timeout(FETCH_TIMEOUT_MS)]));
      await fetchNetworkLayer({
        networkId, peerUrl, from, spaceId: entry.localId, remoteSpaceId: entry.networkId, init: { headers, signal },
        memberId, deadline, onRefusal: (what) => { refusals.set(what, (refusals.get(what) ?? 0) + 1); },
      });
      if (!deadline.aborted) finished += 1;
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency, entries.length) }, worker));
  const refused = [...refusals.values()].reduce((a, b) => a + b, 0);
  if (refused > 0) {
    const reasons = [...refusals.keys()].slice(0, MAX_REASONS_SAID).map(r => peerText(r)).join('; ');
    log.warn(`join-remote: ${peerText(from)} refused the schema of ${refused} of ${entries.length} space(s) (${reasons}); each is not asked again for ${LAYER_REFUSAL_FIRST_MS / 60_000} min`);
  }
  const cutOff = entries.length - finished;
  if (cutOff > 0) {
    log.warn(`join-remote: the deadline of ${Math.round(deadlineMs / 1000)} s ended the schema fetches from ${peerText(from)} with ${cutOff} of ${entries.length} space(s) not taken; the first sync cycle takes them`);
  }
  return { cutOff };
}
