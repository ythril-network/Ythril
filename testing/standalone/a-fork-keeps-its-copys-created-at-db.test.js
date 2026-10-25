/**
 * A fork is created with the DIVERGENT COPY's `createdAt` — never the moment this instance happened to fork it
 * (plan v3 §D, Q-204).
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
 * Every door that forks: the single `POST /<kind>`, `POST /batch-upsert`, and the pull (which forks once it plans
 * by the same rule as push — `push-and-pull-decide-alike-db`). Seen red on the base (0b066822): both push doors
 * stamp `now`; the pull stores no fork at all.
 *
 * ## Every kind (Q-624, test 13)
 *
 * Facts were the only kind that forked; entities, chrono entries and edges fork now (D-23), and each carries the same rule:
 * the fork's `createdAt` AND `updatedAt` are the divergent copy's own, so two receivers store one document under one derived id
 * and retention (D-9) counts the copy's age. The kinds are read from the planner (`_fork-kinds.mjs`, `FORKING_FAMILIES`), never listed.
 * Seen red on the base (b857da8f): `FORKING_FAMILIES` is not exported; with it stubbed in (scratch), entity, chrono and edge copies
 * at an equal seq are skipped and no fork exists to carry a date.
 *
 * Run: node --test testing/standalone/a-fork-keeps-its-copys-created-at-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { forkingFamilies, copyOf, arrivalDoors, FORK_FIXTURE } from './_fork-kinds.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'forkborn';
const TOKEN = Object.freeze({ rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } }, peerInstanceId: PEER });
/** The divergent copy's own birth — long before this test runs, so "now" cannot pass for it. */
const WRITTEN_THEN = '2025-03-04T05:06:07.000Z';
let door, FAMILIES, DOORS;

describe('a fork keeps its divergent copy\'s createdAt', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'forkborn', spaces: [S] });
    DOORS = arrivalDoors(door, TOKEN);
    FAMILIES = await forkingFamilies();
  });
  after(async () => { await door?.close(); });

  // Every kind that forks (Q-624, test 13: entity, chrono and edge cases beside the fact one), derived from the planner, on every door
  // that plans a fork. The doors are `arrivalDoors`: single route, batch and pull.
  for (const via of ['single', 'batch', 'pull']) {
    it(`${via}: the fork of every kind carries the divergent copy's createdAt and updatedAt`, async () => {
      const failures = [];
      for (const family of FAMILIES) {
        const field = FORK_FIXTURE[family].field;
        await door.reset();
        await door.coll(S, family).insertOne(copyOf(family, S, 'f', 5, 'mine', { author: { ...PEER_AUTHOR } }));
        await DOORS[via](family, { [S]: [copyOf(family, S, 'f', 5, 'theirs', { author: { ...PEER_AUTHOR }, createdAt: WRITTEN_THEN, updatedAt: WRITTEN_THEN })] });
        await door.settled();
        const fork = await door.coll(S, family).findOne({ forkOf: 'f' });
        if (!fork) { failures.push(`${via}/${family}: the equal-seq divergent copy was not forked at all`); continue; }
        if (fork[field] !== 'theirs') failures.push(`${via}/${family}: the fork says ${JSON.stringify(fork[field])}`);
        if (fork.createdAt !== WRITTEN_THEN) failures.push(`${via}/${family}: the fork was born ${fork.createdAt}, not when its body was written (${WRITTEN_THEN})`);
        if (fork.updatedAt !== WRITTEN_THEN) failures.push(`${via}/${family}: the fork was last updated ${fork.updatedAt}, not when its body was (${WRITTEN_THEN})`);
      }
      assert.deepEqual(failures, [], `${failures.length} divergence(s): ${failures.join('; ')}`);
    });
  }
});
