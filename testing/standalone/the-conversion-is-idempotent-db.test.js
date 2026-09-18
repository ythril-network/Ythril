/**
 * The link conversion creates every record the arrays imply, twice is a no-op, and it deletes nothing.
 *
 * ## The three properties, and what each one is protecting against
 *
 * **Completeness.** A space upgraded to 4.0 has arrays and no link records. If the walk misses a collection
 * or a class, the readers that switch in 2b answer *fewer* connections than 3.x did — a regression that
 * looks exactly like the data having always been that way, because nothing anywhere says how many links
 * there should be.
 *
 * **Idempotence.** A link's id is a UUIDv5 over the two records and the class, so a second run recomputes the
 * same ids and finds them stored. That is what lets an operator re-run after an interruption instead of
 * working out where it stopped — and it is why nothing has to record whether the script has run, which would
 * be a piece of state that can be wrong.
 *
 * **It never deletes an array.** These documents replicate by whole-document replace, so an array this
 * removed would be restored by any peer on an older build — and a space where the arrays and the records
 * disagree lets whichever reader happens to win decide what is true.
 *
 * ## And the marker is withheld when anything failed
 *
 * `completeLinkage` means every link in the space is a record. A run that skipped a document and set it
 * anyway would arm 2b's refusal over data it had not converted, which is the one outcome worse than not
 * converting at all.
 *
 * Run: node --test testing/standalone/the-conversion-is-idempotent-db.test.js
 * (requires a prior `npm run build` in server/, and a reachable mongod)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-link-convert-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const E1 = 'aaaaaaaa-0000-4000-8000-000000000001';
const E2 = 'aaaaaaaa-0000-4000-8000-000000000002';
const M1 = 'bbbbbbbb-0000-4000-8000-000000000001';
const C1 = 'cccccccc-0000-4000-8000-000000000001';
const AUTHOR = { instanceId: 'convert-test', instanceLabel: 'test' };

let mongo, convertMod, loader;

const coll = (n) => mongo.col(`${SPACE}_${n}`);
const linkPairs = async () =>
  (await coll('links').find({}).toArray()).map(l => `${l.fromKind}:${l.from}>${l.toKind}:${l.to}`).sort();

describe('the link conversion is complete, idempotent and non-destructive', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('linkconvert');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'convert-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    convertMod = await import('../../server/dist/brain/links-conversion.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    for (const c of ['entities', 'edges', 'facts', 'chrono', 'files', 'links', 'tombstones']) {
      await coll(c).deleteMany({});
    }
    // A 3.x space: arrays everywhere, not one link record. Three of the six classes, so a walk that only
    // followed `entityIds` — the class every reader already had — would be visibly short.
    await coll('entities').insertMany([
      { _id: E1, spaceId: SPACE, name: 'One', type: 'thing', tags: [], seq: 1 },
      { _id: E2, spaceId: SPACE, name: 'Two', type: 'thing', tags: [], seq: 2 },
    ]);
    await coll('facts').insertOne({
      _id: M1, spaceId: SPACE, fact: 'a fact', type: '', tags: [], entityIds: [E1, E2], author: AUTHOR, seq: 3,
    });
    await coll('chrono').insertOne({
      _id: C1, spaceId: SPACE, title: 'an event', type: 'event', tags: [],
      entityIds: [E1], memoryIds: [M1], author: AUTHOR, seq: 4,
    });
    await coll('files').insertOne({
      _id: 'notes/one.md', spaceId: SPACE, path: 'notes/one.md', tags: [],
      entityIds: [E2], memoryIds: [], chronoIds: [C1], author: AUTHOR, seq: 5,
    });
  });

  const EXPECTED = [
    `chrono:${C1}>entity:${E1}`,
    `chrono:${C1}>fact:${M1}`,
    `file:notes/one.md>chrono:${C1}`,
    `file:notes/one.md>entity:${E2}`,
    `fact:${M1}>entity:${E1}`,
    `fact:${M1}>entity:${E2}`,
  ].sort();

  it('the module is the one this gate thinks it is', () => {
    assert.equal(typeof convertMod.convertSpaceLinks, 'function');
    assert.equal(typeof convertMod.convertAllLinks, 'function');
  });

  it('creates a record for every array entry, across all three collections', async () => {
    const report = await convertMod.convertSpaceLinks(SPACE);
    assert.equal(report.failed, 0);
    assert.deepEqual(await linkPairs(), EXPECTED,
      'the walk missed a class. A reader that switches to link records then answers fewer connections than'
      + '\n  3.x did, and nothing says how many there should have been.');
    assert.equal(report.added, EXPECTED.length, `report says ${report.added} added, six exist`);
  });

  it('a second run writes nothing and reports nothing', async () => {
    await convertMod.convertSpaceLinks(SPACE);
    const second = await convertMod.convertSpaceLinks(SPACE);
    assert.equal(second.added, 0, 'the second run created records — the ids are not derived after all');
    assert.equal(second.failed, 0);
    assert.deepEqual(await linkPairs(), EXPECTED, 'and the set is unchanged, not doubled');
  });

  it('leaves every array exactly as it found it', async () => {
    await convertMod.convertSpaceLinks(SPACE);
    assert.deepEqual((await coll('facts').findOne({ _id: M1 })).entityIds, [E1, E2]);
    const chrono = await coll('chrono').findOne({ _id: C1 });
    assert.deepEqual(chrono.entityIds, [E1]);
    assert.deepEqual(chrono.memoryIds, [M1]);
    const file = await coll('files').findOne({ _id: 'notes/one.md' });
    assert.deepEqual(file.entityIds, [E2]);
    assert.deepEqual(file.chronoIds, [C1],
      'an array the conversion removed is restored by any peer on an older build, and the space then holds'
      + '\n  two answers to one question');
  });

  it('a record with no arrays at all is walked and produces nothing', async () => {
    // A peer on an older build sends records with no `chronoIds` key. Reading that as "remove the chrono
    // links" would delete data on the strength of a field the sender never had.
    await coll('facts').insertOne({ _id: 'dddddddd-0000-4000-8000-000000000001', spaceId: SPACE, fact: 'bare', seq: 9 });
    const report = await convertMod.convertSpaceLinks(SPACE);
    assert.equal(report.failed, 0);
    assert.deepEqual(await linkPairs(), EXPECTED);
    assert.equal(report.scanned.facts, 2, 'the bare record must still be WALKED, not skipped');
  });

  it('a link that exists ONLY as a record SURVIVES the conversion', async () => {
    /*
     * The conversion announces itself to the operator as *"additive: nothing is removed"*, and on a live
     * instance it printed `general converted — -1 link(s) created`. A negative creation count is a
     * deletion wearing the wrong name.
     *
     * **How a record-only link comes to exist.** Until `Q-28`, `linkEntities` wrote a link RECORD and
     * left the array alone. So a caller who used the spelling the MCP schemas publish produced exactly
     * this shape: a real link, stored, with an empty array beside it.
     *
     * `reconcileLinksForDocument` then builds its DESIRED set from the arrays — `entityIds: []` means
     * "this record links to no entities" — and `reconcileLinks` deletes every link record that the
     * desired set does not name, writing a tombstone so the deletion replicates. The migration therefore
     * destroys the links it was written to preserve, permanently and on every peer.
     */
    /*
     * Its OWN state: the shared seed carries arrays, which convert into records and would make the
     * counts below say something about the seed rather than about this case.
     */
    for (const c of ['entities', 'facts', 'chrono', 'files', 'links', 'tombstones']) {
      await coll(c).deleteMany({});
    }
    await coll('facts').insertOne({
      _id: M1, spaceId: SPACE, fact: 'a claim whose link was written the new way', tags: [],
      entityIds: [], seq: 1, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
      author: AUTHOR,
    });
    await coll('entities').insertOne({
      _id: E1, spaceId: SPACE, name: 'Vault', type: 'service', tags: [], seq: 2,
      createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z',
    });
    // The link, as `linkEntities` wrote it before Q-28: a record, and nothing in the array.
    await coll('links').insertOne({
      _id: `${M1}:fact>entity:${E1}`, spaceId: SPACE, from: M1, fromKind: 'fact', to: E1, toKind: 'entity',
      author: AUTHOR, createdAt: '2026-01-02T00:00:00.000Z', updatedAt: '2026-01-02T00:00:00.000Z', seq: 3,
    });
    assert.equal(await coll('links').countDocuments({}), 1, 'precondition: the link is there to lose');

    const report = await convertMod.convertSpaceLinks(SPACE);

    assert.equal(await coll('links').countDocuments({}), 1,
      'the conversion DELETED a link that existed only as a record — it is announced to the operator as '
      + '"additive: nothing is removed", and a tombstone makes the loss replicate to every peer');
    assert.equal(await coll('tombstones').countDocuments({}), 0,
      'and it wrote a tombstone for it, so the deletion is permanent rather than repairable by a re-run');
    assert.ok(report.added >= 0,
      `the report said ${report.added} link(s) created — a creation count cannot be negative, and a `
      + 'DELTA reported as a total cannot tell "nothing to do" from "one made and one destroyed"');
  });

  it('convertAllLinks sets completeLinkage on a clean run', async () => {
    await convertMod.convertAllLinks();
    const space = loader.getConfig().spaces.find(s => s.id === SPACE);
    assert.equal(space.completeLinkage, true,
      'the conversion finished clean and the space is not marked, so nothing in 2b can tell a converted'
      + '\n  space from one that has never been touched');
  });

  it('and a space that is already converted stays marked without re-writing anything', async () => {
    await convertMod.convertAllLinks();
    const before = await linkPairs();
    await convertMod.convertAllLinks();
    assert.deepEqual(await linkPairs(), before);
    assert.equal(loader.getConfig().spaces.find(s => s.id === SPACE).completeLinkage, true);
  });
});
