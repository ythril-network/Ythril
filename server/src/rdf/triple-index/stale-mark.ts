/**
 * The one write that holds a space's triple index back from being read: marking it `stale` (bundle-273, Q-764).
 *
 * ## The question it answers
 *
 * "This space's records changed in a way the index cannot follow: make every reader take the records until a rebuild states them."
 * The journal (a `*` row, a drop or rename, a write made while RDF is off), the follower (a journal row `*`) and the re-upgrade detector
 * (`sync/positions-owed.ts`, which marks the spaces a 5.6 build wrote) all ask it.
 *
 * ## Why it is a module of its own
 *
 * It imports only the db door and the collection names. `store.ts` carries the index's whole write path and imports half of the server;
 * the detector, which sits inside the server's import cycle, would pull `store.ts` into it for this one update, and the cycle gate
 * (`check-i-architecture-dependency-direction`) ceilings the modules in cycles.
 */
import { col, asFilter, asUpdate } from '../../db/mongo.js';
import { spaceCollection } from '../../db/space-collection.js';
import { RAISE_WRITES } from './write-counter.js';

/** The part of the state row this write reads and sets (`store.ts` `TripleIndexState` is the whole row). */
interface StaleMarkRow { _id: 'state'; status: string; writes?: number }

/**
 * Mark `spaceId`'s index `stale` (a rebuild, slice S4, makes it ready again), when it has a state row: for a change no record row can name
 * (a journal row `*`, a record collection dropped or renamed, a writer around the db door). Never creates a state row: a space whose index
 * has none is not ready already, and a row written under a name a rename is about to move into would stop the rename. Raises the index's
 * write counter in the same write (`store.ts`: a stale mark is a change of the index).
 */
export async function markTripleIndexStale(spaceId: string): Promise<void> {
  await col<StaleMarkRow>(spaceCollection(spaceId, 'rdfState')).updateOne(
    asFilter<StaleMarkRow>({ _id: 'state' }), asUpdate<StaleMarkRow>({ $set: { status: 'stale' }, ...RAISE_WRITES }));
}
