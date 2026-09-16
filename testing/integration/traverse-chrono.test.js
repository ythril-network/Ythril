/**
 * Integration: `traverse` reaches a chrono entry through `chrono.entityIds`.
 *
 * ## The reported cost
 *
 * `chrono.entityIds` was the only thing linking a chrono to the graph, legible to `query()` and invisible to
 * `traverse` — the retrieval path an agent reaches for first. An integrator measured it: reconstructing a
 * **33-day hardware-RMA timeline took four `query()` calls plus two repo greps**, and the first pass still
 * missed the actual carrier ticket, which had to be found by a name regex rather than by traversal from the
 * incident.
 *
 * ## Why this is an integration test and not only a unit one
 *
 * The source-level gate (`traverse-reaches-chrono`) passed on a version that returned **nothing** for the
 * commonest case in the report: an entity whose only link is a timeline. The BFS breaks out early when a
 * frontier yields no entity neighbours, and the chrono lookup sat after that break — so an incident with ten
 * chrono entries and no edges traversed to an empty result. Nothing about the source reads wrong; only running
 * it does.
 *
 * That case is the first test below, deliberately.
 *
 * Run: node --test testing/integration/traverse-chrono.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, reqJson } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `traverse-chrono-${RUN}`;

let tokenA;
const ids = {};
const token = () => tokenA;
const P = (p, body) => post(INSTANCES.a, token(), p, body);
const traverse = (body) => P(`/api/brain/spaces/${SPACE}/traverse`, body);

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const sp = await P('/api/spaces', { id: SPACE, label: `Traverse Chrono ${RUN}` });
  assert.equal(sp.status, 201, `create space: ${JSON.stringify(sp.body)}`);

  // A lone entity whose ONLY link is a timeline — the case that returned nothing.
  const lone = await P(`/api/brain/spaces/${SPACE}/entities`, { name: `Lone Incident ${RUN}`, type: 'incident' });
  ids.lone = lone.body?._id;

  // And an incident with a real edge AND a chrono, so both kinds of node appear in one result.
  const inc = await P(`/api/brain/spaces/${SPACE}/entities`, { name: `RMA Incident ${RUN}`, type: 'incident' });
  const car = await P(`/api/brain/spaces/${SPACE}/entities`, { name: `Carrier Ticket ${RUN}`, type: 'ticket' });
  ids.inc = inc.body?._id;
  ids.car = car.body?._id;
  await P(`/api/brain/spaces/${SPACE}/edges`, { from: ids.inc, to: ids.car, label: 'depends_on' });

  const c1 = await P(`/api/brain/spaces/${SPACE}/chrono`, {
    title: 'Unit collected by carrier', type: 'event',
    startsAt: '2026-07-04T09:00:00.000Z', entityIds: [ids.inc],
  });
  const c2 = await P(`/api/brain/spaces/${SPACE}/chrono`, {
    title: 'Replacement promised', type: 'event',
    startsAt: '2026-07-06T09:00:00.000Z', entityIds: [ids.lone],
  });
  ids.chrono = c1.body?._id;
  ids.loneChrono = c2.body?._id;

  // A memory about the same incident, for the includeMemories flag.
  const m1 = await P(`/api/brain/spaces/${SPACE}/facts`, {
    fact: 'The carrier lost the first replacement unit', entityIds: [ids.inc],
  });
  ids.memory = m1.body?._id;

  // A file about the same incident, for includeFiles. TWO calls, because they are two records: the file write
  // stores the bytes, and the brain's file META record is where `entityIds` — the link traverse follows — lives.
  ids.file = 'rma/carrier-report.md';
  const content = ['# Carrier report', '', 'The unit was lost in transit.', ''].join('\n');
  const w = await P(`/api/files/${SPACE}?path=${encodeURIComponent(ids.file)}`, { content });
  assert.ok(w.status < 300, `write file: ${w.status} ${JSON.stringify(w.body)}`);
  // PATCH, then CONFIRM IT STUCK — re-patching until it does, bounded.
  //
  // The file write kicks off the conversion pipeline, which writes the brain's file-meta record itself and derives
  // `description` from the document's own opening prose. A PATCH issued before that write lands is silently overwritten:
  // in CI on 2026-08-13 this fixture's description came back as "Carrier report The unit was lost in transit." — the
  // excerpt — and the assertion 170 lines later reported it as a traverse defect. Locally the pipeline finishes first, so
  // the race only ever shows up under load.
  //
  // Asserting the fixture is what it claims to be, HERE, is the difference between a one-line failure at setup and a
  // misleading failure in the test body. The product question of whether the pipeline should overwrite an operator's own
  // description at all is filed separately — this loop does not depend on the answer.
  const wantDescription = 'Carrier incident report';
  const patchMeta = () => reqJson(INSTANCES.a, token(),
    `/api/brain/spaces/${SPACE}/files?path=${encodeURIComponent(ids.file)}`,
    { method: 'PATCH', body: JSON.stringify({ description: wantDescription, tags: ['rma'], entityIds: [ids.inc] }) });

  let meta = await patchMeta();
  assert.ok(meta.status < 300, `link file to entity: ${meta.status} ${JSON.stringify(meta.body)}`);

  const deadline = Date.now() + 20_000;
  let readBack;
  for (;;) {
    readBack = await reqJson(INSTANCES.a, token(),
      `/api/brain/spaces/${SPACE}/files?path=${encodeURIComponent(ids.file)}`, { method: 'GET' });
    const got = readBack.body?.files?.[0]?.description ?? readBack.body?.description;
    if (got === wantDescription) break;
    if (Date.now() > deadline) {
      assert.fail(`the file-meta PATCH never stuck: description reads ${JSON.stringify(got)} rather than `
        + `${JSON.stringify(wantDescription)} — the conversion pipeline is overwriting it`);
    }
    await new Promise(r => setTimeout(r, 500));
    meta = await patchMeta();
  }
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

describe('traverse reaches chrono entries', () => {
  it('an entity whose ONLY link is a timeline is not a dead end', async () => {
    // The regression the unit gate could not see: the BFS used to break out before looking for chrono.
    const r = await traverse({ startId: ids.lone, direction: 'both', maxDepth: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const node = (r.body.nodes ?? []).find(n => n._id === ids.loneChrono);
    assert.ok(node, `the chrono must be reachable with no edges present: ${JSON.stringify(r.body)}`);
    assert.equal(node.kind, 'chrono');
    assert.equal(node.name, 'Replacement promised', 'the node name is the chrono title');
  });

  it('returns entity and chrono nodes together, and marks only the chrono', async () => {
    const r = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nodes = r.body.nodes ?? [];

    const chrono = nodes.find(n => n._id === ids.chrono);
    assert.ok(chrono, `the chrono must be reachable: ${JSON.stringify(nodes)}`);
    assert.equal(chrono.kind, 'chrono');

    const entity = nodes.find(n => n._id === ids.car);
    assert.ok(entity, 'the entity reached by a real edge is still returned');
    assert.ok(!('kind' in entity),
      'an entity node must be unchanged — absence of `kind` is what keeps every existing response identical');

    const link = (r.body.edges ?? []).find(e => e.to === ids.chrono);
    assert.ok(link, 'the synthetic link must be reported like any other edge');
    assert.equal(link.label, 'chrono.entityIds');
    assert.equal(link.from, ids.inc, 'it hangs off the entity the chrono references');
    /*
     * The edge id must DIFFER from every node id in the same response.
     *
     * This used to assert the opposite — `link._id === ids.chrono` — on the rationale that the chrono's own
     * id "resolves rather than 404ing on an invented edge". It never resolved: `GET /edges/:id` reads the
     * edge collection only. And sharing an id between a node and an edge makes a graph library drop one of
     * them, since they keep a single id namespace, which is how the chrono links disappeared from the graph
     * view without a word.
     *
     * Asserted against the WHOLE node set rather than against the chrono alone, because the property that
     * matters is uniqueness across the response, not inequality with one particular record.
     */
    const nodeIds = new Set((r.body.nodes ?? []).map(n => n._id));
    assert.ok(
      !nodeIds.has(link._id),
      `the synthetic edge id ${link._id} collides with a node in the same response — a graph library keeps `
      + 'one id namespace and will silently drop one of the two',
    );
    assert.match(link._id, /^chrono\.entityIds:/, 'and it names the link it stands for');
  });

  it('includeChrono:false restores the entity-only shape', async () => {
    const r = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2, includeChrono: false });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const nodes = r.body.nodes ?? [];
    assert.ok(!nodes.some(n => n._id === ids.chrono), 'no chrono node');
    assert.ok(nodes.some(n => n._id === ids.car), 'the entity is still reached');
  });

  it('an explicit edgeLabels filter excludes chrono unless it names the label', async () => {
    // A filter that cannot exclude something is not a filter: asking for `depends_on` must not quietly
    // return timeline entries.
    const filtered = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2, edgeLabels: ['depends_on'] });
    assert.ok(!(filtered.body.nodes ?? []).some(n => n._id === ids.chrono),
      `depends_on must not return chrono: ${JSON.stringify(filtered.body.nodes)}`);

    const named = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2, edgeLabels: ['chrono.entityIds'] });
    assert.ok((named.body.nodes ?? []).some(n => n._id === ids.chrono),
      `naming the label must return it: ${JSON.stringify(named.body.nodes)}`);
  });

  it('refuses a non-boolean includeChrono rather than coercing it', async () => {
    // `includeChrono: "false"` is truthy in JavaScript. Coercing it would mean the opt-out silently did the
    // opposite of what the caller asked.
    const r = await traverse({ startId: ids.inc, includeChrono: 'false' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /includeChrono/);
  });
});

/**
 * The two flags the owner asked for alongside `includeChrono`, "for consistency" — with one asymmetry they
 * spelled out: edges are traversed regardless, and the flag is only about whether they ride back in the answer.
 */
describe('traverse — includeMemories and includeEdges', () => {
  it('memories are NOT included by default', async () => {
    // Opt-in on purpose: memories are usually the most numerous record type and every node counts against
    // `limit`, so on by default they would truncate away the entities the caller traversed for.
    const r = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mem = (r.body.nodes ?? []).find(n => n._id === ids.memory);
    assert.ok(!mem, `a memory must not appear unless asked for: ${JSON.stringify(r.body.nodes)}`);
  });

  it('includeMemories:true reaches the memory and marks it', async () => {
    const r = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2, includeMemories: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const mem = (r.body.nodes ?? []).find(n => n._id === ids.memory);
    assert.ok(mem, `the memory must be reachable through entityIds: ${JSON.stringify(r.body.nodes)}`);
    assert.equal(mem.kind, 'fact');
    assert.equal(mem.name, 'The carrier lost the first replacement unit', 'the node name is the fact');
    const link = (r.body.edges ?? []).find(e => e.to === ids.memory);
    assert.ok(link, 'the synthetic link must be present');
    assert.equal(link.label, 'fact.entityIds');
  });

  it('an explicit edgeLabels filter excludes memories unless it names the label', async () => {
    const only = await traverse({
      startId: ids.inc, direction: 'both', maxDepth: 2, includeMemories: true, edgeLabels: ['depends_on'],
    });
    assert.equal(only.status, 200, JSON.stringify(only.body));
    assert.ok(!(only.body.nodes ?? []).some(n => n._id === ids.memory),
      'asking for depends_on must not quietly return memories too');

    const named = await traverse({
      startId: ids.inc, direction: 'both', maxDepth: 2, includeMemories: true,
      edgeLabels: ['depends_on', 'fact.entityIds'],
    });
    assert.ok((named.body.nodes ?? []).some(n => n._id === ids.memory),
      'naming the label must bring them back');
  });

  it('includeEdges:false drops the edge list and leaves the NODES identical', async () => {
    // The whole distinction. If this flag ever gated traversal instead of output, the node sets would differ —
    // which is the failure this asserts against, not the empty array.
    const withEdges = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 3, includeMemories: true });
    const without = await traverse({
      startId: ids.inc, direction: 'both', maxDepth: 3, includeMemories: true, includeEdges: false,
    });
    assert.equal(without.status, 200, JSON.stringify(without.body));
    assert.deepEqual(without.body.edges, [], 'the edge list must be empty');
    assert.ok((withEdges.body.edges ?? []).length > 0, 'the comparison is meaningless if the walk found no edges');

    const idsOf = r => (r.body.nodes ?? []).map(n => n._id).sort();
    assert.deepEqual(idsOf(without), idsOf(withEdges),
      'suppressing the edge LIST must not change which nodes were reached');
  });

  it('refuses a non-boolean on either new flag rather than coercing it', async () => {
    for (const flag of ['includeMemories', 'includeEdges']) {
      const r = await traverse({ startId: ids.inc, [flag]: 'false' });
      assert.equal(r.status, 400, `${flag}: expected 400, got ${r.status}`);
      assert.match(r.body?.error ?? '', new RegExp(flag), 'the error must name the offending flag');
    }
  });
});

/**
 * Files, the owner's fourth flag — "what about files btw (return only the filemeta of course)".
 *
 * The meta-only rule has teeth here: chunks live in the SAME collection as the file they belong to, told apart
 * only by `parentFileId`. A query that forgot that predicate would return one node per passage, each carrying
 * text, and exhaust `limit` on a single document.
 */
describe('traverse — includeFiles returns file META only', () => {
  it('files are NOT included by default', async () => {
    const r = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2 });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!(r.body.nodes ?? []).some(n => n.kind === 'file'),
      `a file must not appear unless asked for: ${JSON.stringify(r.body.nodes)}`);
  });

  it('includeFiles:true reaches the file, marked, with its meta and no passage text', async () => {
    // set-claim: the passage-level fields a FILE node must not carry, named as the answer's shape rather
    // than derived -- a file node is asserted field by field just above, so this is the negative half.
    const r = await traverse({ startId: ids.inc, direction: 'both', maxDepth: 2, includeFiles: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const files = (r.body.nodes ?? []).filter(n => n.kind === 'file');
    assert.equal(files.length, 1, `exactly one file node, not one per chunk: ${JSON.stringify(files)}`);

    const [f] = files;
    assert.equal(f._id, ids.file, 'the node id is the file path');
    assert.equal(f.name, ids.file, 'the name is the path');
    assert.equal(f.description, 'Carrier incident report');
    assert.deepEqual(f.tags, ['rma']);

    // The whole point of "only the filemeta": no passage body, under any of the names a chunk uses for it.
    for (const forbidden of ['content', 'matchedText', 'parentFileId', 'chunkIndex']) {
      assert.ok(!(forbidden in f), `a file node must not carry \`${forbidden}\`: ${JSON.stringify(f)}`);
    }

    const link = (r.body.edges ?? []).find(e => e.to === ids.file);
    assert.ok(link, 'the synthetic link must be present');
    assert.equal(link.label, 'file.entityIds');
  });

  it('an explicit edgeLabels filter excludes files unless it names the label', async () => {
    const only = await traverse({
      startId: ids.inc, direction: 'both', maxDepth: 2, includeFiles: true, edgeLabels: ['depends_on'],
    });
    assert.ok(!(only.body.nodes ?? []).some(n => n.kind === 'file'),
      'asking for depends_on must not quietly return files too');
  });

  it('refuses a non-boolean includeFiles', async () => {
    const r = await traverse({ startId: ids.inc, includeFiles: 'true' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body?.error ?? '', /includeFiles/);
  });
});
