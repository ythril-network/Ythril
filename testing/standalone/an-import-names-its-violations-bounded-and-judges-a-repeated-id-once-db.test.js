/**
 * What a restore's answer says about the records it stored that break the space's schema (b23 pre-ship T2, `api/admin-import.ts`).
 *
 * The report is bounded and says so: it NAMES the first `IMPORT_VIOLATIONS_NAMED` documents (by id, field and reason, no value),
 * `schemaViolationsTotal` says how many there were in all, and `schemaViolationsTruncated` is present only when the list stopped short.
 * And a repeated id is stored at its HIGHEST seq (the writer's rule), so that is the version judged: a lower-seq copy that is not stored
 * is neither named nor counted, and a document is counted once however often the export repeated it. None of it was asserted anywhere: a
 * report that named a hundred thousand ids, or one that never said it was cut, or one that judged the copy that was thrown away, would
 * have passed every file in the tree.
 *
 * Run: a Mongo the harness accepts, then
 *      node --test testing/standalone/an-import-names-its-violations-bounded-and-judges-a-repeated-id-once-db.test.js
 * (after `npm run build --workspace=server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-import-report-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const SPACE = 'general';

let mongo, importMod;

const coll = (n) => mongo.col(`${SPACE}_${n}`);

/** A strict space whose `service` entity requires `owner`: a document without one carries a violation. */
function withSchema() {
  fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
    instanceId: 'import-report', instanceLabel: 'test', tokens: [], networks: [],
    spaces: [{
      id: SPACE, label: 'General', builtIn: true, folders: [],
      meta: {
        validationMode: 'strict',
        typeSchemas: { entity: { service: { propertySchemas: { owner: { type: 'string', required: true } } } } },
      },
    }],
  }, null, 2), { mode: 0o600 });
}

const broken = (id, seq = 1) => ({ _id: id, name: `Service ${id}`, type: 'service', tags: [], properties: {}, seq });
const sound = (id, seq = 1) => ({ _id: id, name: `Service ${id}`, type: 'service', tags: [], properties: { owner: 'platform' }, seq });
const many = (n, prefix = 'e') => Array.from({ length: n }, (_, i) => broken(`${prefix}-${String(i).padStart(3, '0')}`));

describe('an import names its violations bounded and judges a repeated id once', { skip }, () => {
  let NAMED;

  before(async () => {
    mongo = await openTestMongo('importreport');
    withSchema();
    (await import('../../server/dist/config/loader.js')).loadConfig();
    importMod = await import('../../server/dist/api/admin-import.js');
    NAMED = importMod.IMPORT_VIOLATIONS_NAMED;
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });
  beforeEach(async () => {
    for (const c of ['entities', 'facts', 'edges', 'chrono', 'files', 'embed_jobs', 'tombstones']) await coll(c).deleteMany({});
  });

  it('the bound is a real one (the cases below cannot pass for a bound of nothing)', () => {
    assert.ok(Number.isInteger(NAMED) && NAMED >= 1, `IMPORT_VIOLATIONS_NAMED is ${NAMED}`);
  });

  it('more violating records than the bound: the bound is named, the total is said, and the answer says it stopped short', async () => {
    const total = NAMED + 10;
    const out = await importMod.importDocuments(SPACE, { entities: many(total) });
    const r = out.results.entities;
    assert.equal(r.inserted, total, 'every violating record is still STORED');
    assert.equal(r.schemaViolations.length, NAMED, 'the list is not cut at the bound');
    assert.equal(r.schemaViolationsTotal, total, 'the total does not say how many there were');
    assert.equal(r.schemaViolationsTruncated, true, 'the answer does not say the list stopped short');
    assert.equal(new Set(r.schemaViolations.map(v => v._id)).size, NAMED, 'a document is named twice');
  });

  it('exactly the bound: all of them are named and nothing says it was cut', async () => {
    const out = await importMod.importDocuments(SPACE, { entities: many(NAMED) });
    const r = out.results.entities;
    assert.equal(r.schemaViolations.length, NAMED);
    assert.equal(r.schemaViolationsTotal, NAMED);
    assert.equal(r.schemaViolationsTruncated, undefined, 'a list that is whole says it was cut');
  });

  it('a repeated id is judged at its highest seq: a broken copy with the higher seq is reported, once', async () => {
    const out = await importMod.importDocuments(SPACE, { entities: [sound('dup', 1), broken('dup', 5), sound('dup', 3)] });
    const r = out.results.entities;
    assert.equal((await coll('entities').findOne({ _id: 'dup' })).seq, 5, 'the highest seq was not the one stored');
    assert.deepEqual(r.schemaViolations.map(v => v._id), ['dup'], 'the stored copy breaks the schema and is reported exactly once');
    assert.equal(r.schemaViolationsTotal, 1, 'a repeated id was counted once per copy');
    assert.equal(r.schemaViolationsTruncated, undefined);
  });

  it('a repeated id is judged at its highest seq: a broken copy with a LOWER seq is not stored, so it is not reported', async () => {
    const out = await importMod.importDocuments(SPACE, { entities: [broken('dup', 1), sound('dup', 5), broken('dup', 3)] });
    const r = out.results.entities;
    const stored = await coll('entities').findOne({ _id: 'dup' });
    assert.equal(stored.seq, 5);
    assert.equal(stored.properties.owner, 'platform', 'the stored copy is not the one with the highest seq');
    assert.equal(r.schemaViolations, undefined, `a copy that was never stored was reported: ${JSON.stringify(r.schemaViolations)}`);
    assert.equal(r.schemaViolationsTotal, undefined);
  });
});
