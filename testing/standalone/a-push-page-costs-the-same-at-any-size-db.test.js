/**
 * A fork-free `batch-upsert` page costs the same number of database commands whatever its size — per brain
 * family (`Q-107` part 1, performance; probe `P3`).
 *
 * ## What it costs today
 *
 * `batch-upsert` processes a page one document at a time: a tombstone read, a record read, the record write and
 * an embed-job write per document, plus one counter write — `4N + 1`, so a 200-document page is 801 commands
 * where the page form is five. On a WAN-latency database that is the difference between a sync cycle in tens of
 * milliseconds and one in seconds, multiplied by every page of every family of every space.
 *
 * ## The rule
 *
 * A page of 200 new, fork-free documents issues EXACTLY as many commands as a page of 20, for each of the five
 * brain families, once the collection is warm (the first write to a fresh collection triggers the search-index
 * presence reconcile, which is not the page's cost). Both sizes sit inside one write chunk (500), so a chunked
 * writer cannot make them differ. File metadata is held to the same rule by its own twin since `Q-107` part 2
 * (`a-file-metadata-page-costs-the-same-at-any-size-db`), so its evidence can be read on its own.
 *
 * Counted: the commands addressed to the family's own collection, the tombstones, the embed queue and the
 * counter — what the page itself costs. A link's violation check (fire-and-forget reads of its endpoints'
 * collections) is excluded by that scope, deliberately and stated.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-push-page-costs-the-same-at-any-size-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build, FAMILIES } from './_push-door.mjs';

const skip = await mongoSkipReason();

const S = 'pushcost';
const KIND = { facts: 'fact', entities: 'entity', edges: 'edge', chrono: 'chrono', links: 'link' };
/** The five brain families: every batch family but file metadata, which its twin file holds to the rule. */
const BRAIN = Object.entries(FAMILIES).filter(([k]) => k !== 'filemeta').map(([key, f]) => ({ key, ...f }));

let door, searchIndexPresenceSettled;
let seq = 0;
const page = (fam, n, tag) => Array.from({ length: n }, (_, i) => build[KIND[fam.key]](S, `${fam.key}-${tag}-${i}`, ++seq));

async function cost(fam, n, tag) {
  const scope = new Set([`${S}_${fam.coll}`, `${S}_tombstones`, `${S}_embed_jobs`, 'ythril_counters']);
  let res;
  const seen = await door.commandsDuring(async () => {
    res = await door.push('/batch-upsert', { [fam.key]: page(fam, n, tag) }, { spaceId: S });
    await door.settled();
    /*
     * The search-index presence reconcile a write schedules (`spaces/search-index-presence.ts`) runs AFTER the
     * write, asynchronously: one `findOne` per page while the collection's index belief is unsettled. Awaited
     * inside the window, so it is counted in every page alike — left running, it landed in this window or the
     * next by timing, and two pages of identical cost read as 7 and 8.
     */
    await searchIndexPresenceSettled(S);
  });
  assert.equal(res.code, 200, JSON.stringify(res.body));
  return seen.filter(c => scope.has(c.split(' ')[1]));
}

describe('a fork-free push page costs the same at any size', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'pushcost', monitorCommands: true, spaces: [{ id: S, label: 'Cost', folders: [], meta: {} }] });
    ({ searchIndexPresenceSettled } = await import('../../server/dist/spaces/search-index-presence.js'));
  });
  after(async () => { await door?.close(); });

  it('the family set is the five brain families and monitoring sees commands', async () => {
    assert.equal(BRAIN.length, 5, BRAIN.map(f => f.key).join(', '));
    const seen = await cost(BRAIN[0], 2, 'probe');
    assert.ok(seen.length >= 1, 'command monitoring recorded nothing in scope, so every comparison below would pass vacuously');
  });

  for (const fam of BRAIN) {
    it(`${fam.key}: a 200-document page issues as many commands as a 20-document page`, async () => {
      await cost(fam, 5, 'warm');
      const small = await cost(fam, 20, 'small');
      const large = await cost(fam, 200, 'large');
      assert.equal(large.length, small.length,
        `${fam.key}: 20 documents cost ${small.length} commands and 200 cost ${large.length} — the page is written one `
        + `document at a time. First commands of the large page: ${large.slice(0, 6).join('; ')}`);
    });
  }
});
