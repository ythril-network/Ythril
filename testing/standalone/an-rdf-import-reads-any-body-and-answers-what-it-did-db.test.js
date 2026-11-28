/**
 * The RDF import's doors read the body whatever its content type, answer an act that will be retried as running and an input failure by its own
 * status and code, ask the brain's storage limit, and refuse a peer-bound token as every door outside the sync doors does (bundle-270, second review
 * F5, F6, F10 and U2; bundle-47, Q-244 for U2).
 *
 * ## What it holds
 *
 * - F5: the same Turtle sent as `application/x-www-form-urlencoded` (curl's default), as `application/json` and as `text/turtle` lands alike: no
 *   global body parser takes the body. A JSON-LD body over the JSON body limit sent as `application/json` is answered by the import's own bound,
 *   never by the body parser's 413.
 * - F6: an act left owed answers 202 with the `importId` and its status address on both doors (a caller who retries would import twice); an input
 *   failure answers its own status and code on both doors.
 * - F10: with the brain's hard storage limit reached, both doors refuse as the fact doors do (REST 507 with `storageExceeded`, the tool an error).
 * - U2: Q-244 confines a peer-bound token to the sync doors (`/api/sync/*`, `GET`/`POST /api/files/:spaceId`, `POST /api/notify`): token resolution
 *   answers it `403 { code: 'peer_door' }` on every other route, `/mcp` included (an HTTP `403` with a JSON body, not a tool result). So the REST import,
 *   the tool and both status doors answer a peer-bound token `403 peer_door`, as do the neighbouring write and read doors (`POST entities`,
 *   `save_entity`), no import act is registered and no record lands. Control: a token not bound to a peer writes through the neighbouring door.
 *
 * Run: node --test testing/standalone/an-rdf-import-reads-any-body-and-answers-what-it-did-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { waitFor } from '../_shared/wait-for.mjs';
import { openRdfImportDoors, personMeta, goodTurtle, baseOf } from './_rdf-import-doors.mjs';

const skip = await mongoSkipReason();
const until = (what, fn, ms = 30_000) => waitFor(fn, ms, 50, undefined, { what });
const FORM = 'rdfimpf5form';
const JSON_CT = 'rdfimpf5json';
const TURTLE = 'rdfimpf5ttl';
const BIG = 'rdfimpf5big';
const OWED_REST = 'rdfimpf6rest';
const OWED_MCP = 'rdfimpf6mcp';
const INPUT = 'rdfimpf6input';
const QUOTA = 'rdfimpf10';
const PEER = 'rdfimpu2';
const SPACES = [FORM, JSON_CT, TURTLE, BIG, OWED_REST, OWED_MCP, INPUT, QUOTA, PEER];
const JSON_BODY_LIMIT = 10 * 1024 * 1024;

describe('the RDF import doors read any body and answer what happened (real routes, real MongoDB)', { skip, timeout: 300_000 }, () => {
  let d, writer, peer, act, runner;
  before(async () => {
    d = await openRdfImportDoors({ suite: 'rdf_import_answers', spaces: SPACES.map(id => ({ id, meta: personMeta(id, 'warn') })) });
    const row = () => d.row({ knowledge: 'write', schema: 'admin' });
    writer = await d.mint('rdf-import-answers-writer', Object.fromEntries(SPACES.map(s => [s, row()])));
    peer = await d.mint('rdf-import-answers-peer', { [PEER]: row() }, { peerInstanceId: 'rdf-import-answers-a-peer' });
    act = await import('../../server/dist/spaces/rdf-import-act.js');
    runner = await import('../../server/dist/spaces/space-act-runner.js');
  });
  after(async () => { act?.setRdfImportKnobsForTest?.(null); runner?.setSpaceActKnobsForTest?.(null); await d?.close(); });

  it('F5: the same Turtle sent as form data, as JSON and as turtle lands alike', async () => {
    const answers = {};
    for (const [space, contentType] of [[FORM, 'application/x-www-form-urlencoded'], [JSON_CT, 'application/json'], [TURTLE, 'text/turtle']]) {
      const r = await d.importRest(writer.key, space, goodTurtle(space), { params: { format: 'turtle' }, contentType });
      assert.equal(r.status, 200, `${contentType}: ${r.text.slice(0, 300)}`);
      assert.ok(r.body.quads > 0, `${contentType}: the document was read (${r.body.quads} statements)`);
      answers[contentType] = [r.body.quads, r.body.kinds.entity.inserted, r.body.kinds.edge.inserted];
      assert.deepEqual((await d.records(space, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob'], `${contentType}: the records landed`);
    }
    assert.deepEqual(answers['application/x-www-form-urlencoded'], answers['text/turtle']);
    assert.deepEqual(answers['application/json'], answers['text/turtle']);
  });

  it('F5: a JSON-LD body over the JSON body limit, sent as JSON, is answered by the import\'s own bound', async () => {
    const graph = Array.from({ length: 140_000 },(_, i) => ({ '@id': `http://graph.example/s${i}`, 'http://graph.example/p': `value number ${i} of the graph, long enough to pass the limit` }));
    const text = JSON.stringify({ '@graph': graph });
    assert.ok(text.length > JSON_BODY_LIMIT, 'the document is over the global JSON limit');
    const r = await d.importRest(writer.key, BIG, text, { format: 'jsonld', contentType: 'application/json' });
    assert.match(String(r.body?.code ?? ''), /^rdf_/, `the answer is the import's own, not the body parser's: ${r.status} ${r.text.slice(0, 300)}`);
    assert.deepEqual(d.actsOf(BIG), []);
  });

  it('F6: an act left owed answers 202 with its importId on both doors', async () => {
    for (const [space, door] of [[OWED_REST, 'rest'], [OWED_MCP, 'mcp']]) {
      let failures = 0;
      act.setRdfImportKnobsForTest({ window: 1, hooks: { afterCommitWindow: () => { if (failures === 0) { failures += 1; throw new Error('planted: the first window\'s end fails'); } } } });
      let importId;
      try {
        if (door === 'rest') {
          const r = await d.importRest(writer.key, space, goodTurtle(space));
          assert.equal(r.status, 202, `${door}: ${r.text.slice(0, 300)}`);
          importId = r.body?.importId;
          assert.match(r.headers.get('location') ?? '', new RegExp(`/import/rdf/${importId}$`));
          assert.equal(r.body?.status, 'running');
        } else {
          const r = await d.importMcp(writer.key, { space, document: goodTurtle(space), format: 'turtle' });
          assert.equal(r.isError, false, `${door}: ${r.text.slice(0, 300)}`);
          importId = r.structured?.importId;
          assert.equal(r.structured?.status, 'running', r.text.slice(0, 300));
        }
      } finally { act.setRdfImportKnobsForTest(null); }
      assert.ok(importId, `${door}: the answer names the import`);
      const [entry] = d.actsOf(space);
      assert.ok(entry && entry.spoolId === importId, `${door}: the act that will land is the one named`);
      const status = await d.statusRest(writer.key, space, importId);
      assert.equal(status.body?.status, 'running', status.text.slice(0, 300));
      const settled = await runner.runSpaceAct(entry.id);
      assert.equal(settled.ok, true, settled.error);
      assert.deepEqual((await d.records(space, 'entities')).map(e => e.name).sort(), ['Alice', 'Bob'], `${door}: it landed once, as the 202 said it would`);
    }
  });

  it('F6: an input failure answers its own status and code on both doors', async () => {
    const off = () => d.loader.mutateConfig(cfg => { const s = cfg.spaces.find(x => x.id === INPUT); s.meta = { ...s.meta, rdf: { ...s.meta.rdf, enabled: false } }; });
    const on = () => d.loader.mutateConfig(cfg => { const s = cfg.spaces.find(x => x.id === INPUT); s.meta = { ...s.meta, rdf: { ...s.meta.rdf, enabled: true } }; });
    // The space is able to hold the import when the door looks and no longer when the act starts.
    act.setRdfImportKnobsForTest({ hooks: { beforeRegister: off } });
    let rest;
    try { rest = await d.importRest(writer.key, INPUT, goodTurtle(INPUT)); } finally { act.setRdfImportKnobsForTest(null); on(); }
    assert.equal(rest.status, 409, `REST: ${rest.text.slice(0, 300)}`);
    assert.equal(rest.body?.code, 'rdf_not_enabled');
    await until('the act to end', () => d.actsOf(INPUT).length === 0);
    act.setRdfImportKnobsForTest({ hooks: { beforeRegister: off } });
    let mcp;
    try { mcp = await d.importMcp(writer.key, { space: INPUT, document: goodTurtle(INPUT), format: 'turtle' }); } finally { act.setRdfImportKnobsForTest(null); on(); }
    assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
    assert.match(mcp.text, /rdf_not_enabled/, 'the tool names the same code');
    assert.deepEqual(await d.records(INPUT, 'entities'), [], 'nothing was written');
    await until('the act to end', () => d.actsOf(INPUT).length === 0);
  });

  it('F10: with the brain\'s hard limit reached both doors refuse, as the fact doors do', async () => {
    const fact = async () => d.rest(writer.key, 'POST', `/api/brain/spaces/${QUOTA}/facts`, { fact: 'a fact the limit refuses' });
    d.loader.mutateConfig(cfg => { cfg.storage = { brain: { softLimitGiB: 0, hardLimitGiB: 0 } }; });
    try {
      const neighbour = await fact();
      assert.equal(neighbour.status, 507, `the fact door refuses at the limit: ${neighbour.text?.slice(0, 200)}`);
      const rest = await d.importRest(writer.key, QUOTA, goodTurtle(QUOTA));
      assert.equal(rest.status, 507, rest.text.slice(0, 300));
      assert.equal(rest.body?.storageExceeded, true);
      const mcp = await d.importMcp(writer.key, { space: QUOTA, document: goodTurtle(QUOTA), format: 'turtle' });
      assert.equal(mcp.isError, true, mcp.text.slice(0, 300));
      assert.match(mcp.text, /hard limit/i);
      assert.deepEqual(await d.records(QUOTA, 'entities'), [], 'nothing was written');
      assert.deepEqual(d.actsOf(QUOTA), []);
    } finally { d.loader.mutateConfig(cfg => { delete cfg.storage; }); }
  });

  it('U2: a peer-bound token is refused 403 peer_door on the import doors and on the neighbouring doors, registers no act and lands no record', async () => {
    // `/mcp` answers a peer-bound token an HTTP 403 with a JSON body (the door never reaches the tool), so the code is read from that body.
    const viaMcp = async (name, args) => { const r = await d.rpc(peer.key, 'tools/call', { name, arguments: args }); return { status: r.status, code: r.messages[0]?.code, text: JSON.stringify(r.messages[0] ?? {}).slice(0, 300) }; };
    const restRefused = (a, what) => assert.ok(a.status === 403 && a.body?.code === 'peer_door', `${what}: ${a.status} ${a.text.slice(0, 300)}`);
    const mcpRefused = (a, what) => assert.ok(a.status === 403 && a.code === 'peer_door', `${what}: ${a.status} ${a.text}`);
    // The neighbouring write and read doors refuse it the same way, so the import's refusal is the rule for every door outside the sync doors.
    restRefused(await d.rest(peer.key, 'POST', `/api/brain/spaces/${PEER}/entities`, { name: 'By a peer', type: 'person' }), 'POST entities');
    mcpRefused(await viaMcp('save_entity', { space: PEER, name: 'By a peer, by tool', type: 'person' }), 'save_entity');
    restRefused(await d.importRest(peer.key, PEER, goodTurtle(PEER)), 'REST import');
    mcpRefused(await viaMcp('import_rdf', { space: PEER, document: goodTurtle(PEER), format: 'turtle' }), 'import_rdf');
    assert.deepEqual(d.actsOf(PEER), [], 'no act was registered');
    assert.deepEqual(await d.records(PEER, 'entities'), [], 'something was written for a peer-bound token');
    // The status doors read, and are refused as well: a peer-bound token learns nothing of an import of this space.
    const missing = '00000000-0000-4000-8000-000000000000';
    restRefused(await d.statusRest(peer.key, PEER, missing), 'REST status');
    mcpRefused(await viaMcp('import_rdf_status', { space: PEER, importId: missing }), 'import_rdf_status');
    // Control: a token not bound to a peer, with the same rungs on the same space, writes through the neighbouring door, so the refusals above are about the token kind.
    const control = await d.rest(writer.key, 'POST', `/api/brain/spaces/${PEER}/entities`, { name: 'By a writer', type: 'person' });
    assert.ok(control.status < 300, `control: a token not bound to a peer was refused the neighbouring write door: ${control.status} ${control.text.slice(0, 200)}`);
    assert.deepEqual((await d.records(PEER, 'entities')).map(e => e.name), ['By a writer'], 'only the control\'s record exists: nothing a peer-bound token sent landed');
  });
});
