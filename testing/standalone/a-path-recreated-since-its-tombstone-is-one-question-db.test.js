/**
 * The byte door answers "was this path RE-CREATED since its tombstone erased it" by `recreatedSince`, the one function the
 * sidecar rule asks too (bundle-71, Q-407). Its pure table, and the proof that both sites call it, are in
 * `a-path-recreated-since-its-tombstone-is-one-question.test.js`.
 *
 * ## The rule at the door
 *
 * A peer uploads the bytes a held tombstone erased. A LIVE row at the path (a soft-deleted one is the deletion itself) means the
 * path was re-created when its bytes hash differently from the tombstone's `contentHash`, or when it is a newer version by the
 * tombstone's ISSUER. Re-created: the upload is stored. Otherwise: answered `200 { tombstoned: true }`, stored nowhere. Another
 * author's higher seq never counts (two instances' counters are not one clock), and a re-creation with other bytes counts at any
 * seq.
 *
 * ## Seen red
 *
 * On the base the door compared the row's seq with the tombstone's `rowSeq` across authors: the cross-author high row let the
 * erased bytes in, and the re-creation with other bytes at a lower seq was refused.
 *
 * Run: node --test testing/standalone/a-path-recreated-since-its-tombstone-is-one-question-db.test.js   (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { openByteDoor } from './_byte-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'rcsince';
const sha = (s) => createHash('sha256').update(s).digest('hex');
const ERASED = 'the content the owner deleted';
const RECREATED = 'a different file written at the same path later';
const HELD_AT = '2026-09-01T00:00:05.000Z';
const THIRD = { instanceId: 'a-third-instance', instanceLabel: 'Third' };

describe('the byte door answers by recreatedSince', { skip }, () => {
  let door, bytes;
  const hold = (p, { rowSeq, contentHash, issuer } = {}) => door.coll(S, 'file_tombstones').insertOne({
    _id: `held-${p}`, spaceId: S, path: p, deletedAt: HELD_AT, positionAt: HELD_AT,
    ...(rowSeq !== undefined ? { rowSeq } : {}), ...(contentHash !== undefined ? { contentHash } : {}), ...(issuer !== undefined ? { issuer } : {}),
  });
  /** A live row at `p` as it stands here: its bytes (by hash), its version and its author. */
  const live = (p, content, seq, author, extra = {}) =>
    door.coll(S, 'files').insertOne(build.filemeta(S, p, seq, { author, sizeBytes: content.length, sha256: sha(content), ...extra }));
  const asPeer = (p) => bytes.post({ space: S, path: p, bytes: Buffer.from(ERASED), token: peerToken(PEER) });
  const tombstoned = (res) => res.code === 200 && res.body?.tombstoned === true;
  const stored = (res) => [201, 202].includes(res.code) && res.body?.tombstoned === undefined;

  before(async () => {
    door = await openPullDoor({ suite: 'recreatedsince', spaces: [S], files: true, meta: { [S]: { suppressEmbeddings: true } } });
    bytes = await openByteDoor();
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  /**
   * Every row: a tombstone `{ rowSeq: 5, contentHash: ERASED, issuer: PEER }`, a live row at the path, and the PEER's upload of the
   * erased bytes. `shadowed` is what the byte door must answer.
   */
  const SCENARIOS = [
    { name: 'a live row at a HIGHER seq by ANOTHER author with the erased bytes', shadowed: true,
      set: (p) => live(p, ERASED, 99, THIRD) },
    { name: 'a live row with OTHER bytes at a LOWER seq by another author', shadowed: false,
      set: (p) => live(p, RECREATED, 3, THIRD) },
    { name: 'a live row with other bytes by the issuer at the tombstone\'s own version', shadowed: false,
      set: (p) => live(p, RECREATED, 5, PEER_AUTHOR) },
    { name: 'a live row at a NEWER seq by the tombstone\'s ISSUER with the erased bytes', shadowed: false,
      set: (p) => live(p, ERASED, 20, PEER_AUTHOR) },
    { name: 'a live row by the issuer at the SAME seq with the erased bytes', shadowed: true,
      set: (p) => live(p, ERASED, 5, PEER_AUTHOR) },
    { name: 'a SOFT-DELETED row at a higher seq by the issuer', shadowed: true,
      set: (p) => live(p, ERASED, 20, PEER_AUTHOR, { deletedAt: HELD_AT }) },
    { name: 'no live row at all', shadowed: true, set: async () => { /* none */ } },
  ];

  for (const [i, s] of SCENARIOS.entries()) {
    it(`${s.name}: the peer's bytes are ${s.shadowed ? 'answered 200 { tombstoned: true } and stored nowhere' : 'stored'}`, async () => {
      const p = `rc-${i}.txt`;
      await hold(p, { rowSeq: 5, contentHash: sha(ERASED), issuer: PEER });
      await s.set(p);
      const res = await asPeer(p);
      assert.ok(tombstoned(res) || stored(res), `the byte door answered neither: ${JSON.stringify(res)}`);
      assert.equal(tombstoned(res), s.shadowed, `${s.name}: ${JSON.stringify(res)}`);
      if (s.shadowed) assert.equal(door.localFileExists(S, p), false, 'the erased bytes were written');
      else assert.equal(door.localFileExists(S, p), true, 'the re-created path\'s bytes were refused');
    });
  }
});
