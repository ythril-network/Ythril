/**
 * The SPARQL limits of the scratch Ythril instance: `sparql.timeoutMs`, `sparql.maxRecordsRead`, `sparql.maxResults`.
 *
 * The server reads them live from its config (`server/src/config/sparql-limits.ts`); an absent key is its default and a
 * value outside its bounds refuses the config. This module reads and raises them the same way, so a run records the
 * limits it was measured under and a raise that the server would refuse is refused here first.
 *
 * ## What this prevents
 *
 * - **A timing taken under limits nobody wrote down.** The run reads the limits from the instance's config and the
 *   record carries all three.
 * - **A raise the server refuses.** A value past its ceiling, or not a whole number, throws naming the key; the config is
 *   never written with it.
 * - **A raise that drops other config.** `withLimits` returns a copy changing the `sparql` block only.
 */

/** The defaults and the bounds of the server's `sparql-limits.ts`; a change there is a change here (the README names it). */
export const DEFAULTS = Object.freeze({ timeoutMs: 30_000, maxRecordsRead: 200_000, maxResults: 10_000 });
export const CEILINGS = Object.freeze({ timeoutMs: 300_000, maxRecordsRead: 10_000_000, maxResults: 1_000_000 });
const FLOORS = Object.freeze({ timeoutMs: 1_000, maxRecordsRead: 1_000, maxResults: 1 });
const KEYS = Object.keys(DEFAULTS);

function checked(key, value) {
  if (!Number.isInteger(value) || value < FLOORS[key] || value > CEILINGS[key]) {
    throw new Error(`sparql.${key} must be a whole number from ${FLOORS[key]} to ${CEILINGS[key]}, got ${JSON.stringify(value)}`);
  }
  return value;
}

/** The limits in effect for a config: every key set, an absent one at its default. */
export function limitsOf(config) {
  const block = config?.sparql ?? {};
  return Object.fromEntries(KEYS.map((k) => [k, block[k] === undefined ? DEFAULTS[k] : checked(k, block[k])]));
}

/** A copy of `config` with the three limits set, nothing else changed. */
export function withLimits(config, limits) {
  const sparql = Object.fromEntries(KEYS.map((k) => [k, checked(k, limits?.[k])]));
  return { ...config, sparql };
}
