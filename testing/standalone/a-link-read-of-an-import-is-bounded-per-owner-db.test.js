/**
 * An owner holding more link rows than the bound cannot crowd another owner's rows out of a chunk's read (bundle-270 review U2).
 *
 * ## The doubt
 *
 * `ReadSet.load` reads the stored link rows of a chunk of owners in one query with one unsorted limit for the whole chunk (owners x the per-class
 * cap x the classes). Each owner is meant to hold at most that many rows, but synced rows are not held to the cap, and one owner over it could
 * fill the limit and push another owner's rows out: `storedLinks` of the other owner then under-reports, and a converge built on the union of
 * stored and stated links takes the missing ones away (amendment A4).
 *
 * ## What it holds
 *
 * With one owner whose rows alone exceed the chunk's limit and another owner under the cap, loaded together:
 *  - the owner under the cap reports every row it holds;
 *  - the owner over the cap is never reported as holding fewer links than it has: reading its links is refused in words (a caller that must
 *    take nothing away cannot take a union of a partial set).
 *
 * Run: in-docker.sh --own-db node --test testing/standalone/a-link-read-of-an-import-is-bounded-per-owner-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-link-read-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;

const SPACE = 'general';
const GREEDY = '11111111-1111-4111-8111-111111111111';
const MODEST = '22222222-2222-4222-8222-222222222222';

let mongo, ReadSet, MAX_LINKS_PER_KIND, REF_KINDS;

describe('the link read of an import is bounded per owner', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('linkread');
    const loader = await import('../../server/dist/config/loader.js');
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'link-read-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [], meta: {} }],
    }, null, 2), { mode: 0o600 });
    loader.loadConfig();
    ({ ReadSet } = await import('../../server/dist/brain/write-plan/read-set.js'));
    ({ MAX_LINKS_PER_KIND } = await import('../../server/dist/util/request-bounds.js'));
    ({ REF_KINDS } = await import('../../server/dist/config/types-knowledge.js'));
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  const row = (from, k) => ({ _id: `${from}-${k}`, spaceId: SPACE, from, fromKind: 'fact', to: `target-${k}`, toKind: 'entity' });

  it('one owner over the cap and one under it: the one under reports all its rows, the one over is refused and never under-reported', async () => {
    // The chunk's limit is owners x cap x classes: the greedy owner alone has more rows than that.
    const limit = 2 * MAX_LINKS_PER_KIND * REF_KINDS.length;
    const links = mongo.col(`${SPACE}_links`);
    await links.deleteMany({});
    await links.insertMany(Array.from({ length: limit + 50 }, (_, k) => row(GREEDY, k)));
    await links.insertMany(Array.from({ length: 7 }, (_, k) => row(MODEST, k)));

    const view = new ReadSet(SPACE);
    await view.load({ links: [{ fromKind: 'fact', id: GREEDY }, { fromKind: 'fact', id: MODEST }] });

    assert.deepEqual([...(view.storedLinks('fact', MODEST).entity ?? [])].sort(), Array.from({ length: 7 }, (_, k) => `target-${k}`).sort(),
      'the owner under the cap was crowded out of the read: a converge would take its links away');
    assert.throws(() => view.storedLinks('fact', GREEDY), /more links|bound/i,
      'the owner over the cap was answered with a partial set of its links instead of being refused');
  });

  it('an owner at the cap is read whole (the bound is the cap, not one under it)', async () => {
    const links = mongo.col(`${SPACE}_links`);
    await links.deleteMany({});
    await links.insertMany(Array.from({ length: MAX_LINKS_PER_KIND }, (_, k) => row(GREEDY, k)));
    const view = new ReadSet(SPACE);
    await view.load({ links: [{ fromKind: 'fact', id: GREEDY }] });
    assert.equal((view.storedLinks('fact', GREEDY).entity ?? []).length, MAX_LINKS_PER_KIND);
  });
});
