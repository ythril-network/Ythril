/**
 * The in-process doors the CEL rules `-db` tests drive: the REST route handlers and `callTool`, the one dispatch the MCP
 * transport and `POST /api/<tool>` both hand every request to (F-46).
 *
 * ## What a hand-written copy drops
 *
 * **The caller's rights.** A door driven with an admin token proves the door runs; it cannot prove which rung a write needs.
 * Every driver here takes the rights of the caller as an argument, so "a schema write may not change a rule" is asked of the
 * rung it names (`rightsAt`) and never of whoever happened to be convenient.
 *
 * **The guards between the route and its handler.** The route's final handler is not the door: `requireSettingsFields` sits
 * in the chain of `PATCH /api/spaces/:id` and is where `meta.<field>` meets `SPACE_FIELD_RIGHTS`. `chainFrom` runs the layers
 * from `denyReadOnly` on (everything before it resolves the bearer token and the area rung, which a test with no token store
 * has no way to run, and which `a-rights-row-is-reachable-at-the-rung-it-names` holds on its own), so a guard that is in
 * the chain is in the test, and a guard dropped from it is a test that goes red.
 *
 * It does not stub the planner, the validators or the store: the config is a real file the server's own loader reads.
 *
 * `scratchEnv` must run BEFORE any server module is imported (the loader reads `CONFIG_PATH` once), which is why the test
 * files import this module statically and everything of the server's dynamically, after calling it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const DIST = '../../server/dist/';

/** Point the server at a scratch config and data directory, and keep models offline. Returns where it put them. */
export function scratchEnv(prefix) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const configPath = path.join(tmpDir, 'config.json');
  process.env['CONFIG_PATH'] = configPath;
  process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
  process.env['YTHRIL_MODELS_OFFLINE'] = '1';
  return { tmpDir, configPath, cleanup: () => { try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } } };
}

/** An Express-shaped response that records what a handler answered. */
export function response() {
  return {
    statusCode: 200, body: undefined, headers: {},
    status(c) { this.statusCode = c; return this; },
    json(b) { this.body = b; return this; },
    setHeader(k, v) { this.headers[k] = v; return this; }, set(k, v) { this.headers[k] = v; return this; }, get(k) { return this.headers[k]; },
    send(b) { this.body = b; return this; }, end() { return this; },
  };
}

let tokenSerial = 0;

/** The rights of a caller holding `rungs` (`{ schema: 'write', knowledge: 'read' }`) on `space`, every other area `none`. */
export async function rightsAt(space, rungs) {
  const { SPACE_AREAS } = await import(`${DIST}config/rights-shape.js`);
  const held = Object.fromEntries(SPACE_AREAS.map(a => [a, rungs[a] ?? 'none']));
  return { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [space]: held } };
}

/** Instance administrator: every right on every space. */
export async function adminRights() {
  const { SPACE_AREAS } = await import(`${DIST}config/rights-shape.js`);
  return { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
}

/** A route layer of `router` by verb and path, as Express registered it. */
export function routeOf(router, verb, routePath) {
  const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods?.[verb]);
  assert_(layer, `${verb.toUpperCase()} ${routePath} is gone or moved: re-anchor this test`);
  return layer.route.stack.map(s => s.handle);
}

function assert_(ok, message) { if (!ok) throw new Error(message); }

/**
 * The handlers of a route from the one named `from` on, run in order the way Express runs them. A handler that answers
 * without calling `next` ends the chain. A thrown error answers the way `app.ts`'s global error handler does.
 */
export async function chainFrom(handlers, from, req, res) {
  const start = handlers.findIndex(h => h.name === from);
  assert_(start > -1, `no handler named ${from} in the chain (${handlers.map(h => h.name || '<anonymous>').join(', ')}): re-anchor this test`);
  for (const h of handlers.slice(start)) {
    let advanced = false;
    try {
      await h(req, res, (err) => { if (err) throw err; advanced = true; });
    } catch (err) {
      const s = err && typeof err === 'object' && typeof err.status === 'number' ? err.status : 500;
      res.status(s >= 400 && s < 600 ? s : 500).json({ error: String(err?.message ?? err) });
      return res;
    }
    if (!advanced) return res;
  }
  return res;
}

/** A request as a handler sees it after authentication. */
export function requestOf({ params = {}, query = {}, body = {}, rights, headers = {} } = {}) {
  const n = ++tokenSerial;
  return {
    params, query, body, headers, ip: '127.0.0.1',
    authToken: { id: `cel-doors-${n}`, name: `cel-doors-${n}`, rights },
    get: (h) => headers[String(h).toLowerCase()],
    auditSnapshots: undefined,
  };
}

/** `callTool` with the caller's rights; the answer is `{ status, isError, text, structured }`. */
export async function callMcp(name, args, rights) {
  const { callTool } = await import(`${DIST}mcp/call-tool.js`);
  const out = await callTool({
    name, args,
    caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: `cel-doors-${++tokenSerial}`, tokenLabel: 'cel-doors' },
  });
  return {
    status: out.status,
    isError: out.result?.isError === true,
    text: (out.result?.content ?? []).map(c => c.text ?? '').join('\n'),
    structured: out.result?.structuredContent,
  };
}

/** The one config the doors read: rewrite it and reload, so every case starts from the meta it names. */
export async function resetConfig(configPath, { spaces, instanceId = 'cel-doors' }) {
  fs.writeFileSync(configPath, JSON.stringify({ instanceId, instanceLabel: 'test', tokens: [], networks: [], spaces }, null, 2), { mode: 0o600 });
  (await import(`${DIST}config/loader.js`)).loadConfig();
}

/** What the loader holds for a space's meta right now (the store every door writes). */
export async function storedMeta(space) {
  const { getConfig } = await import(`${DIST}config/loader.js`);
  return getConfig().spaces.find(s => s.id === space)?.meta;
}

/** Every `{ field, reason }` row anywhere in an answer: a refusal nests its rows differently on each door, the rows are what is compared. */
export function violationRows(answer) {
  const rows = [];
  const walk = (v) => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    if (v && typeof v === 'object') {
      if (typeof v.field === 'string' && typeof v.reason === 'string') rows.push({ field: v.field, reason: v.reason });
      Object.values(v).forEach(walk);
    }
  };
  walk(answer);
  return rows;
}

/** The text of an MCP refusal without its `Error (<status>): ` prefix, so it compares with a REST body's `error`. */
export const withoutStatus = (text) => text.replace(/^Error \(\d+\):\s*/, '');
