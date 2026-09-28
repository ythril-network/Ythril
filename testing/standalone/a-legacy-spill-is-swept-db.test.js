/**
 * The spills older versions wrote INTO a space are swept locally, and nothing else is touched.
 *
 * ## Why (Q-92, design point 8)
 *
 * Before 5.5.3 a recall's remainder and an over-cap traversal were written as root `_tmp/results-<uuid>.json` and
 * `_tmp/graph-<uuid>.json`, with a `<space>_files` record. They replicated, and a pulled copy never expired
 * (`_expireAt` is local-only). Sync now carries the shape in neither direction, so what is left is local: the
 * sweep deletes it.
 *
 * - **By PATH, not by tag.** Metadata can arrive before its blob, and a blob can outlive its record, so a sweep
 *   keyed on the FileMeta tag leaves one half behind and finds it again for ever.
 * - **Hard, with no tombstone and no webhook.** No transport carries the path any more, so a tombstone would be
 *   a deletion notice for something no peer is sent; and a burst of unattributed `file.deleted` webhooks on
 *   upgrade would tell consumers a person deleted files.
 * - **Only the root shape.** `notes/_tmp/graph-….json` is a user's own folder and stays.
 * - **Recurring, inside the hourly TTL sweep**, because older peers keep sending spills until they upgrade —
 *   a boot-once sweep would leave every one that arrived after it.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-legacy-spill-is-swept-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { stripComments } from './_strip-comments.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-spill-sweep-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const SPACE = 'general';
const ROOT = path.join(tmpDir, 'files', SPACE);

const BOTH = `_tmp/graph-${randomUUID()}.json`;          // blob and FileMeta
const BLOB_ONLY = `_tmp/results-${randomUUID()}.json`;   // a blob whose record is gone
const META_ONLY = `_tmp/graph-${randomUUID()}.json`;     // a record whose blob never arrived
const USERS_OWN = `notes/_tmp/graph-${randomUUID()}.json`;
const NOTE = 'notes/a.md';
const NOT_A_SPILL = '_tmp/scratch.json';                 // a root _tmp file that is not the spill shape

let mongo, sweepMod;

const abs = (rel) => path.join(ROOT, ...rel.split('/'));
const put = (rel, body) => { fs.mkdirSync(path.dirname(abs(rel)), { recursive: true }); fs.writeFileSync(abs(rel), body); };
const meta = (rel) => ({
  _id: rel, spaceId: SPACE, path: rel, description: '', tags: [rel.startsWith('_tmp/graph') ? 'graph-spill' : 'result-spill'],
  author: { instanceId: 'old-peer', instanceLabel: 'Old' },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: 1,
});

describe('legacy read spills are swept from the space', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('spillsweep');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'spill-sweep-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    sweepMod = await import('../../server/dist/files/legacy-spill-sweep.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    for (const c of ['files', 'fileTombstones']) await mongo.col(`${SPACE}_${c}`).deleteMany({});
    put(BOTH, '{"kind":"graph-traversal"}');
    put(BLOB_ONLY, '{"kind":"recall-results"}');
    put(USERS_OWN, '{"mine":true}');
    put(NOTE, 'a real note');
    put(NOT_A_SPILL, '{}');
    await mongo.col(`${SPACE}_files`).insertMany([meta(BOTH), meta(META_ONLY), meta(USERS_OWN), meta(NOTE), meta(NOT_A_SPILL)]);
  });

  it('removes every half of every spill, by path, and nothing else', async () => {
    const res = await sweepMod.sweepLegacySpills();
    for (const rel of [BOTH, BLOB_ONLY]) assert.equal(fs.existsSync(abs(rel)), false, `the blob ${rel} survived the sweep`);
    const ids = (await mongo.col(`${SPACE}_files`).find({}, { projection: { _id: 1 } }).toArray()).map(d => d._id).sort();
    assert.deepEqual(ids, [NOT_A_SPILL, NOTE, USERS_OWN].sort(),
      'the spill records are gone, a record without its blob included, and every other record is kept');
    for (const rel of [USERS_OWN, NOTE, NOT_A_SPILL]) assert.ok(fs.existsSync(abs(rel)), `${rel} is not a spill and must stay`);
    assert.equal(res.removed, 3, `three spills, counted once each whichever half was present: ${JSON.stringify(res)}`);
  });

  it('writes no tombstone, and a second run finds nothing', async () => {
    await sweepMod.sweepLegacySpills();
    assert.equal(await mongo.col(`${SPACE}_fileTombstones`).countDocuments({}), 0,
      'no transport carries the path any more, so a tombstone would announce a deletion nobody is sent');
    const again = await sweepMod.sweepLegacySpills();
    assert.equal(again.removed, 0, 'idempotent: a spill once swept is not found again');
  });

  it('runs inside the hourly TTL sweep, not once at boot', () => {
    const src = stripComments(fs.readFileSync('server/src/brain/ttl-sweep.ts', 'utf8'));
    assert.match(src, /sweepLegacySpills\(/,
      'older peers keep sending spills until they upgrade, so a boot-once sweep leaves every later arrival');
  });
});
