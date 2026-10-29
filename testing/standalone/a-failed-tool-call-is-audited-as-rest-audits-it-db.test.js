/**
 * A tool call that reaches a named audited operation leaves exactly one audit row, at the status it was answered, on
 * every door — a read's refusal and failure included (`Q-444`, bundle-98).
 *
 * ## The finding
 *
 * REST's rule is `audit/middleware.ts`: every response of a path that matches a `ROUTE_RULES` row is a row at its own
 * status, and the one filter is `audit.logReads`, which drops READ operations. The tool door (`callTool`, which both MCP
 * and `POST /api/<tool>` run) wrote its rows at four call sites, each with its own condition, so a REFUSED or FAILED
 * READ left no row on a tool door while the REST route of the same read did, and a write refused before its space
 * resolved (an unknown space, arguments that are not an object) left none either. An operator reading the trail saw a
 * refusal on one door and nothing on the other.
 *
 * ## What is held
 *
 *  - **The rule, for every audited tool** — the set is DERIVED from the registry (a tool whose `mcpActOperation ??
 *    mcpAuditOperation` is non-null), never listed, with floors: a refusal (the token holds nothing) and a server failure
 *    (the handler throws) each leave exactly ONE row under the tool's operation, at the status answered, naming the
 *    space the call named, with no `changes` — on MCP and on `POST /api/<tool>`.
 *  - **`logReads` is the only filter**, and one switch: off, every read tool leaves nothing at any status and every write
 *    tool and act still leaves its row.
 *  - **Refusals before the space resolves**: an unknown space (404) on a read and on a write, and arguments that are not an
 *    object, are rows (the unknown space's spelling is not written into the row).
 *  - **A thrown read not-found** (`similar` of an entry that does not exist, 404) is a row.
 *  - **The same fields as REST's row** for the same outcome: the real `auditMiddleware` mounted in Express over stubbed
 *    handlers, compared field by field with the tool's row.
 *  - **Exactly one row**: a success, and a stored record whose connections failed (`ConnectionsNotWritten`).
 *
 * ## Seen red
 *
 * On 5fd65a290 every read case above leaves no row, a write refused at visibility has `spaceId: null`, and the
 * pre-resolution refusals leave none. After the fix, removing the `finally` record in `auditedToolCall` by hand turns every
 * case red.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failed-tool-call-is-audited-as-rest-audits-it-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import http from 'node:http';
import express from 'express';
import { elapse } from '../_shared/sleep.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';

const skip = await mongoSkipReason();

const SPACE = 'failedtoolaudit';
const NONE = { instanceAdmin: false, createSpaces: false, perSpace: {}, floor: {} };
const TRANSPORTS = ['mcp', 'rest'];
const sleep = (ms) => elapse(ms, 'sampler interval: the audit row count is read at a fixed rate until it holds still');

let door, loader, TOOLS_BY_NAME, audit, auditMiddleware, toolSchemasFor, materialisedSchema, ConnectionsNotWritten, writtenRecord;

const auditColl = () => door.mongo.getDb().collection('audit_log');

/**
 * Every row, once the writer (fire-and-forget: the row arrives after the answer) has stopped adding: the count is read
 * until it holds still for three reads in a row.
 */
async function settledRows() {
  let last = -1, still = 0;
  for (let i = 0; i < 200 && still < 3; i++) {
    const n = await auditColl().countDocuments({});
    still = n === last ? still + 1 : 0;
    last = n;
    await sleep(120);
  }
  const rows = await auditColl().find({}).toArray();
  const byToken = new Map();
  for (const r of rows) byToken.set(r.tokenId, [...(byToken.get(r.tokenId) ?? []), r]);
  return byToken;
}

/** The tools that name an audited operation, derived: the registry's, with what each is. */
function derivedTools() {
  return [...TOOLS_BY_NAME.keys()].filter(t => audit.mcpActOperation(t) ?? audit.mcpAuditOperation(t)).map(t => {
    const act = audit.mcpActOperation(t) !== null;
    const read = !act && audit.isMcpReadOperation(audit.mcpAuditOperation(t));
    return { tool: t, act, read, write: !act && !read };
  });
}

/** The operation a call to `tool` with `args` is recorded under. */
const operationOf = (tool, args) => audit.mcpActOperation(tool) ?? audit.mcpAuditOperation(tool, args);

/** One value for a JSON-schema node: its first enum value, else one of its type, else the first alternative. */
function valueFor(node) {
  if (!node || typeof node !== 'object') return 'x';
  if (Array.isArray(node.enum) && node.enum.length) return node.enum[0];
  if (node.const !== undefined) return node.const;
  for (const alt of ['oneOf', 'anyOf']) if (Array.isArray(node[alt]) && node[alt].length) return valueFor(node[alt][0]);
  const type = Array.isArray(node.type) ? node.type[0] : node.type;
  switch (type) {
    case 'number': case 'integer': return Math.max(1, node.minimum ?? 1);
    case 'boolean': return true;
    case 'array': return [];
    case 'object': return {};
    default: return 'x';
  }
}

/** Arguments for `tool` built from its own input schema: every required property, and `space` whenever it takes one. */
function argsFor(tool) {
  const schema = materialisedSchema(TOOLS_BY_NAME.get(tool), toolSchemasFor([SPACE]), [SPACE]);
  const props = schema.properties ?? {};
  const args = {};
  for (const key of schema.required ?? []) args[key] = valueFor(props[key]);
  if ('space' in props) args.space = SPACE;
  return args;
}

/** Run `fn` with `tool`'s handler replaced by one that throws a fault of ours, and put the real one back. */
async function withFaultingHandler(tool, fn) {
  const t = TOOLS_BY_NAME.get(tool);
  const original = t.handle;
  t.handle = async () => { throw new TypeError('q444: handler fault'); };
  try { return await fn(); } finally { t.handle = original; }
}

/** One refused call per derived tool and transport: the token holds nothing, the call names the space. */
async function refusedCalls() {
  const out = [];
  for (const spec of derivedTools()) {
    for (const transport of TRANSPORTS) {
      const args = { space: SPACE };
      out.push({ ...spec, transport, args, answered: await door.call(spec.tool, args, { rights: NONE, transport }) });
    }
  }
  return out;
}

/** One faulted call per derived tool and transport: an administrator, arguments from the tool's schema, a handler that throws. */
async function faultedCalls() {
  const out = [];
  for (const spec of derivedTools()) {
    for (const transport of TRANSPORTS) {
      const args = argsFor(spec.tool);
      out.push({ ...spec, transport, args, answered: await withFaultingHandler(spec.tool, () => door.call(spec.tool, args, { transport })) });
    }
  }
  return out;
}

/** The rule on a batch of calls: what each left, given whether reads are logged. */
function assertRowsOfCalls(calls, byToken, { logReads, kind }) {
  for (const c of calls) {
    const rows = byToken.get(c.answered.tokenId) ?? [];
    const label = `${c.tool} over ${c.transport} (${kind}, answered ${c.answered.status})`;
    if (c.read && !logReads) {
      assert.equal(rows.length, 0, `${label}: a read left a row with logReads off: ${JSON.stringify(rows.map(r => [r.operation, r.status]))}`);
      continue;
    }
    assert.equal(rows.length, 1, `${label}: left ${rows.length} audit rows, expected exactly one: ${JSON.stringify(rows.map(r => [r.operation, r.status]))}`);
    const [row] = rows;
    assert.equal(row.operation, operationOf(c.tool, c.args), `${label}: the row is under ${row.operation}`);
    assert.equal(row.status, c.answered.status, `${label}: the row says ${row.status}`);
    assert.equal(row.path, c.transport === 'mcp' ? `http:${c.tool}` : `/api/${c.tool}`, `${label}: the path names the door and the tool`);
    assert.ok(!('changes' in row), `${label}: a refused or failed call recorded a change list`);
    if (kind === 'refused') assert.equal(row.spaceId, SPACE, `${label}: the row does not name the space the call named`);
  }
}

describe('a failed tool call is audited as REST audits its twin', { skip }, () => {
  before(async () => {
    door = await openToolDoor({ suite: 'failedtoolaudit', spaces: [{ id: SPACE, label: SPACE, folders: [] }] });
    loader = await import('../../server/dist/config/loader.js');
    ({ TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js'));
    audit = await import('../../server/dist/mcp/audit-map.js');
    ({ auditMiddleware } = await import('../../server/dist/audit/middleware.js'));
    ({ toolSchemasFor, materialisedSchema } = await import('../../server/dist/mcp/tool-schema.js'));
    ({ ConnectionsNotWritten, writtenRecord } = await import('../../server/dist/brain/connections-not-written.js'));
  });
  after(async () => { await door?.close(); });
  const logReads = (on) => loader.mutateConfig(c => { c.audit = { ...(c.audit ?? {}), logReads: on }; });
  beforeEach(async () => { await auditColl().deleteMany({}); logReads(true); });

  it('the audited tools are derived from the registry, with floors', () => {
    const tools = derivedTools();
    assert.ok(tools.length >= 60, `only ${tools.length} audited tools derived`);
    assert.ok(tools.filter(t => t.read).length >= 10, 'fewer than ten audited reads derived');
    assert.ok(tools.filter(t => t.write).length >= 30, 'fewer than thirty audited writes derived');
  });

  it('(a) a refusal of every audited tool, on both doors, is one row at the status answered, naming its space', async () => {
    const calls = await refusedCalls();
    assertRowsOfCalls(calls, await settledRows(), { logReads: true, kind: 'refused' });
  });

  it('(b) a server failure of every audited tool, on both doors, is one row at the status answered', async () => {
    const calls = await faultedCalls();
    const reached = calls.filter(c => c.answered.status === 500);
    assert.ok(reached.filter(c => c.read).length >= 8, 'fewer than eight reads reached the handler and failed');
    assert.ok(reached.filter(c => c.write).length >= 25, 'fewer than twenty-five writes reached the handler and failed');
    assertRowsOfCalls(calls, await settledRows(), { logReads: true, kind: 'faulted' });
  });

  it('(f) logReads is the one filter: off, no read leaves a row at any status and every write and act still does', async () => {
    logReads(false);
    const refused = await refusedCalls();
    const faulted = await faultedCalls();
    const byToken = await settledRows();
    assertRowsOfCalls(refused, byToken, { logReads: false, kind: 'refused' });
    assertRowsOfCalls(faulted, byToken, { logReads: false, kind: 'faulted' });
  });

  describe('(c) a refusal before the space resolves is a row, and an unknown space is not written into it', () => {
    for (const [tool, args, status] of [
      ['update_entity', { space: 'no-such-space', id: 'x', name: 'y' }, 404],
      ['filter', { space: 'no-such-space', collection: 'entities' }, 404],
      ['save_entity', 'not an object', 400],
    ]) {
      for (const transport of TRANSPORTS) {
        it(`${tool} ${typeof args === 'string' ? 'with arguments that are not an object' : 'naming an unknown space'} over ${transport}`, async () => {
          const out = await door.call(tool, args, { transport });
          assert.equal(out.status, status, out.text);
          const rows = (await settledRows()).get(out.tokenId) ?? [];
          assert.equal(rows.length, 1, `left ${rows.length} rows`);
          assert.equal(rows[0].operation, operationOf(tool, args));
          assert.equal(rows[0].status, status);
          assert.equal(rows[0].spaceId, null, 'the caller\'s spelling of a space that does not exist was written to the trail');
          assert.ok(!('changes' in rows[0]));
        });
      }
    }
  });

  describe('(d) a read the handler throws not-found for is a row', () => {
    for (const transport of TRANSPORTS) {
      it(`similar of an entry that does not exist over ${transport}`, async () => {
        const args = { space: SPACE, entryId: randomUUID(), entryType: 'entity' };
        const out = await door.call('similar', args, { transport });
        assert.equal(out.status, 404, out.text);
        const rows = (await settledRows()).get(out.tokenId) ?? [];
        assert.equal(rows.length, 1, `left ${rows.length} rows`);
        assert.deepEqual([rows[0].operation, rows[0].status, rows[0].spaceId], ['brain.similar', 404, SPACE]);
      });
    }
  });

  describe('(e) the tool row carries the fields the REST row of the same outcome carries', () => {
    let server, port, restRowToken;
    before(async () => {
      const app = express();
      let n = 0;
      app.use((req, _res, next) => { req.authToken = { id: `failedtoolaudit-rest-${++n}`, name: 'rest', rights: NONE }; restRowToken = req.authToken.id; next(); });
      app.use(auditMiddleware);
      const answer = (req, res) => { const s = Number(req.query.s); if (s === 500) throw new TypeError('q444: handler fault'); res.status(s).json({ error: 'stub' }); };
      app.post('/api/brain/filter', answer);
      app.patch('/api/brain/:space/entities/:id', answer);
      server = await listenOnLoopback(http.createServer(app));
      port = server.port;
    });
    after(async () => { await server?.close(); });

    /** The REST row of `method path` answered `status`, by the real middleware. */
    async function restRow(method, path, status) {
      await fetch(`http://127.0.0.1:${port}${path}?s=${status}`, { method, headers: { 'content-type': 'application/json' }, body: '{}' });
      const rows = (await settledRows()).get(restRowToken) ?? [];
      assert.equal(rows.length, 1, `the REST ${method} ${path} left ${rows.length} rows at ${status}`);
      return rows[0];
    }
    const shape = (row, withSpace) => ({
      operation: row.operation, status: row.status, entryId: row.entryId ?? null, hasChanges: 'changes' in row,
      ...(withSpace ? { spaceId: row.spaceId ?? null } : {}),
    });

    const existing = randomUUID();
    // `filter` names its space in the BODY, so the REST row of a refusal (the guard fails before it authorises any) has no space to
    // compare; `update_entity`'s path names it, and its rows are compared whole.
    const CASES = [
      { tool: 'filter', status: 403, withSpace: false, restPath: '/api/brain/filter', method: 'POST', args: { space: SPACE, collection: 'entities' }, rights: NONE },
      { tool: 'filter', status: 404, withSpace: false, restPath: '/api/brain/filter', method: 'POST', args: { space: 'no-such-space', collection: 'entities' } },
      { tool: 'filter', status: 500, withSpace: false, restPath: '/api/brain/filter', method: 'POST', args: { space: SPACE, collection: 'entities' }, fault: true },
      { tool: 'update_entity', status: 403, withSpace: true, restPath: `/api/brain/${SPACE}/entities/${existing}`, method: 'PATCH', args: { space: SPACE, id: existing, name: 'x' }, rights: NONE },
      { tool: 'update_entity', status: 404, withSpace: true, restPath: `/api/brain/${SPACE}/entities/${existing}`, method: 'PATCH', args: { space: SPACE, id: existing, name: 'x' } },
      { tool: 'update_entity', status: 500, withSpace: true, restPath: `/api/brain/${SPACE}/entities/${existing}`, method: 'PATCH', args: { space: SPACE, id: existing, name: 'x' }, fault: true },
    ];
    for (const c of CASES) {
      for (const transport of TRANSPORTS) {
        it(`${c.tool} answered ${c.status} over ${transport}`, async () => {
          const rest = await restRow(c.method, c.restPath, c.status);
          await auditColl().deleteMany({});
          const run = () => door.call(c.tool, c.args, { transport, ...(c.rights ? { rights: c.rights } : {}) });
          const out = c.fault ? await withFaultingHandler(c.tool, run) : await run();
          assert.equal(out.status, c.status, out.text);
          const rows = (await settledRows()).get(out.tokenId) ?? [];
          assert.equal(rows.length, 1, `the tool left ${rows.length} rows at ${c.status}`);
          assert.deepEqual(shape(rows[0], c.withSpace), shape(rest, c.withSpace), 'the tool row and the REST row differ');
        });
      }
    }
  });

  describe('(h) a REST route that dispatches a tool and is audited by its own route rule leaves one row, not two', () => {
    // `POST /api/brain/recall`, `/similar` and `/:space/traverse` run their tool through `callTool` with `restToolCaller`, and
    // `ROUTE_RULES` audits the same paths: each call wrote the route's row AND the tool's. The one row is the TOOL's, under the
    // route's path: it knows the space the body named (the route rule of `/api/brain/similar` has no space to read), and a
    // version that kept the route's row instead left recall's row with no space at all (lens review of dea393b60).
    let server, port, restToolCaller, callTool, n = 0;
    before(async () => {
      ({ restToolCaller } = await import('../../server/dist/api/rest-tool-caller.js'));
      ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
      const app = express();
      app.use(express.json());
      app.use((req, _res, next) => { req.authToken = { id: `failedtoolaudit-classic-${++n}`, name: 'classic', rights: door.ADMIN }; next(); });
      app.use(auditMiddleware);
      app.post('/api/brain/similar', async (req, res) => {
        const out = await callTool({ name: 'similar', args: req.body ?? {}, caller: restToolCaller(req) });
        res.status(out.status).json({ text: out.result.content.map(c => c.text).join('\n') });
      });
      server = await listenOnLoopback(http.createServer(app));
      port = server.port;
    });
    after(async () => { await server?.close(); });

    for (const [label, body, status] of [
      ['answered 404', { space: SPACE, entryId: randomUUID(), entryType: 'entity' }, 404],
      ['refused 400', { space: SPACE }, 400],
    ]) {
      it(`POST /api/brain/similar ${label}`, async () => {
        const r = await fetch(`http://127.0.0.1:${port}/api/brain/similar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        assert.equal(r.status, status, await r.text());
        const rows = (await settledRows()).get(`failedtoolaudit-classic-${n}`) ?? [];
        assert.equal(rows.length, 1, `one call left ${rows.length} rows: ${JSON.stringify(rows.map(x => [x.path, x.operation, x.status]))}`);
        assert.deepEqual([rows[0].path, rows[0].operation, rows[0].status, rows[0].spaceId], ['/api/brain/similar', 'brain.similar', status, SPACE],
          'the one row is the tool\'s, under the route\'s own path and naming the space the body named');
      });
    }

    it('a request refused before it reaches the tool is still the route rule\'s row', async () => {
      // No `space`-less refusal reaches here: a token with no rights is refused by `callTool` itself. What stays the middleware's is
      // a request the tool never saw, so the handler here answers without calling it.
      const app = express();
      app.use((req, _res, next) => { req.authToken = { id: `failedtoolaudit-classic-${++n}`, name: 'classic', rights: door.ADMIN }; next(); });
      app.use(auditMiddleware);
      app.post('/api/brain/similar', (_req, res) => { res.status(429).json({ error: 'rate limited' }); });
      const s = await listenOnLoopback(http.createServer(app));
      try {
        const r = await fetch(`http://127.0.0.1:${s.port}/api/brain/similar`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
        assert.equal(r.status, 429);
        const rows = (await settledRows()).get(`failedtoolaudit-classic-${n}`) ?? [];
        assert.deepEqual(rows.map(x => [x.path, x.operation, x.status]), [['/api/brain/similar', 'brain.similar', 429]]);
      } finally { await s.close(); }
    });
  });

  it('an id the call never resolved is not copied into the row past its bound', async () => {
    const out = await door.call('update_entity', { space: 'no-such-space', id: 'x'.repeat(100_000), name: 'n' });
    assert.equal(out.status, 404, out.text);
    const rows = (await settledRows()).get(out.tokenId) ?? [];
    assert.equal(rows.length, 1);
    assert.equal(rows[0].entryId ?? null, null, `a ${rows[0].entryId?.length}-character caller text was written as the row's entryId`);
  });

  describe('(g) exactly one row', () => {
    for (const transport of TRANSPORTS) {
      it(`a success over ${transport} is one row, with its change list`, async () => {
        const id = randomUUID();
        await door.coll(SPACE, 'entities').insertOne({ _id: id, spaceId: SPACE, name: 'E', type: 'thing', tags: [], properties: {},
          author: { instanceId: 'x', instanceLabel: 'x' }, createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: 1 });
        const out = await door.call('update_entity', { space: SPACE, id, name: 'renamed' }, { transport });
        assert.equal(out.status, 200, out.text);
        const rows = (await settledRows()).get(out.tokenId) ?? [];
        assert.equal(rows.length, 1, `left ${rows.length} rows`);
        assert.deepEqual([rows[0].operation, rows[0].status, rows[0].entryId, 'changes' in rows[0]], ['entity.update', 200, id, true]);
      });

      it(`a stored record whose connections failed over ${transport} is one row naming the record it stored`, async () => {
        const written = randomUUID();
        const t = TOOLS_BY_NAME.get('save_entity');
        const original = t.handle;
        t.handle = async () => { throw new ConnectionsNotWritten(writtenRecord('entity', written, []), new Error('q444: edge failed')); };
        let out;
        try { out = await door.call('save_entity', { space: SPACE, name: 'N', type: 'thing' }, { transport }); } finally { t.handle = original; }
        const rows = (await settledRows()).get(out.tokenId) ?? [];
        assert.equal(rows.length, 1, `left ${rows.length} rows: ${JSON.stringify(rows.map(r => [r.operation, r.status]))}`);
        assert.deepEqual([rows[0].operation, rows[0].status, rows[0].entryId, rows[0].spaceId], ['entity.create', out.status, written, SPACE]);
      });
    }
  });
});
