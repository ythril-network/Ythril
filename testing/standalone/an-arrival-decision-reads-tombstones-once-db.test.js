/**
 * The decision about a page of file metadata arrivals reads the file tombstones ONCE (bundle-88, Q-412).
 *
 * ## The defect
 *
 * `readHeldFor` read the published tombstones of the page's paths (`heldFileTombstones`) and then the pending ones
 * (`actedPendingTombstones`): two reads of one collection, by one key, per chunk of the page, on every page of file metadata of every
 * peer every cycle.
 *
 * ## The rule this file states
 *
 * One `find` on `<space>_file_tombstones` per chunk of paths decides a page, published and pending rows together, split in memory; a page
 * of 300 arrivals is one. The stray drain alone still reads the published ones (`heldFileTombstones`).
 *
 * ## Seen red
 *
 * On the base (1e430410c): two finds on the tombstone collection for the page.
 *
 * The decision is asked through `decideArrivals` (the one predicate every arrival of a file asks); the push that lands the winners reads the
 * tombstones once more for what a landed version supersedes, which is another question and not counted.
 *
 * Run: node --test testing/standalone/an-arrival-decision-reads-tombstones-once-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, peerToken } from './_push-door.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'decideonce';
const TOMBSTONES = `${S}_file_tombstones`;
const PEER = 'decideonce-peer';
const AUTHOR = { instanceId: PEER, instanceLabel: 'Peer' };

let acts, tombstones;

describe('an arrival decision reads the file tombstones once', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'decideonce', space: S, monitorCommands: true });
    tombstones = await import('../../server/dist/files/tombstones.js');
  });
  after(async () => { await acts?.close(); });
  beforeEach(async () => { await acts.reset(); });

  it('a page of 300 metadata arrivals: one find on the tombstone collection, and the verdicts are unchanged', async () => {
    const T = '2026-09-01T00:00:05.000Z';
    await acts.door.coll(S, 'file_tombstones').insertMany([
      { _id: 'held-a', spaceId: S, path: 'p0.txt', deletedAt: T, positionAt: T, rowSeq: 10 },
      { _id: 'pend-b', spaceId: S, path: 'p1.txt', deletedAt: T, writtenAt: T, settleAt: T, pending: true, rowSeq: 10 },
    ]);
    const arrivals = Array.from({ length: 300 }, (_, i) => ({ id: `p${i}.txt`, path: `p${i}.txt`, kind: 'meta', seq: 3, author: PEER, deliveredBy: PEER }));
    let verdicts;
    const commands = await acts.door.commandsDuring(async () => { verdicts = await tombstones.decideArrivals(S, arrivals); });
    // p0 is shadowed by the published row; p1's pending row names a path whose bytes are not there, so it shadows too: a deletion that happened.
    assert.deepEqual([...verdicts.shadowed].sort(), ['p0.txt', 'p1.txt'], 'the verdicts changed');
    assert.equal(verdicts.undecided.size, 0);
    const finds = commands.filter(c => c === `find ${TOMBSTONES}`).length;
    assert.equal(finds, 1, `the decision over 300 arrivals read the tombstones ${finds} times`);
    // The same page through the push door still answers by the same verdicts.
    const docs = arrivals.map(a => build.filemeta(S, a.path, 3, { author: AUTHOR }));
    const answer = await acts.door.push('/batch-upsert', { filemeta: docs }, { spaceId: S, token: peerToken(PEER) });
    assert.equal(answer.code, 200, JSON.stringify(answer.body));
    assert.equal(answer.body.filemeta.tombstoned, 2, JSON.stringify(answer.body.filemeta));
    assert.equal(answer.body.filemeta.upserted, 298, JSON.stringify(answer.body.filemeta));
  });
});
