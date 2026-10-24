/**
 * Database-level test: the brain list endpoints sort the FULL result set, not just a page.
 *
 * "created needs a sort option" (owner feedback) cannot be a client-only header click: the lists are
 * paginated (`limit`/`skip`), so sorting only the visible page would reorder ~20 rows and lie about
 * the rest. The fix is a Mongo `.sort()` applied BEFORE `.skip().limit()`, threaded from the route
 * into the list function. The thing that proves it works is exactly the thing a client-only sort
 * could never do: walk the pages of a sorted list across a page boundary and get one globally
 * ordered sequence back.
 *
 * A fixture/JS test could not prove this — the ordering has to be MongoDB's, applied to the real
 * `col()` cursor, or it proves nothing about the query that ships. So this runs against a real
 * server via the #371 harness.
 *
 * Run: `npm run test:up` first, then
 *      node --test testing/standalone/brain-list-sort-db.test.js
 */

import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const skip = await mongoSkipReason();

const SPACE = 'general';

/*
 * At file scope, and before any import of the loader: it reads `CONFIG_PATH` from the environment when it
 * is first asked for a config, so setting this inside `before()` is too late and it looks for one at the
 * drive root instead.
 */
const CONFIG_PATH = path.join(os.tmpdir(), `ythril-brainsort-${process.pid}.json`);
process.env['CONFIG_PATH'] = CONFIG_PATH;

let mongo;
let listEntities;
let listChrono;
let entities;
let chrono;

/** Insert a raw entity doc — bypassing upsert/embedding, which is the read/sort path under test. */
async function insertEntity(_id, name, type, createdAt, pos) {
  await entities.insertOne({ _id, spaceId: SPACE, name, type, createdAt, seq: 1, ...(pos === undefined ? {} : { pos, posAtSeq: 1 }) });
}

/** Walk every page of a sorted listEntities and concatenate — the full ordered set. */
async function walkEntityPages(sort, pageSize) {
  const ids = [];
  for (let skip = 0; ; skip += pageSize) {
    const page = await listEntities(SPACE, {}, pageSize, skip, sort);
    if (page.length === 0) break;
    ids.push(...page.map(e => String(e._id)));
    if (page.length < pageSize) break;
  }
  return ids;
}

describe('brain list sort — against a real MongoDB', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('brainsort');
    /*
     * Config, because `listChrono` reads the SPACE for what a passed due moment means (`F-26`) and
     * `getConfig` throws when nothing has been loaded.
     *
     * Loaded rather than defended against in the product: every production caller of `listChrono` has a
     * config, and making a read path tolerate its absence would swallow a real misconfiguration to suit a
     * test. The same idiom as `a-delete-refusal-names-the-end-it-checked-db.test.js`.
     */
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'brain-list-sort-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'General', builtIn: true, folders: [] }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ listEntities } = await import('../../server/dist/brain/entities.js'));
    ({ listChrono } = await import('../../server/dist/brain/chrono.js'));
    entities = mongo.col(`${SPACE}_entities`);
    chrono = mongo.col(`${SPACE}_chrono`);
  });

  after(async () => { await closeTestMongo(); });

  beforeEach(async () => {
    await entities.deleteMany({});
    await chrono.deleteMany({});
  });

  // Insertion order is deliberately NOT alphabetical and NOT createdAt order, so a page-only sort
  // (or no sort at all) is visibly distinguishable from a real full-set sort.
  // Each row also carries the position it LANDED at (bundle-81: `pos`), in an order that is neither insertion order nor createdAt order,
  // so a list that ignores landing order cannot pass by accident.
  async function seedFive() {
    await insertEntity('id-banana', 'banana', 'fruit', '2026-03-02T00:00:00.000Z', 3_000);
    await insertEntity('id-apple', 'apple', 'fruit', '2026-03-05T00:00:00.000Z', 1_000);
    await insertEntity('id-cherry', 'cherry', 'fruit', '2026-03-01T00:00:00.000Z', 5_000);
    await insertEntity('id-date', 'date', 'fruit', '2026-03-04T00:00:00.000Z', 2_000);
    await insertEntity('id-elder', 'elderberry', 'fruit', '2026-03-03T00:00:00.000Z', 4_000);
  }

  it('no sort answers LANDING order — the position each row landed at here, newest first, `_id` breaking a tie (bundle-81 decision 20)', async () => {
    await seedFive();
    const got = await listEntities(SPACE, {}, 50, 0);
    assert.deepEqual(
      got.map(e => String(e._id)),
      ['id-cherry', 'id-elder', 'id-banana', 'id-date', 'id-apple'],
      'without a sort arg the list must return rows by `pos` descending: what landed here most recently first, neither insertion order nor createdAt order',
    );
    assert.ok(got.every(e => !('pos' in e) || typeof e.pos === 'number'), 'the fixture lost its positions');
  });

  it('landing order breaks a tie in position by _id, descending, and puts a row with no position last', async () => {
    await insertEntity('id-a', 'a', 'x', '2026-04-01T00:00:00.000Z', 7_000);
    await insertEntity('id-b', 'b', 'x', '2026-04-02T00:00:00.000Z', 7_000);
    await insertEntity('id-none', 'none', 'x', '2026-04-03T00:00:00.000Z');
    const got = await listEntities(SPACE, {}, 50, 0);
    assert.deepEqual(got.map(e => String(e._id)), ['id-b', 'id-a', 'id-none']);
  });

  it('sorts by name asc across a PAGE BOUNDARY — the full set, not just the visible page', async () => {
    await seedFive();
    // Page size 2 over 5 docs → three pages. If the sort were applied only per-page, concatenating
    // the pages would NOT be globally alphabetical. It is, because the .sort() precedes skip/limit.
    const ids = await walkEntityPages({ field: 'name', dir: 1 }, 2);
    assert.deepEqual(ids, ['id-apple', 'id-banana', 'id-cherry', 'id-date', 'id-elder']);
  });

  it('sorts by createdAt desc across a page boundary (the "created" ask, newest first)', async () => {
    await seedFive();
    const ids = await walkEntityPages({ field: 'createdAt', dir: -1 }, 2);
    assert.deepEqual(ids, ['id-apple', 'id-date', 'id-elder', 'id-banana', 'id-cherry']);
  });

  it('sorts by createdAt asc across a page boundary (oldest first)', async () => {
    await seedFive();
    const ids = await walkEntityPages({ field: 'createdAt', dir: 1 }, 2);
    assert.deepEqual(ids, ['id-cherry', 'id-banana', 'id-elder', 'id-date', 'id-apple']);
  });

  it('breaks ties deterministically by _id so a page boundary never drops or duplicates a row', async () => {
    // All four share one createdAt: without the _id tiebreaker, the order within the tie is
    // unspecified and a row could shift between pages. The _id tiebreaker makes paging stable.
    const t = '2026-04-01T00:00:00.000Z';
    await insertEntity('id-04', 'd', 'x', t);
    await insertEntity('id-01', 'a', 'x', t);
    await insertEntity('id-03', 'c', 'x', t);
    await insertEntity('id-02', 'b', 'x', t);
    const ids = await walkEntityPages({ field: 'createdAt', dir: 1 }, 2);
    assert.deepEqual(ids, ['id-01', 'id-02', 'id-03', 'id-04'], 'tie order must follow _id asc');
  });

  it('listChrono: default order is LANDING order, not createdAt desc; an explicit title sort reorders', async () => {
    const mk = (id, title, createdAt, pos) => chrono.insertOne({
      _id: id, spaceId: SPACE, title, type: 'event', status: 'completed',
      startsAt: createdAt, tags: [], createdAt, seq: 1, pos, posAtSeq: 1,
    });
    await mk('c-mid', 'Middle', '2026-05-02T00:00:00.000Z', 200);
    await mk('c-new', 'Alpha', '2026-05-03T00:00:00.000Z', 100);
    await mk('c-old', 'Zeta', '2026-05-01T00:00:00.000Z', 300);

    const def = await listChrono(SPACE, {}, 50, 0);
    assert.deepEqual(def.map(e => String(e._id)), ['c-old', 'c-mid', 'c-new'],
      'default chrono order must be `pos` descending: the entry that landed last first, whatever its createdAt');

    const byTitle = await listChrono(SPACE, {}, 50, 0, { field: 'title', dir: 1 });
    assert.deepEqual(byTitle.map(e => String(e._id)), ['c-new', 'c-mid', 'c-old'],
      'title asc: Alpha, Middle, Zeta');
  });
});
