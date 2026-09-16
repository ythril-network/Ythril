/**
 * The four UPDATE paths really do agree — against a real MongoDB, through the real functions.
 *
 * `one-merge-rule.test.js` pins the rule and gates the source. Neither can tell live code from dead
 * code: a grep-based version of this check would have passed happily while `updateFact` replaced the
 * properties map, because the replace was a `$set` and the merge helper it should have used was simply
 * absent. Only a write, then a read, settles it.
 *
 * ## The defect this exists for
 *
 * `update_fact`'s tool schema said `properties` were "to merge". `updateFact` did
 * `$set['properties'] = updates.properties` — a whole-map REPLACE. An agent patching one key silently
 * destroyed every other property on the record: no error, no warning, and the REST validation
 * simulation mirrored the same replace so the schema check could not see it either. `updateChrono`
 * had it too, through a generic `Object.entries(updates)` loop that treated `properties` like a scalar.
 *
 * So the test is written as ONE table over all four types, not four tests. The failure mode was
 * precisely that the types were handled in four places and nobody compared them.
 *
 * ## Why records are seeded directly rather than created through the writers
 *
 * The subject is the UPDATE path, and going through the creators made the test depend on a live
 * embedding model. Three of the four creators tolerate a missing embedder (`try { embed } catch`);
 * `saveFact` does not — it awaits `embed()` unguarded, so a memory is never stored without a vector.
 * That is defensible on its own terms (a memory with no embedding is invisible to recall), but it made
 * this suite pass on a laptop with a warm model cache and fail in CI with
 * `EACCES: permission denied, mkdir '/data'` — an environment difference reported as a merge defect.
 *
 * A test whose result depends on whether the machine happens to hold 274 MB of model weights is not
 * measuring what it claims to. Every row now seeds its document with one `insertOne`, uniformly, and
 * `YTHRIL_MODELS_OFFLINE=1` makes the update paths' guarded re-embed fail fast instead of reaching for
 * the network. Uniformity is deliberate too: a table where three rows take one route and the fourth
 * takes another invites exactly the divergence it is checking for.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/merge-rule-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const SPACE = 'general';

// Both read at module load, so both must be set before any dist import.
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-merge-rule-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
// No network, no cache probe, no 274 MB download. The update paths catch the failure and keep the
// stored embedding, which is exactly the behaviour under test here (none — this is about properties).
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

let mongo, brain;

/** The stored record, in every type: two properties and one tag, all of which must survive a patch. */
const STORED_PROPS = { owner: 'platform', rack: 'B12' };
/** The patch: one property the record already has, under a new value. Nothing else is mentioned. */
const PATCH_PROPS = { rack: 'C03' };
/** What every type must hold afterwards. `owner` surviving is the whole point. */
const MERGED_PROPS = { owner: 'platform', rack: 'C03' };

/** Fields every brain record carries, so each row below states only what makes it that type. */
const base = (id) => ({
  _id: id,
  spaceId: SPACE,
  tags: ['prod'],
  properties: { ...STORED_PROPS },
  author: { instanceId: 'self' },
  createdAt: '2026-08-01T00:00:00.000Z',
  updatedAt: '2026-08-01T00:00:00.000Z',
  seq: 1,
});

/**
 * One row per record type: how to seed it, how to patch it, how to read it back.
 *
 * `update` takes the patch so the same row serves both the properties case and the "says nothing about
 * properties" case — writing the dispatch twice is how the types drifted apart in the first place.
 */
const TYPES = [
  {
    name: 'entity',
    collection: 'entities',
    seed: (id) => ({ ...base(id), name: 'node-7', type: 'machine' }),
    update: (id, patch) => brain.entities.updateEntityById(SPACE, id, patch),
    unrelated: { description: 'unrelated' },
  },
  {
    name: 'edge',
    collection: 'edges',
    seed: (id) => ({ ...base(id), from: 'a-1', to: 'b-1', label: 'runs-on' }),
    update: (id, patch) => brain.edges.updateEdgeById(SPACE, id, patch),
    unrelated: { description: 'unrelated' },
  },
  {
    name: 'fact',
    collection: 'facts',
    seed: (id) => ({ ...base(id), fact: 'node-7 runs the platform apps', entityIds: [] }),
    update: (id, patch) => brain.fact.updateFact(SPACE, id, patch),
    unrelated: { description: 'unrelated' },
  },
  {
    name: 'chrono',
    collection: 'chrono',
    seed: (id) => ({
      ...base(id), title: 'rack move', type: 'event',
      startsAt: '2026-08-05T09:00:00.000Z', status: 'upcoming', entityIds: [], memoryIds: [],
    }),
    update: (id, patch) => brain.chrono.updateChrono(SPACE, id, patch),
    unrelated: { title: 'unrelated' },
  },
];

/** Seed one record of this type and return its id. */
async function seed(t, id) {
  await mongo.col(`${SPACE}_${t.collection}`).insertOne(t.seed(id));
  return id;
}

const load = (t, id) => mongo.col(`${SPACE}_${t.collection}`).findOne({ _id: id });

describe('one merge rule, four record types (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(
      { spaces: [{ id: SPACE, label: 'General' }], networks: [], tokens: [] }, null, 2,
    ));
    mongo = await openTestMongo('mergerule');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    brain = {
      entities: await import('../../server/dist/brain/entities.js'),
      edges: await import('../../server/dist/brain/edges.js'),
      fact: await import('../../server/dist/brain/fact.js'),
      chrono: await import('../../server/dist/brain/chrono.js'),
    };
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const t of TYPES) await mongo.col(`${SPACE}_${t.collection}`).deleteMany({});
  });

  for (const t of TYPES) {
    it(`${t.name}: a properties patch KEEPS the keys it does not mention`, async () => {
      const id = await seed(t, `${t.name}-1`);
      assert.deepEqual((await load(t, id)).properties, STORED_PROPS, 'precondition: both properties stored');

      const returned = await t.update(id, { properties: PATCH_PROPS });
      assert.ok(returned, `${t.name}: the update found no record to patch`);

      assert.deepEqual((await load(t, id)).properties, MERGED_PROPS,
        `${t.name} lost a property the patch never mentioned — this is the replace defect. Removing a `
        + 'key is deleteFields\' job; an absence must never mean "delete".');
      // The returned document is what an API caller sees. It is built separately from the `$set` on
      // some paths, which is its own way for the two to disagree.
      if (returned.properties) {
        assert.deepEqual(returned.properties, MERGED_PROPS,
          `${t.name}'s returned document disagrees with what was stored`);
      }
    });
  }

  it('all four types produce the SAME merged map from the same input', async () => {
    // The assertion the docs rely on and nothing enforced. Stated as one comparison rather than four
    // so a type drifting away fails here even if its own row above was updated to match it.
    const results = {};
    for (const t of TYPES) {
      const id = await seed(t, `${t.name}-same`);
      await t.update(id, { properties: PATCH_PROPS });
      results[t.name] = (await load(t, id)).properties;
    }
    assert.deepEqual(results, {
      entity: MERGED_PROPS, edge: MERGED_PROPS, fact: MERGED_PROPS, chrono: MERGED_PROPS,
    });
  });

  it('an absent properties field leaves the stored map alone', async () => {
    // `undefined` is the caller saying nothing. Reading it as `{}` would clear the map on any patch
    // that only touches another field.
    for (const t of TYPES) {
      const id = await seed(t, `${t.name}-absent`);
      await t.update(id, t.unrelated);
      assert.deepEqual((await load(t, id)).properties, STORED_PROPS,
        `${t.name}: a patch that says nothing about properties must not touch them`);
    }
  });

  it('an EMPTY properties map is a no-op, not a wipe', async () => {
    // `{}` is a caller who built a patch object and put nothing in it. It must not read as "clear".
    for (const t of TYPES) {
      const id = await seed(t, `${t.name}-empty`);
      await t.update(id, { properties: {} });
      assert.deepEqual((await load(t, id)).properties, STORED_PROPS,
        `${t.name}: an empty properties map must not clear the stored one`);
    }
  });
});
