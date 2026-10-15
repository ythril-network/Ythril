/**
 * What a bulk batch says about the top-level keys of its ITEMS that a bulk item does not take (Q-320, bundle-128).
 *
 * ## The question this answers
 *
 * "This batch carries items; which of them carry a field their collection's item does not take, and what does this instance do about
 * it?" A single-record write is judged by `answerUnknownWriteFields` and answered with `warnings` rows; a batch has no such body — its
 * answer is `errors[]`, one row per refused or flagged item — so its items are judged HERE, against `acceptedWriteKeys('bulk.write',
 * <collection>)` (the item schemas `save_bulk` publishes), with the same membership test, the same names bound and the same near-miss hint.
 * Both doors (`POST /bulk` and `save_bulk`) reach `bulkWrite`, so both reach this, and the rows are the same on both.
 *
 * ## What it says, and what it will not
 *
 * - **`warn` (the default): the item is written and ONE row names its unknown keys**, `unknown_field: a, b — ignored`. **`refuse`: the item
 *   is rejected through the batch's own `reject`**, so a `$ref` dependant is told why and the other items proceed (the answer is a 207).
 *   The top level of a batch is refused in every mode (`bulkBodyRefusal`); this is only about items.
 * - **An item refused for ANOTHER reason keeps its unknown rows**, worded `not accepted` (nothing was ignored: it was not written), so a
 *   caller who fixes the first reason is not then surprised by the second. An item that was written says `ignored`.
 * - **Bounded, because the keys are the caller's.** At most {@link REFUSAL_NAMES_MAX} names per item, then `…(+N more)`, each cut at
 *   `NAME_QUOTED`; at most {@link BULK_UNKNOWN_ROWS_MAX} rows per batch, then ONE `…(+N more items)` row; the accepted list is said once
 *   per batch (on the first row), not once per item.
 * - **The mode is read ONCE**, when the batch starts, for the space it lands in: a batch whose first item was judged under `warn` is not
 *   finished under `refuse` because an operator changed the setting while it ran.
 * - **Counted once per batch** that carried an unknown key, by the judge's own counter (`countJudgedCall`), so a batch of 500 is one
 *   count, not 500, and a key a caller chose is never a label.
 */
import {
  acceptedWriteKeys, countJudgedCall, nearMissOf, unknownKeysOf, type WriteDoor,
} from '../contract/write-accepts.js';
import { acceptedKeysSentence, type UnknownFieldOutcome } from '../contract/unknown-field-rows.js';
import { unknownWriteFieldsMode } from '../spaces/spaces.js';
import { findSpace } from '../spaces/proxy.js';
import type { UnknownWriteFieldAnswer } from '../config/types.js';
import { NAME_QUOTED, REFUSAL_NAMES_MAX, peerText } from '../util/log.js';

/** How many items of one batch get a row of their own; the rest are counted in one `…(+N more items)` row. */
export const BULK_UNKNOWN_ROWS_MAX = 50;

/** The collections a batch's items are judged by, in the order the batch writes them, each with the `type` its error rows carry. */
const COLLECTIONS = [
  ['facts', 'fact'], ['entities', 'entity'], ['chrono', 'chrono'], ['edges', 'edge'],
] as const;
export type BulkCollection = (typeof COLLECTIONS)[number][0];

/** The row shape a batch's `errors[]` carries for an item (`BulkError` in `brain/bulk.ts` is this plus optional fields). */
export interface BulkUnknownRow { type: string; index: number; reason: string }

/** One item that carries unknown keys, and what the batch needs to say about it. */
interface Flagged {
  collection: BulkCollection;
  type: string;
  index: number;
  /** Every unknown name the item carries, in the order it carries them. */
  names: string[];
  /** Whether a row for it has been said (or its absence accounted for) already. */
  said: boolean;
}

const WORDS: Record<UnknownFieldOutcome, string> = { stored: 'ignored', refused: 'not accepted' };

/**
 * The judge of one batch's items. Build it once per batch, before any item is prepared; it reads the items and the setting, and says
 * nothing until it is asked.
 */
export class BulkUnknownFields {
  private readonly mode: UnknownWriteFieldAnswer;
  private readonly flagged = new Map<object, Flagged>();
  private readonly refusedAt = new Map<BulkCollection, Set<number>>(COLLECTIONS.map(([c]) => [c, new Set<number>()]));
  private readonly accepted = new Map<BulkCollection, { keys: ReadonlySet<string>; sorted: string[]; sentence: string }>();
  private rowsSaid = 0;
  private itemsNotNamed = 0;
  private acceptedSaid = false;

  /**
   * @param push where a row goes: the batch's own `errors[]`
   */
  constructor(
    spaceId: string,
    input: Readonly<Partial<Record<BulkCollection, unknown>>>,
    private readonly door: WriteDoor,
    private readonly push: (row: BulkUnknownRow) => void,
  ) {
    this.mode = unknownWriteFieldsMode(findSpace(spaceId));
    for (const [collection, type] of COLLECTIONS) {
      const items = input[collection];
      if (!Array.isArray(items)) continue;
      const keys = acceptedWriteKeys('bulk.write', collection);
      const sorted = [...keys].sort();
      this.accepted.set(collection, { keys, sorted, sentence: acceptedKeysSentence(sorted) });
      for (const [index, item] of items.entries()) {
        if (item === null || typeof item !== 'object' || Array.isArray(item)) continue;
        const names = unknownKeysOf(item as Record<string, unknown>, keys);
        if (names.length === 0) continue;
        this.flagged.set(item, { collection, type, index, names, said: false });
        if (this.mode === 'refuse') this.refusedAt.get(collection)!.add(index);
      }
    }
  }

  /** Is item `index` of `collection` refused for its unknown keys — i.e. the setting says refuse and the item carries one? */
  refuses(collection: BulkCollection, index: number): boolean {
    return this.refusedAt.get(collection)?.has(index) ?? false;
  }

  /**
   * The items the setting refuses, in batch order, each with the reason it is rejected for — which is its unknown-field row, so it is
   * not said twice. The caller hands each to the batch's `reject`.
   */
  refusedItems(input: Readonly<Partial<Record<BulkCollection, unknown>>>): { type: string; index: number; item: object; reason: string }[] {
    const out: { type: string; index: number; item: object; reason: string }[] = [];
    for (const [collection] of COLLECTIONS) {
      const items = input[collection];
      if (!Array.isArray(items)) continue;
      for (const index of this.refusedAt.get(collection) ?? []) {
        const item = items[index] as object;
        const flagged = this.flagged.get(item)!;
        flagged.said = true;
        out.push({ type: flagged.type, index, item, reason: this.reasonOf(flagged, 'refused') ?? this.pastTheCap('refused') });
      }
    }
    return out;
  }

  /**
   * Say what this item's unknown keys came to, worded for what became of it (`stored`: written, so ignored; `refused`: not written, so not
   * accepted). A no-op for an item that carries none, and for one already said — an item is told once, whichever of its rejection and the
   * end of the batch gets to it first.
   */
  say(item: unknown, outcome: UnknownFieldOutcome): void {
    if (item === null || typeof item !== 'object') return;
    const flagged = this.flagged.get(item);
    if (!flagged || flagged.said) return;
    flagged.said = true;
    const reason = this.reasonOf(flagged, outcome);
    if (reason !== null) this.push({ type: flagged.type, index: flagged.index, reason });
  }

  /**
   * End the batch: every item still unsaid was written (or is about to be reported by its own commit), so it is `ignored`; then the one
   * `…(+N more items)` row for the items past the cap; then the count. Call it once, when the batch is done.
   */
  finish(): void {
    for (const flagged of this.flagged.values()) {
      if (flagged.said) continue;
      flagged.said = true;
      const reason = this.reasonOf(flagged, 'stored');
      if (reason !== null) this.push({ type: flagged.type, index: flagged.index, reason });
    }
    if (this.itemsNotNamed > 0) {
      const outcome: UnknownFieldOutcome = this.mode === 'refuse' ? 'refused' : 'stored';
      this.push({
        type: 'batch', index: 0,
        reason: `unknown_field: …(+${this.itemsNotNamed} more items) — ${WORDS[outcome]}; the first ${BULK_UNKNOWN_ROWS_MAX} items that carry one are named above`,
      });
    }
    if (this.flagged.size > 0) countJudgedCall(this.door, 'bulk.write', this.mode, this.mode === 'refuse' ? 'refused' : 'stored');
  }

  /** One item's row text, or `null` when the batch has already named {@link BULK_UNKNOWN_ROWS_MAX} items (it is counted for the overflow row). */
  private reasonOf(flagged: Flagged, outcome: UnknownFieldOutcome): string | null {
    if (this.rowsSaid >= BULK_UNKNOWN_ROWS_MAX) { this.itemsNotNamed++; return null; }
    this.rowsSaid++;
    const accepted = this.accepted.get(flagged.collection)!;
    const shown = flagged.names.slice(0, REFUSAL_NAMES_MAX).map(name => {
      const cut = peerText(name, { max: NAME_QUOTED });
      const near = nearMissOf(cut, accepted.sorted);
      return near === undefined ? cut : `${cut} (did you mean '${near}'?)`;
    });
    if (flagged.names.length > shown.length) shown.push(`…(+${flagged.names.length - shown.length} more)`);
    // The accepted list is said once per batch, on the first row, and never again.
    const list = this.acceptedSaid ? '' : `. ${accepted.sentence}`;
    this.acceptedSaid = true;
    return `unknown_field: ${shown.join(', ')} — ${WORDS[outcome]}${list}`;
  }

  /**
   * The reason of a REFUSED item that has no row of its own because the batch is past the cap: an item the setting rejects must still be
   * told why, so it gets the sentence without the names (the overflow row says how many there are).
   */
  private pastTheCap(outcome: UnknownFieldOutcome): string {
    return `unknown_field: ${WORDS[outcome]} — this item carries a field the write does not take; the batch names the first ${BULK_UNKNOWN_ROWS_MAX} items that do`;
  }
}
