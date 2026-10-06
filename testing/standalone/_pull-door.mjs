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
 * ## What it does not do
 *
 * It does not stub the engine, the transfer, the apply or the data layer. A case that needs a peer to send what no
 * honest peer would (a forged seq, a malformed element) sets `tamper`, which rewrites the real handler's answer on
 * its way out — the receiver must not trust it either way.
 */
import assert from 'node:assert/strict';
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
 * @param {Record<string, object>} [o.spaceSettings]  local space id -> config keys merged into its entry (a retention
 *   window, say), so a case that asks about this instance's own settings can set them before the config is loaded
 */
export async function openPullDoor({ suite, spaces, spaceMap, extraSpaces = [], direction = 'pull', monitorCommands = false, spaceSettings = {} }) {
  const host = privateHostAddress();
  assert.ok(host, 'no non-loopback IPv4 on this host — callers skip on privateAddressSkipReason() first');
  const NET = `${suite}-net`;
  const remoteOf = new Map(spaces.map(s => [s, s]));
  for (const [remote, local] of Object.entries(spaceMap ?? {})) remoteOf.set(local, remote);

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
  app.get('/api/sync/:family', (req, res) => {
    if (!families.includes(req.params.family)) { res.status(404).json({ error: 'not served by the fake peer' }); return; }
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

  const space = (id) => ({ id, label: id, folders: [], meta: {}, ...(spaceSettings[id] ?? {}) });
  const peerSpaces = [...remoteOf.values()].map(peerSide);
  try {
    door = await openPushDoor({
      suite, monitorCommands,
      spaces: [...spaces, ...extraSpaces, ...peerSpaces].map(space),
      networks: [{
        id: NET, label: 'Pull-door network', type: 'pubsub', spaces, votes: [], votingDeadlineHours: 24,
        ...(spaceMap ? { spaceMap } : {}),
        members: [{ instanceId: PEER, label: PEER_LABEL, url, tokenHash: 'x', direction }],
      }],
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

  /** Forget everything a previous case left: both sides' rows, the receiver's watermarks, the fake peer's logs. */
  async function reset({ direction: d = direction } = {}) {
    for (const s of [...spaces, ...extraSpaces]) await door.wipe(s);
    for (const p of peerSpaces) await door.mongo.col(`${p}_tombstones`).deleteMany({});
    const m = member();
    m.lastSeqReceived = {}; m.lastSeqPushed = {}; m.direction = d;
    for (const p of peerSpaces) for (const f of families) await door.mongo.col(`${p}_${familyCollection(f)}`).deleteMany({});
    Object.assign(state, {
      tamper: null, requests: [], answers: [], received: [], pushedRecords: [], records: {},
      family: null, batchUpsert: null, batchRequests: [], familyRequests: [],
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
  };
}
