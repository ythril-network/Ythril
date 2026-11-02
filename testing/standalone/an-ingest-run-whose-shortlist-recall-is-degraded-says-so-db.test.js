/**
 * An ingest run whose entity shortlist was drawn from an incomplete index proceeds and says so (Q-326, bundle-72 DESIGN v3
 * item 7; vet A-S10, P10).
 *
 * ## The rule
 *
 * The conversation extractor matches each mention against what the space already holds: `spaceEntitySearch` is a `recall`, and
 * the shortlist it deals is the judge's whole hand. While the space's entity index is being built or rebuilt (after an upgrade,
 * after a container recreate: 120 s and more) that recall silently answered fewer candidates, and a mention whose real entity
 * was not in the hand became a NEW entity: a duplicate, written with nobody told.
 *
 * Deferring the extraction was ruled out by the probe (P10): the run does not retry, a thrown deferral marks it `failed`. So the
 * run PROCEEDS with what lexical search, the fresh writes and the serving collections found, and its result records the reason:
 * an additive `degraded` on the run, the same closed vocabulary as recall's, so the caller knows entity matching ran on an
 * incomplete index and may re-run or review.
 *
 *  - the shortlist's recall degraded as `index_not_ready` (the index is being built): the run reaches `done`, and `run.degraded`
 *    holds `index_not_ready`.
 *  - degraded as `index_unavailable` (an index that exists and will not serve): the run reaches `done` all the same - it is not
 *    failed by one collection's index, which is what a thrown refusal did - and `run.degraded` holds `index_unavailable`.
 *  - an empty space (a new one, whose first conversation this is): reasonless, no `degraded` on the run. Passes on the base.
 *
 * ## How it reaches the seam
 *
 * The lightest suite that runs the real shortlist: `runIngest` with the production wiring's own shape (`ingest-door.ts`
 * `productionDeps`: `extractConversation` with `spaceEntitySearch(space)` as its `searchSpace`), the decision and writing models
 * and the NLP sidecar standing in as in `the-extractor-runs-end-to-end.test.js`, the write stubbed (what is written is another
 * file's subject), and the store REAL: the refusal is mongot's own wording, injected at the read over aged vectored entities.
 * If the implementation changes how the shortlist's reasons travel (a collector handed to `spaceEntitySearch`, a field on
 * `ExtractResult`), the `extract` wrapper below follows it; the assertions are on the RUN, which is the contract.
 *
 * "Seen red" on the base: the run reaches `done` with no `degraded` (index_not_ready), and `failed` with the mongot refusal
 * (index_unavailable).
 *
 * Needs a MongoDB with mongot (atlas-local): `npm run test:up`.
 *
 * Run: node --test testing/standalone/an-ingest-run-whose-shortlist-recall-is-degraded-says-so-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder, createSpaceCollections } from './_vector-harness.mjs';
import { REFUSALS, refuseVectorSearch } from './_mongot-refusals.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const OLDSPACE = 'ingdeg';       // aged vectored entities: the index matters
const NEWSPACE = 'ingnew';       // empty: the first conversation of a new space
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-ingdeg-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
process.env['YTHRIL_HYBRID_SEARCH'] = 'off';

const OLD = new Date(Date.now() - 3_600_000).toISOString();

const SCHEMA = JSON.parse(readFileSync('benchmarks/space/schema.json', 'utf8'));
const vocabulary = {
  entityTypes: Object.fromEntries(SCHEMA.filter(e => e.knowledgeType === 'entity').map(e => [e.typeName, e.description ?? e.typeName])),
  edgeLabels: Object.fromEntries(SCHEMA.filter(e => e.knowledgeType === 'edge').map(e => [e.typeName,
    { description: e.description ?? e.typeName, from: e.schema.endpoints.from, to: e.schema.endpoints.to }])),
};
const SESSIONS = [{ date: '2023-05-10', turns: [
  { speaker: 'Ada', role: 'person', text: 'We adopted a cat yesterday! Her name is Luna.' },
  { speaker: 'Bo', role: 'person', text: 'Congrats on Luna!' },
] }];

/** Capitalised words as entity spans, as the end-to-end extractor test's sidecar proposes them. */
const spans = async (texts) => texts.map(t => [...t.matchAll(/\b(Luna|Ada|Bo)\b/g)].map(m => ({ text: m[0], start: m.index, end: m.index + m[0].length, kind: 'entity' })));
/** The obvious answer to every question the extractor asks. */
const decide = async (state, questions) => {
  const answers = {};
  for (const [id, q] of Object.entries(questions)) {
    let a;
    if (q.type === 'noul') a = { noul: /^(thing|supported)/.test(id) ? 0.95 : 0.05 };
    else if (id.startsWith('type:')) a = { choice: /Luna/.test(JSON.stringify(q.instructions)) ? 'animal' : 'person' };
    else if (id.startsWith('match:')) a = { choice: Object.keys(q.criteria).find(k => k !== 'new' && k !== 'none') ?? 'new' };
    else if (id === 'status') a = { choice: 'completed' };
    else if (id.startsWith('rel:')) a = { choice: Object.keys(q.criteria).find(k => k.startsWith('owns:')) ?? 'none' };
    else if (id.startsWith('change:')) a = { choice: 'unchanged' };
    else if (q.criteria && 'continues' in q.criteria) a = { choice: /Congrats|Cute/.test(JSON.stringify(state)) ? 'continues' : 'starts' };
    else a = { choice: Object.keys(q.criteria ?? { none: 1 }).includes('none') ? 'none' : Object.keys(q.criteria)[0] };
    answers[id] = { type: q.type, probabilities: null, confidence: null, ...a };
  }
  return { backend: 'jev', model: 'jev-test', answers };
};
const write = async ({ user }) => (/^Entity: (.+?) \(/.test(user) ? `${user.match(/^Entity: (.+?) \(/)[1]} appears in the conversation.` : 'Ada adopted a cat named Luna.');

let mongo, stub, runIngest, parseIngestRequest, IngestRuns, extractConversation, spaceEntitySearch;

/** One ingest of the conversation into `space`, on the production wiring's shape, to the end. */
async function ingest(space) {
  const request = parseIngestRequest({ kind: 'conversation', conversationId: `conv-${space}`, sessions: SESSIONS });
  assert.ok(request.ok, request.error);
  const run = new IngestRuns().create(space);
  const deps = {
    extract: (conversationId, source, vocab) => extractConversation(conversationId, source, vocab, {
      decide, write, spans, searchSpace: spaceEntitySearch(space),
    }),
    // What is written is another file's subject; the run needs only an outcome to record.
    write: async () => ({ written: { entities: 0, claims: 0, chrono: 0, edges: 0, transcripts: 0 }, errors: [], ids: {}, sourceTurns: {} }),
  };
  const ctx = { declared: new Set(), schemaEntries: [], vocabulary, claimType: 'claim', group: [], validationMode: 'off' };
  await runIngest(run, space, request.request, ctx, deps, { transcripts: false });
  return run;
}

describe('an ingest run whose shortlist recall is degraded', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.mkdirSync(process.env['DATA_ROOT'], { recursive: true });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(
      { instanceId: 'ingdeg', instanceLabel: 'test', tokens: [], networks: [],
        spaces: [OLDSPACE, NEWSPACE].map(id => ({ id, label: id, folders: [] })) }, null, 2), { mode: 0o600 });
    mongo = await openTestMongo('ingdeg');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ runIngest, parseIngestRequest } = await import('../../server/dist/extractor/ingest.js'));
    ({ IngestRuns } = await import('../../server/dist/extractor/ingest-runs.js'));
    ({ extractConversation } = await import('../../server/dist/extractor/conversation/extract.js'));
    ({ spaceEntitySearch } = await import('../../server/dist/extractor/conversation/shortlist.js'));
    for (const id of [OLDSPACE, NEWSPACE]) await createSpaceCollections(mongo, id);
    await mongo.col(`${OLDSPACE}_entities`).insertMany(['Luna', 'Ada'].map((name, i) => ({
      _id: `old-${name}`, spaceId: OLDSPACE, name, type: name === 'Luna' ? 'animal' : 'person', tags: [], properties: {},
      description: `${name}, already known`, embedding: unitAt(10 * (i + 1), DIMS), embeddingModel: 'stub', seq: i + 1,
      createdAt: OLD, updatedAt: OLD })));
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('index_not_ready: the run proceeds to done, and its result carries the reason', async () => {
    const fault = refuseVectorSearch(REFUSALS.notInitialized);
    let run;
    try { run = await ingest(OLDSPACE); } finally { fault.restore(); }
    assert.ok(fault.refused() >= 1, 'the shortlist never reached the index - the case did not produce the state it is about');
    assert.equal(run.phase, 'done', `the run ${run.phase}: ${run.error ?? ''}`);
    assert.ok(Array.isArray(run.degraded) && run.degraded.includes('index_not_ready'),
      `run.degraded is ${JSON.stringify(run.degraded)}: the shortlist was drawn from an index that was being built over two known `
      + 'entities, so a mention of one may have become a duplicate, and nothing in the result says entity matching was incomplete');
  });

  it('index_unavailable: the run is not failed by one index, and its result carries the reason', async () => {
    const fault = refuseVectorSearch(REFUSALS.dimensionMismatch);
    let run;
    try { run = await ingest(OLDSPACE); } finally { fault.restore(); }
    assert.ok(fault.refused() >= 1, 'the shortlist never reached the index');
    assert.equal(run.phase, 'done', `the run ${run.phase}: ${run.error ?? ''}`);
    assert.ok(Array.isArray(run.degraded) && run.degraded.includes('index_unavailable'), `run.degraded is ${JSON.stringify(run.degraded)}`);
  });

  it('a new space (empty collections): done, and no degraded on the run', async () => {
    const fault = refuseVectorSearch(REFUSALS.notInitialized);
    let run;
    try { run = await ingest(NEWSPACE); } finally { fault.restore(); }
    assert.equal(run.phase, 'done', `the run ${run.phase}: ${run.error ?? ''}`);
    assert.ok(run.degraded === undefined || run.degraded.length === 0,
      `run.degraded is ${JSON.stringify(run.degraded)}: nothing exists for the index to miss in a space's first conversation`);
  });
});
