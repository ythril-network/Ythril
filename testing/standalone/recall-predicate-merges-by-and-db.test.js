/**
 * Where a caller's predicate meets a server constraint, the two are ANDed — never merged as object keys (Q-102).
 *
 * ## The defect
 *
 * `recallPredicate` built `{ ...{tags: {$all: tags}}, ...filter }`. A raw filter naming `tags` then REPLACED the
 * `tags` parameter instead of narrowing it: `tags: ['a']` with `filter: {tags: 'b'}` returned records tagged `b`
 * alone, at 200. The lexical channel builds its eligibility match the same way, so fixing one site and not the
 * other still resurrects the records the caller excluded — through hybrid fusion rather than the vector path.
 *
 * Both are checked where the answer is decided: MongoDB evaluating the predicate, and a recall answering it.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/recall-predicate-merges-by-and-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { unitAt, queryAxis, startStubEmbedder, createSpaceCollections, insertAll, waitUntilServing } from './_vector-harness.mjs';

const skip = await mongoSkipReason();

const DIMS = 8;
const SPACE = 'tagged';
const COLL = `${SPACE}_entities`;
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-predand-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['EMBEDDING_DIMENSIONS'] = String(DIMS);
// Hybrid ON, explicitly: the lexical channel's eligibility is one of the two sites under test.
process.env['YTHRIL_HYBRID_SEARCH'] = 'on';

const OLD = new Date(Date.now() - 3_600_000).toISOString();
let mongo, recallMod, recallPredicate, resolveRecallFilter, stub;

/** Every record shares the query's rare word, so the lexical channel ranks all of them. */
const rec = (id, tags, deg) => ({
  _id: id, spaceId: SPACE, name: id, type: 'thing', tags, properties: {},
  description: `zebra ${id}`, matchedText: `zebra ${id}`, embedding: unitAt(deg, DIMS), embeddingModel: 'stub',
  seq: Math.round(deg * 10), createdAt: OLD, updatedAt: OLD,
});
const FIXTURE = [rec('both-1', ['a', 'b'], 10), rec('b-only', ['b'], 5), rec('a-only', ['a'], 15), rec('neither', [], 20)];

const raw = (f) => {
  const r = resolveRecallFilter(f);
  assert.ok(r.ok && r.kind === 'mongo', `fixture check: ${JSON.stringify(f)} should resolve as raw Mongo`);
  return r.filter;
};

describe('a recall predicate merges by $and', { skip }, () => {
  before(async () => {
    stub = await startStubEmbedder(() => queryAxis(DIMS));
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({ spaces: [{ id: SPACE, label: SPACE }], networks: [], tokens: [] }, null, 2));
    mongo = await openTestMongo('predand');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    recallMod = await import('../../server/dist/brain/recall.js');
    ({ recallPredicate, resolveRecallFilter } = await import('../../server/dist/brain/recall-filter.js'));
    const vectorIndex = await import('../../server/dist/spaces/vector-index.js');

    await createSpaceCollections(mongo, SPACE);
    await insertAll(mongo, COLL, FIXTURE);
    // The lexical channel's index, spelled as `initSpace` spells it (lifecycle.ts) — `initSpace` itself also
    // creates the space's file directory, which a CI runner cannot write.
    await mongo.col(COLL).createIndex({ matchedText: 'text' }, { name: 'lexical_text' });
    await vectorIndex.buildSpaceVectorIndexes(SPACE, true);
    await waitUntilServing(mongo, COLL, `${COLL}_embedding`, { dims: DIMS, n: FIXTURE.length });
    await mongo.checkVectorSearchAvailability();
  });

  after(async () => {
    await closeTestMongo();
    await stub?.close();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('recallPredicate: tags [a] AND a raw filter naming tags b matches only the record tagged both', async () => {
    const predicate = recallPredicate(['a'], raw({ tags: 'b' }));
    const ids = (await mongo.col(COLL).find(predicate).toArray()).map(d => d._id).sort();
    assert.deepEqual(ids, ['both-1'],
      `the predicate ${JSON.stringify(predicate)} matched [${ids.join(', ')}] — the filter's \`tags\` key replaced `
      + 'the tags parameter instead of narrowing it');
  });

  it('recallPredicate: a raw $or beside tags still has to satisfy the tags', async () => {
    const predicate = recallPredicate(['a'], raw({ $or: [{ tags: 'b' }, { name: 'neither' }] }));
    const ids = (await mongo.col(COLL).find(predicate).toArray()).map(d => d._id).sort();
    assert.deepEqual(ids, ['both-1'], `matched [${ids.join(', ')}]`);
  });

  it('recall, both channels: tags [a] with filter {tags: b} returns only the record tagged both', async () => {
    // `b-only` is the NEAREST record and shares the query's word, so either channel that loses the tags
    // constraint puts it in the answer — the vector path through `recallPredicate`, the lexical channel
    // through its own eligibility match and `introduceLexicalOnly`.
    const results = await recallMod.recall(SPACE, 'zebra', 10, ['a'], ['entity'], undefined, undefined, raw({ tags: 'b' }));
    const ids = results.map(r => r._id);
    assert.deepEqual(ids, ['both-1'],
      `got [${ids.join(', ')}]: a record outside the tags the caller asked for came back at 200`);
  });

  it('a caller\'s own _id clause survives every server id restriction (lexical introduction, stage 2)', async () => {
    // The fifth merge site. The server restricts by `_id` twice: `introduceLexicalOnly` ({_id: {$in: unseen}})
    // and stage 2's id-restricted search. A spread there replaces the caller's `_id` clause instead of narrowing
    // it. A guard today (the lexical introduction only ever sees already-eligible ids, and stage 2 does not
    // exist yet); red the moment either restriction is merged by spread.
    const allowed = ['a-only', 'neither'];
    const results = await recallMod.recall(SPACE, 'zebra', 10, undefined, ['entity'], undefined, undefined,
      raw({ _id: { $in: allowed } }));
    const ids = results.map(r => r._id).sort();
    assert.ok(ids.length > 0, 'nothing came back — the case would pass for a recall that matched nothing');
    assert.deepEqual(ids.filter(i => !allowed.includes(i)), [],
      `got [${ids.join(', ')}]: a record outside the caller's own _id clause came back`);
  });

  it('positive control: with tags alone, both records tagged a come back', async () => {
    const results = await recallMod.recall(SPACE, 'zebra', 10, ['a'], ['entity']);
    assert.deepEqual(results.map(r => r._id).sort(), ['a-only', 'both-1']);
  });
});
