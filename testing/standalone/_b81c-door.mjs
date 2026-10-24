/**
 * The doors a bundle-81 slice-C test drives, over a database whose name starts with `b81tC_`.
 *
 * ## The question it answers
 *
 * "How does a test reach every door that stores, stamps or serves a record (the sync push routes and pull routes, the REST
 * app, the MCP dispatch, the server's own modules) against a real Mongo, in a database nobody else's slice can drop?"
 *
 * ## Why it is not `openPushDoor`
 *
 * `openPushDoor` (`_push-door.mjs`) opens `ythril_harness_<suite>` through `openTestMongo`, whose prefix is fixed. Slice C
 * of bundle-81 runs beside four other slices on one Mongo and may only create and drop databases named `b81tC_*`, so it
 * opens its own. Everything else here is what `openPushDoor` and `openStalledWriteDoors` do (the alias middleware before
 * a push route, the route's own handler, the app on loopback, `callTool`), kept to the part these tests ask.
 *
 * ## What it prevents
 *
 * A copy that skips the alias middleware tests a door no peer reaches; a copy that never drops on entry inherits a killed run's
 * rows and starts passing for the wrong reason. `open` drops on entry and `close` on exit.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { testMongoUri, tuneTestMongo } from './_mongo-harness.mjs';
import { RECORD_PARTS } from './_space-snapshot.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

/** Every database this slice creates starts with this. */
export const DB_PREFIX = 'b81tC_';

/*
 * The config location is fixed at IMPORT, before any test file imports a server module: `config/loader.js` reads `CONFIG_PATH`
 * when it is first loaded, and a test that imports `util/seq.js` at its top (for a constant) would otherwise load it against the
 * default path. One directory per process; `openB81cDoor` writes the config into it.
 */
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'b81tc-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');

/**
 * @param {object} o
 * @param {string} o.name  database suffix; the database is `b81tC_<name>`
 * @param {string[]} o.spaces  space ids to register and initialise
 * @param {string} [o.instanceId]
 * @param {boolean} [o.app]  also serve the REST app on loopback and make an admin key (`rest`, `mcp`)
 * @param {object[]} [o.networks]
 */
export async function openB81cDoor({ name, spaces, instanceId, app = false, networks = [] }) {
  const dbName = `${DB_PREFIX}${name}`;
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: instanceId ?? `b81c-${name}`, instanceLabel: 'B81C', tokens: [], networks,
    spaces: spaces.map(id => ({ id, label: id, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } })),
  }, null, 2), { mode: 0o600 });

  process.env['MONGO_URI'] = testMongoUri(dbName);
  const mongo = await import('../../server/dist/db/mongo.js');
  mongo._resetDbName?.();
  await mongo.connectMongo();
  let server;
  const closeAll = async () => {
    await server?.close().catch(() => {});
    try { await mongo.getDb().dropDatabase(); } catch { /* best effort */ }
    await mongo.closeMongo().catch(() => {});
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  };
  try {
    await tuneTestMongo();
    await mongo.getDb().dropDatabase();
    (await import('../../server/dist/config/loader.js')).loadConfig();
    const { initSpace } = await import('../../server/dist/spaces/lifecycle.js');
    for (const id of spaces) await initSpace(id, { waitForVectorReady: false });

    const docs = await import('../../server/dist/api/sync/docs.js');
    const tombs = await import('../../server/dist/api/sync/tombstones.js');
    const { resolveNetworkSpaceAlias } = await import('../../server/dist/api/sync/space-alias.js');
    const routers = [docs.syncDocsRouter, tombs.syncTombstonesRouter];
    const handlerFor = (method, routePath) => {
      for (const router of routers) {
        const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
        if (layer) return layer.route.stack.at(-1).handle;
      }
      throw new Error(`no ${method.toUpperCase()} ${routePath} on the sync routers: re-anchor _b81c-door`);
    };

    /** One push route as a peer reaches it: the alias middleware, then the route's own handler. */
    async function push(routePath, body, { spaceId, token, networkId } = {}) {
      const req = { method: 'POST', path: routePath, query: { spaceId, ...(networkId ? { networkId } : {}) },
        params: {}, body, authToken: token, get: () => undefined, headers: {} };
      await new Promise((resolve, reject) => resolveNetworkSpaceAlias(req, {}, (e) => (e ? reject(e) : resolve())));
      const res = {
        code: 200, body: undefined, sent: false, headers: {},
        status(c) { this.code = c; return this; },
        setHeader(n, v) { this.headers[n.toLowerCase()] = v; return this; },
        json(b) { this.body = b; this.sent = true; return this; },
      };
      await handlerFor('post', routePath)(req, res);
      assert.ok(res.sent, `POST ${routePath} settled without answering`);
      return { code: res.code, body: res.body };
    }

    /** One pull route as a peer reaches it. */
    async function pull(routePath, query, token) {
      const req = { method: 'GET', query: { full: 'true', ...query }, params: {}, authToken: token, get: () => undefined, headers: {} };
      await new Promise((resolve, reject) => resolveNetworkSpaceAlias(req, {}, (e) => (e ? reject(e) : resolve())));
      const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, setHeader() { return this; }, json(b) { this.body = b; return this; } };
      await handlerFor('get', routePath)(req, res);
      return { code: res.code, body: res.body };
    }

    const coll = (space, part) => mongo.col(`${space}_${part}`);
    const counter = async (space) => (await mongo.col('ythril_counters').findOne({ _id: space }))?.seq ?? 0;
    const setCounter = (space, seq) => mongo.col('ythril_counters').updateOne({ _id: space }, { $set: { seq } }, { upsert: true });
    /** Empty a space and its counter row. Nothing of the case may still be writing when this runs. */
    async function wipe(space) {
      for (const p of RECORD_PARTS) await coll(space, p).deleteMany({});
      await mongo.col('ythril_counters').deleteMany({ _id: space });
    }

    let rest, mcp, baseUrl, adminKey;
    if (app) {
      const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
      const { callTool } = await import('../../server/dist/mcp/call-tool.js');
      const tokens = await import('../../server/dist/auth/tokens.js');
      adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
      server = await listenApp();
      baseUrl = server.url;
      /** `{ status, body, text }` of one REST call as an admin. */
      rest = async (method, url, body) => {
        const r = await fetch(`${server.url}${url}`, {
          method, headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });
        const text = await r.text();
        let parsed; try { parsed = text ? JSON.parse(text) : undefined; } catch { parsed = text; }
        return { status: r.status, body: parsed, text };
      };
      const ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
      /** `{ status, body, text }` of one MCP tool call as an admin; `body` is the tool result's `structuredContent`. */
      mcp = async (toolName, args) => {
        const out = await callTool({
          name: toolName, args,
          caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' },
        });
        const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
        return { status: out.status, body: out.result.structuredContent ?? {}, text, isError: out.result.isError === true };
      };
    }

    return { mongo, dbName, push, pull, coll, counter, setCounter, wipe, rest, mcp, handlerFor, baseUrl, adminKey, close: closeAll };
  } catch (err) {
    await closeAll();
    throw err;
  }
}

/**
 * The module `rel` of the server's build, or `null` when this build has none. For a test written against a module the
 * plan creates: it asserts the module exists with a sentence naming it, instead of failing on an import error that names
 * a path.
 */
export async function moduleOrNull(rel) {
  try { return await import(`../../server/dist/${rel}`); } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND') return null;
    throw err;
  }
}
