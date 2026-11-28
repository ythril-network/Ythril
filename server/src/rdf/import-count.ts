/**
 * What an RDF import's door can know of a file's memory need from the sorted spool alone, with no read of the store (bundle-270, second review
 * F1 and F7), and the digest set the act's passes keep a file's triplets in.
 *
 * ## What it prevents
 *
 * The index holds a record per subject and one per bare edge (an asserted triple no reifier names), the two sets hold a digest per statement, and a
 * bare edge is only found by a pass over the file. That pass used to run in the request together with the store reads of the translation, so a request
 * for the largest file the bounds allow held the server for minutes before a byte was answered. The count is made here, from the spool alone: it
 * reads no store, so the door answers 413 at once for a file that cannot fit in the memory one import is given (`import-memory.ts`), and the
 * translation, which does read the store, runs in the act under its hold.
 *
 * The need is an upper bound of what the translation's index and sets take (a subject that is no record, an edge a translation refuses, and a record
 * whose stored id is shorter than the address are charged as the dearest case): it never refuses a file the index would take, and the index, which
 * charges the exact figure, is the act's own judge. In particular an addressed subject is charged `max(minted entry, its text id's entry)`, whichever
 * the index will hold, so the door's need is never below the act's.
 */
import { createHash } from 'node:crypto';
import { ENDS_COPY_BYTES, MINTED_END_BYTES, MINTED_ENTRY_BYTES, SET_ENTRY_BYTES, ImportMemoryMeter, indexEntryBytes } from './import-memory.js';
import { RdfImportBoundExceeded } from './import-bound.js';
import { edgePlansCharged, hasFunctionalEdge } from './import-edge-plan.js';
import type { SpaceMeta } from '@ythril-network/schema';
import { recordOfAddress, type AddressNames } from './term-reverse.js';
import type { QuadGroup } from './import-spool.js';
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

  /** Add `key` unless it is held, charging {@link SET_ENTRY_BYTES} to `meter` first: a refused charge adds nothing. The key is digested once. */
  addCharged(key: string, meter: ImportMemoryMeter): void {
    const held = digestOfKey(key);
    if (Set.prototype.has.call(this, held)) return;
    meter.charge(SET_ENTRY_BYTES);
    Set.prototype.add.call(this, held);
  }
}

/**
 * The labelled edge statements a file asserts and reifies, as digests (the passes' two sets), fed group by group: {@link addGroup} charges each new
 * statement to the import's meter and refuses the file by `RDF_IMPORT_MAX_MEMORY` the moment a charge would pass the room, so no caller can fill a
 * set with the whole file before looking. Only a statement whose predicate names one edge label is kept: the translation asks the sets only about
 * those, so a file of other links fills nothing and is charged nothing. The meter is the import's, shared with its index: the sets are not capped
 * by a multiple of any count, only by what they cost.
 */
export class TripletSets {
  readonly asserted = new DigestSet();
  readonly reified = new DigestSet();
  constructor(private readonly meter: ImportMemoryMeter) {}

  /** Take the statements of one group read under `names`; throws {@link RdfImportBoundExceeded} (`RDF_IMPORT_MAX_MEMORY`) past the room. */
  addGroup(quads: readonly Quad[], names: AddressNames): void {
    const t = tripletsOfGroup(quads);
    for (const key of t.asserted) this.#take(this.asserted, key, names);
    for (const key of t.reified) this.#take(this.reified, key, names);
  }

  #take(set: DigestSet, key: string, names: AddressNames): void {
    const label = edgeLabelOf((JSON.parse(key) as string[])[1] ?? '', names);
    if (label === null || label === 'shared') return;
    set.addCharged(key, this.meter);
  }

  /** The asserted statements no reifier names: each is an edge of its own. */
  bare(): number {
    let n = 0;
    for (const digest of this.asserted) if (!Set.prototype.has.call(this.reified, digest)) n += 1;
    return n;
  }
}

/** The heap bytes the index will take for a subject: its minted id, or the text of its address when it is a record of the space (a stored one). */
function subjectBytes(group: QuadGroup, names: AddressNames): number {
  if (group.subject.kind !== 'iri') return MINTED_ENTRY_BYTES;
  const read = recordOfAddress(group.subject.value, names);
  return read.answer === 'record' && read.of === 'space' ? Math.max(MINTED_ENTRY_BYTES, indexEntryBytes(read.id)) : MINTED_ENTRY_BYTES;
}

/**
 * Throw {@link RdfImportBoundExceeded} (`RDF_IMPORT_MAX_MEMORY`, a 413) when the act's holders for the file need more than `memoryBytes`, or as soon as
 * the subjects and statements read so far make that certain. The act has two phases, each within the room: the translation, which holds the index (a
 * subject each, and a bare edge each) and the two sets, and then the plan, which holds the minted ends of the records the file inserts and a copy of
 * them (`import-ends.ts`), by then without the index and the sets. The need is the larger of the two; a refusal that comes where it is known whole (the
 * second phase's figure from the number of subjects, or the bare edges that end the first) says so, and one at the charge that crossed the room, before
 * the rest was read, is at least that. Answers the need when the file fits. Reads only `groups` (the sorted spool); `namesOf` says which address names
 * a group's graph is read under.
 */
export async function assertRecordsWithinBound(
  groups: AsyncIterable<QuadGroup>, namesOf: (graph: string | undefined) => AddressNames, memoryBytes: number, planSchema?: SpaceMeta['typeSchemas'],
): Promise<{ need: number; first: number; second: number }> {
  const meter = new ImportMemoryMeter(memoryBytes);
  const sets = new TripletSets(meter);
  let subjects = 0;
  for await (const group of groups) {
    const names = namesOf(group.graph?.value);
    meter.charge(subjectBytes(group, names));
    sets.addGroup(group.quads, names);
    subjects += 1;
  }
  // At most one end for each group (a stored record, an edge or a subject that is no record has none): an upper bound, as the first phase's is.
  const first = meter.used + sets.bare() * MINTED_ENTRY_BYTES;
  // Beside them, the dry plan's shared read set when the plan shares one (`import-edge-plan.ts`): every edge it may plan, a bare one or a reifier's.
  const second = subjects * (MINTED_END_BYTES + ENDS_COPY_BYTES) + edgePlansCharged(sets.bare() + sets.reified.size, hasFunctionalEdge(planSchema) || sets.reified.size > 0);
  const need = Math.max(first, second);  if (need > memoryBytes) throw new RdfImportBoundExceeded('RDF_IMPORT_MAX_MEMORY', memoryBytes, need, true);
  return { need, first, second };
}
