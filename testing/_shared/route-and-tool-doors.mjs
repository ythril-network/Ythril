/**
 * Ask one capability on both of its doors in-process: a REST route's own handler, and MCP's `callTool` — the question
 * "what does each door answer this caller", written once for every -db test that compares the two.
 *
 * ## Why a module
 *
 * `a-flagged-file-is-not-a-recall-result-db` and `a-withheld-field-is-never-answered-on-any-door-db` each wrote the same
 * three functions (`Q-446`): find a route's last handler, drive it with a fake request, and drive the tool dispatch. Two
 * copies is where the rule says to extract; a third would differ in what it calls a failure.
 *
 * ## What a hand-written copy drops
 *
 * **The failure verdict, the same on both doors.** A REST refusal is a status of 400 or more, or an `{ok: false}` envelope
 * from the generic tool door; an MCP refusal is `isError`. Each answer says `failed` and carries the refusal TEXT as
 * `error`, so a test comparing the two doors' words compares like with like. And the route is found by path AND method,
 * throwing when it is gone, so a moved route is a red test rather than a test of nothing.
 *
 * Setup (config, Mongo, the caller's rights) stays with each test: this answers how a door is driven, not what it reads.
 */

/** A route's last handler (past rate limit and auth); throws when the route is gone or moved. */
export function routeHandler(router, routePath, method = 'post') {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods?.[method]);
  if (!layer) throw new Error(`no ${method.toUpperCase()} ${routePath} on the router — re-anchor this test`);
  return layer.route.stack.at(-1).handle;
}

/**
 * Drive a route handler as a request would reach it. Resolves `{ status, failed, error, body }`: `body` is the generic
 * tool door's `data` when the answer is that envelope, else the body as sent.
 */
export async function viaRest(handler, body, { rights, params = {} }) {
  const req = { method: 'POST', params, query: {}, body, ip: '127.0.0.1', get: () => undefined, headers: {},
    authToken: { id: 't', name: 'test', rights } };
  const res = { code: 200, body: undefined, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader() { return this; }, set() { return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handler(req, res);
  const failed = res.code >= 400 || res.body?.ok === false;
  return { status: res.code, failed, error: failed ? String(res.body?.error ?? '') : '', body: res.body?.data ?? res.body };
}

/**
 * Drive one tool call through the dispatch MCP runs (`callTool`, handed in by the test that loaded it). Resolves
 * `{ status, failed, error, body }`: `body` is `structuredContent`, or the text parsed, or `{ error }` on a refusal.
 */
export async function viaMcp(callTool, name, args, { rights }) {
  const out = await callTool({ name, args,
    caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  const failed = out.result.isError === true;
  let parsed = out.result.structuredContent ?? null;
  if (!failed && !parsed) { try { parsed = JSON.parse(text); } catch { parsed = null; } }
  return { status: out.status, failed, error: failed ? text : '', body: failed ? { error: text } : parsed };
}
