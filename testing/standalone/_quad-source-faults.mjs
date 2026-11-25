/**
 * What the quad source's fault tests share (bundle-271, Q-756): the recorder of a process-level fault, and the two faults a read of the
 * store can be given, both against the REAL driver the server uses.
 *
 * ## What it prevents
 *
 * - **A fault no test saw.** An unhandled rejection or an uncaught exception does not fail a test that finished before it landed (the
 *   server's own handler ends the process on one: `process.exit(1)`). {@link recordProcessFaults} listens from the start of a file to its
 *   end, and `quiet()` is the assertion every SPARQL db file that runs queries ends with.
 * - **A fault injected into a class the server does not use.** The error classes and the prototypes patched are the ones the SERVER's
 *   `mongodb` resolves to (`createRequire` from the built server), never the test's own copy: the server tells a store failure by
 *   `instanceof MongoError`, and a copy from another install is none.
 *
 * ## What it does not do
 *
 * It does not build a store; the file opens its own doors. A patch is undone by the function it returns, and a file undoes it in `finally`.
 */
import { createRequire } from 'node:module';
import assert from 'node:assert/strict';
import { elapse } from '../_shared/sleep.mjs';

/** The `mongodb` package the built server loads. */
export const serverDriver = () => createRequire(new URL('../../server/dist/db/mongo.js', import.meta.url))('mongodb');

/**
 * Record every unhandled rejection and uncaught exception of the process from now until `stop()`.
 * @returns `faults` (what was raised), `quiet()` (settles, then asserts none was raised) and `stop()` (lets the listeners go).
 */
export function recordProcessFaults() {
  const faults = [];
  const onRaised = (kind) => (err) => faults.push(`${kind}: ${err instanceof Error ? `${err.name}: ${err.message}` : String(err)}`);
  const rejected = onRaised('unhandledRejection');
  const thrown = onRaised('uncaughtException');
  process.on('unhandledRejection', rejected);
  process.on('uncaughtException', thrown);
  const stop = () => { process.off('unhandledRejection', rejected); process.off('uncaughtException', thrown); };
  return {
    faults,
    stop,
    async quiet() {
      // An unhandled rejection is reported once the microtasks of its turn have drained, so one turn of the loop after the work is enough.
      await elapse(100, 'absence window: a fault the work raised lands within a turn of the loop after it');
      assert.deepEqual(faults, [], 'the process raised faults while the queries ran');
    },
  };
}

/**
 * Every find's first batch answers after `delayMs` with `error`: the store's cursor that was ended under a read in flight (what the driver
 * throws when a session ends while a batch is on its way).
 * @returns the function that puts the driver back.
 */
export function failFirstBatches(delayMs, makeError) {
  const { FindCursor } = serverDriver();
  const real = FindCursor.prototype.hasNext;
  FindCursor.prototype.hasNext = async function slowThenFailing() {
    await elapse(delayMs, 'simulated latency: the find\'s first batch is on its way for this long');
    throw makeError();
  };
  return () => { FindCursor.prototype.hasNext = real; };
}

/**
 * Every find's first batch answers `delayMs` late, with what the store answers.
 * @returns the function that puts the driver back.
 */
export function delayFirstBatches(delayMs) {
  const { FindCursor } = serverDriver();
  const real = FindCursor.prototype.hasNext;
  FindCursor.prototype.hasNext = async function slow(...args) {
    await elapse(delayMs, 'simulated latency: the find\'s first batch is on its way for this long');
    return real.apply(this, args);
  };
  return () => { FindCursor.prototype.hasNext = real; };
}

/**
 * Every count of a collection (`countDocuments`, `estimatedDocumentCount`) fails with `makeError()`.
 * @returns the function that puts the driver back.
 */
export function failCounts(makeError) {
  const { Collection } = serverDriver();
  const real = { countDocuments: Collection.prototype.countDocuments, estimatedDocumentCount: Collection.prototype.estimatedDocumentCount };
  const failing = async () => { throw makeError(); };
  Collection.prototype.countDocuments = failing;
  Collection.prototype.estimatedDocumentCount = failing;
  return () => { Object.assign(Collection.prototype, real); };
}
