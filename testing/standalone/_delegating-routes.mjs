/**
 * Does this REST route hold an implementation, or hand its body to a tool?
 *
 * ## Why this is a module rather than a regex each gate writes
 *
 * `B-9` put every capability behind one function, `callTool`, and the legacy REST routes are collapsing onto
 * it one at a time — `POST /api/brain/recall` first, with `filter` and `similar` behind it. Every gate that
 * counted implementation sites across the two doors goes red on each collapse, and each one's repair is the
 * same sentence: *a route that delegates is covered by the tool's site, not missing its own.*
 *
 * Written per gate, that sentence becomes a dozen slightly different regexes, and the one that is subtly
 * wrong passes for ever — a gate that cannot find the delegation reports the route as missing the behaviour
 * it is checking, which reads as a finding.
 *
 * ## The forgettable part, which is why this throws rather than returning false
 *
 * The condition is not *"does `callTool` appear"* — it is **that and nothing else reads the body**. A route
 * that delegates and also peeks at one field (a `space` for a log line, a `topK` clamped "just here") has
 * two implementations of one contract, and the second is invisible precisely because the route looks
 * delegated. A hand-written copy drops that half, because it is the half that looks like paranoia.
 *
 * So {@link delegationOf} answers with a REASON when the shape is nearly-but-not-delegation, and callers are
 * expected to fail on it rather than treat it as "not delegated, carry on".
 */

/** The block of source from a route registration to the next one — a handler, however long. */
export function routeBody(src, path, routerName = 'searchRouter') {
  const at = src.indexOf(`${routerName}.post('${path}'`);
  if (at < 0) return null;
  const next = src.indexOf(`${routerName}.`, at + routerName.length + 6);
  return src.slice(at, next < 0 ? src.length : next);
}

/**
 * What a handler does with its body: `{ tool }`, `{ tool, impure }`, or `null` for an ordinary handler.
 *
 * `impure` names a delegating route that ALSO reads the body itself — see the docblock. Callers must treat
 * it as a failure, not as an ordinary route: it is the one way a collapse can be half-done and look finished.
 */
export function delegationOf(body) {
  const named = /callTool\(\s*\{\s*name:\s*'([a-z_0-9]+)'/.exec(body);
  if (!named) return null;
  const reads = [...body.matchAll(/req\.body/g)].length;
  return reads === 1 ? { tool: named[1] } : { tool: named[1], impure: reads - 1 };
}

/** Convenience for the common case: delegated AND clean. Throws on the half-done shape rather than lying. */
export function delegatesCleanly(body, label = 'a route') {
  const d = delegationOf(body);
  if (!d) return false;
  if (d.impure) {
    throw new Error(
      `${label} hands its body to the '${d.tool}' tool and then reads it ${d.impure} more time(s). That is two `
      + 'implementations of one contract, with the second invisible because the route looks delegated.');
  }
  return true;
}
