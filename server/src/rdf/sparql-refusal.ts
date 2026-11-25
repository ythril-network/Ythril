/**
 * The named refusals of a SPARQL read (bundle-271, Q-756; design §1.3, r2 R2, R3, R4): each bound and each wall answers with a status and a
 * code in the `{ error, code }` shape every `/api/` route shares, never with a short answer that looks whole.
 *
 * ## What it prevents
 *
 * - **A refusal routed by its message.** The quad source, the engine and the doors throw and catch {@link SparqlRefusal}, a class with its
 *   status and code: a door answers by the class, never by matching words.
 * - **A code the guide does not list.** {@link SPARQL_REFUSAL_CODES} is every code a SPARQL read answers, for the guide's gate.
 * - **The query in a log or a body.** No refusal here carries the query's text; a parse error names only its line and column.
 */

export const SPARQL_QUERY_TOO_LARGE = 'sparql_query_too_large';
export const SPARQL_MALFORMED = 'sparql_malformed';
export const SPARQL_FEDERATION_REFUSED = 'sparql_federation_refused';
export const SPARQL_UPDATE_NOT_HERE = 'sparql_update_not_here';
export const SPARQL_PATTERN_REFUSED = 'sparql_pattern_refused';
export const SPARQL_TIMEOUT = 'sparql_timeout';
export const SPARQL_TOO_MUCH_READ = 'sparql_too_much_read';
export const SPARQL_TOO_MANY_RESULTS = 'sparql_too_many_results';
export const SPARQL_STORE_UNAVAILABLE = 'sparql_store_unavailable';
export const SPARQL_BUSY = 'sparql_busy';

/** Every code a SPARQL read answers. */
export const SPARQL_REFUSAL_CODES: readonly string[] = Object.freeze([
  SPARQL_QUERY_TOO_LARGE, SPARQL_MALFORMED, SPARQL_FEDERATION_REFUSED, SPARQL_UPDATE_NOT_HERE, SPARQL_PATTERN_REFUSED, SPARQL_TIMEOUT,
  SPARQL_TOO_MUCH_READ, SPARQL_TOO_MANY_RESULTS, SPARQL_STORE_UNAVAILABLE, SPARQL_BUSY,
]);

/** The statuses a SPARQL read refuses with. */
export const SPARQL_BAD_REQUEST = 400;
export const SPARQL_TOO_LARGE = 413;
export const SPARQL_UNAVAILABLE = 503;
/** How deep a refusal is looked for in the causes an engine wrapped it in. */
const CAUSE_DEPTH_MAX = 8;

/** The wait a query ended by its deadline or a store that did not answer is told to keep before trying again, in seconds. */
export const SPARQL_RETRY_AFTER_SECONDS = 5;

/** A SPARQL read refused or ended by a bound: its HTTP status, its code, and the words a caller reads. */
export class SparqlRefusal extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly retryAfterSeconds?: number,
  ) {
    super(message);
    this.name = 'SparqlRefusal';
  }

  /** The refusal as the `{ error, code }` body a door answers. */
  body(): { error: string; code: string; retryAfterSeconds?: number } {
    return { error: this.message, code: this.code, ...(this.retryAfterSeconds !== undefined ? { retryAfterSeconds: this.retryAfterSeconds } : {}) };
  }
}

/** Is `err` a SPARQL refusal, here or as the cause an engine wrapped it in? Answers the refusal itself. */
export function sparqlRefusalOf(err: unknown): SparqlRefusal | null {
  let e: unknown = err;
  for (let depth = 0; depth < CAUSE_DEPTH_MAX && e !== null && e !== undefined; depth++) {
    if (e instanceof SparqlRefusal) return e;
    e = (e as { cause?: unknown }).cause;
  }
  return null;
}

/** The deadline passed: unavailable, try again. */
export const timeoutRefusal = (): SparqlRefusal => new SparqlRefusal(SPARQL_UNAVAILABLE, SPARQL_TIMEOUT,
  'The query did not finish inside the server\'s time bound (sparql.timeoutMs), so nothing of it is answered: narrow it or try again', SPARQL_RETRY_AFTER_SECONDS);

/** The read cap passed: too large. */
export const tooMuchReadRefusal = (cap: number): SparqlRefusal => new SparqlRefusal(SPARQL_TOO_LARGE, SPARQL_TOO_MUCH_READ,
  `The query reads more than ${cap} records (sparql.maxRecordsRead), so nothing of it is answered: bind more of its patterns`);
