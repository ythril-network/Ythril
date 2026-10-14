/**
 * Drive a tool call and a REST route handler in-process against a real Mongo, past rate limit and auth — the question
 * "what does this instance answer a write it refuses, on each door", asked once for every test that asks it.
 *
 * ## Why a module
 *
 * Four tests of the refusal bodies (`a-refused-merge-...`, `an-mcp-record-write-...`, `a-bulk-refusal-...`,
 * `an-mcp-write-refusal-is-audited-...`) each need the same four things: a config with strict spaces, the server's own
 * Mongo layer pointed at a harness database, an admin token that reaches every space, and the dispatch both the MCP transport
 * and `POST /api/<tool>` run (`callTool`). The setup is `openPushDoor`'s (it writes the config, opens the harness
 * database and initialises each space the way production does); this adds the caller.
 *
 * ## What a hand-written copy drops
 *
 * **The rights shape.** An admin that is built by hand with a typo in an area name holds nothing, and a refusal is then the
 * 403 of the missing right rather than the refusal under test. The rights are built from the server's own `SPACE_AREAS`.
 *
 * **Both doors of one tool.** `transport: 'mcp'` is the MCP door and `transport: 'rest'` is `POST /api/<tool>`; the two
 * differ in what `callTool` does with the arguments' budget and nothing else, and a test that drives one has said nothing
 * about the other. `call(name, args, { transport })` takes either.
 */
import { openPushDoor } from './_push-door.mjs';

/**
 * @param {object} o
 * @param {string} o.suite   harness database slug (unique per test file: `a-db-harness-name-is-unique`)
 * @param {object[]} o.spaces  config `spaces` entries
 */
export async function openToolDoor({ suite, spaces }) {
  process.env['YTHRIL_MODELS_OFFLINE'] = '1';
  const door = await openPushDoor({ suite, spaces });
  const { callTool } = await import('../../server/dist/mcp/call-tool.js');
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  let serial = 0;

  /** One tool call as the dispatch answers it: `{ tokenId, status, result, text, structured }` — `tokenId` names the audit rows it left. */
  async function call(name, args, { rights = ADMIN, transport = 'mcp' } = {}) {
    const id = `${suite}-token-${++serial}`;
    const out = await callTool({
      name, args,
      caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport, tokenId: id, tokenLabel: id },
    });
    return {
      tokenId: id, status: out.status, result: out.result,
      text: (out.result.content ?? []).map(c => c.text ?? '').join('\n'),
      structured: out.result.structuredContent,
    };
  }

  /** The final handler of a route on a router, as the merge-door test finds it: past every middleware. */
  function routeHandler(router, method, routePath) {
    const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods?.[method]);
    if (!layer) throw new Error(`${method.toUpperCase()} ${routePath} is gone or moved — re-anchor this test`);
    return layer.route.stack.at(-1).handle;
  }

  /** Invoke a route handler as a request would reach it; resolves `{ status, body }` (a handler that throws is the global handler's 500). */
  async function request(handler, { params = {}, query = {}, body = {}, headers = {}, rights = ADMIN } = {}) {
    const res = {
      statusCode: 200, body: undefined,
      status(c) { this.statusCode = c; return this; },
      json(b) { this.body = b; return this; },
      end() { return this; },
      setHeader() { return this; }, set() { return this; }, get() { return undefined; },
    };
    const id = `${suite}-token-${++serial}`;
    const req = {
      params, query, body, headers, ip: '127.0.0.1', authToken: { id, name: id, rights },
      get: (h) => headers[String(h).toLowerCase()],
    };
    try { await handler(req, res); } catch (err) {
      const s = err && typeof err === 'object' && typeof err.status === 'number' ? err.status : undefined;
      return { status: s !== undefined && s >= 400 && s < 600 ? s : 500, body: { error: String(err?.message ?? err) }, threw: err };
    }
    return { status: res.statusCode, body: res.body };
  }

  return { ...door, ADMIN, call, routeHandler, request };
}
