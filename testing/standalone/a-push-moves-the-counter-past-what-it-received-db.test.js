/**
 * Before a push is answered, this instance's seq counter is past every plausible seq the push carried — on every
 * push door, for every family, whatever was done with the document (`Q-198`, `Q-107` part 1 §3).
 *
 * ## Why the counter, and why before the answer
 *
 * The counter is what makes "a local write sorts above everything received" true. A record that arrived at seq
 * 40 while the counter stays at 5 lets the next local write take 6, and every peer that already holds the
 * arrival at 40 has a cursor past 6 — the local write is never pulled by them. That is the defect, and it has
 * three shapes on the base:
 *
 *   - the four SINGLE routes never bump at all;
 *   - `batch-upsert` bumps four of its six families (links and file metadata are left out), fire-and-forget,
 *     AFTER `res.json`;
 *   - `POST /tombstones` bumps fire-and-forget before the answer, unawaited.
 *
 * The counter is read AT THE MOMENT the handler answers (`_push-door.mjs`, `counterAtResponse`), so an unawaited
 * bump is caught deterministically rather than by losing a race.
 *
 * ## Over what — RECEIVED, not stored
 *
 * The page's highest seq is deliberately a document that is NOT stored (tombstoned, skipped against a newer
 * local copy, a chrono type this space does not declare): the counter follows the peer's clock, and a bump over
 * only what landed would leave it behind exactly where a re-created record is then refused. A seq the door
 * refuses as implausible is the opposite case — a sentinel near the ceiling must NOT move the counter, on any
 * door, tombstones included (they were checked only by `z.number()`).
 *
 * ## And a fork's own seq
 *
 * A fork is a LOCAL write and takes a local seq. Allocated from a counter still below the max received, it sorts
 * below the arrival that caused it, and a peer pulling from the arrival's seq never sees the fork. The fixture
 * writes the stored copy and a stale counter straight into the database, because every door now bumps and the
 * stale state can only come from the past.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-push-moves-the-counter-past-what-it-received-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES, familiesCarriedByBatch } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'pushclock';
let door, MAX_INGEST_SEQ;

/** Every batch family, derived from the route's own body keys and checked against the fixture table. */
const BATCH_FAMILIES = skip ? [] : familiesCarriedByBatch();
const SINGLE_ROUTES = Object.entries(FAMILIES).filter(([, f]) => f.single).map(([k, f]) => ({ key: k, ...f }));

function oneDoc(key, _id, seq, extra) {
  const kind = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link', filemeta: 'filemeta' }[key];
  return build[kind](S, _id, seq, extra);
}

describe('a push moves the counter past what it received, before it answers', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushclock', spaces: [{ id: S, label: 'Clock', folders: [], meta: {} }] });
    ({ MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); });

  it('the derivations found the families, so an empty set cannot pass', () => {
    assert.ok(BATCH_FAMILIES.length >= 6, `batch families: ${BATCH_FAMILIES}`);
    assert.deepEqual(BATCH_FAMILIES.filter(k => !FAMILIES[k]), [], 'a batch family with no fixture goes unchecked');
    assert.ok(SINGLE_ROUTES.length >= 4, `single routes: ${SINGLE_ROUTES.map(r => r.single)}`);
  });

  describe('single routes', () => {
    for (const r of SINGLE_ROUTES) {
      it(`POST ${r.single}: the counter is at least the received seq when the push is answered`, async () => {
        const res = await door.push(r.single, oneDoc(r.key, `${r.key}-1`, 40), { spaceId: S });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.ok(res.counterAtResponse >= 40,
          `POST ${r.single} answered with the counter at ${res.counterAtResponse}, below the seq 40 it stored. The `
          + 'next local write takes a seq below a record every peer already holds, and is never pulled by them');
      });
    }

    it('POST /chrono refusing an unknown type still bumps over the seq it parsed (the 400s are received too)', async () => {
      const res = await door.push('/chrono', oneDoc('chrono', 'c-odd', 45, { type: 'not-a-chrono-type' }), { spaceId: S });
      assert.equal(res.code, 400);
      assert.ok(res.counterAtResponse >= 45, `counter at ${res.counterAtResponse} after a parsed chrono at 45`);
    });
  });

  describe('batch-upsert', () => {
    for (const key of BATCH_FAMILIES) {
      it(`a ${key}-only page: the counter is at least its max seq when the page is answered`, async () => {
        const res = await door.push('/batch-upsert', { [key]: [oneDoc(key, `${key}-a`, 30), oneDoc(key, `${key}-b`, 40)] },
          { spaceId: S });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        assert.ok(res.counterAtResponse >= 40,
          `a ${key}-only page answered with the counter at ${res.counterAtResponse}, below its seq 40`);
        assert.ok(await door.counter(S) >= 40, `after the ${key}-only page the counter stayed at ${await door.counter(S)}`);
      });
    }

    it('the bump is over the max RECEIVED: a tombstoned, a skipped and an unknown-type document all count', async () => {
      await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'f-dead', 'fact', 70));
      await door.coll(S, 'facts').insertOne(build.fact(S, 'f-newer', 80));
      const res = await door.push('/batch-upsert', {
        facts: [build.fact(S, 'f-live', 10), build.fact(S, 'f-dead', 60), build.fact(S, 'f-newer', 50)],
        chrono: [build.chrono(S, 'c-odd', 65, { type: 'not-a-chrono-type' })],
      }, { spaceId: S });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.facts.inserted, res.body.facts.tombstoned, res.body.facts.skipped, res.body.chrono.unknownType],
        [1, 1, 1, 1], JSON.stringify(res.body));
      assert.ok(res.counterAtResponse >= 65,
        `the page's highest received seq is 65 (not stored); the counter was at ${res.counterAtResponse} when it answered`);
    });

    it('a sentinel implausible seq does not move the counter', async () => {
      const res = await door.push('/batch-upsert', {
        facts: [build.fact(S, 'f-ok', 12), build.fact(S, 'f-poison', MAX_INGEST_SEQ + 1)],
      }, { spaceId: S });
      assert.equal(res.code, 200);
      assert.equal(res.body.facts.rejected, 1);
      assert.ok(await door.counter(S) < 1000, `the counter moved to ${await door.counter(S)} on a refused sentinel`);
    });
  });

  describe('POST /tombstones', () => {
    it('the counter is at least the max tombstone seq when the page is answered', async () => {
      const res = await door.push('/tombstones', { tombstones: [build.tombstone(S, 'x', 'fact', 90)] }, { spaceId: S });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.ok(res.counterAtResponse >= 90,
        `POST /tombstones answered with the counter at ${res.counterAtResponse}; the bump was not awaited`);
    });

    it('a tombstone with an implausible seq does not drag the counter to the ceiling', async () => {
      const res = await door.push('/tombstones', {
        tombstones: [build.tombstone(S, 'y', 'fact', 7), build.tombstone(S, 'z', 'fact', MAX_INGEST_SEQ + 5)],
      }, { spaceId: S });
      assert.ok([200, 400].includes(res.code), JSON.stringify(res.body));
      const after = await door.counter(S);
      assert.ok(after < 1000,
        `a tombstone at seq ${MAX_INGEST_SEQ + 5} moved the counter to ${after}: every later local write now sits `
        + 'within the ceiling reserve, and a tombstone that high refuses every later copy of its record');
    });
  });

  describe('a fork takes a seq above the max received', () => {
    async function staleFixture() {
      await door.coll(S, 'facts').insertOne(build.fact(S, 'f', 50, { fact: 'mine' }));
      await door.setCounter(S, 5);
    }
    async function assertForkAbove(label) {
      const fork = await door.coll(S, 'facts').findOne({ forkOf: 'f' });
      assert.ok(fork, `${label}: no fork was written`);
      assert.ok(fork.seq > 50,
        `${label}: the fork took seq ${fork.seq}, below the seq 50 of the arrival that caused it — a peer pulling `
        + 'from 50 never sees it');
      const page = await door.pull('/facts', { spaceId: S, sinceSeq: '50' });
      assert.ok(page.items.some(i => i._id === fork._id), `${label}: a pull from cursor 50 does not serve the fork`);
    }

    it('single /facts', async () => {
      await staleFixture();
      const res = await door.push('/facts', build.fact(S, 'f', 50, { fact: 'theirs' }), { spaceId: S });
      assert.equal(res.body?.status, 'forked', JSON.stringify(res.body));
      await assertForkAbove('single /facts');
    });

    it('batch-upsert', async () => {
      await staleFixture();
      const res = await door.push('/batch-upsert', { facts: [build.fact(S, 'f', 50, { fact: 'theirs' })] }, { spaceId: S });
      assert.equal(res.body?.facts?.forked, 1, JSON.stringify(res.body));
      await assertForkAbove('batch-upsert');
    });
  });
});
