/**
 * Drive a file act through its real doors, and read what a peer can learn from it — the question "what did this
 * delete or move publish", answered once for every test that asks it (bundle-30 I15, I16).
 *
 * ## Why a module
 *
 * The tombstone tests each need the same things: a space initialised the way production initialises one, the REST
 * file router's own `DELETE` and `PATCH` handlers, MCP's `callTool` with an admin caller, and the two ways a peer
 * learns of a file tombstone. The second test that needed them was about to copy them, and the copy that drifts is
 * the one whose case passes for the wrong reason.
 *
 * ## The part a hand-written copy drops
 *
 * **"Published" is BOTH ways a peer learns of a tombstone**: what `GET /api/sync/file-tombstones` serves, and what a
 * sync cycle PUSHES (`syncFiles` against a fake peer that records what it is sent). Reading the collection instead
 * cannot tell a pending tombstone from a published one, which is the whole question; reading one door alone passes
 * when the other one forgets the filter.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { openPushDoor } from './_push-door.mjs';
import { privateHostAddress } from './_private-address.mjs';

process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
process.env['SYNC_ALLOW_INSECURE_PEERS'] = 'true';

const T0 = '2026-09-01T00:00:00.000Z';
/** What every published tombstone carries: its identity. The rest of `wireKeys()` is present when the act knew it (a row to read a version from). */
export const IDENTITY_KEYS = Object.freeze(['_id', 'deletedAt', 'path', 'spaceId']);
/**
 * The fields a file tombstone has on the wire — what a peer's `POST /file-tombstones` stores. DERIVED from the projection
 * every serving reader uses (`WIRE` in `files/tombstones.ts`, exported for this), never listed: a hand-written list was
 * right until the wire gained `issuer` and `rowSeq` (bundle-51), and a test holding "no local field leaks" against a stale
 * list either fails the new field or, worse, is edited to pass it. The floor guards the failure of a derivation — an empty
 * or reshaped `WIRE` would make every "nothing but wire fields" check pass about nothing.
 *
 * A function and not a constant: this module is imported by five suites, and a top-level read of a build that lacks the
 * export would fail all five at load for a question only one of them asks.
 */
export async function wireKeys() {
  const { WIRE } = await import('../../server/dist/files/tombstones.js');
  if (!WIRE || typeof WIRE !== 'object') {
    throw new Error('files/tombstones.ts no longer exports WIRE (the projection of a tombstone\'s wire fields) — _file-act-doors.mjs derives its wire keys from it');
  }
  const keys = Object.keys(WIRE).sort();
  if (keys.length < 4 || !IDENTITY_KEYS.every(k => keys.includes(k))) {
    throw new Error(`WIRE names ${JSON.stringify(keys)}: a tombstone's identity (${IDENTITY_KEYS}) is missing — re-anchor`);
  }
  return keys;
}
/** What "nothing was published" reads as from {@link FileActDoors.published}. */
export const NOTHING = Object.freeze({ served: [], pushed: [] });

/**
 * `POST /api/<tool>` — the third door a file act reaches, beside the file router and MCP — and the one reading of any door's answer.
 *
 * Standalone, so a suite that opens its own store (`openPushDoor`) drives the same door the same way and not through a copy of it.
 * `tool(name, args)` is the tools router's own handler, past rate limit and auth, answering as REST answers (`code`, `body`, `headers`).
 * `answerOf(a)` is `{ status, code, path, retryable, retryAfter }` of a REST, tool or MCP answer: a REST answer is its body, a tool's
 * structured answer is `data`, MCP's is `structuredContent` and has no header (`retryAfter` is undefined; its wait is `retryable`).
 */
export async function toolDoor(space) {
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  const { toolsRouter } = await import('../../server/dist/api/tools.js');
  const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  const layer = toolsRouter.stack.find(l => l.route?.path === '/:tool' && l.route.methods['post']);
  assert.ok(layer, 'no POST /:tool on the tools router — re-anchor _file-act-doors.mjs');
  const handler = layer.route.stack.at(-1).handle;
  return {
    async tool(name, args) {
      const req = { method: 'POST', params: { tool: name }, query: {}, body: { space, ...args }, headers: {}, ip: '127.0.0.1',
        authToken: { id: 't', name: 'test', rights: ADMIN }, get: () => undefined };
      const res = { code: 200, body: undefined, headers: {}, headersSent: false,
        status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
        json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
      await handler(req, res);
      return res;
    },
    answerOf(a) {
      const detail = 'code' in a ? (a.body?.data ?? a.body ?? {}) : (a.sc ?? {});
      return { status: 'code' in a ? a.code : a.status, code: detail.code, path: detail.path, retryable: detail.retryable,
        retryAfter: 'code' in a ? a.headers['retry-after'] : undefined };
    },
  };
}

/**
 * Open a door on one space, `S`, under the harness database named `suite`. Close it with `close()`.
 * `monitorCommands` opens the door with command monitoring, for `door.commandsDuring` (`openPushDoor`).
 * Skip a suite with `mongoSkipReason()` and `privateAddressSkipReason()` before calling this.
 */
export async function openFileActDoors({ suite, space: S, monitorCommands = false }) {
  const door = await openPushDoor({ suite, monitorCommands, spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
  const files = await import('../../server/dist/files/files.js');
  const { syncFiles } = await import('../../server/dist/sync/file-sync.js');
  const { callTool } = await import('../../server/dist/mcp/call-tool.js');
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  const { fileStoreRouter } = await import('../../server/dist/api/files.js');
  const handlerOf = (m, route = '/:spaceId') => {
    const layer = fileStoreRouter.stack.find(l => l.route?.path === route && l.route.methods[m]);
    assert.ok(layer, `no ${m.toUpperCase()} ${route} on the file router — re-anchor _file-act-doors.mjs`);
    return layer.route.stack.at(-1).handle;
  };
  const handlers = { DELETE: handlerOf('delete'), PATCH: handlerOf('patch') };
  const postHandlers = { upload: handlerOf('post'), mkdir: handlerOf('post', '/:spaceId/mkdir') };
  const { tool, answerOf } = await toolDoor(S);

  // A peer that records the tombstones a sync cycle pushes it, and holds no files of its own.
  const received = [];
  const app = express();
  app.post('/api/sync/file-tombstones', express.json({ limit: '10mb' }), (req, res) => {
    const page = Array.isArray(req.body?.tombstones) ? req.body.tombstones : [];
    received.push(...page);
    res.json({ applied: page.length });
  });
  app.get('/api/sync/manifest', (_req, res) => res.json({ manifest: [], spaceId: S }));
  app.use((_req, res) => res.json({}));
  const host = privateHostAddress();
  // own-listener: binds the private LAN address, because the SSRF guards block loopback
  const peer = await new Promise(r => { const s = app.listen(0, host, () => r(s)); });
  const peerUrl = `http://${host}:${peer.address().port}`;

  const root = () => path.join(process.env['DATA_ROOT'], 'files', S);

  /** What the `GET /api/sync/file-tombstones` door serves a peer. */
  async function served() {
    const body = await door.pull('/file-tombstones', { spaceId: S });
    return body.tombstones;
  }
  /** What a sync cycle pushes to a peer. */
  async function pushed() {
    received.length = 0;
    const member = { instanceId: `${suite}-peer`, label: 'File act peer', url: peerUrl };
    await syncFiles(member, S, S, `${suite}-net`, {}, () => ({ headers: { 'content-type': 'application/json' } }), false, true);
    return [...received];
  }
  async function rest(method, query, body = {}) {
    const req = { method, params: { spaceId: S }, query, body, authToken: { name: 'test' }, get: () => undefined, headers: {} };
    const res = { code: 200, body: undefined, headers: {}, headersSent: false,
      status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
    await handlers[method](req, res);
    return res;
  }
  /**
   * One `POST` through the file router's own handler, past rate limit and auth, as an admin token: `upload` (`POST /:spaceId`, a
   * whole file or one range) or `mkdir`. Answers as `rest` does (`code`, `body`, `headers`).
   */
  async function post(which, { query = {}, body = {}, headers = {} } = {}) {
    const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
    const req = { method: 'POST', params: { spaceId: S }, query, body, headers: lower, ip: '127.0.0.1',
      authToken: { id: 't', name: 'test', rights: ADMIN },
      get: (h) => lower[String(h).toLowerCase()],
      is: (type) => (lower['content-type'] ?? '').includes(type.split('/')[1]) };
    const res = { code: 200, body: undefined, headers: {}, headersSent: false,
      status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
      json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
    await postHandlers[which](req, res);
    return res;
  }
  async function mcp(tool, args) {
    const out = await callTool({ name: tool, args: { space: S, ...args },
      caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
    const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
    return { status: out.status, isError: !!out.result.isError, text, sc: out.result.structuredContent ?? {} };
  }

  return {
    door, files, root,
    /** Whether the space's files tree holds `p`. */
    onDisk: (p) => fs.existsSync(path.join(root(), p)),
    /** Every stored file tombstone, pending or not. */
    raw: () => door.coll(S, 'file_tombstones').find({}).toArray(),
    /** A file at `p` with its metadata record. */
    async seed(p, extra = {}) {
      await files.writeFile(S, p, `content of ${p}`);
      await door.coll(S, 'files').insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0, ...extra });
    },
    /** Empty the space: its records, its tombstones and its files tree. */
    async reset() {
      for (const part of ['files', 'file_tombstones', 'filemeta']) await door.coll(S, part).deleteMany({});
      fs.rmSync(root(), { recursive: true, force: true });
      fs.mkdirSync(root(), { recursive: true });
    },
    rest, post, mcp, tool, answerOf, served, pushed,
    /** Both ways a peer learns of a tombstone, by path. */
    async published() {
      const paths = (list) => list.map(t => t.path).sort();
      return { served: paths(await served()), pushed: paths(await pushed()) };
    },
    /** `via` is `REST` (the file router), `TOOL` (`POST /api/<tool>`) or anything else for MCP. */
    move: (via, src, dst) => (via === 'REST' ? rest('PATCH', { path: src }, { destination: dst })
      : via === 'TOOL' ? tool('move_file', { src, dst }) : mcp('move_file', { src, dst })),
    del: (via, p) => (via === 'REST' ? rest('DELETE', { path: p })
      : via === 'TOOL' ? tool('delete_file', { path: p }) : mcp('delete_file', { path: p })),
    /** Whether a door's answer (REST or MCP) is a failure. */
    failed: (a) => ('code' in a ? a.code >= 400 : a.isError),
    /** A door's answer as one status number. */
    statusOf: (a) => ('code' in a ? a.code : a.status),
    async close() {
      await new Promise(r => peer.close(r));
      await door.close();
    },
  };
}
