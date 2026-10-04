/**
 * A read result that did not fit is kept OUTSIDE every space: in an instance store, readable by the token that
 * caused it and nobody else, for up to a day.
 *
 * ## The defect (Q-92)
 *
 * `brain/graph-spill.ts` wrote a recall's remainder and an over-cap traversal into the seed's space: a blob under
 * `_tmp/`, a `<space>_files` record, a seq bump that made the record sync to every peer, and an embed job. So a
 * token holding only `knowledge: read` changed a space by searching it. Owner, 2026-09-27: *"i somewhere read a
 * search can modify data? sounds like a huge bug and security issue to me!"* The rest of the 2026-08-13 ruling
 * stands — the complete result, a download link, a one-day lifetime, the caller's own token required — and only
 * the LOCATION moves.
 *
 * ## The contract these tests hold `brain/read-spill-store.ts` to
 *
 * - `putSpill({ kind: 'results' | 'graph', issuedTo, items, request, ceilingHit? })` resolves to
 *   `{ id, expiresAt, ... }` on success, or `{ refused: <reason> }` — a refusal is RETURNED, because every caller
 *   degrades it to `spillRefused: <reason>` on an answer that still carries `truncated` and `nextSkip`.
 * - `readSpillPage({ id, issuedTo, skip, maxBytes })` resolves to `{ status: 200, kind, request, total,
 *   expiresAt, items: <the window>, skip, nextSkip?, truncated }`, or `{ status: 404 }` / `{ status: 410 }`.
 * - `dropSpillsForSpace(spaceId)`, `renameSpillsForSpace(from, to)`, `ensureReadSpillIndexes()`.
 * - Two collections: headers in `_read_spills`, gzip pages of at most 256 KiB RAW in `_read_spill_pages`, each
 *   page `{ spillId, index: <ordinal of its first item>, count, body, rawBytes, expiresAt }`.
 *
 * The collection names and the page size are literal here on purpose: they are the plan's fixture, and a test
 * that derived them from the module under test would assert that the module equals itself.
 *
 * ## The caps are set SMALL, before the module loads
 *
 * `READ_SPILL_TOKEN_MAX_MB=1`, `READ_SPILL_TOKEN_MAX_COUNT=3`, `READ_SPILL_INSTANCE_MAX_MB=2`, so a share and a
 * ceiling can be crossed with a few hundred kilobytes rather than the production 64 MiB / 1 GiB.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-read-spill-is-kept-outside-every-space-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { gunzipSync } from 'node:zlib';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';
import { MUTATORS } from './_document-mutators.mjs';

// Before ANY import of the store: a module that reads its caps at load time must see these.
process.env['READ_SPILL_TOKEN_MAX_MB'] = '1';
process.env['READ_SPILL_TOKEN_MAX_COUNT'] = '3';
process.env['READ_SPILL_INSTANCE_MAX_MB'] = '2';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-read-spill-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const HEADERS = '_read_spills';
const PAGES = '_read_spill_pages';
const PAGE_RAW_BYTES = 256 * 1024;
const MIB = 1024 * 1024;
const DAY_MS = 86_400_000;

const TOKEN_A = 'tok-aaaa';
const TOKEN_B = 'tok-bbbb';

let mongo, store, SPILL_TTL_DAYS;

const headers = () => mongo.col(HEADERS);
const pages = () => mongo.col(PAGES);

/** One result record of roughly `bytes` raw JSON bytes. Random filler, so gzip cannot flatter a size. */
const record = (i, spaceId = 'general', bytes = 1_000) => ({
  _id: `rec-${i}`, spaceId, name: `record ${i}`, body: randomBytes(Math.ceil(bytes / 2)).toString('hex'),
});
const rawBytes = (v) => Buffer.byteLength(JSON.stringify(v), 'utf8');
const records = (n, bytes, spaceId) => Array.from({ length: n }, (_, i) => record(i, spaceId, bytes));

const put = (over) => store.putSpill({ kind: 'results', issuedTo: TOKEN_A, request: { query: 'q' }, ...over });
const read = (id, issuedTo = TOKEN_A, over = {}) =>
  store.readSpillPage({ id, issuedTo, skip: 0, maxBytes: 64 * MIB, ...over });

/** A successful put, or the reason it was not one — so a red test says why rather than `undefined`. */
async function putOk(over) {
  const r = await put(over);
  assert.ok(r && typeof r.id === 'string' && !r.refused, `putSpill refused or returned no id: ${JSON.stringify(r)}`);
  return r;
}

/** The ordering a spill must not be able to lose: headers are created after their pages, even in a burst. */
const tick = () => new Promise(res => setTimeout(res, 5));

const decode = (page) => JSON.parse(gunzipSync(Buffer.from(page.body.buffer ?? page.body)).toString('utf8'));

async function assertNothingStored(label) {
  assert.equal(await headers().countDocuments({}), 0, `${label}: a header was written for a refused spill`);
  assert.equal(await pages().countDocuments({}), 0, `${label}: pages were written for a refused spill`);
}

describe('the caps are validated settings', () => {
  it('each cap is a NUMERIC_SETTINGS row, so a typo stops the boot instead of disabling the cap', async () => {
    const { NUMERIC_SETTINGS } = await import('../../server/dist/config/env-num.js');
    const names = new Set(NUMERIC_SETTINGS.map(s => s.name));
    const missing = ['READ_SPILL_TOKEN_MAX_MB', 'READ_SPILL_TOKEN_MAX_COUNT', 'READ_SPILL_INSTANCE_MAX_MB']
      .filter(n => !names.has(n));
    assert.deepEqual(missing, [],
      'a cap read with a bare Number() is NaN on a typo, and every comparison against NaN is false: no cap at all');
  });
});

describe('a read spill lives in the instance store, never in a space', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('readspill');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'read-spill-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [
        { id: 'general', label: 'General', builtIn: true, folders: [] },
        { id: 'alpha', label: 'Alpha', folders: [] },
        { id: 'beta', label: 'Beta', folders: [] },
      ],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    ({ SPILL_TTL_DAYS } = await import('../../server/dist/brain/graph-spill.js'));
    store = await import('../../server/dist/brain/read-spill-store.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    await headers().deleteMany({});
    await pages().deleteMany({});
  });

  describe('pages', () => {
    it('are cut on item boundaries, in order, and none passes the page size unless one item does', async () => {
      // ~80 KB items make three per page; the 300 KB one at position 4 is larger than a page on its own. The
      // whole spill stays under the 1 MB share set above — a larger one is refused, which is its own case.
      const items = records(9, 80_000);
      items.splice(4, 0, record(99, 'general', 300_000));
      const { id } = await putOk({ items });

      const stored = await pages().find({ spillId: id }).sort({ index: 1 }).toArray();
      assert.ok(stored.length >= 4, `expected the spill to page, got ${stored.length} page(s)`);

      let ordinal = 0;
      const back = [];
      for (const p of stored) {
        assert.equal(p.index, ordinal, `a page's index is the ordinal of its first item (page at ${p.index})`);
        const body = decode(p);
        assert.ok(Array.isArray(body), 'a page body is a gzip JSON ARRAY of whole items');
        assert.equal(p.count, body.length, 'count names how many items the page holds');
        assert.ok(p.rawBytes <= PAGE_RAW_BYTES || p.count === 1,
          `a ${p.rawBytes}-byte page of ${p.count} items: only a single oversized item may pass the page size`);
        ordinal += p.count;
        back.push(...body);
      }
      assert.deepEqual(back, items, 'the pages, concatenated, are the items — none split, none lost, none reordered');
      assert.ok(stored.some(p => p.count === 1 && decode(p)[0]._id === 'rec-99'),
        'the item larger than a page is a page of its own, never cut in two');

      const h = await headers().findOne({ _id: id });
      assert.equal(h.items, items.length);
      assert.equal(h.rawBytes, stored.reduce((n, p) => n + p.rawBytes, 0), 'the header totals its pages');
    });

    it('a read decodes only the pages its window touches, across a page boundary', async () => {
      const items = records(9, 100_000);
      const { id } = await putOk({ items });

      // Poison every page the window [1, 3) does not touch. A read that decodes them fails; one that decodes
      // only what it returns cannot notice. This is the behaviour a paged store exists for.
      const res = await pages().updateMany({ spillId: id, index: { $gte: 4 } },
        { $set: { body: Buffer.from('this is not gzip') } });
      assert.ok(res.modifiedCount >= 2, 'the poison must reach the pages past the window, or it proves nothing');

      const page = await read(id, TOKEN_A, { skip: 1, maxBytes: Math.floor(rawBytes(items[0]) * 2.5) });
      assert.equal(page.status, 200, JSON.stringify(page).slice(0, 300));
      assert.deepEqual(page.items.map(r => r._id), ['rec-1', 'rec-2'],
        'the window starts mid-page and ends on the next one');
      assert.deepEqual(page.items, items.slice(1, 3));
      assert.equal(page.nextSkip, 3, 'nextSkip is absolute, not page-relative');
      assert.equal(page.truncated, true);
      assert.equal(page.total, items.length, 'total is the whole spill, not the window');
    });

    it('the last window says there is no more', async () => {
      const items = records(5, 100_000);
      const { id } = await putOk({ items });
      const page = await read(id);
      assert.equal(page.status, 200);
      assert.deepEqual(page.items, items);
      assert.equal(page.truncated, false);
      assert.equal(page.nextSkip, undefined, 'a complete answer carries no continuation');
    });
  });

  describe('a reader never sees a partial spill, and the space is never written', () => {
    /** Record every write the driver is asked to make, by collection, in order. The server's OWN driver. */
    async function recordingWrites(fn) {
      const require = createRequire(path.resolve('server/package.json'));
      const { Collection } = require('mongodb');
      const writes = [];
      const originals = {};
      for (const m of MUTATORS) {
        originals[m] = Collection.prototype[m];
        Collection.prototype[m] = function (...args) {
          writes.push({ coll: this.collectionName, op: m });
          return originals[m].apply(this, args);
        };
      }
      try { await fn(); } finally {
        for (const m of MUTATORS) Collection.prototype[m] = originals[m];
      }
      return writes;
    }

    it('every page is written before the header', async () => {
      // Several pages, and under the 1 MB share so the put is not refused before it writes anything.
      const writes = await recordingWrites(() => putOk({ items: records(12, 60_000) }));
      const firstHeader = writes.findIndex(w => w.coll === HEADERS);
      const lastPage = writes.map(w => w.coll).lastIndexOf(PAGES);
      assert.ok(firstHeader > -1, `no header write recorded: ${JSON.stringify(writes)}`);
      assert.ok(lastPage > -1, `no page write recorded: ${JSON.stringify(writes)}`);
      assert.ok(lastPage < firstHeader,
        `a header was written before its last page (${JSON.stringify(writes)}) — a reader in between sees a `
        + 'spill whose pages are not all there');
    });

    it('a put writes the two store collections and nothing else', async () => {
      const writes = await recordingWrites(() => putOk({
        items: [record(1, 'alpha'), record(2, 'beta')],
      }));
      const elsewhere = writes.filter(w => w.coll !== HEADERS && w.coll !== PAGES);
      assert.deepEqual(elsewhere, [],
        'a read wrote outside the spill store — a space collection, a seq, an embed job — which is the defect');
    });
  });

  describe('who a spill belongs to', () => {
    it('no issuer, no spill: null and undefined both refuse, and nothing is stored', async () => {
      for (const issuedTo of [null, undefined, '']) {
        const r = await store.putSpill({ kind: 'results', issuedTo, request: {}, items: [record(1)] });
        assert.ok(r && typeof r.refused === 'string' && r.refused.length > 0,
          `issuedTo=${JSON.stringify(issuedTo)}: expected a refusal with a reason, got ${JSON.stringify(r)}`);
        await assertNothingStored(`issuedTo=${JSON.stringify(issuedTo)}`);
      }
    });

    it('an item without a spaceId refuses the spill, on both kinds, and so does an empty set', async () => {
      const cases = {
        'a result without spaceId': { kind: 'results', items: [record(1), { _id: 'x', name: 'orphan' }] },
        'a graph node without spaceId': {
          kind: 'graph',
          items: [{ id: 'n1', spaceId: 'general', depth: 1, record: {} }, { id: 'n2', depth: 2, record: {} }],
        },
        'no items at all': { kind: 'results', items: [] },
      };
      for (const [label, over] of Object.entries(cases)) {
        const r = await store.putSpill({ issuedTo: TOKEN_A, request: {}, ...over });
        assert.ok(r && typeof r.refused === 'string' && r.refused.length > 0,
          `${label}: a spill whose member spaces cannot be named must be refused, got ${JSON.stringify(r)}`);
        await assertNothingStored(label);
      }
    });

    it('its member spaces are derived from its items, never taken from the caller', async () => {
      const results = await putOk({
        items: [record(1, 'alpha'), record(2, 'beta'), record(3, 'alpha')],
        memberSpaceIds: ['general'],
      });
      const graph = await putOk({
        kind: 'graph',
        items: [
          { id: 'n1', spaceId: 'beta', depth: 1, via: { edgeId: 'e1', from: 's' }, record: { name: 'x' } },
          { id: 'n2', spaceId: 'general', depth: 2, via: { edgeId: 'e2', from: 'n1' }, record: { name: 'y' } },
        ],
        memberSpaceIds: ['alpha'],
      });
      const r = await headers().findOne({ _id: results.id });
      const g = await headers().findOne({ _id: graph.id });
      assert.deepEqual([...r.memberSpaceIds].sort(), ['alpha', 'beta'],
        'a caller-supplied list is ignored: the read check has to cover every space whose records are inside');
      assert.deepEqual([...g.memberSpaceIds].sort(), ['beta', 'general'], 'and every graph node counts');
      assert.equal(r.issuedTo, TOKEN_A);
    });

    it('another token, an unknown id and an expired spill all get the same 404', async () => {
      const { id } = await putOk({ items: [record(1)] });
      assert.equal((await read(id)).status, 200, 'the owner reads it');

      const other = await read(id, TOKEN_B);
      const unknown = await read(randomUUID(), TOKEN_A);
      await headers().updateOne({ _id: id }, { $set: { expiresAt: new Date(Date.now() - 60_000) } });
      const expired = await read(id, TOKEN_A);

      for (const [label, r] of [['another token', other], ['an unknown id', unknown], ['expired', expired]]) {
        assert.equal(r.status, 404, `${label}: ${JSON.stringify(r)}`);
      }
      // UNIFORM: a 403 for "exists but not yours" would let any token probe for other callers' spills.
      assert.deepEqual(other, unknown, 'another token must not be able to tell a spill exists');
      assert.deepEqual(expired, unknown, 'and an expired spill reads exactly like one that never was');
      assert.ok(!JSON.stringify(other).includes(TOKEN_A), 'a refusal never names the owner');
    });
  });

  describe('lifetime', () => {
    it('expiresAt is a BSON Date, SPILL_TTL_DAYS out, on the header and on every page', async () => {
      const before = Date.now();
      const { id } = await putOk({ items: records(4, 100_000) });
      const h = await headers().findOne({ _id: id });
      assert.ok(h.expiresAt instanceof Date,
        `expiresAt is ${typeof h.expiresAt}: a TTL index only ever deletes a BSON Date, so a string lives for ever`);
      const want = before + SPILL_TTL_DAYS * DAY_MS;
      assert.ok(Math.abs(h.expiresAt.getTime() - want) < 60_000, `expires ${h.expiresAt.toISOString()}`);
      for (const p of await pages().find({ spillId: id }).toArray()) {
        assert.ok(p.expiresAt instanceof Date, 'a page carries its own TTL, so an orphaned page still goes');
        assert.equal(p.expiresAt.getTime(), h.expiresAt.getTime());
      }
    });

    it('ensureReadSpillIndexes creates both TTL indexes and the lookups, and is idempotent', async () => {
      await mongo.getDb().dropCollection(HEADERS).catch(() => {});
      await mongo.getDb().dropCollection(PAGES).catch(() => {});
      await store.ensureReadSpillIndexes();
      await store.ensureReadSpillIndexes();

      const keyOf = (ix) => JSON.stringify(ix.key);
      const h = await headers().indexes();
      const p = await pages().indexes();
      const find = (list, key) => list.find(ix => keyOf(ix) === JSON.stringify(key));

      assert.equal(find(h, { expiresAt: 1 })?.expireAfterSeconds, 0, `headers: ${JSON.stringify(h)}`);
      assert.equal(find(p, { expiresAt: 1 })?.expireAfterSeconds, 0, `pages: ${JSON.stringify(p)}`);
      assert.ok(find(h, { issuedTo: 1, createdAt: 1 }), 'the per-token share is summed from an index');
      assert.ok(find(h, { memberSpaceIds: 1 }), 'drop/rename by space is an index lookup');
      assert.equal(find(p, { spillId: 1, index: 1 })?.unique, true, 'a page is unique per spill and position');
    });

    it('an existing TTL index with another lifetime is corrected, whatever it was named', async () => {
      await mongo.getDb().dropCollection(HEADERS).catch(() => {});
      await headers().createIndex({ expiresAt: 1 }, { expireAfterSeconds: 3600 });
      await store.ensureReadSpillIndexes();
      const ttl = (await headers().indexes()).find(ix => JSON.stringify(ix.key) === '{"expiresAt":1}');
      assert.equal(ttl?.expireAfterSeconds, 0,
        'createIndex refuses a changed option, so without the collMod fallback the old lifetime stays');
    });

    it('bootstrap ensures the indexes', () => {
      const boot = stripComments(fs.readFileSync('server/src/bootstrap.ts', 'utf8'));
      assert.match(boot, /ensureReadSpillIndexes\(\)/,
        'an index nothing creates at boot exists only on instances where a test made it');
    });
  });

  describe('caps: a token pays for its own spills, never for somebody else\'s', () => {
    it('past its byte share a token evicts its OWN oldest spill, which then answers 410 to it alone', async () => {
      const theirs = await putOk({ issuedTo: TOKEN_B, items: records(1, 400_000) });
      await tick();
      const first = await putOk({ items: records(1, 400_000) });
      await tick();
      const second = await putOk({ items: records(1, 400_000) });
      await tick();
      const third = await putOk({ items: records(1, 400_000) });   // 1.2 MB against a 1 MB share

      assert.equal((await read(first.id)).status, 410, 'the owner learns its spill was evicted');
      assert.equal((await read(first.id, TOKEN_B)).status, 404, 'nobody else learns it existed');
      assert.equal(await pages().countDocuments({ spillId: first.id }), 0, 'eviction frees the pages');
      assert.equal((await read(second.id)).status, 200);
      assert.equal((await read(third.id)).status, 200);
      assert.equal((await read(theirs.id, TOKEN_B)).status, 200, "another token's spill is never evicted");
    });

    it('past its count share a token evicts its own oldest', async () => {
      const ids = [];
      for (let i = 0; i < 4; i++) { ids.push((await putOk({ items: [record(i)] })).id); await tick(); }
      assert.equal((await read(ids[0])).status, 410, 'the fourth spill against a count of three evicts the first');
      for (const id of ids.slice(1)) assert.equal((await read(id)).status, 200);
    });

    it('a single spill larger than the share is refused with the reason, and evicts nothing to make room', async () => {
      const kept = await putOk({ items: [record(1)] });
      const r = await put({ items: records(3, 400_000) });
      assert.ok(r && typeof r.refused === 'string', `expected a refusal, got ${JSON.stringify(r)?.slice(0, 200)}`);
      assert.match(r.refused, /share|READ_SPILL_TOKEN_MAX_MB/i, 'the reason names the share it exceeded');
      assert.equal(await headers().countDocuments({ _id: { $ne: kept.id } }), 0, 'no header for the refused spill');
      assert.equal(await pages().countDocuments({ spillId: { $ne: kept.id } }), 0,
        'and no pages: the refusal comes before the cost');
      assert.equal((await read(kept.id)).status, 200, 'a refused spill must not evict the token\'s others');
    });

    it('the instance ceiling refuses the new spill and never evicts another caller\'s', async () => {
      const b = await putOk({ issuedTo: TOKEN_B, items: records(1, 800_000) });
      const c = await putOk({ issuedTo: 'tok-cccc', items: records(1, 800_000) });
      const r = await put({ issuedTo: 'tok-dddd', items: records(1, 800_000) });   // 2.4 MB against 2 MB
      assert.ok(r && typeof r.refused === 'string', `expected a refusal, got ${JSON.stringify(r)?.slice(0, 200)}`);
      assert.match(r.refused, /ceiling|instance|READ_SPILL_INSTANCE_MAX_MB/i, 'the reason names the ceiling');
      assert.equal((await read(b.id, TOKEN_B)).status, 200, 'the ceiling never evicts another token\'s spill');
      assert.equal((await read(c.id, 'tok-cccc')).status, 200);
      assert.equal(await headers().countDocuments({ issuedTo: 'tok-dddd' }), 0);
    });
  });

  describe('a spill follows its spaces', () => {
    it('dropSpillsForSpace removes every spill holding that space\'s records, pages included', async () => {
      const onlyAlpha = await putOk({ items: [record(1, 'alpha')] });
      const mixed = await putOk({ items: [record(2, 'alpha'), record(3, 'beta')] });
      const onlyBeta = await putOk({ items: [record(4, 'beta')] });

      await store.dropSpillsForSpace('alpha');

      for (const gone of [onlyAlpha, mixed]) {
        assert.equal(await headers().countDocuments({ _id: gone.id }), 0, 'a deleted space leaves no spill of it');
        assert.equal(await pages().countDocuments({ spillId: gone.id }), 0, 'nor any page');
      }
      assert.equal((await read(onlyBeta.id)).status, 200, 'a spill of another space is untouched');
    });

    it('renameSpillsForSpace moves the member id, and the owner still reads it', async () => {
      const onlyAlpha = await putOk({ items: [record(1, 'alpha')] });
      const mixed = await putOk({ items: [record(2, 'alpha'), record(3, 'beta')] });

      await store.renameSpillsForSpace('alpha', 'omega');

      assert.deepEqual((await headers().findOne({ _id: onlyAlpha.id })).memberSpaceIds, ['omega']);
      assert.deepEqual([...(await headers().findOne({ _id: mixed.id })).memberSpaceIds].sort(), ['beta', 'omega']);
      assert.equal(await headers().countDocuments({ memberSpaceIds: 'alpha' }), 0, 'the old id is gone everywhere');
      assert.equal((await read(mixed.id)).status, 200);
    });
  });

  describe('vectors never reach the store', () => {
    it('every vector key is stripped at every depth, faceEmbedding included', async () => {
      const { id } = await putOk({
        items: [{
          _id: 'v1', spaceId: 'general', name: 'keep me',
          embedding: [1, 2], faceEmbedding: [3], contentEmbedding: [4],
          _graph: [{ record: { vector: [5], embeddings: [[6]], faceEmbedding: [7], ok: 1 } }],
        }],
      });
      const stored = JSON.stringify((await pages().find({ spillId: id }).toArray()).map(decode));
      for (const key of ['embedding', 'faceEmbedding', 'contentEmbedding', 'vector', 'embeddings']) {
        assert.ok(!stored.includes(`"${key}"`), `\`${key}\` reached a stored page: ${stored}`);
      }
      const page = await read(id);
      assert.equal(page.items[0].name, 'keep me', 'and everything else survives');
      assert.equal(page.items[0]._graph[0].record.ok, 1);
    });
  });
});
