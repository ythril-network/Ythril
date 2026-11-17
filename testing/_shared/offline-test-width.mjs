/**
 * How many test files each of several concurrent `node --test` units may run at once, so that all of them together stay within the cap
 * (Q-863, bundle-310).
 *
 * ## What it prevents
 *
 * The flows' rule is that a project's offline test files run concurrently, at most 8 at a time (convention-offline-tests-run-in-parallel).
 * Preflight runs its pure batches as several units at once, each with its own `--test-concurrency`, so the files alive at one moment are the
 * units times the workers per unit. Rounding the workers per unit up (`ceil(cores / units)`) puts the product past the cap on most machines.
 * The product is computed here, rounded down and capped, so no caller can round it past the limit; a unit count above the cap is refused,
 * because even one worker each would exceed it.
 */
import { availableParallelism } from 'node:os';

/** The most offline test files alive at once, over every unit (convention-offline-tests-run-in-parallel). */
export const OFFLINE_TEST_FILE_CAP = 8;

/**
 * The `--test-concurrency` each of `units` concurrent units gets: `floor(min(cap, cores) / units)`, at least 1, so
 * `units × workersPerUnit(units)` never exceeds `min(cap, cores)` once the cores cover the units, and never the cap. Throws a RangeError
 * when `units` is not an integer from 1 to the cap.
 */
export function workersPerUnit(units, cores = availableParallelism(), cap = OFFLINE_TEST_FILE_CAP) {
  if (!Number.isInteger(units) || units < 1 || units > cap) {
    throw new RangeError(`workersPerUnit: units must be an integer from 1 to ${cap}, got ${String(units)}`);
  }
  return Math.max(1, Math.floor(Math.min(cap, cores) / units));
}
