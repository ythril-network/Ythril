#!/usr/bin/env node
/**
 * check-i-security-rate-limits: every mutating, expensive or outbound route is rate-limited.
 *
 * Rule (the flow node's stated assertion): enumerate the mutating, expensive and outbound routes; the limiter middleware is in each chain.
 *
 *   - The routes are the server's mounted routes (`testing/standalone/_routes.mjs`), each with its router's own guards in front of its chain
 *     (`_route-chains.mjs`). In scope: every route that is not a `GET`, and every `GET` whose handler reaches an expensive or outbound
 *     primitive (`fetch(`, a child process, a file stream, a streamed write).
 *   - A route is rate-limited when its chain names a limiter (any `const X = rateLimit(` of the server's code, found, not listed), or a guard
 *     that meters the token: `attachToken` of `auth/middleware.ts` runs the per-token limiter, so every guard that reaches it (read from the
 *     guard's body, not its name) bounds the caller by its token's own quota. A route with neither answers any caller without a count.
 *   - A route on the tool door is not a route here: `heavy` tools are counted by `callTool`, which the one route that serves them reaches
 *     through a metering guard.
 *   - Exceptions live only in `check-i-security-rate-limits.allow.json` beside this file (`{ id: "METHOD path", reason, reviewBy }`), through
 *     `_allow.mjs`: a reason, a date not yet past, and an entry that excuses nothing is itself a violation. The verdict says how many it used.
 *
 * The failure that bought it (Q-876): the check is named by the plan and audit lenses and answered "cannot answer" from a placeholder, so
 * each bundle that added a route judged by reading whether a limiter sat in its chain.
 *
 *     node tools/flow-checks/check-i-security-rate-limits.mjs
 */
import { holds, violated, answer, isMain } from './_verdict.mjs';
import { allowFileFor, readAllow, applyAllow, today } from './_allow.mjs';
import { routesWithChains, guardFacts, limiterNames, chainFacts, serverSources, middlewareText } from './_route-chains.mjs';

/** A handler that spends real work or leaves the process: an outbound request, a child process, a file stream, a streamed answer. */
const EXPENSIVE_PRIMITIVE = /\b(?:fetch|execFile|execFileSync|spawn|createReadStream|pipeline)\s*\(|\.pipe\s*\(|\bres\.write\s*\(/;

/** Is the route in the rule's scope: mutating, or a read whose handler is expensive or outbound. */
export const inScope = (r) => r.method !== 'GET' || EXPENSIVE_PRIMITIVE.test(r.source ?? '');

/**
 * `findings` for every in-scope route whose chain holds no limiter and no metering guard, as `[{ id, text }]`.
 *
 * @param {Array<{method:string,path:string,file:string,all:string,source?:string}>} routes from `routesWithChains`
 * @param {Map<string, object>} guards from `guardFacts`
 * @param {Set<string>} limiters from `limiterNames`
 */
export function unlimitedRoutes(routes, guards, limiters) {
  return routes.filter(inScope).flatMap((r) => {
    const f = chainFacts(r.all, guards, limiters);
    return f.limiters.length || f.metered ? [] : [{ id: `${r.method} ${r.path}`, text: `${r.method} ${r.path} (${r.file}) carries no limiter and no metering guard: [${r.all.slice(0, 80)}]` }];
  });
}

export function decide(routes, guards, limiters, allow, todayDate) {
  if (!limiters.size) throw new Error('no rateLimit( limiter found in the server code: the scan broke, not the routes');
  const scoped = routes.filter(inScope).length;
  const { problem, open, used } = applyAllow(unlimitedRoutes(routes, guards, limiters), allow, todayDate);
  if (problem) return violated(problem);
  const tail = `${scoped} mutating or expensive route(s) of ${routes.length}, ${limiters.size} limiter(s), ${used} exception(s) used`;
  return open.length
    ? violated(`${open.length} route(s) without a limiter: ${open.slice(0, 5).map((f) => f.text).join('; ')}${open.length > 5 ? `; and ${open.length - 5} more` : ''} (${tail})`)
    : holds(`every mutating or expensive route is rate-limited by a limiter in its chain or a guard that meters the token (${tail})`);
}

if (isMain(import.meta.url)) {
  await answer(() => decide(
    routesWithChains(),
    guardFacts(middlewareText()),
    limiterNames(serverSources()),
    readAllow(allowFileFor(import.meta.url)),
    today(),
  ));
}
