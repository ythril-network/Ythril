/**
 * Every door answers a store failure alike: `503`, `Retry-After`, `retryable: true`, one message of ours in one
 * spelling, and none of the driver's text — REST reads and writes, the REST tool door, and MCP (bundle-30 I12, from
 * verify-drive-2 findings 2, 3 and 5).
 *
 * ## The findings this gate is written from
 *
 * With the store paused, the doors disagreed: `/api/brain/recall`, `/api/brain/similar` and every `/api/<tool>` answered
 * 503 without `Retry-After`; `POST /api/brain/spaces/:s/entities` answered `500 Internal server error` (which is what
 * the UI's create form showed an operator for a retryable condition); `GET /api/conflicts` answered `500 Internal
 * error`; and the same failure read "Error: A store-side…" on one door and "A store-side…" on the next. Each door was
 * written by hand, and a gate built on the one shared helper's CALL SITES could only see the doors that already
 * called it.
 *
 * ## The doors are read from the mounts, never from the sender
 *
 * Every route the server mounts (`_routes.mjs`, the mount graph), with `/api/:tool` expanded over every tool, plus every
 * tool through `callTool` as MCP reaches it — and each boolean query flag a route reads, as a door of its own
 * (`flagsOf`): a sync trigger answers `triggered` before its cycle touches the store unless asked to `wait`. Each is called with the store failing BELOW the server — the driver's
 * own `Server.command`, the one function every operation the driver sends goes through, throws the error the drive
 * saw (a real `PoolClearedError`, built by the driver's own constructor). Nothing here names a server module's
 * catch, so a door added next month is asked the day it is mounted.
 *
 * ## Which doors are held to it
 *
 * A door is asked about the store only if its request REACHED the store: the fault counts the operations it fails
 * per request id, and a door that refused the request before that (a validation `400`, a rights `403`) said nothing
 * about a store failure either way. The set that reached it is floored, so a fault that stopped firing — or a body
 * that stopped getting past validation — cannot leave a short list that passes. Every door, reached or not, is held
 * to carrying none of the driver's text.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-store-failure-answers-alike-on-every-door-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { mountedRoutesWithSource } from './_routes.mjs';

const skip = await mongoSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'storedown';
const UUID = 'cccccccc-0000-4000-8000-0000000000d1';
const UUID2 = 'cccccccc-0000-4000-8000-0000000000d2';
const HOST = 'mongo-a.internal:27017';
const ADDRESS = '172.16.0.9';
/** The driver's text, as the drive saw it: an internal host, a private address and a port. */
const LEAK = /mongo-a\.internal|172\.16\.0\.9|27017|Connection pool for|MongoPoolClearedError/;
/** How many doors must reach the failing store for the run to conclude anything. Raise it; never lower it. */
const REACHED_FLOOR = 60;
const PER_DOOR_MS = 20_000;

// The driver the SERVER loads, so the patched class is the one its operations go through.
const requireFromServer = createRequire(path.resolve('server/package.json'));
const driverLib = path.dirname(requireFromServer.resolve('mongodb'));
const { Server } = requireFromServer(path.join(driverLib, 'sdam', 'server.js'));
const { Topology } = requireFromServer(path.join(driverLib, 'sdam', 'topology.js'));
const { BulkOperationBase } = requireFromServer(path.join(driverLib, 'bulk', 'common.js'));
const { PoolClearedError, PoolClosedError, WaitQueueTimeoutError } = requireFromServer(path.join(driverLib, 'cmap', 'errors.js'));
const { MongoNetworkTimeoutError, MongoServerSelectionError, MongoWriteConcernError } = requireFromServer('mongodb');

/**
 * The two ways the store is gone, each raised where the driver raises it, and each run over every door.
 *
 * **One fault was not enough (bundle-30 I14, verify-drive-4 D1).** A pool cleared under a command is a
 * `MongoNetworkError` carrying the driver's `PoolRequestedRetry` label. When a BULK write (`insertMany`, `bulkWrite`)
 * meets it, the driver wraps it in a `MongoBulkWriteError` that keeps the label — so the wrapper was recognised, and
 * the gate passed. With the store paused, the driver instead fails to SELECT a server: a `MongoServerSelectionError`
 * with no label, wrapped the same way into an error carrying neither class nor label, which every door answered `400`
 * with the store's address. So both faults run, and the second must reach a bulk write on enough doors (floored
 * below) for its run to say anything about one.
 */
const FAULTS = [
  { id: 'pool-cleared', what: 'a pooled connection cleared under a command', answers: 'retry' },
  { id: 'no-server', what: 'no server can be selected — the paused store, which a bulk write wraps without a label', answers: 'retry' },
  // bundle-53 G1 (Q-330): the pool's own two errors are `MongoDriverError`s, not network errors — answered 500, "an
  // internal fault", for an exhausted or a closed pool, which is the store not answering.
  { id: 'wait-queue-timeout', what: 'a connection could not be checked out of the pool in time', answers: 'retry' },
  { id: 'pool-closed', what: 'a connection was asked of a closed pool', answers: 'retry' },
  // bundle-53 G1 (Q-343): a write concern that can never be met is a misconfiguration, so it is a 500 that says so and
  // says not to retry — answered 503 it was retried for ever. Raised on WRITES only (a read cannot raise one), so
  // fewer doors reach it; the floor is its own.
  { id: 'unsatisfiable-write-concern', what: 'a write whose write concern the deployment can never meet', answers: 'misconfigured', floor: 20 },
];
/** The commands a write sends: the unsatisfiable-write-concern fault is raised on these and on no read. */
const WRITE_COMMANDS = new Set(['insert', 'update', 'delete', 'findAndModify']);
/** The driver's text, as each fault's error carries it: the one string the log must hold once and no answer may. */
const MARKER = `${ADDRESS}:27017 timed out`;
/** What each command fault throws, built by the driver's own constructors; the marker is in the message the way an address is. */
const COMMAND_FAULTS = {
  'pool-cleared': () => new PoolClearedError({
    address: HOST,
    serverError: new MongoNetworkTimeoutError(`connection <monitor> to ${MARKER}`),
  }),
  'wait-queue-timeout': () => new WaitQueueTimeoutError(`Timed out while checking out a connection from connection pool (${MARKER}; ${HOST})`, HOST),
  'pool-closed': () => {
    const e = new PoolClosedError({ address: HOST });
    e.message = `Attempted to check out a connection from closed connection pool (${MARKER}; ${HOST})`;
    return e;
  },
  'unsatisfiable-write-concern': () => new MongoWriteConcernError({
    writeConcernError: { code: 100, codeName: 'UnsatisfiableWriteConcern', errmsg: `Not enough data-bearing nodes (${MARKER}; ${HOST})` },
  }),
};
/**
 * How many doors must meet a failed BULK write under the selection fault, or that run proves nothing about one. Most
 * doors read before they write, and a failed read is not wrapped; the file deletes reach the tombstone `insertMany`
 * first once a probe has left a file at their path. Raise it; never lower it.
 */
const BULK_REACHED_FLOOR = 2;

/** A body that gets past the commonest validation, so a write door reaches the store rather than a 400. */
const BODY = {
  space: S, spaceId: S, name: 'Store Down Probe', type: 'concept', fact: 'a fact written while the store is down',
  title: 'Store down', label: 'relates', from: UUID, to: UUID2, query: 'lighthouse', id: UUID, ids: [UUID],
  entryId: UUID, path: 'probe.txt', content: 'probe', tags: [], properties: {}, description: 'probe',
  startsAt: '2026-01-01T00:00:00.000Z', status: 'upcoming', filter: {}, collection: 'entities', topK: 5,
};

/** A path's parameters filled: the space, a record id, or a placeholder. */
function fill(routePath) {
  return routePath.replace(/:(\w+)/g, (_, p) => {
    if (/^space(Id)?$/i.test(p)) return S;
    if (/id$/i.test(p)) return UUID;
    return 'probe';
  });
}

/**
 * The boolean query flags a route reads (`req.query['wait'] === 'true'`), from the route's own source. A door whose
 * store work sits behind a flag answers before it reaches the store unless the probe sets the flag — `POST
 * /api/networks/:id/sync` answers `triggered` and runs the cycle after the answer, so only `?wait=true` reaches the
 * catch that answers the cycle's failure (bundle-30 I13: that catch answered the driver's text, and no probe sent
 * `wait`). Derived, so a flag added to a route next month is probed the day it is read.
 */
function flagsOf(source) {
  return [...new Set([...source.matchAll(/req\.query(?:\['(\w+)'\]|\.(\w+))\s*===\s*'(?:true|1)'/g)].map(m => m[1] ?? m[2]))];
}

/**
 * The network the flag variants find. Its id is the probe's `:id` (`fill`), so a network door whose work is behind a
 * flag reaches it instead of a `404 Network not found`; one member, so a sync cycle has a member to run. Present only
 * while the variants are asked, so it changes the reach of no other door.
 */
const NETWORK = {
  id: UUID, label: 'Store down network', type: 'pubsub', spaces: [S], pendingRounds: [], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z',
  members: [{ instanceId: UUID, label: 'Store down peer', url: 'http://127.0.0.1:9', tokenHash: 'x', direction: 'both' }],
};

/** Arguments a tool's own schema admits: every required property, given a value of its type. */
function argsFor(schema) {
  const valueOf = (key, s = {}) => {
    const branch = s.anyOf?.[0] ?? s.oneOf?.[0];
    if (branch) return valueOf(key, branch);
    if (key === 'space') return S;
    if (Array.isArray(s.enum) && s.enum.length) return s.enum[0];
    const type = Array.isArray(s.type) ? s.type[0] : s.type;
    if (type === 'string') {
      if (s.format === 'date-time' || /At$/.test(key)) return '2026-01-01T00:00:00.000Z';
      if (s.format === 'uuid' || /(^id$|Id$|^from$|^to$)/.test(key)) return key === 'to' ? UUID2 : UUID;
      return BODY[key] && typeof BODY[key] === 'string' ? BODY[key] : 'probe';
    }
    if (type === 'number' || type === 'integer') return s.minimum ?? 1;
    if (type === 'boolean') return false;
    if (type === 'array') return s.minItems ? [valueOf(key, s.items ?? {})] : [];
    if (type === 'object') return Object.fromEntries((s.required ?? []).map(k => [k, valueOf(k, s.properties?.[k])]));
    return 'probe';
  };
  const out = { space: S };
  for (const k of schema.required ?? []) out[k] = valueOf(k, schema.properties?.[k]);
  return out;
}

let door, base, adminKey, callTool, ADMIN, server, TOOLS, schemaOf, log, getConfig;

/**
 * Operations the fault failed BEFORE the request was answered, per request id — so a door is judged only on what it
 * reached. A failure after the answer (the audit row a finished request writes) cannot change what the caller read.
 */
const failedByRequest = new Map();
/** Request ids whose status line has been written: the answer is decided from that moment. */
const answered = new Set();
/** Every log line while the doors run, and how many there were when each request was answered. */
const lines = [];
const linesAtAnswer = new Map();
const markAnswered = (id) => {
  if (answered.has(id)) return;
  answered.add(id);
  linesAtAnswer.set(id, lines.length);
};
let failing = false;
/** Which of {@link FAULTS} is failing the store while `failing` is set. */
let fault = FAULTS[0].id;
/** Request ids whose answer came after a bulk write the driver wrapped a failure of — the D1 shape. */
const bulkWrapped = new Set();
const realCommand = Server.prototype.command;
const realSelectServer = Topology.prototype.selectServer;
const realBulkExecute = BulkOperationBase.prototype.execute;
const realWriteHead = http.ServerResponse.prototype.writeHead;
const countFailure = () => {
  const id = log.currentRequestId() ?? '(none)';
  if (!answered.has(id)) failedByRequest.set(id, (failedByRequest.get(id) ?? 0) + 1);
};

/**
 * Doors excused from the leak check, each for a reason that is the door's own: the log viewer serves the operator's
 * log, which is where the driver's text is SUPPOSED to go.
 */
const SERVES_THE_LOG = new Set(['GET /api/about/logs', 'GET /api/about/logs/stream']);

/**
 * Doors whose answer REPORTS the store's state rather than failing on it — held to the leak check, not to the 503.
 * Each reason is the door's own contract; a door added here without one is the defect this gate exists to find.
 */
const REPORTS_THE_STORE = new Map([
  ['GET /metrics', 'a scrape answers what its collectors could gather — partial beats nothing (the budget in metrics/registry.ts)'],
  ['GET /api/admin/pipeline-status', 'a status report: a failing store is one of the conditions it reports, in its body'],
  ['GET /ready', 'a readiness probe: its 503 and `{ready: false, checks}` ARE its contract with the orchestrator'],
  // A waited sync cycle answers what each member's run came to: a member whose run failed on the store is counted in
  // `errors` (the per-member catch in `sync/engine.ts`), and the cycle itself completed. Its own failure path —
  // `sync/trigger.ts`'s catch — answers through `sendCaughtFailure` like every route catch.
  ['POST /api/networks/:id/sync?wait=true', 'a waited sync trigger reports the cycle: a member that failed on the store is counted in `errors`'],
  ['POST /api/networks/peers/:peerId/sync?wait=true', 'a waited peer sync reports the cycle: a member that failed on the store is counted in `errors`'],
  // The listing is the Brain overview's load; `counts` is an optional extra per space (`Promise.allSettled`), so a
  // space whose count failed is listed without one rather than failing the whole listing.
  ['GET /api/spaces?counts=true', 'the space listing with optional counts: a space whose count failed is listed without them'],
  // Asked since the probes find a stored file (bundle-30 I14): an empty directory never reached the store.
  ['GET /api/files/:spaceId', 'the Files listing is read from disk; the metadata it adds (status, tags, folder sizes, live stage) is optional per member, and a member whose read failed is listed without it (`enrichEntries`)'],
]);

describe('a store failure answers alike on every door', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'storedown', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    log = await import('../../server/dist/util/log.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const tools = await import('../../server/dist/mcp/tools/index.js');
    TOOLS = [...tools.TOOLS_BY_NAME.keys()];
    const { toolSchemasFor, materialisedSchema } = await import('../../server/dist/mcp/tool-schema.js');
    const schemas = toolSchemasFor([S]);
    schemaOf = name => materialisedSchema(tools.TOOLS_BY_NAME.get(name), schemas, [S, 'other']);
    const { createApp } = await import('../../server/dist/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;

    http.ServerResponse.prototype.writeHead = function answeredHere(...args) {
      const id = log.currentRequestId();
      if (id) markAnswered(id);
      return realWriteHead.apply(this, args);
    };
    Server.prototype.command = async function storeDown(...args) {
      const make = COMMAND_FAULTS[fault];
      if (!failing || !make) return realCommand.apply(this, args);
      // A write concern can only fail a write: a read is never answered with one, so it goes through.
      if (fault === 'unsatisfiable-write-concern' && !WRITE_COMMANDS.has(args[0]?.commandName)) return realCommand.apply(this, args);
      countFailure();
      throw make();
    };
    // Raised where the driver raises it, with the topology's own description as its reason, as `selectServer` does.
    Topology.prototype.selectServer = async function noServer(...args) {
      if (!failing || fault !== 'no-server') return realSelectServer.apply(this, args);
      // A real selection fails when its timeout runs out, never in the same tick it was asked: thrown synchronously,
      // the audit row a finished tool call starts (and does not wait for) was counted against a request already
      // answered, as if its failure had been that request's.
      await new Promise(r => setImmediate(r));
      countFailure();
      throw new MongoServerSelectionError(`connection <monitor> to ${ADDRESS}:27017 timed out`, this.description);
    };
    // Observes, changes nothing: which requests met a bulk write the driver wrapped a failure of.
    BulkOperationBase.prototype.execute = async function observed(...args) {
      try { return await realBulkExecute.apply(this, args); } catch (err) {
        if (failing && err?.name === 'MongoBulkWriteError' && err.errorResponse instanceof Error) {
          bulkWrapped.add(log.currentRequestId() ?? '(none)');
        }
        throw err;
      }
    };
  });
  after(async () => {
    Server.prototype.command = realCommand;
    Topology.prototype.selectServer = realSelectServer;
    BulkOperationBase.prototype.execute = realBulkExecute;
    http.ServerResponse.prototype.writeHead = realWriteHead;
    failing = false;
    await new Promise(r => server?.close(r));
    await door?.close();
  });

  /**
   * The space as the first fault found it, for each fault: no files, no records. A door's reach depends on what the
   * doors before it left behind (a probe file written while the store was down is still on disk), so a second run
   * over the first one's leftovers would be asked different questions and conclude about neither.
   */
  async function freshSpace() {
    const files = path.join(process.env['DATA_ROOT'], 'files', S);
    fs.rmSync(files, { recursive: true, force: true });
    fs.mkdirSync(files, { recursive: true });
    for (const { name } of await door.mongo.getDb().listCollections({}, { nameOnly: true }).toArray()) {
      if (name.startsWith(`${S}_`)) await door.mongo.getDb().collection(name).deleteMany({});
    }
    // A stored file at the probes' path, so a file delete's first store write is its tombstone — a BULK write — and
    // every file door is asked about a file that exists rather than refused for one that does not.
    fs.writeFileSync(path.join(files, BODY.path), 'probe');
    await door.mongo.col(`${S}_files`).insertOne({ _id: BODY.path, spaceId: S, path: BODY.path, sizeBytes: 5, tags: [],
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  }

  /** Every door: REST from the mounts (the tool door per tool), then MCP per tool. */
  function doors() {
    const out = [];
    for (const r of mountedRoutesWithSource()) {
      if (r.path.includes(':tool')) {
        for (const t of TOOLS) out.push({ kind: 'rest', name: `${r.method} ${r.path.replace(':tool', t)}`, method: r.method, url: r.path.replace(':tool', t), body: argsFor(schemaOf(t)) });
        continue;
      }
      out.push({ kind: 'rest', name: `${r.method} ${r.path}`, method: r.method, url: fill(r.path), body: BODY });
      for (const flag of flagsOf(r.source)) {
        out.push({ kind: 'rest', name: `${r.method} ${r.path}?${flag}=true`, method: r.method, url: `${fill(r.path)}?${flag}=true`, body: BODY, variant: true });
      }
    }
    for (const t of TOOLS) out.push({ kind: 'mcp', name: `MCP ${t}`, tool: t, args: argsFor(schemaOf(t)) });
    return out;
  }

  async function ask(d) {
    if (d.kind === 'mcp') {
      // An MCP request is one id for the whole call, as the HTTP middleware gives one; the fault reads it.
      const requestId = `mcp-${d.tool}-${Math.random().toString(36).slice(2)}`;
      const out = await log.runWithRequestId(requestId, () => callTool({ name: d.tool, args: d.args,
        caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } }));
      markAnswered(requestId);
      const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
      const sc = out.result.structuredContent ?? {};
      return { requestId, status: out.result.isError ? out.status : 200, retryAfter: null,
        retryable: sc.retryable, code: sc.code, codeName: sc.codeName, error: text, raw: `${text}\n${JSON.stringify(sc)}` };
    }
    const sep = d.url.includes('?') ? '&' : '?';
    const url = `${base}${d.url}${d.url.startsWith('/api/sync') ? `${sep}spaceId=${S}` : ''}`;
    const init = { method: d.method, headers: { Authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(PER_DOOR_MS) };
    if (!['GET', 'DELETE'].includes(d.method)) {
      init.headers['Content-Type'] = 'application/json';
      init.body = JSON.stringify(d.body);
    }
    let r, raw;
    try {
      r = await fetch(url, init);
      raw = await r.text();
    } catch (err) {
      return { status: r?.status ?? 0, raw: String(err), error: String(err), timedOut: true, streaming: !!r };
    }
    let body; try { body = JSON.parse(raw); } catch { body = null; }
    const retryable = body?.retryable ?? body?.data?.retryable;
    return { requestId: r.headers.get('x-request-id'), status: r.status, retryAfter: r.headers.get('retry-after'),
      retryable, code: body?.code ?? body?.data?.code, codeName: body?.codeName ?? body?.data?.codeName,
      error: typeof body?.error === 'string' ? body.error : null, raw };
  }

  for (const { id: faultId, what, answers, floor = REACHED_FLOOR } of FAULTS) it(`every door that reached the failing store answers ${answers === 'retry' ? '503, Retry-After, retryable' : '500, not retryable, with the code'}, one message, no driver text — ${what}`, { timeout: 30 * 60_000 }, async (t) => {
    fault = faultId;
    const { UNSATISFIABLE_WRITE_CONCERN_MESSAGE } = await import('../../server/dist/brain/store-failure.js');
    await freshSpace();
    const all = doors();
    // The derivation's floor: the sync trigger's `wait` is the flag this case was written from.
    assert.ok(all.some(d => d.variant && d.name === 'POST /api/networks/:id/sync?wait=true'),
      `no flag variant of the network sync trigger was derived — flagsOf no longer reads the routes: ${all.filter(d => d.variant).map(d => d.name)}`);
    const stop = log.subscribeLogLines(l => lines.push(l));
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    const results = [];
    try {
      const networks = getConfig().networks;
      failing = true;
      for (const d of all) {
        if (!d.variant) { results.push({ d, a: await ask(d) }); continue; }
        networks.push(structuredClone(NETWORK));
        try { results.push({ d, a: await ask(d) }); } finally {
          const at = networks.findIndex(n => n.id === NETWORK.id);
          if (at > -1) networks.splice(at, 1);
        }
      }
    } finally {
      failing = false;
      Object.assign(console, saved);
      stop();
    }

    const reached = results.filter(({ a }) => a.requestId && failedByRequest.has(a.requestId));
    const wrong = [];
    const messages = new Map();
    for (const { d, a } of results) {
      if (SERVES_THE_LOG.has(d.name)) continue;
      if (LEAK.test(a.raw)) wrong.push(`${d.name}: answered with the driver's text (${a.status}): ${a.raw.slice(0, 200)}`);
      // A stream that opened (a status line, then events) is a stream, not an answer that never came.
      if (a.timedOut && !(a.streaming && a.status === 200)) wrong.push(`${d.name}: no answer within ${PER_DOOR_MS} ms of a store failure`);
    }
    for (const { d, a } of reached) {
      if (a.streaming || REPORTS_THE_STORE.has(d.name)) continue;
      const why = [];
      if (answers === 'retry') {
        if (a.status !== 503) why.push(`status ${a.status}`);
        if (d.kind === 'rest' && !(Number(a.retryAfter) > 0)) why.push('no Retry-After');
        if (a.retryable !== true) why.push(`retryable ${a.retryable}`);
      } else {
        // A misconfiguration says so: 500, never retryable, no Retry-After, the code and its name, and the named message.
        if (a.status !== 500) why.push(`status ${a.status}`);
        if (d.kind === 'rest' && a.retryAfter) why.push(`Retry-After ${a.retryAfter} on an answer nobody should retry`);
        if (a.retryable !== false) why.push(`retryable ${a.retryable}`);
        if (a.code !== 100) why.push(`code ${a.code}`);
        if (a.codeName !== 'UnsatisfiableWriteConcern') why.push(`codeName ${a.codeName}`);
        if (a.error !== UNSATISFIABLE_WRITE_CONCERN_MESSAGE) why.push(`error ${JSON.stringify(a.error)?.slice(0, 80)}`);
      }
      if (typeof a.error !== 'string' || a.error.startsWith('Error:')) why.push(`error ${JSON.stringify(a.error)?.slice(0, 80)}`);
      else messages.set(a.error, [...(messages.get(a.error) ?? []), d.name]);
      // The operator's log: the driver's text once for this request's answer, not once per layer that saw it. Lines
      // after the answer belong to other operations (the audit row a finished request writes logs its own failure).
      // A misconfiguration is logged once per operation and code per window, so the same text is not repeated per door.
      const logged = lines.slice(0, linesAtAnswer.get(a.requestId) ?? lines.length)
        .filter(l => l.includes(a.requestId) && l.includes(MARKER));
      if (logged.length > 1) why.push(`driver text logged ${logged.length} times: ${logged.map(l => l.slice(0, 140)).join(' | ')}`);
      if (why.length) wrong.push(`${d.name}: ${why.join(', ')} — ${a.raw.slice(0, 160)}`);
    }
    if (messages.size > 1) {
      wrong.push(`one failure, ${messages.size} spellings: ${[...messages].map(([m, ds]) => `${JSON.stringify(m)} (${ds.length} doors, e.g. ${ds[0]})`).join(' | ')}`);
    }

    const viaBulk = reached.filter(({ a }) => bulkWrapped.has(a.requestId));
    t.diagnostic(`${all.length} doors from the mounts and the tool registry; ${reached.length} reached the failing store before answering, ${viaBulk.length} through a failed bulk write (${viaBulk.map(({ d, a }) => `${d.name} ${a.status}`).join(', ')})`);
    assert.ok(reached.length >= floor,
      `only ${reached.length} of ${all.length} doors reached the failing store — the fault or the probe bodies stopped `
      + 'working, and a short list concludes nothing');
    if (faultId === 'no-server') {
      assert.ok(viaBulk.length >= BULK_REACHED_FLOOR,
        `only ${viaBulk.length} door(s) met a failed bulk write under ${faultId} — the run says nothing about the wrapper D1 was`);
    }
    assert.deepEqual(wrong, [], `${wrong.length} door(s) of the ${reached.length} that reached the store (of ${all.length}) answer it differently:\n  ${wrong.join('\n  ')}`);
  });
});
