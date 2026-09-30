/**
 * Two listeners on the database's record writes each hear the collections THEY asked for (`Q-95`).
 *
 * ## How this was found
 *
 * `onRecordCollectionWrite(isRecordCollection, listener)` kept ONE predicate for the whole registry, and each
 * subscriber overwrote it. While `spaces/search-index-presence.ts` was the only subscriber that was invisible.
 * `Q-95` adds a second — the space-shape cache, which must hear `_links` writes the index lifecycle has no
 * interest in — and the second subscription would have silently re-scoped the first: the index lifecycle
 * hearing links writes it cannot parse, or missing the vector collections it builds indexes for, depending on
 * which module loaded last. Nothing would have failed; recall would have missed records for good.
 *
 * Also held here: `reportDatabaseReplaced()`, the one report a write the observer cannot see ends with — a
 * restore writes through its own client — reaches every listener, whatever its predicate.
 *
 * Run: node --test testing/standalone/record-write-listeners-keep-their-own-collections-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

describe('each record-write listener keeps its own collections', { skip }, () => {
  let mongo;
  const heard = { alpha: [], beta: [] };
  before(async () => {
    mongo = await openTestMongo('writelisteners');
    mongo.onRecordCollectionWrite(name => name.endsWith('_alpha'), (name, effect) => heard.alpha.push([name, effect]));
    mongo.onRecordCollectionWrite(name => name.endsWith('_beta'), (name, effect) => heard.beta.push([name, effect]));
  });
  after(async () => { await closeTestMongo(); });

  it('a write is reported to the listener that asked for its collection, and only to it', async () => {
    await mongo.col('x_alpha').insertOne({ _id: 'a1' });
    await mongo.col('x_beta').insertOne({ _id: 'b1' });
    assert.deepEqual(heard.alpha.map(([n]) => n), ['x_alpha'],
      `the first listener heard ${JSON.stringify(heard.alpha)} — its predicate was replaced by the second's`);
    assert.deepEqual(heard.beta.map(([n]) => n), ['x_beta']);
  });

  it('a replaced database reaches every listener', () => {
    assert.equal(typeof mongo.reportDatabaseReplaced, 'function', 'no way to report a write the observer cannot see');
    heard.alpha.length = 0; heard.beta.length = 0;
    mongo.reportDatabaseReplaced();
    assert.equal(heard.alpha.length, 1, 'the first listener was not told the database was replaced');
    assert.equal(heard.beta.length, 1, 'the second listener was not told the database was replaced');
    assert.equal(heard.alpha[0][1].forget, true, 'a replaced database voids what was known: a forget');
  });
});
