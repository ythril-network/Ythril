/**
 * How a request path is read against a table of routes — the question, answered once.
 *
 * ## The question
 *
 * Express matches a route's literal segments without regard to case and accepts one trailing slash (`/API/x/` reaches `/api/x`). A table
 * that lists routes (the rights inventory `ROUTE_RIGHTS`, the audit rules `ROUTE_RULES`, the route map's patterns) is written in one
 * spelling, so a lookup keyed by the path as the caller TYPED it finds nothing for another one: the rights lookup took a re-cased route
 * for unclassified (Q-700), and the audit wrote no row for a write sent under `/API` or a delete sent with a trailing slash. Every such
 * lookup asks this module how a path is spelled for it, so the two answers cannot drift apart again.
 *
 * ## Three answers, one per way a table reads a path
 *
 * - {@link trimTrailingSlashes}: the path without its trailing slashes (`/` for the root), the case kept. For a lookup whose captured parts
 *   are evidence of what was sent (the audit's space id), matched with {@link caseBlind} patterns.
 * - {@link routeSpelling}: the same, lowercased. For a lookup by whole key or by prefix (an inventory key, `/api/` and `/mcp`).
 * - {@link caseBlind}: a pattern that ignores case, for a table of regular expressions written in one spelling.
 *
 * ## What it prevents
 *
 * A guard or a record keyed by the caller's spelling of a path: the request that is answered and then walks past the check beside it.
 */

/** The path without its trailing slashes, `/` when nothing is left; the caller's casing kept. */
export function trimTrailingSlashes(p: string): string {
  return p.replace(/\/+$/, '') || '/';
}

/** The path as a route table spells it: no trailing slashes, lowercase, `/` for the root. */
export function routeSpelling(p: string): string {
  return trimTrailingSlashes(p).toLowerCase();
}

/** The pattern, matching without regard to case (its other flags kept). A pattern already case-blind is returned as it is. */
export function caseBlind(pattern: RegExp): RegExp {
  return pattern.flags.includes('i') ? pattern : new RegExp(pattern.source, `${pattern.flags}i`);
}
