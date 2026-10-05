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
import { wipeParts, RECORD_PARTS } from './_space-snapshot.mjs';
import { fakeResponse } from './_fake-response.mjs';

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
 * A valid document of a replicated family, by the name the family goes by on the wire (`REPLICATED_FAMILIES`'s
 * `payloadKey`) — the one place that name is turned into a `build` entry, so a test that loops over the families asks
 * this instead of spelling its own table. A family without a builder throws here, at the call, rather than being skipped.
 */
export function buildOf(payloadKey) {
  const builder = { facts: build.fact, entities: build.entity, edges: build.edge, chrono: build.chrono, links: build.link, filemeta: build.filemeta }[payloadKey];
  if (!builder) throw new Error(`no document builder for the replicated family '${payloadKey}' — add one to \`build\` and to buildOf`);
  return builder;
}

/**
 * The body keys `batch-upsert` reads, derived from `REPLICATED_FAMILIES` — after checking the route reads every one
 * of them, since a route that dropped a family would make the registry the wrong thing to read. On 5.6.x the route
 * spells each key out (`body?.facts`, ...) rather than mapping the registry, so the check is per key. A family the
 * registry has and the fixture table lacks fails a floor.
 */
export function familiesCarriedByBatch() {
  const src = fs.readFileSync('server/src/api/sync/docs.ts', 'utf8');
  const keys = REPLICATED_FAMILY_KEYS;
  const unread = keys.filter(k => !src.includes(`Array.isArray(body?.${k})`)
    && !(/Array\.isArray\(body\?\.\[k\]\)/.test(src) && /REPLICATED_FAMILIES\.map\(\(\{ payloadKey: k \}\)/.test(src)));
  if (unread.length > 0) {
    throw new Error(`batch-upsert does not read body key(s) ${unread} — re-anchor familiesCarriedByBatch`);
  }
  if (keys.length < 6) throw new Error(`batch-upsert reads only ${keys.length} body key(s) — the derivation is broken: ${keys}`);
  return keys;
}
const REPLICATED_FAMILY_KEYS = (await import('../../server/dist/sync/replicated-families.js'))
  .REPLICATED_FAMILIES.map(f => f.payloadKey);

/**
 * Every push door that runs the TOMBSTONE ACCEPT (`pushVerdict` / `applyPushVerdict` in `api/sync/docs.ts`): each
 * batch-upsert family whose collection takes tombstones, and each single route the sync docs router registers for
 * such a family. Callable at load, before any door is open, so a file can register its cases per door.
 *
 * Derived, never listed: the batch families from `familiesCarriedByBatch()`, which families take tombstones from
 * `TOMBSTONE_COLLECTION`, and the single routes from the router's own POST registrations in `api/sync/docs.ts` (read
 * as source, because importing the router before a config is loaded leaves the loader pointed at the default path;
 * `push()` then refuses a route the router does not really serve, so a stale reading fails loudly). So a family that gains a single
 * route, or a new tombstoned family, is a door every rule over the accept is asserted on without an edit here — and
 * a rule asserted on one door is the shape this exists to end: the accept is called from nine sites, and a rule held
 * at one of them says nothing about the other eight. Floors on both halves, because an empty list passes every loop.
 *
 * Each door: `name`, `coll`, `type` (the tombstone and `build` type), and `body(doc)` — what that route is sent.
 */
export async function tombstoneAcceptDoors() {
  const { TOMBSTONE_COLLECTION } = await import('../../server/dist/config/types.js');
  const tombTypeOf = new Map(Object.entries(TOMBSTONE_COLLECTION).map(([type, coll]) => [coll, type]));
  const docsSrc = fs.readFileSync('server/src/api/sync/docs.ts', 'utf8');
  const posts = new Set([...docsSrc.matchAll(/\bsyncDocsRouter\.post\(\s*'([^']+)'/g)].map(m => m[1]));
  if (!posts.has('/batch-upsert')) throw new Error('no POST /batch-upsert registration found in api/sync/docs.ts — re-anchor tombstoneAcceptDoors');
  const doors = [];
  for (const key of familiesCarriedByBatch()) {
    const fam = FAMILIES[key];
    if (!fam) throw new Error(`batch-upsert carries '${key}', which the FAMILIES fixture lacks — add it`);
    const type = tombTypeOf.get(fam.coll);
    if (!type) continue;   // file metadata takes no tombstone: the writer's own plan accepts it
    if (typeof build[type] !== 'function') throw new Error(`no build.${type} for the tombstoned family '${key}' — add one`);
    doors.push({ name: `batch-upsert ${key}`, route: '/batch-upsert', coll: fam.coll, type, body: (doc) => ({ [key]: [doc] }) });
    if (posts.has(`/${fam.coll}`)) {
      doors.push({ name: `POST /${fam.coll}`, route: `/${fam.coll}`, coll: fam.coll, type, body: (doc) => doc });
    }
  }
  const batch = doors.filter(d => d.route === '/batch-upsert').length;
  const single = doors.length - batch;
  if (batch < 5 || single < 4) {
    throw new Error(`derived ${batch} batch and ${single} single tombstone-accept door(s) — the derivation is broken: `
      + doors.map(d => d.name).join(', '));
  }
  return doors;
}

/**
 * Open a push door.
 *
 * @param {object} o
 * @param {string} o.suite  harness database slug
 * @param {object[]} o.spaces  config `spaces` entries
 * @param {object[]} [o.networks]
 * @param {boolean} [o.monitorCommands]  reconnect with command monitoring, for `commandsDuring`
 * @param {object} [o.secrets]  a `secrets.json` to write beside the config BEFORE it is loaded — the loader reads
 *   it once, at `loadConfig`, so a door whose engine calls out to a peer (`_pull-door.mjs`) must hand its peer
 *   tokens in here rather than write them afterwards
 */
export async function openPushDoor({ suite, spaces, networks = [], monitorCommands = false, secrets }) {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `ythril-${suite}-`));
  process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
  // The space's files land under DATA_ROOT, whose default is /data: a directory Windows lets any process create at
  // the drive root and the Linux CI runner refuses (EACCES), so without this every door passed locally and failed
  // its setup in CI. Set here, once, so no test that opens a door has to remember it.
  process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: `${suite}-receiver`, instanceLabel: 'Receiver', tokens: [], networks, spaces,
  }, null, 2), { mode: 0o600 });
  if (secrets) fs.writeFileSync(path.join(tmpDir, 'secrets.json'), JSON.stringify(secrets), { mode: 0o600 });

  const mongo = await openTestMongo(suite);
  try {
    return await assemblePushDoor({ suite, spaces, monitorCommands, mongo, tmpDir });
  } catch (err) {
    // A setup that throws after the connect must still close it: an open client keeps this test process alive,
    // and node's runner waits on the file for ever instead of reporting it failed (PR #1475's hung Build & Test).
    await releaseHarness(tmpDir);
    throw err;
  }
}

/** Close the harness database and remove the door's config directory: the one teardown, success or failure. */
async function releaseHarness(tmpDir) {
  await closeTestMongo();
  try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
}

/** Everything `openPushDoor` builds once the harness database is open; split out so its failure can close it. */
async function assemblePushDoor({ suite, spaces, monitorCommands, mongo, tmpDir }) {
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
    let counterAtResponse;
    const res = fakeResponse({ onAnswer: () => { counterAtResponse = landed.get(localSpace) ?? 0; } });
    await handlerFor('post', routePath)(req, res);
    assert.ok(res.sent, `POST ${routePath} settled without answering`);
    return { code: res.statusCode, body: res.body, counterAtResponse };
  }

  /** A GET page, for the cases that assert what a peer pulling from this instance is served. */
  async function pull(routePath, query) {
    const req = { method: 'GET', query: { full: 'true', ...query }, params: {}, authToken: PEER_TOKEN, get: () => undefined };
    const res = fakeResponse();
    await handlerFor('get', routePath)(req, res);
    assert.equal(res.statusCode, 200, JSON.stringify(res.body));
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
    await wipeParts(mongo, space, RECORD_PARTS);
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
    await releaseHarness(tmpDir);
  }

  /** The route's own handler, past rate limit and auth — for a fake peer that serves a real route (`_pull-door.mjs`). */
  const handler = (method, routePath) => handlerFor(method, routePath);

  return { mongo, push, pull, coll, counter, setCounter, settled, wipe, commandsDuring, handler, close };
}
