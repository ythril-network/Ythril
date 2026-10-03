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

/**
 * The server's error code on a failed write — a single write's rejection or one entry of a bulk write's
 * `writeErrors` — or undefined when it carries none. The one reader of the code, because it sits on the error
 * itself or on its `err` depending on the driver path, and a reader that knows one shape misses the other.
 */
export function writeErrorCode(err: unknown): number | undefined {
  const w = err as RawWriteError | null;
  const c = w?.code ?? w?.err?.code;
  return typeof c === 'number' ? c : undefined;
}
const codeOf = (w: RawWriteError): number | undefined => writeErrorCode(w);

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

/**
 * Server codes that refuse ONE DOCUMENT for what it is — it will be refused identically however often it is
 * sent — as opposed to a refusal of the command, the collection or the moment (a view, a missing namespace, an
 * authorisation, a step-down), which is not the document's and must fail the whole write so it is retried.
 *
 * An ALLOWLIST, and the reason is the direction of the mistake: a fault misread as a document's refusal drops
 * that document from a sync page for good (the sender is told it was handled and moves past it), while a
 * document's refusal misread as a fault only re-sends a page. So only a code that positively identifies the
 * document is one.
 */
const DOCUMENT_REFUSAL_CODES = new Set([
  2,      // BadValue
  14,     // TypeMismatch
  28,     // PathNotViable
  52,     // DollarPrefixedFieldName
  53,     // InvalidIdField
  55,     // InvalidDBRef
  56,     // EmptyFieldName
  57,     // DottedFieldName
  66,     // ImmutableField
  121,    // DocumentValidationFailure — a `$jsonSchema` validator refusing this document
  10334,  // BSONObjectTooLarge
  17280,  // KeyTooLong
  17419,  // a resulting document over the size limit
]);

/**
 * Driver errors raised before anything is sent, about the document itself (unserialisable BSON).
 *
 * NOT `MongoInvalidArgumentError` (bundle-30). It names the CALL's arguments, and since operations inside a seq
 * hold carry a bound, the driver raises it for a misused bound too ("cannot be given a timeoutMS setting…", "a
 * Timeout with a negative duration") — a defect of ours that, read as a refusal, dropped a peer's document from its
 * sync page for good. The allowlist's own rule decides it: only an error that positively identifies the DOCUMENT is
 * a document's refusal, and this one does not. `a-write-timeout-is-told-from-every-other-failure` pins it.
 */
const DOCUMENT_REFUSAL_NAMES = new Set(['BSONError', 'BSONVersionError']);

/** Is this failure one document's, so refusing that document (and only it) is the right answer? */
export function isDocumentRefusal(err: unknown): boolean {
  const e = err as { code?: unknown; name?: unknown } | null;
  const code = writeErrorCode(err);
  if (code !== undefined && DOCUMENT_REFUSAL_CODES.has(code)) return true;
  return typeof e?.name === 'string' && DOCUMENT_REFUSAL_NAMES.has(e.name);
}

/** The per-operation shape of the same question, for a code read off a bulk write's failure list. */
export function isDocumentRefusalCode(code: number | undefined): boolean {
  return code !== undefined && DOCUMENT_REFUSAL_CODES.has(code);
}

/** A write failure said for a caller — from the code alone, never the driver's message. */
export function phraseWriteFailure(code: number | undefined): string {
  if (code === DUPLICATE_KEY) return 'a record with this identity was written by another request at the same moment; nothing was written for this item — retry it';
  return `the write did not complete${code !== undefined ? ` (error code ${code})` : ''}; nothing was written for this item — retry it`;
}
