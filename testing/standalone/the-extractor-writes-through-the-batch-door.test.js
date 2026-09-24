/**
 * Phase 10 of the conversation extractor: an extraction is written into a space THROUGH THE BATCH DOOR
 * (`bulkWrite`), never through the bare record writers.
 *
 * The bare writers (`saveFact`, `upsertEntity`, …) do not validate: schema validation, strict linkage and the
 * shape rules live in the door that calls them. An `ingest` that called them directly would store what every
 * other door refuses, which is the forgettable guard this module exists to keep. So the writer is handed the
 * door, and this test hands it a fake that records what it was asked.
 *
 * What the order buys, and what the writer owes the door:
 *  - entities, then claims, then chrono, then edges, then transcripts — each names ids the step before minted;
 *  - an entity the space already held is linked BY ID and never written again;
 *  - a claim carries `superseded`, and an attributed one is written unranked (`suppressEmbeddings`);
 *  - a claim's own chrono entries link to it (the format's `claim.chrono`, which the benchmark writer ignored);
 *  - a supersedes edge runs claim → claim, and says so (`fromKind`/`toKind: 'fact'`);
 *  - `sourceTurns` are returned to the caller and stored in no record.
 *
 * Run: node --test testing/standalone/the-extractor-writes-through-the-batch-door.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let writeExtraction, validateExtraction;
before(async () => {
  ({ writeExtraction } = await import('../../server/dist/extractor/conversation/write-extraction.js'));
  ({ validateExtraction } = await import('../../server/dist/extractor/validate-extraction.js'));
});
const SCHEMA = JSON.parse(readFileSync('benchmarks/space/schema.json', 'utf8'));
const CLAIM_TYPE = SCHEMA.find(e => e.knowledgeType === 'fact').typeName;
const EXISTING = '9b2f6c1e-4d3a-4f8b-9c7d-1e2f3a4b5c6d';

function extraction() {
  return {
    conversationId: 'conv-w',
    sessions: [
      { date: '2023-05-10', turns: ['s1:1', 's1:2'], text: 'Ada: We adopted Luna!\nBo: Congrats!' },
      { date: '2023-06-01', turns: ['s2:1'], text: 'Ada: Luna is a therapy cat now.' },
    ],
    entities: [
      { key: 'ada', type: 'person', name: 'Ada', description: 'Ada adopted Luna.', sourceTurns: ['s1:1'] },
      { key: 'luna', type: 'animal', name: 'Luna', description: 'Luna is a cat.', properties: { aliases: 'the cat' } },
    ],
    existingEntities: [{ key: 'caroline', id: EXISTING, type: 'person' }],
    edges: [
      { label: 'owns', from: 'ada', to: 'luna' },
      { label: 'supersedes', from: 'claim-later', to: 'claim-earlier' },
    ],
    chrono: [{ key: 'adoption', type: 'event', title: 'Ada adopted Luna', date: '2023-05-09', status: 'completed', entities: ['ada', 'luna'], sourceTurns: ['s1:1'] }],
    claims: [
      { key: 'claim-earlier', text: 'Luna lives with Ada and Caroline.', speaker: 'Ada', statedOn: '2023-05-10', superseded: true, entities: ['luna', 'ada', 'caroline'], chrono: ['adoption'], sourceTurns: ['s1:1', 's1:2'] },
      { key: 'claim-later', text: 'Luna lives with Ada as a therapy cat.', speaker: 'Ada', statedOn: '2023-06-01', entities: ['luna', 'ada'], sourceTurns: ['s2:1'] },
      { text: 'Ada was told Luna is a common cat name.', speaker: 'assistant', statedOn: '2023-05-10', attributed: true, entities: ['ada'], sourceTurns: ['s1:2'] },
    ],
    producedBy: { extractor: 'ythril-conversation', unattended: true, backends: ['jev'] },
  };
}

/** A fake batch door: records every call, mints `id:<ref>` for each key, refuses what `refuse` names. */
function fakeDoor({ refuse = () => false } = {}) {
  const calls = [];
  const files = [];
  return {
    calls, files,
    writers: {
      bulk: async (spaceId, input) => {
        calls.push(JSON.parse(JSON.stringify(input)));
        const refs = {}, errors = [];
        for (const [coll, kind] of [['entities', 'entity'], ['facts', 'fact'], ['chrono', 'chrono'], ['edges', 'edge']]) {
          (input[coll] ?? []).forEach((item, index) => {
            if (refuse(coll, item)) { errors.push({ type: kind, index, reason: 'schema_violation: refused by the test' }); return; }
            if (item.$ref) refs[item.$ref] = { id: `id:${item.$ref}`, kind };
          });
        }
        return { inserted: {}, updated: {}, connections: { links: 0, edges: 0 }, errors, refs };
      },
      storeFile: async (spaceId, path, bytes, opts) => { files.push({ path, text: bytes.toString('utf8'), opts }); return { sha256: 'x', sizeBytes: bytes.length }; },
      linkFile: async (spaceId, path, links) => { files.find(f => f.path === path).links = links; },
    },
  };
}

const write = (door, x = extraction()) => writeExtraction('space-1', x, { schemaEntries: SCHEMA, claimType: CLAIM_TYPE, transcripts: true }, door.writers);

describe('the validator knows the entities a space already holds', () => {
  it('an existing entity key is an entity key, and its id must be one', () => {
    const x = extraction();
    const problems = (y) => validateExtraction(y, SCHEMA).filter(p => !/producedBy/.test(p));
    assert.deepEqual(problems(x), []);
    x.existingEntities[0].id = 'not-a-uuid';
    assert.match(problems(x).join('\n'), /caroline.*UUID|UUID.*caroline/);
  });
});

describe('phase 10: through the batch door, in order', () => {
  it('entities, claims, chrono, edges — one batch each, in that order', async () => {
    const door = fakeDoor();
    await write(door);
    assert.deepEqual(door.calls.map(c => Object.keys(c)), [['entities'], ['facts'], ['chrono'], ['edges']]);
  });

  it('an existing entity is linked by id and never written', async () => {
    const door = fakeDoor();
    await write(door);
    const [entities, facts] = door.calls;
    assert.ok(!entities.entities.some(e => e.name === 'Caroline'));
    assert.ok(facts.facts[0].linkEntities.includes(EXISTING));
    assert.ok(facts.facts[0].linkEntities.includes('id:ada'), 'ids minted by the entity batch reach the claims');
  });

  it('an entity is written with its description, and its key is its $ref', async () => {
    const door = fakeDoor();
    await write(door);
    assert.deepEqual(door.calls[0].entities[0], { $ref: 'ada', name: 'Ada', type: 'person', description: 'Ada adopted Luna.' });
    assert.deepEqual(door.calls[0].entities[1].properties, { aliases: 'the cat' });
  });

  it('a claim: its type, speaker and date as properties; superseded kept; attributed written unranked', async () => {
    const door = fakeDoor();
    await write(door);
    const [earlier, later, attributed] = door.calls[1].facts;
    assert.equal(earlier.type, CLAIM_TYPE);
    assert.deepEqual(earlier.properties, { speaker: 'Ada', statedOn: '2023-05-10' });
    assert.equal(earlier.superseded, true);
    assert.equal(later.superseded, undefined, 'absent, never false');
    assert.equal(attributed.suppressEmbeddings, true);
    assert.equal(attributed.properties.attributed, true);
    assert.ok(!JSON.stringify(door.calls).includes('s1:1'), 'no turn id is stored in any record');
  });

  it('a chrono entry links its entities AND the claims that dated it', async () => {
    const door = fakeDoor();
    await write(door);
    const [c] = door.calls[2].chrono;
    assert.deepEqual({ title: c.title, startsAt: c.startsAt, status: c.status }, { title: 'Ada adopted Luna', startsAt: '2023-05-09', status: 'completed' });
    assert.deepEqual(c.linkEntities, ['id:ada', 'id:luna']);
    assert.deepEqual(c.linkFacts, [door.calls[1].facts[0].$ref].map(k => `id:${k}`));
  });

  it('edges resolve to ids; supersedes names its ends as facts', async () => {
    const door = fakeDoor();
    await write(door);
    const [owns, sup] = door.calls[3].edges;
    assert.deepEqual(owns, { from: 'id:ada', to: 'id:luna', label: 'owns' });
    assert.equal(sup.label, 'supersedes');
    assert.equal(sup.fromKind, 'fact');
    assert.equal(sup.toKind, 'fact');
    assert.equal(sup.to, `id:${door.calls[1].facts[0].$ref}`);
  });

  it('each session becomes a transcript under the conversation, linked to its claims and entities', async () => {
    const door = fakeDoor();
    await write(door);
    assert.deepEqual(door.files.map(f => f.path), ['transcripts/conv-w/2023-05-10.md', 'transcripts/conv-w/2023-06-01.md']);
    assert.equal(door.files[0].text, 'Ada: We adopted Luna!\nBo: Congrats!');
    assert.deepEqual(door.files[0].opts.meta.tags, ['transcript']);
    assert.equal(door.files[0].links.linkFacts.length, 2, 'the two claims stated that day');
    assert.ok(door.files[0].links.linkEntities.includes(EXISTING));
  });

  it('transcripts are written only when the caller may write files', async () => {
    const door = fakeDoor();
    const r = await writeExtraction('space-1', extraction(), { schemaEntries: SCHEMA, claimType: CLAIM_TYPE, transcripts: false }, door.writers);
    assert.equal(door.files.length, 0);
    assert.equal(r.written.transcripts, 0);
    assert.equal(door.calls.length, 4, 'the records are still written');
  });

  it('sourceTurns come back keyed by record id, and nothing else carries them', async () => {
    const door = fakeDoor();
    const r = await write(door);
    assert.deepEqual(r.sourceTurns[`id:${door.calls[1].facts[0].$ref}`], ['s1:1', 's1:2']);
    assert.deepEqual(r.sourceTurns['id:ada'], ['s1:1']);
    assert.deepEqual(r.sourceTurns['id:adoption'], ['s1:1']);
  });
});

describe('what the door refuses is reported, and nothing points at it', () => {
  it('a refused entity is reported by key, and no claim, chrono entry or edge links to it', async () => {
    const door = fakeDoor({ refuse: (coll, item) => coll === 'entities' && item.$ref === 'luna' });
    const r = await write(door);
    // The edge is reported rather than sent: an end that was never written would store a dangling edge.
    assert.deepEqual(r.errors.map(e => [e.phase, e.key]), [['entities', 'luna'], ['edges', 'ada owns luna']]);
    assert.ok(!JSON.stringify(door.calls.slice(1)).includes('id:luna'));
    assert.equal(door.calls[3].edges.some(e => e.label === 'owns'), false, 'an edge with a missing end is not sent');
    assert.ok(r.errors.length >= 1);
  });

  it('an extraction the validator refuses writes nothing at all', async () => {
    const door = fakeDoor();
    const x = extraction();
    x.entities[0].type = 'not-a-type';
    await assert.rejects(write(door, x), /not-a-type/);
    assert.equal(door.calls.length, 0);
    assert.equal(door.files.length, 0);
  });

  it('a batch over the door\'s cap is split, never truncated', async () => {
    const door = fakeDoor();
    // One turn per claim — a single turn behind a thousand claims is refused as a mined document.
    const turns = Array.from({ length: 1201 }, (_, i) => `s1:${i + 1}`);
    const x = extraction();
    x.sessions = [{ date: '2023-05-10', turns }];
    x.chrono = [];
    x.claims = turns.map((t, i) => ({ text: `Ada said thing ${i}.`, speaker: 'Ada', statedOn: '2023-05-10', entities: ['ada'], sourceTurns: [t] }));
    x.edges = x.edges.filter(e => e.label !== 'supersedes');
    const r = await write(door, x);
    const factCalls = door.calls.filter(c => c.facts);
    assert.deepEqual(factCalls.map(c => c.facts.length), [500, 500, 201]);
    assert.equal(r.written.claims, 1201);
  });
});
