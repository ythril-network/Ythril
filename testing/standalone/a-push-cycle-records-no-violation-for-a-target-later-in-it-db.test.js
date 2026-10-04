/**
 * On the PUSH door, a strict-linkage violation is never recorded for a target the same push cycle delivers, and the
 * push is answered without waiting for the check (bundle-30 I13, pre-ship observability O1 / data-integrity DI-1 and
 * reliability R2).
 *
 * ## The defect
 *
 * I8 made the check wait for "the whole transfer", and on the push door it took the REQUEST as the transfer. But the
 * sender pushes one family per `batch-upsert` request, in `REPLICATED_FAMILIES` order — and that order put edges before
 * chrono and links before file metadata. So an edge to a chrono entry, or a link to a file, created in the same
 * interval was checked before its target's request arrived: recorded as missing, for good, with a webhook. The pull
 * test could not see it, because the pull checks once after every family.
 *
 * And the push door AWAITED the check before answering, outside the write bound, with no deadline on its read — so a
 * stalled store held the push answer past the sender's 60 s, which the write bound exists to prevent.
 *
 * ## What is asserted
 *
 * - The sender's push cycle is captured from the REAL engine (its `batch-upsert` requests, in the order it sent them)
 *   and replayed, request by request, into the real push door: an edge to a chrono entry and a link to a file that
 *   the cycle also carries record nothing; an edge to an entry no request carries records exactly one violation.
 * - A push whose check's read hangs is answered anyway, and the check runs inside a write bound of its own.
 *
 * Run: node --test testing/standalone/a-push-cycle-records-no-violation-for-a-target-later-in-it-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'pushwait';
let door, linkage, writeBound;

/** Every linkage check the push door started has finished (a check runs after the answer). */
async function checksSettled() {
  await linkage.whenLinkageChecksSettle?.();
}
const violationsOf = async (docId) =>
  (await door.mongo.col(`${S}_link_violations`).find({ docId }).toArray()).map(v => v.field).sort();

/** Store records in this instance's space, as its own writes would, so the engine's push cycle offers them. */
async function seedLocal(byPart) {
  let top = 0;
  for (const [part, docs] of Object.entries(byPart)) {
    if (docs.length === 0) continue;
    await door.mongo.col(`${S}_${part}`).insertMany(docs.map(d => ({ ...d })));
    for (const d of docs) top = Math.max(top, d.seq);
  }
  await door.bumpSeq(S, top);
}

/** One push cycle of the real engine, captured as the requests it sent: one `{ key, docs }` per batch-upsert body. */
async function capturePushCycle() {
  await door.sync();
  const requests = [];
  for (const { key, ...doc } of door.state.pushedRecords) {
    if (requests.at(-1)?.key !== key) requests.push({ key, docs: [] });
    requests.at(-1).docs.push(doc);
  }
  return requests;
}

describe('a push cycle records no violation for a target later in it', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'pushwait', spaces: [S], direction: 'push' });
    linkage = await import('../../server/dist/sync/linkage-check.js');
    writeBound = await import('../../server/dist/db/write-bound.js');
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.reset({ direction: 'push' });
    await door.mongo.col(`${S}_link_violations`).deleteMany({});
  });

  it('an edge to a chrono entry and a link to a file, pushed in one cycle with their targets, record nothing', async () => {
    const [a, b, edge, fact, link, dangling, edge2] = Array.from({ length: 7 }, () => randomUUID());
    const file = `notes/${randomUUID()}.md`;
    await seedLocal({
      facts: [build.fact(S, fact, 1)],
      chrono: [build.chrono(S, a, 2), build.chrono(S, b, 3)],
      files: [build.filemeta(S, file, 4)],
      edges: [build.edge(S, edge, 5, { from: a, to: b, fromKind: 'chrono', toKind: 'chrono' }),
        build.edge(S, edge2, 6, { from: a, to: dangling, fromKind: 'chrono', toKind: 'chrono' })],
      links: [build.link(S, link, 7, { from: fact, fromKind: 'fact', to: file, toKind: 'file' })],
    });
    const requests = await capturePushCycle();
    const keys = requests.map(r => r.key);
    for (const k of ['facts', 'chrono', 'filemeta', 'edges', 'links']) {
      assert.ok(keys.includes(k), `the engine pushed no ${k} request — the fixture is broken: ${keys}`);
    }

    // The receiver: the same space, empty, sent exactly what the sender sent, in the order it sent it.
    await door.reset({ direction: 'push' });
    for (const { key, docs } of requests) {
      const r = await door.push('/batch-upsert', { [key]: docs }, { spaceId: S });
      assert.equal(r.code, 200, `batch-upsert ${key}: ${JSON.stringify(r.body)}`);
    }
    await checksSettled();
    assert.ok(await door.mongo.col(`${S}_edges`).findOne({ _id: edge }), 'the edge did not land — the fixture is broken');
    assert.ok(await door.mongo.col(`${S}_files`).findOne({ _id: file }), 'the file metadata did not land — the fixture is broken');

    assert.deepEqual(await violationsOf(edge), [],
      `an edge to a chrono entry the same cycle delivered was recorded missing (the cycle pushed ${keys.join(', ')})`);
    assert.deepEqual(await violationsOf(fact), [],
      `a link to a file the same cycle delivered was recorded missing (the cycle pushed ${keys.join(', ')})`);
    assert.deepEqual(await violationsOf(edge2), ['to'], 'a dangling end no request carries must be recorded, once');
  });

  it('a push is answered while its check is still reading, and the check runs inside a write bound', async () => {
    const [from, missing, edge] = [randomUUID(), randomUUID(), randomUUID()];
    await door.push('/batch-upsert', { chrono: [build.chrono(S, from, 1)] }, { spaceId: S });
    await checksSettled();

    // The check's read of the chrono collection hangs until released; nothing else is touched.
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const realFind = proto.find;
    let release;
    const released = new Promise(r => { release = r; });
    const timeLeftAtRead = [];
    proto.find = function maybeHang(filter, ...rest) {
      if (this.collectionName === `${S}_chrono` && filter?._id?.$in) {
        timeLeftAtRead.push(writeBound.boundTimeLeft());
        // Released, the read answers what the store holds — so the check's outcome is the real one.
        return { toArray: async () => { await released; return realFind.call(this, filter, ...rest).toArray(); } };
      }
      return realFind.call(this, filter, ...rest);
    };
    try {
      const answered = door.push('/batch-upsert',
        { edges: [build.edge(S, edge, 2, { from, to: missing, fromKind: 'chrono', toKind: 'chrono' })] }, { spaceId: S });
      const outcome = await Promise.race([answered.then(r => r.code),
        new Promise(r => setTimeout(() => r('still waiting'), 5_000))]);
      assert.equal(outcome, 200, 'the push answer waited on the linkage check — a stalled store holds it past the sender\'s timeout');
    } finally {
      release();
      proto.find = realFind;
    }
    await checksSettled();
    assert.ok(timeLeftAtRead.length > 0, 'the check never read the chrono collection — the fixture is broken');
    assert.ok(timeLeftAtRead.every(t => typeof t === 'number'),
      `the check's read ran outside any write bound (time left: ${timeLeftAtRead}) — nothing ends it if the store stalls`);
    assert.deepEqual(await violationsOf(edge), ['to'], 'the check did not run after the answer');
  });
});
