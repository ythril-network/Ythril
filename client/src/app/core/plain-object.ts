/**
 * Is a value someone else shaped (a server's answer, an error body, a vote round's steps) an object whose keys can be read as a map?
 *
 * ## What it prevents
 *
 * `typeof v === 'object' && v !== null && !Array.isArray(v)` was written as a private `isRecord` in six client modules, each in its own spelling.
 * Each copy is one line, and each is the line a reader skims: `typeof null === 'object'` and an array being an object are the two halves a copy
 * drops. The question is asked here and nowhere else (`testing/one-plain-object-question.spec.ts` refuses a local copy).
 *
 * It answers as the schema package's `isPlainObject` answers on the server: not `null`, not an array, an object. A class instance counts (an
 * `HttpErrorResponse` is read for its `status` and `error`), and so does an object made without a prototype.
 */

/** Is `v` a plain object (not `null`, not an array) whose keys can be read as a map? */
export function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
