/**
 * The records an RDF import inserts, by id, as the act keeps them after the translation: what the dry plan and the commit seed as present, an entity
 * with its type (bundle-384, Q-983, fix round, finding 1).
 *
 * ## What it prevents
 *
 * The act's second phase holds one entry per record the file inserts, and the dry plan holds a copy it can take refused records out of, for the whole
 * file. The index and the digest sets of the first phase are gone by then, so this is a holder of its own, as dear per subject as the index was and
 * charged to no meter: a file whose index fitted its room could take the heap with these two maps before any bound looked at them. It is charged to a
 * meter of its own room ({@link MINTED_END_BYTES} an entry, {@link ENDS_COPY_BYTES} an entry of its copy, measured by
 * `the-import-memory-charges-every-holder-of-the-import.test.js`), and the door's count answers the larger of the two phases, so a file the door
 * lets in is not refused here.
 *
 * ## What a caller cannot forget, because it is inside
 *
 * - **The charge comes before the entry**: an id the room cannot hold is refused naming `RDF_IMPORT_MAX_MEMORY` and is not kept; an id set again is
 *   one entry and costs nothing more.
 * - **A copy is charged before it is made**: {@link MintedEnds.copy} takes its whole cost from the meter first, so a copy that cannot fit is refused
 *   with nothing allocated.
 */
import { MINTED_END_BYTES, ENDS_COPY_BYTES, type ImportMemoryMeter } from './import-memory.js';
import type { MintedEnd } from './import-plan.js';

export class MintedEnds extends Map<string, MintedEnd> {
  constructor(private readonly meter: ImportMemoryMeter) { super(); }

  /** Keep `end` for `id`, charging {@link MINTED_END_BYTES} first when `id` is new; a refused charge keeps nothing. */
  override set(id: string, end: MintedEnd): this {
    if (!this.has(id)) this.meter.charge(MINTED_END_BYTES);
    return super.set(id, end);
  }

  /** A plain Map of the same ends, which the dry plan takes refused records out of: its table is charged ({@link ENDS_COPY_BYTES} an entry) before it is made. */
  copy(): Map<string, MintedEnd> {
    this.meter.charge(this.size * ENDS_COPY_BYTES);
    return new Map(this);
  }
}
