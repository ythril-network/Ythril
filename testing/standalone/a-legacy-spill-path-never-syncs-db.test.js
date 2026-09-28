/**
 * A legacy spill under a space's root `_tmp/` is never offered to a peer and never counted in the space hash.
 *
 * ## Why (Q-92, design point 8)
 *
 * Until this release a recall's remainder and an over-cap traversal were written into the space as
 * `_tmp/results-<uuid>.json` and `_tmp/graph-<uuid>.json`. `_tmp` was hidden from BROWSING only: the file
 * manifest walks every file, so a spill replicated to every peer, carrying one caller's search result to
 * instances that caller never addressed. Spills now live in an instance store (`brain/read-spill-store.ts`);
 * what is left is the files older versions wrote, and the ones older PEERS still send.
 *
 * So sync stops carrying the shape in both directions, and two of those places are here:
 *
 * - **the manifest** (`files/manifest.ts`), which is what a peer diffs against to decide what to pull, and
 * - **the Merkle root** (`brain/merkle.ts`), which hashes both the manifest AND the `<space>_files` records. If
 *   either still counted a spill, two instances where one had swept its legacy spills and the other had not
 *   would report `MERKLE_DIVERGENCE` every cycle over a file nobody should have — the false alarm that
 *   teaches an operator to ignore the one signal that means data really is missing.
 *
 * **Only the ROOT tree, and only the spill shape.** `notes/_tmp/graph-….json` is a user's own folder, exactly
 * as `isSpillPath` and `hideDerivedTrees` already treat it, and it must still sync.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/a-legacy-spill-path-never-syncs-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-spill-sync-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = tmpDir;

const SPACE = 'general';
const ROOT = path.join(tmpDir, 'files', SPACE);

const GRAPH_SPILL = `_tmp/graph-${randomUUID()}.json`;
const RESULT_SPILL = `_tmp/results-${randomUUID()}.json`;
const USERS_OWN = `notes/_tmp/graph-${randomUUID()}.json`;
const NOTE = 'notes/a.md';

let mongo, manifestMod, merkleMod;

const put = (rel, body) => {
  const abs = path.join(ROOT, ...rel.split('/'));
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, body);
};
const meta = (rel, over = {}) => ({
  _id: rel, spaceId: SPACE, path: rel, description: '', tags: [],
  author: { instanceId: 'me', instanceLabel: 'Me' },
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', seq: 1, ...over,
});

describe('a legacy spill path never syncs', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('spillsync');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'spill-sync-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    const loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    manifestMod = await import('../../server/dist/files/manifest.js');
    merkleMod = await import('../../server/dist/brain/merkle.js');
  });

  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  beforeEach(async () => {
    fs.rmSync(ROOT, { recursive: true, force: true });
    await mongo.col(`${SPACE}_files`).deleteMany({});
    await mongo.col(`${SPACE}_fileHashes`).deleteMany({});
    put(NOTE, 'a real note');
    put(USERS_OWN, '{"mine":true}');
    await mongo.col(`${SPACE}_files`).insertMany([meta(NOTE), meta(USERS_OWN)]);
  });

  it('the manifest omits root spill files and keeps a user\'s own _tmp folder', async () => {
    put(GRAPH_SPILL, '{"kind":"graph-traversal"}');
    put(RESULT_SPILL, '{"kind":"recall-results"}');
    const paths = (await manifestMod.buildFileManifest(SPACE)).map(e => e.path).sort();

    assert.ok(paths.includes(NOTE), `the scan must still see ordinary files: ${paths.join(', ')}`);
    assert.ok(paths.includes(USERS_OWN), 'a `_tmp` folder below the root is the user\'s and syncs like any other');
    for (const spill of [GRAPH_SPILL, RESULT_SPILL]) {
      assert.ok(!paths.includes(spill), `the manifest offers \`${spill}\` to every peer`);
    }
  });

  it('the Merkle root is the same with and without legacy spills, blob and record alike', async () => {
    const clean = (await merkleMod.computeMerkleRoot(SPACE)).root;

    put(GRAPH_SPILL, '{"kind":"graph-traversal"}');
    put(RESULT_SPILL, '{"kind":"recall-results"}');
    await mongo.col(`${SPACE}_files`).insertMany([
      meta(GRAPH_SPILL, { tags: ['graph-spill'], _expireAt: new Date(Date.now() + 86_400_000) }),
      meta(RESULT_SPILL, { tags: ['result-spill'], _expireAt: new Date(Date.now() + 86_400_000) }),
    ]);
    const withSpills = (await merkleMod.computeMerkleRoot(SPACE)).root;
    assert.equal(withSpills, clean,
      'a legacy spill moved the space hash, so an instance that swept its spills diverges from one that has not');

    // Sensitivity: the same comparison must move for a real file, or "equal" above proves nothing.
    put('notes/b.md', 'another note');
    await mongo.col(`${SPACE}_files`).insertOne(meta('notes/b.md'));
    assert.notEqual((await merkleMod.computeMerkleRoot(SPACE)).root, clean, 'a real file must change the root');
  });
});
