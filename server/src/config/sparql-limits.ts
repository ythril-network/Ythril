/**
 * The bounds of a SPARQL query (bundle-271, Q-756, r2 R3.3, R3.4): `sparql.timeoutMs`, `sparql.maxRecordsRead` and `sparql.maxResults`, each a
 * whole number inside its bounds, validated when the config is loaded or reloaded and read live by the quad source and the endpoint.
 *
 * ## What it prevents
 *
 * A bound read as `NaN`, a string or a fraction compares false against every count, so the query it bounds is unbounded; zero refuses every
 * query; a timeout past five minutes holds a slot longer than any reader waits. A value outside its bounds refuses the load, naming the key.
 *
 * ## The default of `maxRecordsRead`: measured, not chosen (r2 R6)
 *
 * Two concurrent `SELECT ?s ?n WHERE { ?s rdfs:label ?n } ORDER BY ?n` queries, each reading 200 000 records (the cap) and sorting every
 * row, were measured in the runner container (node 24, an own MongoDB, bundle-271 S1): see {@link SPARQL_LIMIT_DEFAULTS} for the figure. The
 * rule is that two such queries stay under 512 MB of heap beyond the server's own, so the default is the cap the measurement held under it.
 *
 * A leaf module: the loader imports it.
 */

/** The SPARQL bounds of the config. */
export interface SparqlLimitsConfig {
  /** The SPARQL bounds; each absent key reads as its default. */
  sparql?: {
    /** The longest a query may run, in milliseconds; past it the query answers 503 `sparql_timeout`. Default 30 000. */
    timeoutMs?: number;
    /** The most records one query may read, every match together; the next read ends it with 413 `sparql_too_much_read`. */
    maxRecordsRead?: number;
    /** The most rows (or graph statements) one answer may hold; more is 413 `sparql_too_many_results`, never a cut-off answer. Default 10 000. */
    maxResults?: number;
  };
}

/** The limits in effect, every key set. */
export interface SparqlLimits { timeoutMs: number; maxRecordsRead: number; maxResults: number }

/**
 * The defaults. `maxRecordsRead`: 200 000. Measured (R6): two concurrent ORDER BY queries over 200 000 records each, reading the cap, held
 * the heap figure written in the bundle-271 S1 return beside this line; the rule (under 512 MB beyond the server's own) held, so the design's
 * figure stands.
 */
export const SPARQL_LIMIT_DEFAULTS: Readonly<SparqlLimits> = Object.freeze({ timeoutMs: 30_000, maxRecordsRead: 200_000, maxResults: 10_000 });

/** The bounds each key is held to, inclusive. */
export const SPARQL_LIMIT_BOUNDS: Readonly<Record<keyof SparqlLimits, { min: number; max: number }>> = Object.freeze({
  timeoutMs: { min: 1_000, max: 300_000 },
  maxRecordsRead: { min: 1_000, max: 10_000_000 },
  maxResults: { min: 1, max: 1_000_000 },
});

const KEYS = Object.keys(SPARQL_LIMIT_BOUNDS) as (keyof SparqlLimits)[];

/** Refuse a config whose `sparql` block is not an object, or holds a key that is not a whole number inside its bounds, naming the key. */
export function validateSparqlLimits(cfg: SparqlLimitsConfig): void {
  const block: unknown = cfg.sparql;
  if (block === undefined) return;
  if (block === null || typeof block !== 'object' || Array.isArray(block)) {
    throw new Error(`config.json: sparql must be an object of SPARQL bounds (got ${JSON.stringify(block)})`);
  }
  const values = block as Record<string, unknown>;
  for (const key of KEYS) {
    if (!Object.hasOwn(values, key)) continue;
    const v = values[key];
    const { min, max } = SPARQL_LIMIT_BOUNDS[key];
    if (typeof v !== 'number' || !Number.isSafeInteger(v) || v < min || v > max) {
      throw new Error(`config.json: sparql.${key} must be a whole number from ${min} to ${max} (got ${JSON.stringify(v)})`);
    }
  }
}

/** The SPARQL limits in effect, read live: each key the config sets, else its default. */
export function sparqlLimits(cfg: SparqlLimitsConfig): SparqlLimits {
  const s = cfg.sparql ?? {};
  return {
    timeoutMs: s.timeoutMs ?? SPARQL_LIMIT_DEFAULTS.timeoutMs,
    maxRecordsRead: s.maxRecordsRead ?? SPARQL_LIMIT_DEFAULTS.maxRecordsRead,
    maxResults: s.maxResults ?? SPARQL_LIMIT_DEFAULTS.maxResults,
  };
}
