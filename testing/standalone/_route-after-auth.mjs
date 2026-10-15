/**
 * Call a route the way a request that PASSED authentication reaches it — answered once.
 *
 * ## The question it answers
 *
 * *"What does this route do for a caller whose bearer token has already been accepted?"* The route's last handler is not the
 * door: a guard registered between `requireAuth` and the handler (the standing question of a governance route, Q-454; the
 * rights guards of a settings route) is part of the route and not part of the handler. `callRoute` in
 * `_vote-round-instance.mjs` runs the last handler alone, so a test written over it passes when that guard is missing from
 * the chain, which is the failure a test of the guard exists to see.
 *
 * ## The guards a hand-written copy drops
 *
 * - **The chain is the route's own.** Every layer after the one named `requireAuth`, in registration order, run the way Express
 *   runs them: a layer that answers without calling `next` ends the chain, one that throws is the test's failure.
 * - **A chain with no `requireAuth` is refused, not started from the top.** Starting from the top would run the bearer lookup,
 *   which this harness has no token store for; starting from the first layer of a route that never authenticated would test a
 *   door nobody reaches. It throws naming the layers it found.
 * - **A chain that never answers is a failure.** A handler that falls off the end without a response reads as a hang in
 *   production and as an empty body here; the assertion names the route.
 *
 * ## What it does not do
 *
 * It does not run the rate limit, the router-level `use` layers of the parent router, or authentication. The caller hands the
 * token record `requireAuth` would have set on the request.
 */
import assert from 'node:assert/strict';
import { fakeRes } from './_vote-round-instance.mjs';

/**
 * @param {import('express').Router} router
 * @param {'get'|'post'|'put'|'patch'|'delete'} method
 * @param {string} routePath the path the route was registered with (`/networks/:networkId/votes`)
 * @param {{ params?: object, body?: object, query?: object, authToken?: object }} [request]
 * @returns {Promise<{ code: number, body: unknown }>}
 */
export async function callRouteAfterAuth(router, method, routePath, { params = {}, body = {}, query = {}, authToken } = {}) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
  assert.ok(layer, `no ${method.toUpperCase()} ${routePath} on that router — re-anchor this harness`);
  const chain = layer.route.stack.map(s => s.handle);
  const at = chain.findIndex(h => h.name === 'requireAuth');
  assert.ok(at > -1, `${method.toUpperCase()} ${routePath} has no requireAuth in its chain (${chain.map(h => h.name || '<anonymous>').join(', ')})`);
  const res = fakeRes();
  const req = { method: method.toUpperCase(), params, body, query, authToken, headers: {}, ip: '127.0.0.1', get: () => undefined };
  for (const handle of chain.slice(at + 1)) {
    let advanced = false;
    await handle(req, res, (err) => { if (err) throw err; advanced = true; });
    if (!advanced) break;
  }
  assert.ok(res.sent, `${method.toUpperCase()} ${routePath} settled without answering`);
  return { code: res.code, body: res.body };
}
