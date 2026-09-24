/**
 * `ingest` (`F-31`): the door that turns a conversation into records. What is tested here is the part a model never
 * touches — the request shape, the refusals made BEFORE any model is paid for (DECOMPOSITION phase 0), and the life
 * of a run — with the pipeline and the writer handed in as stand-ins.
 *
 * Phase 0 exists because a run is minutes of model calls. A space that cannot hold the records, or an instance with
 * no model to judge them, is refused up front and names what is missing — never discovered after the bill.
 *
 * Run: node --test testing/standalone/the-ingest-door-refuses-before-it-pays.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let parseIngestRequest, ingestRefusals, spaceContextFrom, IngestRuns, runIngest, shippedLibraryEntries;
before(async () => {
  ({ parseIngestRequest, ingestRefusals, spaceContextFrom, runIngest } = await import('../../server/dist/extractor/ingest.js'));
  ({ IngestRuns } = await import('../../server/dist/extractor/ingest-runs.js'));
  ({ shippedLibraryEntries } = await import('../../server/dist/config/shipped-library-entries.js'));
});

const SESSIONS = [{ date: '2023-05-10', turns: [{ speaker: 'Ada', text: 'We adopted Luna!' }, { speaker: 'Bo', text: 'Congrats!' }] }];

/** A space meta that declares the whole group, resolved — what `resolveMetaRefs` hands back after a group apply. */
function groupMeta(drop = []) {
  const typeSchemas = {};
  for (const e of shippedLibraryEntries()) {
    if (drop.includes(e.typeName)) continue;
    (typeSchemas[e.knowledgeType] ??= {})[e.typeName] = e.schema;
  }
  return { typeSchemas };
}

const ok = { decision: () => {}, generation: () => {}, nlp: async () => true };

describe('the request', () => {
  it('a raw conversation, or an extraction already made — exactly one', () => {
    assert.equal(parseIngestRequest({ kind: 'conversation', sessions: SESSIONS }).ok, true);
    assert.equal(parseIngestRequest({ kind: 'conversation', extraction: { conversationId: 'c' } }).ok, true);
    assert.match(parseIngestRequest({ kind: 'conversation', sessions: SESSIONS, extraction: {} }).error, /exactly one/);
    assert.match(parseIngestRequest({ kind: 'conversation' }).error, /exactly one/);
  });
  it('a key the door does not know is refused by name, not carried and ignored', () => {
    const r = parseIngestRequest({ kind: 'conversation', sessions: SESSIONS, session: [] });
    assert.equal(r.ok, false);
    assert.match(r.error, /session\b/);
  });
  it('an unknown kind names the kinds there are', () => {
    assert.match(parseIngestRequest({ kind: 'email', sessions: SESSIONS }).error, /conversation/);
  });
  it('a malformed conversation is refused with every problem, before a run exists', () => {
    const r = parseIngestRequest({ kind: 'conversation', sessions: [{ turns: [] }] });
    assert.equal(r.ok, false);
    assert.match(r.error, /date/);
  });
  it('the conversation id is the caller\'s when given, and derived when not', () => {
    assert.equal(parseIngestRequest({ kind: 'conversation', conversationId: 'chat-7', sessions: SESSIONS }).request.conversationId, 'chat-7');
    assert.match(parseIngestRequest({ kind: 'conversation', sessions: SESSIONS }).request.conversationId, /^conversation-2023-05-10/);
    assert.match(parseIngestRequest({ kind: 'conversation', conversationId: '../etc', sessions: SESSIONS }).error, /conversationId/);
  });
});

describe('phase 0: refused before anything is paid for', () => {
  const raw = () => parseIngestRequest({ kind: 'conversation', sessions: SESSIONS }).request;

  it('a space missing group types is refused, naming them and the apply that adds them', async () => {
    const refusals = await ingestRefusals(raw(), spaceContextFrom(groupMeta(['animal', 'owns'])), ok);
    const text = refusals.join('\n');
    assert.match(text, /entity 'animal'/);
    assert.match(text, /edge 'owns'/);
    assert.match(text, /schema-library\/groups\/conversation\/apply/);
  });

  it('each missing model names its setting', async () => {
    const none = { decision: () => { throw new Error('no decision model'); }, generation: () => { throw new Error('no assist model'); }, nlp: async () => false };
    const text = (await ingestRefusals(raw(), spaceContextFrom(groupMeta()), none)).join('\n');
    assert.match(text, /decision/i);
    assert.match(text, /assist/i);
    assert.match(text, /doc-nlp|NLP/);
  });

  it('an extraction already made needs no model — only the space', async () => {
    const request = parseIngestRequest({ kind: 'conversation', extraction: { conversationId: 'c' } }).request;
    const none = { decision: () => { throw new Error('x'); }, generation: () => { throw new Error('x'); }, nlp: async () => false };
    assert.deepEqual(await ingestRefusals(request, spaceContextFrom(groupMeta()), none), []);
  });

  it('a space with the whole group and every model is not refused', async () => {
    assert.deepEqual(await ingestRefusals(raw(), spaceContextFrom(groupMeta()), ok), []);
  });
});

describe('a run', () => {
  const extraction = { conversationId: 'c', sessions: [{ date: '2023-05-10', turns: ['2023-05-10:1'] }], entities: [], existingEntities: [], edges: [], chrono: [], claims: [] };

  it('goes queued → extracting → writing → done, and reports what was written', async () => {
    const runs = new IngestRuns();
    const run = runs.create('space-1');
    const seen = [];
    await runIngest(run, 'space-1', parseIngestRequest({ kind: 'conversation', sessions: SESSIONS }).request, spaceContextFrom(groupMeta()), {
      extract: async () => { seen.push(run.phase); return { extraction, judgements: [{}], dropped: [{ reason: 'not supported' }], uncovered: ['x'] }; },
      write: async (spaceId, x) => { seen.push(run.phase); assert.equal(x.sessions[0].text, 'Ada: We adopted Luna!\nBo: Congrats!'); return { written: { entities: 0, claims: 0, chrono: 0, edges: 0, transcripts: 1 }, ids: { ada: 'id-1' }, sourceTurns: { 'id-1': ['2023-05-10:1'] }, errors: [] }; },
    });
    assert.deepEqual(seen, ['extracting', 'writing']);
    assert.equal(run.phase, 'done');
    assert.equal(run.written.transcripts, 1);
    assert.equal(run.dropped.length, 1);
    assert.deepEqual(run.uncovered, ['x']);
    // Provenance, reported rather than stored: each key's record id, and which turns each record came from.
    assert.deepEqual(run.ids, { ada: 'id-1' });
    assert.deepEqual(run.sourceTurns, { 'id-1': ['2023-05-10:1'] });
    assert.ok(run.finishedAt);
  });

  it('an extraction already made skips straight to writing', async () => {
    const runs = new IngestRuns();
    const run = runs.create('space-1');
    let extracted = false;
    await runIngest(run, 'space-1', parseIngestRequest({ kind: 'conversation', extraction }).request, spaceContextFrom(groupMeta()), {
      extract: async () => { extracted = true; },
      write: async () => ({ written: { entities: 0, claims: 0, chrono: 0, edges: 0, transcripts: 0 }, ids: {}, sourceTurns: {}, errors: [] }),
    });
    assert.equal(extracted, false);
    assert.equal(run.phase, 'done');
  });

  it('a failure is recorded on the run as failed, with the message — never thrown into nothing', async () => {
    const runs = new IngestRuns();
    const run = runs.create('space-1');
    await runIngest(run, 'space-1', parseIngestRequest({ kind: 'conversation', sessions: SESSIONS }).request, spaceContextFrom(groupMeta()), {
      extract: async () => { throw new Error('the decision model answered 529'); },
      write: async () => { throw new Error('unreachable'); },
    });
    assert.equal(run.phase, 'failed');
    assert.match(run.error, /529/);
  });

  it('transcripts follow the file rights of the caller, and a run that skipped them says so', async () => {
    const runs = new IngestRuns();
    const run = runs.create('space-1');
    let asked;
    await runIngest(run, 'space-1', parseIngestRequest({ kind: 'conversation', extraction }).request, spaceContextFrom(groupMeta()), {
      extract: async () => {},
      write: async (spaceId, x, opts) => { asked = opts.transcripts; return { written: { entities: 0, claims: 0, chrono: 0, edges: 0, transcripts: 0 }, ids: {}, sourceTurns: {}, errors: [] }; },
    }, { transcripts: false });
    assert.equal(asked, false);
    assert.match(run.transcripts, /files/);
  });

  it('a run is found only under the space it was started in', () => {
    const runs = new IngestRuns();
    const run = runs.create('space-1');
    assert.equal(runs.get('space-1', run.runId), run);
    assert.equal(runs.get('space-2', run.runId), undefined);
  });

  it('the registry is bounded: the oldest finished runs go first, a running one never', () => {
    const runs = new IngestRuns(3);
    const first = runs.create('s');
    const done = [runs.create('s'), runs.create('s')];
    for (const r of done) r.phase = 'done';
    runs.create('s');
    assert.ok(runs.get('s', first.runId), 'still running, so kept');
    assert.equal(runs.get('s', done[0].runId), undefined, 'the oldest finished run was evicted');
  });
});
