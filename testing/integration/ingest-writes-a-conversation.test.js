/**
 * `ingest` on a live instance (`F-31`), both doors: an extraction already made is validated and written, and the run
 * reports what it wrote — the records read back by the ids the run produced, not counted.
 *
 * The `extraction` body is the one kind a test stack can run end to end: it asks no model. The raw `sessions` kind
 * is the same door and the same writer with the extractor in front, and the extractor is tested with stand-ins
 * (`the-extractor-runs-end-to-end.test.js`); what only a live instance can show is that the door, the shipped
 * Schema Library group, the space's own rules and the batch writer agree.
 *
 * Also here: the refusals made BEFORE a run exists — a space without the `conversation` group is refused and told
 * which types to add, on both doors in the same words.
 *
 * Run: node --test testing/integration/ingest-writes-a-conversation.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody, readCollection, waitFor } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const WITH_GROUP = `ingest-group-${RUN}`;
const WITHOUT_GROUP = `ingest-bare-${RUN}`;

let token;
let mcp;

before(async () => {
  token = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  mcp = await openMcpSession(token);
  for (const id of [WITH_GROUP, WITHOUT_GROUP]) {
    const r = await post(INSTANCES.a, token, '/api/spaces', { id, label: id });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  const applied = await post(INSTANCES.a, token, '/api/schema-library/groups/conversation/apply', { spaceId: WITH_GROUP });
  assert.equal(applied.status, 200, `the shipped conversation group is not in the library: ${JSON.stringify(applied.body)}`);
});

after(async () => {
  for (const id of [WITH_GROUP, WITHOUT_GROUP]) await delWithBody(INSTANCES.a, token, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
});

function extraction(conversationId) {
  return {
    conversationId,
    sessions: [{ date: '2023-05-10', turns: ['s1:1', 's1:2'], text: 'Ada: We adopted Luna yesterday!\nBo: Congrats!' }],
    entities: [
      { key: 'ada', type: 'person', name: `Ada ${conversationId}`, description: 'Ada adopted a cat named Luna on 9 May 2023.', sourceTurns: ['s1:1'] },
      { key: 'luna', type: 'animal', name: `Luna ${conversationId}`, description: 'Luna is a cat Ada adopted on 9 May 2023.', sourceTurns: ['s1:1'] },
    ],
    existingEntities: [],
    edges: [{ label: 'owns', from: 'ada', to: 'luna' }],
    chrono: [{ key: 'adoption', type: 'event', title: 'Ada adopted Luna', date: '2023-05-09', status: 'completed', entities: ['ada', 'luna'], sourceTurns: ['s1:1'] }],
    claims: [{ text: `Ada adopted a cat named Luna on 9 May 2023 (${conversationId}).`, speaker: 'Ada', statedOn: '2023-05-10', entities: ['ada', 'luna'], chrono: ['adoption'], sourceTurns: ['s1:1', 's1:2'] }],
    producedBy: { extractor: 'ythril-conversation', unattended: true, backends: ['test'] },
  };
}

const DOORS = [
  ['REST',
    async (space, body) => {
      const r = await post(INSTANCES.a, token, `/api/brain/spaces/${space}/ingest`, body);
      return { status: r.status, body: r.body };
    },
    async (space, runId) => (await get(INSTANCES.a, token, `/api/brain/spaces/${space}/ingest/${runId}`)).body,
  ],
  ['MCP',
    async (space, body) => {
      const r = await mcp.callTool('ingest', { space, ...body });
      return r?.isError ? { status: 'refused', body: { error: r.content?.[0]?.text } } : { status: 202, body: r.structuredContent };
    },
    async (space, runId) => (await mcp.callTool('ingest_status', { space, runId }))?.structuredContent,
  ],
];

describe('an extraction is validated and written, and the run says what it wrote', () => {
  for (const [door, start, status] of DOORS) {
    it(`${door}: entities, a claim, a dated event, an edge and a transcript`, async () => {
      const id = `conv-${door.toLowerCase()}-${RUN}`;
      const r = await start(WITH_GROUP, { kind: 'conversation', extraction: extraction(id) });
      assert.equal(r.status, 202, JSON.stringify(r.body));
      let run;
      await waitFor(async () => { run = await status(WITH_GROUP, r.body.runId); return run?.phase === 'done' || run?.phase === 'failed'; }, 60_000);
      assert.equal(run.phase, 'done', JSON.stringify(run));
      assert.deepEqual(run.written, { entities: 2, claims: 1, chrono: 1, edges: 1, transcripts: 1 }, JSON.stringify(run));
      assert.deepEqual(run.writeErrors, []);

      const ada = await readCollection(INSTANCES.a, token, WITH_GROUP, 'entities', { filter: { name: `Ada ${id}` }, limit: 2 });
      assert.equal(ada.results.length, 1, 'the entity was written once');
      assert.match(ada.results[0].description, /adopted a cat named Luna/, 'the description is written');
      const edges = await readCollection(INSTANCES.a, token, WITH_GROUP, 'edges', { filter: { from: ada.results[0]._id }, limit: 5 });
      assert.deepEqual(edges.results.map(e => e.label), ['owns']);
      const claim = await readCollection(INSTANCES.a, token, WITH_GROUP, 'facts', { filter: { fact: `Ada adopted a cat named Luna on 9 May 2023 (${id}).` }, limit: 2 });
      assert.equal(claim.results.length, 1);
      assert.equal(claim.results[0].type, 'utterance');
      assert.deepEqual(claim.results[0].properties, { speaker: 'Ada', statedOn: '2023-05-10' }, 'no turn id is stored');
      const file = await get(INSTANCES.a, token, `/api/files/${WITH_GROUP}?path=${encodeURIComponent(`transcripts/${id}/2023-05-10.md`)}`);
      assert.equal(file.status, 200, 'the transcript was written under the conversation');
    });

    it(`${door}: a space without the conversation group is refused, naming what to add`, async () => {
      const r = await start(WITHOUT_GROUP, { kind: 'conversation', extraction: extraction(`bare-${door}-${RUN}`) });
      assert.notEqual(r.status, 202);
      assert.match(r.body.error, /entity 'person'/);
      assert.match(r.body.error, /groups\/conversation\/apply/);
    });

    it(`${door}: a body with both kinds is refused before a run exists`, async () => {
      const r = await start(WITH_GROUP, { kind: 'conversation', extraction: extraction('x'), sessions: [] });
      assert.notEqual(r.status, 202);
      assert.match(r.body.error, /exactly one/);
    });
  }

  it('a run is found only under the space it was started in', async () => {
    const r = await post(INSTANCES.a, token, `/api/brain/spaces/${WITH_GROUP}/ingest`, { kind: 'conversation', extraction: extraction(`scoped-${RUN}`) });
    assert.equal(r.status, 202, JSON.stringify(r.body));
    const other = await get(INSTANCES.a, token, `/api/brain/spaces/${WITHOUT_GROUP}/ingest/${r.body.runId}`);
    assert.equal(other.status, 404);
  });
});
