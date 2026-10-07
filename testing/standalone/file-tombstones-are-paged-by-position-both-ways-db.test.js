/**
 * File tombstones are served, read and sent in PAGES by a position, and a peer that does not know the paging still works
 * (bundle-51 Q-96, Q-396).
 *
 * ## The defect
 *
 * Both directions moved the whole set in one body. The served read stopped at 5000 rows with no way to ask for the rest (a
 * space with more deletions than that never finished replicating: the puller read the first 5000 every cycle, for ever); the
 * sender put its entire set in one POST, and past the request body limit that POST failed — and kept failing every cycle,
 * because the set only grows until a peer acknowledges. File tombstones have no seq, so the record routes' seq keyset does not
 * apply; they are keyed by a LOCAL position (`positionAt`, with the `_id` to break ties).
 *
 * ## The rules
 *
 *  1. **`cursor` pages by keyset**: 500 per page in position order, `nextCursor` naming where to resume and `null` at the end;
 *     every row exactly once across the pages, however many rows share a position (the ties).
 *  2. **A request WITHOUT `cursor` is exactly what it was**: up to 5000 rows, no `nextCursor` key. An older puller reads a full
 *     page as "that is all there is", and a different shape would be misread by it.
 *  3. **A bad cursor is a 400** (the same refusal the record routes answer), never an empty page that reads as "the end".
 *  4. **`since` is still accepted** by the cursor-less read.
 *  5. **The puller opens in cursor mode and reads to the end**, applying every page — and against an older server (no
 *     `nextCursor` in the answer) it reads ONE page, and says that a full one may be truncated.
 *  6. **The sender pushes in pages of at most 500 and records the acknowledgement PER ACKNOWLEDGED PAGE**, never past a page the
 *     peer did not acknowledge: pruned past one, a deletion is lost, and the file it names comes back on the next manifest pull.
 *
 * ## How it is driven
 *
 * Rules 1-4 call the route's own handler over this instance's own `<space>_file_tombstones`. The opening cursor is the one
 * the real puller sends first, read off its request (a client never builds one; it echoes). Rule 5 runs the engine against the
 * fake peer serving the real handler; rule 6 runs it as a pusher against a fake peer that records and can refuse a POST.
 *
 * Run: node --test testing/standalone/file-tombstones-are-paged-by-position-both-ways-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build, PEER_TOKEN } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const S = 'ftpg';
const PAGE = 500;
const LEGACY_LIMIT = 5000;
const POSITIONS = ['2026-08-01T00:00:00.000Z', '2026-08-01T00:00:00.001Z', '2026-08-01T00:00:00.002Z'];

let door, BAD_SYNC_START;

/** `n` own, published tombstones in three heavily tied positions: the case a position-only keyset skips rows in. */
const manyTombs = (n, spaceId = S, prefix = 'p') => Array.from({ length: n }, (_, i) => {
  const at = POSITIONS[Math.floor(i * POSITIONS.length / n)];
  return { _id: `${prefix}-${String(i).padStart(5, '0')}`, spaceId, path: `${prefix}/${i}.txt`, deletedAt: at, positionAt: at };
});

/** The route's own handler, called as a peer token that reaches the space. */
async function get(query) {
  const req = { method: 'GET', query, params: {}, authToken: PEER_TOKEN, get: () => undefined, headers: {} };
  const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
  await door.handler('get', '/file-tombstones')(req, res);
  return { code: res.code, body: res.body };
}

/** The cursor the real puller opens with, read off its first request against an empty peer. */
async function openingCursor() {
  await door.reset();
  await door.sync();
  const first = door.state.fileTombstoneRequests[0];
  assert.ok(first, 'the puller made no file-tombstone request');
  assert.equal(typeof first.cursor, 'string',
    `the puller's first file-tombstone request carries no cursor (${JSON.stringify(first)}): it reads in the legacy mode, which stops at ${LEGACY_LIMIT} rows`);
  assert.notEqual(first.cursor, '', 'the opening cursor is empty, which the server reads as "no cursor"');
  return first.cursor;
}

describe('file tombstones are served, pulled and pushed in pages by a position', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'ftpaging', spaces: [S], files: true });
    ({ BAD_SYNC_START } = await import('../../server/dist/api/sync/_shared.js'));
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); });

  describe('the served read', () => {
    it('with a cursor it pages 500 at a time by keyset: every row once, in order, ties included, nextCursor null at the end', async () => {
      const cursor0 = await openingCursor();
      const all = manyTombs(PAGE * 2 + 120);
      await door.coll(S, 'file_tombstones').insertMany(all.map(t => ({ ...t })));
      const seen = [];
      const sizes = [];
      const nexts = [];
      let cursor = cursor0;
      for (let guard = 0; guard < 20; guard++) {
        const { code, body } = await get({ spaceId: S, cursor });
        assert.equal(code, 200, JSON.stringify(body));
        seen.push(...body.tombstones.map(t => t._id));
        sizes.push(body.tombstones.length);
        assert.ok('nextCursor' in body, 'a cursor-mode answer has no nextCursor key');
        nexts.push(body.nextCursor);
        if (body.nextCursor === null) break;
        assert.equal(typeof body.nextCursor, 'string');
        cursor = body.nextCursor;
      }
      assert.deepEqual(sizes, [PAGE, PAGE, 120], 'pages are not 500 rows, then the remainder');
      assert.deepEqual(nexts.map(n => n === null), [false, false, true], 'nextCursor is not null exactly on the last page');
      assert.equal(new Set(seen).size, seen.length, 'a row was served twice across the pages');
      assert.deepEqual([...seen].sort(), all.map(t => t._id).sort(),
        'the pages together are not exactly the stored rows: a row sharing a position with the page boundary was skipped');
      const order = seen.map(id => all.find(t => t._id === id).positionAt);
      assert.deepEqual(order, [...order].sort(), 'the pages are not in position order');
    });

    it('a pending tombstone is never in a page (the act has not happened)', async () => {
      const cursor0 = await openingCursor();
      await door.coll(S, 'file_tombstones').insertMany([
        ...manyTombs(3), { _id: 'pending-one', spaceId: S, path: 'pend.txt', deletedAt: POSITIONS[0], positionAt: POSITIONS[0], pending: true },
      ]);
      const { body } = await get({ spaceId: S, cursor: cursor0 });
      assert.deepEqual(body.tombstones.map(t => t._id).sort(), ['p-00000', 'p-00001', 'p-00002']);
    });

    it('without a cursor it answers exactly what it did: up to 5000 rows and NO nextCursor key', async () => {
      await door.coll(S, 'file_tombstones').insertMany(manyTombs(LEGACY_LIMIT + 100).map(t => ({ ...t })));
      const { code, body } = await get({ spaceId: S });
      assert.equal(code, 200);
      assert.equal(body.tombstones.length, LEGACY_LIMIT, 'the cursor-less read is not the legacy 5000');
      assert.equal('nextCursor' in body, false, 'a cursor-less answer carries nextCursor: an older puller would misread it');
      assert.deepEqual(Object.keys(body), ['tombstones']);
    });

    it('a bad cursor is a 400 with the sync refusal, never an empty page', async () => {
      await door.coll(S, 'file_tombstones').insertMany(manyTombs(3).map(t => ({ ...t })));
      for (const cursor of ['not-a-cursor', '!!!', 'eyJ4IjoxfQ', 'a'.repeat(5000)]) {
        const { code, body } = await get({ spaceId: S, cursor });
        assert.equal(code, 400, `cursor ${JSON.stringify(cursor.slice(0, 20))} answered ${code}: ${JSON.stringify(body).slice(0, 100)}`);
        assert.equal(body.error, BAD_SYNC_START);
      }
    });

    it('since is still accepted by the cursor-less read', async () => {
      await door.coll(S, 'file_tombstones').insertMany(manyTombs(9).map(t => ({ ...t })));
      const { code, body } = await get({ spaceId: S, since: POSITIONS[0] });
      assert.equal(code, 200);
      assert.ok(body.tombstones.length > 0 && body.tombstones.every(t => t.deletedAt > POSITIONS[0]),
        `since was ignored or misread: ${body.tombstones.map(t => t.deletedAt)}`);
      assert.equal('nextCursor' in body, false);
    });
  });

  describe('the puller', () => {
    /** A tombstone on the PEER's side, for a file this instance holds that the peer wrote. */
    async function seedPeerSide(n) {
      const docs = manyTombs(n, door.peerSide(S), 'pp').map(t => ({ ...t, issuer: PEER }));
      await door.seedPeerFileTombstones(S, docs);
      return docs;
    }
    async function holdFile(p) {
      door.writeLocalFile(S, p, `bytes of ${p}`);
      await door.coll(S, 'files').insertOne(build.filemeta(S, p, 3, { author: PEER_AUTHOR, sizeBytes: 11 }));
    }

    it('opens in cursor mode and reads PAST the first page to the end, applying every page', async () => {
      const docs = await seedPeerSide(PAGE * 2 + 300);
      // The first, a middle one and the very last: the last two are only reached by following nextCursor.
      const targets = [docs[0], docs[PAGE + 17], docs[docs.length - 1]].map(t => t.path);
      for (const p of targets) await holdFile(p);
      await door.sync();
      const reqs = door.state.fileTombstoneRequests;
      assert.ok(reqs.length >= 3, `the puller made ${reqs.length} request(s) for ${docs.length} tombstones: it did not follow nextCursor`);
      assert.ok(reqs.every(r => typeof r.cursor === 'string' && r.cursor !== ''), `a request without a cursor: ${JSON.stringify(reqs.map(r => r.cursor))}`);
      assert.equal(new Set(reqs.map(r => r.cursor)).size, reqs.length, 'the puller re-sent a cursor instead of the next one');
      const left = targets.filter(p => door.localFileExists(S, p));
      assert.deepEqual(left, [], 'files whose tombstones lie beyond the first page were not deleted');
    });

    it('against an older server (no nextCursor) it reads ONE page and applies it', async () => {
      await holdFile('legacy-page.txt');
      door.state.fileTombstoneGet = (_req, res) => res.json({ tombstones: [
        { _id: 'old-1', spaceId: door.peerSide(S), path: 'legacy-page.txt', deletedAt: POSITIONS[0] },
      ] });
      await door.sync();
      assert.equal(door.state.fileTombstoneRequests.length, 1, `the puller made ${door.state.fileTombstoneRequests.length} requests of a server that never answers nextCursor`);
      assert.ok(!door.localFileExists(S, 'legacy-page.txt'), 'the older server\'s tombstone (no issuer, no rowSeq) was not applied');
    });

    it('a FULL page from a server that never answers nextCursor is warned about as possibly truncated', async () => {
      door.state.fileTombstoneGet = (_req, res) => res.json({
        tombstones: manyTombs(LEGACY_LIMIT, door.peerSide(S), 'old').map(({ positionAt: _p, ...t }) => t),
      });
      const { lines } = await door.logsDuring(() => door.sync());
      assert.ok(lines.some(l => /truncat/i.test(l)), `a full ${LEGACY_LIMIT}-row page with no nextCursor was read as complete, silently:\n${lines.slice(0, 8).join('\n')}`);
    });
  });

  describe('the sender', () => {
    const OWN = PAGE * 2 + 200;
    /** The position of own tombstone `i`: strictly increasing, so an acknowledgement names exactly one row. */
    const at = (i) => new Date(Date.UTC(2026, 7, 1, 0, 0, 0, i)).toISOString();
    const own = () => Array.from({ length: OWN }, (_, i) => ({ _id: `own-${String(i).padStart(5, '0')}`, spaceId: S, path: `own/${i}.txt`, deletedAt: at(i), positionAt: at(i) }));
    const acked = () => door.member().lastFileTombstoneAckedAt?.[S];

    beforeEach(async () => {
      door.configure({ direction: 'both' });
      await door.coll(S, 'file_tombstones').insertMany(own());
    });

    it('pushes in pages of at most 500, every tombstone exactly once, and records the acknowledgement at the last one', async () => {
      await door.sync();
      const sizes = door.state.fileTombstonePosts.map(p => p.count);
      assert.ok(sizes.length >= 3 && sizes.every(n => n <= PAGE), `the push went out as [${sizes}]: one body carries the whole set, and past the body limit it never succeeds`);
      assert.deepEqual(door.state.fileTombstonesReceived.map(t => t._id).sort(), own().map(t => t._id).sort(), 'a tombstone was not sent exactly once');
      assert.equal(acked(), at(OWN - 1), 'every page was acknowledged and the position is not at the last tombstone');
    });

    it('records the acknowledgement per page: a page the peer refuses is never acknowledged, and nothing after it is counted', async () => {
      door.state.fileTombstonePost = (_req, res) => {
        const n = door.state.fileTombstonePosts.length;
        if (n === 2) { res.status(500).json({ error: 'the peer failed this page' }); return; }
        res.json({ applied: door.state.fileTombstonePosts[n - 1].count });
      };
      await door.sync();
      assert.equal(acked(), at(PAGE - 1),
        `the acknowledged position is ${acked()}, want the last tombstone of the first page (${at(PAGE - 1)}): `
        + 'an acknowledgement past a refused page prunes tombstones no peer has, and the files they name come back');
    });

    it('the next cycle sends what the refused page left, and the position then reaches the end', async () => {
      let fail = true;
      door.state.fileTombstonePost = (_req, res) => {
        const n = door.state.fileTombstonePosts.length;
        if (fail && n === 2) { res.status(500).json({ error: 'the peer failed this page' }); return; }
        res.json({ applied: door.state.fileTombstonePosts[n - 1].count });
      };
      await door.sync();
      fail = false;
      door.state.fileTombstonesReceived.length = 0;
      await door.sync();
      const second = new Set(door.state.fileTombstonesReceived.map(t => t._id));
      for (const i of [PAGE, PAGE + 1, OWN - 1]) assert.ok(second.has(`own-${String(i).padStart(5, '0')}`), `own-${i} was not sent after the refused page was retried`);
      assert.equal(acked(), at(OWN - 1));
    });
  });
});
