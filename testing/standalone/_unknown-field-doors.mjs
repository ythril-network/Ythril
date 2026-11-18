/**
 * The three doors, the fixtures and the readings the unknown-field cases share (bundle-128 design-v3 section 8.1; bundle-348 split them in two files).
 *
 * ## Why a module
 *
 * `an-unknown-field-is-answered-alike-on-both-doors-db.test.js` (cases (a) to (h)) and its `-part-2-` twin (cases (i) to (p)) ask the same question of the
 * same three doors: REST over loopback, MCP `callTool`, and `POST /api/<tool>`. As one file it was among the slowest of its shard's, and a file that is
 * cut in two runs in about the time of its longer half when its shard runs files side by side. Both need one derivation of the subjects, one table of requests, one way to ask a door and one way
 * to read what a write stored, so those live here and a case that changed them is changed for both files at once. The split is by case letter (a to h in
 * the first, i to p in the second) and `the-unknown-field-cases-are-held-by-two-files-once-each` holds that between them they declare every case once.
 *
 * ## What it prevents
 *
 * - **A snapshot that reads nothing.** `snapshot()` is the space's record collections in one round trip (`snapshotSpaceInOneRead`), which starts from the
 *   space's counter row: with no row it answers empty arrays however many records the space holds, and "a refused write changed nothing" would then pass
 *   about nothing. The row is primed when the doors open and the snapshot refuses to answer without it.
 * - **A case that reads the last case's records.** `cleanSpace()` is the door's own wipe (it drains the writes still running first, then empties the
 *   space's record collections and counter row) and re-primes the counter row, so every case starts on a space no earlier case wrote to, and a snapshot
 *   covers only what the case itself stored.
 * - **A subject set that is empty.** `assertSubjectSet()` is read by every case (`judged()`), so a derivation that finds no route fails each case by name.
 *
 * It declares no test: a test is declared in the file that runs it (`a-test-is-declared-where-it-runs`).
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { snapshotSpaceInOneRead } from './_space-snapshot.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

export const skip = await mongoSkipReason();
// A limiter answers 429 to a caller past its quota before the write is reached; it is not what these cases ask about.
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

// The one space that embeds (case (p)) reaches a stub endpoint, so no model is fetched. Set before any server module loads.
export const DIMS = 8;
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
export const UNKNOWN = 'unrecognisedThing';
export const UNKNOWN_VALUE = 7;
export const S = 'pspace';
export const SCHEMA_SPACE = 'pschema';
export const EMBED_SPACE = 'pembed';
export const IGNORED = 'unknown field — ignored';
export const NOT_ACCEPTED = 'unknown field — not accepted';
export const RECORD_COLLECTIONS = ['entities', 'facts', 'edges', 'chrono', 'links', 'files'];
export const WIDE = Array.from({ length: 21 }, (_, i) => `p${String(i).padStart(2, '0')}`);

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

/** What the open doors hold: set by `openUnknownFieldDoors`, read through these live bindings by the test files. */
export let door, app, base, adminKey, callTool, ADMIN, getConfig, TOOLS_BY_NAME, toolSchemas, RETIRED, NAME_QUOTED, REFUSAL_NAMES_MAX, peerText;
export const SUBJECTS = [];
export const cutOnce = (name) => peerText(name, { max: NAME_QUOTED });
let counter = 0;
export const uniq = (label) => `${label} ${process.pid}-${++counter}`;
export const fmt = (x) => JSON.stringify(x)?.slice(0, 240);
/**
 * A structured answer as the doors are compared: the REST app adds `retryable` to every error body (`statesRetryability`),
 * which the MCP structured answer does not carry. It says nothing about the unknown field, so it is not compared.
 */
export const comparable = (data) => (data && typeof data === 'object' && !Array.isArray(data)
  ? Object.fromEntries(Object.entries(data).filter(([k]) => k !== 'retryable')) : data);

/**
 * Open the three doors on the harness database `suite` (one per test file: the harness names are unique) and derive the subjects. The file's `before`.
 *
 * @param {string} suite  the harness database slug of the calling file
 */
export async function openUnknownFieldDoors(suite) {
  door = await openPushDoor({
    suite,
    spaces: [
      { id: S, label: S, folders: [], meta: { suppressEmbeddings: true } },
      { id: SCHEMA_SPACE, label: SCHEMA_SPACE, folders: [], meta: { suppressEmbeddings: true, validationMode: 'warn', typeSchemas: { entity: { wide: { propertySchemas: Object.fromEntries(WIDE.map(k => [k, { type: 'number' }])) } } } } },
      { id: EMBED_SPACE, label: EMBED_SPACE, folders: [], meta: {} },
    ],
  });
  ({ getConfig } = await import('../../server/dist/config/loader.js'));
  ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
  ({ TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js'));
  ({ RETIRED_WRITE_FIELDS: RETIRED } = await import('../../server/dist/brain/retired-write-fields.js'));
  ({ NAME_QUOTED, REFUSAL_NAMES_MAX, peerText } = await import('../../server/dist/util/log.js'));
  const { toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');
  toolSchemas = toolSchemasFor([S, SCHEMA_SPACE, EMBED_SPACE]);
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  const tokens = await import('../../server/dist/auth/tokens.js');
  adminKey = (await tokens.createToken({ name: 'b128-parity', admin: true })).plaintext;
  app = await listenApp();
  base = app.url;
  await primeCounter();

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
}

/** The file's `after`: every door and the stub closed, whatever the cases did. */
export async function closeUnknownFieldDoors() {
  await app?.close();
  await door?.close();
  await stub?.close();
}

/** The space's counter row exists, as `snapshot()` needs (see the docblock): a row at 0 is what a space that has not been written to yet holds. */
const primeCounter = () => door.setCounter(S, 0);

/**
 * Every case starts on `S` as no earlier case left it: the door's wipe (the writes still running are drained first), then the counter row again.
 * The file's `beforeEach`. The other spaces are not wiped: only `S` is read as a whole, and the cases that write elsewhere read by id.
 */
export async function cleanSpace() {
  await door.wipe(S);
  await primeCounter();
}

// ── doors ────────────────────────────────────────────────────────────────────────────────────────────────────────────

export async function http_(method, url, body) {
  const init = { method, headers: { Authorization: `Bearer ${adminKey}` }, signal: AbortSignal.timeout(60_000) };
  if (body !== undefined) { init.headers['Content-Type'] = 'application/json'; init.body = typeof body === 'string' ? body : JSON.stringify(body); }
  const r = await fetch(`${base}${url}`, init);
  const text = await r.text();
  let json = null; try { json = JSON.parse(text); } catch { /* not JSON */ }
  return { status: r.status, body: json, text };
}

export async function mcpCall(name, args) {
  const out = await callTool({ name, args, caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  return { status: out.status, isError: out.result.isError === true, text: (out.result.content ?? []).map(c => c.text ?? '').join('\n'), sc: out.result.structuredContent };
}

/** One answer, normalised: the same four things whichever door gave it. `data` is the structured body (the tool door's `data`). */
export async function ask(which, req) {
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
export const DOORS = ['rest', 'mcp', 'tool'];

/** The rows of an answer that are about unknown fields (by their code, or — on the base, which has none — by their wording). */
export const unknownRows = (data) => (Array.isArray(data?.warnings) ? data.warnings : [])
  .filter(r => r && (r.code === 'unknown_field' || (typeof r.reason === 'string' && r.reason.startsWith('unknown field'))));

// ── what is stored ───────────────────────────────────────────────────────────────────────────────────────────────────

/**
 * Every record of every record collection of the space, whole, in `_id` order: "nothing was stored" is an identity check. One round trip for all of the
 * collections, from the space's counter row, which the answer must hold (an absent row would read as an empty space whatever it stored).
 */
export async function snapshot(space = S) {
  const read = await snapshotSpaceInOneRead(door.mongo, space, RECORD_COLLECTIONS);
  assert.equal(read.counter.length, 1, `space ${space} has no counter row, so a one-read snapshot of it reads nothing whatever it holds — prime it (primeCounter)`);
  return JSON.stringify(Object.fromEntries(Object.entries(read).filter(([part]) => part !== 'counter')));
}

export function setMode(space, mode) {
  const sp = getConfig().spaces.find(s => s.id === space);
  assert.ok(sp, `space ${space} is not in the config`);
  if (mode === 'refuse') sp.unknownWriteFields = 'refuse'; else delete sp.unknownWriteFields;
}

// ── seeds: records the doors under test write to, made through the app with nothing unknown in them ───────────────────

export async function seed(kind) {
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
export const FIXTURES = {
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
export function requestOf(fx, { space = S, extra = {}, payload = fx.payload, addr = {}, targetRest, targetMcp } = {}) {
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
export function acceptedOf(fx) {
  const schema = TOOLS_BY_NAME.get(fx.tool).inputSchema(toolSchemas);
  const addressing = new Set(['space', ...Object.keys(fx.addr)]);
  return Object.keys(schema.properties).filter(k => !addressing.has(k));
}

/**
 * One fresh fixture per door, made at once: each seeds records of its own through the app, none reads another's, and the stored documents are read only
 * after all three exist, so the order they are made in is not something a case can see. The doors themselves are asked one after another (`threeDoors`).
 */
export const freshFixtures = (op) => Promise.all(DOORS.map(() => FIXTURES[op]()));

/** Three fresh fixtures, then the three doors in turn with the stored documents read before, between and after (A, B, A, ...). */
export async function threeDoors(subject, opts = {}) {
  const fxs = await freshFixtures(subject.op);
  const snaps = [await snapshot()];
  const answers = {};
  for (const [i, which] of DOORS.entries()) {
    answers[which] = await ask(which, requestOf(fxs[i], typeof opts === 'function' ? opts(fxs[i]) : opts));
    snaps.push(await snapshot());
  }
  return { fxs, answers, snaps };
}

/** Every problem with how a set of rows reads, as strings. `outcome` is 'stored' or 'refused'. */
export function rowProblems(rows, { outcome, names }) {
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
export function assertSubjectSet() {
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
export const judged = () => assertSubjectSet();
export const withKey = (...pairs) => Object.fromEntries(pairs);
