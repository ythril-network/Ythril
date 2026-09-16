/**
 * Wiping every edge in a space.
 *
 * ## Why the edge wipe has a file of its own and the other three do not
 *
 * `bulkDeleteEntities`, `bulkDeleteFacts` and `bulkDeleteChrono` each sit in their type's own module.
 * `edges.ts` is frozen at its current size by `no-new-god-files.test.js`, whose message is the reason rather
 * than the rule — *"every change lands in the same place because that is where the code already is"* — so the
 * edge wipe came out when that file needed room, and it stays out.
 *
 * ## What used to be here
 *
 * Thirty lines: a tombstone per document, one reserved seq block, the delete. They were the same thirty lines
 * as the other three types' (`R-4`), and they now live once in `bulk-wipe.ts` — including the part worth
 * knowing before editing it, which is that the seq range is reserved in ONE round trip and never rolled back.
 *
 * This file's previous docblock said the extraction was *"filed rather than fixed here"* because it would touch
 * "four sets of webhook semantics". That was wrong on the facts: not one of the four emits a webhook. What they
 * actually differ in is one cascade and one sort — which is what writing the characterization tests
 * established, and what the shared helper takes as options.
 */
import { wipeSpaceCollection } from './bulk-wipe.js';

/** Bulk-delete every edge in a space, writing a tombstone per deleted doc. */
export async function bulkDeleteEdges(spaceId: string): Promise<number> {
  return await wipeSpaceCollection(spaceId, 'edges', 'edge');
}
