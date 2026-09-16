/**
 * The stamp check reaches the STORED record, on all four brain creates — against a real MongoDB.
 *
 * ## Why this is a separate file from `stamp-skew.test.js`
 *
 * That one proves the comparison and the parsing. This one proves the wiring, which is the part that silently does
 * nothing: `stampSkewOnCreate` is called beside `stampExpiryOnCreate` in four places, and a create that forgets the call
 * produces a perfectly valid record with no signal on it. A unit test of the helper cannot see that, and neither can a
 * reader — the absence of a field looks exactly like agreement, which is the same failure mode as the incident that
 * prompted the feature.
 *
 * So the assertions here are on the document as Mongo holds it, per collection.
 *
 * ## The negative cases are the load-bearing ones
 *
 * A check that fires on everything is worse than none: it teaches a reader to ignore the flag. So a stamp INSIDE the
 * tolerance, a record with no stamp at all, and a space that switched the check off must each leave the field absent —
 * and `{ stampSkew: { $exists: true } }` must return exactly the records that are actually wrong, because that query IS
 * the deliverable.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/stamp-skew-is-stored-db.test.js
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
const OFF = 'no-stamp-check';

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-stamp-skew-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

// No embedder: this suite is about a stored FIELD, and a create that waits on a model would either be slow or fail for
// reasons that have nothing to do with the stamp.
const EMPTY_CACHE = path.join(tmpDir, 'empty-model-cache');
fs.mkdirSync(EMPTY_CACHE, { recursive: true });
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
process.env['MODEL_CACHE_DIR'] = EMPTY_CACHE;

let mongo, memory, entities, edges, chrono;

const col = (space, name) => mongo.col(`${space}_${name}`);

/** Eight hours early, in the compact form the board writes — the incident, reproduced. */
const eightHoursEarly = () => {
  const d = new Date(Date.now() - 8 * 3_600_000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}${p(d.getUTCMinutes())}Z`;
};

describe('stamp skew reaches the stored record (real MongoDB)', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      spaces: [
        { id: SPACE, label: 'General' },
        // The same records, in a space that switched the check off. Two spaces in one config is how "off means off" is
        // proved without restarting the process, which would make it a test of the loader instead.
        { id: OFF, label: 'No check', meta: { stampSkew: { warnMinutes: 0 } } },
      ],
      networks: [], tokens: [],
    }, null, 2));
    mongo = await openTestMongo('stampskew');
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    memory = await import('../../server/dist/brain/fact.js');
    entities = await import('../../server/dist/brain/entities.js');
    edges = await import('../../server/dist/brain/edges.js');
    chrono = await import('../../server/dist/brain/chrono.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const space of [SPACE, OFF]) {
      for (const c of ['facts', 'entities', 'edges', 'chrono']) await col(space, c).deleteMany({});
    }
  });

  it('a memory stamped eight hours early carries the skew', async () => {
    const stamp = eightHoursEarly();
    const doc = await memory.saveFact(SPACE, 'stamped from an estimate', [], [], undefined, { postedAt: stamp });

    const stored = await col(SPACE, 'facts').findOne({ _id: doc._id });
    assert.ok(stored.stampSkew, 'the stored record must carry the skew — this is the whole feature');
    assert.equal(stored.stampSkew.property, 'postedAt');
    assert.equal(stored.stampSkew.stamp, stamp, 'the stamp is quoted as written');
    assert.ok(stored.stampSkew.skewMs < -7.5 * 3_600_000, `expected roughly -8h, got ${stored.stampSkew.skewMs}`);
    assert.equal(stored.stampSkew.thresholdMs, 40 * 60_000, 'and what it was judged against');

    // The returned record carries it too, so the writer -- the only party who can still fix their clock -- sees it at
    // the time rather than finding out from a reader months later.
    assert.ok(doc.stampSkew, 'the create response must carry it as well');
  });

  it('leaves a record with an ACCURATE stamp alone', async () => {
    const doc = await memory.saveFact(SPACE, 'stamped from a measurement', [], [], undefined,
      { postedAt: new Date().toISOString() });
    const stored = await col(SPACE, 'facts').findOne({ _id: doc._id });
    assert.equal(stored.stampSkew, undefined,
      'a correct stamp must leave no field — a flag on every record teaches a reader to ignore it');
  });

  it('leaves a record with no stamp property alone', async () => {
    const doc = await memory.saveFact(SPACE, 'no stamp at all', [], []);
    assert.equal((await col(SPACE, 'facts').findOne({ _id: doc._id })).stampSkew, undefined);
  });

  it('stores nothing in a space that switched the check OFF', async () => {
    const doc = await memory.saveFact(OFF, 'off by eight hours, unchecked', [], [], undefined,
      { postedAt: eightHoursEarly() });
    assert.equal((await col(OFF, 'facts').findOne({ _id: doc._id })).stampSkew, undefined,
      'warnMinutes: 0 disables the check rather than making it strictest');
  });

  it('an entity create is wired too', async () => {
    const e = await entities.upsertEntity(SPACE, `skewed entity ${Date.now()}`, 'thing', [], { stampedAt: eightHoursEarly() });
    const stored = await col(SPACE, 'entities').findOne({ _id: e.entity._id });
    assert.ok(stored.stampSkew, 'entities.ts must call the helper as well');
    assert.equal(stored.stampSkew.property, 'stampedAt');
  });

  it('a chrono create is wired too', async () => {
    const c = await chrono.createChrono(SPACE, {
      title: `skewed chrono ${Date.now()}`, type: 'event', properties: { postedAt: eightHoursEarly() },
    });
    assert.ok((await col(SPACE, 'chrono').findOne({ _id: c._id })).stampSkew, 'chrono.ts must call the helper as well');
  });

  it('an edge create is wired too', async () => {
    const a = await entities.upsertEntity(SPACE, `edge-a ${Date.now()}`, 'thing');
    const b = await entities.upsertEntity(SPACE, `edge-b ${Date.now()}`, 'thing');
    const edge = await edges.upsertEdge(
      SPACE, a.entity._id, b.entity._id, 'relates_to', undefined, undefined, undefined,
      { stampedAt: eightHoursEarly() },
    );
    assert.ok((await col(SPACE, 'edges').findOne({ _id: edge._id })).stampSkew, 'edges.ts must call the helper as well');
  });

  it('the integrity QUERY returns exactly the wrong records', async () => {
    // This is the deliverable in their words: "a cheap integrity check". If presence were not the signal, this query
    // would match every record in the space and answer nothing.
    const bad = await memory.saveFact(SPACE, 'wrong', [], [], undefined, { postedAt: eightHoursEarly() });
    await memory.saveFact(SPACE, 'right', [], [], undefined, { postedAt: new Date().toISOString() });
    await memory.saveFact(SPACE, 'unstamped', [], []);

    const flagged = await col(SPACE, 'facts').find({ stampSkew: { $exists: true } }).toArray();
    assert.equal(flagged.length, 1, `expected exactly one flagged record, got ${flagged.length}`);
    assert.equal(flagged[0]._id, bad._id);
  });
});
