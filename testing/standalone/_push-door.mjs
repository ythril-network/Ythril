/**
 * Drive the sync PUSH door in-process against a real Mongo — the question "what does this instance do with a
 * document a peer pushed", answered once for every test that asks it.
 *
 * ## Why a module
 *
 * The push-door tests (`a-push-*-db.test.js`) each need the same five things: a config with the spaces and
 * networks a case needs, the server's own Mongo layer pointed at a harness database, the spaces initialised
 * the way production initialises them (so the unique triplet and link indexes exist), the route's own handler
 * invoked past rate limit and auth, and a probe of the space counter AT THE MOMENT the response is sent. Each
 * would otherwise write its own copy, and the copy that drifts is the one whose case passes for the wrong
 * reason.
 *
 * ## The two things a hand-written copy drops
 *
 * **The alias middleware.** A peer names a space by the NETWORK's id; `resolveNetworkSpaceAlias` translates it
 * ahead of every sync route. Calling the handler alone would test a door no peer ever reaches, and it would
 * hide the one defect that lives between the two (the documents keep the sender's `spaceId`).
 *
 * **The counter at response time.** "The counter is bumped" passes on a fire-and-forget `$max` almost every
 * time, because the write usually lands before the test reads it. What the protocol needs is that the counter
 * is past what was received BEFORE the sender is told the push landed. So the counter collection's writes are
 * observed as they COMPLETE, and `push()` reports the highest value that had completed when the handler called
 * `res.json`. No sleeps: a bump that was not awaited has, by construction, not completed when the synchronous
 * `res.json` that follows it runs.
 *
 * ## What it does not do
 *
 * It does not stub the data layer, the planner or the writer. The handler is the real one; the Mongo layer is
 * production's (`_mongo-harness.mjs`).
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, testMongoUri } from './_mongo-harness.mjs';

/** A peer-bound token that reaches every space by its own scope (an unknown peer falls through to space scope). */
export const PEER_TOKEN = Object.freeze({
  rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } },
  peerInstanceId: 'push-door-peer',
});

const AUTHOR = { instanceId: 'push-door-peer', instanceLabel: 'Peer' };
const T0 = '2026-09-01T00:00:00.000Z';

/** Document builders: the smallest body each `Incoming*Doc` accepts, plus whatever a case overrides. */
export const build = {
  fact: (space, _id, seq, extra = {}) => ({ _id, spaceId: space, fact: `fact ${_id}`, tags: [], author: AUTHOR,
    createdAt: T0, updatedAt: T0, seq, ...extra }),
  entity: (space, _id, seq, extra = {}) => ({ _id, spaceId: space, name: `Entity ${_id}`, type: 'concept', tags: [],
    properties: {}, author: AUTHOR, createdAt: T0, updatedAt: T0, seq, ...extra }),
  edge: (space, _id, seq, extra = {}) => ({ _id, spaceId: space, from: `from-${_id}`, to: `to-${_id}`, label: 'relates',
    tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq, ...extra }),
  chrono: (space, _id, seq, extra = {}) => ({ _id, spaceId: space, title: `Chrono ${_id}`, type: 'event',
    startsAt: T0, status: 'upcoming', tags: [], author: AUTHOR, createdAt: T0, updatedAt: T0, seq, ...extra }),
  link: (space, _id, seq, extra = {}) => ({ _id, spaceId: space, from: `from-${_id}`, fromKind: 'fact',
    to: `to-${_id}`, toKind: 'entity', author: AUTHOR, createdAt: T0, updatedAt: T0, seq, ...extra }),
  filemeta: (space, _id, seq, extra = {}) => ({ _id, spaceId: space, path: _id, tags: [], author: AUTHOR,
    createdAt: T0, updatedAt: T0, seq, ...extra }),
  tombstone: (space, _id, type, seq, extra = {}) => ({ _id, type, spaceId: space, deletedAt: T0,
    instanceId: AUTHOR.instanceId, seq, ...extra }),
};

/**
 * The batch-upsert body key, the collection, and the record type of each family the push door carries.
 * A fixture table, not a derivation — `familiesCarriedByBatch()` is the derivation it is checked against.
 */
export const FAMILIES = Object.freeze({
  facts:    { coll: 'facts',    type: 'fact',   single: '/facts' },
  entities: { coll: 'entities', type: 'entity', single: '/entities' },
  edges:    { coll: 'edges',    type: 'edge',   single: '/edges' },
  chrono:   { coll: 'chrono',   type: 'chrono', single: '/chrono' },
  links:    { coll: 'links',    type: null,     single: null },
  filemeta: { coll: 'files',    type: 'file',   single: null },
});

/**
 * The body keys `batch-upsert` reads. The route derives them from `REPLICATED_FAMILIES` (`Q-107` part 1 dup pass),
 * so this does too — after checking the route still does, since a route that went back to a hand list would make
 * the registry the wrong thing to read. A family the registry has and the fixture table lacks fails a floor.
 */
export function familiesCarriedByBatch() {
  const src = fs.readFileSync('server/src/api/sync/docs.ts', 'utf8');
  if (!/Array\.isArray\(body\?\.\[k\]\)/.test(src) || !/REPLICATED_FAMILIES\.map\(\(\{ payloadKey: k \}\)/.test(src)) {
    throw new Error('batch-upsert no longer reads its body keys from REPLICATED_FAMILIES — re-anchor familiesCarriedByBatch');
  }
  const keys = REPLICATED_FAMILY_KEYS;
  if (keys.length < 6) throw new Error(`batch-upsert reads only ${keys.length} body key(s) — the derivation is broken: ${keys}`);
  return keys;
}
const REPLICATED_FAMILY_KEYS = (await import('../../server/dist/sync/replicated-families.js'))
  .REPLICATED_FAMILIES.map(f => f.payloadKey);

/**
 * Open a push door.
 *
 * @param {object} o
 * @param {string} o.suite  harness database slug
 * @param {object[]} o.spaces  config `spaces` entries
 * @param {object[]} [o.networks]
 * @param {boolean} [o.monitorCommands]  reconnect with command monitoring, for `commandsDuring`
 */
export async function openPushDoor({ suite, spaces, networks = [], monitorCommands = false }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ythril-${suite}-`));
  process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: `${suite}-receiver`, instanceLabel: 'Receiver', tokens: [], networks, spaces,
  }, null, 2), { mode: 0o600 });

  const mongo = await openTestMongo(suite);
  const DB = `ythril_harness_${suite}`;
  let counting = false;
  let commands = [];
  if (monitorCommands) {
    await mongo.closeMongo();
    process.env['MONGO_URI'] = `${testMongoUri(DB)}&monitorCommands=true`;
    mongo._resetDbName?.();
    await mongo.connectMongo();
    mongo.getMongo().on('commandStarted', (ev) => {
      if (counting && ev.databaseName === DB) commands.push(`${ev.commandName} ${ev.command?.[ev.commandName] ?? ''}`);
    });
  }
  (await import('../../server/dist/config/loader.js')).loadConfig();
  const docs = await import('../../server/dist/api/sync/docs.js');
  const tombs = await import('../../server/dist/api/sync/tombstones.js');
  const { resolveNetworkSpaceAlias } = await import('../../server/dist/api/sync/space-alias.js');
  const { initSpace } = await import('../../server/dist/spaces/lifecycle.js');
  for (const s of spaces) await initSpace(s.id, { waitForVectorReady: false });

  // ── The counter probe: the highest value a COMPLETED counter write left, per space ─────────────────────────
  const landed = new Map();
  const inFlight = new Set();
  const track = (p) => { inFlight.add(p); p.finally(() => inFlight.delete(p)).catch(() => {}); return p; };
  /** Every counter write already started has completed — so a fire-and-forget bump cannot land on a later case. */
  async function settled() { while (inFlight.size > 0) await Promise.allSettled([...inFlight]); }
  const proto = Object.getPrototypeOf(mongo.col('probe'));
  const originals = { updateOne: proto.updateOne, findOneAndUpdate: proto.findOneAndUpdate };
  const counted = (coll, op) => (coll.collectionName === 'ythril_counters' ? track(op) : op);
  proto.updateOne = async function observed(filter, update, ...rest) {
    const r = await counted(this, originals.updateOne.call(this, filter, update, ...rest));
    if (this.collectionName === 'ythril_counters' && typeof update?.$max?.seq === 'number') {
      landed.set(filter._id, Math.max(landed.get(filter._id) ?? 0, update.$max.seq));
    }
    return r;
  };
  proto.findOneAndUpdate = async function observed(filter, update, ...rest) {
    const r = await counted(this, originals.findOneAndUpdate.call(this, filter, update, ...rest));
    if (this.collectionName === 'ythril_counters' && typeof r?.seq === 'number') {
      landed.set(filter._id, Math.max(landed.get(filter._id) ?? 0, r.seq));
    }
    return r;
  };

  const routers = [docs.syncDocsRouter, tombs.syncTombstonesRouter];
  function handlerFor(method, routePath) {
    for (const router of routers) {
      const layer = router.stack.find(l => l.route?.path === routePath && l.route.methods[method]);
      if (layer) return layer.route.stack.at(-1).handle;
    }
    throw new Error(`no ${method.toUpperCase()} ${routePath} on the sync routers — re-anchor the push-door harness`);
  }

  /**
   * Invoke one push route as a peer would reach it: the alias middleware, then the route's own handler.
   * Resolves when the handler's promise settles, with what it answered and the counter as it stood when it did.
   */
  async function push(routePath, body, { spaceId, networkId, token = PEER_TOKEN } = {}) {
    const req = { method: 'POST', path: routePath, query: { spaceId, ...(networkId ? { networkId } : {}) },
      params: {}, body, authToken: token, get: () => undefined, headers: {} };
    await new Promise((resolve, reject) => resolveNetworkSpaceAlias(req, {}, (e) => (e ? reject(e) : resolve())));
    const localSpace = req.query.spaceId;
    const res = {
      code: 200, body: undefined, sent: false, counterAtResponse: undefined,
      status(c) { this.code = c; return this; },
      json(b) {
        this.body = b; this.sent = true;
        this.counterAtResponse = landed.get(localSpace) ?? 0;
        return this;
      },
    };
    await handlerFor('post', routePath)(req, res);
    assert.ok(res.sent, `POST ${routePath} settled without answering`);
    return { code: res.code, body: res.body, counterAtResponse: res.counterAtResponse };
  }

  /** A GET page, for the cases that assert what a peer pulling from this instance is served. */
  async function pull(routePath, query) {
    const req = { method: 'GET', query: { full: 'true', ...query }, params: {}, authToken: PEER_TOKEN, get: () => undefined };
    const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handlerFor('get', routePath)(req, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    return res.body;
  }

  const coll = (space, part) => mongo.col(`${space}_${part}`);
  /** The stored counter, after every counter write already started has landed. */
  async function counter(space) {
    await settled();
    return (await mongo.col('ythril_counters').findOne({ _id: space }))?.seq ?? 0;
  }
  async function setCounter(space, seq) {
    await mongo.col('ythril_counters').updateOne({ _id: space }, { $set: { seq } }, { upsert: true });
  }
  async function wipe(space) {
    await settled();
    for (const part of ['facts', 'entities', 'edges', 'chrono', 'links', 'files', 'tombstones', 'embed_jobs']) {
      await coll(space, part).deleteMany({});
    }
    await mongo.col('ythril_counters').deleteMany({ _id: space });
    landed.delete(space);
  }
  /** Commands the harness database saw while `fn` ran, minus the driver's own housekeeping. */
  async function commandsDuring(fn) {
    assert.ok(monitorCommands, 'commandsDuring needs openPushDoor({ monitorCommands: true })');
    commands = [];
    counting = true;
    try { await fn(); } finally { counting = false; }
    return commands.filter(c => !/^(hello|isMaster|ping|endSessions|saslContinue|saslStart) /.test(c));
  }

  async function close() {
    proto.updateOne = originals.updateOne;
    proto.findOneAndUpdate = originals.findOneAndUpdate;
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  }

  return { mongo, push, pull, coll, counter, setCounter, settled, wipe, commandsDuring, close };
}
