/**
 * Upgrading to 5.0 renames every `<space>_memories` collection, and cannot quietly lose one.
 *
 * ## Why this is the most dangerous change in the release
 *
 * The knowledge type `memory` became `fact`, and a collection is named after its type. An instance that
 * upgrades without the rename looks for `<space>_facts`, does not find it, creates an empty one, and
 * reports zero facts in a space holding thousands.
 *
 * **Nothing errors.** Reading a collection that does not exist returns an empty result, which is the same
 * shape as a space nobody has written to. So the failure mode is not an outage an operator can act on — it
 * is a silent, total, invisible data loss that looks like an empty space to every caller.
 *
 * ## What is asserted, and why each case is here
 *
 * The rename itself is exercised against a real MongoDB rather than mocked: `renameCollection` is the whole
 * mechanism, and a test that stubs it asserts that the code calls the function it obviously calls.
 *
 * The conflict case is the one worth the most: when BOTH names exist, merging them means deciding which
 * copy of a document wins, and a migration that guesses is how a repair becomes the incident. It must
 * refuse and say so.
 *
 * Run: node --test testing/standalone/the-collection-rename-cannot-lose-a-space.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

let renameMemoriesToFacts;
let getDb;

before(async () => {
  if (skip) return;
  await openTestMongo('rename-memories-to-facts');
  ({ renameMemoriesToFacts } = await import('../../server/dist/db/rename-memories-to-facts.js'));
  ({ getDb } = await import('../../server/dist/db/mongo.js'));
});

describe('the rename moves every space, and only the spaces', { skip }, () => {
  it('renames a populated collection and keeps every document', async () => {
    const db = getDb();
    await db.collection('rn1_memories').insertMany([{ _id: 'a', fact: 'one' }, { _id: 'b', fact: 'two' }]);

    const out = await renameMemoriesToFacts();
    assert.ok(out.renamed.includes('rn1_facts'), `expected rn1_facts in ${JSON.stringify(out)}`);

    const moved = await db.collection('rn1_facts').find({}).sort({ _id: 1 }).toArray();
    assert.deepEqual(moved.map(d => d._id), ['a', 'b'], 'the documents must arrive intact');
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
    assert.ok(!names.includes('rn1_memories'), 'the old collection must be gone, not copied');
  });

  it('is idempotent — a second boot does nothing', async () => {
    const before2 = await renameMemoriesToFacts();
    assert.deepEqual(before2.renamed, [], 'a second run must rename nothing');
  });

  it('leaves collections that are not memories alone', async () => {
    const db = getDb();
    await db.collection('rn2_entities').insertOne({ _id: 'e' });
    await db.collection('rn2_chrono').insertOne({ _id: 'c' });
    await renameMemoriesToFacts();
    const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name);
    assert.ok(names.includes('rn2_entities') && names.includes('rn2_chrono'),
      'only the _memories suffix moves — a rename that caught a neighbour would be worse than none');
  });
});

describe('a conflict is refused, never merged', { skip }, () => {
  it('reports both-exist rather than guessing which document wins', async () => {
    const db = getDb();
    await db.collection('rn3_memories').insertOne({ _id: 'old', fact: 'from the old collection' });
    await db.collection('rn3_facts').insertOne({ _id: 'new', fact: 'from the new one' });

    const out = await renameMemoriesToFacts();
    assert.ok(out.conflicts.includes('rn3_memories'),
      'a populated pair must be reported, because merging them is a decision this code cannot make');

    // And neither side was touched.
    assert.equal(await db.collection('rn3_memories').countDocuments(), 1);
    assert.equal(await db.collection('rn3_facts').countDocuments(), 1);
  });

  it('but an EMPTY leftover is skipped quietly — there is nothing to lose', async () => {
    const db = getDb();
    await db.createCollection('rn4_memories');
    await db.collection('rn4_facts').insertOne({ _id: 'x' });

    const out = await renameMemoriesToFacts();
    assert.ok(out.skipped.includes('rn4_memories'), 'an empty source is not a conflict worth a warning');
    assert.ok(!out.conflicts.includes('rn4_memories'));
  });
});

after(async () => {
  if (skip) return;
  const db = getDb();
  for (const n of ['rn1_memories', 'rn1_facts', 'rn2_entities', 'rn2_chrono', 'rn3_memories', 'rn3_facts',
    'rn4_memories', 'rn4_facts', '_webhooks']) {
    await db.collection(n).drop().catch(() => {});
  }
  await closeTestMongo();
});

describe('a webhook subscribed to the old event name is rewritten, not left dead', { skip }, () => {
  /*
   * Subscriptions live in Mongo, not in the config file, which is why this rides with the collection
   * rename rather than with the config one. The failure is the same silent shape: a hook subscribed to
   * `memory.created` stays listed, stays enabled, and never delivers again, because nothing emits that
   * name any more. No error, no warning, no metric.
   */
  it('renames memory.* to fact.* on every subscription that carries one', async () => {
    const db = getDb();
    await db.collection('_webhooks').insertOne({
      _id: 'wh1', url: 'https://example.invalid/a', enabled: true,
      events: ['memory.created', 'entity.updated', 'memory.deleted'],
    });

    await renameMemoriesToFacts();

    const hook = await db.collection('_webhooks').findOne({ _id: 'wh1' });
    assert.deepEqual(hook.events, ['fact.created', 'entity.updated', 'fact.deleted'],
      'the renamed events must move and the untouched one must stay, in place');
  });

  it('does not end up with the new name twice when a hook carried both', async () => {
    const db = getDb();
    await db.collection('_webhooks').insertOne({
      _id: 'wh2', url: 'https://example.invalid/b', enabled: true,
      events: ['memory.updated', 'fact.updated'],
    });

    await renameMemoriesToFacts();

    const hook = await db.collection('_webhooks').findOne({ _id: 'wh2' });
    assert.deepEqual(hook.events, ['fact.updated'], 'a duplicate subscription is a double delivery');
  });

  it('leaves a subscription with no renamed event completely alone', async () => {
    const db = getDb();
    await db.collection('_webhooks').insertOne({
      _id: 'wh3', url: 'https://example.invalid/c', enabled: true, events: ['edge.created'],
    });
    await renameMemoriesToFacts();
    const hook = await db.collection('_webhooks').findOne({ _id: 'wh3' });
    assert.deepEqual(hook.events, ['edge.created']);
  });
});
