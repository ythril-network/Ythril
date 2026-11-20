/**
 * What an RDF import's door can know of a file's record count from the sorted spool alone, with no read of the store (bundle-270, second review
 * F1 and F7), and the digest set the act's passes keep a file's triplets in.
 *
 * ## What it prevents
 *
 * The index bound (`RDF_IMPORT_MAX_RECORDS`) counts a record per subject and one per bare edge (an asserted triple no reifier names), and a bare
 * edge is only found by a pass over the file. That pass used to run in the request together with the store reads of the translation, so a request
 * for the largest file the bounds allow held the server for minutes before a byte was answered. The count is made here, from the spool alone:
 * it reads no store, so the door answers 413 at once for a file that cannot fit, and the translation, which does read the store, runs in the act
 * under its hold.
 *
 * The count is an upper bound of the records the translation makes (a subject that is no record, and an edge a translation refuses, are counted
 * too): it never refuses a file the index would take, and the index, which holds the exact figure, is the act's own judge.
 */
import { createHash } from 'node:crypto';
import type { AddressNames } from './term-reverse.js';
import { RDF_IMPORT_MAX_RECORDS } from './import-index.js';
import { RdfImportBoundExceeded, type QuadGroup } from './import-spool.js';
import { edgeLabelOf, tripletsOfGroup } from './quads-to-ops.js';

/** The bytes of a record key's digest in the passes' sets: 128 bits, so a collision is not a thing a file can plan. */
const KEY_DIGEST_BYTES = 16;

/** The digest a key is held as. */
export const digestOfKey = (key: string): string => createHash('sha256').update(key).digest().subarray(0, KEY_DIGEST_BYTES).toString('latin1');

/** A set of keys held as 128-bit digests: the triplets a file asserts and reifies, at a fixed cost per triplet. */
export class DigestSet extends Set<string> {
  override add(key: string): this { return super.add(digestOfKey(key)); }
  override has(key: string): boolean { return super.has(digestOfKey(key)); }
}

/**
 * Throw {@link RdfImportBoundExceeded} (`RDF_IMPORT_MAX_RECORDS`, a 413) when `subjects` plus the file's bare edges are over `max`. Reads only
 * `groups` (the sorted spool); `namesOf` says which address names a group's graph is read under.
 */
export async function assertRecordsWithinBound(
  groups: AsyncIterable<QuadGroup>, namesOf: (graph: string | undefined) => AddressNames, subjects: number, max: number = RDF_IMPORT_MAX_RECORDS,
): Promise<void> {
  const asserted = new Set<string>();
  const reified = new Set<string>();
  for await (const group of groups) {
    const names = namesOf(group.graph?.value);
    const t = tripletsOfGroup(group.quads);
    for (const key of t.asserted) {
      const predicate = (JSON.parse(key) as string[])[1] ?? '';
      const label = edgeLabelOf(predicate, names);
      if (label !== null && label !== 'shared') asserted.add(digestOfKey(key));
    }
    for (const key of t.reified) reified.add(digestOfKey(key));
  }
  let bare = 0;
  for (const digest of asserted) if (!reified.has(digest)) bare += 1;
  if (subjects + bare > max) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_RECORDS', max);
}
