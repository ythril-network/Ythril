/**
 * How many records does this space hold? One number, from the collections' own metadata, never a scan (bundle-81, design rev 8 §7, decision 42).
 *
 * The admin network view carries it per space so the client can estimate a re-read's duration (`sum over spaces of max(1, ceil(records / 10,000))` cycles, decisions 40
 * and 47). It is an ESTIMATE by construction: `estimatedDocumentCount` reads the collection's count from its metadata in O(1), which is right to the record in normal
 * operation and may be off after an unclean shutdown, which for "about how many cycles" does not matter, and a count by scan of a million-record space on every
 * read of a network would. The families counted are the six a pull pages (`BRAIN_COLLECTIONS`: facts, entities, edges, chrono, links and the file rows), not the
 * tombstones and not the review and job collections, which are not records a re-read reads.
 */
import { col } from '../db/mongo.js';
import { spaceCollection } from '../db/space-collection.js';
import { BRAIN_COLLECTIONS } from '../config/types.js';

/** The records of one space, summed over the families a pull reads. */
export async function spaceRecordCount(spaceId: string): Promise<number> {
  const counts = await Promise.all(BRAIN_COLLECTIONS.map(part => col(spaceCollection(spaceId, part)).estimatedDocumentCount()));
  return counts.reduce((a, b) => a + b, 0);
}
