/**
 * What a failed Mongo write said, read the one way — and said back to a caller without the driver's own text.
 *
 * ## Why it is one module
 *
 * A `bulkWrite` and a single write report the same failure in two shapes: a single write rejects with a
 * top-level `code`, a bulk collects per-operation `writeErrors` with no top-level code, and the code inside each
 * is on the entry or on its `err` depending on the driver path. `isDuplicateKeyOnly` read both under
 * `api/sync/` and the sync engine read them again inline; the write commit is the third reader, so the rule
 * lives here once.
 *
 * ## Why the driver's message never reaches a caller
 *
 * An E11000 message names the internal collection (`<space>_edges`), the index and the duplicated key's values.
 * A per-item reason is answered on two doors and read by integrators, so it is PHRASED from the code instead.
 */

/** One per-operation failure: which operation of the batch, and the server's error code. */
export interface WriteFailure {
  /** The index of the failed operation in the list the bulk write was given. */
  readonly index: number;
  readonly code: number | undefined;
}

type RawWriteError = { index?: number; code?: number; err?: { code?: number; index?: number } };

function codeOf(w: RawWriteError): number | undefined {
  return w.code ?? w.err?.code;
}

/** The per-operation failures a bulk write reported, or `null` when the error is not that shape (ambiguous). */
export function bulkWriteFailures(err: unknown): WriteFailure[] | null {
  const writeErrors = (err as { writeErrors?: RawWriteError[] | Record<string, RawWriteError> } | null)?.writeErrors;
  if (!writeErrors) return null;
  const list = Array.isArray(writeErrors) ? writeErrors : Object.values(writeErrors);
  if (list.length === 0) return null;
  return list.map(w => ({ index: w.index ?? w.err?.index ?? -1, code: codeOf(w) }));
}

/**
 * Is this write failure ONLY duplicate-key rejections — the shape two peers produce independently?
 *
 * Two peers creating the same edge independently produce one `{ from, to, label }` triplet under two ids, so
 * the receiver's upsert hits the unique index. Answering that with a 500 would stall the sender's edges
 * channel permanently (its watermark never advances past the batch).
 *
 * Only duplicates: any other write fault still throws, or genuine corruption would be hidden.
 */
export function isDuplicateKeyOnly(err: unknown): boolean {
  const failures = bulkWriteFailures(err);
  if (failures) return failures.every(f => f.code === DUPLICATE_KEY);
  return (err as { code?: number } | null)?.code === DUPLICATE_KEY;
}

export const DUPLICATE_KEY = 11000;

/** A write failure said for a caller — from the code alone, never the driver's message. */
export function phraseWriteFailure(code: number | undefined): string {
  if (code === DUPLICATE_KEY) return 'a record with this identity was written by another request at the same moment; nothing was written for this item — retry it';
  return `the write did not complete${code !== undefined ? ` (error code ${code})` : ''}; nothing was written for this item — retry it`;
}
