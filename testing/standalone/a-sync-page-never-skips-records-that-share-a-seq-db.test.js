/**
 * A sync PAGE never skips a record that shares its position with the last record of the page before it — on every replicated
 * family, for every client that reads the pages (bundle-52, `Q-277`; re-pointed to positions for bundle-81, design rev 8 §6, decision 5).
 *
 * ## The defect
 *
 * A record keeps its AUTHOR's seq when it replicates, so records from several authors share seqs, and the rows carried from 5.6 are paged by
 * that seq as their position (the legacy band). A page that serves `position > since` and hands back a cursor holding the LAST item's position
 * excludes the rest of a run of equal ones. Nothing reports it: the records are not in the response, and the pull engine moves its mark to
 * the highest position it was handed. Records written on a 6.0 instance take a position of their own from the clock and never tie; the carried
 * band is what this file builds, directly, because it is what a cursor still has to be a pair for.
 *
 * ## The rules this file holds, each over every replicated family (derived from `REPLICATED_FAMILIES`, floor 6)
 *
 *  1. **The page handler**, in-process and as the real route, with records sharing one position across the page boundary: a client that
 *     follows `nextCursor` alone receives every record exactly once, and each page says `positions: 1` and is complete through the position
 *     BEFORE a run it ends inside (decision 5). The cursor is OPAQUE here: nothing below decodes or builds one.
 *  2. **A `sinceSeq` is refused**, also beside a cursor: the 5.6 client sends its `sinceSeq` CONSTANT and echoes `cursor`, which is the shape
 *     the 5.6 integrator guide told clients to use, and read as a position its number would start the read in another space of numbers.
 *  3. **A cursor that cannot name its position does not lose a run**: a file whose path `_id` is 2000 characters long, last on its page inside a
 *     run of equal positions, ends the page one row earlier instead of handing back a cursor that would continue from the NEXT position.
 *  4. **The pull engine** against that handler receives the whole run; a stop that leaves a run split across the last two pages leaves the
 *     receive mark at the position before the run, so the next cycle receives the rest.
 *
 * The 5.6 server that pages only by strict `seq >` (this file's old rule 3) is gone with the seq reading: an engine that is answered in that shape
 * ends the member's turn and says the peer is too old, which `a-5x-answer-ends-the-members-turn-db` holds.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-sync-page-never-skips-records-that-share-a-seq-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { replicatedFixtureFamilies, deriveLinkIds, tieRun, missingAndRepeated } from './_seq-tie-families.mjs';
import { positioned, readMark } from './_b81b-positions.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'tiepull';
/** The page the pull engine asks for (`PULL_PAGE` in `sync/pull-family.ts`): the engine cases put a run across this. */
const ENGINE_PAGE = 200;
const MAX_PAGES = 60;

/** Derived once, at load, so each family gets its own case and a red run names every family it fails on. */
const families = await replicatedFixtureFamilies();
/** The run: 199 distinct positions, then four records sharing position 200 — the 200-record engine page ends INSIDE the run. */
const RUN = { before: ENGINE_PAGE - 1, tie: 4, extra: { author: PEER_AUTHOR } };

let door, raiseVersionTo;

/** The ids of the RECORDS a page carries. */
const recordIds = (body) => body.items.map(d => d._id);

/**
 * Read a whole family through the real page handler, one page after another, and return every record id in the order served, and the pages.
 * The start of the stream is the default (no `afterPos`), so the first request names nothing.
 */
async function readAll(family, { limit }) {
  const ids = [];
  const pages = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = { spaceId: S, limit: String(limit), ...(cursor ? { cursor } : {}) };
    const body = await door.pull(`/${family.payloadKey}`, q);
    pages.push(body);
    ids.push(...recordIds(body));
    if (!body.nextCursor) return { ids, pages };
    cursor = body.nextCursor;
  }
  assert.fail(`${family.payloadKey}: still paging after ${MAX_PAGES} pages — a cursor that does not advance`);
}

/** One GET on a family route as a client would send it, with the answer's status (`door.pull` insists on a 200). */
async function getFamily(family, query) {
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  const token = { rights: { perSpace: {}, spaceAdmin: { floor: true, spaces: [] } } };
  await door.handler('get', `/${family.payloadKey}`)({ query: { full: 'true', ...query }, params: {}, authToken: token, get: () => undefined }, res);
  return res;
}

/** The ids stored in the receiver's collection for a family. */
async function storedIds(family) {
  return (await door.coll(S, family.collection).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id);
}

describe('a sync page never skips a record that shares its position', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tiepull', spaces: [S] });
    ({ raiseVersionTo } = await import('../../server/dist/util/version-stamp.js'));
    deriveLinkIds(families, (await import('../../server/dist/brain/link-id.js')).linkIdFor);   // the planner refuses any other link id (Q-222)
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('derives the replicated families, so an empty set cannot pass', () => {
    assert.ok(families.length >= 6, `only ${families.length} families`);
  });

  describe('the page handler (in-process, the real route)', () => {
    for (const family of families) {
      it(`${family.payloadKey}: a client following nextCursor alone receives every record of a run that straddles the page boundary, once`, async () => {
        // positions 1, 2, then FOUR records at position 3 whose ids need escaping in a cursor, then 4: each page size below
        // puts the boundary at a different place inside the run.
        const tied = tieRun(family, S, { before: 2, tie: 4, after: 1, extra: { author: PEER_AUTHOR },
          tieIds: ['tie:a', 'tie:b=', 'tie-ü', 'tie/z'] });
        for (const limit of [1, 2, 3, 4, 5]) {
          await door.wipe(S);
          await door.coll(S, family.collection).insertMany(tied.docs.map(d => ({ ...d })));
          await raiseVersionTo(S, 100);
          const { ids: got, pages } = await readAll(family, { limit });
          const { missing, repeated } = missingAndRepeated(tied.ids, got);
          assert.deepEqual({ missing, repeated }, { missing: [], repeated: [] },
            `GET /${family.payloadKey} limit=${limit}: ${missing.length} of ${tied.ids.length} records never arrived `
            + `(${missing.join(', ')}) — the cursor a page hands back sits on the LAST item's position, so the rest of a run of `
            + `records sharing position ${tied.tieSeq} is cut at the boundary; repeated: ${repeated.join(', ') || 'none'}`);
          for (const page of pages) {
            assert.equal(page.positions, 1, `GET /${family.payloadKey} limit=${limit}: a page does not say it is a 6.0 page`);
            assert.ok(page.through <= page.head, `GET /${family.payloadKey} limit=${limit}: a page is complete through a position above the head`);
          }
          // A page that has more to give and ends inside the run is complete only through the position BEFORE it (decision 5).
          const cutInside = pages.filter(p => p.nextCursor !== null && p.items.length > 0 && p.through >= tied.tieSeq);
          assert.deepEqual(cutInside.map(p => p.through), [], `GET /${family.payloadKey} limit=${limit}: a page with more to come says it is complete through the run's own position`);
        }
      });

      it(`${family.payloadKey}: a 5.6 client (sinceSeq constant, cursor echoed) is refused at its first request, and is served nothing`, async () => {
        const tied = tieRun(family, S, { before: 2, tie: 4, after: 1, extra: { author: PEER_AUTHOR } });
        await door.coll(S, family.collection).insertMany(tied.docs.map(d => ({ ...d })));
        await raiseVersionTo(S, 100);
        const first = await door.pull(`/${family.payloadKey}`, { spaceId: S, limit: '2' });
        assert.ok(first.nextCursor, 'the fixture gave no cursor for a page of two out of seven');
        for (const query of [{ spaceId: S, limit: '2', sinceSeq: '0' }, { spaceId: S, limit: '2', sinceSeq: '0', cursor: first.nextCursor }]) {
          const res = await getFamily(family, query);
          assert.equal(res.code, 400, `GET /${family.payloadKey} ${JSON.stringify(Object.keys(query))} was answered ${res.code}: a sinceSeq was read`);
          assert.match(String(res.body?.error), /sinceSeq/, 'the refusal does not say what it refused');
          assert.equal(res.body?.items, undefined, 'a refused request was served records');
        }
      });
    }

    it('a file whose 2000-character path is last on its page inside a run does not lose the rest of the run', async () => {
      const family = families.find(f => f.payloadKey === 'filemeta');
      assert.ok(family, 'no filemeta family — the derivation is broken');
      const long = `deep/${'x'.repeat(1995)}`;
      assert.equal(long.length, 2000);
      // ONE position for all of them: a carried run. Ids sort by their bytes: a-first, c-third, d-fourth, then the long path, then zz-after.
      const docs = ['a-first.md', 'c-third.md', 'd-fourth.md', long, 'zz-after.md'].map(id => positioned(family.make(S, id, 1, { author: PEER_AUTHOR })));
      await door.coll(S, family.collection).insertMany(docs.map(d => ({ ...d })));
      await raiseVersionTo(S, 100);
      // limit 4: the long path would be the LAST item of the first page, and the run goes on after it, so a cursor that cannot name it would
      // continue from the next position and never serve `zz-after.md`. The page ends one row earlier instead.
      for (const limit of [2, 3, 4]) {
        const { ids } = await readAll(family, { limit });
        const { missing, repeated } = missingAndRepeated(docs.map(d => d._id), ids);
        assert.deepEqual({ missing: missing.map(m => m.slice(0, 20)), repeated: repeated.map(m => m.slice(0, 20)) }, { missing: [], repeated: [] },
          `limit=${limit}: a page ending on a 2000-character path inside a run did not hand back a cursor that reads the rest of the run`);
      }
    });
  });

  describe('the pull engine against the real handler', () => {
    for (const family of families) {
      it(`${family.payloadKey}: a run of equal positions across the engine page boundary is received whole`, async () => {
        door.state.family = door.serveFamily;
        const run = tieRun(family, S, RUN);
        await door.seedPeerRecords(S, family.payloadKey, run.docs);
        await door.sync();
        const { missing, repeated } = missingAndRepeated(run.ids, await storedIds(family));
        assert.deepEqual({ missing: missing.slice(0, 6), repeated }, { missing: [], repeated: [] },
          `${family.payloadKey}: ${missing.length} of ${run.ids.length} records were never received (${missing.slice(0, 6).join(', ')}) — `
          + `the page ended inside the run at position ${run.tieSeq} and the next ask excluded the rest of it`);
        const mark = readMark(door, 'received', S);
        assert.ok(Number.isSafeInteger(mark) && mark >= run.tieSeq,
          `${family.payloadKey}: a pull that finished leaves the receive mark at or past the run's position (it is ${String(mark)})`);
      });

      it(`${family.payloadKey}: a stop with the run split across the last two pages holds the mark before the run, and the next cycle receives the rest`, async () => {
        const run = tieRun(family, S, RUN);
        await door.seedPeerRecords(S, family.payloadKey, run.docs);
        // The second page of the family is refused: the transfer stops with the FIRST page of the run delivered.
        let asked = 0;
        door.state.family = async (req, res, key) => {
          if (key === family.payloadKey && ++asked >= 2) { res.status(503).json({ error: 'scripted stop' }); return; }
          await door.serveFamily(req, res, key);
        };
        await door.logsDuring(() => door.sync());
        assert.ok(asked >= 2, `${family.payloadKey}: the engine never asked for a second page — the fixture does not straddle the boundary`);
        const held = readMark(door, 'received', S) ?? 0;
        assert.equal(held, run.tieSeq - 1,
          `${family.payloadKey}: the pull stopped inside the run at position ${run.tieSeq} and left the receive mark at ${held}; `
          + `only position ${run.tieSeq - 1} is complete, so a mark at ${run.tieSeq} puts the rest of the run behind it for good`);

        door.state.family = door.serveFamily;
        await door.sync();
        const { missing, repeated } = missingAndRepeated(run.ids, await storedIds(family));
        assert.deepEqual({ missing: missing.slice(0, 6), repeated }, { missing: [], repeated: [] },
          `${family.payloadKey}: the next cycle did not receive the rest of the run (${missing.slice(0, 6).join(', ')})`);
        assert.ok(readMark(door, 'received', S) >= run.tieSeq, `${family.payloadKey}: the finished cycle reaches the run's position`);
      });
    }
  });
});
