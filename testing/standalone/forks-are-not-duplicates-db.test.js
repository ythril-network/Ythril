/**
 * An unchosen version of an entity or a chrono entry is not a duplicate of it, and nothing that resolves a name or merges two records
 * reaches it (Q-624 design §6 "Entities and chrono", test 20).
 *
 * ## What it prevents
 *
 * A fork row is stored beside its subject with the same `name` (or the same `title`) and almost the same body, which is exactly what
 * every duplicate reader looks for. Left in their candidate sets:
 *  - the duplicate scanner proposes a subject and its fork as a pair, and AUTOMERGE merges them: the unchosen version is absorbed with no
 *    user ever choosing, which is the loss D-23 forbids;
 *  - `findEntitiesByName` (which resolves a name to THE entity for edge-by-names and dedupe-on-insert) returns two records, so the name is
 *    ambiguous and an insert by that name may write onto the fork;
 *  - `graph_merge` accepts a fork as survivor or absorbed and changes a row that only Review, delete or arrival may change.
 *
 * ## The rule, for each reader and each kind it serves
 *
 *  - `findEntitiesByName` answers the subject alone;
 *  - an upsert by the subject's name lands on the subject and writes nothing on the fork (dedupe-on-insert);
 *  - the duplicate scanner never reads a fork row as a seed, for entity and for chrono (observed as a read of the row by id, the way
 *    `a-scanner-reads-every-record-of-a-tie-db` observes a scan), and records no candidate naming one;
 *  - `graph_merge` with a fork as survivor, and with a fork as absorbed, is refused `fork_row_read_only` and writes nothing.
 *
 * The duplicate notification and the automerge are the scanner's own callers (`handlePair`), so a pair the scanner never forms reaches
 * neither. Both kinds the scanner serves are driven; the vectors are not (a scan whose seeds have none still READS each seed, which is
 * what is asserted), so no case passes for lack of a search engine.
 *
 * Run: node --test testing/standalone/forks-are-not-duplicates-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { snapshotParts, changedParts, RECORD_PARTS } from './_space-snapshot.mjs';
import { FORK_KINDS, initForkFixtures, seedFork, reviewDoors } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();
const S = 'q624dupes';

describe('a fork is not a duplicate', { skip }, () => {
  let door; let loader; let proto; let realFindOne; let read; let doors; let scanner;

  before(async () => {
    door = await openPushDoor({ suite: 'q624t3_dupes', spaces: [{ id: S, label: 'Dupes', folders: [], meta: {} }] });
    await initForkFixtures();
    const available = await door.mongo.checkVectorSearchAvailability();
    assert.equal(available.available, true, 'the harness Mongo has no $vectorSearch: the scanner returns before reading anything, so the scanner cases would pass for no reason');
    loader = await import('../../server/dist/config/loader.js');
    scanner = await import('../../server/dist/brain/dupe-scanner.js');
    doors = await reviewDoors(door, S);
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    realFindOne = proto.findOne;
    proto.findOne = function recording(filter, ...rest) {
      if (typeof filter?._id === 'string' && this.collectionName.startsWith(`${S}_`)) read.push(`${this.collectionName.slice(S.length + 1)}:${filter._id}`);
      return realFindOne.call(this, filter, ...rest);
    };
  });
  after(async () => { if (proto && realFindOne) proto.findOne = realFindOne; await door?.close(); });
  beforeEach(async () => { read = []; await door.wipe(S); await door.mongo.col('ythril_dupe_scan_state').deleteMany({}); });

  /** The kinds the duplicate readers serve and that fork: derived from the fixture table, minus the two with no name to resolve. */
  const NAMED = ['entity', 'chrono'];

  it('findEntitiesByName answers the subject alone, and an upsert by that name lands on the subject', async () => {
    const { findEntitiesByName, upsertEntity } = await import('../../server/dist/brain/entities.js');
    const subject = randomUUID();
    await door.coll(S, 'entities').insertOne(build.entity(S, subject, 5, { name: 'Acme', description: 'the subject' }));
    const fork = await seedFork(door, S, 'entity', subject, 5, { name: 'Acme', description: 'the other version' });
    assert.deepEqual((await findEntitiesByName(S, 'Acme')).map(e => e._id), [subject], `the name 'Acme' resolves to ${(await findEntitiesByName(S, 'Acme')).length} records: the fork makes it ambiguous`);
    const before = await door.coll(S, 'entities').findOne({ _id: fork._id });
    const saved = await upsertEntity(S, 'Acme', 'concept', [], {}, 'edited by name');
    assert.equal(saved.entity._id, subject, 'an insert by the subject\'s name was written onto another record');
    assert.deepEqual(await door.coll(S, 'entities').findOne({ _id: fork._id }), before, 'dedupe-on-insert wrote the fork row');
  });

  for (const kind of NAMED) {
    it(`${kind}: the duplicate scanner reads the subject as a seed and never the fork`, async () => {
      const k = FORK_KINDS[kind];
      const subject = randomUUID();
      await door.coll(S, k.family).insertOne(k.row(S, subject, 5, { pos: 5, posAtSeq: 5 }));
      const fork = await seedFork(door, S, kind, subject, 5, k.alt);
      const cfg = loader.getConfig();
      cfg.dupeScanner = { ...(cfg.dupeScanner ?? {}), enabled: true, types: [kind], batchSize: 50, maxPerRun: 500 };
      await scanner.scanSpace(S);
      assert.ok(read.includes(`${k.family}:${subject}`), `fixture check: the scan never read the subject (read: ${read}), so it did not run over this collection`);
      assert.ok(!read.includes(`${k.family}:${fork._id}`), `${kind}: the scanner read the fork row as a seed: an unchosen version is a candidate for automerge`);
      const pairs = await door.mongo.col(`${S}_dupeCandidates`).find({}).toArray();
      assert.deepEqual(pairs.filter(p => [p.aId, p.bId].includes(fork._id)), [], `${kind}: a duplicate candidate names the fork`);
    });
  }

  it('graph_merge refuses a fork as survivor and as absorbed, and writes nothing', async () => {
    const [subject, other] = [randomUUID(), randomUUID()];
    await door.coll(S, 'entities').insertMany([build.entity(S, subject, 5, { name: 'Acme' }), build.entity(S, other, 4, { name: 'Other' })]);
    const fork = await seedFork(door, S, 'entity', subject, 5, { name: 'Acme', description: 'the other version' });
    const mongo = await import('../../server/dist/db/mongo.js');
    for (const [role, args] of [['survivor', { survivorId: fork._id, absorbedId: other }], ['absorbed', { survivorId: other, absorbedId: fork._id }]]) {
      const before = await snapshotParts(mongo, S, RECORD_PARTS);
      const r = await doors.mcp('graph_merge', { space: S, resolutions: [], ...args });
      assert.equal(r.ok, false, `graph_merge accepted a fork as ${role}`);
      assert.match(r.sentence ?? r.text, /fork_row_read_only|unresolved version|cannot be edited/, `the refusal for a fork as ${role} does not say the row is read-only: ${r.sentence ?? r.text}`);
      assert.deepEqual(changedParts(before, await snapshotParts(mongo, S, RECORD_PARTS)), [], `a refused merge of a fork as ${role} wrote something`);
    }
  });
});
