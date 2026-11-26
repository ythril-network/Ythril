/**
 * One read over a quad source that holds across a swap of a triple index (bundle-273, Q-764 S4; design-r2 R5; contract row 2).
 *
 * ## The question it answers
 *
 * "What does this read answer, given that a rebuild may swap a member's index in while it runs?" A quad source pins the build of every
 * member it decided to read from an index (`quad-source.ts` `indexesSwapped`). A member whose build changed before the read ended may
 * have answered from two builds, whose term ids differ, so the read is run again over a source that reads every member the run read from
 * an index from its records (not only the swapped one: another member of the run could be swapped during the rerun, finding F4). A run
 * that reads a member from an index is asked again whether it was swapped, so the answer is always one no swap touched.
 *
 * ## What it prevents
 *
 * A read door that reads the index and forgets the check. Every door that runs a read over a quad source that may read an index (the
 * SPARQL answer, each Linked Data read) runs it through here, so the pin is checked at the end of every such read, also when the read
 * threw: a read that met collections renamed under it fails, and is then answered from the records instead of refused.
 */
import type { QuadSource } from './quad-source.js';

/**
 * Run `read` over `open([])`; when it read a member whose index was swapped meanwhile, run it again over `open(members)`, which reads
 * every member the run read from an index from its records, and answer the first run no swap touched. A throw is answered the same way
 * when a member was swapped, and thrown otherwise; `final(err)` names a throw that is thrown whatever was swapped (the caller went away).
 */
export async function readAcrossSwaps<T>(
  open: (recordsFor: readonly string[]) => QuadSource,
  read: (source: QuadSource) => Promise<T>,
  final: (err: unknown) => boolean = () => false,
): Promise<T> {
  const fromRecords = new Set<string>();
  // Each run that met a swap adds every member it read from an index to `fromRecords`, and each member is added once (a run reads none
  // of them from an index), so the loop ends after at most one run more than there are members.
  for (;;) {
    const source = open([...fromRecords]);
    let answered: T | undefined;
    let failure: { err: unknown } | undefined;
    try {
      answered = await read(source);
    } catch (err) {
      if (final(err)) throw err;
      failure = { err };
    }
    if ((await source.indexesSwapped()).length === 0) {
      if (failure) throw failure.err;
      return answered as T;
    }
    for (const { space, path } of source.readPaths()) if (path === 'index') fromRecords.add(space);
  }
}
