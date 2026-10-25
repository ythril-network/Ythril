/**
 * A copy whose body a stored fork already holds IS that fork: it answers `forked` with the stored id and adds no row (Q-624,
 * design rev 4 section 3, "Fork matching by id", test 9 of section 16).
 *
 * ## The rule
 *
 * Stored forks are never hashed to be matched. A fork row's id proves its body (`forkIdFor(forkOf, seq, authoredContentHash(...).text)`),
 * so "is this the same fork" is an id lookup: the planner derives the id of the arriving copy, and when a stored fork (or one this
 * page already made) has it, the verdict is `forked` WITH THAT ID and no second row is written, whatever cap the parent has reached
 * since. Two spellings of the id exist for FACTS and both must match:
 *
 * - **the body-derived id**, for every kind that forks: a fork stored by this design, offered again (a retried push, a peer that
 *   re-offers every cycle), is found by the id the arriving body derives;
 * - **the text-derived id**, for a FACT fork a 5.6.2 or later instance stored (`forkIdFor(forkOf, seq, row.fact)`): its row is a real
 *   one on the instance that upgraded, and the same text re-delivered must be that fork and not a second one beside it
 *   ("a text-derived legacy fact fork re-delivered answers `forked` with the stored id, with no second row").
 *
 * The answer is held on the three doors that PLAN a fork: the single route (`{ status: 'forked', forkId }`), the batch (`forked` counted,
 * `forkDepthRefused` and `rejected` not), and the pull (stored state only: one fork row, the stored id).
 *
 * ## Derived, never listed
 *
 * The kinds are `FORKING_FAMILIES` (`_fork-kinds.mjs`); the legacy rows are the one family the text-derived spelling belongs to, facts,
 * which is a fact of history (`CHANGELOG`, 5.6.2) and is stated as such, not derived.
 *
 * ## Seen red
 *
 * On the base (b857da8f) `FORKING_FAMILIES` and `authoredContentHash` do not exist. With them stubbed in (scratch only): a fact fork
 * stored under its body-derived id is not found by the text-derived id the base computes, so the re-delivery makes a second fork,
 * and an equal-seq copy of an entity, a chrono entry or an edge is skipped and answers no `forked` at all.
 *
 * Run: node --test testing/standalone/a-fork-is-matched-by-its-id-db.test.js  (requires a server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { FORK_FIXTURE, forkingFamilies, forkIdOf, copyOf, arrivalDoors } from './_fork-kinds.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'q624t2matched';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
const ID = 'subject';
const SEQ = 5;
const THEIRS = 'what the peer wrote';

let door, FAMILIES, DOORS;

const subject = (family) => copyOf(family, S, ID, SEQ, 'what this instance wrote', { author: { ...PEER_AUTHOR } });
const arriving = (family) => copyOf(family, S, ID, SEQ, THEIRS, { author: { ...PEER_AUTHOR } });
const forkRows = (family) => door.coll(S, family).find({ forkOf: ID }).toArray();

/**
 * What a door answers for `family`'s copy delivered again, with a fork of it already stored under `storedId`: the rows left, and
 * the door's own sentence about the delivery where it gives one.
 */
async function deliverAgain(via, family, storedId) {
  await door.reset();
  await door.coll(S, family).insertMany([
    subject(family),
    { ...arriving(family), _id: storedId, forkOf: ID },
  ]);
  await door.raiseVersionTo(S, SEQ);
  const answers = [];
  const record = door.push;
  // The push doors answer for the delivery; the pull has no answer, only the state it leaves.
  if (via !== 'pull') {
    door.push = async (...args) => { const r = await record(...args); answers.push(r); return r; };
  }
  try { await DOORS[via](family, { [S]: [arriving(family)] }); } finally { door.push = record; }
  await door.settled();
  return { rows: await forkRows(family), answers };
}

describe('a copy whose body a stored fork holds is that fork (Q-624)', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'q624t2_matched', spaces: [S] });
    DOORS = arrivalDoors(door, TOKEN);
    FAMILIES = await forkingFamilies();
  });
  after(async () => { await door?.close(); });

  for (const via of ['single', 'batch', 'pull']) {
    it(`${via}: a fork stored under the body-derived id is found by that id, for every kind: the same row, no second one`, async () => {
      const failures = [];
      for (const family of FAMILIES) {
        const storedId = await forkIdOf(family, ID, SEQ, arriving(family));
        const { rows, answers } = await deliverAgain(via, family, storedId);
        if (rows.length !== 1 || rows[0]._id !== storedId) {
          failures.push(`${via}/${family}: fork rows after the re-delivery: ${JSON.stringify(rows.map(r => r._id))}, expected only ${storedId}`);
        }
        const r = answers[0];
        if (via === 'single' && (r?.code !== 200 || r.body?.status !== 'forked' || r.body?.forkId !== storedId)) {
          failures.push(`${via}/${family}: answered ${r?.code} ${JSON.stringify(r?.body)}, expected 200 forked with forkId ${storedId}`);
        }
        if (via === 'batch') {
          const stats = r?.body?.[family];
          if (stats?.forked !== 1 || stats?.rejected !== 0 || stats?.forkDepthRefused !== 0) {
            failures.push(`${via}/${family}: counted ${JSON.stringify(stats)}, expected forked 1 and nothing refused`);
          }
        }
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
    });

    it(`${via}: a FACT fork a 5.6.2 instance stored under the TEXT-derived id is the same fork when its text arrives again`, async () => {
      const { forkIdFor } = await import('../../server/dist/sync/upsert-plan.js');
      const legacyId = forkIdFor(ID, SEQ, THEIRS);
      const bodyId = await forkIdOf('facts', ID, SEQ, arriving('facts'));
      assert.notEqual(legacyId, bodyId, 'fixture check: the text-derived and the body-derived id are one id, so the case cannot tell them apart');
      const { rows, answers } = await deliverAgain(via, 'facts', legacyId);
      assert.deepEqual(rows.map(r => r._id), [legacyId],
        `the re-delivery was not matched to the stored fork: rows ${JSON.stringify(rows.map(r => r._id))} (a second row is the body-derived id ${bodyId})`);
      if (via === 'single') assert.deepEqual([answers[0].code, answers[0].body.status, answers[0].body.forkId], [200, 'forked', legacyId], JSON.stringify(answers[0].body));
      if (via === 'batch') assert.deepEqual([answers[0].body.facts.forked, answers[0].body.facts.rejected, answers[0].body.facts.forkDepthRefused], [1, 0, 0], JSON.stringify(answers[0].body.facts));
    });
  }

  it('a re-delivery is matched by id even when the parent has reached the fan-out cap since', async () => {
    const { MAX_FORKS_PER_RECORD: CAP } = await import('../../server/dist/sync/upsert-plan.js');
    const failures = [];
    for (const family of FAMILIES) {
      await door.reset();
      const storedId = await forkIdOf(family, ID, SEQ, arriving(family));
      const siblings = await Promise.all(Array.from({ length: CAP - 1 }, async (_, i) => {
        const doc = copyOf(family, S, ID, SEQ, `sibling ${i}`, { author: { ...PEER_AUTHOR } });
        return { ...doc, _id: await forkIdOf(family, ID, SEQ, doc), forkOf: ID };
      }));
      await door.coll(S, family).insertMany([subject(family), { ...arriving(family), _id: storedId, forkOf: ID }, ...siblings]);
      await door.raiseVersionTo(S, SEQ);
      const r = await door.push('/batch-upsert', { [family]: [arriving(family)] }, { spaceId: S, networkId: door.NET, token: TOKEN });
      const stats = r.body?.[family];
      if (r.code !== 200 || stats?.forked !== 1 || stats?.forkDepthRefused !== 0 || stats?.rejected !== 0) {
        failures.push(`${family}: a re-delivery at the cap was counted ${JSON.stringify(stats)}, expected forked 1 (the fork is stored; the cap refuses NEW forks)`);
      }
      if ((await forkRows(family)).length !== CAP) failures.push(`${family}: the fork count moved from ${CAP}`);
    }
    assert.deepEqual(failures, [], `${failures.length} divergence(s):\n  ${failures.join('\n  ')}`);
  });
});
