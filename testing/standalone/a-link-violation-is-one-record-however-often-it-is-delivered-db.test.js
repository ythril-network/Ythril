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
let door, subscribeBrainChanges, linkIdFor, forkIdFor, unsubscribe, events;

const violations = () => door.coll(S, 'link_violations');
const rows = () => violations().find({}).sort({ field: 1 }).toArray();

/** Wait for the fire-and-forget check of a delivery to have written `n` records, then leave room for a stray extra one. */
async function settleAt(n) {
  assert.ok(await eventually(async () => (await violations().countDocuments({})) >= n, 5_000, 25), `fewer than ${n} violation record(s) appeared`);
  await new Promise(r => setTimeout(r, 400));
  return violations().countDocuments({});
}

describe('a link violation is one record however often it is delivered', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'violations', spaces: [{ id: S, label: 'Violations', folders: [], meta: { strictLinkage: true } }] });
    ({ subscribeBrainChanges } = await import('../../server/dist/brain/brain-events.js'));
    ({ linkIdFor } = await import('../../server/dist/brain/links.js'));
    ({ forkIdFor } = await import('../../server/dist/sync/upsert-plan.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    await violations().deleteMany({});
    events = [];
    unsubscribe?.();
    unsubscribe = subscribeBrainChanges(S, (ev) => { if (ev.event === 'link_violation.created') events.push(ev); });
  });

  const edge = (id, seq, extra = {}) => build.edge(S, id, seq, { from: randomUUID(), to: randomUUID(), ...extra });
  const deliver = (doc) => door.push('/edges', doc, { spaceId: S });

  it('control: an edge whose two ends are missing records one violation per end', async () => {
    assert.equal((await deliver(edge('e1', 5))).code, 200);
    assert.equal(await settleAt(2), 2);
    assert.deepEqual((await rows()).map(r => r.field), ['from', 'to']);
  });

  it('delivering the same edge again records nothing new', async () => {
    const e = edge('e1', 5);
    await deliver(e);
    assert.equal(await settleAt(2), 2);
    await deliver(e);
    assert.equal(await settleAt(2), 2, 'a re-delivery added records');
  });

  it('an edit of the edge that leaves the same ends dangling records nothing new', async () => {
    const e = edge('e1', 5);
    await deliver(e);
    assert.equal(await settleAt(2), 2);
    await deliver({ ...e, seq: 6, description: 'edited' });
    assert.equal(await settleAt(2), 2, 'an edit added records');
  });

  it('the announcement fires once per record INSERTED, not once per delivery', async () => {
    const e = edge('e1', 5);
    await deliver(e);
    await settleAt(2);
    await deliver(e);
    await deliver({ ...e, seq: 6 });
    await settleAt(2);
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
    assert.equal(await settleAt(1), 1);
  });

  it('PIN different violations stay different records: another target, and the two ends of one edge', async () => {
    const fact = randomUUID();
    const [m1, m2] = [randomUUID(), randomUUID()];
    const link = (to) => build.link(S, linkIdFor(fact, 'fact', to, 'entity'), 5, { from: fact, fromKind: 'fact', to, toKind: 'entity' });
    await door.push('/batch-upsert', { links: [link(m1), link(m2)] }, { spaceId: S });
    assert.equal(await settleAt(2), 2, 'two dangling targets of one record were folded into one');
    await deliver(edge('e1', 5));
    assert.equal(await settleAt(4), 4, 'the two ends of one edge were folded into one');
    assert.equal(new Set((await rows()).map(r => r._id)).size, 4);
  });

  it('what is stored of a peer\'s text in the reason is bounded: a huge target is not stored whole', async () => {
    const fact = randomUUID();
    const huge = `docs/${'x'.repeat(20_000)}.md`;
    const r = await door.push('/batch-upsert', { links: [build.link(S, linkIdFor(fact, 'fact', huge, 'file'), 5, { from: fact, fromKind: 'fact', to: huge, toKind: 'file' })] }, { spaceId: S });
    assert.equal(r.code, 200, JSON.stringify(r.body));
    assert.equal(await settleAt(1), 1);
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
    await settleAt(3);
    await deliver({ ...e, seq: 6 });
    await deliver(e);
    assert.ok(await settleAt(3) <= 3, 'a stored random-id row kept producing new records on each delivery');
  });

  it('PIN forkIdFor answers byte-for-byte what 5.6.3 answered', () => {
    assert.equal(forkIdFor('cccccccc-0000-4000-8000-000000000001', 7, 'diverging text'), 'f1c4bfcb-fc60-405b-90da-1ed27e28aa50');
    assert.equal(forkIdFor('a', 1, ''), '6d2f8506-bc2d-4354-945d-dcb95089125c');
  });
});