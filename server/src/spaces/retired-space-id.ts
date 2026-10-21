/**
 * Whether a space id is a RETIRED proxy id, and the one sentence that says so (Q-531): the leaf half of `spaces/unknown-space.ts`.
 *
 * A leaf (it imports only the config loader and the log text helpers) so the file sandbox and the file act answers - imported far below the
 * view store and the metrics registry - can ask the rule without closing an import cycle through them. `unknown-space.ts` re-exports both;
 * there is still one rule.
 */
import { getConfig } from '../config/loader.js';
import { NAME_QUOTED, peerText } from '../util/log.js';

/** The half of a config the retired-id rule reads: the reservations and the live spaces (a pure caller may hand just these). */
export interface Reservations {
  spaces: readonly { id: string }[];
  retiredSpaceIds?: readonly string[] | undefined;
}

/** Whether `id` is a retired proxy id: reserved, and not a live space (a live space wins over a reservation). */
export function isRetiredSpaceId(id: string, config: Reservations = getConfig()): boolean {
  return (config.retiredSpaceIds ?? []).includes(id) && !config.spaces.some(s => s.id === id);
}

/** The one sentence a retired id is answered with. */
export const retiredSpaceSentence = (id: string): string =>
  `'${peerText(id, { max: NAME_QUOTED })}' was a shared proxy and is now personal views; ask the instance admin`;
