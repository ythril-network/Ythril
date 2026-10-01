/**
 * A record that a create/converge writer CONVERGES on is re-embedded from its new content — on every writer,
 * through every door that reaches it.
 *
 * ## The defect (`Q-192`)
 *
 * A create that names an existing record by id converges on it: tags union, properties merge, the content
 * fields take the new values. The stored vector then describes the record as it was a moment ago, and the
 * embed queue is what makes it catch up — `saveFact` and `upsertEntity` say so in as many words, and enqueue.
 *
 * `createChrono`'s converge branch did not. It stored the new `matchedText` beside the OLD vector and queued
 * nothing — so a chrono entry re-sent with a changed title was found, by meaning, as the entry it used to
 * be, for ever: nothing comes back to a record no job names. The bulk importer reaches the same branch, so a
 * batch of corrected chrono items had the same outcome a hundred at a time.
 *
 * ## The rule, not the site
 *
 * Asserted over every create/converge writer (fact, entity, chrono, edge) and over both doors that reach them
 * — the single writer and `bulkWrite`. The writers that already enqueue are not decoration: they prove the
 * case is measuring the queue rather than an artefact of how it seeds, and they hold the rule for the next
 * writer added beside them.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-converged-record-is-re-embedded-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-converge-reembed-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const A = 'aaaaaaaa-0000-4000-8000-0000000c0a01';
const B = 'aaaaaaaa-0000-4000-8000-0000000c0b02';

let mongo, factMod, entMod, edgeMod, chronoMod, bulkMod;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const jobsFor = (id) => coll('embed_jobs').countDocuments({ recordId: id });
const COLLECTION = { fact: 'facts', entity: 'entities', edge: 'edges', chrono: 'chrono' };

/**
 * Per writer: how to seed a record, and how to converge on it with CHANGED content through each door.
 *
 * `newText` is a string the converged record's stored embed text must contain — what tells "the new content
 * reached the embed input" apart from "something was stored". `null` for an edge, whose `matchedText` is
 * written by the inline path alone (the queued job resolves the endpoint names itself).
 */
const WRITERS = {
  fact: {
    seed: async () => (await factMod.saveFact(SPACE, 'the original fact', [], ['old'], 'old description',
      undefined, 'note'))._id,
    single: (id) => factMod.saveFact(SPACE, 'the CORRECTED fact', [], ['new-tag'], 'new description',
      undefined, 'note', undefined, undefined, undefined, id),
    bulk: (id) => ({ facts: [{ id, fact: 'the CORRECTED fact', tags: ['new-tag'], description: 'new description', type: 'note' }] }),
    newText: 'CORRECTED',
  },
  entity: {
    seed: async () => (await entMod.upsertEntity(SPACE, 'Original', 'concept', ['old'], {}, 'old description')).entity._id,
    single: (id) => entMod.upsertEntity(SPACE, 'CORRECTED', 'concept', ['new-tag'], {}, 'new description', id),
    bulk: (id) => ({ entities: [{ id, name: 'CORRECTED', type: 'concept', tags: ['new-tag'], description: 'new description' }] }),
    newText: 'CORRECTED',
  },
  edge: {
    // An edge converges by its triplet rather than by an id, so "the same record re-sent" is the same triplet.
    seed: async () => (await edgeMod.upsertEdge(SPACE, A, B, 'knows', undefined, undefined, 'old description',
      undefined, ['old']))._id,
    single: () => edgeMod.upsertEdge(SPACE, A, B, 'knows', undefined, undefined, 'the CORRECTED description',
      undefined, ['new-tag']),
    bulk: () => ({ edges: [{ from: A, to: B, label: 'knows', description: 'the CORRECTED description', tags: ['new-tag'] }] }),
    newText: null,
  },
  chrono: {
    seed: async () => (await chronoMod.createChrono(SPACE, {
      title: 'the original event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z',
      description: 'old description', tags: ['old'],
    }))._id,
    single: (id) => chronoMod.createChrono(SPACE, {
      id, title: 'the CORRECTED event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z',
      description: 'new description', tags: ['new-tag'],
    }),
    bulk: (id) => ({ chrono: [{ id, title: 'the CORRECTED event', type: 'event', startsAt: '2026-01-01T00:00:00.000Z',
      description: 'new description', tags: ['new-tag'] }] }),
    newText: 'CORRECTED',
  },
};

describe('a converged record is re-embedded from its new content', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('convergereembed');
    const loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'converge-reembed-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    factMod = await import('../../server/dist/brain/fact.js');
    entMod = await import('../../server/dist/brain/entities.js');
    edgeMod = await import('../../server/dist/brain/edges.js');
    chronoMod = await import('../../server/dist/brain/chrono.js');
    bulkMod = await import('../../server/dist/brain/bulk.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'embed_jobs', 'tombstones', 'links']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertMany([
      { _id: A, spaceId: SPACE, name: 'A', type: 'person', tags: [], seq: 1 },
      { _id: B, spaceId: SPACE, name: 'B', type: 'person', tags: [], seq: 1 },
    ]);
  });

  it('every writer and both doors are reachable (the suite cannot pass by importing nothing)', () => {
    for (const fn of [factMod.saveFact, entMod.upsertEntity, edgeMod.upsertEdge, chronoMod.createChrono, bulkMod.bulkWrite]) {
      assert.equal(typeof fn, 'function');
    }
    assert.deepEqual(Object.keys(WRITERS).sort(), Object.keys(COLLECTION).sort());
  });

  for (const [kind, w] of Object.entries(WRITERS)) {
    for (const door of ['single', 'bulk']) {
      it(`a ${kind} converged through the ${door} door with changed content is queued for re-embedding`, async () => {
        const id = await w.seed();
        // The seed's own job is cleared, so the job asserted below can only be the converge's.
        await coll('embed_jobs').deleteMany({});

        if (door === 'single') {
          await w.single(id);
        } else {
          const res = await bulkMod.bulkWrite(SPACE, w.bulk(id));
          assert.deepEqual(res.errors, [], `the bulk converge was refused: ${JSON.stringify(res.errors)}`);
        }

        // Converged, not duplicated: the record is still the one at `id`, and it is the only one of its kind
        // apart from the two seeded endpoint entities.
        const others = await coll(COLLECTION[kind]).find({ _id: { $nin: [id, A, B] } }).project({ _id: 1 }).toArray();
        assert.deepEqual(others, [], `the ${kind} did not converge — a second record was written, so this case measures nothing`);
        const doc = await coll(COLLECTION[kind]).findOne({ _id: id });
        assert.ok(doc, 'the converged record is gone');
        assert.ok(doc.tags.includes('new-tag'), 'the new content did not reach the stored record');
        if (w.newText) {
          assert.match(doc.matchedText ?? '', new RegExp(w.newText),
            'the stored embed text still describes the record before the converge');
        }
        assert.equal(await jobsFor(id), 1,
          `the ${kind} converged on new content through the ${door} door and NO embed job was queued, so its `
          + 'stored vector describes the record as it was and nothing will ever come back to replace it — a '
          + 'meaning-ranked search finds it as the record it used to be');
      });
    }
  }
});
