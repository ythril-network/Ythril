/**
 * One read over a quad source that holds across a swap of a triple index (bundle-273, Q-764 S4; design-r2 R5; contract row 2).
 *
 * ## The question it answers
 *
 * "What does this read answer, given that a rebuild may swap a member's index in while it runs?" A quad source pins the build of every
 * member it decided to read from an index (`quad-source.ts` `indexesSwapped`). A member whose build changed before the read ended may
 * have answered from two builds, whose term ids differ, so the read is run once more over a source that reads those members from their
 * records. Once: the second source reads no swapped index.
 *
 * ## What it prevents
 *
 * A read door that reads the index and forgets the check. Every door that runs a read over a quad source that may read an index (the
 * SPARQL answer, each Linked Data read) runs it through here, so the pin is checked at the end of every such read, also when the read
 * threw: a read that met collections renamed under it fails, and is then answered from the records instead of refused.
 */
import type { QuadSource } from './quad-source.js';

/**
 * Run `read` over `open([])`; when it read a member whose index was swapped meanwhile, run it again over `open(swapped)`, which reads
 * those members from their records, and answer that run. A throw of the first run is answered the same way when a member was swapped,
 * and thrown otherwise; `final(err)` names a throw that is thrown whatever was swapped (the caller went away). The second run's answer or
 * throw is the read's.
 */
export async function readAcrossSwaps<T>(
  open: (recordsFor: readonly string[]) => QuadSource,
  read: (source: QuadSource) => Promise<T>,
  final: (err: unknown) => boolean = () => false,
): Promise<T> {
  const first = open([]);
  let answered: T;
  try {
    answered = await read(first);
  } catch (err) {
    if (final(err)) throw err;
    const swapped = await first.indexesSwapped();
    if (swapped.length === 0) throw err;
    return read(open(swapped));
  }
  const swapped = await first.indexesSwapped();
  return swapped.length === 0 ? answered : read(open(swapped));
}
