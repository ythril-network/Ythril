/**
 * Deleting a record deletes its unresolved versions, and an arriving tombstone does the same here without issuing any (Q-624 design §7, test 22).
 *
 * ## What it prevents
 *
 * Today the delete tools say forks "are own records and are not deleted", so deleting a fact leaves its forks as orphans that Review
 * hides (`forks.ts` lists a fork only when its parent exists). With every kind forking, a delete that left forks standing would leave
 * the user's unchosen versions of a record they deleted, and a peer that applied the subject's tombstone would keep orphans the deleting
 * instance does not have: a permanent merkle divergence. D2: the tombstone wins.
 *
 * ## The rule
 *
 *  - an explicit delete (`deleteFact`, `deleteEntity`, `deleteChrono`, `deleteEdge`) removes every fork of the subject, EACH with a tombstone
 *    issued here, and the subject's own;
 *  - the entity delete's cascade preview counts the forks that will go (the field is named for them; the design does not fix its name);
 *  - the TTL sweep removes a subject that expired together with its forks, each tombstoned;
 *  - an APPLIED peer tombstone removes the subject's forks here and issues NO tombstone for any of them;
 *  - the cascade runs for the tombstoned IDS (R7): a subject that is `absent` here but whose forks are stored loses them; a subject whose
 *    delete the authority declined keeps its forks (it still stands, so they are still its unresolved versions); a re-delivered tombstone
 *    (`already_newer`) repeats nothing harmful;
 *  - a fork arriving after its parent's tombstone is `tombstoned`: nothing is stored.
 *
 * Not driven: a subject whose delete the write BOUND refused (the bound is a race between the verdict and the write, which the design
 * names but gives no seam to hold open).
 *
 * Run: node --test testing/standalone/a-delete-takes-its-forks-db.test.js  (requires a prior server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, PEER_TOKEN, peerToken } from './_push-door.mjs';
import { FORK_KINDS, initForkFixtures, seedFork, forkIdOf } from './_q624-fork-fixtures.mjs';

const skip = await mongoSkipReason();
const S = 'q624delete';
const AUTHOR = 'push-door-peer';

describe('a delete takes its forks', { skip }, () => {
  let door; let deletes; let ttl;

  before(async () => {
    door = await openPushDoor({ suite: 'q624t3_delete', spaces: [{ id: S, label: 'Delete', folders: [], meta: {} }] });
    await initForkFixtures();
    deletes = {
      fact: (await import('../../server/dist/brain/fact.js')).deleteFact,
      entity: (await import('../../server/dist/brain/entities.js')).deleteEntity,
      chrono: (await import('../../server/dist/brain/chrono.js')).deleteChrono,
      edge: (await import('../../server/dist/brain/edges.js')).deleteEdge,
    };
    ttl = await import('../../server/dist/brain/ttl-sweep.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  /** A subject and two forks of it; an edge subject needs its own endpoints. Returns ids. */
  async function subjectWithForks(kind, { storeSubject = true } = {}) {
    const k = FORK_KINDS[kind];
    let subject = randomUUID(); let identity = {};
    if (kind === 'edge') {
      const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');
      const [a, b] = [randomUUID(), randomUUID()];
      identity = { from: a, to: b, label: 'knows' };
      subject = edgeIdFor(a, b, 'knows', 'entity', 'entity');
      await door.coll(S, 'entities').insertMany([build.entity(S, a, 1), build.entity(S, b, 1)]);
    }
    if (storeSubject) await door.coll(S, k.family).insertOne(k.row(S, subject, 5, { pos: 5, posAtSeq: 5, ...identity }));
    const f1 = await seedFork(door, S, kind, subject, 5, { ...identity, ...k.alt });
    const f2 = await seedFork(door, S, kind, subject, 5, { ...identity, ...Object.fromEntries(Object.entries(k.alt).map(([a, v]) => [a, `${v} two`])) });
    return { k, subject, forks: [f1._id, f2._id] };
  }
  const stillStored = async (family, ids) => (await Promise.all(ids.map(id => door.coll(S, family).countDocuments({ _id: id })))).reduce((a, b) => a + b, 0);
  const tombstonedHere = async (ids) => (await Promise.all(ids.map(async id => (await door.coll(S, 'tombstones').findOne({ _id: id }))?.issuedHere === true))).filter(Boolean).length;
  const tombstoned = async (ids) => door.coll(S, 'tombstones').countDocuments({ _id: { $in: ids } });
  const wire = (id, kind, seq, issuer = AUTHOR) => build.tombstone(S, id, kind, seq, { instanceId: issuer });

  for (const kind of Object.keys(FORK_KINDS)) {
    describe(kind, () => {
      it('an explicit delete removes the subject and every fork, each behind a tombstone issued here', async () => {
        const { k, subject, forks } = await subjectWithForks(kind);
        assert.equal(await deletes[kind](S, subject), true, 'the delete answered false');
        assert.equal(await stillStored(k.family, [subject]), 0, 'the subject is still stored');
        assert.equal(await stillStored(k.family, forks), 0, `${await stillStored(k.family, forks)} fork(s) of a deleted ${kind} are still stored: orphans that Review never lists`);
        assert.equal(await tombstonedHere(forks), forks.length, 'a fork was removed without a tombstone issued here, so peers keep it');
      });

      it('an applied peer tombstone for the subject removes its forks here and issues no tombstone for them', async () => {
        const { k, subject, forks } = await subjectWithForks(kind);
        const r = await door.push('/tombstones', { tombstones: [wire(subject, kind, 9)] }, { spaceId: S, token: peerToken(AUTHOR) });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(await stillStored(k.family, [subject]), 0, 'fixture check: the subject\'s tombstone was not applied');
        assert.equal(await stillStored(k.family, forks), 0, 'a fork of the tombstoned subject stands: this instance now holds orphans every other instance lacks');
        assert.equal(await tombstoned(forks), 0, 'the cascade issued tombstones for forks: each instance removes its own, nothing crosses');
      });

      it('R7: a subject that is absent here but whose forks are stored loses the forks to its tombstone', async () => {
        const { k, subject, forks } = await subjectWithForks(kind, { storeSubject: false });
        await door.push('/tombstones', { tombstones: [wire(subject, kind, 9)] }, { spaceId: S, token: peerToken(AUTHOR) });
        assert.equal(await stillStored(k.family, forks), 0, 'forks of an absent, tombstoned subject were kept: the cascade runs on the rows it deleted, not on the tombstoned ids');
      });

      it('R7: a tombstone the authority declines leaves the subject and its forks standing', async () => {
        const { k, subject, forks } = await subjectWithForks(kind);
        await door.push('/tombstones', { tombstones: [wire(subject, kind, 9, 'someone-else')] }, { spaceId: S, token: peerToken('someone-else') });
        assert.equal(await stillStored(k.family, [subject]), 1, 'fixture check: a declined tombstone deleted the subject');
        assert.equal(await stillStored(k.family, forks), forks.length, 'forks went with a subject that still stands');
      });

      it('R7: the same tombstone delivered again repeats nothing harmful', async () => {
        const { k, subject, forks } = await subjectWithForks(kind);
        for (let i = 0; i < 2; i++) {
          const r = await door.push('/tombstones', { tombstones: [wire(subject, kind, 9)] }, { spaceId: S, token: peerToken(AUTHOR) });
          assert.equal(r.code, 200, `delivery ${i + 1}: ${JSON.stringify(r.body)}`);
        }
        assert.equal(await stillStored(k.family, [subject, ...forks]), 0, 'a record survived its re-delivered tombstone');
        assert.equal(await tombstoned(forks), 0, 'a re-delivery issued fork tombstones');
      });

      it('a fork arriving after its parent\'s tombstone is tombstoned: nothing is stored', async () => {
        const k = FORK_KINDS[kind];
        const parent = randomUUID();
        await door.push('/tombstones', { tombstones: [wire(parent, kind, 9)] }, { spaceId: S, token: PEER_TOKEN });
        const row = { ...k.row(S, 'late', 5, kind === 'edge' ? { from: randomUUID(), to: randomUUID(), label: 'knows', ...k.alt } : k.alt), forkOf: parent };
        row._id = forkIdOf(k.family, parent, row);
        const r = await door.push('/batch-upsert', { [k.family]: [row] }, { spaceId: S });
        assert.equal(r.code, 200, JSON.stringify(r.body));
        assert.equal(await stillStored(k.family, [row._id]), 0, 'a fork of a tombstoned parent was stored');
        assert.ok((r.body[k.family]?.tombstoned ?? 0) >= 1, `the page did not count it tombstoned: ${JSON.stringify(r.body[k.family])}`);
      });

      it('the TTL sweep removes an expired subject together with its forks, each tombstoned', async () => {
        const { k, subject, forks } = await subjectWithForks(kind);
        await door.coll(S, k.family).updateOne({ _id: subject }, { $set: { _expireAt: new Date(Date.now() - 60_000) } });
        await ttl.sweepExpired(new Date());
        assert.equal(await stillStored(k.family, [subject]), 0, 'fixture check: the sweep did not remove the expired subject');
        assert.equal(await stillStored(k.family, forks), 0, 'the sweep left forks of an expired record');
        assert.equal(await tombstonedHere(forks), forks.length, 'the sweep removed a fork without a tombstone issued here');
      });
    });
  }

  it('the entity cascade preview counts the forks that will go', async () => {
    const { previewEntityCascade } = await import('../../server/dist/brain/entity-delete-cascade.js');
    const { subject } = await subjectWithForks('entity');
    const preview = await previewEntityCascade(S, subject);
    assert.match(JSON.stringify(preview), /"[A-Za-z]*[Ff]orks?[A-Za-z]*":\s*2\b/, `the preview does not count the two forks that will go: ${JSON.stringify(preview).slice(0, 300)}`);
  });
});
