/**
 * Two instances that each hold ONE of two divergent copies of a FILE's metadata at one version end holding the SAME row, and the instance whose
 * copy lost keeps it as a metadata conflict of its own (Q-426).
 *
 * ## The defect
 *
 * A file row arriving at the seq this instance already holds, with other authored content (a different description, other tags), fell through the
 * planner to `skipped`: no log line, no counter beyond "skipped", no record. A holds X and B holds Y, each skips the other's, and the space hash
 * differs for ever. (A file does not fork: it has no body schema and its `_id` is its path, so a copy has nowhere to be kept as a row.)
 *
 * ## The rule
 *
 * The same tie as every forking family (`arrivingWinsTie`) over the file's own hash (`fileContentHash`): the lower hash is the row on every
 * instance. When the arriving copy wins, the receiver replaces its stored row at the SAME seq (under a guard that names the stored row it
 * read) and keeps the metadata it displaced as a `kind: 'metadata'` conflict in Conflicts, which its user resolves: `keep-local` re-applies the
 * displaced fields as an ordinary local edit (a new seq, so it wins everywhere), `keep-incoming` closes it. When the arriving copy loses, the
 * stored row stands, nothing is written, and the page says so (`divergenceKept`, counted `skipped`): the peer converges on this copy by the same
 * rule. Nothing on the peer is touched, and nothing is dropped.
 *
 * ## What is asserted, on every door that takes an arrival (batch, pull)
 *
 *  - both instances hold the same authored content, and it is the copy the server's own tie rule names (read from the server: the fixtures'
 *    texts are literal, so one of the two instances swaps and the other keeps, which is both orders of the rule in one run);
 *  - the conflict is on the instance whose copy lost, one of it, naming the displaced fields, and on no other;
 *  - the space hash agrees;
 *  - a re-delivery writes no second conflict and changes nothing else;
 *  - `keep-local` lands the displaced fields at a higher seq and closes the conflict; `keep-incoming` closes it and touches no row; `keep-both`
 *    and `save-to-space` are refused `not_a_file_copy`;
 *  - a swap whose guard misses (the stored row changed between the read and the write) writes no conflict and leaves the stored row.
 *
 * Seen red on the base (993447fb6): the rows differ, no conflict exists.
 *
 * Run: node --test testing/standalone/an-equal-seq-file-divergence-keeps-the-loser-as-a-conflict-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { build, ADMIN_TOKEN } from './_push-door.mjs';
import { callRoute } from './_vote-round-instance.mjs';
import { parkWrites } from './_write-faults.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const SPACES = ['q426-a', 'q426-b'];
const [A, B] = SPACES;
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const ID = 'notes/shared.md';
const SEQ = 5;
const THIRD = 'a-third-peer';

let door, DELIVER, merkle, upsertPlan, conflictsRouter;

/** The metadata a copy carries: its description and a tag, authored by the peer at fixed stamps, so only the text decides the hash. */
const meta = (space, text, extra = {}) => build.filemeta(space, ID, SEQ, {
  description: text, tags: ['t'], author: { ...PEER_AUTHOR }, createdAt: '2026-08-01T00:00:00.000Z', updatedAt: '2026-10-01T00:00:00.000Z', ...extra,
});
/** What an instance stores of its own copy: the wire shape and its own machinery. */
const stored = (space, text) => ({ ...meta(space, text), path: ID, deliveredBy: THIRD, sizeBytes: 4, sha256: 'b'.repeat(64), pos: SEQ, posAtSeq: SEQ });

const deliver = {
  batch: async (docsBySpace) => {
    for (const [space, docs] of Object.entries(docsBySpace)) await door.push('/batch-upsert', { filemeta: docs }, { spaceId: space, networkId: door.NET, token: TOKEN });
  },
  pull: async (docsBySpace) => {
    for (const [space, docs] of Object.entries(docsBySpace)) door.state.records[space] = { filemeta: docs };
    await door.sync();
  },
};

/** A clean slate: the door's reset, and the files and conflicts of both spaces (the reset clears them only for a door that opened with file support). */
async function fresh() {
  await door.reset();
  for (const space of SPACES) for (const part of ['files', 'conflicts']) await door.coll(space, part).deleteMany({});
}
const row = (space) => door.coll(space, 'files').findOne({ _id: ID });
const conflicts = (space) => door.coll(space, 'conflicts').find({}).toArray();
/** Which of the two texts is the row, by the server's own rule: asked of the server, never re-derived. */
function winnerOf(x, y) {
  const wins = upsertPlan.arrivingWinsTie(merkle.fileContentHash(y), merkle.fileContentHash(x));
  return wins ? { winner: y, loser: x } : { winner: x, loser: y };
}

/** Both instances hold their own copy; each is then handed the other's. Returns what each copy said. */
async function exchange(via) {
  await fresh();
  const x = meta(A, 'what instance A wrote');
  const y = meta(B, 'what instance B wrote');
  await door.coll(A, 'files').insertOne(stored(A, x.description));
  await door.coll(B, 'files').insertOne(stored(B, y.description));
  for (const space of SPACES) await door.raiseVersionTo(space, SEQ);
  await deliver[via]({ [A]: [meta(A, y.description)], [B]: [meta(B, x.description)] });
  await door.settled();
  return { x, y };
}

describe('an equal-seq file divergence keeps the lower hash as the row and the other as a conflict (Q-426)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q426_file_tie', spaces: SPACES });
    merkle = await import('../../server/dist/brain/merkle.js');
    upsertPlan = await import('../../server/dist/sync/upsert-plan.js');
    ({ conflictsRouter } = await import('../../server/dist/api/conflicts.js'));
  });
  after(async () => { await door?.close(); });

  for (const via of ['batch', 'pull']) {
    it(`${via}: after the exchange both hold the lower-hash copy, the instance whose copy lost holds it as one metadata conflict, and the roots agree`, async () => {
      const { x, y } = await exchange(via);
      const { winner, loser } = winnerOf(x, y);
      const [ra, rb] = [await row(A), await row(B)];
      assert.equal(ra.description, winner.description, `A holds ${JSON.stringify(ra.description)}, the tie rule names ${JSON.stringify(winner.description)}`);
      assert.equal(rb.description, winner.description, `B holds ${JSON.stringify(rb.description)}, the tie rule names ${JSON.stringify(winner.description)}`);
      assert.equal(ra.seq, SEQ); assert.equal(rb.seq, SEQ);
      assert.equal((await merkle.computeMerkleRoot(A)).root, (await merkle.computeMerkleRoot(B)).root, 'the space hashes differ after the exchange');

      const loserSpace = loser === x ? A : B;
      const winnerSpace = loserSpace === A ? B : A;
      assert.deepEqual(await conflicts(winnerSpace), [], 'the instance whose copy won holds a conflict it has no use for');
      const mine = await conflicts(loserSpace);
      assert.equal(mine.length, 1, `the instance whose copy lost holds ${mine.length} conflicts, expected 1`);
      const [c] = mine;
      assert.equal(c.kind, 'metadata');
      assert.equal(c.spaceId, loserSpace);
      assert.equal(c.originalPath, ID);
      assert.equal(c.losing.description, loser.description, 'the conflict does not hold the displaced description');
      assert.deepEqual(c.losing.tags, ['t']);
      assert.equal(c.seq, SEQ);
      assert.equal(c.peerInstanceId, PEER);
      assert.equal(typeof c.detectedAt, 'string');
      assert.equal(c.conflictPath, undefined, 'a metadata conflict names no copy of the file');

      // A re-delivery of both copies adds no conflict and changes no row.
      const before = JSON.stringify([await row(A), await row(B), await conflicts(A), await conflicts(B)]);
      await deliver[via]({ [A]: [meta(A, y.description)], [B]: [meta(B, x.description)] });
      await door.settled();
      assert.equal(JSON.stringify([await row(A), await row(B), await conflicts(A), await conflicts(B)]), before, 'a re-delivery changed what is held');
    });
  }

  describe('the conflict is resolved by its instance\'s user', () => {
    const resolve = (space, id, action, extra = {}) => callRoute(conflictsRouter, 'post', '/:id/resolve', { params: { id }, body: { action, ...extra }, authToken: ADMIN_TOKEN });

    async function lost() {
      const { x, y } = await exchange('batch');
      const { loser } = winnerOf(x, y);
      const space = loser === x ? A : B;
      const [c] = await conflicts(space);
      return { space, c, loser };
    }

    it('keep-local re-applies the displaced fields as a local edit at a higher seq, and closes the conflict', async () => {
      const { space, c, loser } = await lost();
      const answer = await resolve(space, c._id, 'keep-local');
      assert.equal(answer.code, 200, JSON.stringify(answer.body));
      const after = await row(space);
      assert.equal(after.description, loser.description, 'the displaced description was not re-applied');
      assert.ok(after.seq > SEQ, `the re-applied row is at ${after.seq}: a local edit takes a new seq so it wins everywhere`);
      assert.deepEqual(await conflicts(space), []);
    });

    it('keep-incoming closes the conflict and touches no row', async () => {
      const { space, c } = await lost();
      const before = JSON.stringify(await row(space));
      const answer = await resolve(space, c._id, 'keep-incoming');
      assert.equal(answer.code, 200, JSON.stringify(answer.body));
      assert.equal(JSON.stringify(await row(space)), before);
      assert.deepEqual(await conflicts(space), []);
    });

    it('keep-both and save-to-space are refused: there is no copy of the file to place', async () => {
      const { space, c } = await lost();
      for (const [action, extra] of [['keep-both', {}], ['save-to-space', { targetSpaceId: space === A ? B : A }]]) {
        const answer = await resolve(space, c._id, action, extra);
        assert.equal(answer.code, 400, `${action}: ${JSON.stringify(answer.body)}`);
        assert.equal(answer.body.code, 'not_a_file_copy', `${action}: ${JSON.stringify(answer.body)}`);
      }
      assert.equal((await conflicts(space)).length, 1, 'a refused resolution closed the conflict');
    });
  });

  for (const [interference, edit, outcomeOf] of [
    // A local edit stamps a higher seq: the swap's guard names a row that is gone, and the arriving copy is older than what stands.
    ['a local edit (a higher seq)', { description: 'edited here meanwhile', seq: SEQ + 1 },
      () => ({ description: 'edited here meanwhile', displaced: undefined })],
    // Another body at the SAME seq (a racing push of a third copy): `seq` alone would be satisfied, so the guard has to name the content. The swap is not
    // made on what it read; the divergence is planned again against the third body, by the same tie, and whatever that displaces is that body and no other.
    ['a third body at the same seq', { description: 'a third body' }, (arriving) => {
      const { winner, loser } = winnerOf(meta(A, 'a third body'), meta(A, arriving));
      return { description: winner.description, displaced: loser.description === 'a third body' ? 'a third body' : undefined };
    }],
  ]) it(`a swap that loses the race to ${interference} never displaces the row it read, and every conflict names what was displaced`, async () => {
    await fresh();
    const x = meta(A, 'what instance A wrote');
    const y = meta(A, 'what instance B wrote');
    // Whichever of the two the tie names as the winner is the arriving copy, so the stored one is the loser and a swap is planned.
    const { winner, loser } = winnerOf(x, y);
    await door.coll(A, 'files').insertOne(stored(A, loser.description));
    await door.raiseVersionTo(A, SEQ);
    // Parked as the first bulkWrite whose filter names a `seq`: the swap's guard, and no ordinary arrival's.
    const park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
    try {
      const { reached, release } = park.arm(`${A}_files`, { when: (method, args) => method === 'bulkWrite' && args[0]?.[0]?.updateOne?.filter?.seq === SEQ });
      const pushing = deliver.batch({ [A]: [meta(A, winner.description)] });
      await Promise.race([reached, new Promise((_, reject) => setTimeout(() => reject(new Error('no swap write was made for a copy that wins the tie')), 15_000).unref())]);
      // The stored row moves while the swap is parked.
      await door.coll(A, 'files').updateOne({ _id: ID }, { $set: edit });
      release();
      await pushing;
    } finally { park.restore(); }
    await door.settled();
    const { description, displaced } = outcomeOf(winner.description);
    assert.equal((await row(A)).description, description, 'the swap overwrote a row it never saw');
    const held = (await conflicts(A)).map(c => c.losing.description);
    assert.deepEqual(held, displaced === undefined ? [] : [displaced],
      `a swap that did not happen left a conflict for metadata that was never displaced (or one that was is missing): ${JSON.stringify(held)}`);
  });
});
