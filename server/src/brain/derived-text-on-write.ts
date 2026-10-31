/**
 * What a write may store of `matchedText` and the vector beside the content it writes.
 *
 * ## The rule
 *
 * **A vector is stored only beside the text it was made from.** `matchedText` beside a vector is that vector's text;
 * with no vector it is the text the lexical channel searches.
 *
 * ## What it prevents
 *
 * The embed job reads the pair as its "nothing to do" test (`embedStoredRecord`: vector present, `matchedText` equal to
 * the text it builds, same model -> `unchanged`). A converge that put the NEW text in `matchedText` and left the OLD
 * vector standing therefore made the job answer `unchanged` for ever: the vector described text the record no longer had,
 * although the enqueue had succeeded. The same pair is what the backfill's walk (`queue-embed-sweep.ts`, through the worker's
 * classifier `embedOwed`) compares, so a writer that broke the rule also hid its record from the repair.
 *
 * ## The one question
 *
 * Given the content a write stores, what goes beside it?
 *
 * - a vector computed inline: the vector, its model, and the text it was made from;
 * - a record the write leaves suppressed: the text and NO vector (the vector it held is removed), because a stored
 *   vector is the feature failing and the lexical channel still has to find it;
 * - a new record (`onto: 'insert'`) with no vector: the text, since no vector can exist beside it yet;
 * - anything else (`onto: 'stored'`, no vector, not suppressed): NOTHING. The stored pair stands, still describing each
 *   other, until the job writes both. A planner's read of the stored record does not carry its vector, so it cannot tell
 *   a record that holds one from one that does not, and the safe answer is the same for both. This is the branch the
 *   converge writers used to get wrong. A lexical search meanwhile sees the previous text, the same window an update and
 *   an arrival already have. An edge's insert asks for it too: its text costs two endpoint reads, so it is left to the job
 *   unless the record is suppressed (which no job will write it for).
 *
 * `text` is lazy, so a caller that pays a read to build it pays only when the answer needs it. The guard is inside: there
 * is no input for which this returns `matchedText` beside a vector it was not made from, or without removing that vector,
 * except an insert, which has none.
 */
import { UNSET_VECTOR } from '../sync/local-only-fields.js';

/** A vector computed before the write, in the fields a record stores it under. */
export interface InlineVectorFields {
  embedding: number[];
  embeddingModel: string;
}

export interface DerivedWriteInput {
  /** The text this record's builder gives for the content being written. Called at most once, and only if the answer needs it. */
  text: () => string | Promise<string>;
  /** The vector computed before the write, or `null`. Never beside `suppressed`. */
  vector: InlineVectorFields | null;
  /** Whether the record this write LEAVES is suppressed (`suppressedAfterWrite`). */
  suppressed: boolean;
  /** `insert`: a new record, no vector can exist beside the text. `stored`: it may hold a pair, which stands until the job writes both. */
  onto: 'insert' | 'stored';
}

export interface DerivedWrite {
  /** Fields to merge into the document or the `$set`. */
  set: Record<string, unknown>;
  /** Fields to `$unset` (never on an insert, which holds nothing to remove). */
  unset: Record<string, ''>;
}

export async function derivedFieldsForWrite(input: DerivedWriteInput): Promise<DerivedWrite> {
  const { vector, suppressed, onto } = input;
  if (vector && suppressed) {
    // Suppression IS the absence of a vector; a caller that computed one for a suppressed record has the order wrong.
    throw new Error('derivedFieldsForWrite: a vector was computed for a record the write leaves suppressed');
  }
  if (vector) {
    return { set: { embedding: vector.embedding, embeddingModel: vector.embeddingModel, matchedText: await input.text() }, unset: {} };
  }
  if (suppressed) {
    return { set: { matchedText: await input.text() }, unset: onto === 'insert' ? {} : { ...UNSET_VECTOR } };
  }
  if (onto === 'insert') return { set: { matchedText: await input.text() }, unset: {} };
  return { set: {}, unset: {} };
}

/**
 * Is the stored record's text stale: is there a current text, and is the stored `matchedText` not it?
 *
 * The other half of the rule above: a writer that leaves the stored pair standing leaves a record whose text is stale until its
 * job runs. The worker's classifier (`embedOwed`, which the backfill's walk asks too) and the dupe scanner's hold on a dismissed
 * pair ask it; written twice, the two drifted on a text the batch could not build. Only a STRING is a current text: `null` (a
 * derived row with no text), `undefined` and the builder's `UNBUILDABLE` marker owe nothing on this question
 * (`a-stale-text-is-asked-in-one-place`).
 */
export function textIsStale(stored: Readonly<Record<string, unknown>>, currentText: unknown): currentText is string {
  return typeof currentText === 'string' && stored['matchedText'] !== currentText;
}
