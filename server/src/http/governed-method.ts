/**
 * The method a request is governed as — the question, answered once.
 *
 * Express answers a `HEAD` with the route registered for `GET`: the same guards, the same handler, the body left out. The tables
 * keyed by method (the rights inventory `ROUTE_RIGHTS`, the audit rules) hold `GET` rows and no `HEAD` rows, so a lookup by the
 * method as sent found nothing for a `HEAD`: the area rung took it for unclassified and asked the reach check alone, and the audit
 * wrote no row. Every lookup of such a table asks this instead, so a `HEAD` is judged and recorded as the `GET` it mirrors. Only
 * `HEAD` maps: every other method is its own question (an `OPTIONS` or an unknown verb never reaches a route's handlers).
 *
 * What it prevents: a decision keyed on the request method that a `HEAD` walks past because the table it reads spells only `GET`.
 */
export function governedMethod(method: string): string {
  const upper = method.toUpperCase();
  return upper === 'HEAD' ? 'GET' : upper;
}
