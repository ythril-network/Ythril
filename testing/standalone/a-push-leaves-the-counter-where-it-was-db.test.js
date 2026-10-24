/**
 * A push moves NO counter: whatever it carried, this instance's seq counter is where it was when the push is answered — on every push door, for
 * every family, whatever was done with the document (bundle-81, design rev 8 §1a, D-19 B). The inverse of what this file held until then
 * (`a-push-moves-the-counter-past-what-it-received-db`, `Q-198`, `Q-107` part 1 §3: "before a push is answered the counter is past every plausible
 * seq it carried"); the reason is stated here so the inversion is not read as a weakened gate.
 *
 * ## Why the rule turned over
 *
 * The counter used to be the one clock a peer's sync cursor and this instance's writes shared: a record that arrived at seq 40 while the counter stayed
 * at 5 let the next local write take 6, below the arrival, and every peer that held the arrival at 40 had a cursor past 6 and never pulled it. So every
 * push door raised the counter over what it RECEIVED, awaited, before it answered. A seq is a VERSION now and is no longer what anything pages by (a
 * record's landing POSITION is, \`util/position-clock.ts\`): a local write stamps its record above the version THAT record holds, and above any deletion held
 * for its id (\`util/version-stamp.ts\`), so it is always above the version it replaces, whatever the counter stands at. An arrival that raised the counter
 * would lift every later stamp of the space to a peer's clock — and a peer that sent a seq near the ceiling would lift them all there, which is what the
 * ceiling reserve was built to refuse. So an arrival leaves the counter alone: what it received, it stores, and that is all.
 *
 * ## What is asserted, on every door, with the counter read AT THE MOMENT the handler answers (\`_push-door.mjs\`, \`counterAtResponse\`)
 *
 *  - the four single routes, every batch family, \`POST /tombstones\`: the server wrote no counter before it answered, and the stored counter is where it stood after it;
 *  - a page whose highest seq is on a document that is NOT stored (tombstoned, skipped against a newer local copy, an unknown chrono type): the same;
 *  - a seq the door refuses as implausible, and a tombstone above the ceiling: the same (they never could move it);
 *  - **a fork is still a local write and takes a version above the version it forks from** — and a pull serves it, by position and by seq — because
 *    the stamp reads the PARENT's version, not the counter (the fixture leaves the counter far below it).
 *
 * Run: a Mongo the harness accepts (see \`_mongo-harness.mjs\`), then
 *      node --test testing/standalone/a-push-leaves-the-counter-where-it-was-db.test.js
 * (requires a prior \`npm run build\` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES, familiesCarriedByBatch } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'pushclock';
/** Where the counter stands before every case: a number no fixture seq below it can be mistaken for. */
const STANDING = 5;
let door, MAX_INGEST_SEQ;

/** Every batch family, derived from the route's own body keys and checked against the fixture table. */
const BATCH_FAMILIES = skip ? [] : familiesCarriedByBatch();
const SINGLE_ROUTES = Object.entries(FAMILIES).filter(([, f]) => f.single).map(([k, f]) => ({ key: k, ...f }));

function oneDoc(key, _id, seq, extra) {
  const kind = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link', filemeta: 'filemeta' }[key];
  return build[kind](S, _id, seq, extra);
}

describe('a push leaves the counter where it was, whatever it carried', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushclock', spaces: [{ id: S, label: 'Clock', folders: [], meta: {} }] });
    ({ MAX_INGEST_SEQ } = await import('../../server/dist/util/seq.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.wipe(S); await door.setCounter(S, STANDING); });

  /**
   * The server wrote no counter while it answered (`counterAtResponse` is the highest value the harness saw one of the server's own counter writes land,
   * `0` when it saw none) and the stored counter is still `STANDING`.
   */
  async function assertUnmoved(res, what) {
    assert.equal(res.counterAtResponse, 0, `${what}: the server wrote the counter (to ${res.counterAtResponse}) before it answered — an arrival moved it`);
    assert.equal(await door.counter(S), STANDING, `${what}: the counter is ${await door.counter(S)} afterwards, not the ${STANDING} it stood at — an arrival moved it`);
  }

  it('the derivations found the families, so an empty set cannot pass', () => {
    assert.ok(BATCH_FAMILIES.length >= 6, `batch families: ${BATCH_FAMILIES}`);
    assert.deepEqual(BATCH_FAMILIES.filter(k => !FAMILIES[k]), [], 'a batch family with no fixture goes unchecked');
    assert.ok(SINGLE_ROUTES.length >= 4, `single routes: ${SINGLE_ROUTES.map(r => r.single)}`);
  });

  describe('single routes', () => {
    for (const r of SINGLE_ROUTES) {
      it(`POST ${r.single}: a record at seq 40 is stored and the counter does not move`, async () => {
        const res = await door.push(r.single, oneDoc(r.key, `${r.key}-1`, 40), { spaceId: S });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        await assertUnmoved(res, `POST ${r.single}`);
      });
    }

    it('POST /chrono refusing an unknown type moves nothing either (the 400s are received too)', async () => {
      const res = await door.push('/chrono', oneDoc('chrono', 'c-odd', 45, { type: 'not-a-chrono-type' }), { spaceId: S });
      assert.equal(res.code, 400);
      await assertUnmoved(res, 'POST /chrono (unknown type)');
    });
  });

  describe('batch-upsert', () => {
    for (const key of BATCH_FAMILIES) {
      it(`a ${key}-only page: both documents are stored and the counter does not move`, async () => {
        const res = await door.push('/batch-upsert', { [key]: [oneDoc(key, `${key}-a`, 30), oneDoc(key, `${key}-b`, 40)] }, { spaceId: S });
        assert.equal(res.code, 200, JSON.stringify(res.body));
        await assertUnmoved(res, `a ${key}-only page`);
      });
    }

    it('a tombstoned, a skipped and an unknown-type document received at higher seqs move nothing', async () => {
      await door.coll(S, 'tombstones').insertOne(build.tombstone(S, 'f-dead', 'fact', 70));
      await door.coll(S, 'facts').insertOne(build.fact(S, 'f-newer', 80));
      const res = await door.push('/batch-upsert', {
        facts: [build.fact(S, 'f-live', 10), build.fact(S, 'f-dead', 60), build.fact(S, 'f-newer', 50)],
        chrono: [build.chrono(S, 'c-odd', 65, { type: 'not-a-chrono-type' })],
      }, { spaceId: S });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      assert.deepEqual([res.body.facts.inserted, res.body.facts.tombstoned, res.body.facts.skipped, res.body.chrono.unknownType],
        [1, 1, 1, 1], JSON.stringify(res.body));
      await assertUnmoved(res, 'a page whose highest seq is on a document that is not stored');
    });

    it('a sentinel implausible seq is refused and does not move the counter', async () => {
      const res = await door.push('/batch-upsert', {
        facts: [build.fact(S, 'f-ok', 12), build.fact(S, 'f-poison', MAX_INGEST_SEQ + 1)],
      }, { spaceId: S });
      assert.equal(res.code, 200);
      assert.equal(res.body.facts.rejected, 1);
      await assertUnmoved(res, 'a refused sentinel');
    });
  });

  describe('POST /tombstones', () => {
    it('a tombstone at seq 90 is stored and the counter does not move', async () => {
      const res = await door.push('/tombstones', { tombstones: [build.tombstone(S, 'x', 'fact', 90)] }, { spaceId: S });
      assert.equal(res.code, 200, JSON.stringify(res.body));
      await assertUnmoved(res, 'POST /tombstones');
      assert.ok(await door.coll(S, 'tombstones').findOne({ _id: 'x' }), 'the tombstone was not stored');
    });

    it('a tombstone with an implausible seq does not drag the counter anywhere', async () => {
      const res = await door.push('/tombstones', {
        tombstones: [build.tombstone(S, 'y', 'fact', 7), build.tombstone(S, 'z', 'fact', MAX_INGEST_SEQ + 5)],
      }, { spaceId: S });
      assert.ok([200, 400].includes(res.code), JSON.stringify(res.body));
      await assertUnmoved(res, 'a tombstone above the ceiling');
    });
  });

  describe('a fork takes a version above the version it forks from, and is served', () => {
    async function staleFixture() {
      await door.coll(S, 'facts').insertOne(build.fact(S, 'f', 50, { fact: 'mine' }));
      await door.setCounter(S, 5);
    }
    async function assertForkAbove(label) {
      const fork = await door.coll(S, 'facts').findOne({ forkOf: 'f' });
      assert.ok(fork, `${label}: no fork was written`);
      assert.ok(fork.seq > 50,
        `${label}: the fork took seq ${fork.seq}, below the seq 50 of the record it forks from — the stamp read the counter, not the parent's version`);
      assert.ok(typeof fork.pos === 'number' && fork.pos > 2 ** 50 && fork.posAtSeq === fork.seq, `${label}: the fork did not land at a position of its own: ${JSON.stringify([fork.pos, fork.posAtSeq])}`);
      const bySeq = await door.pull('/facts', { spaceId: S, sinceSeq: '50' });
      assert.ok(bySeq.items.some(i => i._id === fork._id), `${label}: a pull from seq cursor 50 does not serve the fork`);
      const byPosition = await door.pull('/facts', { spaceId: S, afterPos: '0' });
      assert.ok(byPosition.items.some(i => i._id === fork._id), `${label}: a pull by position does not serve the fork`);
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
