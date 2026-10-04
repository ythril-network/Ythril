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
 * tool through `callTool` as MCP reaches it. Each is called with the store failing BELOW the server — the driver's
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
import http from 'node:http';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { mountedRoutes } from './_routes.mjs';

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
const { PoolClearedError } = requireFromServer(path.join(driverLib, 'cmap', 'errors.js'));
const { MongoNetworkTimeoutError } = requireFromServer('mongodb');

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

let door, base, adminKey, callTool, ADMIN, server, TOOLS, schemaOf, log;

/**
 * Operations the fault failed BEFORE the request was answered, per request id — so a door is judged only on what it
 * reached. A failure after the answer (the audit row a finished request writes) cannot change what the caller read.
 */
const failedByRequest = new Map();
/** Request ids whose status line has been written: the answer is decided from that moment. */
const answered = new Set();
let failing = false;
const realCommand = Server.prototype.command;
const realWriteHead = http.ServerResponse.prototype.writeHead;

/**
 * Doors excused from the leak check, each for a reason that is the door's own: the log viewer serves the operator's
 * log, which is where the driver's text is SUPPOSED to go.
 */
const SERVES_THE_LOG = new Set(['GET /api/about/logs', 'GET /api/about/logs/stream']);

describe('a store failure answers alike on every door', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'storedown', spaces: [{ id: S, label: S, folders: [], meta: { suppressEmbeddings: true } }] });
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
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
      if (id) answered.add(id);
      return realWriteHead.apply(this, args);
    };
    Server.prototype.command = async function storeDown(...args) {
      if (!failing) return realCommand.apply(this, args);
      const id = log.currentRequestId() ?? '(none)';
      if (!answered.has(id)) failedByRequest.set(id, (failedByRequest.get(id) ?? 0) + 1);
      throw new PoolClearedError({
        address: HOST,
        serverError: new MongoNetworkTimeoutError(`connection <monitor> to ${ADDRESS}:27017 timed out`),
      });
    };
  });
  after(async () => {
    Server.prototype.command = realCommand;
    http.ServerResponse.prototype.writeHead = realWriteHead;
    failing = false;
    await new Promise(r => server?.close(r));
    await door?.close();
  });

  /** Every door: REST from the mounts (the tool door per tool), then MCP per tool. */
  function doors() {
    const out = [];
    for (const r of mountedRoutes()) {
      if (r.path.includes(':tool')) {
        for (const t of TOOLS) out.push({ kind: 'rest', name: `${r.method} ${r.path.replace(':tool', t)}`, method: r.method, url: r.path.replace(':tool', t), body: argsFor(schemaOf(t)) });
        continue;
      }
      out.push({ kind: 'rest', name: `${r.method} ${r.path}`, method: r.method, url: fill(r.path), body: BODY });
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
      const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
      const sc = out.result.structuredContent ?? {};
      return { requestId, status: out.result.isError ? (sc.storeSideFailure ? 503 : out.status) : 200, retryAfter: null,
        retryable: sc.retryable, error: text, raw: `${text}\n${JSON.stringify(sc)}` };
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
      retryable, error: typeof body?.error === 'string' ? body.error : null, raw };
  }

  it('every door that reached the failing store answers 503, Retry-After, retryable, one message, no driver text', { timeout: 30 * 60_000 }, async () => {
    const all = doors();
    const lines = [];
    const stop = log.subscribeLogLines(l => lines.push(l));
    const saved = { log: console.log, warn: console.warn, error: console.error };
    console.log = console.warn = console.error = () => {};
    const results = [];
    try {
      failing = true;
      for (const d of all) results.push({ d, a: await ask(d) });
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
      if (a.streaming) continue;
      const why = [];
      if (a.status !== 503) why.push(`status ${a.status}`);
      if (d.kind === 'rest' && !(Number(a.retryAfter) > 0)) why.push('no Retry-After');
      if (a.retryable !== true) why.push(`retryable ${a.retryable}`);
      if (typeof a.error !== 'string' || a.error.startsWith('Error:')) why.push(`error ${JSON.stringify(a.error)?.slice(0, 80)}`);
      else messages.set(a.error, [...(messages.get(a.error) ?? []), d.name]);
      // The operator's log: the driver's text once for this request, not once per layer that saw it.
      const logged = lines.filter(l => l.includes(a.requestId) && l.includes(`${ADDRESS}:27017 timed out`)).length;
      if (logged > 1) why.push(`driver text logged ${logged} times`);
      if (why.length) wrong.push(`${d.name}: ${why.join(', ')} — ${a.raw.slice(0, 160)}`);
    }
    if (messages.size > 1) {
      wrong.push(`one failure, ${messages.size} spellings: ${[...messages].map(([m, ds]) => `${JSON.stringify(m)} (${ds.length} doors, e.g. ${ds[0]})`).join(' | ')}`);
    }

    assert.ok(reached.length >= REACHED_FLOOR,
      `only ${reached.length} of ${all.length} doors reached the failing store — the fault or the probe bodies stopped `
      + 'working, and a short list concludes nothing');
    assert.deepEqual(wrong, [], `${wrong.length} door(s) of the ${reached.length} that reached the store (of ${all.length}) answer it differently:\n  ${wrong.join('\n  ')}`);
  });
});
