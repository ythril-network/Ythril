/**
 * The application and its MCP endpoint, as a token reaches them (bundle-284 slice 6): the REAL router stack with its authentication, rights guard and
 * rate limit, and the REGISTERED tools (`tools/list`, `tools/call` on `POST /mcp`).
 *
 * ## The question it answers
 *
 * "How does a database test ask a door the way a client does, with a token of given rights, and not through the handler of a router or a tool it
 * imported itself?" A test that imports `api/spaces-unconverted.js` and calls a handler tests a router nobody mounted: it passes while `app.ts`
 * does not mount it, and while the tool list does not offer the tool. Both are the doors the test must reach, so it starts the app
 * (`listenApp`, the one door that starts it) and speaks HTTP.
 *
 * ## What it prevents
 *
 * - A caller's rights decided by a copy: a token is minted through `createToken` and its STORED rights are returned (`rights`), so a test compares the
 *   mounted door with the act asked as the same caller, never with rights the server would not have kept.
 * - A tool "called" that the list does not offer: `toolNames` is the `tools/list` this token gets, so a mutating tool hidden from a read-only token
 *   is seen as hidden, not assumed.
 *
 * Needs the config and the database a door opened (`openB81cDoor`, `openConvertDoor`) before `openMountedDoor` is called, and a prior `npm run build`.
 */
import { listenApp } from '../_shared/in-process-app.mjs';

/** One JSON-RPC request on `POST /mcp`, answered as the message that carries its id. */
async function rpcAs(url, key, method, params) {
  const r = await fetch(`${url}/mcp`, {
    method: 'POST', signal: AbortSignal.timeout(60_000),
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const raw = await r.text();
  const data = /^(?:event|data):/m.test(raw) ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
  let message = {};
  try { message = JSON.parse(data); } catch { /* not JSON: the status and the empty message say so */ }
  return { status: r.status, message };
}

/**
 * Start the application on loopback. `rights` of `mint` is what the token record stored.
 * @returns {Promise<{ url: string, close: () => Promise<void>, mint: Function, rest: Function, mcp: Function, toolNames: Function }>}
 */
export async function openMountedDoor() {
  const tokens = await import('../../server/dist/auth/tokens.js');
  const server = await listenApp();

  /** A token of the given rights (`admin: true` for an instance administrator): its key and the rights the record keeps. */
  async function mint(name, rights) {
    const { record, plaintext } = await tokens.createToken({ name, ...(rights === 'admin' ? { admin: true } : { rights }) });
    return { key: plaintext, rights: record.rights, id: record.id };
  }

  /** `{ status, body }` of one REST call as `key`: the query string is part of `url`; a body is sent as JSON. */
  async function rest(key, method, url, body) {
    const r = await fetch(`${server.url}${url}`, {
      method, signal: AbortSignal.timeout(60_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await r.text();
    let parsed; try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
    return { status: r.status, body: parsed };
  }

  /** `tools/call` as `key`: `{ isError, text, body }`, `body` the tool result's `structuredContent`. */
  async function mcp(key, name, args) {
    const { status, message } = await rpcAs(server.url, key, 'tools/call', { name, arguments: args });
    const text = (message.result?.content ?? []).map(c => c.text ?? '').join('\n') || message.error?.message || '';
    return { status, isError: message.result?.isError === true || !!message.error, text, body: message.result?.structuredContent ?? null };
  }

  /** The names `tools/list` offers `key`. */
  async function toolNames(key) {
    const { message } = await rpcAs(server.url, key, 'tools/list', {});
    return (message.result?.tools ?? []).map(t => t.name);
  }

  return { url: server.url, close: () => server.close(), mint, rest, mcp, toolNames };
}
