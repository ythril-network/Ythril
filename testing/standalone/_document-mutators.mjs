/**
 * Which MongoDB driver methods change a document — read from the server's own answer, never listed here.
 *
 * ## Why a module
 *
 * The question was answered by hand in at least four places: `_space-writers.mjs` (the scanner's `MUTATORS`), a test
 * that records every write the driver is asked to make (`a-read-spill-is-kept-outside-every-space-db`), and the parks
 * in `_write-faults.mjs` and the -db tests that predate it. The lists did not agree with each other, and each was a
 * second copy of a table the server already holds and gates:
 * `COLLECTION_METHOD_EFFECT` in `db/record-write-observer.ts` classifies every method on the driver's `Collection`,
 * and its own gate fails on a method it does not classify, so a driver upgrade that adds a write method is caught
 * there once instead of being missed by every copy.
 *
 * ## The guard a hand-written copy drops
 *
 * **The floor.** A derivation that finds nothing passes every loop written over it — a scanner with no mutators sees
 * no writer and calls every door clean. This throws below the floor in its assertion (the driver's document methods
 * when it was written), and when `bulkWrite` or `findOneAndDelete` (the two a hand list most often left out) is missing.
 *
 * ## What it is not
 *
 * A `drop` or `rename` FORGETS a collection rather than changing a document, so it is not here. And the result
 * includes the two bulk-op BUILDERS (`initializeOrderedBulkOp`, `initializeUnorderedBulkOp`): they return a builder
 * synchronously, so a caller that wraps methods in an `async` function must not wrap them — `ASYNC_MUTATORS` is the
 * rest, for that caller (`_write-faults.mjs`'s park).
 */
import assert from 'node:assert/strict';
import { COLLECTION_METHOD_EFFECT } from '../../server/dist/db/record-write-observer.js';

/** Every driver `Collection` method that may add, change or remove a document. */
export const MUTATORS = Object.freeze(Object.entries(COLLECTION_METHOD_EFFECT)
  .filter(([, effect]) => typeof effect === 'object' && (effect.write || effect.delete))
  .map(([method]) => method));

assert.ok(MUTATORS.length >= 11 && MUTATORS.includes('bulkWrite') && MUTATORS.includes('findOneAndDelete'),
  `only ${MUTATORS.length} document-changing method(s) read from COLLECTION_METHOD_EFFECT — the derivation is broken: `
  + MUTATORS.join(', '));

/** `MUTATORS` without the synchronous bulk-op builders: the ones a caller may wrap in an `async` function. */
export const ASYNC_MUTATORS = Object.freeze(MUTATORS.filter(m => !/^initialize\w*BulkOp$/.test(m)));
