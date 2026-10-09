/**
 * What a relabel answers when the store refuses its write with a duplicate key (`Q-439`).
 *
 * ## What it prevents
 *
 * A relabel onto a functional label is a write the planner never sees: `updateEdgeById` resolves the subject's other edges
 * once and writes. Two relabels (or a relabel and an insert) that both counted zero both write, and the guard index refuses the
 * second with a raw `E11000` — a driver error that names the internal collection and the key, and tells the caller nothing
 * about what they did. A relabel has no re-plan loop (`planAndCommit` is the create path's), so it is THIS function that turns
 * the store's refusal into one of the answers the door already speaks, and a raw driver error never reaches a caller.
 *
 * ## The order, and why it never reads the message
 *
 * An `E11000` inside a held transaction carries no `keyPattern`, and the driver's text is not a contract, so which index refused
 * is never asked of the error. Any duplicate key on the write runs the same four steps, each cheaper than the next:
 *
 *  1. **heal** (`healStaleMarker`) — the guard may be held by a phantom; clearing it makes the same write land, once;
 *  2. **re-classify** — the ends are resolved again and the schema asked again: the stored winner is now counted, so a
 *     functional breach is refused as the ordinary `SchemaViolationError`, the same class and body as every other door;
 *  3. **identity** — the identity the edge moves onto may be taken by another edge: `EdgeIdentityTaken`, which the doors map;
 *  4. **one more write**, and a duplicate key on THAT is `WriteConflict` (409): something is changing this subject faster than a
 *     write can be answered, which is what 409 says.
 *
 * Anything that is not a duplicate key is thrown as it came: a store that is down is the door's 503, not a conflict.
 */
import { findEdgeByTriplet } from '../edge-lookup.js';
import { EdgeIdentityTaken } from '../edge-rekey.js';
import { isDuplicateKey } from '../../db/write-errors.js';
import type { RefKind } from '../../config/types-knowledge.js';
import { healStaleMarker } from './heal-stale-marker.js';
import { WriteConflict } from './types.js';

/** The edge as the relabel leaves it: its id (the one it will hold, or keeps), and the identity it moves onto. */
export interface RelabelTarget {
  id: string;
  from: string;
  to: string;
  label: string;
  fromKind?: RefKind | undefined;
  toKind?: RefKind | undefined;
}

/**
 * Run `write` (a relabel's one write: the held re-key transaction, or the in-place update) and answer a duplicate key on it.
 *
 * @param guard      the guard the relabelled edge is stamped with, when it is; `undefined` for a relabel that leaves it unguarded.
 * @param reclassify resolves the ends again and THROWS the refusal when the write is now refused — the same classification
 *                   the relabel ran before it wrote.
 */
export async function writeRelabel<T>(
  spaceId: string, target: RelabelTarget, guard: string | undefined,
  write: () => Promise<T>, reclassify: () => Promise<void>,
): Promise<T> {
  try {
    return await write();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  if (guard !== undefined && (await healStaleMarker(spaceId, guard, target.id)) === 'healed') {
    try {
      return await write();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
    }
  }
  await reclassify();
  const taken = await findEdgeByTriplet(spaceId, target.from, target.to, target.label, target.fromKind, target.toKind);
  if (taken && taken._id !== target.id) throw new EdgeIdentityTaken(taken._id, target.from, target.to, target.label);
  try {
    return await write();
  } catch (err) {
    if (!isDuplicateKey(err)) throw err;
  }
  throw new WriteConflict('edge', target.id);
}
