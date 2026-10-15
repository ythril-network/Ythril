/**
 * An unknown top-level field on a brain write is answered ALIKE on every door that takes the write — REST, MCP
 * `callTool` and `POST /api/<tool>` — by one rule: this instance's `unknownWriteFields` setting for the space the write
 * lands in decides (bundle-128, Q-320 with Q-494/495/496; design-v3 section 8.1, cases (a)-(n) and (p); case (o), the
 * setting's own write and read paths, is `b128-contract`'s).
 *
 * ## The rule, in the words the cases below hold it to
 *
 * - **`warn`** (the default; an ABSENT setting means warn): the record is stored and each unknown field is named in
 *   `warnings` as `{ field, code: 'unknown_field', reason, value }`, reason `unknown field — ignored`.
 * - **`refuse`** (`'refuse'` on the space): the write is refused before anything is stored — a 400 whose body is
 *   `{ error, issues: [{ code: 'unrecognized_keys', path: [], keys }], warnings: rows }`, rows `unknown field — not
 *   accepted` and WITHOUT `value` (a refusal reflects no received value).
 * - In both modes a retired name is refused by name, and EVERY answer of a judged call names the unknown fields once
 *   the target space is resolved — a refusal for another reason included, a stored record whose connections failed
 *   included — except a plain store failure where nothing was stored.
 * - The accepted list appears ONCE per answer, in the first unknown row; a key near an accepted one carries a
 *   `did you mean` suffix; at most 10 names are rowed, then `…(+N more)`; unknown rows come first and sit outside the
 *   20-row schema cut.
 *
 * ## What it was written against
 *
 * Base `ec160701`: REST single-record writes warn with a row that has no `code`, the MCP tools REFUSE every unknown
 * argument from the dispatcher's closed schema in every mode, bulk items and a file-metadata PATCH name nothing, and the
 * setting does not exist. Each case below is red for the planned reason there and is meant to go green only when BOTH
 * doors answer through the one judge.
 *
 * ## The subjects are derived, never listed
 *
 * Every non-GET route registered in the brain write routers, read from the routers' own stacks, each paired to a tool
 * through `ROUTE_RULES` (the audit rule the route is recorded under) and `MCP_TOOL_OPERATIONS` (the tool recorded under the
 * same operation). The `ROUTE_RULES` row for `POST /chrono/:id` has no route behind it and is therefore not a subject. A
 * route whose operation this file has no request for FAILS the derivation instead of dropping out of it, and the accepted
 * set each case compares against is read from the paired tool's own `inputSchema`, never typed here.
 *
 * ## Three doors, sandwiched
 *
 * REST is the real Express app over loopback; MCP is `callTool`; the third door is `POST /api/<tool>`, whose `data` is the
 * MCP structured answer. Each door writes its own freshly seeded record, and the record collections are read BEFORE the
 * first call, between the calls and AFTER the last (A, B, A): a refusal must leave the same documents behind every time, so
 * a comparison is of a stable value and not of two different moments.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-unknown-field-is-answered-alike-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { holdsWithin } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
// A limiter answers 429 to a caller past its quota before the write is reached; it is not what these cases ask about.
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

// The one space that embeds (case (p)) reaches a stub endpoint, so no model is fetched. Set before any server module loads.
const DIMS = 8;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
const stubEmbedder = http.createServer((req, res) => {
  let body = '';
  req.on('data', c => { body += c; });
  req.on('end', () => {
    let input = '';
    try { input = JSON.parse(body).input; } catch { /* the stub answers whatever it is asked */ }
    const text = Array.isArray(input) ? input.join(' ') : String(input);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ data: [{ embedding: Array.from({ length: DIMS }, (_, i) => ((text.length + i) % 10) / 10 + 0.05) }] }));
  });
});
const stub = skip ? null : await listenOnLoopback(stubEmbedder);
if (stub) process.env['EMBEDDING_URL'] = stub.url;

/** The unknown top-level key every case sends. Far from every accepted key, so no near-miss hint is earned by it. */
const UNKNOWN = 'unrecognisedThing';
const UNKNOWN_VALUE = 7;
const S = 'pspace';
const SCHEMA_SPACE = 'pschema';
const EMBED_SPACE = 'pembed';
const PROXY = 'pproxy';
const IGNORED = 'unknown field — ignored';
const NOT_ACCEPTED = 'unknown field — not accepted';
const RECORD_COLLECTIONS = ['entities', 'facts', 'edges', 'chrono', 'links', 'files'];
const WIDE = Array.from({ length: 21 }, (_, i) => `p${String(i).padStart(2, '0')}`);

/** The routers whose non-GET routes are the subjects: file, export. Their ROUTES are read from the stacks. */
const BRAIN_WRITE_ROUTERS = [
  ['entities', 'entitiesRouter'], ['facts', 'memoriesRouter'], ['edges', 'edgesRouter'], ['chrono', 'chronoRouter'],
  ['links', 'linksRouter'], ['file-meta', 'fileMetaRouter'], ['bulk', 'bulkRouter'],
];
/** An operation whose route takes no record body, so no unknown field can ride on it. A reason per verb, never a bare skip. */
const TAKES_NO_RECORD_BODY = new Map([
  ['delete', 'a delete names its target by path and takes no body of fields'],
  ['retry_embedding_all', 'a retry-all takes no record fields'],
]);
/** Subjects the generic cases leave to a case of their own, each for a reason of its own. */
const OWN_CASE = new Map([
  ['bulk.write', 'a batch judges its ITEMS and refuses its top level in every mode — case (n)'],
]);
/** Subjects case (g) cannot ask, each with the reason. */
const NO_PROXY_CASE = new Map([
  ['entity.merge', 'REST refuses a proxy space before any target is read and MCP takes targetSpace: the divergence is Q-499, outside this bundle'],
]);

const requireFromServer = createRequire(path.resolve('server/package.json'));
const driverLib = path.dirname(requireFromServer.resolve('mongodb'));
const { Server } = requireFromServer(path.join(driverLib, 'sdam', 'server.js'));
const { PoolClearedError } = requireFromServer(path.join(driverLib, 'cmap', 'errors.js'));
const { MongoNetworkTimeoutError } = requireFromServer('mongodb');

let door, app, base, adminKey, callTool, ADMIN, getConfig, TOOLS_BY_NAME, toolSchemas, RETIRED, NAME_QUOTED, REFUSAL_NAMES_MAX;
let SUBJECTS = [];
let counter = 0;
const uniq = (label) => `${label} ${process.pid}-${++counter}`;
const fmt = (x) => JSON.stringify(x)?.slice(0, 240);
/**
 * A structured answer as the doors are compared: the REST app adds `retryable` to every error body (`statesRetryability`),
 * which the MCP structured answer does not carry. It says nothing about the unknown field, so it is not compared.
 */
const comparable = (data) => (data && typeof data === 'object' && !Array.isArray(data)
  ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'retryable')) : data);

// ── doors ────────────────────────────────────────────────────────────────────────────────────────────────────────────

async function http_(method, url, body) {
  const init = { method, headers: { Authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(60_000) };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(`${base}${url}`, init);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}

async function mcpCall(name, args) {
  const out = await callTool({ name, args, caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  return { status: out.status, isError: out.result.isError === true, text: (out.result.content ?? []).map(c => c.text ?? '').join('\n'), sc: out.result.structuredContent };
}

/** One answer, normalised: the same four things whichever door gave it. `data` is the structured body (the tool door's `data`). */
async function ask(which, req) {
  if (which === 'rest') {
    const r = await http_(req.rest.method, req.rest.url, req.rest.body);
    return { door: which, status: r.status, refused: r.status >= 400, data: r.body, error: typeof r.body?.error === 'string' ? r.body.error : '', text: r.text };
  }
  if (which === 'mcp') {
    const o = await mcpCall(req.tool.name, req.tool.args);
    return { door: which, status: o.status, refused: o.isError || o.status >= 400, data: o.sc ?? null, error: o.text, text: o.text };
  }
  const r = await http_('POST', `/api/${req.tool.name}`, req.tool.args);
  return { door: which, status: r.status, refused: r.status >= 400, data: r.body?.data ?? null, error: typeof r.body?.error === 'string' ? r.body.error : '', text: r.text, envelope: r.body };
}
const DOORS = ['rest', 'mcp', 'tool'];

/** The rows of an answer that are about unknown fields (by their code, or — on the base, which has none — by their wording). */
const unknownRows = (data) => (Array.isArray(data?.warnings) ? data.warnings : [])
  .filter(r => r && (r.code === 'unknown_field' || (typeof r.reason === 'string' && r.reason.startsWith('unknown field'))));

// ── what is stored ───────────────────────────────────────────────────────────────────────────────────────────────────

/** Every record of every record collection of the space, whole, in `_id` order: "nothing was stored" is an identity check. */
async function snapshot(space = S) {
  const out = {};
  for (const c of RECORD_COLLECTIONS) out[c] = await door.mongo.col(`${space}_${c}`).find({}).sort({ _id: 1 }).toArray();
  return JSON.stringify(out);
}

function setMode(space, mode) {
  const sp = getConfig().spaces.find(s => s.id === space);
  assert.ok(sp, `space ${space} is not in the config`);
  if (mode === 'refuse') sp.unknownWriteFields = 'refuse'; else delete sp.unknownWriteFields;
}

// ── seeds: records the doors under test write to, made through the app with nothing unknown in them ───────────────────

async function seed(kind) {
  const base_ = `/api/brain/spaces/${S}`;
  const must = (r, what) => { assert.ok(r.status < 300, `seeding ${what} answered ${r.status}: ${r.text}`); return r.body; };
  if (kind === 'entity') return must(await http_('POST', `${base_}/entities`, { name: uniq('seed entity'), type: 'thing' }), 'an entity')._id;
  if (kind === 'fact') return must(await http_('POST', `${base_}/facts`, { fact: uniq('seed fact') }), 'a fact')._id;
  if (kind === 'chrono') return must(await http_('POST', `${base_}/chrono`, { title: uniq('seed chrono'), type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }), 'a chrono entry')._id;
  if (kind === 'edge') {
    const from = await seed('entity'); const to = await seed('entity');
    return must(await http_('POST', `${base_}/edges`, { from, to, label: 'seeded' }), 'an edge')._id;
  }
  if (kind === 'file') {
    const p = `${uniq('seed').replace(/\s+/g, '-')}.txt`;
    const dir = path.join(process.env['DATA_ROOT'], 'files', S);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, p), 'seeded');
    await door.mongo.col(`${S}_files`).insertOne({ _id: p, spaceId: S, path: p, sizeBytes: 6, tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
    return p;
  }
  throw new Error(`no seed for ${kind}`);
}

// ── fixtures: ONE valid request per operation, as data, so a door-specific builder cannot drift per door ───────────────

/**
 * What each judged operation sends. `route(space, addr)` is the REST path, `query` its non-body parameters, `addr` the
 * ADDRESSING arguments the tool names beside the body (a path segment on REST), `payload` a VALID body, and `empty` what a
 * create must carry to be well-formed at all (so dropping it makes the write refusable for another reason).
 */
const FIXTURES = {
  'entity.create': async () => ({ tool: 'save_entity', method: 'POST', route: sp => `/api/brain/spaces/${sp}/entities`, addr: {}, query: {}, payload: { name: uniq('entity'), type: 'thing' }, embeds: true, missing: 'create' }),
  'entity.update': async () => { const id = await seed('entity'); return { tool: 'update_entity', method: 'PATCH', route: (sp, a) => `/api/brain/spaces/${sp}/entities/${a.id}`, addr: { id }, query: {}, payload: { description: 'changed' }, missing: 'update' }; },
  'entity.merge': async () => { const survivorId = await seed('entity'); const absorbedId = await seed('entity'); return { tool: 'graph_merge', method: 'POST', route: (sp, a) => `/api/brain/spaces/${sp}/entities/${a.survivorId}/merge/${a.absorbedId}`, addr: { survivorId, absorbedId }, query: {}, payload: {}, missing: null }; },
  'fact.create': async () => ({ tool: 'save_fact', method: 'POST', route: sp => `/api/brain/spaces/${sp}/facts`, addr: {}, query: {}, payload: { fact: uniq('fact') }, embeds: true, missing: 'create' }),
  'fact.update': async () => { const id = await seed('fact'); return { tool: 'update_fact', method: 'PATCH', route: (sp, a) => `/api/brain/spaces/${sp}/facts/${a.id}`, addr: { id }, query: {}, payload: { description: 'changed' }, missing: 'update' }; },
  'edge.create': async () => { const from = await seed('entity'); const to = await seed('entity'); return { tool: 'save_edge', method: 'POST', route: sp => `/api/brain/spaces/${sp}/edges`, addr: {}, query: {}, payload: { from, to, label: uniq('rel').replace(/\s+/g, '-') }, embeds: true, missing: 'create' }; },
  'edge.update': async () => { const id = await seed('edge'); return { tool: 'update_edge', method: 'PATCH', route: (sp, a) => `/api/brain/spaces/${sp}/edges/${a.id}`, addr: { id }, query: {}, payload: { description: 'changed' }, missing: 'update' }; },
  'chrono.create': async () => ({ tool: 'save_chrono', method: 'POST', route: sp => `/api/brain/spaces/${sp}/chrono`, addr: {}, query: {}, payload: { title: uniq('chrono'), type: 'event', startsAt: '2026-01-01T00:00:00.000Z' }, embeds: true, missing: 'create' }),
  'chrono.update': async () => { const id = await seed('chrono'); return { tool: 'update_chrono', method: 'PATCH', route: (sp, a) => `/api/brain/spaces/${sp}/chrono/${a.id}`, addr: { id }, query: {}, payload: { description: 'changed' }, missing: 'update' }; },
  'link.create': async () => { const from = await seed('fact'); const to = await seed('entity'); return { tool: 'save_link', method: 'POST', route: sp => `/api/brain/spaces/${sp}/links`, addr: {}, query: {}, payload: { from, fromKind: 'fact', to, toKind: 'entity' }, missing: 'create' }; },
  'file.meta.update': async () => { const p = await seed('file'); return { tool: 'update_file_meta', method: 'PATCH', route: sp => `/api/brain/spaces/${sp}/files`, addr: { path: p }, query: { path: p }, payload: { description: 'changed' }, missing: 'update' }; },
};

/**
 * The request a fixture makes on each door. `extra` rides on the BODY (and as tool arguments); `payload` replaces the valid
 * body; `addr` overrides an addressing value; `targetRest` / `targetMcp` are the door's own spelling of `targetSpace`.
 */
function requestOf(fx, { space = S, extra = {}, payload = fx.payload, addr = {}, targetRest, targetMcp } = {}) {
  const a = { ...fx.addr, ...addr };
  const body = { ...payload, ...extra };
  const qs = new URLSearchParams();
  for (const [k, v] of Object.entries(fx.query)) qs.set(k, k in addr ? addr[k] : v);
  for (const t of [].concat(targetRest ?? [])) qs.append('targetSpace', t);
  const url = fx.route(space, a) + (qs.size ? `?${qs}` : '');
  const args = { space, ...a, ...body, ...(targetMcp !== undefined ? { targetSpace: targetMcp } : {}) };
  return { rest: { method: fx.method, url, body: JSON.stringify(body) }, tool: { name: fx.tool, args } };
}

/**
 * The accepted set of a subject: what its paired tool declares minus addressing. This is the design's own definition of the
 * accepted keys (section 2.1), read here from the schema the tool publishes.
 */
function acceptedOf(fx) {
  const schema = TOOLS_BY_NAME.get(fx.tool).inputSchema(toolSchemas);
  const addressing = new Set(['space', 'targetSpace', ...Object.keys(fx.addr)]);
  return Object.keys(schema.properties).filter(k => !addressing.has(k));
}

/** Three fresh fixtures, then the three doors in turn with the stored documents read before, between and after (A, B, A, ...). */
async function threeDoors(subject, opts = {}) {
  const fxs = [await FIXTURES[subject.op](), await FIXTURES[subject.op](), await FIXTURES[subject.op]()];
  const snaps = [await snapshot()];
  const answers = {};
  for (const [i, which] of DOORS.entries()) {
    answers[which] = await ask(which, requestOf(fxs[i], typeof opts === 'function' ? opts(fxs[i]) : opts));
    snaps.push(await snapshot());
  }
  return { fxs, answers, snaps };
}

/** Every problem with how a set of rows reads, as strings. `outcome` is 'stored' or 'refused'. */
function rowProblems(rows, { outcome, names }) {
  const bad = [];
  const want = outcome === 'stored' ? IGNORED : NOT_ACCEPTED;
  if (rows.length !== names.length) bad.push(`${rows.length} unknown row(s) for ${names.length} unknown name(s): ${fmt(rows)}`);
  for (const r of rows) {
    if (r.code !== 'unknown_field') bad.push(`row for ${fmt(r.field)} has no code 'unknown_field': ${fmt(r)}`);
    if (typeof r.reason !== 'string' || !r.reason.startsWith(want)) bad.push(`row for ${fmt(r.field)}: reason ${fmt(r.reason)} does not start with ${fmt(want)}`);
    if (outcome === 'refused' && 'value' in r) bad.push(`a refused answer reflects a received value: ${fmt(r)}`);
  }
  return bad;
}

/**
 * The subject set is what every case below ranges over, so its floors are asserted EVERY time it is read (`judged()`): a derivation
 * that reads nothing would otherwise leave each case passing over an empty set. Every non-GET route of the brain write routers is
 * paired to an operation and a tool, the `ROUTE_RULES` row with no route behind it (`POST /chrono/:id`) is not a subject, and every
 * judged route has a request in FIXTURES.
 */
function assertSubjectSet() {
  assert.ok(SUBJECTS.length >= 13, `only ${SUBJECTS.length} non-GET brain write route(s) were found — the derivation reads nothing, so every case below would pass over an empty set`);
  const unpaired = SUBJECTS.filter(s => !s.op || s.tools.length === 0).map(s => `${s.method} ${s.routePath}`);
  assert.deepEqual(unpaired, [], 'these registered routes are paired to no operation in ROUTE_RULES or to no tool in MCP_TOOL_OPERATIONS, so a tool-side answer for them is a door nobody judges');
  assert.ok(!SUBJECTS.some(s => s.method === 'POST' && s.routePath === '/spaces/:spaceId/chrono/:id'),
    'the ROUTE_RULES row for POST /chrono/:id has no route behind it and must not be a subject');
  const single = SUBJECTS.filter(s => !OWN_CASE.has(s.op) && !s.takesNoBody);
  const noRequest = single.filter(s => !FIXTURES[s.op]).map(s => `${s.method} ${s.routePath} (${s.op})`);
  assert.deepEqual(noRequest, [], 'a registered write route has no request in FIXTURES, so the cases would skip it silently — add one, or give its verb a reason in TAKES_NO_RECORD_BODY');
  assert.ok(single.length >= 11, `only ${single.length} single-record subject(s) — expected at least the create, update, merge, link and file-meta routes`);
  for (const s of SUBJECTS.filter(x => !x.takesNoBody)) assert.ok(TOOLS_BY_NAME.has(s.tool), `${s.op} pairs to ${s.tool}, which is not a registered tool`);
  return single;
}
const judged = () => assertSubjectSet();
const withKey = (...pairs) => Object.fromEntries(pairs);

describe('an unknown field on a brain write is answered alike on both doors (b128 parity)', { skip }, () => {
  before(async () => {
    door = await openPushDoor({
      suite: 'b128-parity-doors',
      spaces: [
        { id: S, label: S, folders: [], meta: { suppressEmbeddings: true } },
        // A view over the member: written by a proxy, a record lands in `pspace` (the target a write names).
        { id: PROXY, label: PROXY, folders: [], proxyFor: [S], meta: {} },
        { id: SCHEMA_SPACE, label: SCHEMA_SPACE, folders: [], meta: { suppressEmbeddings: true, validationMode: 'warn', typeSchemas: { entity: { wide: { propertySchemas: Object.fromEntries(WIDE.map(k => [k, { type: 'number' }])) } } } } },
        { id: EMBED_SPACE, label: EMBED_SPACE, folders: [], meta: {} },
      ],
    });
    ({ getConfig } = await import('../../server/dist/config/loader.js'));
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js'));
    ({ RETIRED_WRITE_FIELDS: RETIRED } = await import('../../server/dist/brain/retired-write-fields.js'));
    ({ NAME_QUOTED, REFUSAL_NAMES_MAX } = await import('../../server/dist/util/log.js'));
    const { toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');
    toolSchemas = toolSchemasFor([S, SCHEMA_SPACE, EMBED_SPACE, PROXY]);
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'b128-parity', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    app = await listenOnLoopback(http.createServer(createApp()));
    base = app.url;

    // ── the subjects: every non-GET route of the brain write routers, paired to its tool ────────────────────────────
    const { ROUTE_RULES } = await import('../../server/dist/audit/middleware.js');
    const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
    for (const [file, exportName] of BRAIN_WRITE_ROUTERS) {
      const router = (await import(`../../server/dist/api/brain/${file}.js`))[exportName];
      assert.ok(router?.stack, `${file}.ts no longer exports ${exportName} as a router — re-anchor BRAIN_WRITE_ROUTERS`);
      for (const layer of router.stack) {
        if (!layer.route) continue;
        for (const method of Object.keys(layer.route.methods).filter(m => layer.route.methods[m] && m !== 'get' && m !== '_all')) {
          const routePath = layer.route.path;
          const filled = `/api/brain${routePath.replace(/:spaceId/, S).replace(/:\w+/g, '00000000-0000-4000-8000-000000000000')}`;
          const rule = ROUTE_RULES.find(r => r.method === method.toUpperCase() && r.pattern.test(filled));
          const tools = Object.entries(MCP_TOOL_OPERATIONS).filter(([, v]) => v && [].concat(v).includes(rule?.operation)).map(([t]) => t);
          const verb = rule?.operation.split('.').pop();
          SUBJECTS.push({ file, method: method.toUpperCase(), routePath, op: rule?.operation, tools, tool: tools[0], takesNoBody: TAKES_NO_RECORD_BODY.has(verb) });
        }
      }
    }
  });

  after(async () => {
    await app?.close();
    await door?.close();
    await stub?.close();
  });

  // ── the subject set ──────────────────────────────────────────────────────────────────────────────────────────────


  // ── (a) the unknown key, under each mode ─────────────────────────────────────────────────────────────────────────

  it('(a) under warn every door stores the write and names the unknown field; the rows are the same on all three', async () => {
    setMode(S, 'absent');
    const failures = [];
    for (const s of judged()) {
      const { answers, snaps } = await threeDoors(s, { extra: withKey([UNKNOWN, UNKNOWN_VALUE]) });
      for (const [i, which] of DOORS.entries()) {
        const a = answers[which];
        if (a.refused) { failures.push(`${s.op} ${which}: refused ${a.status}: ${a.error.slice(0, 200)}`); continue; }
        if (snaps[i] === snaps[i + 1]) failures.push(`${s.op} ${which}: answered ${a.status} and stored nothing`);
        if (snaps[i + 1].includes(`"${UNKNOWN}"`)) failures.push(`${s.op} ${which}: the unknown field was STORED on the record`);
        const rows = unknownRows(a.data);
        if (rows.length !== 1 || rows[0].field !== UNKNOWN) failures.push(`${s.op} ${which}: the answer does not name ${UNKNOWN}: ${fmt(a.data?.warnings)}`);
      }
      if (!answers.rest.refused && !answers.mcp.refused && !answers.tool.refused) {
        try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
        catch { failures.push(`${s.op}: REST rows ${fmt(unknownRows(answers.rest.data))} / MCP rows ${fmt(unknownRows(answers.mcp.data))} / tool rows ${fmt(unknownRows(answers.tool.data))} differ`); }
      }
    }
    assert.deepEqual(failures, [], 'a warn space must answer an unknown field the same on every door: stored, and named once');
  });

  it('(a) under refuse every door refuses with the same body and stores nothing — the documents are read before, between and after the three calls', async () => {
    setMode(S, 'refuse');
    const failures = [];
    try {
      for (const s of judged()) {
        const { answers, snaps } = await threeDoors(s, { extra: withKey([UNKNOWN, UNKNOWN_VALUE]) });
        for (const [i, which] of DOORS.entries()) {
          const a = answers[which];
          if (a.status !== 400) failures.push(`${s.op} ${which}: answered ${a.status}, not 400: ${a.error.slice(0, 200)}`);
          if (snaps[i] !== snaps[i + 1]) failures.push(`${s.op} ${which}: a refused write left the documents changed`);
          const issue = a.data?.issues?.[0];
          if (issue?.code !== 'unrecognized_keys' || !issue.keys?.includes(UNKNOWN)) failures.push(`${s.op} ${which}: no unrecognized_keys issue naming ${UNKNOWN}: ${fmt(a.data)}`);
        }
        try {
          assert.deepEqual(comparable(answers.mcp.data), comparable(answers.rest.data));
          assert.deepEqual(comparable(answers.tool.data), comparable(answers.rest.data));
        } catch { failures.push(`${s.op}: the refusal body differs by door — REST ${fmt(answers.rest.data)} / MCP ${fmt(answers.mcp.data)} / tool ${fmt(answers.tool.data)}`); }
      }
    } finally { setMode(S, 'absent'); }
    assert.deepEqual(failures, [], 'a refuse space must refuse an unknown field the same on every door, before anything is stored');
  });

  it('(a) clearing the setting (null on the REST PATCH, "" on update_space) returns the space to warn, with the key absent from the config', async () => {
    const failures = [];
    const subject = SUBJECTS.find(s => s.op === 'entity.create');
    const probe = async (label) => {
      const { answers } = await threeDoors(subject, { extra: withKey([UNKNOWN, UNKNOWN_VALUE]) });
      for (const which of DOORS) if (answers[which].refused) failures.push(`${label} ${which}: still refuses after the clear (${answers[which].status})`);
    };
    for (const [label, clear] of [
      ['REST PATCH null', () => http_('PATCH', `/api/spaces/${S}`, { unknownWriteFields: null })],
      ['update_space ""', () => mcpCall('update_space', { space: S, unknownWriteFields: '' })],
    ]) {
      setMode(S, 'refuse');
      const done = await clear();
      if ((done.status ?? 0) >= 400 || done.isError) failures.push(`${label}: the clear was refused: ${done.text ?? ''}`.slice(0, 240));
      if ('unknownWriteFields' in getConfig().spaces.find(s => s.id === S)) failures.push(`${label}: the key is still on the space (it must be absent, never falsy)`);
      await probe(label);
    }
    setMode(S, 'absent');
    assert.deepEqual(failures, [], 'null and "" are the two spellings of "back to the default", and both leave the key absent');
  });

  // ── (b) retired + unknown ────────────────────────────────────────────────────────────────────────────────────────

  for (const mode of ['absent', 'refuse']) {
    it(`(b) a retired name and an unknown one together: the retired refusal, in ${mode === 'absent' ? 'warn' : 'refuse'}, carries the unknown rows`, async () => {
      setMode(S, mode);
      const retired = Object.keys(RETIRED).find(n => !['memories'].includes(n));
      const failures = [];
      try {
        for (const s of judged()) {
          const { answers, snaps } = await threeDoors(s, { extra: withKey([retired, []], [UNKNOWN, UNKNOWN_VALUE]) });
          for (const [i, which] of DOORS.entries()) {
            const a = answers[which];
            if (a.status !== 400) failures.push(`${s.op} ${which}: answered ${a.status}, not 400`);
            if (!a.error.includes(RETIRED[retired].message)) failures.push(`${s.op} ${which}: the retired sentence for ${retired} is missing: ${a.error.slice(0, 200)}`);
            if (snaps[i] !== snaps[i + 1]) failures.push(`${s.op} ${which}: a refused write changed the documents`);
            const rows = unknownRows(a.data).filter(r => r.field === UNKNOWN);
            const bad = rowProblems(rows, { outcome: 'refused', names: [UNKNOWN] });
            if (bad.length) failures.push(`${s.op} ${which}: ${bad.join('; ')}`);
          }
          try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
          catch { failures.push(`${s.op}: the rows differ by door`); }
        }
      } finally { setMode(S, 'absent'); }
      assert.deepEqual(failures, [], 'a retired name is refused by name in every mode, and the answer still names the unknown field beside it');
    });
  }

  // ── (c) a nested value stays refused per door; the unknown key rides on that refusal ─────────────────────────────

  /**
   * The subjects whose nested property value BOTH doors refuse today, found by asking with no unknown key in the body: REST
   * checks a value's type for an entity and for file metadata only (the fact, edge and chrono routes store a nested value, which
   * is not this change's to alter), while the MCP schema is closed on every tool. A subject is held to the nested refusal only
   * where both doors make one, so the case asks about the change and not about that older difference.
   */
  async function nestedRefusedOnBothDoors() {
    setMode(S, 'absent');
    const out = [];
    for (const s of judged().filter(x => acceptedOf({ tool: x.tool, addr: {} }).includes('properties'))) {
      const fx = await FIXTURES[s.op]();
      const req = requestOf(fx, { extra: { properties: { k: { nested: 1 } } } });
      const [rest, mcp] = [await ask('rest', req), await ask('mcp', req)];
      if (rest.status === 400 && mcp.status === 400) out.push(s);
    }
    return out;
  }

  for (const mode of ['absent', 'refuse']) {
    it(`(c) a nested value a door refuses stays refused on both doors in ${mode === 'absent' ? 'warn' : 'refuse'}, and the answer names the top-level unknown key`, async () => {
      const nested = await nestedRefusedOnBothDoors();
      assert.ok(nested.length >= 2, `only ${nested.length} subject(s) are refused for a nested value on both doors — the case would ask almost nothing`);
      setMode(S, mode);
      const failures = [];
      try {
        for (const s of nested) {
          const { answers, snaps } = await threeDoors(s, { extra: withKey(['properties', { k: { nested: 1 } }], [UNKNOWN, UNKNOWN_VALUE]) });
          for (const [i, which] of DOORS.entries()) {
            const a = answers[which];
            if (a.status !== 400) failures.push(`${s.op} ${which}: a nested property value was answered ${a.status}`);
            if (snaps[i] !== snaps[i + 1]) failures.push(`${s.op} ${which}: the refused write changed the documents`);
            if (mode === 'absent' && !a.error.includes('properties')) failures.push(`${s.op} ${which}: the refusal is not about the nested value: ${a.error.slice(0, 160)}`);
            const bad = rowProblems(unknownRows(a.data), { outcome: 'refused', names: [UNKNOWN] });
            if (bad.length) failures.push(`${s.op} ${which}: ${bad.join('; ')}`);
          }
        }
      } finally { setMode(S, 'absent'); }
      assert.deepEqual(failures, [], 'a nested refusal is another reason a judged call fails, so it carries the unknown rows too');
    });
  }

  it('(c) a nested unknown key inside an inline edge stays refused by the MCP dispatcher, in warn, and the answer still names the top-level unknown key', async () => {
    setMode(S, 'absent');
    const failures = [];
    for (const s of judged().filter(x => acceptedOf({ tool: x.tool, addr: {} }).includes('edges'))) {
      const target = await seed('entity');
      const fx = await FIXTURES[s.op]();
      const req = requestOf(fx, { extra: withKey(['edges', [{ to: target, label: 'rel', nestedUnknown: 1 }]], [UNKNOWN, UNKNOWN_VALUE]) });
      for (const which of ['mcp', 'tool']) {
        const a = await ask(which, req);
        if (a.status !== 400 || !a.error.includes('nestedUnknown')) failures.push(`${s.op} ${which}: the nested unknown key was not refused by name (${a.status}): ${a.error.slice(0, 200)}`);
        const bad = rowProblems(unknownRows(a.data), { outcome: 'refused', names: [UNKNOWN] });
        if (bad.length) failures.push(`${s.op} ${which}: ${bad.join('; ')}`);
      }
    }
    assert.ok(judged().some(x => acceptedOf({ tool: x.tool, addr: {} }).includes('edges')), 'no subject takes inline edges — the case ran over nothing');
    assert.deepEqual(failures, [], 'tolerance is for the top level only: a nested unknown key is still the dispatcher\'s refusal, and it is one more reason to name the top-level key');
  });

  // ── (d) names the accepted set must not contain through the prototype ────────────────────────────────────────────

  for (const mode of ['absent', 'refuse']) {
    it(`(d) "constructor" and "__proto__" are unknown keys, not accepted ones, in ${mode === 'absent' ? 'warn' : 'refuse'}`, async () => {
      setMode(S, mode);
      const failures = [];
      try {
        for (const s of judged()) {
          // Built by JSON.parse, so `__proto__` is an OWN key as it is when it arrives over the wire.
          const { answers } = await threeDoors(s, { extra: JSON.parse('{"constructor":1,"__proto__":{}}') });
          for (const which of DOORS) {
            const a = answers[which];
            const names = unknownRows(a.data).map(r => r.field).sort();
            if (JSON.stringify(names) !== JSON.stringify(['__proto__', 'constructor'])) failures.push(`${s.op} ${which}: rows name ${fmt(names)} (answered ${a.status}) instead of constructor and __proto__`);
            if (mode === 'refuse' && a.status !== 400) failures.push(`${s.op} ${which}: answered ${a.status}, not 400`);
          }
        }
      } finally { setMode(S, 'absent'); }
      assert.deepEqual(failures, [], 'membership is tested on a Set, so a prototype name is as unknown as any other');
    });
  }

  // ── (e) the wording, by mode and outcome, the same on all doors ──────────────────────────────────────────────────

  it('(e) a stored answer says "ignored" with the value, a refused one "not accepted" without it; code, wording and the accepted list are the same on all doors, and the list appears once', async () => {
    const failures = [];
    const three = [['uk_alpha', 1], ['uk_beta', 'two'], ['uk_gamma', true]];
    for (const mode of ['absent', 'refuse']) {
      setMode(S, mode);
      try {
        for (const s of judged()) {
          const { answers, fxs } = await threeDoors(s, { extra: Object.fromEntries(three) });
          const accepted = acceptedOf(fxs[0]).sort();
          const outcome = mode === 'absent' ? 'stored' : 'refused';
          for (const which of DOORS) {
            const a = answers[which];
            const rows = unknownRows(a.data);
            const bad = rowProblems(rows, { outcome, names: three.map(t => t[0]) });
            if (bad.length) failures.push(`${s.op} ${mode} ${which}: ${bad.join('; ')}`);
            const holders = rows.filter(r => /This write accepts:/.test(r.reason ?? ''));
            if (holders.length !== 1 || holders[0] !== rows[0]) failures.push(`${s.op} ${mode} ${which}: the accepted list must be in the first row and only there (in ${holders.length} row(s))`);
            else {
              const listed = holders[0].reason.split('This write accepts:')[1].split(' — ')[0].split(',').map(x => x.trim()).filter(Boolean).sort();
              if (JSON.stringify(listed) !== JSON.stringify(accepted)) failures.push(`${s.op} ${mode} ${which}: the answer lists ${fmt(listed)}, the tool declares ${fmt(accepted)}`);
            }
            if (outcome === 'stored') for (const [name, value] of three) if (rows.find(r => r.field === name)?.value !== value) failures.push(`${s.op} ${mode} ${which}: the row for ${name} does not carry its value ${fmt(value)}`);
            if (which === 'mcp') {
              const lines = a.text.split('\n').filter(l => l.includes('Unknown field'));
              if (lines.length < 3) failures.push(`${s.op} ${mode} mcp: ${lines.length} "Unknown field" text line(s), expected one per name`);
              if ((a.text.match(/This write accepts:/g) ?? []).length !== 1) failures.push(`${s.op} ${mode} mcp: the accepted list is not in the text exactly once`);
              if (!a.text.includes(outcome === 'stored' ? '— ignored' : '— not accepted')) failures.push(`${s.op} ${mode} mcp: the text lines do not carry the ${outcome} wording`);
            }
          }
          try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
          catch { failures.push(`${s.op} ${mode}: the rows differ by door`); }
        }
      } finally { setMode(S, 'absent'); }
    }
    assert.deepEqual(failures, [], 'one judge writes the rows, so wording, code, value and the accepted list cannot differ by door');
  });

  // ── (f) an unknown key beside a failure of another kind ──────────────────────────────────────────────────────────

  for (const mode of ['absent', 'refuse']) {
    it(`(f) an unknown key beside a missing required field or an empty update: every door's refusal carries the same rows without a value, in ${mode === 'absent' ? 'warn' : 'refuse'}`, async () => {
      // The subjects whose body is refused for being empty on BOTH doors today, asked with no unknown key in it: a create without its
      // required fields, an update that changes nothing. A route that stores an empty body has no other refusal to carry rows on.
      setMode(S, 'absent');
      const refusable = [];
      for (const s of judged().filter(x => x.op !== 'entity.merge')) {
        const req = requestOf(await FIXTURES[s.op](), { payload: {} });
        if ((await ask('rest', req)).status === 400 && (await ask('mcp', req)).status === 400) refusable.push(s);
      }
      setMode(S, mode);
      const failures = [];
      const asked = [];
      try {
        for (const s of refusable) {
          asked.push(s.op);
          const { answers, snaps, fxs } = await threeDoors(s, { payload: {}, extra: withKey([UNKNOWN, UNKNOWN_VALUE]) });
          for (const [i, which] of DOORS.entries()) {
            const a = answers[which];
            if (a.status !== 400) failures.push(`${s.op} ${which}: answered ${a.status}, not 400`);
            if (snaps[i] !== snaps[i + 1]) failures.push(`${s.op} ${which}: the refused write changed the documents`);
            const bad = rowProblems(unknownRows(a.data), { outcome: 'refused', names: [UNKNOWN] });
            if (bad.length) failures.push(`${s.op} ${which}: ${bad.join('; ')}`);
            if (mode === 'refuse' && a.data?.issues?.[0]?.code !== 'unrecognized_keys') failures.push(`${s.op} ${which}: the judge did not answer first (${a.error.slice(0, 120)})`);
          }
          try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
          catch { failures.push(`${s.op}: the rows differ by door`); }
          if (mode === 'absent' && fxs[0].missing === 'update') {
            // The "nothing to update" sentence is ONE derived sentence on every door (section 2.3), not four hand lists and a fifth on REST.
            // The MCP text is the sentence, then one line per row: the sentence is its first line.
            const rest = answers.rest.error; const mcp = answers.mcp.error.split('\n')[0].replace(/^Error: /, '');
            if (!/^At least one of .+ must be provided$/.test(rest) || rest !== mcp) failures.push(`${s.op}: the "at least one" refusal is ${fmt(rest)} on REST and ${fmt(mcp)} on MCP`);
          }
        }
      } finally { setMode(S, 'absent'); }
      assert.ok(asked.length >= 9, `only ${asked.length} subject(s) had a failure to carry the rows beside`);
      assert.deepEqual(failures, [], 'the unknown rows ride on a refusal for another reason, and a nothing-to-update refusal is one sentence everywhere');
    });
  }

  // ── (g) the target is resolved BEFORE the judge ──────────────────────────────────────────────────────────────────

  for (const mode of ['absent', 'refuse']) {
    it(`(g) an unknown key beside a failed targetSpace: both doors answer the resolution error and no rows, in ${mode === 'absent' ? 'warn' : 'refuse'}`, async () => {
      setMode(S, mode); setMode(PROXY, mode);
      const failures = [];
      try {
        for (const s of judged().filter(x => !NO_PROXY_CASE.has(x.op))) {
          const fx = await FIXTURES[s.op]();
          const extra = withKey([UNKNOWN, UNKNOWN_VALUE]);
          // Control: the proxy fixture works — a VALID write that names its member is accepted on every door, so a refusal below is
          // about the target and not about a proxy the fixture could not write through.
          for (const which of DOORS) {
            const good = await ask(which, requestOf(await FIXTURES[s.op](), { space: PROXY, targetRest: S, targetMcp: S }));
            if (good.refused) failures.push(`${s.op} ${which}: a valid write through the proxy to ${S} was refused (${good.status}): ${good.error.slice(0, 160)}`);
          }
          const cases = [
            ['a target that is not a member', { targetRest: 'nope', targetMcp: 'nope' }, /'nope' is not a member of proxy space 'pproxy'/],
            ['no target on a proxy space', {}, /This is a proxy space\. Specify targetSpace/],
          ];
          for (const [label, target, expected] of cases) {
            const req = requestOf(fx, { space: PROXY, extra, ...target });
            for (const which of DOORS) {
              const a = await ask(which, req);
              if (a.status !== 400 || !expected.test(a.error)) failures.push(`${s.op} ${which} (${label}): answered ${a.status} ${a.error.slice(0, 200)}`);
              if (unknownRows(a.data).length > 0) failures.push(`${s.op} ${which} (${label}): resolution comes first, yet the answer carries unknown rows ${fmt(unknownRows(a.data))}`);
            }
          }
        }
      } finally { setMode(S, 'absent'); setMode(PROXY, 'absent'); }
      assert.deepEqual(failures, [], 'a call whose target cannot be resolved is refused for that, with nothing said about its body');
    });
  }

  it('(g) a targetSpace that is not a string answers "targetSpace must be a string" on both doors — the array a REST query makes of a repeated name, and the object an MCP caller can send — and never a TypeError', async () => {
    const failures = [];
    for (const s of judged().filter(x => !NO_PROXY_CASE.has(x.op))) {
      const fx = await FIXTURES[s.op]();
      const rest = await ask('rest', requestOf(fx, { space: PROXY, targetRest: ['a', 'b'] }));
      if (rest.status !== 400 || !rest.error.includes('targetSpace must be a string')) failures.push(`${s.op} REST ?targetSpace=a&targetSpace=b: answered ${rest.status} ${rest.error.slice(0, 160)}`);
      for (const which of ['mcp', 'tool']) {
        const a = await ask(which, requestOf(fx, { space: PROXY, targetMcp: { toString: 1 } }));
        if (a.status !== 400 || !a.error.includes('targetSpace must be a string')) failures.push(`${s.op} ${which} {"toString":1}: answered ${a.status} ${a.error.slice(0, 160)}`);
        if (/TypeError/.test(a.text)) failures.push(`${s.op} ${which}: the dispatcher threw a TypeError out of the template`);
      }
    }
    assert.deepEqual(failures, [], 'the string guard lives in resolveWriteTarget, so both doors refuse a non-string target in the same words before any lookup');
  });

  // ── (h) merge: the judge before the path ids ─────────────────────────────────────────────────────────────────────

  it('(h) a merge with an unknown key and a malformed survivor id: warn names the key on the id refusal, refuse is the judge\'s refusal — on both doors', async () => {
    const failures = [];
    const s = SUBJECTS.find(x => x.op === 'entity.merge');
    assert.ok(s, 'no merge subject was derived');
    for (const mode of ['absent', 'refuse']) {
      setMode(S, mode);
      try {
        const { answers } = await threeDoors(s, fx => ({ extra: withKey([UNKNOWN, UNKNOWN_VALUE]), addr: { survivorId: 'not-a-uuid' } }));
        for (const which of DOORS) {
          const a = answers[which];
          if (a.status !== 400) failures.push(`${mode} ${which}: answered ${a.status}, not 400`);
          if (mode === 'refuse' && a.data?.issues?.[0]?.code !== 'unrecognized_keys') failures.push(`refuse ${which}: the path-id refusal came before the judge: ${a.error.slice(0, 160)}`);
          if (mode === 'absent' && !a.error.includes('survivorId')) failures.push(`warn ${which}: the malformed survivor id is not what refused: ${a.error.slice(0, 160)}`);
          const bad = rowProblems(unknownRows(a.data), { outcome: 'refused', names: [UNKNOWN] });
          if (bad.length) failures.push(`${mode} ${which}: ${bad.join('; ')}`);
        }
      } finally { setMode(S, 'absent'); }
    }
    assert.deepEqual(failures, [], 'the unknown-key judge precedes the addressing checks on the merge path, as it does on MCP');
  });

  // ── (i) chrono superseded ────────────────────────────────────────────────────────────────────────────────────────

  for (const mode of ['absent', 'refuse']) {
    it(`(i) PATCH chrono {superseded:true} succeeds and is stored on every door, in ${mode === 'absent' ? 'warn' : 'refuse'}`, async () => {
      setMode(S, mode);
      const failures = [];
      try {
        const s = SUBJECTS.find(x => x.op === 'chrono.update');
        assert.ok(s, 'no chrono update subject was derived');
        for (const which of DOORS) {
          const fx = await FIXTURES['chrono.update']();
          const a = await ask(which, requestOf(fx, { payload: { superseded: true } }));
          const stored = await door.mongo.col(`${S}_chrono`).findOne({ _id: fx.addr.id });
          if (a.refused) failures.push(`${which}: refused ${a.status}: ${a.error.slice(0, 160)}`);
          if (stored?.superseded !== true) failures.push(`${which}: the stored entry has superseded=${fmt(stored?.superseded)}`);
        }
      } finally { setMode(S, 'absent'); }
      assert.deepEqual(failures, [], 'superseded is an accepted key of the chrono update, so a body of only that key is a real edit on REST as it is on MCP');
    });
  }

  // ── (j) near-misses, and a key too large to measure ──────────────────────────────────────────────────────────────

  const distance = (a, b) => {
    const row = Array.from({ length: b.length + 1 }, (_, j) => j);
    for (let i = 1; i <= a.length; i++) {
      let diag = row[0]; row[0] = i;
      for (let j = 1; j <= b.length; j++) { const up = row[j]; row[j] = Math.min(row[j] + 1, row[j - 1] + 1, diag + (a[i - 1] === b[j - 1] ? 0 : 1)); diag = up; }
    }
    return row[b.length];
  };

  for (const mode of ['absent', 'refuse']) {
    it(`(j) a misspelt accepted key carries "did you mean" — by a deleted letter and by case alone — and an unrelated key does not, in ${mode === 'absent' ? 'warn' : 'refuse'}`, async () => {
      setMode(S, mode);
      const failures = [];
      try {
        for (const s of judged().filter(x => x.op !== 'entity.merge')) {
          const fx0 = await FIXTURES[s.op]();
          const accepted = acceptedOf(fx0);
          const target = accepted.find(k => k.length >= 6 && /^[a-z]/.test(k) && (() => { const typo = k.slice(0, 2) + k.slice(3); return accepted.every(o => o === k || distance(typo, o) > 1) && !accepted.includes(typo); })());
          if (!target) { failures.push(`${s.op}: no accepted key of the tool is a safe near-miss target — ${fmt(accepted)}`); continue; }
          const typo = target.slice(0, 2) + target.slice(3);
          const caseOnly = target[0].toUpperCase() + target.slice(1);
          const { answers } = await threeDoors(s, { extra: withKey([typo, 1], [caseOnly, 1], [UNKNOWN, 1]) });
          for (const which of DOORS) {
            const rows = unknownRows(answers[which].data);
            for (const [name, hint] of [[typo, true], [caseOnly, true], [UNKNOWN, false]]) {
              const row = rows.find(r => r.field === name);
              const has = typeof row?.reason === 'string' && row.reason.includes(` — did you mean '${target}'?`);
              if (!row) failures.push(`${s.op} ${which}: no row for ${name} (${answers[which].status})`);
              else if (has !== hint) failures.push(`${s.op} ${which}: ${name} ${hint ? 'lacks' : 'wrongly carries'} the hint for ${target}: ${fmt(row.reason)}`);
            }
          }
        }
      } finally { setMode(S, 'absent'); }
      assert.deepEqual(failures, [], 'the suggestion is computed for the keys that are rowed, against the accepted set, and a case-only difference counts');
    });
  }

  it('(j) a megabyte key is answered within a time bound, its name cut and no suggestion computed for it', async () => {
    setMode(S, 'absent');
    const failures = [];
    const subject = SUBJECTS.find(s => s.op === 'entity.create');
    const huge = 'x'.repeat(1 << 20);
    for (const which of DOORS) {
      const fx = await FIXTURES['entity.create']();
      const t0 = Date.now();
      const a = await ask(which, requestOf(fx, { extra: { [huge]: 1 } }));
      const ms = Date.now() - t0;
      const rows = unknownRows(a.data);
      if (ms > 5000) failures.push(`${which}: ${ms} ms for one oversized key`);
      if (rows.length !== 1 || rows[0].code !== 'unknown_field') failures.push(`${which}: the oversized key was not answered as one unknown row (${a.status}): ${fmt(rows).slice(0, 200)}`);
      else if (rows[0].field.length > NAME_QUOTED + 8) failures.push(`${which}: the row quotes ${rows[0].field.length} characters of a key, past NAME_QUOTED=${NAME_QUOTED}`);
    }
    assert.ok(subject, 'no entity create subject');
    assert.deepEqual(failures, [], 'a caller\'s key is cut before it is measured, so a huge one costs the same as a short one');
  });

  // ── (k) link keys the tool does not declare ──────────────────────────────────────────────────────────────────────

  it('(k) linkFiles is an unknown key on an entity and on file metadata, on every door: the write is stored, it is not counted as a field, and no link is stored from it', async () => {
    setMode(S, 'absent');
    const failures = [];
    const ghost = crypto.randomUUID();
    for (const s of judged().filter(x => ['entity.update', 'file.meta.update'].includes(x.op))) {
      for (const which of DOORS) {
        const fx = await FIXTURES[s.op]();
        const a = await ask(which, requestOf(fx, { extra: { linkFiles: [ghost] } }));
        const rows = unknownRows(a.data);
        if (a.refused) failures.push(`${s.op} ${which}: valid fields plus linkFiles was refused ${a.status}: ${a.error.slice(0, 200)}`);
        if (!rows.some(r => r.field === 'linkFiles' && String(r.reason).startsWith(IGNORED))) failures.push(`${s.op} ${which}: linkFiles is not named as ignored: ${fmt(a.data?.warnings)}`);
        // Nothing was linked: no link record names the ghost file. (The audit log is not read back: its change list is an allowlist
        // with no link fields for these operations, so a read-back could never fail.)
        const linked = await door.mongo.col(`${S}_links`).findOne({ to: ghost });
        if (linked) failures.push(`${s.op} ${which}: a link to the ghost file was stored from a field the write does not take: ${fmt(linked)}`);
      }
    }
    // A body of nothing but the unknown link key has nothing to update: the refusal names the accepted fields, and the key is still named.
    // Asked of the entity update, whose route carries a "nothing to update" refusal today (file metadata's does not).
    const entityUpdate = await FIXTURES['entity.update']();
    const only = await ask('rest', requestOf(entityUpdate, { payload: {}, extra: { linkFiles: [ghost] } }));
    if (only.status !== 400 || !/^At least one of /.test(only.error)) failures.push(`entity.update REST {linkFiles} alone: answered ${only.status} ${only.error.slice(0, 160)} — an unknown link key must not count as something to update`);
    if (!unknownRows(only.data).some(r => r.field === 'linkFiles')) failures.push(`entity.update REST {linkFiles} alone: the refusal does not name linkFiles: ${fmt(only.data)}`);
    assert.deepEqual(failures, [], 'link helpers read only the classes the record kind holds, so an undeclared link key is neither written, audited nor counted');
  });

  // ── (l) a stored record whose connections failed; a plain store failure ──────────────────────────────────────────

  /** Fail every driver command (or only the writes) on the named collections of the space, then run `fn`. */
  async function withStoreFault({ collections, writesOnly }, fn) {
    const real = Server.prototype.command;
    const WRITES = new Set(['insert', 'update', 'delete', 'findAndModify']);
    const names = new Set(collections.map(c => `${S}_${c}`));
    Server.prototype.command = async function fault(op, ...rest) {
      if (names.has(op?.ns?.collection) && (!writesOnly || WRITES.has(op?.commandName))) {
        throw new PoolClearedError({ address: 'harness:27017', serverError: new MongoNetworkTimeoutError('harness fault') });
      }
      return real.call(this, op, ...rest);
    };
    try { return await fn(); } finally { Server.prototype.command = real; }
  }

  it('(l) a stored record whose connections failed keeps its 5xx and carries the unknown rows on every door; a plain store failure carries none', async () => {
    setMode(S, 'absent');
    const failures = [];
    const withEdges = judged().filter(s => acceptedOf({ tool: s.tool, addr: {} }).includes('edges'));
    assert.ok(withEdges.length >= 4, `only ${withEdges.length} subject(s) take inline edges — the case ran over too little`);
    for (const s of withEdges) {
      const far = await seed('entity');
      const fxs = [await FIXTURES[s.op](), await FIXTURES[s.op](), await FIXTURES[s.op]()];
      const answers = {};
      const before = await snapshot();
      for (const [i, which] of DOORS.entries()) {
        const req = requestOf(fxs[i], { extra: { edges: [{ to: far, label: 'rel' }], [UNKNOWN]: UNKNOWN_VALUE } });
        answers[which] = await withStoreFault({ collections: ['edges'], writesOnly: true }, () => ask(which, req));
      }
      for (const which of DOORS) {
        const a = answers[which];
        if (a.status < 500 || !a.data?.written?.id) failures.push(`${s.op} ${which}: not the connections-not-written answer (${a.status}): ${fmt(a.data)}`);
        const bad = rowProblems(unknownRows(a.data), { outcome: 'stored', names: [UNKNOWN] }).filter(p => !p.includes('does not start with'));
        if (bad.length) failures.push(`${s.op} ${which}: ${bad.join('; ')}`);
      }
      try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
      catch { failures.push(`${s.op}: the rows on the connections-not-written answer differ by door`); }
      if (s.op.endsWith('.create') && before === await snapshot()) failures.push(`${s.op}: nothing was stored, so this was not a stored record whose connections failed`);
    }
    // The other half of the rule: nothing stored and the cause a store failure — no rows, on any door.
    for (const s of judged().filter(x => x.op === 'entity.create' || x.op === 'fact.create')) {
      const fxs = [await FIXTURES[s.op](), await FIXTURES[s.op](), await FIXTURES[s.op]()];
      const before = await snapshot();
      for (const [i, which] of DOORS.entries()) {
        const a = await withStoreFault({ collections: RECORD_COLLECTIONS, writesOnly: false }, () => ask(which, requestOf(fxs[i], { extra: { [UNKNOWN]: UNKNOWN_VALUE } })));
        if (a.status < 500) failures.push(`${s.op} ${which}: a failing store was answered ${a.status}`);
        if (unknownRows(a.data).length) failures.push(`${s.op} ${which}: a plain store failure carries unknown rows ${fmt(unknownRows(a.data))}`);
      }
      if (before !== await snapshot()) failures.push(`${s.op}: the failing store left documents behind`);
    }
    assert.deepEqual(failures, [], 'rows ride on a stored record whose connections failed, and on nothing a store failure refused outright');
  });

  // ── (m) bounds ───────────────────────────────────────────────────────────────────────────────────────────────────

  const names = (n) => Array.from({ length: n }, (_, i) => `uk${String(i).padStart(2, '0')}`);
  for (const [n, rowed, more] of [[10, 10, 0], [11, 10, 1], [12, 10, 2]]) {
    for (const mode of ['absent', 'refuse']) {
      it(`(m) ${n} unknown names are ${rowed} rows${more ? ` and one "…(+${more} more)"` : ''}, in ${mode === 'absent' ? 'warn' : 'refuse'}, the same on every door`, async () => {
        setMode(S, mode);
        const failures = [];
        try {
          for (const s of judged()) {
            const { answers } = await threeDoors(s, { extra: Object.fromEntries(names(n).map(k => [k, 1])) });
            for (const which of DOORS) {
              const rows = unknownRows(answers[which].data);
              const named = rows.filter(r => !String(r.field).startsWith('…'));
              const overflow = rows.filter(r => String(r.field).startsWith('…'));
              if (named.length !== rowed) failures.push(`${s.op} ${which}: ${named.length} named row(s), expected ${rowed}`);
              if (more === 0 && overflow.length) failures.push(`${s.op} ${which}: an overflow row for exactly ${REFUSAL_NAMES_MAX} names: ${fmt(overflow)}`);
              if (more > 0 && (overflow.length !== 1 || !overflow[0].field.includes(`(+${more} more)`) || overflow[0].code !== 'unknown_field')) failures.push(`${s.op} ${which}: expected one "(+${more} more)" row with the code, got ${fmt(overflow)}`);
              if (mode === 'refuse' && overflow.some(r => 'value' in r)) failures.push(`${s.op} ${which}: the overflow row of a refusal carries a value`);
            }
            try { assert.deepEqual(unknownRows(answers.mcp.data), unknownRows(answers.rest.data)); assert.deepEqual(unknownRows(answers.tool.data), unknownRows(answers.rest.data)); }
            catch { failures.push(`${s.op}: the rows differ by door`); }
          }
        } finally { setMode(S, 'absent'); }
        assert.deepEqual(failures, [], 'at most REFUSAL_NAMES_MAX names are rowed and the rest are counted, identically on every door');
      });
    }
  }

  it('(m) twenty schema warnings and one unknown key: the unknown row is present, first, and outside the schema cut', async () => {
    setMode(SCHEMA_SPACE, 'absent');
    const failures = [];
    const properties = Object.fromEntries(WIDE.map(k => [k, 'not a number']));
    const body = { name: uniq('wide'), type: 'wide', properties, [UNKNOWN]: UNKNOWN_VALUE };
    const rest = await http_('POST', `/api/brain/spaces/${SCHEMA_SPACE}/entities`, body);
    const mcp = await mcpCall('save_entity', { space: SCHEMA_SPACE, ...body });
    const tool = await http_('POST', '/api/save_entity', { space: SCHEMA_SPACE, ...body });
    for (const [which, data, status] of [['rest', rest.body, rest.status], ['mcp', mcp.sc, mcp.status], ['tool', tool.body?.data, tool.status]]) {
      const rows = Array.isArray(data?.warnings) ? data.warnings : [];
      const schemaRows = rows.filter(r => r.code !== 'unknown_field' && !String(r.reason).startsWith('unknown field'));
      if (rows.length === 0 || rows[0].field !== UNKNOWN || rows[0].code !== 'unknown_field') failures.push(`${which} (answered ${status}): the unknown row is not first among ${rows.length} row(s): ${fmt(rows.slice(0, 2))}`);
      if (schemaRows.length !== 20) failures.push(`${which}: ${schemaRows.length} schema row(s) beside the unknown one, expected the cut of 20`);
    }
    if (rest.body?.warningsTruncated !== true) failures.push('rest: warningsTruncated is not set although 21 schema rows were cut to 20');
    assert.deepEqual(failures, [], 'the unknown rows sit outside MAX_ROWS, so twenty schema rows cannot push them out');
  });

  // ── (n) bulk ─────────────────────────────────────────────────────────────────────────────────────────────────────

  const bulkOn = (which, body) => which === 'rest'
    ? ask('rest', { rest: { method: 'POST', url: `/api/brain/spaces/${S}/bulk`, body: JSON.stringify(body) } })
    : ask(which, { tool: { name: 'save_bulk', args: { space: S, ...body } } });
  const bulkErrors = (a) => (a.data?.errors ?? []);
  const unknownErrors = (a) => bulkErrors(a).filter(e => String(e.reason).startsWith('unknown_field'));

  it('(n) warn: an item with an unknown key is written and one "unknown_field:" row names it, with the accepted list once — a chrono item\'s recurrence is accepted and stored', async () => {
    assertSubjectSet();
    setMode(S, 'absent');
    const failures = [];
    assert.ok(SUBJECTS.some(s => s.op === 'bulk.write'), 'the bulk route is not among the derived subjects');
    for (const which of DOORS) {
      const t = uniq('bulk');
      const body = {
        // The second fact is refused for ANOTHER reason (nothing to store), and keeps its unknown rows beside that reason.
        facts: [{ fact: `${t} fact`, uk_fact: 1 }, { fact: '', uk_other_reason: 1 }],
        entities: [{ name: `${t} entity`, type: 'thing', uk_entity: 1 }],
        chrono: [{ title: `${t} chrono`, type: 'event', startsAt: '2026-01-01T00:00:00.000Z', recurrence: { freq: 'daily' }, uk_chrono: 1 }],
      };
      const a = await bulkOn(which, body);
      const rows = unknownErrors(a);
      if (a.refused) failures.push(`${which}: refused ${a.status}: ${a.error.slice(0, 200)}`);
      for (const [type, key] of [['fact', 'uk_fact'], ['entity', 'uk_entity'], ['chrono', 'uk_chrono']]) {
        const mine = rows.filter(r => r.type === type && r.index === 0);
        if (mine.length !== 1 || !mine[0].reason.includes(key)) failures.push(`${which}: expected one unknown_field row for the ${type} item naming ${key}, got ${fmt(mine)}`);
      }
      if (rows.some(r => r.reason.includes('recurrence'))) failures.push(`${which}: recurrence is read and stored by the chrono item, so it is not unknown: ${fmt(rows)}`);
      if (rows.filter(r => /accepts:/.test(r.reason)).length !== 1) failures.push(`${which}: the accepted list must appear once per batch`);
      const chrono = await door.mongo.col(`${S}_chrono`).findOne({ title: `${t} chrono` });
      if (chrono?.recurrence?.freq !== 'daily') failures.push(`${which}: the chrono item's recurrence was not stored: ${fmt(chrono?.recurrence)}`);
      if (!await door.mongo.col(`${S}_facts`).findOne({ fact: `${t} fact` })) failures.push(`${which}: the fact item was not written`);
      if (a.data?.inserted?.entities !== 1) failures.push(`${which}: the entity item was not written: ${fmt(a.data?.inserted)}`);
      const other = bulkErrors(a).filter(r => r.type === 'fact' && r.index === 1).map(r => r.reason).join(' | ');
      if (!other.includes('missing required field') || !other.includes('uk_other_reason')) failures.push(`${which}: the item refused for another reason lost its unknown rows: ${fmt(other)}`);
    }
    // Control, held in every mode: the TOP level of a batch names collections, and an unknown name there is refused outright, on every door.
    for (const mode of ['absent', 'refuse']) {
      setMode(S, mode);
      try {
        for (const which of DOORS) {
          const a = await bulkOn(which, { facts: [{ fact: uniq('top') }], [UNKNOWN]: 1 });
          if (a.status !== 400 || !a.error.includes(UNKNOWN)) failures.push(`${mode} ${which}: a top-level unknown key was answered ${a.status}: ${a.error.slice(0, 160)}`);
        }
      } finally { setMode(S, 'absent'); }
    }
    assert.deepEqual(failures, [], 'a warn batch writes the item and says what it did not take, on both doors');
  });

  it('(n) the rows of a batch are the same on every door, and a batch is capped at 50 unknown rows then "(+N more items)"; each item names at most 10 keys then "(+N more)"', async () => {
    assertSubjectSet();
    setMode(S, 'absent');
    const failures = [];
    const answers = {};
    for (const which of DOORS) {
      const t = uniq('cap');
      answers[which] = await bulkOn(which, { facts: Array.from({ length: 55 }, (_, i) => ({ fact: `${t} ${i}`, [`uk_item_${i}`]: 1 })) });
    }
    for (const which of DOORS) {
      const rows = unknownErrors(answers[which]);
      const overflow = rows.filter(r => /\(\+\d+ more items\)/.test(r.reason));
      const named = rows.filter(r => !/\(\+\d+ more items\)/.test(r.reason));
      if (named.length !== 50) failures.push(`${which}: ${named.length} per-item unknown row(s), expected the cap of 50`);
      if (overflow.length !== 1 || !overflow[0].reason.includes('(+5 more items)')) failures.push(`${which}: expected one "(+5 more items)" row, got ${fmt(overflow)}`);
      if ((answers[which].data?.inserted?.facts ?? 0) !== 55) failures.push(`${which}: ${answers[which].data?.inserted?.facts} of 55 items written under warn`);
    }
    const many = await bulkOn('rest', { facts: [{ fact: uniq('many'), ...Object.fromEntries(names(12).map(k => [k, 1])) }] });
    const row = unknownErrors(many)[0];
    if (!row || !/\(\+2 more\)/.test(row.reason) || names(10).some(k => !row.reason.includes(k)) || row.reason.includes(names(12)[10])) failures.push(`one item with 12 unknown keys: expected 10 named and "(+2 more)", got ${fmt(row)}`);
    for (const which of ['mcp', 'tool']) {
      try { assert.deepEqual(unknownErrors(answers[which]).map(r => r.reason.replace(/\d+/g, '#')), unknownErrors(answers.rest).map(r => r.reason.replace(/\d+/g, '#'))); }
      catch { failures.push(`${which}: the unknown rows differ from REST's`); }
    }
    assert.deepEqual(failures, [], 'bulk bounds what it says about unknown keys, per item and per batch, and every door says the same');
  });

  it('(n) refuse: the item is rejected (207), a $ref dependant is told why, the other items proceed; an item refused for another reason keeps its unknown rows', async () => {
    assertSubjectSet();
    setMode(S, 'refuse');
    const failures = [];
    try {
      for (const which of DOORS) {
        const t = uniq('refuse');
        const far = await seed('entity');
        const body = {
          facts: [{ fact: `${t} fine` }, { fact: `${t} bad`, uk_refused: 1 }, { fact: '', uk_other_reason: 1 }],
          entities: [{ $ref: 'gone', name: `${t} entity`, type: 'thing', uk_ref: 1 }],
          edges: [{ from: '$ref:gone', to: far, label: 'dep' }],
        };
        const before = await snapshot();
        const a = await bulkOn(which, body);
        const rows = bulkErrors(a);
        if (which === 'rest' && a.status !== 207) failures.push(`rest: answered ${a.status}, not 207`);
        if (!await door.mongo.col(`${S}_facts`).findOne({ fact: `${t} fine` })) failures.push(`${which}: the clean item did not proceed`);
        if (await door.mongo.col(`${S}_facts`).findOne({ fact: `${t} bad` })) failures.push(`${which}: the item with an unknown key was written under refuse`);
        if (await door.mongo.col(`${S}_entities`).findOne({ name: `${t} entity` })) failures.push(`${which}: the entity with an unknown key was written under refuse`);
        if (!rows.some(r => r.type === 'fact' && r.index === 1 && r.reason.includes('uk_refused'))) failures.push(`${which}: no row says why fact[1] was rejected: ${fmt(rows)}`);
        const other = rows.filter(r => r.type === 'fact' && r.index === 2).map(r => r.reason).join(' | ');
        if (!other.includes('uk_other_reason')) failures.push(`${which}: the second fact (empty AND carrying an unknown key) is not rejected with its unknown key named: ${fmt(other)}`);
        const dependant = rows.filter(r => r.type === 'edge' && r.index === 0).map(r => r.reason).join(' | ');
        if (!dependant.includes('uk_ref')) failures.push(`${which}: the $ref dependant was not told why its reference failed: ${fmt(dependant)}`);
        if (before === await snapshot()) failures.push(`${which}: nothing at all was written, the clean item included`);
      }
    } finally { setMode(S, 'absent'); }
    assert.deepEqual(failures, [], 'refuse rejects the item through the batch\'s own reject, so a dependant is told and the rest proceed');
  });

  // ── (p) Q-495: waitForEmbedding is declared and honoured ─────────────────────────────────────────────────────────

  it('(p) waitForEmbedding on a create is honoured on every door: the vector is stored when the call returns (entity, chrono and edge declared it nowhere on MCP)', async () => {
    const failures = [];
    const creates = judged().filter(s => FIXTURES[s.op] && s.op.endsWith('.create') && s.op !== 'link.create');
    assert.ok(creates.length >= 4, `only ${creates.length} embedding create(s) found`);
    // A write that honours the option has the vector as the call returns; the short poll only rides out the store's own latency.
    const vectorOf = async (collection, id) => {
      let vector = null;
      await holdsWithin(async () => {
        const doc = await door.mongo.col(`${EMBED_SPACE}_${collection}`).findOne({ _id: id });
        vector = Array.isArray(doc?.embedding) && doc.embedding.length === DIMS ? doc.embedding : null;
        return vector;
      }, 3_000, 10, { what: `the vector of ${collection} ${id}` });
      return vector;
    };
    const collectionOf = { 'entity.create': 'entities', 'fact.create': 'facts', 'edge.create': 'edges', 'chrono.create': 'chrono' };
    for (const s of creates) {
      for (const which of DOORS) {
        // The embedding space: its own ends for an edge, so the write embeds a record of its own.
        const fx = await FIXTURES[s.op]();
        if (s.op === 'edge.create') {
          const mk = async (n) => (await http_('POST', `/api/brain/spaces/${EMBED_SPACE}/entities`, { name: uniq(n), type: 'thing' })).body._id;
          fx.payload = { ...fx.payload, from: await mk('from'), to: await mk('to') };
        }
        const a = await ask(which, requestOf(fx, { space: EMBED_SPACE, extra: { waitForEmbedding: true } }));
        const id = which === 'rest' ? a.data?._id : (a.data?._id ?? a.data?.id);
        if (a.refused || !id) { failures.push(`${s.op} ${which}: waitForEmbedding was ${a.refused ? `refused ${a.status}` : 'answered without an id'}: ${a.error.slice(0, 160)}`); continue; }
        if (!await vectorOf(collectionOf[s.op], id)) failures.push(`${s.op} ${which}: no vector was stored although waitForEmbedding was asked`);
      }
    }
    assert.deepEqual(failures, [], 'the option REST has always read is declared by the MCP tool too, so it is neither refused nor ignored there');
  });
});
