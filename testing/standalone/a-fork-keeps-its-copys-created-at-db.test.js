/**
 * A fork is created with the DIVERGENT COPY's `createdAt` — never the moment this instance happened to fork it
 * (Q-361 item 8, from plan v3 §D).
 *
 * ## Why it matters
 *
 * A fork holds the text the other peer wrote, when it wrote it. Stamped with "now", it is a record whose age is
 * the receiver's sync schedule: retention (D-9 stamps a record from its OWN `createdAt`) gives it a fresh window
 * however old the text is, and two receivers forking the same divergence on different days store two different
 * documents under one derived fork id — which the space hash reports as a divergence for ever. The divergent copy's
 * `createdAt` is the one value both receivers agree on.
 *
 * ## Doors
 *
 * Every PUSH door that forks: the single `POST /facts` and `POST /batch-upsert`. The pull does not fork on 5.6.x (Q-204 is cut), so
 * it is not a case here. Forks already stored keep the stamp they were written with; forks written from now on keep
 * the divergent copy's own. Seen red on 6eb5a333 (5.6.3): both push doors stamp `now`.
 *
 * Run: node --test testing/standalone/a-fork-keeps-its-copys-created-at-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'forkborn';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
/** The divergent copy's own birth — long before this test runs, so "now" cannot pass for it. */
const WRITTEN_THEN = '2025-03-04T05:06:07.000Z';
let door, forkIdFor;

describe('a fork keeps its divergent copy\'s createdAt', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'forkborn', spaces: [S] });
    ({ forkIdFor } = await import('../../server/dist/sync/upsert-plan.js'));
  });
  after(async () => { await door?.close(); });

  const deliver = {
    single: (doc) => door.push('/facts', doc, { spaceId: S, networkId: door.NET, token: TOKEN }),
    batch: (doc) => door.push('/batch-upsert', { facts: [doc] }, { spaceId: S, networkId: door.NET, token: TOKEN }),
  };

  for (const via of Object.keys(deliver)) {
    it(`${via}: the fork carries the divergent copy's createdAt`, async () => {
      await door.reset();
      await door.coll(S, 'facts').insertOne(build.fact(S, 'f', 5, { fact: 'mine', author: { ...PEER_AUTHOR } }));
      await deliver[via](build.fact(S, 'f', 5, { fact: 'theirs', author: { ...PEER_AUTHOR },
        createdAt: WRITTEN_THEN, updatedAt: WRITTEN_THEN }));
      await door.settled();
      const fork = await door.coll(S, 'facts').findOne({ forkOf: 'f' });
      assert.ok(fork, `${via}: the equal-seq divergent copy was not forked at all`);
      assert.equal(fork.fact, 'theirs');
      assert.equal(fork.createdAt, WRITTEN_THEN,
        `${via}: the fork was born ${fork.createdAt}, not when its text was written (${WRITTEN_THEN})`);
      assert.equal(fork.updatedAt, WRITTEN_THEN,
        `${via}: the fork was last updated ${fork.updatedAt}, not when its text was written (${WRITTEN_THEN})`);
      // PIN: the stamps never entered the fork's id, so a re-send still finds the fork it made (forkIdFor hashes parent, seq, text).
      assert.equal(fork._id, forkIdFor('f', 5, 'theirs'));
    });
  }
});
