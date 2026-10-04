/**
 * Red-team: a SEARCH never writes into the space it searches (`Q-92`).
 *
 * ## The defect
 *
 * A recall with `remainderDump: true`, or a traversal past the inline cap, wrote a JSON file under the
 * space's `_tmp/`, a `<space>_files` record, a seq bump — so the record synced to every peer — and an embed
 * job. All of it from a token holding knowledge READ. The owner, 2026-09-27: *"i somewhere read a search can
 * modify data? sounds like a huge bug and security issue to me!"*
 *
 * ## The rule these cases pin
 *
 * - Every search site — `recall` and `similar`, each with a graph past the old inline cap, a truncated
 *   `remainderDump`, and a truncated `remainderDump` under a traversal, on BOTH doors — leaves the space's file
 *   records, its seq counter and its embed queue exactly as they were. Asserted door by door over one table, so
 *   a door that still writes is a named failure rather than an average.
 * - Since Q-126 a graph is never spilled: the hub comes back WHOLE and nothing is written without
 *   `remainderDump` (owner, 2026-09-28, reversing the 2026-08-13 auto-spill). The remainder spill is delivered
 *   when asked: the response carries `spillId`, and the SAME token pages it through `GET /api/brain/spills/:id`
 *   and the MCP `read_spill` tool, identically, each row whole, across a storage-page boundary.
 * - Nobody else reads it. Another token with read on the space gets the same 404 as an id that never
 *   existed, on both doors; a token that lost read on one of the spill's member spaces gets that 404 too.
 * - The legacy `path` still resolves — through `read_file` and the files GET — for its issuer only.
 * - Deleting the space drops its spills.
 *
 * ## What is NOT here, and where it is
 *
 * The caps (a token's own oldest evicted → 410, the instance ceiling → `spillRefused`, one spill larger than
 * the share → refused with `nextSkip` intact) need `READ_SPILL_*` limits small enough to reach, and the test
 * compose file sets none — so they belong to the standalone slice, which owns its Mongo and its env. So does
 * "no token, no spill": every request that reaches this stack carries a token.
 *
 * Run: node --test --test-concurrency=1 testing/red-team-tests/a-search-never-writes-a-space.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, get, patch, waitForIndexed, waitForSimilarityIndex, waitForEmbedQueueEmpty } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';
import { spaceFootprint, spillRows } from '../_shared/space-footprint.mjs';
import { requireEmbedding } from '../_shared/embedding-required.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');
const A = INSTANCES.a;
const RUN = Date.now();
const S = `never-writes-${RUN}`;       // the searched space
const S2 = `never-writes-b-${RUN}`;    // a second member, for the lost-read case
const D = `never-writes-del-${RUN}`;   // deleted by its own case
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const HUB_QUERY = 'telemetry metrics aggregation collectors';
const VAULT_QUERY = 'vault credential rotation service';
/**
 * 120 leaves of ~2.6 KiB each: past the inline cap (topK 1, traverse 1 → 7 nodes) and inside the spill
 * ceiling (×20 → 140, measured: a 150-leaf hub came back `ceilingHit` at 140), so the spill holds all 120 —
 * and ~310 KiB of them, past one 256 KiB storage page, so paging it crosses a page boundary.
 */
const LEAVES = Array.from({ length: 120 }, (_, i) => `nw-leaf-${i}-${RUN}`);
const LEAF_TEXT = 'Quartz lantern orchard ledger, walnut ferry compass, amber loom harbour. '.repeat(36);

let admin;          // the stack's admin token
let reader;         // knowledge READ on S and S2 — the caller whose search must not write
let readerId;
let other;          // read on S too, and must still be refused another token's spill
let otherId;
let embeddingAvailable = false;
let hubId = null;   // the recall seed with 150 neighbours
let twinId = null;  // a second hub, whose nearest match is `hubId` — the `similar` seed
const vaultIds = [];

const json = (r) => r.body;
const mcpJson = (res) => {
  const text = res?.content?.[0]?.text ?? '';
  assert.notEqual(res?.isError, true, `the MCP call failed: ${text.slice(0, 300)}`);
  return JSON.parse(text);
};

async function mkSpace(id) {
  const r = await post(A, admin, '/api/spaces', { id, label: id });
  assert.equal(r.status, 201, `create ${id}: ${JSON.stringify(r.body)}`);
}

async function mkEntity(space, name, description) {
  const r = await post(A, admin, `/api/brain/spaces/${space}/entities`, {
    name, type: 'service', description, tags: [], properties: {},
  });
  return r.status === 201 ? (r.body._id ?? r.body.id) : null;
}

/**
 * The leaves and their edges through the SYNC door, in one batch: not embedded, so a leaf is reached
 * structurally and never ranks on its own. Readable ids are accepted here, which the write doors refuse.
 *
 * `suppressEmbeddings` because a sync ingest queues embedding on the RECEIVER: without it 150 two-KiB
 * leaves held the batch open past the five-minute fetch timeout, and an embedded leaf could outrank the hub.
 * The text is off-topic for the same second reason.
 */
async function syncLeaves(space, hubs) {
  const now = new Date().toISOString();
  const common = { spaceId: space, author: { instanceId: 'test', instanceLabel: 'Test' }, createdAt: now, updatedAt: now };
  let seq = Date.now();
  const entities = LEAVES.map(leaf => ({ ...common, _id: leaf, name: `Leaf ${leaf}`, type: 'service', tags: [], properties: {}, description: LEAF_TEXT, suppressEmbeddings: true, seq: seq++ }));
  const edges = hubs.flatMap((hub, h) =>
    LEAVES.map(leaf => ({ ...common, _id: `edge-${h}-${leaf}`, from: hub, to: leaf, label: 'feeds', seq: seq++ })));
  const r = await post(A, admin, `/api/sync/batch-upsert?spaceId=${space}`, { entities, edges });
  assert.ok(r.status < 400, `leaf fixture: ${r.status} ${JSON.stringify(r.body).slice(0, 300)}`);
}

async function mint(name, spaces) {
  const r = await post(A, admin, '/api/tokens', { name: `${name}-${RUN}`, rights: legacyRights({ spaces, readOnly: true }) });
  assert.equal(r.status, 201, `mint ${name}: ${JSON.stringify(r.body)}`);
  return [r.body.plaintext, r.body.token?.id];
}

before(async () => {
  admin = fs.readFileSync(TOKEN_FILE, 'utf8').trim();
  for (const id of [S, S2, D]) await mkSpace(id);

  hubId = await mkEntity(S, `Telemetry Aggregator ${RUN}`,
    'Telemetry aggregation pipeline collecting metrics from many downstream collectors');
  embeddingAvailable = hubId !== null;
  twinId = await mkEntity(S, `Telemetry Aggregation Hub ${RUN}`,
    'Telemetry metrics aggregation hub gathering collector metrics into one pipeline');
  for (let i = 0; i < 10; i++) {
    const id = await mkEntity(S, `vault-credential-service-${i}-${RUN}`,
      `Vault credential rotation service number ${i}, scoping authentication tokens`);
    if (id) vaultIds.push(id);
  }
  // Six each, not three: three vault records serialise to ~900 bytes and fit the 1000-byte floor, so a
  // `maxBytes: 1000` recall over three truncates nothing and spills nothing.
  for (let i = 0; i < 6; i++) {
    await mkEntity(S2, `vault-credential-mirror-${i}-${RUN}`,
      `Vault credential rotation service mirror ${i}, scoping authentication tokens`);
  }
  for (let i = 0; i < 6; i++) {
    await mkEntity(D, `vault-credential-doomed-${i}-${RUN}`,
      `Vault credential rotation service doomed ${i}, scoping authentication tokens`);
  }

  // BOTH hubs feed every leaf. `topK: 1` may rank either one first — the two describe the same thing, which
  // is what makes one the other's `similar` — and whichever wins must have the same 120 neighbours, or the
  // fixture spills on one run and not the next.
  if (hubId && twinId) await syncLeaves(S, [hubId, twinId]);

  // `similar` reads the SEED's vector, so the seeds must be embedded, not merely fresh.
  if (embeddingAvailable) {
    await waitForIndexed(A, admin, S, [hubId, twinId, ...vaultIds].filter(Boolean), ['entity']);
    // The `similar` rows search the INDEX, and recall above also finds a record the index has not ingested yet (its
    // fresh-write scan), so wait for what each similar seed must find: the hub from the twin, every vault record
    // from the first. Without it `similar` answered `results: []` on a run where the index lagged.
    if (hubId && twinId) await waitForSimilarityIndex(A, admin, S, twinId, 'entity', hubId);
    for (const id of vaultIds.slice(1)) await waitForSimilarityIndex(A, admin, S, vaultIds[0], 'entity', id);
    // S2 and D feed spills too (the cross-space spill and the delete case): their seeds have to be embedded for a
    // recall to find enough of them to overflow 1000 bytes, and a REST write does not embed inline (Q-99).
    await waitForEmbedQueueEmpty(A, admin, S2);
    await waitForEmbedQueueEmpty(A, admin, D);
  }

  [reader, readerId] = await mint('never-writes-reader', [S, S2]);
  [other, otherId] = await mint('never-writes-other', [S]);
});

after(async () => {
  for (const id of [readerId, otherId]) {
    if (id) await fetch(`${A}/api/tokens/${id}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } }).catch(() => {});
  }
  for (const id of [S, S2, D]) {
    await fetch(`${A}/api/spaces/${id}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  }
});

const ready = (t) => requireEmbedding(t, embeddingAvailable, `the hub seed could not be written (${S})`);

/**
 * Every spill site, on both doors. `pick` names where that call's spill is reported.
 *
 * Six sites in the server (recall ×3, similar ×3 — a graph past the cap, a truncated remainder, a truncated
 * remainder under a traversal), and each is reached through REST and through MCP. REST `recall` is a
 * pass-through to the tool, which is exactly why it is listed anyway: "it calls the same code" is the
 * belief this row is here to test rather than hold.
 */
const graphArgs = () => ({ space: S, query: HUB_QUERY, types: ['entity'], topK: 1, traverse: 1 });
const recallDumpArgs = (traverse) => ({
  space: S, query: VAULT_QUERY, types: ['entity'], topK: 10, maxBytes: 1000, remainderDump: true, ...(traverse ? { traverse } : {}),
});
const similarGraphArgs = () => ({ space: S, entryId: twinId, entryType: 'entity', targetTypes: ['entity'], topK: 1, traverse: 1 });
const similarDumpArgs = (traverse) => ({
  space: S, entryId: vaultIds[0], entryType: 'entity', targetTypes: ['entity'], topK: 10, maxBytes: 1000, remainderDump: true,
  ...(traverse ? { traverse } : {}),
});

const restDoor = (route, args) => async (tok) => json(await post(A, tok, route, args()));
const mcpDoor = (tool, args) => async (tok) => {
  const s = await openMcpSession(tok, A);
  try { return mcpJson(await s.callTool(tool, args())); } finally { s.close(); }
};

/**
 * `spills: false` rows are the graph that used to be spilled unasked: a hub past the old inline cap. Since
 * Q-126 it comes back WHOLE and nothing is written without `remainderDump` — so those rows assert the absence
 * of a spill, and that the absence is not the hub having been dropped instead.
 */
const SITES = [
  { name: 'recall, a whole graph past the old cap, no flag', rest: '/api/brain/recall', tool: 'recall', args: graphArgs, spills: false },
  { name: 'recall, remainderDump', rest: '/api/brain/recall', tool: 'recall', args: () => recallDumpArgs(0), spills: true },
  { name: 'recall, remainderDump under a traversal', rest: '/api/brain/recall', tool: 'recall', args: () => recallDumpArgs(1), spills: true },
  { name: 'similar, a whole graph past the old cap, no flag', rest: '/api/brain/similar', tool: 'similar', args: similarGraphArgs, spills: false },
  { name: 'similar, remainderDump', rest: '/api/brain/similar', tool: 'similar', args: () => similarDumpArgs(0), spills: true },
  { name: 'similar, remainderDump under a traversal', rest: '/api/brain/similar', tool: 'similar', args: () => similarDumpArgs(1), spills: true },
];
const DOORS = SITES.flatMap(site => [
  { label: `REST ${site.rest} — ${site.name}`, call: restDoor(site.rest, site.args), spills: site.spills },
  { label: `MCP ${site.tool} — ${site.name}`, call: mcpDoor(site.tool, site.args), spills: site.spills },
]);

/** The node ids in one returned row's `_graph`, whichever door's shape the row has. */
const graphIdsOf = (row) => (row?._graph ?? row?.record?._graph ?? []).map(n => n.node?._id);

describe('a search by a read-only token leaves the space exactly as it was', () => {
  it('the door table covers every search site on both doors', () => {
    // A floor, so a table edited down to nothing cannot pass every case below by having none.
    assert.equal(DOORS.length, 12);
  });

  for (const door of DOORS) {
    it(door.label, async (t) => {
      if (!ready(t)) return;
      const before = spaceFootprint('a', S);
      const body = await door.call(reader);
      const after = spaceFootprint('a', S);
      assert.deepEqual(after.fileIds, before.fileIds,
        `a search wrote file records into '${S}': ${JSON.stringify(after.fileIds.filter(f => !before.fileIds.includes(f)))}`);
      assert.equal(after.seq, before.seq, 'a search advanced the space seq, so its write would sync to every peer');
      assert.deepEqual(after.spillJobs, before.spillJobs, 'a search queued an embed job for its own output');
      if (door.spills) {
        // Without a spill this case would compare two identical footprints and prove nothing.
        assert.ok(body.remainder, `this call must spill or it tests nothing: ${JSON.stringify(body).slice(0, 300)}`);
        assert.match(String(body.remainder.spillId), UUID, `the spill is delivered by id: ${JSON.stringify(body.remainder)}`);
      } else {
        assert.equal(body.remainder, undefined, 'a spill was written without remainderDump');
        assert.equal(body.graphComplete, undefined, 'a graph spill is back');
        // The absence proves something only if the hub came back — and came back whole.
        const [row] = body.results ?? [];
        assert.deepEqual([...graphIdsOf(row)].sort(), [...LEAVES].sort(),
          `the hub must come back with every leaf, not be dropped or cut: ${JSON.stringify(body).slice(0, 300)}`);
      }
    });
  }
});

/** Every window of a spill through REST, following `nextSkip` to the end. */
async function pageRest(tok, id, maxBytes) {
  const items = [];
  let skip = 0;
  for (let n = 0; n < 200; n++) {
    const r = await get(A, tok, `/api/brain/spills/${id}?skip=${skip}&maxBytes=${maxBytes}`);
    assert.equal(r.status, 200, `REST window at skip ${skip}: ${r.status} ${JSON.stringify(r.body).slice(0, 200)}`);
    items.push(...windowOf(r.body));
    if (!r.body.truncated) return { items, windows: n + 1, header: r.body };
    assert.equal(r.body.nextSkip, skip + windowOf(r.body).length, 'nextSkip is absolute');
    skip = r.body.nextSkip;
  }
  assert.fail('paging never ended');
}

async function pageMcp(tok, id, maxBytes) {
  const s = await openMcpSession(tok, A);
  try {
    const items = [];
    let skip = 0;
    for (let n = 0; n < 200; n++) {
      const out = mcpJson(await s.callTool('read_spill', { id, skip, maxBytes }));
      items.push(...windowOf(out));
      if (!out.truncated) return { items, windows: n + 1, header: out };
      assert.equal(out.nextSkip, skip + windowOf(out).length, 'nextSkip is absolute');
      skip = out.nextSkip;
    }
    assert.fail('paging never ended');
  } finally { s.close(); }
}

/**
 * The window a read returns. Plan v3 point 3 names it `items` beside a header field also called `items` (the
 * count), so this takes the ARRAY wherever the implementation puts it and fails when there is none.
 */
function windowOf(body) {
  const w = [body?.items, body?.nodes, body?.results].find(Array.isArray);
  assert.ok(w, `a spill read must return its window as an array: ${JSON.stringify(body).slice(0, 200)}`);
  return w;
}
const itemId = (it) => it?.id ?? it?.record?._id ?? it?.node?._id;

/**
 * A LARGE remainder spill: the two hubs (each ~310 KiB with its 120 leaves) and the vault services, cut after
 * the first row. The other hub is the remainder's first item — whole, with every leaf — so the spill spans
 * storage pages, and the vault rows after it make a second read window. Which hub ranks first is not fixed;
 * the pair is what the assertions use. Returns the spill and the id of the hub that was answered inline.
 */
async function readerLargeSpill() {
  const body = json(await post(A, reader, '/api/brain/recall', {
    space: S, query: HUB_QUERY, types: ['entity'], topK: 12, traverse: 1, maxBytes: 1000, remainderDump: true,
  }));
  const spillId = remainderSpillId(body);
  const inline = body.results?.[0]?.record?._id ?? body.results?.[0]?._id;
  assert.ok([hubId, twinId].includes(inline), `the first row must be a hub, or the fixture is wrong: ${inline}`);
  return { ...body.remainder, spillId, inline };
}

/** A remainder spill: the fixture half (it spilled at all) apart from the contract half (it names an id). */
function remainderSpillId(body) {
  assert.ok(body.remainder, `the fixture must spill: ${JSON.stringify({ ...body, results: undefined }).slice(0, 300)}`);
  assert.match(String(body.remainder.spillId), UUID, `the remainder is delivered by id: ${JSON.stringify(body.remainder)}`);
  return body.remainder.spillId;
}

describe('the issuing token reads its spill, whole, on both doors', () => {
  it('pages every row through REST and MCP, identically, each whole, across a storage-page boundary', async (t) => {
    if (!ready(t)) return;
    const spill = await readerLargeSpill();
    assert.equal(spill.download, `/api/brain/spills/${spill.spillId}`, 'the link is the spill route, not a file in the space');

    const rest = await pageRest(reader, spill.spillId, 40_000);
    const mcp = await pageMcp(reader, spill.spillId, 40_000);

    assert.ok(rest.windows > 1 && mcp.windows > 1, `the read budget must bite: ${rest.windows}/${mcp.windows} window(s)`);
    const restIds = rest.items.map(itemId);
    assert.equal(new Set(restIds).size, restIds.length, 'a row was served twice across REST windows');
    assert.ok(!restIds.includes(spill.inline), 'the spill repeats the row already answered inline');
    const otherHub = spill.inline === hubId ? twinId : hubId;
    const hubRow = rest.items.find(i => itemId(i) === otherHub);
    assert.ok(hubRow, `the other hub is not in the remainder: ${JSON.stringify(restIds)}`);
    assert.deepEqual([...graphIdsOf(hubRow)].sort(), [...LEAVES].sort(), 'a spilled row is whole: every leaf, nothing else');
    assert.deepEqual(mcp.items.map(itemId), restIds, 'the two doors serve the same spill in the same order');
    assert.equal(rest.header.kind, 'results');

    // ~310 KiB in one row against 256 KiB pages: the store holds it in more than one page, so the windows above
    // crossed a page boundary rather than reading one page twice.
    const rows = spillRows('a', spill.spillId);
    assert.equal(rows.headers, 1, 'one header per spill');
    assert.ok(rows.pages >= 2, `the fixture must span storage pages, got ${rows.pages}`);
  });
});

describe('nobody else reads it — one uniform 404, on every door', () => {
  it('another token with read on the space gets exactly what an unknown id gets', async (t) => {
    if (!ready(t)) return;
    const spill = { spillId: remainderSpillId(json(await post(A, reader, '/api/brain/recall', recallDumpArgs(0)))) };
    const mine = await get(A, reader, `/api/brain/spills/${spill.spillId}`);
    assert.equal(mine.status, 200, `the issuer reads it first, or the refusal below proves nothing: ${mine.status}`);

    const theirs = await get(A, other, `/api/brain/spills/${spill.spillId}`);
    const nobody = await get(A, other, '/api/brain/spills/00000000-0000-4000-8000-000000000000');
    assert.equal(theirs.status, 404, `another token must not learn the spill exists: ${theirs.status}`);
    assert.equal(nobody.status, 404);
    assert.deepEqual(theirs.body, nobody.body, 'someone else\'s spill must be indistinguishable from none');

    const s = await openMcpSession(other, A);
    try {
      const a = await s.callTool('read_spill', { id: spill.spillId });
      const b = await s.callTool('read_spill', { id: '00000000-0000-4000-8000-000000000000' });
      assert.equal(a?.isError, true, 'MCP must refuse it too');
      assert.equal(a?.content?.[0]?.text, b?.content?.[0]?.text, 'with the unknown-id answer, word for word');
    } finally { s.close(); }

    const anon = await fetch(`${A}/api/brain/spills/${spill.spillId}`);
    assert.equal(anon.status, 401, 'and no token is no read at all');
  });

  it('a token that lost read on ONE member of the spill gets the same 404', async (t) => {
    if (!ready(t)) return;
    const [lost, lostId] = await mint('never-writes-lost', [S, S2]);
    try {
      // No `space`: the recall spans both of the token's spaces, so the spill holds records of both.
      const body = json(await post(A, lost, '/api/brain/recall', {
        query: VAULT_QUERY, types: ['entity'], topK: 20, maxBytes: 1000, remainderDump: true,
      }));
      const spillId = remainderSpillId(body);
      const whole = await pageRest(lost, spillId, 5_000_000);
      const spaces = new Set(whole.items.map(i => i.spaceId));
      assert.ok(spaces.has(S) && spaces.has(S2), `the spill must span both members: ${JSON.stringify([...spaces])}`);

      const cut = await patch(A, admin, `/api/tokens/${lostId}`, { rights: legacyRights({ spaces: [S], readOnly: true }) });
      assert.equal(cut.status, 200, `drop S2 from the token: ${JSON.stringify(cut.body)}`);

      const r = await get(A, lost, `/api/brain/spills/${spillId}`);
      assert.equal(r.status, 404, `read on every member is required, not on one: ${r.status}`);
      const s = await openMcpSession(lost, A);
      try {
        const m = await s.callTool('read_spill', { id: spillId });
        assert.equal(m?.isError, true, 'MCP must refuse it on the same terms');
      } finally { s.close(); }
    } finally {
      await fetch(`${A}/api/tokens/${lostId}`, { method: 'DELETE', headers: { Authorization: `Bearer ${admin}` } }).catch(() => {});
    }
  });
});

describe('the legacy `path` still resolves — for its issuer only', () => {
  it('read_file and the files GET serve it to the issuer and 404 everyone else', async (t) => {
    if (!ready(t)) return;
    const body = json(await post(A, reader, '/api/brain/recall', recallDumpArgs(0)));
    const spill = { ...body.remainder, spillId: remainderSpillId(body) };
    const url = `/api/files/${encodeURIComponent(S)}?path=${encodeURIComponent(spill.path)}`;

    // The refusal first: it is the half the unchanged code gets wrong, since a spill in the space's own
    // file store is readable by every files:read token on it.
    const theirs = await get(A, other, url);
    assert.equal(theirs.status, 404, `a files:read token that did not issue the spill must not read it: ${theirs.status}`);
    const s2 = await openMcpSession(other, A);
    try {
      const r = await s2.callTool('read_file', { space: S, path: spill.path });
      assert.equal(r?.isError, true, 'nor through read_file');
    } finally { s2.close(); }

    const mine = await get(A, reader, url);
    assert.equal(mine.status, 200, `the issuer resolves it: ${mine.status}`);
    const s = await openMcpSession(reader, A);
    try {
      const r = await s.callTool('read_file', { space: S, path: spill.path });
      assert.notEqual(r?.isError, true, `and so does read_file: ${r?.content?.[0]?.text?.slice(0, 200)}`);
    } finally { s.close(); }
    assert.equal(spill.path, `_tmp/results-${spill.spillId}.json`, 'the path keeps its shape and names the spill');
  });
});

describe('a spill goes with its space', () => {
  it('deleting the space drops its spills', async (t) => {
    if (!ready(t)) return;
    const body = json(await post(A, admin, '/api/brain/recall', {
      space: D, query: VAULT_QUERY, types: ['entity'], topK: 10, maxBytes: 1000, remainderDump: true,
    }));
    const id = remainderSpillId(body);
    assert.equal((await get(A, admin, `/api/brain/spills/${id}`)).status, 200, 'readable while the space exists');

    const del = await fetch(`${A}/api/spaces/${D}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${admin}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    });
    assert.ok(del.status < 300, `delete ${D}: ${del.status}`);

    assert.equal((await get(A, admin, `/api/brain/spills/${id}`)).status, 404, 'gone with the space');
    assert.deepEqual(spillRows('a', id), { headers: 0, pages: 0 }, 'and gone from the store, not merely hidden');
  });
});
