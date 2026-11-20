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
import type { Quad } from './literals.js';
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
 * How many labelled asserted edge statements a file may hold per unit of the record bound before its records cannot be met (lens finding L5).
 *
 * A file whose records can be met has at most `max` bare edges (each is a record) plus the edges a reifier names (each reifier is a subject,
 * and subjects are bounded by the same figure through `RDF_IMPORT_MAX_SUBJECTS`): two times the bound. Past that the sets below are refused
 * as the statement arrives, so they never hold more than this multiple of the bound each. The price is a hand-made file whose reifiers each
 * name several triples, which the translation drops (`several-values`) and which the unbounded count let through: it is refused by the record
 * bound's name like any file too large for the index. Measured heap per entry of a set (a 128-bit digest as a string, the Set's slot): 53 bytes,
 * 150 bytes resident, so the largest set a file can build is 2 000 000 entries, about 106 MB of heap, where the ten million statements the reader
 * admits held 530 MB of heap and 1.5 GB resident per set.
 */
export const RDF_IMPORT_EDGE_STATEMENT_MULTIPLE = 2;

/**
 * The labelled edge statements a file asserts and reifies, as digests (the passes' two sets), fed group by group: {@link addGroup} refuses the
 * file by the record bound's name the moment either set would pass {@link RDF_IMPORT_EDGE_STATEMENT_MULTIPLE} times the bound, so no caller can
 * fill a set with the whole file before looking. Only a statement whose predicate names one edge label is kept: the translation asks the sets
 * only about those, so a file of other links fills nothing.
 */
export class TripletSets {
  readonly asserted = new DigestSet();
  readonly reified = new DigestSet();
  constructor(private readonly max: number = RDF_IMPORT_MAX_RECORDS) {}

  private get cap(): number { return this.max * RDF_IMPORT_EDGE_STATEMENT_MULTIPLE; }

  /** Take the statements of one group read under `names`; throws {@link RdfImportBoundExceeded} (`RDF_IMPORT_MAX_RECORDS`) past the cap. */
  addGroup(quads: readonly Quad[], names: AddressNames): void {
    const t = tripletsOfGroup(quads);
    for (const key of t.asserted) this.#take(this.asserted, key, names);
    for (const key of t.reified) this.#take(this.reified, key, names);
  }

  #take(set: DigestSet, key: string, names: AddressNames): void {
    const label = edgeLabelOf((JSON.parse(key) as string[])[1] ?? '', names);
    if (label === null || label === 'shared') return;
    if (set.size >= this.cap && !set.has(key)) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_RECORDS', this.max);
    set.add(key);
  }

  /** The asserted statements no reifier names: each is an edge of its own. */
  bare(): number {
    let n = 0;
    for (const digest of this.asserted) if (!Set.prototype.has.call(this.reified, digest)) n += 1;
    return n;
  }
}

/**
 * Throw {@link RdfImportBoundExceeded} (`RDF_IMPORT_MAX_RECORDS`, a 413) when `subjects` plus the file's bare edges are over `max`, or as soon as
 * the file's edge statements make that certain ({@link TripletSets}). Reads only `groups` (the sorted spool); `namesOf` says which address
 * names a group's graph is read under.
 */
export async function assertRecordsWithinBound(
  groups: AsyncIterable<QuadGroup>, namesOf: (graph: string | undefined) => AddressNames, subjects: number, max: number = RDF_IMPORT_MAX_RECORDS,
): Promise<void> {
  const sets = new TripletSets(max);
  for await (const group of groups) sets.addGroup(group.quads, namesOf(group.graph?.value));
  if (subjects + sets.bare() > max) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_RECORDS', max);
}
