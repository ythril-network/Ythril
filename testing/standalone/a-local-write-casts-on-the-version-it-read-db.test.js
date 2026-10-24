/**
 * A local write is stamped against the version it READ, and a record that moved since is never overwritten by a lower stamp
 * (bundle-81, plan rev 8 §1a, decision 14, §9 test 16).
 *
 * ## The defect
 *
 * A local edit reads the record's `seq`, allocates its own (`V + 1`), and writes. Without an `If-Match` its filter is a plain
 * `{ _id }` (`writeFilterFor`, `brain/write-precondition.ts`), so an arrival that lands BETWEEN the read and the write is overwritten
 * by a stamp BELOW it. Arrivals do not raise V any more (D-19 B), so nothing corrects it afterwards: the stored copy now carries a
 * lower version than the one a peer holds, and the peer's next pull is skipped as "not newer".
 *
 * ## The rules this file holds
 *
 *  1. No If-Match: an arrival parked between an edit's allocation and its write does not lose to a lower stamp. The edit retries and
 *     lands ABOVE the arrival (a stamp above the version it read), on REST and on MCP.
 *  2. With If-Match: the same arrival ends the edit in the precondition refusal (412), and the arrival's copy stands untouched.
 *     (True today: the control that keeps rule 1 from being satisfied by refusing everything.)
 *
 * ## How the arrival is placed exactly there
 *
 * The REAL edit runs through the whole app (REST) or `callTool` (MCP). Its write is parked behind a gate (`_write-faults.mjs parkWrites`):
 * the first update-shaped write to the facts collection after arming, which is the edit's, carries the seq it allocated (`reached.seq`,
 * proving the hold sits after the allocation). While it is parked the REAL push route stores a peer's newer copy; then the gate opens.
 * No sleeps. Whatever the fix does about it (a CAS, a retry), the edit's write has been decided against a version that is no longer true.
 *
 * Database `b81tC_cas`, dropped on entry and exit.
 *
 * Run: node --test testing/standalone/a-local-write-casts-on-the-version-it-read-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openB81cDoor } from './_b81c-door.mjs';
import { parkWrites } from './_write-faults.mjs';
import { build, peerToken } from './_push-door.mjs';

const skip = await mongoSkipReason();
const SPACE = 'cas';
const FACT = 'bbbbbbbb-0000-4000-8000-0000000000c1';
const READ_SEQ = 3;
const ARRIVAL_SEQ = 5000;
const PEER = 'b81c-cas-peer';
const AUTHOR = { instanceId: PEER, instanceLabel: 'Peer' };
const HOLD_TIMEOUT = 30_000;
/** The writes that put a record's new version in place: the edit's, whichever driver call it spells it with. */
const UPDATE_SHAPED = (m) => /^(findOneAndUpdate|updateOne|findOneAndReplace|replaceOne)$/.test(m);

describe('a local write casts on the version it read', { skip }, () => {
  let door, park;

  before(async () => { door = await openB81cDoor({ name: 'cas', spaces: [SPACE], app: true }); });
  after(async () => { park?.restore(); await door?.close(); });

  beforeEach(async () => {
    park?.restore();
    park = parkWrites(Object.getPrototypeOf(door.mongo.col('probe')));
    await door.wipe(SPACE);
    await door.coll(SPACE, 'facts').insertOne(build.fact(SPACE, FACT, READ_SEQ, { author: AUTHOR, fact: 'the fact as first stored' }));
    await door.setCounter(SPACE, READ_SEQ);
  });

  /**
   * Start `edit`, park its write, land the peer's newer copy through the real push route, open the gate, and settle the edit.
   * Returns what the edit answered, the seq its write carried when parked, and what is stored.
   */
  async function editRacingAnArrival(edit) {
    const hold = park.arm(`${SPACE}_facts`, { when: UPDATE_SHAPED });
    const call = edit();
    const parked = await Promise.race([
      hold.reached,
      call.then(() => { throw new Error('the edit finished without parking a write to the facts collection'); }),
    ]);
    assert.equal(typeof parked.seq, 'number', 'the parked write carries no seq: the hold is not between the stamp and the write');
    let landed;
    try {
      landed = await door.push('/facts',
        build.fact(SPACE, FACT, ARRIVAL_SEQ, { author: AUTHOR, fact: 'the peer\'s newer copy' }), { spaceId: SPACE, token: peerToken(PEER) });
      assert.equal(landed.code, 200, `the arrival was not stored: ${JSON.stringify(landed.body)}`);
      assert.equal((await door.coll(SPACE, 'facts').findOne({ _id: FACT }))?.seq, ARRIVAL_SEQ, 'the arrival did not land while the edit was parked');
    } finally { hold.release(); }
    const answer = await call;
    return { answer, parkedSeq: parked.seq, stored: await door.coll(SPACE, 'facts').findOne({ _id: FACT }) };
  }

  it('the edit parks a write carrying a seq at or below the arrival that then lands (the race is real)', { timeout: HOLD_TIMEOUT }, async () => {
    const r = await editRacingAnArrival(() => door.rest('PATCH', `/api/brain/spaces/${SPACE}/facts/${FACT}`, { fact: 'a local edit' }));
    assert.ok(r.parkedSeq < ARRIVAL_SEQ, `the edit allocated ${r.parkedSeq}, not below the arrival (${ARRIVAL_SEQ}): the fixture does not race`);
  });

  for (const via of ['REST', 'MCP']) {
    it(`${via}, no If-Match: the edit lands ABOVE the arrival that moved the record after it read it`, { timeout: HOLD_TIMEOUT }, async () => {
      const text = `a local edit over ${via}`;
      const r = await editRacingAnArrival(via === 'REST'
        ? () => door.rest('PATCH', `/api/brain/spaces/${SPACE}/facts/${FACT}`, { fact: text })
        : () => door.mcp('update_fact', { space: SPACE, id: FACT, fact: text }));
      assert.ok(r.stored.seq > ARRIVAL_SEQ,
        `the edit overwrote the arrival (seq ${ARRIVAL_SEQ}) with a LOWER stamp, ${r.stored.seq}: with no counter lift from arrivals nothing `
        + 'corrects it, and a peer holding the arrival never takes this copy as newer');
      assert.equal(r.stored.fact, text, 'the retried edit is not what is stored');
      assert.equal(r.answer.status, 200, r.answer.text);
    });
  }

  it('REST, with If-Match of the version it read: the same arrival ends the edit in the precondition refusal, and the arrival stands', { timeout: HOLD_TIMEOUT }, async () => {
    const hold = park.arm(`${SPACE}_facts`, { when: UPDATE_SHAPED });
    const call = (async () => {
      // `door.rest` sends no If-Match, so this call spells it out against the same app.
      const base = door.baseUrl;
      const r = await fetch(`${base}/api/brain/spaces/${SPACE}/facts/${FACT}`, {
        method: 'PATCH', headers: { Authorization: `Bearer ${door.adminKey}`, 'Content-Type': 'application/json', 'If-Match': String(READ_SEQ) },
        body: JSON.stringify({ fact: 'an edit with If-Match' }),
      });
      return { status: r.status, text: await r.text() };
    })();
    await Promise.race([hold.reached, call.then(() => { throw new Error('the edit finished without parking a write'); })]);
    try {
      const landed = await door.push('/facts', build.fact(SPACE, FACT, ARRIVAL_SEQ, { author: AUTHOR, fact: 'the peer\'s newer copy' }), { spaceId: SPACE, token: peerToken(PEER) });
      assert.equal(landed.code, 200, JSON.stringify(landed.body));
    } finally { hold.release(); }
    const answer = await call;
    assert.equal(answer.status, 412, `the stale If-Match answered ${answer.status}, not the precondition refusal: ${answer.text.slice(0, 200)}`);
    const stored = await door.coll(SPACE, 'facts').findOne({ _id: FACT });
    assert.equal(stored.seq, ARRIVAL_SEQ);
    assert.equal(stored.fact, 'the peer\'s newer copy', 'the refused edit changed the stored record');
  });
});
