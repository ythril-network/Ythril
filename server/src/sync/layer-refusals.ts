/**
 * Which members refuse to hand over a network's schema, and how long this instance leaves them alone (`Q-966`).
 *
 * ## What it prevents
 *
 * A member that refuses the schema (a 403 `schema_rung`, a missing door, a layer the reader refuses) refuses for as long as its rights or its
 * build are what they are. The heal asked it again every cycle and warned every cycle, for as long as it stayed in the network. A refusal is
 * recorded against the member and the space, and the member is not asked again until a backoff has passed: ten minutes at the first refusal,
 * doubling at each next one, never more than a day. One answer clears it, so a right granted later is found at the first ask after the backoff.
 *
 * Local to the process, like every other retry state of the sync engine: a restart asks once more and warns once more, which is the cost of
 * not writing a refusal count into the config on every cycle. The table is bounded, oldest entry out.
 */

import { nominalBackoffMs } from '../util/backoff.js';
import { LruMap } from '../util/lru-map.js';

const MINUTE_MS = 60_000;
export const LAYER_REFUSAL_FIRST_MS = 10 * MINUTE_MS;
export const LAYER_REFUSAL_CAP_MS = 24 * 60 * MINUTE_MS;
/** A wait in whole minutes, as the log lines say it. */
export const minutesOf = (ms: number): number => Math.round(ms / MINUTE_MS);
const MAX_ENTRIES = 5_000;

interface Entry { until: number; step: number }

/** The table of refused (network, member, space) triples; one per process. */
export class LayerRefusals {
  private readonly entries = new LruMap<string, Entry>(MAX_ENTRIES);

  private static key(networkId: string, memberId: string, spaceId: string): string {
    return JSON.stringify([networkId, memberId, spaceId]);
  }

  /** May this member be asked for this space now? */
  mayAsk(networkId: string, memberId: string, spaceId: string): boolean {
    const e = this.entries.peek(LayerRefusals.key(networkId, memberId, spaceId));
    return e === undefined || Date.now() >= e.until;
  }

  /** The member refused: it is left alone for the next backoff step. @returns the wait that starts now, for the one warning of this step. */
  refused(networkId: string, memberId: string, spaceId: string): number {
    const k = LayerRefusals.key(networkId, memberId, spaceId);
    const step = (this.entries.get(k)?.step ?? -1) + 1;
    const wait = nominalBackoffMs(step, LAYER_REFUSAL_FIRST_MS, LAYER_REFUSAL_CAP_MS);
    this.entries.set(k, { until: Date.now() + wait, step });
    return wait;
  }

  /** The member answered: nothing is held against it. */
  answered(networkId: string, memberId: string, spaceId: string): void {
    this.entries.delete(LayerRefusals.key(networkId, memberId, spaceId));
  }
}

/** The instance every ask of a member's schema goes through. */
export const layerRefusals = new LayerRefusals();
