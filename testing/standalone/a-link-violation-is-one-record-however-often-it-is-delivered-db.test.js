/**
 * A strict-linkage violation a peer's document causes is ONE record however often that document is delivered, and its
 * announcement fires once (Q-361 item 17).
 *
 * ## The defect
 *
 * `recordLinkViolation` gave every record a fresh random id and inserted it, and the single `POST /api/sync/edges` checks
 * an arriving edge on EVERY delivery — a re-send after a lost 200, an edit, the same edge pushed again. So one dangling
 * endpoint became one more record each time (the Review list grew with the sender's retries), and each one announced
 * `link_violation.created` to every subscriber again.
 *
 * ## The rule
 *
 * The record's id is DERIVED from what it names — the document type, the document id, the field and the target — and the
 * record is written with a set-on-insert, so:
 *
 *  - delivering the same document again, or an edit of it that leaves the same endpoint dangling, records nothing new;
 *  - the announcement (the webhook and the live event) fires only when a record was INSERTED;
 *  - two different violations stay two records: another target, or the other end of the same edge;
 *  - the reason does not enter the id (it is text that can change with the document), and what is stored of it is
 *    bounded: a peer's text is rendered through the one bounded renderer, so a megabyte target is not stored whole;
 *  - a record already stored under a random id (written by 5.6.3) gets, at most, ONE derived twin on the next delivery,
 *    and no more after it — a stored row converges as its document is delivered again, with no sweep.
 *
 * And, because the id is shaped like a fork's, the fork id stays byte-for-byte what it was: a changed fork id would fork
 * every record again on a mixed-version network (pinned to values computed on 5.6.3).
 *
 * Seen red on 6eb5a333 (5.6.3): every delivery adds a record and fires the event; the reason is stored whole.
 *
 * Run: node --test testing/standalone/a-link-violation-is-one-record-however-often-it-is-delivered-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { eventually } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const S = 'violations';
let door, subscribeBrainChanges, linkIdFor, forkIdFor, unsubscribe, events, proto, priorUpdateOne;

const violations = () => door.coll(S, 'link_violations');
const rows = () => violations().find({}).sort({ field: 1 }).toArray();

/**
 * The check of a delivery is fire-and-forget, so the answer says nothing of whether it has run. What a delivery's own
 * completion is observable as: each violation it checks ends in ONE write to the violations collection, whether that
 * write inserts a record or finds the one it already holds. The writes are counted as they COMPLETE (the same probe the
 * push door puts on the counter), so "nothing new was recorded" is asserted AFTER the check that could have recorded
 * it has finished — never after a guess of how long that takes.
 */
let writesCompleted = 0;
let writesExpected = 0;

/**
 * Wait for the checks of the deliveries so far to have completed — `checks` more violation writes than last time —
 * and answer how many records the collection holds then. More writes than the deliveries make is a failure too.
 */
async function settleAfter(checks) {
  writesExpected += checks;
  assert.ok(await eventually(() => writesCompleted >= writesExpected, 5_000, 10),
    `${writesExpected - writesCompleted} of the ${checks} expected violation write(s) never completed`);
  assert.equal(writesCompleted, writesExpected, 'a delivery wrote more violation checks than it should have');
  return violations().countDocuments({});
}

describe('a link violation is one record however often it is delivered', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'violations', spaces: [{ id: S, label: 'Violations', folders: [], meta: { strictLinkage: true } }] });
    ({ subscribeBrainChanges } = await import('../../server/dist/brain/brain-events.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/links.js'));
    ({ forkIdFor } = await import('../../server/dist/sync/upsert-plan.js'));
    // The completion probe, on top of the door's own (the door's close puts its originals back, so ours is removed first).
    proto = Object.getPrototypeOf(door.mongo.col('probe'));
    priorUpdateOne = proto.updateOne;
    proto.updateOne = async function observed(...args) {
      try { return await priorUpdateOne.apply(this, args); } finally {
        if (this.collectionName === `${S}_link_violations`) writesCompleted++;
      }
    };
  });
  after(async () => {
    unsubscribe?.();
    if (proto && priorUpdateOne) proto.updateOne = priorUpdateOne;
    await door?.close();
  });
  beforeEach(async () => {
    await door.wipe(S);
    await violations().deleteMany({});
    writesCompleted = 0;
    writesExpected = 0;
    events = [];
    unsubscribe?.();
    unsubscribe = subscribeBrainChanges(S, (ev) => { if (ev.event === 'link_violation.created') events.push(ev); });
  });

  const edge = (id, seq, extra = {}) => build.edge(S, id, seq, { from: randomUUID(), to: randomUUID(), ...extra });
  const deliver = (doc) => door.push('/edges', doc, { spaceId: S });

  it('control: an edge whose two ends are missing records one violation per end', async () => {
    assert.equal((await deliver(edge('e1', 5))).code, 200);
    assert.equal(await settleAfter(2), 2);
    assert.deepEqual((await rows()).map(r => r.field), ['from', 'to']);
  });

  it('delivering the same edge again records nothing new', async () => {
    const e = edge('e1', 5);
    await deliver(e);
    assert.equal(await settleAfter(2), 2);
    await deliver(e);
    assert.equal(await settleAfter(2), 2, 'a re-delivery added records');
  });

  it('an edit of the edge that leaves the same ends dangling records nothing new', async () => {
    const e = edge('e1', 5);
    await deliver(e);
    assert.equal(await settleAfter(2), 2);
    await deliver({ ...e, seq: 6, description: 'edited' });
    assert.equal(await settleAfter(2), 2, 'an edit added records');
  });

  it('two documents that dangle at the same field and target are two records, not one', async () => {
    // The id names the DOCUMENT as well as the field and the target: a dangling end shared by two edges is a violation
    // of each of them, and the Review list is where an operator finds out which edges to repair.
    const [from, to] = [randomUUID(), randomUUID()];
    // A distinct label keeps the second edge from being refused as a duplicate of the first's relationship.
    await deliver(edge('e1', 5, { from, to, label: 'one' }));
    await deliver(edge('e2', 5, { from, to, label: 'two' }));
    assert.equal(await settleAfter(4), 4, 'two edges with the same dangling ends were folded into one record per end');
    const stored = await rows();
    assert.deepEqual(stored.map(r => r.docId).sort(), ['e1', 'e1', 'e2', 'e2']);
    assert.equal(new Set(stored.map(r => r._id)).size, 4);
  });

  it('the announcement fires once per record INSERTED, not once per delivery', async () => {
    const e = edge('e1', 5);
    await deliver(e);
    await settleAfter(2);
    await deliver(e);
    await deliver({ ...e, seq: 6 });
    await settleAfter(4);
    assert.equal(events.length, 2, `${events.length} link_violation.created events for two records`);
  });

  it('a link delivered again, and edited, is still one record', async () => {
    const fact = randomUUID();
    const missing = randomUUID();
    const link = (seq) => build.link(S, linkIdFor(fact, 'fact', missing, 'entity'), seq, { from: fact, fromKind: 'fact', to: missing, toKind: 'entity' });
    for (const seq of [5, 5, 6]) {
      const r = await door.push('/batch-upsert', { links: [link(seq)] }, { spaceId: S });
      assert.equal(r.code, 200, JSON.stringify(r.body));
    }
    // The re-send at the same seq is not applied, so it is not checked; the edit at seq 6 is, and finds the record.
    assert.equal(await settleAfter(2), 1);
  });

  it('PIN different violations stay different records: another target, and the two ends of one edge', async () => {
    const fact = randomUUID();
    const [m1, m2] = [randomUUID(), randomUUID()];
    const link = (to) => build.link(S, linkIdFor(fact, 'fact', to, 'entity'), 5, { from: fact, fromKind: 'fact', to, toKind: 'entity' });
    await door.push('/batch-upsert', { links: [link(m1), link(m2)] }, { spaceId: S });
    assert.equal(await settleAfter(2), 2, 'two dangling targets of one record were folded into one');
    await deliver(edge('e1', 5));
    assert.equal(await settleAfter(2), 4, 'the two ends of one edge were folded into one');
    assert.equal(new Set((await rows()).map(r => r._id)).size, 4);
  });

  it('what is stored of a peer\'s text in the reason is bounded: a huge target is not stored whole', async () => {
    const fact = randomUUID();
    const huge = `docs/${'x'.repeat(20_000)}.md`;
    const r = await door.push('/batch-upsert', { links: [build.link(S, linkIdFor(fact, 'fact', huge, 'file'), 5, { from: fact, fromKind: 'fact', to: huge, toKind: 'file' })] }, { spaceId: S });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(await settleAfter(1), 1);
    const [row] = await rows();
    assert.ok(row.reason.length < 5_000, `a ${row.reason.length}-character reason was stored: ${row.reason.slice(0, 80)}…`);
    assert.match(row.reason, /non-existent file/, 'the reason lost what it says');
  });

  it('a record stored under a random id (5.6.3) gets at most one derived twin, and no more after it', async () => {
    const e = edge('e1', 5);
    const stale = { _id: randomUUID(), spaceId: S, docId: 'e1', docType: 'edge', field: 'from',
      reason: `from references non-existent entity '${e.from}'`, peerInstanceId: 'push-door-peer', detectedAt: '2026-09-01T00:00:00.000Z' };
    await violations().insertOne(stale);
    await deliver(e);
    assert.equal(await settleAfter(2), 3, 'the first delivery after 5.6.3 adds its derived twin and the missing end');
    await deliver({ ...e, seq: 6 });
    await deliver(e);
    assert.equal(await settleAfter(4), 3, 'a stored random-id row kept producing new records on each delivery');
  });

  it('PIN forkIdFor answers byte-for-byte what 5.6.3 answered', () => {
    assert.equal(forkIdFor('cccccccc-0000-4000-8000-000000000001', 7, 'diverging text'), 'f1c4bfcb-fc60-405b-90da-1ed27e28aa50');
    assert.equal(forkIdFor('a', 1, ''), '6d2f8506-bc2d-4354-945d-dcb95089125c');
  });
});