/**
 * A file row that ARRIVING BYTES created has no author's say in its deletion: the origin's tombstone deletes it (bundle-71, Q-405).
 *
 * ## The defect
 *
 * Bytes land before their metadata when a peer R pushes a file's bytes (or this instance pulls them): `recordArrivedFile`
 * creates the row as a placeholder — seq 0, `author` = the peer that DELIVERED the bytes, nothing authored in it. The file's
 * origin O then deletes the file and its tombstone, issued and delivered by O, reaches this instance. The deletion authority
 * (`authorises`) read that placeholder's `author` as the file's author: O is not R, so the tombstone was DECLINED
 * (`not_author`), and the file stayed here for ever — with its tombstone not stored either, so nothing relayed it on.
 *
 * ## The rule
 *
 * A file row at seq 0 with no authored metadata is authorless to the deletion authority, which `tombstoneGoverns` already
 * governs (an author-less row is deleted by whoever proves they issued the tombstone). So:
 *
 *   - the placeholder a delivery's bytes created is deleted by the origin's tombstone, on the push door and on the pull door
 *   - the placeholder is NOT authorless once metadata is authored into it: a row R authored (a seq above 0, written by R)
 *     is still protected from a tombstone another peer issued
 *   - a row a third peer authored is protected exactly as before, and a row the origin itself delivered is deleted as before
 *
 * Records are unchanged (D-14): this is about the row `recordArrivedFile` makes, and the docblocks that said "a declined
 * element would be declined again" name this case.
 *
 * ## Seen red
 *
 * On the base the first scenario is declined, so its row and bytes stay and the push answer counts a decline the rule says
 * is a deletion. The other three rows are green on the base: they state what the rule must still hold.
 *
 * Run: node --test testing/standalone/a-row-that-arriving-bytes-created-is-authorless-to-the-deletion-authority-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, LATERAL } from './_pull-door.mjs';
import { openByteDoor } from './_byte-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'oauth';
/** The file's origin (it deletes) and the peer that delivered its bytes first. */
const ORIGIN = PEER;
const R = LATERAL;
const THIRD = 'third-party-author';

let door, bytes;

const rowOf = (id) => door.coll(S, 'files').findOne({ _id: id });
const pathOf = (id) => `${id}.txt`;
const arrive = async (id, from) => {
  const res = await bytes.post({ space: S, path: pathOf(id), bytes: Buffer.from(`bytes of ${id}`), token: peerToken(from) });
  assert.ok([201, 202].includes(res.code), `${id}: the arrival of its bytes was refused: ${JSON.stringify(res)}`);
};

/**
 * What each scenario holds before the origin's tombstone arrives, and whether the tombstone must delete it.
 * `ready` makes the state; the fixture check below asserts the row is what the scenario says it is (the rule is about
 * a state, and a scenario that did not reach it would pass for the wrong reason).
 */
const SCENARIOS = [
  { id: 'placeholder-from-r', deleted: true, note: 'bytes delivered by R created the row (seq 0, authored by R); the origin deletes',
    async ready(id) { await arrive(id, R); },
    holds: (r) => r.seq === 0 && r.author?.instanceId === R },
  { id: 'placeholder-then-authored-by-r', deleted: false, note: 'R then delivered the file\'s metadata: a version R authored (seq above 0); the origin\'s tombstone is not R\'s to speak for',
    async ready(id) {
      await arrive(id, R);
      const sent = await door.push('/batch-upsert', { filemeta: [build.filemeta(S, pathOf(id), 5, { author: { instanceId: R, instanceLabel: R }, description: 'written by R' })] },
        { spaceId: S, token: peerToken(R) });
      assert.equal(sent.body.filemeta.upserted, 1, `fixture: R's metadata did not land: ${JSON.stringify(sent.body)}`);
    },
    holds: (r) => r.seq === 5 && r.author?.instanceId === R },
  { id: 'authored-by-third', deleted: false, note: 'a third peer authored the version (seq 3) and R delivered it: protected, as before',
    async ready(id) {
      door.writeLocalFile(S, pathOf(id), `bytes of ${id}`);
      await door.coll(S, 'files').insertOne(build.filemeta(S, pathOf(id), 3, { author: { instanceId: THIRD, instanceLabel: THIRD }, deliveredBy: R, sizeBytes: 11 }));
    },
    holds: (r) => r.seq === 3 && r.author?.instanceId === THIRD },
  { id: 'placeholder-from-origin', deleted: true, note: 'the origin itself delivered the bytes (a row it is the author of): deleted, as before',
    async ready(id) { await arrive(id, ORIGIN); },
    holds: (r) => r.seq === 0 && r.author?.instanceId === ORIGIN },
];

const tombFor = (s, n) => ({ _id: `ft-${s.id}`, spaceId: S, path: pathOf(s.id), deletedAt: `2026-09-01T00:00:${String(10 + n).padStart(2, '0')}.000Z`, issuer: ORIGIN, rowSeq: 3 });

/** The origin's tombstone as a push by the origin, or as served to this instance's pull from the origin. */
const DOORS = {
  push: { async deliver(tombstones) { return door.push('/file-tombstones', { spaceId: S, tombstones }, { spaceId: S, token: peerToken(ORIGIN) }); } },
  pull: {
    async deliver(tombstones) {
      await door.seedPeerFileTombstones(S, tombstones.map(t => ({ ...t, spaceId: door.peerSide(S), positionAt: t.deletedAt })));
      return door.sync();
    },
  },
};

describe('a row arriving bytes created is authorless to the deletion authority', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'originauthless', spaces: [S], lateral: true, files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  for (const [name, d] of Object.entries(DOORS)) {
    it(`${name} door: the origin's tombstone deletes the placeholder its peer's bytes made, and only a row nobody authored`, async () => {
      for (const s of SCENARIOS) {
        await s.ready(s.id);
        const r = await rowOf(pathOf(s.id));
        assert.ok(r, `fixture: ${s.id} has no row`);
        assert.ok(s.holds(r), `fixture: ${s.id} is not in the state it names (${s.note}): ${JSON.stringify({ seq: r.seq, author: r.author })}`);
      }
      const answer = await d.deliver(SCENARIOS.map(tombFor));
      const wrong = [];
      for (const s of SCENARIOS) {
        const gone = (await rowOf(pathOf(s.id))) === null;
        const bytesGone = !door.localFileExists(S, pathOf(s.id));
        if (gone !== s.deleted) wrong.push(`${s.id} (${s.note}): the row is ${gone ? 'GONE' : 'STILL HERE'}, want ${s.deleted ? 'gone' : 'kept'}`);
        if (bytesGone !== s.deleted) wrong.push(`${s.id}: the bytes are ${bytesGone ? 'GONE' : 'STILL HERE'}, want ${s.deleted ? 'gone' : 'kept'}`);
      }
      if (name === 'push') {
        assert.equal(answer.code, 200, JSON.stringify(answer.body));
        const wantDeclined = SCENARIOS.filter(s => !s.deleted).length;
        if ((answer.body.declined ?? 0) !== wantDeclined) {
          wrong.push(`the push answer says declined ${answer.body.declined ?? 0}, want ${wantDeclined}: a deletion the rule allows was declined`);
        }
      }
      assert.deepEqual(wrong, [], 'what the origin\'s tombstone did against the rule');
    });
  }
});
