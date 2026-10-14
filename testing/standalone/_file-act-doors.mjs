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
 *
 * ## What it also drives (bundle-113)
 *
 *  - `webhooks()` — what a file act ANNOUNCES: a subscription aimed where the SSRF guard refuses at once, so every dispatch
 *    that reaches it leaves a retry row carrying its payload, and a listener on the in-process bus. Read by the PATH in the payload
 *    (`a-byte-arrival-emits-nothing-db.test.js` is the method, copied here because the second test that needed it was about to
 *    copy it). A negative is read only after a control dispatch has been seen, so "nothing was announced" cannot be a read that
 *    came before the dispatcher's own asynchronous hop.
 *  - `links` — the link rows of files: seeded with the author the case needs (this instance, another instance, none: a link
 *    the file delete removes is the one this instance wrote), read by source, and the link tombstones a removal writes.
 *  - `conflicts` — a sync conflict record and its two resolution doors (`POST /api/conflicts/:id/resolve` and
 *    `POST /api/conflicts/bulk-resolve`) through the router's own handlers, as a token with chosen rights.
 *  - `otherSpaces` — further concrete spaces on the same door, with `seedIn` / `onDiskIn` / `rootOf` for the one a conflict is saved to.
 */
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import express from 'express';
import { openPushDoor } from './_push-door.mjs';
import { privateHostAddress } from './_private-address.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

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
export async function openFileActDoors({ suite, space: S, monitorCommands = false, otherSpaces = [] }) {
  const door = await openPushDoor({ suite, monitorCommands,
    spaces: [S, ...otherSpaces].map(id => ({ id, label: id, folders: [], meta: { suppressEmbeddings: true } })) });
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

  // ── What a file act announces (Q-469) ────────────────────────────────────────────────────────────────────────

  const RETRY_QUEUE = '_webhook_retry_queue';
  let controlSeq = 0;
  /**
   * A subscription to every event of every space, aimed at an address the SSRF guard refuses at once (`127.0.0.1:9`): a dispatch
   * that reaches it fails its first attempt and enqueues a retry row, which carries the payload it would have sent, whether the
   * dispatcher delivered it, queued it or overflowed it to the queue. Plus a listener on the in-process bus (what the live Files
   * page is told). Close it with `close()`.
   */
  async function webhooks() {
    const store = await import('../../server/dist/webhooks/store.js');
    const bus = await import('../../server/dist/brain/brain-events.js');
    const made = await store.createWebhook({ url: 'http://127.0.0.1:9/hook', secret: `${suite}-secret` });
    const seen = [];
    const unsubscribe = bus.subscribeBrainChanges(S, (ev) => { seen.push(ev); });
    const dispatches = async () => (await door.mongo.col(RETRY_QUEUE).find({ webhookId: made.id }).toArray())
      .map(r => ({ event: r.event, spaceId: r.spaceId, path: JSON.parse(r.body)?.entry?.path }));
    const api = {
      id: made.id,
      /** Every dispatch made for the subscription: `{ event, spaceId, path }`. */
      dispatches,
      /** The paths dispatched as `event`, sorted. */
      async pathsOf(event) { return (await dispatches()).filter(d => d.event === event).map(d => d.path).sort(); },
      /** The bus events the space published since the capture opened (or `clear()`). */
      bus: () => [...seen],
      busPathsOf: (event) => seen.filter(e => e.event === event).map(e => e.entry?.path).sort(),
      clear() { seen.length = 0; },
      /**
       * A person's delete of a fresh file (MCP `delete_file` passes an actor), waited for until its dispatch has appeared: after
       * it returns, the dispatcher's own asynchronous hop has ended for everything made before it, so a negative read is not early.
       */
      async control() {
        const p = `control-${suite}-${++controlSeq}.txt`;
        await files.writeFile(S, p, `content of ${p}`);
        await door.coll(S, 'files').insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0 });
        const a = await mcp('delete_file', { path: p });
        assert.ok(!a.isError, `the control delete was refused: ${a.text}`);
        await waitFor(async () => (await dispatches()).some(d => d.event === 'file.deleted' && d.path === p), 15_000, 50,
          () => `no dispatch for the control delete of ${p}`, { what: 'the control dispatch' });
        return p;
      },
      /** Stop listening and remove the subscription and its rows. */
      async close() {
        unsubscribe();
        await store.deleteWebhook(made.id).catch(() => {});
        await door.mongo.col(RETRY_QUEUE).deleteMany({}).catch(() => {});
      },
    };
    return api;
  }

  // ── The links of files (Q-464) ───────────────────────────────────────────────────────────────────────────────

  let linkSeq = 0;
  const OTHER_INSTANCE = Object.freeze({ instanceId: `${suite}-another-instance`, instanceLabel: 'Another instance' });
  const links = {
    /** The author of a link row another instance wrote. */
    OTHER_INSTANCE,
    /**
     * One link row FROM `from` (a file id, or a derived id such as `a.txt#chunk-0`) to the entity `to`, authored by `who`: `self` (this
     * instance), `peer` (another instance) or `none` (a row with no author). Raw: it is the row a write once left, so a case can hold
     * a link another instance wrote, which no local door can make. `createdAt` is the row's write time (default a fixed old instant): a
     * case about a link written DURING a delete passes the current time. Returns the row's id.
     */
    async put(from, to, who = 'self', createdAt = T0) {
      const { linkIdFor } = await import('../../server/dist/brain/link-id.js');
      const { authorRef } = await import('../../server/dist/config/author.js');
      const author = who === 'self' ? authorRef() : who === 'peer' ? OTHER_INSTANCE : undefined;
      const _id = linkIdFor(from, 'file', to, 'entity');
      await door.coll(S, 'links').insertOne({ _id, spaceId: S, from, fromKind: 'file', to, toKind: 'entity', ...(author ? { author } : {}),
        createdAt, updatedAt: createdAt, seq: 1_000 + (++linkSeq) });
      return _id;
    },
    /** {@link links.put} for many sources at once (one insert): `from` is each of `froms`, `to` the same entity. Returns the ids. */
    async putMany(froms, to, who = 'self') {
      const { linkIdFor } = await import('../../server/dist/brain/link-id.js');
      const { authorRef } = await import('../../server/dist/config/author.js');
      const author = who === 'self' ? authorRef() : who === 'peer' ? OTHER_INSTANCE : undefined;
      const rows = froms.map(from => ({ _id: linkIdFor(from, 'file', to, 'entity'), spaceId: S, from, fromKind: 'file', to, toKind: 'entity',
        ...(author ? { author } : {}), createdAt: T0, updatedAt: T0, seq: 1_000 + (++linkSeq) }));
      if (rows.length > 0) await door.coll(S, 'links').insertMany(rows);
      return rows.map(r => r._id);
    },
    /** The ids of the link rows whose source is any of `froms`, sorted. */
    async idsFrom(...froms) {
      return (await door.coll(S, 'links').find({ from: { $in: froms } }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
    },
    /** The ids of every link row whose source is `root` itself, a derived id of it (`root#…`), or anything under `root/`, sorted. */
    async idsUnder(root) {
      const esc = root.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
      return (await door.coll(S, 'links').find({ fromKind: 'file', from: { $regex: `^${esc}(?:[#/]|$)` } }, { projection: { _id: 1 } }).toArray())
        .map(r => r._id).sort();
    },
    /** Every link row's id, sorted. */
    async ids() { return (await door.coll(S, 'links').find({}, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort(); },
    /** The ids of the link tombstones the space holds, sorted: what a removal tells peers. */
    async tombstoned() {
      return (await door.coll(S, 'tombstones').find({ type: 'link' }, { projection: { _id: 1 } }).toArray()).map(r => r._id).sort();
    },
    /** Empty the space's links and tombstones of every kind. */
    async reset() { for (const part of ['links', 'tombstones']) await door.coll(S, part).deleteMany({}); },
  };

  // ── Further spaces on the same door ──────────────────────────────────────────────────────────────────────────

  const rootOf = (space) => path.join(process.env['DATA_ROOT'], 'files', space);
  /** A file at `p` in `space` with its record, as `seed` makes one in the door's own space. */
  const seedIn = async (space, p, extra = {}) => {
    await files.writeFile(space, p, `content of ${p} in ${space}`);
    await door.coll(space, 'files').insertOne({ _id: p, spaceId: space, path: p, sizeBytes: 10, tags: [], createdAt: T0, updatedAt: T0, ...extra });
  };

  // ── Conflict resolution (Q-466) ──────────────────────────────────────────────────────────────────────────────

  // Resolved on first use: a suite that never resolves a conflict does not load the conflicts router.
  let conflictDoorsCache;
  const conflictDoorsOf = async () => {
    if (conflictDoorsCache) return conflictDoorsCache;
    const { conflictsRouter } = await import('../../server/dist/api/conflicts.js');
    const handlerOf = (m, route) => {
      const layer = conflictsRouter.stack.find(l => l.route?.path === route && l.route.methods[m]);
      assert.ok(layer, `no ${m.toUpperCase()} ${route} on the conflicts router — re-anchor _file-act-doors.mjs`);
      return layer.route.stack.at(-1).handle;
    };
    conflictDoorsCache = { resolve: handlerOf('post', '/:id/resolve'), bulk: handlerOf('post', '/bulk-resolve') };
    return conflictDoorsCache;
  };
  const fakeRes = () => ({ code: 200, body: undefined, headers: {}, headersSent: false,
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } });
  /** The rights a resolver holds: `{ [space]: { area: rung } }` over no floor — for a token that is not an administrator. */
  const rightsFor = (perSpace) => ({ instanceAdmin: false, createSpaces: false, floor: null,
    perSpace: Object.fromEntries(Object.entries(perSpace).map(([sp, areas]) => [sp, { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none', networks: 'none', ...areas }])) });
  const conflictCall = async (which, req, rights) => {
    const res = fakeRes();
    await (await conflictDoorsOf())[which]({ method: 'POST', query: {}, headers: {}, ip: '127.0.0.1', get: () => undefined,
      authToken: { id: 't', name: 'test', rights: rights ?? ADMIN }, ...req }, res);
    return res;
  };
  const resolveBody = (action, { rename, targetSpaceId }) => ({ action, ...(rename !== undefined ? { rename } : {}), ...(targetSpaceId !== undefined ? { targetSpaceId } : {}) });
  const conflicts = {
    rightsFor,
    /**
     * A conflict record in `space` (default the door's own) and the bytes of its two files: the original, and the incoming copy under
     * its conflict name. `original: null` / `conflict: null` leave that file absent. Returns the record's id.
     */
    async seed({ id, original = 'doc.txt', conflict = 'doc.conflict-peer.txt', space = S, originalContent, conflictContent } = {}) {
      if (original !== null) await files.writeFile(space, original, originalContent ?? `local ${original}`);
      if (conflict !== null) await files.writeFile(space, conflict, conflictContent ?? `incoming ${conflict}`);
      await door.coll(space, 'conflicts').insertOne({ _id: id, spaceId: space, originalPath: original ?? 'doc.txt', conflictPath: conflict ?? 'doc.conflict-peer.txt',
        peerInstanceId: 'a-peer', peerInstanceLabel: 'A peer', detectedAt: T0 });
      return id;
    },
    /** `POST /api/conflicts/:id/resolve` through the router's own handler. Answers as `rest` does: `code`, `body`, `headers`. */
    resolve: (id, action, o = {}) => conflictCall('resolve', { params: { id }, body: resolveBody(action, o) }, o.rights),
    /** `POST /api/conflicts/bulk-resolve`. */
    bulk: (ids, action, o = {}) => conflictCall('bulk', { params: {}, body: { ids, ...resolveBody(action, o) } }, o.rights),
    /** The record with this id in `space`, or null: a resolution that completed is the one thing that removes it. */
    record: (id, space = S) => door.coll(space, 'conflicts').findOne({ _id: id }),
    /** Remove every conflict record of `spaces` (default the door's own). */
    async reset(...spaces) { for (const sp of spaces.length ? spaces : [S]) await door.coll(sp, 'conflicts').deleteMany({}); },
  };

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
    webhooks, links, conflicts, rootOf, seedIn,
    /** Whether `p` is on disk in `space`. */
    onDiskIn: (space, p) => fs.existsSync(path.join(rootOf(space), p)),
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
