/**
 * A sync PAGE never skips a record that shares its seq with the last record of the page before it — on every replicated
 * family, for every client that reads the pages, and against a server that pages only by `seq >` (bundle-52, `Q-277`).
 *
 * ## The defect
 *
 * A record keeps its AUTHOR's seq when it replicates, so records from several authors share seqs. `pageBySeq`
 * (`api/sync/docs.ts`) serves `seq > since` and hands back a cursor holding the LAST item's seq, so a page that ends
 * inside a run of equal seqs hands the next page a cursor that excludes the rest of the run. Nothing reports it: the
 * records are not in the response, and the pull engine moves its watermark to the highest seq it was handed.
 *
 * ## The rules this file holds, each over every replicated family (derived from `REPLICATED_FAMILIES`, floor 6)
 *
 *  1. **The page handler**, in-process and as the real route, with records sharing one seq across the page boundary:
 *     (a) a client that follows `nextCursor` alone, and (b) a 5.6 client, which sends `sinceSeq` CONSTANT and echoes
 *     `cursor` (`sync/engine.ts`) — both receive every record exactly once. The cursor is OPAQUE here: nothing below
 *     decodes or builds one, so the format the fix chooses is not pinned.
 *  2. **The pull engine** against that handler receives the whole run; a stop that leaves a run split across the last
 *     two pages leaves `lastSeqReceived` at S - 1, so the next cycle receives the rest.
 *  3. **The pull engine against a server that pages only by strict `seq >`** (a 5.6 peer: its cursor is
 *     `base64url(String(seq))`, ties are unordered, and the tombstones that ride in a page are counted among its
 *     items) still receives the whole run — the deployed servers are not upgraded when the client is.
 *  4. **A cursor that cannot name its position does not wedge paging**: a file whose path `_id` is 2000 characters long,
 *     last on its page, still lets the next page be read.
 *
 * ## What "red at base" is
 *
 * The base pager cuts a run at the boundary, so rules 1-3 fail with the ids of the records that never arrived. Rule 4
 * holds at base (a bare-seq cursor is always readable) and is the guard against the fix refusing the cursor it could
 * not encode.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-sync-page-never-skips-records-that-share-a-seq-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { replicatedFixtureFamilies, tieRun, missingAndRepeated } from './_seq-tie-families.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'tiepull';
/** The page the pull engine asks for (`limit: '200'` in `pullType`): the engine cases put a run across this. */
const ENGINE_PAGE = 200;
const MAX_PAGES = 60;

/** Derived once, at load, so each family gets its own case and a red run names every family it fails on. */
const families = await replicatedFixtureFamilies();
/** The run: 199 distinct seqs, then four records sharing seq 200 — the 200-record engine page ends INSIDE the run. */
const RUN = { before: ENGINE_PAGE - 1, tie: 4, extra: { author: PEER_AUTHOR } };

let door, bumpSeq;

/** The ids of the RECORDS a page carries — the tombstones that ride along are `{ _id, seq, deletedAt }` stubs. */
const recordIds = (body) => body.items.filter(d => d.deletedAt === undefined).map(d => d._id);

/**
 * Read a whole family through the real page handler, one page after another, and return every record id in the order
 * served. `echoSince` is the 5.6 client's shape: `sinceSeq` sent CONSTANT on every request beside the echoed cursor.
 */
async function readAll(family, { limit, echoSince }) {
  const ids = [];
  let cursor;
  for (let page = 0; page < MAX_PAGES; page++) {
    const q = { spaceId: S, limit: String(limit), ...(echoSince ? { sinceSeq: '0' } : {}), ...(cursor ? { cursor } : {}) };
    const body = await door.pull(`/${family.payloadKey}`, q);
    ids.push(...recordIds(body));
    if (!body.nextCursor) return ids;
    cursor = body.nextCursor;
  }
  assert.fail(`${family.payloadKey}: still paging after ${MAX_PAGES} pages — a cursor that does not advance`);
}

/** The ids stored in the receiver's collection for a family. */
async function storedIds(family) {
  return (await door.coll(S, family.collection).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id);
}

describe('a sync page never skips a record that shares its seq', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'tiepull', spaces: [S] });
    ({ bumpSeq } = await import('../../server/dist/util/seq.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  it('derives the replicated families, so an empty set cannot pass', () => {
    assert.ok(families.length >= 6, `only ${families.length} families`);
  });

  describe('the page handler (in-process, the real route)', () => {
    for (const family of families) {
      for (const echoSince of [false, true]) {
        const client = echoSince ? 'a 5.6 client (sinceSeq constant, cursor echoed)' : 'a client following nextCursor alone';
        it(`${family.payloadKey}: ${client} receives every record of a run that straddles the page boundary, once`, async () => {
          // seqs 1, 2, then FOUR records at seq 3 whose ids need escaping in a cursor, then seq 4: each page size below
          // puts the boundary at a different place inside the run.
          const tied = tieRun(family, S, { before: 2, tie: 4, after: 1, extra: { author: PEER_AUTHOR },
            tieIds: ['tie:a', 'tie:b=', 'tie-ü', 'tie/z'] });
          for (const limit of [1, 2, 3, 4, 5]) {
            await door.wipe(S);
            await door.coll(S, family.collection).insertMany(tied.docs.map(d => ({ ...d })));
            await bumpSeq(S, 100);
            const got = await readAll(family, { limit, echoSince });
            const { missing, repeated } = missingAndRepeated(tied.ids, got);
            assert.deepEqual({ missing, repeated }, { missing: [], repeated: [] },
              `GET /${family.payloadKey} limit=${limit} (${client}): ${missing.length} of ${tied.ids.length} records never arrived `
              + `(${missing.join(', ')}) — the cursor a page hands back sits on the LAST item's seq, so the rest of a run of `
              + `records sharing seq ${tied.tieSeq} is cut at the boundary; repeated: ${repeated.join(', ') || 'none'}`);
          }
        });
      }
    }

    it('a file whose 2000-character path is last on its page does not stop the next page being read (guard: holds at base)', async () => {
      const family = families.find(f => f.payloadKey === 'filemeta');
      assert.ok(family, 'no filemeta family — the derivation is broken');
      const long = `deep/${'x'.repeat(1995)}`;
      assert.equal(long.length, 2000);
      const docs = [
        family.make(S, 'a-first.md', 1, { author: PEER_AUTHOR }),
        family.make(S, long, 2, { author: PEER_AUTHOR }),
        family.make(S, 'c-third.md', 3, { author: PEER_AUTHOR }),
        family.make(S, 'd-fourth.md', 4, { author: PEER_AUTHOR }),
      ];
      await door.coll(S, family.collection).insertMany(docs.map(d => ({ ...d })));
      await bumpSeq(S, 100);
      for (const echoSince of [false, true]) {
        // limit 2: the long path is the LAST item of the first page, so the cursor has to name a 2000-character id.
        const got = await readAll(family, { limit: 2, echoSince });
        assert.deepEqual(got, docs.map(d => d._id),
          `a page ending on a 2000-character path ${echoSince ? '(5.6 client) ' : ''}did not hand back a cursor that reads the next page`);
      }
    });
  });

  describe('the pull engine against the real handler', () => {
    for (const family of families) {
      it(`${family.payloadKey}: a run of equal seqs across the engine page boundary is received whole`, async () => {
        door.state.family = door.serveFamily;
        const run = tieRun(family, S, RUN);
        await door.seedPeerRecords(S, family.payloadKey, run.docs);
        await door.sync();
        const { missing, repeated } = missingAndRepeated(run.ids, await storedIds(family));
        assert.deepEqual({ missing: missing.slice(0, 6), repeated }, { missing: [], repeated: [] },
          `${family.payloadKey}: ${missing.length} of ${run.ids.length} records were never received (${missing.slice(0, 6).join(', ')}) — `
          + `the page ended inside the run at seq ${run.tieSeq} and the next ask excluded the rest of it`);
        assert.equal(door.member().lastSeqReceived?.[S], run.tieSeq,
          `${family.payloadKey}: a pull that finished leaves lastSeqReceived at the run's seq`);
      });

      it(`${family.payloadKey}: a stop with the run split across the last two pages holds the watermark at S - 1, and the next cycle receives the rest`, async () => {
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
        const held = door.member().lastSeqReceived?.[S] ?? 0;
        assert.equal(held, run.tieSeq - 1,
          `${family.payloadKey}: the pull stopped inside the run at seq ${run.tieSeq} and left lastSeqReceived at ${held}; `
          + `only seq ${run.tieSeq - 1} is complete, so a watermark at ${run.tieSeq} puts the rest of the run behind it for good`);

        door.state.family = door.serveFamily;
        await door.sync();
        const { missing, repeated } = missingAndRepeated(run.ids, await storedIds(family));
        assert.deepEqual({ missing: missing.slice(0, 6), repeated }, { missing: [], repeated: [] },
          `${family.payloadKey}: the next cycle did not receive the rest of the run (${missing.slice(0, 6).join(', ')})`);
        assert.equal(door.member().lastSeqReceived?.[S], run.tieSeq, `${family.payloadKey}: the finished cycle reaches the run's seq`);
      });
    }
  });

  describe('the pull engine against a server that pages only by strict seq > (a 5.6 peer)', () => {
    const b64 = (s) => Buffer.from(s).toString('base64url');
    const un64 = (t) => Number.parseInt(Buffer.from(t, 'base64url').toString(), 10) || 0;

    /**
     * What a 5.6 server answers, pinned to its codec: the start is `cursor` (a bare decimal seq, base64url) or `sinceSeq`;
     * a page is every record above it, `limit` of them, ties in NO particular order (here: descending id, so a client
     * that relied on id order would be wrong); `nextCursor` is the last item's seq. The tombstones that ride in a page
     * are appended to `items`, so a page's length is not its record count.
     */
    function legacyServer(family, docs, riders) {
      return (req, res) => {
        const q = req.query;
        const start = q.cursor ? un64(String(q.cursor)) : Number(q.sinceSeq ?? 0);
        const limit = Math.min(Number(q.limit) || 100, 500);
        const above = docs.filter(d => d.seq > start).sort((a, b) => a.seq - b.seq || (a._id < b._id ? 1 : -1));
        const items = above.slice(0, limit);
        const nextCursor = above.length > limit ? b64(String(items[items.length - 1].seq)) : null;
        const pageMax = items.length > 0 ? items[items.length - 1].seq : start;
        const taken = new Set(items.map(d => d._id));
        const tombs = family.tombstoneType === null ? [] : riders
          .filter(t => t.seq > start && t.seq <= pageMax && !taken.has(t._id))
          .map(t => ({ _id: t._id, seq: t.seq, deletedAt: '2026-09-01T00:00:00.000Z' }));
        res.json({ items: [...items, ...tombs].sort((a, b) => a.seq - b.seq), nextCursor });
      };
    }

    for (const family of families) {
      it(`${family.payloadKey}: a run of equal seqs across the page boundary is received whole, riders and unordered ties included`, async () => {
        const run = tieRun(family, S, RUN);
        // Deletions that ride in the pages, one below the run and one inside it.
        const riders = [{ _id: 'gone-1', seq: 150 }, { _id: 'gone-2', seq: run.tieSeq }];
        const asks = [];
        const serve = legacyServer(family, run.docs, riders);
        door.state.family = (req, res, key) => {
          if (key !== family.payloadKey) { res.json({ items: [], nextCursor: null }); return; }
          asks.push({ ...req.query });
          serve(req, res);
        };
        await door.sync();
        assert.ok(asks.length >= 2, `${family.payloadKey}: the engine asked the legacy server ${asks.length} time(s) — the fixture does not straddle the boundary`);
        const { missing, repeated } = missingAndRepeated(run.ids, await storedIds(family));
        assert.deepEqual({ missing: missing.slice(0, 6), repeated }, { missing: [], repeated: [] },
          `${family.payloadKey}: ${missing.length} of ${run.ids.length} records were never received from a strict-seq server `
          + `(${missing.slice(0, 6).join(', ')}) — a client that moves on from the LAST seq of a page loses the rest of a run that the `
          + 'page ended inside; asks: ' + JSON.stringify(asks.map(a => [a.sinceSeq, a.cursor ? un64(a.cursor) : null])));
        assert.equal(door.member().lastSeqReceived?.[S], run.tieSeq, `${family.payloadKey}: the finished cycle reaches the run's seq`);
      });

      it(`${family.payloadKey}: a stop with the run split across the last two pages holds the watermark at S - 1, and the next cycle receives the rest`, async () => {
        const run = tieRun(family, S, RUN);
        const serve = legacyServer(family, run.docs, []);
        let asked = 0;
        let stopAtSecond = true;
        door.state.family = (req, res, key) => {
          if (key !== family.payloadKey) { res.json({ items: [], nextCursor: null }); return; }
          if (stopAtSecond && ++asked >= 2) { res.status(503).json({ error: 'scripted stop' }); return; }
          serve(req, res);
        };
        await door.logsDuring(() => door.sync());
        assert.ok(asked >= 2, `${family.payloadKey}: the engine never asked for a second page`);
        const held = door.member().lastSeqReceived?.[S] ?? 0;
        assert.equal(held, run.tieSeq - 1,
          `${family.payloadKey}: stopped inside the run at seq ${run.tieSeq}, left lastSeqReceived at ${held} instead of ${run.tieSeq - 1}`);

        stopAtSecond = false;
        await door.sync();
        const { missing, repeated } = missingAndRepeated(run.ids, await storedIds(family));
        assert.deepEqual({ missing: missing.slice(0, 6), repeated }, { missing: [], repeated: [] },
          `${family.payloadKey}: the next cycle did not receive the rest of the run from a strict-seq server (${missing.slice(0, 6).join(', ')})`);
      });
    }
  });
});
