/**
 * The client file change feed pages every change to a space's files in position order, resumes exactly, and answers alike on both of
 * its doors (bundle-255; plan `design-final.md` item 4, vets: returns, privacy).
 *
 * ## The report
 *
 * A client that mirrors a space's files has no way to ask "what changed since I last looked": `GET /api/files/:spaceId` lists one folder,
 * unpaged, and `list_dir` is the same; `/api/sync/filemeta` is the peer protocol and is not promised to clients. The feed is the
 * door: `GET /api/files/:spaceId/changes?cursor=&prefix=&limit=` and the MCP tool `file_changes`, answering
 * `{ items, nextCursor, through, head }` over one position-ordered read of the space's `files` collection.
 *
 * ## The rule this file holds
 *
 * **Every change to a file puts its path in the feed at the position the change took, in position order, once per page walk; a
 * cursor resumes exactly where the last page ended, whatever lands meanwhile; and both doors give the same answer.** Concretely:
 *
 *  1. ORDER, per act: an upload, a metadata edit, a processing write, a delete (soft delete on and off), a folder delete, a move and a
 *     byte arrival each put exactly the paths they touched into the feed after the cursor taken before, and the full listing equals the
 *     DERIVED set: the space's file rows (no chunk, no hidden tree) sorted by `(pos, _id)`, a flagged row or a marker as `deleted`.
 *  2. A deleted item is `{ path, deleted: true, updatedAt }` and nothing else; a live item carries `path`, `sha256`, `sizeBytes`,
 *     `updatedAt`, `deleted: false`.
 *  3. RESUME: a page never passes a write that is stamped and not committed (the hold of `a-pull-never-passes-an-uncommitted-position-db`,
 *     parked by the same `_b81c-park` helper, no sleep): `through` stays below it; once it settles a resume from the last cursor serves
 *     it, and a write that lands between two pages is served by the continuing walk, each path once.
 *  4. PREFIX: only the paths under the prefix page (a deletion under it included).
 *  5. NO CURSOR: the walk starts at the beginning and the last page carries an encoded cursor, never null; a cursor at the end answers
 *     no items and a cursor again.
 *  6. HIDDEN TREES: `_converted/...` and a legacy `_tmp/graph-<uuid>.json` row never appear.
 *  7. BOTH DOORS answer the same pages for the same state (items, `nextCursor`, `through`, `head`).
 *
 * Database `ythril_harness_fchanges`.
 *
 * Red on d9e2738d: the route is not a route (the file router's wildcard answers it as a path) and the tool is unknown; each case
 * says so through `served`, so no case is red for an import error.
 *
 * Run: node --test testing/standalone/a-file-change-feed-pages-in-position-order-db.test.js
 * (requires the harness Mongo and a prior `npm run build -w server`)
 */
import { describe, it, before, after, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openFeedDoors, DOORS, pathsOf, stateOf, keysOf } from './_file-change-feed.mjs';
import { parkPositionWrites } from './_b81c-park.mjs';
import { seedClaim } from './_media-claim.mjs';
import { escapeRegExp } from '../../scripts/_shared/escape-regexp.mjs';

const skip = await mongoSkipReason();
const S = 'fchanges';
const PEER = Object.freeze({ instanceId: 'feed-peer', instanceLabel: 'Feed peer' });
const HOLD_TIMEOUT = 30_000;
const SHA = 'a'.repeat(64);

let d, meta, processing, loader, park, seq = 0;
const files = () => d.door.coll(S, 'files');
const enc = encodeURIComponent;

const upload = async (p, content = `content of ${p}`) => {
  const a = await d.rest(d.admin.key, 'POST', `/api/files/${S}?path=${enc(p)}`, { content });
  assert.ok(a.status >= 200 && a.status < 300, `fixture: upload of ${p} answered ${a.status}: ${a.text.slice(0, 200)}`);
};
const remove = async (p, confirm = false) => {
  const a = await d.rest(d.admin.key, 'DELETE', `/api/files/${S}?path=${enc(p)}`, confirm ? { confirm: true } : undefined);
  assert.ok(a.status >= 200 && a.status < 300, `fixture: delete of ${p} answered ${a.status}: ${a.text.slice(0, 200)}`);
};
const move = async (src, dst) => {
  const a = await d.rest(d.admin.key, 'PATCH', `/api/files/${S}?path=${enc(src)}`, { destination: dst });
  assert.ok(a.status >= 200 && a.status < 300, `fixture: move ${src} -> ${dst} answered ${a.status}: ${a.text.slice(0, 200)}`);
};

/**
 * What the feed must list for `prefix`: the space's file rows under it (a chunk or a sidecar's derived row is not a file), by `(pos, _id)`,
 * each as `[path, deleted]`. Read from the collection, so the expectation is the data and not a second statement of the rule.
 */
async function derived(prefix) {
  const rows = await files().find({ _id: { $regex: `^${escapeRegExp(prefix)}` }, parentFileId: { $exists: false } }).sort({ pos: 1, _id: 1 }).toArray();
  assert.ok(rows.every(r => typeof r.pos === 'number'), `fixture: a row under ${prefix} carries no position: ${JSON.stringify(rows.find(r => typeof r.pos !== 'number'))}`);
  return rows.map(r => [r._id, r.deletedAt !== undefined || r.feedMarker === true]);
}

describe('the client file change feed pages in position order (real MongoDB)', { skip }, () => {
  before(async () => {
    d = await openFeedDoors({ suite: 'fchanges', spaces: [S] });
    meta = await import('../../server/dist/files/file-meta.js');
    processing = await import('../../server/dist/files/derived-fields.js');
    loader = d.loader;
  });
  after(async () => { park?.restore(); await d?.close(); });
  beforeEach(() => { park?.restore(); park = parkPositionWrites(Object.getPrototypeOf(d.door.mongo.col('probe'))); });
  afterEach(() => { loader.getConfig().softDeleteFileMeta = false; });

  it('fixture: the acts the cases below drive all work, and leave rows carrying positions (green on any build)', { timeout: HOLD_TIMEOUT }, async () => {
    // Held first, by itself, so a case that cannot run its acts fails here and names the act, not in the middle of a feed read.
    const base = 'fx';
    await upload(`${base}/a.md`);
    const claimed = await processing.setDerivedDescriptionIfUnset(S, await seedClaim(S, `${base}/a.md`), `${base}/a.md`, 'Derived here', 'generated');
    assert.equal(claimed, true, 'the processing write did not land on an uploaded file');
    await meta.updateFileMeta(S, `${base}/a.md`, { tags: ['edited'] });
    await upload(`${base}/dir/y.md`);
    await upload(`${base}/m/old.txt`);
    await move(`${base}/m/old.txt`, `${base}/m/new.txt`);
    await remove(`${base}/dir`, true);
    await remove(`${base}/a.md`);
    await meta.recordArrivedFile(S, `${base}/arrived.bin`, 40, SHA, PEER);   // (a byte arrival takes no position on d9e2738d: Q-725)
    const rows = await files().find({ _id: { $regex: `^${base}/` }, parentFileId: { $exists: false } }).toArray();
    assert.ok(rows.some(r => r._id === `${base}/m/new.txt` && r.deletedAt === undefined), 'the moved file is not live at its destination');
    assert.ok(rows.some(r => r._id === `${base}/arrived.bin`), 'the arrival left no row');
    assert.ok(rows.filter(r => r._id !== `${base}/arrived.bin`).every(r => typeof r.pos === 'number'), 'a row an authored act wrote carries no position');
    for (const hidden of ['_converted/fx/x.md', '_tmp/graph-33333333-2222-4333-8444-555555555555.json']) {
      await meta.upsertFileMeta(S, hidden, 5);
      assert.ok(await files().findOne({ _id: hidden }), `the hidden-tree row ${hidden} was not stored`);
    }
    // The hold the resume cases use: a write parked between its stamp and its commit hands back the position it carries.
    const hold = park.arm(`${S}_files`);
    const held = meta.upsertFileMeta(S, `${base}/held.md`, 10);
    const parked = await Promise.race([hold.reached, held.then(() => { throw new Error('the held write finished without a write carrying a numeric pos'); })]);
    await meta.upsertFileMeta(S, `${base}/later.md`, 10);
    hold.release();
    await held;
    assert.equal(typeof parked.pos, 'number');
    const later = await files().findOne({ _id: `${base}/later.md` });
    assert.ok(later.pos > parked.pos, `the second write committed at ${later.pos}, not above the held ${parked.pos}`);
  });

  for (const via of DOORS) {
    it(`${via}: the feed is served, and an empty space answers no items and an encoded cursor`, async () => {
      const a = await d.read(via, { space: S, prefix: `empty-${via}/` });
      const body = d.served(a, via);
      assert.deepEqual(body.items, []);
      assert.equal(typeof body.nextCursor, 'string', `an empty read answered nextCursor ${JSON.stringify(body.nextCursor)}: the last page carries a cursor, never null`);
      assert.ok(body.nextCursor.length > 0);
      assert.equal(typeof body.through, 'number');
      assert.equal(typeof body.head, 'number');
    });

    for (const soft of [false, true]) {
      it(`${via}, soft delete ${soft ? 'on' : 'off'}: each act puts exactly its paths into the feed, in position order, and the full listing is the derived set`, async () => {
        loader.getConfig().softDeleteFileMeta = soft;
        const base = `act-${via}-${soft ? 'soft' : 'hard'}`;
        const p = (name) => `${base}/${name}`;
        let cursor = (await d.drain(via, { space: S })).cursor;
        /** The items the feed adds after the cursor kept, and the cursor moved on. */
        const since = async () => { const r = await d.drain(via, { space: S, cursor, limit: 3 }); cursor = r.cursor; return r.items; };

        // upload: the file, live, with the fields a live item carries
        await upload(p('a.md'));
        let items = await since();
        assert.deepEqual(pathsOf(items), [p('a.md')], `${via}: an upload`);
        // (sha256 is the arrived bytes' hash, asserted below on a byte arrival; an upload's row may not hold one yet)
        assert.deepEqual(keysOf(items[0]).filter(k => k !== 'sha256'), ['deleted', 'path', 'sizeBytes', 'updatedAt'],
          `${via}: a live item carries path, sha256, sizeBytes, updatedAt and deleted and nothing else: ${JSON.stringify(items[0])}`);
        assert.equal(items[0].deleted, false);
        assert.equal(typeof items[0].sizeBytes, 'number');
        assert.equal(typeof items[0].updatedAt, 'string');

        // processing: the machine description write takes a position of its own, so the file is listed again (the client compares sha256)
        const wrote = await processing.setDerivedDescriptionIfUnset(S, await seedClaim(S, p('a.md')), p('a.md'), 'Derived here', 'generated');
        assert.equal(wrote, true, 'fixture: the processing write did not land on an authored file');
        assert.deepEqual(pathsOf(await since()), [p('a.md')], `${via}: a processing write`);

        // edit: a metadata edit
        await meta.updateFileMeta(S, p('a.md'), { tags: ['edited'] });
        assert.deepEqual(pathsOf(await since()), [p('a.md')], `${via}: a metadata edit`);

        // order: two uploads then an edit of the first list the second, then the first (each row once, at its latest position)
        await upload(p('x1.md'));
        await upload(p('x2.md'));
        await meta.updateFileMeta(S, p('x1.md'), { tags: ['again'] });
        assert.deepEqual(pathsOf(await since()), [p('x2.md'), p('x1.md')], `${via}: position order across an upload, an upload and an edit`);

        // delete: a deleted item, exactly { path, deleted, updatedAt }
        await remove(p('a.md'));
        items = await since();
        assert.deepEqual(pathsOf(items), [p('a.md')], `${via}: a delete`);
        assert.deepEqual(keysOf(items[0]), ['deleted', 'path', 'updatedAt'], `${via}: a deleted item carries path, deleted and updatedAt only: ${JSON.stringify(items[0])}`);
        assert.equal(items[0].deleted, true);
        assert.equal(typeof items[0].updatedAt, 'string');

        // folder delete: every file under it, each as deleted
        await upload(p('dir/y.md'));
        await upload(p('dir/sub/z.md'));
        await since();
        await remove(p('dir'), true);
        items = await since();
        assert.deepEqual(stateOf(items).sort(), [[p('dir/sub/z.md'), true], [p('dir/y.md'), true]], `${via}: a folder delete`);

        // move: the source as deleted and the destination as live
        await upload(p('m/old.txt'));
        await since();
        await move(p('m/old.txt'), p('m/new.txt'));
        assert.deepEqual(stateOf(await since()).sort(), [[p('m/new.txt'), false], [p('m/old.txt'), true]], `${via}: a move`);

        // byte arrival: a position and no new version; its sha256 and size are the arrived bytes'
        await meta.recordArrivedFile(S, p('arrived.bin'), 40, SHA, PEER);
        items = await since();
        assert.deepEqual(pathsOf(items), [p('arrived.bin')], `${via}: a byte arrival`);
        assert.deepEqual(keysOf(items[0]), ['deleted', 'path', 'sha256', 'sizeBytes', 'updatedAt']);
        assert.equal(items[0].sha256, SHA);
        assert.equal(items[0].sizeBytes, 40);
        // an identical arrival again writes nothing, so the feed has nothing new
        await meta.recordArrivedFile(S, p('arrived.bin'), 40, SHA, PEER);
        assert.deepEqual(await since(), [], `${via}: an identical byte arrival took a position`);

        // the full listing, with no cursor, is the derived set in position order, and ends with an encoded cursor
        const full = await d.drain(via, { space: S, prefix: `${base}/`, limit: 4 });
        assert.deepEqual(stateOf(full.items), await derived(`${base}/`), `${via}: the full listing is not the position-ordered derived set`);
        assert.equal(typeof full.cursor, 'string');
        assert.ok(full.pages >= 3, 'fixture: limit 4 should have paged');
      });
    }
  }

  for (const via of DOORS) {
    it(`${via}: a prefix pages only the paths under it, a deletion under it included`, async () => {
      const base = `pre-${via}`;
      for (const name of ['p/a.md', 'p/b.md', 'pq/c.md', 'other/d.md']) await upload(`${base}/${name}`);
      await remove(`${base}/p/a.md`);
      const r = await d.drain(via, { space: S, prefix: `${base}/p/` });
      assert.deepEqual(stateOf(r.items).sort(), [[`${base}/p/a.md`, true], [`${base}/p/b.md`, false]], `${via}: the prefix read`);
      const none = await d.drain(via, { space: S, prefix: `${base}/nothing/` });
      assert.deepEqual(none.items, []);
    });

    it(`${via}: no cursor starts at the beginning; a cursor at the end answers nothing and a cursor; a later write is the next page`, async () => {
      const base = `end-${via}`;
      await upload(`${base}/one.md`);
      const first = await d.drain(via, { space: S, prefix: `${base}/` });
      assert.deepEqual(pathsOf(first.items), [`${base}/one.md`]);
      assert.equal(typeof first.cursor, 'string', 'the walk ended without an encoded cursor');
      const again = await d.page(via, { space: S, cursor: first.cursor, prefix: `${base}/` });
      assert.deepEqual(again.items, []);
      assert.equal(typeof again.nextCursor, 'string');
      await upload(`${base}/two.md`);
      const next = await d.page(via, { space: S, cursor: again.nextCursor, prefix: `${base}/` });
      assert.deepEqual(pathsOf(next.items), [`${base}/two.md`]);
    });

    it(`${via}: hidden trees never appear (a sidecar, a legacy graph row) and a visible control does`, async () => {
      const base = `hid-${via}`;
      const cursor = (await d.drain(via, { space: S })).cursor;
      await meta.upsertFileMeta(S, `_converted/${base}/x.md`, 5);
      await meta.upsertFileMeta(S, `_tmp/graph-${via === 'REST' ? '11111111' : '22222222'}-2222-4333-8444-555555555555.json`, 5);
      await meta.upsertFileMeta(S, `${base}/visible.md`, 5);
      const r = await d.drain(via, { space: S, cursor });
      assert.deepEqual(pathsOf(r.items), [`${base}/visible.md`], `${via}: a hidden tree appeared in the feed`);
      const whole = await d.drain(via, { space: S });
      assert.ok(whole.items.every(i => !i.path.startsWith('_converted/') && !i.path.startsWith('_tmp/')), `${via}: the full listing names a hidden tree`);
    });
  }

  it('a write landing between two pages is served by the continuing walk: no gap, no duplicate', async () => {
    for (const via of DOORS) {
      const base = `mid-${via}`;
      for (const n of ['1', '2', '3']) await upload(`${base}/f${n}.md`);
      const one = await d.page(via, { space: S, prefix: `${base}/`, limit: 1 });
      assert.deepEqual(pathsOf(one.items), [`${base}/f1.md`]);
      await upload(`${base}/landed.md`);
      const rest = await d.drain(via, { space: S, cursor: one.nextCursor, prefix: `${base}/`, limit: 1 });
      assert.deepEqual(pathsOf(rest.items), [`${base}/f2.md`, `${base}/f3.md`, `${base}/landed.md`], `${via}: the walk lost or repeated a path`);
    }
  });

  it('a page never passes a write stamped and not committed, and a resume serves both once it settles', { timeout: HOLD_TIMEOUT }, async () => {
    for (const via of DOORS) {
      const base = `hold-${via}`;
      const cursor = (await d.drain(via, { space: S })).cursor;
      const hold = park.arm(`${S}_files`);
      const firstWrite = meta.upsertFileMeta(S, `${base}/held.md`, 10);
      const parked = await Promise.race([
        hold.reached,
        firstWrite.then(() => { throw new Error('the held write finished without a write carrying a numeric pos: this build stamps no position'); }),
      ]);
      let during, kept;
      try {
        await meta.upsertFileMeta(S, `${base}/later.md`, 10);
        const later = await files().findOne({ _id: `${base}/later.md` });
        assert.ok(later && later.pos > parked.pos, `fixture: the second write did not commit above the held position ${parked.pos}`);
        const body = await d.page(via, { space: S, cursor, prefix: `${base}/` });
        during = body;
        kept = body.nextCursor;
      } finally { hold.release(); await firstWrite; }
      assert.ok(!pathsOf(during.items).includes(`${base}/later.md`),
        `${via}: the feed served later.md while position ${parked.pos} was stamped and uncommitted: a client keeps the last cursor and would lose held.md for good`);
      assert.equal(typeof during.through, 'number');
      assert.ok(during.through < parked.pos, `${via}: through ${during.through} is at or past the uncommitted ${parked.pos}`);
      const settled = await d.drain(via, { space: S, cursor: kept, prefix: `${base}/` });
      assert.deepEqual(pathsOf(settled.items), [`${base}/held.md`, `${base}/later.md`], `${via}: after it settled a resume did not serve both, in position order`);
    }
  });

  it('both doors answer the same pages for the same state: items, nextCursor, through and head', async () => {
    const base = 'same';
    for (const n of ['a', 'b', 'c', 'd', 'e']) await upload(`${base}/${n}.md`);
    await remove(`${base}/c.md`);
    const [rest, mcp] = await Promise.all(DOORS.map(async (via) => {
      const out = [];
      let cursor;
      for (let i = 0; i < 4; i += 1) {
        const body = await d.page(via, { space: S, cursor, prefix: `${base}/`, limit: 2 });
        out.push(body);
        cursor = body.nextCursor;
      }
      return out;
    }));
    assert.deepEqual(mcp, rest, 'the MCP tool and the REST route answered different pages for one state');
    assert.deepEqual(stateOf(rest.flatMap(b => b.items)), await derived(`${base}/`), 'the pages are not the derived set');
  });
});
