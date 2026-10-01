/**
 * A new edge STORES the property defaults its label's schema declares — the values its validation passed on.
 *
 * ## The defect
 *
 * `upsertEdge` filled the schema defaults into `withDefaults`, validated THAT, and then inserted the caller's raw
 * `properties`. So an edge created with `{ other: 'x' }` under a label whose schema defaults `status: 'draft'`
 * passed a `required` check on `status` and was stored without it. The converge branch stored the merged
 * defaults; only the insert dropped them.
 *
 * `a-property-default-is-applied-and-stored.test.js` did not catch it: it checks the line that computes
 * `effectiveProps`, which was right, while the insert never read `effectiveProps`. This one reads the stored
 * document, so it does not care which variable the insert spreads.
 *
 * Seen red on v5.6.0: the first two cases stored no `status`.
 *
 * Run: a mongod on 127.0.0.1:27117 (or `YTHRIL_TEST_MONGO_PORT`) and `npm run build -w server`, then
 *      node --test testing/standalone/a-new-edge-stores-its-schema-defaults-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-edge-default-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const A = 'aaaaaaaa-0000-4000-8000-0000000ed001';
const B = 'aaaaaaaa-0000-4000-8000-0000000ed002';
const LABEL = 'reviews';

let mongo, edgeMod, bulkMod;
const coll = (n) => mongo.col(`${SPACE}_${n}`);
const stored = () => coll('edges').findOne({ from: A, to: B, label: LABEL });

describe('a new edge stores its schema defaults', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('edgedefault');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'edge-default-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{
        id: SPACE, label: 'General', builtIn: true, folders: [],
        meta: {
          validationMode: 'strict',
          typeSchemas: { edge: { [LABEL]: { propertySchemas: {
            status: { type: 'string', default: 'draft' },
            other: { type: 'string' },
          }, required: ['status'] } } },
        },
      }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    edgeMod = await import('../../server/dist/brain/edges.js');
    bulkMod = await import('../../server/dist/brain/bulk.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'embed_jobs', 'tombstones', 'links']) await coll(c).deleteMany({});
    await coll('entities').insertMany([
      { _id: A, spaceId: SPACE, name: 'Reviewer', type: 'person', tags: [], seq: 1 },
      { _id: B, spaceId: SPACE, name: 'Paper', type: 'document', tags: [], seq: 2 },
    ]);
  });

  it('created with other properties, the stored edge carries the default it was validated with', async () => {
    await edgeMod.upsertEdge(SPACE, A, B, LABEL, undefined, undefined, undefined, { other: 'x' });
    const edge = await stored();
    assert.ok(edge, 'the edge was not written');
    assert.deepEqual(edge.properties, { other: 'x', status: 'draft' },
      'the default passed validation and was not stored — the record says less than what was checked');
  });

  it('created with no properties at all, the stored edge still carries the default', async () => {
    await edgeMod.upsertEdge(SPACE, A, B, LABEL);
    assert.deepEqual((await stored())?.properties, { status: 'draft' });
  });

  it('through the batch door too, which writes through the same function', async () => {
    const r = await bulkMod.bulkWrite(SPACE, { edges: [{ from: A, to: B, label: LABEL, properties: { other: 'y' } }] });
    assert.deepEqual(r.errors, []);
    assert.deepEqual((await stored())?.properties, { other: 'y', status: 'draft' });
  });

  it('control: a value the caller stated is stored as stated, never replaced by the default', async () => {
    await edgeMod.upsertEdge(SPACE, A, B, LABEL, undefined, undefined, undefined, { status: 'final' });
    assert.deepEqual((await stored())?.properties, { status: 'final' });
  });
});
