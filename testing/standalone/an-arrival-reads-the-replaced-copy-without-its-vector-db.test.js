/**
 * The copy an arrival will replace is read for what a rule can SEE of it, not whole (b23 pre-ship A2).
 *
 * `watchArrivals` (`sync/arrival-recording.ts`) reads the stored copy of each document that carries a violation, only to judge it
 * (`violationsOfRecord`) and to build its view (`recordViewOf`). It asked for projection `'all'` — every field but the never-returned
 * ones — so a page of five hundred violating documents pulled five hundred vectors out of Mongo to read a name and a few properties.
 * The question is "which fields does a view carry", and `viewSourceProjection(kind)` (`brain/record-view.ts`) is its one answer; the
 * stored-data check (`api/schema-validate-door.ts`) already reads that way.
 *
 * Held two ways: the find the recorder makes names an inclusion projection of the view's source fields and no vector, and what it
 * recorded is what it recorded before (a copy that already broke the same rule is not told again; a copy that did not is).
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/an-arrival-reads-the-replaced-copy-without-its-vector-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Collection } from 'mongodb';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-arrival-projection-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const SPACE = 'general';
/** A vector long enough that reading it is visible, and a field name no view carries. */
const VECTOR = Array.from({ length: 16 }, (_, i) => i / 16);

let mongo, recording;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

/** A strict space whose `service` entity requires `owner`: a document without it carries a violation. */
function withSchema() {
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: 'arrival-projection', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{
      id: SPACE, label: 'General', builtIn: true, folders: [],
      meta: {
        validationMode: 'strict',
        typeSchemas: { entity: { service: { propertySchemas: { owner: { type: 'string', required: true } } } } },
      },
    }],
  }, null, 2), { mode: 0o600 });
}

const arriving = (id, extra = {}) => ({ _id: id, spaceId: SPACE, name: 'API', type: 'service', tags: [], properties: {}, seq: 2, ...extra });

/** The finds the recorder makes against the entities collection, with the options each was given. */
async function findsDuring(fn) {
  const seen = [];
  const original = Collection.prototype.find;
  Collection.prototype.find = function spied(filter, options) {
    if (this.collectionName === `${SPACE}_entities`) seen.push({ filter, options });
    return original.call(this, filter, options);
  };
  try { return { result: await fn(), seen }; } finally { Collection.prototype.find = original; }
}

describe('the recorder reads a replaced copy by its view fields, never its vector', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('arrivalprojection');
    withSchema();
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recording = await import('../../server/dist/sync/arrival-recording.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => { await coll('entities').deleteMany({}); });

  it('the read asks for the view fields and no vector', async () => {
    await coll('entities').insertOne({ _id: 'e-1', spaceId: SPACE, name: 'API', type: 'service', tags: [], properties: {}, seq: 1,
      embedding: VECTOR, embeddingModel: 'm' });
    const { seen } = await findsDuring(() => recording.watchArrivals(SPACE, 'entities', [arriving('e-1')], 'import'));
    const reads = seen.filter(s => s.filter && s.filter._id && s.filter._id.$in);
    assert.equal(reads.length, 1, `expected the one read of the replaced copies, saw ${JSON.stringify(seen.map(s => s.filter))}`);
    assert.deepEqual(reads[0].options.projection, { _id: 1, name: 1, type: 1, description: 1, tags: 1, properties: 1 },
      'the replaced copy was read whole (every field but the never-returned ones), vector included');
  });

  it('what it records is unchanged: a copy that already broke the rule is not told again, one that did not is', async () => {
    await coll('entities').insertMany([
      { _id: 'e-broken', spaceId: SPACE, name: 'API', type: 'service', tags: [], properties: {}, seq: 1, embedding: VECTOR },
      { _id: 'e-fine', spaceId: SPACE, name: 'API', type: 'service', tags: [], properties: { owner: 'x' }, seq: 1, embedding: VECTOR },
    ]);
    const docs = [arriving('e-broken'), arriving('e-fine'), arriving('e-new')];
    const watch = await recording.watchArrivals(SPACE, 'entities', docs, 'import');
    assert.notEqual(watch, null);
    const recorded = recording.recordedOf(watch, docs, 'import');
    const byId = Object.fromEntries([...recorded].map(([doc, rows]) => [doc._id, rows.map(r => r.field)]));
    assert.deepEqual(Object.keys(byId).sort(), ['e-fine', 'e-new'], 'the document whose copy had the same break was recorded again');
    assert.ok(byId['e-new'].some(f => /owner/.test(f)), `the new document's row should name owner: ${JSON.stringify(byId)}`);
    assert.ok(watch.held.get('e-broken').rows.length > 0, 'the held copy was not judged');
  });
});
