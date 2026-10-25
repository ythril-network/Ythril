/**
 * A push forks a divergent fact at most ten times per parent — on BOTH doors, counting the forks the same page
 * is creating — and the same push retried forks to the same id rather than forking again (`Q-107` part 1 §2).
 *
 * ## The fan-out cap, and the door that did not have it
 *
 * `MAX_FORK_DEPTH` (10) caps a fork chain twice: its depth, and its FAN-OUT — the number of forks one parent
 * may have. The single `POST /api/sync/facts` route enforced both. `batch-upsert`, which is what a real peer
 * uses, checked only depth: a page carrying eleven divergent copies of one fact at one seq forks eleven times,
 * and the next page eleven more. The cap a red-team test proved on the single route did not exist where the
 * traffic is. Siblings already stored and siblings created earlier IN THE SAME PAGE both count — a planner that
 * counts only stored ones lets a single page past the cap by any amount.
 *
 * On the batch door a refused fork is counted `forkDepthRefused` and in `rejected`, as a depth refusal is; on
 * the single door it stays the 400 it was.
 *
 * ## The retry
 *
 * A fork id was `uuidv4()`, so a push whose 200 was lost and is re-sent forks the record a second time — the
 * stored parent is unchanged, so the retry is divergent all over again. The fork id is now derived from (parent
 * id, incoming seq, the incoming text), so a retry upserts the fork it already made.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-push-forks-once-within-the-cap-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { forkIdOf } from './_fork-kinds.mjs';

const skip = await mongoSkipReason();

const S = 'pushfork';
let door, CAP;
const forks = () => door.coll(S, 'facts').countDocuments({ forkOf: 'f' });
const variant = (i) => build.fact(S, 'f', 5, { fact: `variant ${i}` });

describe('a push forks once, within the fan-out cap, on both doors', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushfork', spaces: [{ id: S, label: 'Forks', folders: [], meta: {} }] });
    ({ MAX_FORK_DEPTH: CAP } = await import('../../server/dist/api/sync/_shared.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => {
    await door.wipe(S);
    await door.coll(S, 'facts').insertOne(build.fact(S, 'f', 5, { fact: 'root' }));
  });

  it('the cap is ten, as the red-team test and the docs state', () => { assert.equal(CAP, 10); });

  describe('the fan-out cap', () => {
    it('single /facts: forks 1..10 are forked, the 11th is a 400', async () => {
      for (let i = 1; i <= CAP; i++) {
        const r = await door.push('/facts', variant(i), { spaceId: S });
        assert.deepEqual([r.code, r.body.status], [200, 'forked'], `fork ${i}: ${JSON.stringify(r.body)}`);
      }
      const over = await door.push('/facts', variant(CAP + 1), { spaceId: S });
      assert.equal(over.code, 400, `fork ${CAP + 1}: ${JSON.stringify(over.body)}`);
      assert.equal(await forks(), CAP);
    });

    it('batch-upsert: eleven divergent copies in ONE page fork ten times and refuse the eleventh', async () => {
      const r = await door.push('/batch-upsert', { facts: Array.from({ length: CAP + 1 }, (_, i) => variant(i + 1)) }, { spaceId: S });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(await forks(), CAP,
        `one page forked one parent ${await forks()} times; the fan-out cap is ${CAP} and the single route enforces it`);
      assert.deepEqual([r.body.facts.forked, r.body.facts.forkDepthRefused, r.body.facts.rejected], [CAP, 1, 1],
        JSON.stringify(r.body.facts));
    });

    it('batch-upsert: stored siblings and in-page siblings are counted together', async () => {
      await door.coll(S, 'facts').insertMany(Array.from({ length: 8 }, (_, i) =>
        build.fact(S, `old-fork-${i}`, 100 + i, { fact: `old ${i}`, forkOf: 'f' })));
      const r = await door.push('/batch-upsert', { facts: [variant(1), variant(2), variant(3), variant(4)] }, { spaceId: S });
      assert.equal(r.code, 200, JSON.stringify(r.body));
      assert.equal(await forks(), CAP, `8 stored forks + a page of 4 left ${await forks()} forks of one parent`);
      assert.deepEqual([r.body.facts.forked, r.body.facts.forkDepthRefused], [2, 2], JSON.stringify(r.body.facts));
    });
  });

  describe('a retried push forks to the same id', () => {
    it('single /facts: the same divergent push twice leaves one fork', async () => {
      const first = await door.push('/facts', variant(1), { spaceId: S });
      assert.equal(first.body.status, 'forked', JSON.stringify(first.body));
      const retry = await door.push('/facts', variant(1), { spaceId: S });
      assert.equal(retry.code, 200, JSON.stringify(retry.body));
      assert.equal(await forks(), 1,
        'a push re-sent after its 200 was lost forked the record a second time: the stored parent is unchanged, so '
        + 'every retry is divergent again and every lost response is a duplicate fork on this instance');
      if (retry.body.status === 'forked') assert.equal(retry.body.forkId, first.body.forkId);
    });

    // Q-624 re-anchor: the id the push makes IS the body-derived one (section 3). A re-send is found by that equation, so it is the
    // equation this file holds; the old one (`forkIdFor(parent, seq, text)`) names a different row.
    it('the fork a push makes is stored under the id its body derives, on both doors', async () => {
      const expected = await forkIdOf('facts', 'f', 5, variant(1));
      const one = await door.push('/facts', variant(1), { spaceId: S });
      assert.equal(one.body.forkId, expected, `single: the fork was stored under ${one.body.forkId}, its body derives ${expected}`);
      await door.wipe(S);
      await door.coll(S, 'facts').insertOne(build.fact(S, 'f', 5, { fact: 'root' }));
      await door.push('/batch-upsert', { facts: [variant(1)] }, { spaceId: S });
      assert.deepEqual((await door.coll(S, 'facts').find({ forkOf: 'f' }).toArray()).map(d => d._id), [expected], 'batch: the fork id is not the one its body derives');
    });

    it('batch-upsert: the same page twice leaves one fork', async () => {
      await door.push('/batch-upsert', { facts: [variant(1)] }, { spaceId: S });
      const retry = await door.push('/batch-upsert', { facts: [variant(1)] }, { spaceId: S });
      assert.equal(retry.code, 200, JSON.stringify(retry.body));
      assert.equal(await forks(), 1, 'a re-sent page forked the same divergent copy twice');
    });

    /*
     * `Q-218` round R, item R9: a RE-SENT push at a cap. The fork the first send made is found by its derived id, so
     * the re-send is the same delivery again, not a new fork — it answers `forked` with that id whichever cap the
     * parent has reached since (fan-out: the fork itself is one of the ten; depth: the chain above the parent). The
     * cap refuses NEW forks; refusing the re-send tells the sender a record it already delivered was dropped
     * (`rejected` on batch, a 400 on the single route) although the fork is stored. Truth table: both doors x both caps.
     */
    for (const cap of ['fan-out', 'depth']) {
      for (const via of ['single', 'batch']) {
        it(`R9 ${via}, at the ${cap} cap: a re-sent push whose derived fork exists answers forked with that id`, async () => {
          // Q-624 re-anchor: a fork's id derives from its BODY (`forkIdFor(forkOf, forkAt, authoredContentHash(family, body).text)`, design
          // section 3), no longer from the text alone; and the stored fork keeps the seq its id was derived from, so its row verifies.
          const forkId = await forkIdOf('facts', 'f', 5, variant(1));
          const theFork = build.fact(S, forkId, 5, { fact: 'variant 1', forkOf: 'f', forkAt: 5 });
          if (cap === 'fan-out') {
            await door.coll(S, 'facts').insertMany([theFork,
              ...Array.from({ length: CAP - 1 }, (_, i) => build.fact(S, `sib-${i}`, 20 + i, { fact: `sib ${i}`, forkOf: 'f' }))]);
          } else {
            // f -> a1 -> ... -> a10: f is CAP forks below its root, and its fork was made before the chain grew.
            const chain = Array.from({ length: CAP }, (_, i) => `a${i + 1}`);
            await door.coll(S, 'facts').updateOne({ _id: 'f' }, { $set: { forkOf: chain[0] } });
            await door.coll(S, 'facts').insertMany([theFork,
              ...chain.map((id, i) => build.fact(S, id, 1, chain[i + 1] ? { forkOf: chain[i + 1] } : {}))]);
          }
          const before = await forks();
          const r = via === 'single'
            ? await door.push('/facts', variant(1), { spaceId: S })
            : await door.push('/batch-upsert', { facts: [variant(1)] }, { spaceId: S });
          assert.equal(await forks(), before, 'fixture check: the re-send made a second fork');
          if (via === 'single') {
            assert.deepEqual([r.code, r.body], [200, { status: 'forked', forkId, positions: 1 }],
              `a re-sent push at the ${cap} cap was answered ${r.code} ${JSON.stringify(r.body)} although its fork ${forkId} `
              + 'is stored: the sender is told a record it delivered was refused');
          } else {
            assert.equal(r.code, 200, JSON.stringify(r.body));
            assert.deepEqual([r.body.facts.forked, r.body.facts.forkDepthRefused, r.body.facts.rejected], [1, 0, 0],
              `a re-sent page at the ${cap} cap counted ${JSON.stringify(r.body.facts)} although the fork ${forkId} is `
              + 'stored: the sender subtracts a delivered record as rejected');
          }
        });
      }
    }

    it('two DIFFERENT divergent texts still fork apart (the id is not the parent alone)', async () => {
      const a = await door.push('/facts', variant(1), { spaceId: S });
      const b = await door.push('/facts', variant(2), { spaceId: S });
      assert.notEqual(a.body.forkId, b.body.forkId);
      assert.equal(await forks(), 2);
    });
  });
});
