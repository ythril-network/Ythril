/**
 * Integration: a space's RDF export imports back, on a LIVE instance, through the import's real doors (bundle-270, Q-753 last line).
 *
 * ## What it proves, and what no other test does
 *
 * Every test of the import so far drives a module or one act in its own database. This one sends the export's real output, in each of the
 * four formats and both edge forms, through `POST /api/brain/spaces/:id/import/rdf` and MCP `import_rdf` of a running instance, and compares
 * what landed with what was written through the ordinary doors.
 *
 * - INTO AN EMPTY STRICT SPACE with the same schema (set through the JSON schema door), the import completes and every record comes back
 *   with a fresh id: under the id map (the import's report gives none, so it is built from a unique name per record) the entities, facts,
 *   chrono entries, edges and link rows are equal in the fields a round trip promises. Created, modified, author and stamp are asserted to
 *   be the target's own, never skipped.
 * - INTO THE SOURCE SPACE ITSELF every subject is under the space's own base, so the import converges and changes nothing: no record's
 *   version (`seq`), modified time or stamp, no record or link count.
 * - THE SAME FILE TWICE into the empty target: the guide's rule is that a subject that is not under the target's own base is a NEW record
 *   with a minted id, so a second import makes every record twice (and says so by its own counts).
 * - THE MCP TOOL with the document inline lands the same records as the REST route.
 *
 * ## The forgettable parts
 *
 * - The compared fields are the literal lists below (the plan's section 6 promises), never imported from the product.
 * - An equality over two empty lists passes: every comparison is guarded by the count the fixture wrote (a literal), and by the fixture's
 *   own read-back before any export.
 * - The import answers 202 with an `importId` for a long run: the test waits on the status door under a bound, never a fixed sleep.
 * - Every space the test makes is removed in `after`, also when a case fails.
 * - One source space is shared by every case, so the file stays under the project's per-file budget of 60 s.
 *
 * Three groups of cases were red as product findings (fact link rows, the data-graph default of `sourceBase`, a re-import that leaves versions
 * alone); their causes are fixed (bundle-270, fix round 4, R1 to R3) and the cases stand as they were written.
 *
 * What it needs up: the integration stack (`npm run test:up`), with instance A built from this checkout.
 *
 * Run: node --test testing/integration/an-rdf-export-imports-back-into-an-empty-strict-space.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, put, patch, get, delWithBody, readCollection, waitFor } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SOURCE = `rdf-imp-src-${RUN}`;
const baseOf = (space) => `https://${space}.example.org/ld/${space}/`;
const SOURCE_BASE = baseOf(SOURCE);
const MEDIA = { turtle: 'text/turtle', trig: 'application/trig', nquads: 'application/n-quads', jsonld: 'application/ld+json' };
/** The documents under test: the format, the edge form the export is asked for, and the name the case answers to. */
const DOCUMENTS = [
  { key: 'turtle', format: 'turtle', edgeDetails: 'rdf12' },
  { key: 'turtle-reification', format: 'turtle', edgeDetails: 'reification' },
  { key: 'trig', format: 'trig', edgeDetails: 'rdf12' },
  { key: 'nquads', format: 'nquads', edgeDetails: 'rdf12' },
  { key: 'jsonld', format: 'jsonld', edgeDetails: 'reification' },
];

/** What the fixture writes, as literal counts: the guard that makes an equality over two empty lists fail. */
const EXPECTED = Object.freeze({ entity: 5, fact: 2, chrono: 2, edge: 6, link: 6 });

/**
 * The fields a round trip promises per kind (plan section 6, first bullet), written out here: kinds, types, names, texts, titles, properties,
 * tags, descriptions, chrono fields, edges with their details. The ends of an edge and the rows of a link are compared under the id map.
 */
const PROMISED = Object.freeze({
  entity: ['name', 'type', 'description', 'tags', 'properties'],
  fact: ['fact', 'type', 'description', 'tags', 'properties'],
  chrono: ['title', 'type', 'startsAt', 'endsAt', 'status', 'confidence', 'recurrence', 'description', 'tags', 'properties'],
  edge: ['label', 'type', 'weight', 'description', 'tags', 'properties'],
});
const COLLECTION = { entity: 'entities', fact: 'facts', chrono: 'chrono', edge: 'edges', link: 'links' };

/** A fact's text that needs escaping in Turtle and in JSON, plain and with no language: quotes, backslashes, line ends, tab, markup, syntax, non-ASCII. */
const NASTY = 'He said "hello"\nsecond line \\ back\\slash <b>&amp;</b> tab\there crlf\r\nend üñï 日本語 \u{1F600} """triple""" \'single\' @en "x"^^<http://x/y> # not a comment { } ] [ \\u0041 not an A';

let token;
let mcp;
const made = [];
/** The ids and the names the fixture was written under, by kind. */
const ids = {};
const exportsOf = {};
let sourceSnapshot;

const url = (space, rest) => `${INSTANCES.a}/api/brain/spaces/${space}${rest}`;

async function createStrictSpace(id, label) {
  const sp = await post(INSTANCES.a, token, '/api/spaces', { id, label });
  assert.equal(sp.status, 201, `create space ${id}: ${JSON.stringify(sp.body)}`);
  made.push(id);
  const on = await patch(INSTANCES.a, token, `/api/spaces/${id}`, { meta: { rdf: { enabled: true, base: baseOf(id) } } });
  assert.ok(on.status < 300, `switch RDF on for ${id}: ${on.status} ${JSON.stringify(on.body)}`);
  // The schema, through the JSON schema door (the whole map, schema admin): the same in the source and in every target.
  const schema = await put(INSTANCES.a, token, `/api/spaces/${id}/schema`, { typeSchemas: {
    entity: {
      Person: { propertySchemas: { age: { type: 'number', minimum: 0 }, active: { type: 'boolean' }, born: { type: 'date' }, nick: { type: 'string' } } },
      Org: { propertySchemas: { size: { type: 'number' }, note: { type: 'string' } } },
    },
    fact: { note: { propertySchemas: { source: { type: 'string' }, weight: { type: 'number' }, verified: { type: 'boolean' } } } },
    edge: {
      knows: { propertySchemas: { since: { type: 'date' }, closeness: { type: 'number' } } },
      mentor_of: { functional: true },
      mentions: {},
      about: {},
    },
  } });
  assert.equal(schema.status, 200, `schema of ${id}: ${JSON.stringify(schema.body)}`);
  const meta = await get(INSTANCES.a, token, `/api/spaces/${id}/meta`);
  assert.equal(meta.status, 200, JSON.stringify(meta.body));
  assert.equal(meta.body?.validationMode, 'strict', `${id} is a strict space`);
  return id;
}

/** The targets, made together before the cases (a space takes about two seconds to make): one per case that lands a file, empty until it does. */
const TARGETS = ['turtle', 'turtle-reification', 'trig', 'nquads', 'jsonld', 'gzip', 'dry', 'twice', 'mcp'];
const targetIds = {};

/** The target of a case, asserted empty of every record kind and link as the case begins. */
async function emptyTarget(label) {
  const id = targetIds[label];
  assert.ok(id, `a target was made for ${label}`);
  const snap = await snapshot(id);
  for (const kind of Object.keys(EXPECTED)) assert.equal(snap[kind].length, 0, `${id} starts empty of ${kind}`);
  return id;
}

/** Every record of a space by kind, read through the ordinary read door. */
async function snapshot(space) {
  const snap = {};
  for (const [kind, collection] of Object.entries(COLLECTION)) {
    const r = await readCollection(INSTANCES.a, token, space, collection, { limit: 500 });
    assert.equal(r.status, 200, `read ${collection} of ${space}: ${JSON.stringify(r.body)}`);
    assert.ok(r.results.length < 500, `${collection} of ${space} fits one page`);
    snap[kind] = r.results;
  }
  return snap;
}

/** The text a record is known by, unique in the fixture. */
const labelOf = (kind, d) => (kind === 'entity' ? d.name : kind === 'fact' ? d.fact : d.title);
const endKind = (k) => k ?? 'entity';
/** `kind:id` to `kind:label`. */
function labels(snap) {
  const m = new Map();
  for (const kind of ['entity', 'fact', 'chrono']) for (const d of snap[kind]) m.set(`${kind}:${d._id}`, `${kind}:${labelOf(kind, d)}`);
  return m;
}
/** The key of an edge or a link as the labels of its ends say it. */
const edgeKey = (d, m) => `${m.get(`${endKind(d.fromKind)}:${d.from}`)} -${d.label}-> ${m.get(`${endKind(d.toKind)}:${d.to}`)}`;
const linkKey = (d, m) => `${m.get(`${endKind(d.fromKind)}:${d.from}`)} => ${m.get(`${endKind(d.toKind)}:${d.to}`)}`;

/** A value as the promised comparison reads it: an absent tag list, property bag or text is one thing. */
function normal(field, value) {
  if (field === 'tags') return [...new Set(value ?? [])].sort();
  if (field === 'properties') return value ?? {};
  if (field === 'description') return value ?? null;
  return value ?? null;
}
const promised = (kind, d) => Object.fromEntries(PROMISED[kind].map(f => [f, normal(f, d[f])]));

/**
 * `target` holds what `source` held, `times` times over: every record by its label equal in the promised fields, an edge by its ends, and
 * nothing else (the link rows are `assertLinksComeBack`'s). The id map is the label.
 */
function assertHoldsWhatSourceHeld(source, target, times = 1) {
  for (const [kind, n] of Object.entries(EXPECTED)) {
    assert.equal(source[kind].length, n, `the source holds ${n} ${kind} (the fixture's own count)`);
    if (kind !== 'link') assert.equal(target[kind].length, n * times, `the target holds ${n * times} ${kind}`);
  }
  const sm = labels(source);
  const tm = labels(target);
  const sourceIds = new Set(Object.values(source).flat().map(d => d._id));
  for (const kind of ['entity', 'fact', 'chrono']) {
    for (const s of source[kind]) {
      const found = target[kind].filter(t => labelOf(kind, t) === labelOf(kind, s));
      assert.equal(found.length, times, `${kind} ${JSON.stringify(labelOf(kind, s).slice(0, 40))} is in the target ${times} time(s)`);
      for (const t of found) {
        assert.deepEqual(promised(kind, t), promised(kind, s), `${kind} ${JSON.stringify(labelOf(kind, s).slice(0, 40))} is equal in the promised fields`);
        assertTheTargetsOwn(s, t, sourceIds);
      }
    }
  }
  const tEdges = target.edge.map(d => ({ key: edgeKey(d, tm), d }));
  for (const s of source.edge) {
    const key = edgeKey(s, sm);
    assert.ok(!key.includes('undefined'), `the source edge's ends are named: ${key}`);
    const found = tEdges.filter(e => e.key === key);
    assert.equal(found.length, times, `edge ${key} is in the target ${times} time(s)`);
    for (const e of found) {
      assert.deepEqual(promised('edge', e.d), promised('edge', s), `edge ${key} is equal in the promised fields`);
      assert.equal(endKind(e.d.fromKind), endKind(s.fromKind), `edge ${key}: the kind of its start`);
      assert.equal(endKind(e.d.toKind), endKind(s.toKind), `edge ${key}: the kind of its end`);
      assertTheTargetsOwn(s, e.d, sourceIds);
    }
  }
}

/** The link rows of `target` are those of `source`, `times` times over, by the labels of their ends. */
function assertLinksComeBack(source, target, times = 1) {
  const sm = labels(source);
  const tm = labels(target);
  const tLinks = target.link.map(d => linkKey(d, tm));
  const sLinks = source.link.map(d => linkKey(d, sm));
  assert.deepEqual([...new Set(tLinks)].sort(), [...new Set(sLinks)].sort(), `the link rows of the target are the source's (each ${times} time(s))`);
  assert.equal(target.link.length, EXPECTED.link * times, `the target holds ${EXPECTED.link * times} link rows`);
  for (const s of source.link) {
    const key = linkKey(s, sm);
    assert.ok(!key.includes('undefined'), `the source link's ends are named: ${key}`);
    assert.equal(tLinks.filter(k => k === key).length, times, `link ${key} is in the target ${times} time(s)`);
  }
}

/** The fields the instance owns are the target's: a new id, a later creation, the same instance as author, and a stamp. */
function assertTheTargetsOwn(s, t, sourceIds) {
  assert.ok(t._id && !sourceIds.has(t._id), `the record has an id of its own (${t._id}), not the source's`);
  assert.ok(Date.parse(t.createdAt) > Date.parse(s.createdAt), `created is the target's own (${t.createdAt} is after the source's ${s.createdAt})`);
  assert.ok(Date.parse(t.updatedAt) > Date.parse(s.updatedAt), `modified is the target's own (${t.updatedAt} is after the source's ${s.updatedAt})`);
  assert.ok(t.author?.instanceId, 'the author is named');
  assert.equal(t.author.instanceId, s.author.instanceId, 'the author is this instance, as for the source (the same instance wrote both)');
  assert.ok(Number.isInteger(t.seq) && t.seq > 0, `the record has a version of its own (seq ${t.seq})`);
  assert.equal(typeof t.schemaFingerprint, 'string', 'the target stamps the record with its schema');
  assert.equal(t.schemaFingerprint, s.schemaFingerprint, 'the stamp is the target\'s schema\'s, which is the source\'s schema');
}

/** The status door until the import ends, with a bound. */
async function waitForEnd(space, importId, door) {
  let last;
  await waitFor(async () => {
    last = door === 'mcp'
      ? (await mcp.callTool('import_rdf_status', { space, importId })).structuredContent
      : (await get(INSTANCES.a, token, `/api/brain/spaces/${space}/import/rdf/${importId}`)).body;
    return last?.status && last.status !== 'running';
  }, 90_000, 250, () => `import ${importId} still running: ${JSON.stringify(last)}`, { thinMargin: false });
  return last;
}

/** One import through the REST route: the answer's status, its report and what the status door says of the same import. */
async function importRest(space, { text, format, gzip = false, query = {} }) {
  const params = new URLSearchParams({ format, ...query });
  const body = gzip ? zlib.gzipSync(Buffer.from(text, 'utf8')) : text;
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': MEDIA[format], ...(gzip ? { 'Content-Encoding': 'gzip' } : {}) };
  let r;
  // One RDF import body runs at a time on the instance: another file's import in the same stack is waited for.
  await waitFor(async () => {
    const res = await fetch(url(space, `/import/rdf?${params}`), { method: 'POST', headers, body });
    r = { http: res.status, body: await res.json().catch(() => null) };
    return !(r.http === 409 && r.body?.code === 'rdf_import_busy');
  }, 30_000, 500, () => `another import held the door: ${JSON.stringify(r)}`, { thinMargin: false });
  const rep = r.body?.report;
  assert.ok(r.http === 200 || r.http === 202,
    `import into ${space}: ${r.http} ${r.body?.code} ${JSON.stringify({ byCode: rep?.reasonsByCode, reasons: rep?.reasons?.slice(0, 2), error: r.body?.error }).slice(0, 2500)}`);
  const ended = r.http === 202 ? await waitForEnd(space, r.body.importId, 'rest') : r.body;
  if (query.dryRun === 'true') return ended; // a dry run registers no act, so the status door holds nothing of it
  const status = await get(INSTANCES.a, token, `/api/brain/spaces/${space}/import/rdf/${ended.importId}`);
  assert.equal(status.status, 200, JSON.stringify(status.body));
  assert.equal(status.body.status, ended.status, 'the status door says what the answer said');
  assert.deepEqual(status.body.kinds, ended.kinds, 'the status door counts what the answer counted');
  return ended;
}

const exportOf = async (space, format, edgeDetails) => {
  const r = await fetch(url(space, `/export/rdf?format=${format}&edgeDetails=${edgeDetails}`), { headers: { Authorization: `Bearer ${token}` } });
  const text = await r.text();
  assert.equal(r.status, 200, `export ${format}: ${text.slice(0, 300)}`);
  return text;
};

const assertCompleted = (report, what) => {
  assert.equal(report.status, 'completed', `${what}: ${JSON.stringify({ status: report.status, error: report.error, reasons: report.reasons?.slice(0, 5), reasonsByCode: report.reasonsByCode })}`);
  assert.equal(report.dryRun, false);
  assert.equal(report.reasonCount, 0, `${what}: no reason`);
};

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token, INSTANCES.a, 90_000);
  await Promise.all([
    createStrictSpace(SOURCE, `RDF import source ${RUN}`),
    ...TARGETS.map(async (label) => {
      const id = `rdf-imp-${label}-${RUN}`.slice(0, 60);
      await createStrictSpace(id, `RDF import target ${label} ${RUN}`);
      targetIds[label] = id;
    }),
  ]);
  const P = async (rest, body) => {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${SOURCE}${rest}`, body);
    assert.ok(r.status < 300 && r.body?._id, `${rest}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body._id;
  };
  const ent = (name, type, extra) => P('/entities', { name: `${name} ${RUN}`, type, ...extra });
  ids.ada = await ent('Ada', 'Person', { tags: ['math', 'pioneer'], description: 'First programmer', properties: { age: 36, active: true, born: '1815-12-10', nick: 'Enchantress of Number' } });
  ids.charles = await ent('Charles', 'Person', { tags: ['engine'], properties: { age: 79, active: false, born: '1791-12-26' } });
  ids.mary = await ent('Mary "Grace"', 'Person', { description: 'line1\nline2 "q" \\ <i>', properties: { age: 52.5 } });
  ids.engines = await ent('Analytical Engines Ltd', 'Org', { tags: ['org'], description: 'A company', properties: { size: 12, note: 'quote "q" and \\ backslash' } });
  ids.works = await ent('Babbage Works', 'Org', { properties: { size: 0 } });
  ids.f1 = await P('/facts', { fact: `${NASTY} ${RUN}`, type: 'note', tags: ['ledger', 'x"y'], description: 'with a description\nover two lines', properties: { source: 'ledger', weight: 0.95, verified: true }, linkEntities: [ids.ada, ids.charles] });
  ids.f2 = await P('/facts', { fact: `Second fact ${RUN}`, type: 'note', linkEntities: [ids.engines] });
  ids.c1 = await P('/chrono', {
    title: `Lecture ${RUN}`, type: 'event', startsAt: '2026-06-01T09:00:00Z', endsAt: '2026-06-01T10:30:00Z', status: 'active', confidence: 0.8,
    tags: ['talk'], description: 'A lecture', properties: { room: 'A1', seats: 40 }, recurrence: { freq: 'weekly', interval: 2, until: '2027-06-01T00:00:00Z' },
    linkEntities: [ids.ada], linkFacts: [ids.f1],
  });
  ids.c2 = await P('/chrono', { title: `Launch ${RUN}`, type: 'milestone', startsAt: '2026-09-15T00:00:00Z', status: 'upcoming', linkEntities: [ids.engines] });
  const E = (body) => P('/edges', body);
  await E({ from: ids.ada, to: ids.charles, label: 'knows', weight: 0.7, type: 'friend', description: 'met in 1833', tags: ['social'], properties: { since: '1833-01-01', closeness: 4 } });
  await E({ from: ids.ada, to: ids.mary, label: 'knows' });
  await E({ from: ids.charles, to: ids.ada, label: 'mentor_of' });
  await E({ from: ids.mary, to: ids.charles, label: 'mentor_of', weight: 1 });
  await E({ from: ids.f1, fromKind: 'fact', to: ids.engines, toKind: 'entity', label: 'mentions', weight: 0.25 });
  await E({ from: ids.c1, fromKind: 'chrono', to: ids.f2, toKind: 'fact', label: 'about', tags: ['t'] });

  sourceSnapshot = await snapshot(SOURCE);
  for (const [kind, n] of Object.entries(EXPECTED)) assert.equal(sourceSnapshot[kind].length, n, `the fixture wrote ${n} ${kind}, read back through the ordinary door`);
  for (const d of DOCUMENTS) {
    exportsOf[d.key] = await exportOf(SOURCE, d.format, d.edgeDetails);
    assert.ok(exportsOf[d.key].includes(`${SOURCE_BASE}entity/${ids.ada}`), `${d.key}: the export names the first entity`);
  }
});

after(async () => {
  for (const id of made) {
    await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  }
});

/** The records of each empty target an import landed in, by the case's name (the link cases read them). */
const landed = {};
const KINDS_INSERTED = { fact: 2, entity: 5, chrono: 2, edge: 6 };
const insertedOf = (report) => Object.fromEntries(Object.entries(report.kinds).map(([k, v]) => [k, v.inserted]));
const convergedOf = (report) => Object.fromEntries(Object.entries(report.kinds).map(([k, v]) => [k, v.converged]));
const NOTHING = { fact: 0, entity: 0, chrono: 0, edge: 0 };

describe('an RDF export imports back into an empty strict space', () => {
  for (const d of DOCUMENTS) {
    it(`${d.key}: the import completes and every record comes back equal under the id map`, async () => {
      const target = await emptyTarget(d.key);
      const report = await importRest(target, { text: exportsOf[d.key], format: d.format, query: { sourceBase: SOURCE_BASE } });
      assertCompleted(report, d.key);
      assert.deepEqual(insertedOf(report), KINDS_INSERTED, `${d.key}: the records inserted per kind`);
      assert.deepEqual(convergedOf(report), NOTHING, `${d.key}: nothing converged in an empty space`);
      landed[d.key] = target;
      assertHoldsWhatSourceHeld(sourceSnapshot, await snapshot(target));
    });
  }

  it('a gzipped TriG body lands the same records as the plain one', async () => {
    const target = await emptyTarget('gzip');
    const report = await importRest(target, { text: exportsOf.trig, format: 'trig', gzip: true, query: { sourceBase: SOURCE_BASE } });
    assertCompleted(report, 'gzip');
    assert.deepEqual(insertedOf(report), KINDS_INSERTED);
    landed.gzip = target;
    assertHoldsWhatSourceHeld(sourceSnapshot, await snapshot(target));
  });

  // The export states all six link rows and the import brings each back, in every format (it once lost the three that start at a fact: the
  // import wrote facts before the entities they link, and a link row to an entity not yet stored is taken back).
  it('the export states every link row, and the import brings each back in every format', async () => {
    assert.equal((exportsOf.nquads.match(/<http:\/\/purl\.org\/dc\/terms\/references>/g) ?? []).length, EXPECTED.link, 'the export states one dcterms:references per link row');
    for (const key of [...DOCUMENTS.map(d => d.key), 'gzip']) {
      assert.ok(landed[key], `${key}: a target was landed by the case above`);
      assertLinksComeBack(sourceSnapshot, await snapshot(landed[key]));
    }
  });
});

describe('a dry run into an empty target', () => {
  const assertNothingLanded = async (target, what) => {
    const snap = await snapshot(target);
    for (const kind of Object.keys(EXPECTED)) assert.equal(snap[kind].length, 0, `${what} left no ${kind}`);
  };

  it('counts what would land and writes nothing', async () => {
    const target = await emptyTarget('dry');
    const dry = await importRest(target, { text: exportsOf.turtle, format: 'turtle', query: { dryRun: 'true', sourceBase: SOURCE_BASE } });
    assert.equal(dry.status, 'dry-run');
    assert.deepEqual(insertedOf(dry), KINDS_INSERTED, 'a dry run counts what would land');
    await assertNothingLanded(target, 'a dry run');
  });

  // Guide 06f ("What becomes of a subject" and the parameters table): TriG, N-Quads and JSON-LD "default to the file's one data graph", so an
  // export of another space needs no sourceBase. A dry run shows it without landing anything.
  for (const d of DOCUMENTS.filter(x => x.format !== 'turtle')) {
    it(`${d.key}: with no sourceBase the file's one data graph is the source, as the guide says`, async () => {
      const target = await emptyTarget('dry');
      const dry = await importRest(target, { text: exportsOf[d.key], format: d.format, query: { dryRun: 'true' } });
      assert.equal(dry.status, 'dry-run');
      assert.deepEqual(insertedOf(dry), KINDS_INSERTED, `${d.key}: what would land`);
      await assertNothingLanded(target, `${d.key} dry run`);
    });
  }
});

// The ticket says a re-import into the source space changes nothing: the import converges every record onto itself and writes none (a record's
// version, `seq`, and `updatedAt` stay as they were).
describe('an RDF export imported into its own source space changes nothing', () => {
  for (const d of DOCUMENTS) {
    it(`${d.key}: every record keeps its version, modified time and stamp, and no record or link is added`, async () => {
      const was0 = await snapshot(SOURCE);
      assert.deepEqual(Object.fromEntries(Object.entries(was0).map(([k, v]) => [k, v.length])), EXPECTED, 'the source space is as written');
      const report = await importRest(SOURCE, { text: exportsOf[d.key], format: d.format });
      assertCompleted(report, `${d.key} into the source`);
      assert.deepEqual(insertedOf(report), NOTHING, `${d.key}: nothing is inserted into the space it came from`);
      assert.deepEqual(convergedOf(report), KINDS_INSERTED, `${d.key}: every record converges onto itself`);
      const now0 = await snapshot(SOURCE);
      const changed = [];
      for (const kind of Object.keys(EXPECTED)) {
        assert.equal(now0[kind].length, EXPECTED[kind], `${d.key}: the ${kind} count is what it was`);
        const was = new Map(was0[kind].map(x => [x._id, x]));
        const now = new Map(now0[kind].map(x => [x._id, x]));
        assert.deepEqual([...now.keys()].sort(), [...was.keys()].sort(), `${d.key}: the ${kind} are the same records`);
        for (const [id, x] of now) {
          const w = was.get(id);
          if (kind === 'link') continue;
          assert.deepEqual(promised(kind, x), promised(kind, w), `${d.key}: ${kind} ${id} keeps its fields`);
          for (const f of ['seq', 'updatedAt', 'createdAt', 'schemaFingerprint']) {
            if (x[f] !== w[f]) changed.push(`${kind} ${JSON.stringify(labelOf(kind, x) ?? id).slice(0, 30)} ${f}: ${w[f]} -> ${x[f]}`);
          }
        }
      }
      assert.deepEqual(changed, [], `${d.key}: no record's version, modified time or stamp changed`);
    });
  }
});

describe('the same file imported twice into one empty target', () => {
  it('makes every record twice: a subject under another space\'s base is a new record each time, as the guide says', async () => {
    const target = await emptyTarget('twice');
    const first = await importRest(target, { text: exportsOf.turtle, format: 'turtle', query: { sourceBase: SOURCE_BASE } });
    assertCompleted(first, 'first import');
    assertHoldsWhatSourceHeld(sourceSnapshot, await snapshot(target));
    const second = await importRest(target, { text: exportsOf.turtle, format: 'turtle', query: { sourceBase: SOURCE_BASE } });
    assertCompleted(second, 'second import');
    assert.deepEqual(insertedOf(second), insertedOf(first), 'the second import inserts what the first did');
    assert.deepEqual(convergedOf(second), NOTHING, 'and converges nothing');
    const snap = await snapshot(target);
    assertHoldsWhatSourceHeld(sourceSnapshot, snap, 2);
    const every = Object.values(snap).flat();
    assert.equal(new Set(every.map(d => d._id)).size, every.length, 'no id is used twice');
  });
});

describe('the MCP tool imports the document inline', () => {
  it('N-Quads through import_rdf lands the same records as the REST route', async () => {
    assert.ok(landed.nquads, 'the REST route landed N-Quads in a target above');
    const target = await emptyTarget('mcp');
    const r = await mcp.callTool('import_rdf', { space: target, document: exportsOf.nquads, format: 'nquads', sourceBase: SOURCE_BASE });
    assert.ok(!r.isError, `import_rdf: ${JSON.stringify(r).slice(0, 600)}`);
    const answer = r.structuredContent;
    const report = answer.status === 'running' ? await waitForEnd(target, answer.importId, 'mcp') : answer;
    assertCompleted(report, 'mcp');
    assert.deepEqual(insertedOf(report), KINDS_INSERTED);
    const status = await mcp.callTool('import_rdf_status', { space: target, importId: report.importId });
    assert.equal(status.structuredContent?.status, 'completed', 'the status tool says completed');
    const [viaMcp, viaRest] = [await snapshot(target), await snapshot(landed.nquads)];
    assertHoldsWhatSourceHeld(sourceSnapshot, viaMcp);
    // Both doors' records equal each other in the promised fields too, by label.
    for (const kind of ['entity', 'fact', 'chrono']) {
      assert.equal(viaMcp[kind].length, EXPECTED[kind]);
      for (const s of viaRest[kind]) {
        const t = viaMcp[kind].find(x => labelOf(kind, x) === labelOf(kind, s));
        assert.ok(t, `${kind} ${JSON.stringify(labelOf(kind, s).slice(0, 40))} is landed by both doors`);
        assert.deepEqual(promised(kind, t), promised(kind, s));
      }
    }
  });
});

