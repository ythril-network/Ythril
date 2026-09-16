/**
 * The link write door creates the ARRAY ENTRY, not just the link record.
 *
 * ## The bug this exists to prevent, which has no symptom at the time it happens
 *
 * A door that inserted a row into the links collection and stopped would look completely correct: the row is
 * there, it has the right derived id, it replicates, `/query` returns it. And it would be deleted by the next
 * ordinary write to the record it hangs off — because `reconcileLinks` makes the stored rows equal what the
 * arrays say, and the array never heard about it.
 *
 * So the sequence is: create a link through the door, then patch the memory's description an hour later, and
 * the link is gone. Nothing failed. No error, no warning, no tombstone anybody would look at. The caller who
 * created it is not the caller who patched the memory, and neither of them can see the other's half.
 *
 * The door therefore writes the array and lets the same reconcile every other writer uses derive the row.
 * **One writer, no second opinion** — the rule `brain/links.ts` is built around, applied to the one caller
 * most tempted to bypass it, because it is the caller that knows exactly which row it wants.
 *
 * ## Why that stays right after the readers switch
 *
 * The arrays do not go away in 2b. They are how a peer on an older build still understands the record, which
 * is why the conversion script is forbidden from deleting them. The door writing both is what makes it a
 * door an operator can use during the whole transition rather than one that only becomes safe at the end.
 *
 * Run: node --test testing/standalone/a-link-door-writes-through-the-array-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-link-door-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const E1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const E2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const M1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const AUTHOR = { instanceId: 'link-door-test', tokenLabel: 'test' };

let mongo, linksMod, memoryMod;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const linkRows = () => coll('links').find({}).toArray();
const memory = () => coll('facts').findOne({ _id: M1 });

describe('a link door writes through the array', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('linkdoor');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'link-door-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    linksMod = await import('../../server/dist/brain/links.js');
    memoryMod = await import('../../server/dist/brain/fact.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'files', 'links', 'tombstones']) {
      await coll(c).deleteMany({});
    }
    await coll('entities').insertMany([
      { _id: E1, spaceId: SPACE, name: 'One', type: 'thing', tags: [], seq: 1 },
      { _id: E2, spaceId: SPACE, name: 'Two', type: 'thing', tags: [], seq: 2 },
    ]);
    await coll('facts').insertOne({
      _id: M1, spaceId: SPACE, fact: 'a fact', type: '', tags: [], entityIds: [],
      author: AUTHOR, createdAt: new Date().toISOString(), seq: 3,
    });
  });

  it('the module exports the door this gate is about', () => {
    // The floor. Without it every assertion below would fail as a TypeError and read as a behaviour bug.
    assert.equal(typeof linksMod.addLink, 'function', 'addLink');
    assert.equal(typeof linksMod.removeLink, 'function', 'removeLink');
    assert.equal(typeof linksMod.LINK_PAIRS, 'object', 'LINK_PAIRS — the six legal (fromKind, toKind) pairs');
  });

  it('creates the row AND the array entry', async () => {
    const link = await linksMod.addLink(SPACE, M1, 'fact', E1, 'entity', AUTHOR);
    assert.equal(link.from, M1);
    assert.equal(link.to, E1);
    assert.equal(link.fromKind, 'fact');
    assert.equal(link.toKind, 'entity');

    assert.equal((await linkRows()).length, 1, 'one link row');
    assert.deepEqual((await memory()).entityIds, [E1],
      'the door wrote no array entry — the row it created is deleted by the next write to this memory');
  });

  it('SURVIVES the next ordinary write to the record it hangs off', async () => {
    /*
     * The whole point, asserted as the sequence that would expose the bug rather than as a property of the
     * write. A door writing only the row passes every check above this one and fails here.
     */
    await linksMod.addLink(SPACE, M1, 'fact', E1, 'entity', AUTHOR);
    assert.equal((await linkRows()).length, 1);

    // An unrelated edit, of the kind that happens all day and knows nothing about links.
    await memoryMod.updateFact(SPACE, M1, { fact: 'a revised fact' });

    const after = await linkRows();
    assert.equal(after.length, 1,
      'the link vanished when the memory was edited — the door wrote a row the arrays never claimed, so'
      + '\n  `reconcileLinks` removed it as stale. Nothing reported it: the edit succeeded.');
    assert.equal(after[0].to, E1);
  });

  it('is idempotent — the same link twice is one row and one array entry', async () => {
    await linksMod.addLink(SPACE, M1, 'fact', E1, 'entity', AUTHOR);
    await linksMod.addLink(SPACE, M1, 'fact', E1, 'entity', AUTHOR);
    assert.equal((await linkRows()).length, 1, 'the derived id makes a re-write a no-op, not a duplicate');
    assert.deepEqual((await memory()).entityIds, [E1], 'and the array must not gain a second copy either');
  });

  it('a second link on the same record does not disturb the first', async () => {
    await linksMod.addLink(SPACE, M1, 'fact', E1, 'entity', AUTHOR);
    await linksMod.addLink(SPACE, M1, 'fact', E2, 'entity', AUTHOR);
    assert.deepEqual((await linkRows()).map(l => l.to).sort(), [E1, E2].sort());
    assert.deepEqual([...(await memory()).entityIds].sort(), [E1, E2].sort());
  });

  it('refuses a pair that is not one of the six', async () => {
    // `entity` is only ever a TO. A memory cannot hold `memoryIds`, so there is no array to write into and a
    // row alone would be exactly the orphan this gate exists for.
    await assert.rejects(() => linksMod.addLink(SPACE, M1, 'fact', M1, 'fact', AUTHOR),
      /memory\.memoryIds|not a link class|cannot link/i);
    assert.equal((await linkRows()).length, 0, 'and nothing was written on the way to refusing');
  });

  it('refuses when the record it would hang off does not exist', async () => {
    await assert.rejects(() => linksMod.addLink(SPACE, 'cccccccc-0000-4000-8000-000000000009', 'fact', E1, 'entity', AUTHOR),
      /not found/i);
    assert.equal((await linkRows()).length, 0);
  });

  it('removing by id clears the array entry, the row, and leaves a tombstone', async () => {
    const link = await linksMod.addLink(SPACE, M1, 'fact', E1, 'entity', AUTHOR);
    assert.equal(await linksMod.removeLink(SPACE, link._id), true);

    assert.equal((await linkRows()).length, 0, 'the row is gone');
    assert.deepEqual((await memory()).entityIds, [],
      'the array still claims the link, so the next reconcile re-creates the row and the delete undoes itself');

    const tomb = await coll('tombstones').findOne({ _id: link._id });
    assert.ok(tomb, 'no tombstone — the next pull from any peer still holding this link brings it back');
    assert.equal(tomb.type, 'link');
  });

  it('removing an id that is not a link answers false rather than throwing', async () => {
    assert.equal(await linksMod.removeLink(SPACE, 'dddddddd-0000-4000-8000-000000000009'), false);
  });

  it('the six pairs are the six, and they agree with the labels the readers print', () => {
    // Through `linkLabel`, NOT a `${t}Ids` written here. That spelling was a third copy of the field
    // derivation, and it is wrong for exactly one kind: the type is `fact` while the stored array is still
    // `memoryIds`, because the six arrays replicate and are merkle-hashed. A gate that re-derives the name
    // asserts its own arithmetic — this one asserts the label the readers actually print.
    const pairs = linksMod.LINK_PAIRS.map(([f, t]) => linksMod.linkLabel(f, t)).sort();
    assert.deepEqual(pairs, [
      'chrono.entityIds', 'chrono.memoryIds', 'fact.entityIds',
      'file.chronoIds', 'file.entityIds', 'file.memoryIds',
    ], 'the door accepts a different set of classes than the six the arrays actually are');
  });
});
