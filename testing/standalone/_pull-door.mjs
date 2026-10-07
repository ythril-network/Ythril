/**
 * Drive the sync PULL door in-process against a real Mongo — the twin of `_push-door.mjs`, for the question "what
 * does this instance do with what it PULLED from a peer", answered once for every test that asks it.
 *
 * ## What it is
 *
 * A push door (`openPushDoor`: config, the server's own Mongo layer on a harness database, the spaces initialised as
 * production initialises them, the counter probe) plus a FAKE PEER: an HTTP server this instance's real engine
 * (`runSyncForPeer`) syncs with. The fake peer serves the REAL `GET /api/sync/tombstones` handler over the real
 * `listTombstones`, behind production's own `compression` middleware and filter — so what crosses the wire is what a
 * real peer would send, compressed as a real peer compresses it, and read back through `peerSafeFetch` and
 * `boundedJson` exactly as the engine reads any peer.
 *
 * ## The things a hand-written copy drops
 *
 * **A routable address.** The peer fetch refuses loopback whatever the opt-in (`_private-address.mjs` says why), so
 * a fake peer on 127.0.0.1 is refused before a socket opens and the test proves nothing about the pull. It binds to
 * this host's LAN address, and `SYNC_ALLOW_PRIVATE_PEERS` admits that.
 *
 * **The peer's OWN storage.** The receiver and the fake peer share one process and one database, so a peer that
 * served the receiver's own `<space>_tombstones` would hand the receiver its own rows back and every "was it
 * stored" assertion would pass by construction. The peer keeps what it serves under `peer-<space it is asked for>`,
 * a space the receiver's network does not carry; the documents keep whatever `spaceId` the case gave them, which is
 * the field under test.
 *
 * **The peer's settled bound.** `listTombstones` serves only seqs below the space's settled bound, which is seeded
 * once per process from the counter. `seedPeer` bumps the peer-side counter through the server's own `bumpSeq`, so a
 * seed is served whatever was seeded before it.
 *
 * ## The topology a case is about (bundle-51)
 *
 * Who may delete what a peer delivered depends on WHERE the peer sits: the upstream of a directional network (a pubsub
 * publisher, a braintree parent) or anything else (a subscriber, a child, a club member, a stranger). So the door takes
 * the network's `type`, a braintree `myParentInstanceId`, the peer's `direction` and member fields, and a second CLUB
 * network carrying the same spaces through a `LATERAL` member (`lateral`) — and `configure` rewrites any of them on the
 * live config for the next case, because the process has ONE door (its config, Mongo layer and engine are singletons) and
 * `reset` puts the opening topology back. With `files: true` the fake peer also serves the REAL file-tombstone and
 * manifest handlers over its own storage and disk, and canned plain-file routes.
 *
 * ## What it does not do
 *
 * It does not stub the engine, the transfer, the apply or the data layer. A case that needs a peer to send what no
 * honest peer would (a forged seq, a malformed element) sets `tamper`, which rewrites the real handler's answer on
 * its way out — the receiver must not trust it either way.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import express from 'express';
import compression from 'compression';
import { openPushDoor } from './_push-door.mjs';
import { privateHostAddress } from './_private-address.mjs';

process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
process.env['SYNC_ALLOW_INSECURE_PEERS'] = 'true';

/** The fake peer's instance id and label, as this instance's network config lists it. */
export const PEER = 'pull-door-peer';
export const PEER_LABEL = 'Pull-door peer';

/** The author block of a record the fake peer wrote. */
export const PEER_AUTHOR = Object.freeze({ instanceId: PEER, instanceLabel: PEER_LABEL });

/**
 * A LATERAL writer: a member of a CLUB network that carries the same space (`lateral` below). It is no upstream of
 * anything, so what it delivered is never the fake peer's to delete (bundle-51).
 */
export const LATERAL = 'pull-door-lateral';
export const LATERAL_LABEL = 'Pull-door lateral';
export const LATERAL_AUTHOR = Object.freeze({ instanceId: LATERAL, instanceLabel: LATERAL_LABEL });

/** Where the fake peer keeps the tombstones it serves for a space it is asked for by `remote`. */
export const peerSide = (remote) => `peer-${remote}`;

/**
 * The token the fake peer's handler is called with: it reaches every space by its own scope, and its peer id is no
 * member of anything here, so `spaceAllowed` falls through to plain space scope (the peer side is no network space).
 */
const SERVING_TOKEN = Object.freeze({
  rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } },
  peerInstanceId: 'pull-door-receiver',
});

/**
 * Open a pull door.
 *
 * @param {object} o
 * @param {string} o.suite  harness database slug
 * @param {string[]} o.spaces  the LOCAL space ids the network carries
 * @param {Record<string,string>} [o.spaceMap]  network (remote) id -> local id, as `join-remote` records it
 * @param {string[]} [o.extraSpaces]  local spaces this instance has OUTSIDE the network (a victim of a forgery)
 * @param {'pull'|'push'|'both'} [o.direction]  the member's direction, from this instance's view
 * @param {boolean} [o.monitorCommands]
 * @param {Record<string, object>} [o.meta]  local space id -> its `meta` (suppression tiers, type schemas, retention)
 * @param {Record<string, object>} [o.spaceExtra]  local space id -> further space config (`recordTtlDays`, …)
 * @param {string} [o.type]  the network's type: `pubsub` (default), `braintree`, `club`, `closed`, `democratic`. With
 *   `pubsub` and the default direction `pull` the fake peer is this instance's PUBLISHER, i.e. its upstream
 * @param {string} [o.myParentInstanceId]  a braintree network's parent of THIS instance (`upstreamOf` reads it): the
 *   fake peer is the upstream when it is `PEER`, and a stranger to the tree otherwise
 * @param {object} [o.memberExtra]  further fields on the fake peer's member record (`parentInstanceId`, …)
 * @param {boolean|string[]} [o.lateral]  also carry the same spaces (or these local ids) through a CLUB network whose one
 *   member is `LATERAL`: a space reached by a non-directional network as well. Toggled later by `configure`
 * @param {boolean} [o.files]  serve the file routes on the fake peer too — the REAL `GET`/`POST /api/sync/file-tombstones`
 *   and `GET /api/sync/manifest` handlers over the peer's own storage and disk, and the plain file routes
 *   (`GET`/`POST /api/files/:space`) as canned answers. Off by default: the existing callers never meet them
 *
 * ONE DOOR PER PROCESS (the config, the Mongo layer and the engine are module singletons). A case that needs another
 * TOPOLOGY does not open another door: `configure` rewrites the live network config, and `reset` puts it back.
 */
export async function openPullDoor({ suite, spaces, spaceMap, extraSpaces = [], direction = 'pull', monitorCommands = false,
  meta = {}, spaceExtra = {}, type = 'pubsub', myParentInstanceId, memberExtra, lateral = false, files = false }) {
  const host = privateHostAddress();
  assert.ok(host, 'no non-loopback IPv4 on this host — callers skip on privateAddressSkipReason() first');
  const NET = `${suite}-net`;
  const LATERAL_NET = `${suite}-lateral-net`;
  const remoteOf = new Map(spaces.map(s => [s, s]));
  for (const [remote, local] of Object.entries(spaceMap ?? {})) remoteOf.set(local, remote);
  const lateralSpaces = (on) => (Array.isArray(on) ? on : spaces);
  const lateralNetwork = (on) => ({
    id: LATERAL_NET, label: 'Pull-door lateral network', type: 'club', origin: 'joined', spaces: [...lateralSpaces(on)], votes: [],
    votingDeadlineHours: 24,
    members: [{ instanceId: LATERAL, label: LATERAL_LABEL, url: 'http://192.0.2.1:9', tokenHash: 'x', direction: 'both' }],
  });
  /** The topology the door opened with: `reset` returns to it, so one case's `configure` never leaks into the next. */
  const initial = { type, myParentInstanceId, memberExtra: memberExtra ?? {}, lateral };

  let door;
  let families = [];
  let maxCap = Infinity;
  const state = {
    /** `(body, query) => body` — rewrites the real GET handler's answer on its way to the receiver. */
    tamper: null,
    /** Every tombstone GET the receiver sent, its query as the receiver wrote it. */
    requests: [],
    /** Per tombstone GET: the encoding the answer went out in, and its JSON size before compression. */
    answers: [],
    /** Every tombstone the receiver PUSHED to the fake peer, in arrival order. */
    received: [],
    /** Every record the receiver pushed by batch-upsert, each with its body `key`. */
    pushedRecords: [],
    /** remote space -> payloadKey -> items, served as one page of the record family. */
    records: {},
    /**
     * A payloadKey whose page GET is answered by destroying the socket — the receiver's fetch REJECTS rather than
     * reading a non-ok status, which is the failure a transfer meets mid-cycle when the peer goes away.
     */
    failFamily: null,
    /**
     * `(req, res, family) => void | Promise<void>` — answers a record family's page GET INSTEAD of the canned route below
     * (which serves one page and ignores `sinceSeq`, `limit` and `cursor`). For a case whose subject is how a page is
     * PAGED: the real handler (`door.serveFamily`) over `seedPeerRecords`, or a fake pinned to another server's paging
     * (a 5.6 server's strict `seq >` and riders). Unset, the canned route answers, as every other case expects.
     */
    family: null,
    /**
     * `(key, items, n) => { status?: number, body?: object } | undefined` — answers a `batch-upsert` POST INSTEAD of the
     * default `{ status: 'ok' }` (`n` counts the requests since `reset`, from 1). A non-200 `status` is a refusal of the
     * whole request, and its items are NOT added to `pushedRecords`; a `body` of `{ [key]: { rejected } }` is the peer
     * discarding records it answered 200 for. `undefined` falls through to the default.
     */
    batchUpsert: null,
    /** Every `batch-upsert` request the receiver sent, accepted or not: `{ key, ids, status }`, in arrival order. */
    batchRequests: [],
    /** Every record-family page GET `serveFamily` answered, its query as the receiver wrote it plus the `family`. */
    familyRequests: [],
    /**
     * `(req, res, next) => void` — answers the governance routes under `/api/sync/networks` (member gossip, votes,
     * change notes) as a case scripts them; `req.path` is what follows `/api/sync/networks`. Unset, they 404, as
     * every route the fake peer does not serve does.
     */
    network: null,
    // ── the file routes (`files: true` only) ────────────────────────────────────────────────────────────────────────
    /** Every `GET /file-tombstones` the receiver sent, its query as the receiver wrote it. */
    fileTombstoneRequests: [],
    /** Every file tombstone the receiver PUSHED, in arrival order, and each request's body `{ n, answer }`. */
    fileTombstonesReceived: [],
    fileTombstonePosts: [],
    /**
     * `(req, res) => void | Promise<void>` — answers `GET /file-tombstones` INSTEAD of the real handler: a scripted older
     * server (no `cursor` mode, no `nextCursor`, `issuer`-less rows) or a server that fails. Unset, the real handler
     * answers over `seedPeerFileTombstones`.
     */
    fileTombstoneGet: null,
    /** The same for `POST /file-tombstones`: `(req, res) => void | Promise<void>`. */
    fileTombstonePost: null,
    /** Every `GET /manifest` the receiver sent, and `(req, res) => …` to answer it INSTEAD of the real handler. */
    manifestRequests: [],
    manifest: null,
    /** Every `GET /api/files/:space?path=` the receiver sent (the byte download), by `{ space, path }`. */
    fileDownloads: [],
    /**
     * Every `POST /api/files/:space?path=` the receiver sent (the byte push): `{ space, path, sha256, size }`. Answered
     * `{ status: 'ok' }` unless `fileUpload` — `(info, res) => boolean` — answers it and returns true.
     */
    fileUploads: [],
    fileUpload: null,
  };

  const app = express();
  // Production's middleware and filter, first in the chain as in `app.ts`.
  const { shouldCompress } = await import('../../server/dist/util/transfer.js');
  app.use(compression({ filter: (req, res) => shouldCompress(req, res, compression.filter) }));
  app.get('/api/sync/tombstones', async (req, res) => {
    const asked = { ...req.query };
    state.requests.push(asked);
    const query = { ...asked, spaceId: peerSide(asked.spaceId) };
    delete query.networkId;
    Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
    req.authToken = SERVING_TOKEN;
    const answer = { encoding: undefined, bytes: 0 };
    state.answers.push(answer);
    const json = res.json.bind(res);
    res.json = (body) => {
      const out = state.tamper ? (state.tamper(body, asked) ?? body) : body;
      answer.bytes = Buffer.byteLength(JSON.stringify(out));
      return json(out);
    };
    res.on('finish', () => { answer.encoding = res.getHeader('Content-Encoding'); });
    await door.handler('get', '/tombstones')(req, res);
  });
  app.post('/api/sync/tombstones', express.json({ limit: '100mb' }), (req, res) => {
    const page = Array.isArray(req.body?.tombstones) ? req.body.tombstones : [];
    state.received.push(...page);
    res.json({ applied: page.length, refused: 0 });
  });
  // A record page this instance pushes is accepted whole — what a push of records does is the push door's question.
  app.post('/api/sync/batch-upsert', express.json({ limit: '100mb' }), (req, res) => {
    const entries = Object.entries(req.body ?? {}).filter(([, items]) => Array.isArray(items));
    const scripted = entries.length === 1 && state.batchUpsert
      ? state.batchUpsert(entries[0][0], entries[0][1], state.batchRequests.length + 1) : undefined;
    const status = scripted?.status ?? 200;
    for (const [key, items] of entries) state.batchRequests.push({ key, ids: items.map(d => d?._id), status });
    if (status !== 200) { res.status(status).json(scripted?.body ?? { error: 'scripted refusal' }); return; }
    for (const [key, items] of entries) state.pushedRecords.push(...items.map(d => ({ key, ...d })));
    res.json(scripted?.body ?? { status: 'ok' });
  });
  app.use('/api/sync/networks', express.json({ limit: '100mb' }), (req, res, next) => {
    if (state.network) state.network(req, res, next); else next();
  });
  if (files) {
    /** Serve a real sync route over the peer-side space the receiver asked for as `spaceId` (query or body). */
    const serveReal = async (req, res, method, route, token) => {
      const asked = { ...req.query };
      const query = { ...asked };
      if (typeof asked.spaceId === 'string') query.spaceId = peerSide(asked.spaceId);
      delete query.networkId;
      Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
      if (req.body && typeof req.body.spaceId === 'string') req.body = { ...req.body, spaceId: peerSide(req.body.spaceId) };
      req.authToken = token;
      await door.handler(method, route)(req, res);
    };
    const failed = (res) => (err) => { if (!res.headersSent) res.status(500).json({ error: String(err) }); };
    app.get('/api/sync/file-tombstones', async (req, res) => {
      state.fileTombstoneRequests.push({ ...req.query });
      if (state.fileTombstoneGet) { await Promise.resolve(state.fileTombstoneGet(req, res)).catch(failed(res)); return; }
      await serveReal(req, res, 'get', '/file-tombstones', SERVING_TOKEN).catch(failed(res));
    });
    app.post('/api/sync/file-tombstones', express.json({ limit: '100mb' }), async (req, res) => {
      const sent = Array.isArray(req.body?.tombstones) ? req.body.tombstones : [];
      state.fileTombstonesReceived.push(...sent);
      const post = { n: state.fileTombstonePosts.length + 1, count: sent.length, answer: undefined };
      state.fileTombstonePosts.push(post);
      const json = res.json.bind(res);
      res.json = (b) => { post.answer = { code: res.statusCode, body: b }; return json(b); };
      if (state.fileTombstonePost) { await Promise.resolve(state.fileTombstonePost(req, res)).catch(failed(res)); return; }
      // The receiving side of this push is the real handler over the PEER's storage, authenticated as the instance that
      // pushed (so a tombstone it issued is its own, as a real peer's apply reads it).
      await serveReal(req, res, 'post', '/file-tombstones', { ...SERVING_TOKEN, peerInstanceId: `${suite}-receiver` }).catch(failed(res));
    });
    app.get('/api/sync/manifest', async (req, res) => {
      state.manifestRequests.push({ ...req.query });
      if (state.manifest) { await Promise.resolve(state.manifest(req, res)).catch(failed(res)); return; }
      await serveReal(req, res, 'get', '/manifest', SERVING_TOKEN).catch(failed(res));
    });
    // The plain file routes: the bytes under the peer's disk, canned (what the byte door does is the door's own question).
    app.get('/api/files/:space', (req, res) => {
      const rel = String(req.query.path ?? '');
      state.fileDownloads.push({ space: req.params.space, path: rel });
      const abs = path.join(peerFilesRoot(req.params.space.replace(/^peer-/, '')), rel);
      if (!fs.existsSync(abs)) { res.status(404).json({ error: 'not on the fake peer' }); return; }
      res.type('application/octet-stream').send(fs.readFileSync(abs));
    });
    app.post('/api/files/:space', express.raw({ type: '*/*', limit: '100mb' }), (req, res) => {
      const bytes = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
      const info = { space: req.params.space, path: String(req.query.path ?? ''), size: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex') };
      state.fileUploads.push(info);
      if (state.fileUpload?.(info, res)) return;
      res.json({ status: 'ok' });
    });
  }
  app.get('/api/sync/:family', (req, res) => {
    if (!families.includes(req.params.family)) { res.status(404).json({ error: 'not served by the fake peer' }); return; }
    if (state.failFamily === req.params.family) { req.socket.destroy(); return; }
    if (state.family) {
      Promise.resolve(state.family(req, res, req.params.family))
        .catch(err => { if (!res.headersSent) res.status(500).json({ error: String(err) }); });
      return;
    }
    const items = state.records[req.query.spaceId]?.[req.params.family] ?? [];
    res.json({ items: req.query.cursor ? [] : items, nextCursor: null });
  });
  app.use((_req, res) => { res.status(404).json({ error: 'not served by the fake peer' }); });
  const server = await new Promise(resolve => { const s = app.listen(0, '0.0.0.0', () => resolve(s)); });
  const url = `http://${host}:${server.address().port}`;

  const space = (id) => ({ id, label: id, folders: [], meta: meta[id] ?? {}, ...(spaceExtra[id] ?? {}) });
  const peerSpaces = [...remoteOf.values()].map(peerSide);
  try {
    door = await openPushDoor({
      suite, monitorCommands,
      spaces: [...spaces, ...extraSpaces, ...peerSpaces].map(space),
      networks: [{
        id: NET, label: 'Pull-door network', type, spaces, votes: [], votingDeadlineHours: 24,
        ...(spaceMap ? { spaceMap } : {}),
        ...(type === 'club' ? { origin: 'joined' } : {}),
        ...(myParentInstanceId !== undefined ? { myParentInstanceId } : {}),
        members: [{ instanceId: PEER, label: PEER_LABEL, url, tokenHash: 'x', direction, ...(memberExtra ?? {}) }],
      }, ...(lateral ? [lateralNetwork(lateral)] : [])],
      secrets: { peerTokens: { [PEER]: 'pull-door-token' } },
    });
  } catch (err) {
    await new Promise(r => server.close(r));
    throw err;
  }
  const loader = await import('../../server/dist/config/loader.js');
  const engine = await import('../../server/dist/sync/engine.js');
  const seq = await import('../../server/dist/util/seq.js');
  const { log } = await import('../../server/dist/util/log.js');
  families = (await import('../../server/dist/sync/replicated-families.js')).REPLICATED_FAMILIES.map(f => f.payloadKey);
  maxCap = (await import('../../server/dist/util/bounded-read.js')).maxUpstreamResponseBytes();

  /** This instance's record of the fake peer, live. */
  const member = () => loader.getConfig().networks.find(n => n.id === NET).members.find(m => m.instanceId === PEER);

  /** Store tombstones on the fake peer for the space it is asked for as `remote`, and settle them. */
  async function seedPeer(remote, tombstones) {
    if (tombstones.length === 0) return;
    await door.mongo.col(`${peerSide(remote)}_tombstones`).insertMany(tombstones.map(t => ({ ...t })), { ordered: false });
    await seq.bumpSeq(peerSide(remote), tombstones.reduce((m, t) => Math.max(m, t.seq), 0));
  }

  /** The member fields a `configure` added, so `reset` can take them off again. */
  const configuredKeys = new Set();

  /** The fake peer's file-tombstone rows for the space it is asked for as `remote`, stored and served by the REAL handler. */
  async function seedPeerFileTombstones(remote, docs) {
    if (docs.length === 0) return;
    await door.mongo.col(`${peerSide(remote)}_file_tombstones`).insertMany(docs.map(d => ({ ...d })), { ordered: false });
  }

  /** The directory a peer-side space's files live in, and this instance's own. */
  function peerFilesRoot(remote) { return path.join(loader.getDataRoot(), 'files', peerSide(remote)); }
  function localFilesRoot(local) { return path.join(loader.getDataRoot(), 'files', local); }

  /** Put bytes on the fake peer's disk for the space it is asked for as `remote`: what its manifest advertises. */
  function seedPeerFile(remote, rel, bytes) {
    const abs = path.join(peerFilesRoot(remote), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }

  /** Put bytes on THIS instance's disk for a local space, as an earlier arrival or upload left them. */
  function writeLocalFile(local, rel, bytes) {
    const abs = path.join(localFilesRoot(local), rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, bytes);
  }
  const localFileExists = (local, rel) => fs.existsSync(path.join(localFilesRoot(local), rel));

  /**
   * Rewrite the LIVE network config for the next cases — the topology a case is about, on the one door the process has.
   * Every field is optional; what is not named stays. `reset` returns to the topology the door opened with.
   *
   * @param {object} [o]
   * @param {string} [o.type]  the network's type
   * @param {string|null} [o.myParentInstanceId]  a braintree parent (`null` removes it)
   * @param {'pull'|'push'|'both'} [o.direction]  the fake peer's direction, from this instance's view
   * @param {object} [o.memberExtra]  fields merged into the fake peer's member record
   * @param {boolean|string[]} [o.lateral]  carry the spaces through a club network with a `LATERAL` member (`false` removes it)
   */
  function configure({ type: t, myParentInstanceId: parent, direction: d, memberExtra: extra, lateral: l } = {}) {
    const cfg = loader.getConfig();
    const net = cfg.networks.find(n => n.id === NET);
    if (t !== undefined) {
      net.type = t;
      if (t === 'club') net.origin = 'joined';
    }
    if (parent !== undefined) { if (parent === null) delete net.myParentInstanceId; else net.myParentInstanceId = parent; }
    if (d !== undefined) member().direction = d;
    if (extra) { Object.assign(member(), extra); for (const k of Object.keys(extra)) configuredKeys.add(k); }
    if (l !== undefined) {
      cfg.networks = cfg.networks.filter(n => n.id !== LATERAL_NET);
      if (l) cfg.networks.push(lateralNetwork(l));
    }
  }

  /** Forget everything a previous case left: both sides' rows, the receiver's watermarks, the fake peer's logs. */
  async function reset({ direction: d = direction } = {}) {
    for (const s of [...spaces, ...extraSpaces]) await door.wipe(s);
    for (const p of peerSpaces) await door.mongo.col(`${p}_tombstones`).deleteMany({});
    // The topology goes back to what the door opened with, and the receiver's repair state is owed again: a case that
    // `configure`d or re-read must not decide the next one.
    configure({ type: initial.type, myParentInstanceId: initial.myParentInstanceId ?? null, lateral: initial.lateral });
    if (files) {
      for (const s of [...spaces, ...extraSpaces, ...peerSpaces]) {
        for (const part of ['file_tombstones', 'file_hashes']) await door.mongo.col(`${s}_${part}`).deleteMany({});
        fs.rmSync(path.join(loader.getDataRoot(), 'files', s), { recursive: true, force: true });
      }
    }
    const m = member();
    for (const k of configuredKeys) delete m[k];
    configuredKeys.clear();
    for (const k of Object.keys(initial.memberExtra)) m[k] = initial.memberExtra[k];
    delete m.tombstoneRereadAt;
    // The file-tombstone acknowledgement is a watermark too, and it only ever moves forward: left from a case that pushed
    // everything, it would stand in for the next case's own position and every "acknowledged up to here" row would read it.
    delete m.lastFileTombstoneAckedAt;
    m.lastSeqReceived = {}; m.lastSeqPushed = {}; m.direction = d;
    for (const p of peerSpaces) for (const f of families) await door.mongo.col(`${p}_${familyCollection(f)}`).deleteMany({});
    Object.assign(state, {
      tamper: null, requests: [], answers: [], received: [], pushedRecords: [], records: {}, failFamily: null, network: null,
      family: null, batchUpsert: null, batchRequests: [], familyRequests: [],
      fileTombstoneRequests: [], fileTombstonesReceived: [], fileTombstonePosts: [], fileTombstoneGet: null, fileTombstonePost: null,
      manifestRequests: [], manifest: null, fileDownloads: [], fileUploads: [], fileUpload: null,
    });
  }

  /** The collection suffix a family's records are stored in (`filemeta` is the `files` collection). */
  const familyCollection = (payloadKey) => (payloadKey === 'filemeta' ? 'files' : payloadKey);

  /**
   * Store record documents on the fake peer for the space it is asked for as `remote`, and settle them, for a case that
   * serves them through the REAL page handler (`serveFamily`). The documents keep whatever `spaceId` the case gave them.
   */
  async function seedPeerRecords(remote, payloadKey, docs) {
    if (docs.length === 0) return;
    await door.mongo.col(`${peerSide(remote)}_${familyCollection(payloadKey)}`).insertMany(docs.map(d => ({ ...d })), { ordered: false });
    await seq.bumpSeq(peerSide(remote), docs.reduce((m, d) => Math.max(m, d.seq), 0));
  }

  /**
   * Answer a record family's page GET with the REAL handler over the peer's own storage, as `GET /tombstones` is
   * answered above: the query's space is rewritten to the peer-side space and the serving token set. For `state.family`.
   */
  async function serveFamily(req, res, family) {
    const asked = { ...req.query };
    state.familyRequests.push({ ...asked, family });
    const query = { ...asked, spaceId: peerSide(asked.spaceId) };
    delete query.networkId;
    Object.defineProperty(req, 'query', { value: query, writable: true, configurable: true, enumerable: true });
    req.authToken = SERVING_TOKEN;
    await door.handler('get', `/${family}`)(req, res);
  }

  /** One sync cycle of the real engine with the fake peer. */
  async function sync() {
    const out = await engine.runSyncForPeer(PEER);
    await door.settled();
    return out;
  }

  /** Every warn and error line the server logs while `fn` runs, and its result. */
  async function logsDuring(fn) {
    const lines = [];
    const orig = { warn: log.warn, error: log.error };
    log.warn = (...a) => { lines.push(a.join(' ')); };
    log.error = (...a) => { lines.push(a.join(' ')); };
    try { return { result: await fn(), lines }; } finally { Object.assign(log, orig); }
  }

  async function close() {
    await new Promise(r => server.close(r));
    await door.close();
  }

  return {
    ...door, NET, url, state, instanceId: `${suite}-receiver`, remoteOf: (local) => remoteOf.get(local), maxUpstreamBytes: maxCap,
    member, seedPeer, seedPeerRecords, serveFamily, peerSide, reset, sync, logsDuring, bumpSeq: seq.bumpSeq, close,
    configure, config: () => loader.getConfig(), LATERAL_NET, seedPeerFileTombstones, seedPeerFile, writeLocalFile, localFileExists, peerFilesRoot, localFilesRoot,
  };
}
