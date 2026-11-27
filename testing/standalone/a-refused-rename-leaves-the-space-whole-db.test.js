/**
 * A rename the store refused leaves the space whole under ONE name, or says what stays moved (Q-978).
 *
 * ## The finding
 *
 * `POST /api/space_rename` under an unsatisfiable write concern answered the store's refusal, and had moved the space's
 * collections first: its records sat under the new name, its files directory under the old one, its counter, change-feed
 * floor and scan cursors under either, and every document still carried the old `spaceId` (the repair of that field swallowed
 * its own failure). The answer said none of this. The owner had a broken space and nothing that showed it.
 *
 * ## What is asserted
 *
 * A write is failed at each step of the rename that can refuse it: one collection's move (the last one, with the others
 * already moved), the `spaceId` rewrite, the counter document, the change-feed floor, the reindex run, the files directory
 * (a non-empty directory under the new name, which the rename never overwrites) and the config commit that ends the rename.
 * After the refusal:
 *
 * - every collection of the space sits under the old name and none under the new one; the files directory, the counter, the
 *   floor and the scan cursors too, and every document carries the old `spaceId`; the config still names the old id;
 * - what stood under the new name before the rename (the directory above) is not touched by the move back;
 * - the answer is the one the failure had before (503 retryable for a store failure, in our words), and the fault fired;
 * - the same rename, repeated once the fault is lifted, completes and leaves everything under the new name.
 *
 * And when the move back is itself refused, the answer names the collection that stays under the new name and says to repeat
 * the rename, which then completes.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-refused-rename-leaves-the-space-whole-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { failWrites } from './_write-faults.mjs';
import { logLinesDuring } from './_log-lines.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const requireFromServer = createRequire(path.resolve('server/package.json'));
const { MongoNetworkError } = requireFromServer('mongodb');

const ADDRESS = '172.16.0.9';
const failure = (token) => new MongoNetworkError(`connection 5 to ${ADDRESS}:27017 closed (${token}): namespace already exists, record not found`);
const LEAK = new RegExp(`${ADDRESS.replace(/\./g, '\\.')}|27017|namespace already exists`);

const COUNTERS = 'ythril_counters';
const FLOORS = 'ythril_file_feed_floors';
const CURSORS = 'ythril_dupe_scan_state';
const ACTIVITY = 'space_activity';
const FILE = 'probe.txt';

/** One space per case: a refused rename leaves its mark on the space, and the next case must not read it. */
const CASES = ['collection', 'repair', 'counter', 'floor', 'reindex', 'tree', 'commit', 'undo', 'split', 'mcp'];
const idOf = (c) => `rf-${c}`;

let door, faults, base, adminKey, callTool, ADMIN, server, getConfig, mutateConfig, db;

async function rest(method, url, body) {
  const init = { method, headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${base}${url}`, init);
  const raw = await r.text();
  let json = null; try { json = JSON.parse(raw); } catch { /* not JSON */ }
  return { status: r.status, retryable: json?.retryable, raw, json };
}

async function mcp(tool, args) {
  const out = await callTool({ name: tool, args,
    caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 't', tokenLabel: 't' } });
  const text = (out.result.content ?? []).map(c => c.text ?? '').join('\n');
  const sc = out.result.structuredContent ?? {};
  return { status: out.result.isError ? out.status : 200, retryable: sc.retryable, raw: `${text}\n${JSON.stringify(sc)}` };
}

const underPrefix = async (p) => (await db.listCollections({}, { nameOnly: true }).toArray())
  .map(c => c.name).filter(n => n.startsWith(`${p}_`)).map(n => n.slice(p.length + 1)).sort();
const dirOf = (id) => path.join(process.env['DATA_ROOT'], 'files', id);

/** What the space holds, planted so that every step of the rename has something to move. */
async function seed(id) {
  await db.collection(`${id}_facts`).insertOne(build.fact(id, randomUUID(), 1));
  await db.collection(`${id}_files`).insertOne({ _id: FILE, spaceId: id, path: FILE, sizeBytes: 5, tags: [], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' });
  await db.collection(`${id}_reindex_run`).insertOne({ _id: 'run', members: [id] });
  fs.mkdirSync(dirOf(id), { recursive: true });
  fs.writeFileSync(path.join(dirOf(id), FILE), 'probe');
  await db.collection(COUNTERS).replaceOne({ _id: id }, { _id: id, seq: 7 }, { upsert: true });
  await db.collection(FLOORS).replaceOne({ _id: id }, { _id: id, floor: 3 }, { upsert: true });
  await db.collection(CURSORS).replaceOne({ _id: `${id}:facts` }, { _id: `${id}:facts`, cursor: 'c' }, { upsert: true });
  await db.collection(ACTIVITY).replaceOne({ _id: `${id}:2026-01-01T00` }, { _id: `${id}:2026-01-01T00`, space: id, bucket: '2026-01-01T00', bucketAt: new Date(), calls: {} }, { upsert: true });
}

/** Where each part of the space is under a name, for the old and the new one. */
async function whereIs(id, other) {
  const at = async (p) => ({
    collections: await underPrefix(p),
    dir: fs.existsSync(path.join(dirOf(p), FILE)),
    counter: !!(await db.collection(COUNTERS).findOne({ _id: p })),
    floor: !!(await db.collection(FLOORS).findOne({ _id: p })),
    cursor: !!(await db.collection(CURSORS).findOne({ _id: `${p}:facts` })),
    run: (await db.collection(`${p}_reindex_run`).findOne({ _id: 'run' }))?.members ?? null,
    factSpaceIds: (await db.collection(`${p}_facts`).find({}).toArray()).map(d => d.spaceId),
  });
  return { [id]: await at(id), [other]: await at(other), configIds: getConfig().spaces.map(s => s.id).filter(s => s === id || s === other) };
}

/** The whole space under `home`, nothing of it under `away`. */
function assertWhole(label, w, { home, away, collections }) {
  assert.deepEqual(w[home].collections, collections, `${label}: the collections of the space under '${home}' are not all there: ${JSON.stringify(w[home].collections)}`);
  assert.deepEqual(w[away].collections.filter(c => collections.includes(c)), [], `${label}: collections of the space stay under '${away}': ${JSON.stringify(w[away].collections)}`);
  assert.equal(w[home].dir, true, `${label}: the file is not under '${home}'`);
  assert.equal(w[away].dir, false, `${label}: the file is under '${away}'`);
  for (const k of ['counter', 'floor', 'cursor']) {
    assert.equal(w[home][k], true, `${label}: the ${k} is not under '${home}'`);
    assert.equal(w[away][k], false, `${label}: the ${k} is under '${away}'`);
  }
  assert.deepEqual(w[home].run, [home], `${label}: the reindex run does not name '${home}': ${JSON.stringify(w[home].run)}`);
  assert.ok(w[home].factSpaceIds.length > 0 && w[home].factSpaceIds.every(s => s === home), `${label}: documents under '${home}' carry ${JSON.stringify(w[home].factSpaceIds)}`);
  assert.deepEqual(w.configIds, [home], `${label}: the config names ${JSON.stringify(w.configIds)}, not '${home}'`);
}

describe('a refused rename leaves the space whole', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'rfwhole',
      spaces: CASES.map(c => ({ id: idOf(c), label: idOf(c), folders: [], meta: { suppressEmbeddings: true } })) });
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ getConfig, mutateConfig } = await import('../../server/dist/config/loader.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
    base = server.url;
    db = door.mongo.getDb();
    faults = failWrites(Object.getPrototypeOf(door.mongo.col('probe')),
      ['rename', 'updateMany', 'updateOne', 'replaceOne', 'insertOne', 'bulkWrite']);
  });
  after(async () => {
    faults?.restore();
    await server?.close();
    await door?.close();
  });
  beforeEach(() => {
    faults.clear();
    // What the case before left (an owed rename, its marker) is not this case's subject: a rename that meets another's marker
    // finishes that one first, and would answer for it.
    if (getConfig().pendingSpaceActs || getConfig().pendingSpaceOp) mutateConfig(cfg => { delete cfg.pendingSpaceActs; delete cfg.pendingSpaceOp; });
  });

  /** Seed `c`, let `plant(newId, collections, token)` arm its fault, ask for the rename, and return the answer with where the space is after it. */
  async function refused(c, plant, { via = 'REST' } = {}) {
    const id = idOf(c);
    const newId = `${id}-moved`;
    await seed(id);
    const collections = await underPrefix(id);
    assert.ok(collections.length >= 2, `${id} has ${collections.length} collections: a rename of one proves nothing about the others`);
    const token = `fired-${randomUUID()}`;
    plant(newId, collections, token);
    const ask = () => (via === 'REST' ? rest('PATCH', `/api/spaces/${id}/rename`, { newId }) : mcp('space_rename', { space: id, newId }));
    const { result: a } = await logLinesDuring(ask);
    return { id, newId, collections, ask, a, where: await whereIs(id, newId) };
  }

  /** The fault was reached, and the answer is the store failure's in our words. */
  function assertStoreAnswer(label, r, armed) {
    assert.ok(armed.some(([m, n]) => faults.fired(m, n) > 0), `${label}: no armed fault fired (${armed.map(a => a.join(' ')).join(', ')}) — the rename never reached the failing step`);
    assert.equal(r.a.status, 503, `${label}: answered ${r.a.status}, not 503: ${r.a.raw}`);
    assert.equal(r.a.retryable, true, `${label}: not retryable: ${r.a.raw}`);
    assert.ok(!LEAK.test(r.a.raw), `${label}: the answer holds the driver's text: ${r.a.raw}`);
  }

  /** The same rename, asked again with no fault, completes and leaves everything under the new name. */
  async function assertRetryCompletes(label, r) {
    faults.clear();
    const retry = await r.ask();
    assert.equal(retry.status, 200, `${label}: the retry did not complete the rename: ${retry.raw}`);
    assertWhole(`${label} after the retry`, await whereIs(r.id, r.newId), { home: r.newId, away: r.id, collections: r.collections });
  }

  const storeCases = [
    ['collection', 'the last collection of the space refuses its move, the others already moved', (newId, cols, token) => {
      const name = `${idOf('collection')}_${cols[cols.length - 1]}`;
      faults.fail('rename', name, failure(token));
      return [['rename', name]];
    }],
    ['repair', 'the spaceId rewrite of the moved documents refuses', (newId, cols, token) => {
      faults.fail('updateMany', `${newId}_facts`, failure(token));
      return [['updateMany', `${newId}_facts`]];
    }],
    ['counter', 'the counter document refuses its move', (newId, cols, token) => {
      faults.fail('replaceOne', COUNTERS, failure(token));
      return [['replaceOne', COUNTERS]];
    }],
    ['floor', 'the change-feed floor refuses its move', (newId, cols, token) => {
      faults.fail('updateOne', FLOORS, failure(token));
      return [['updateOne', FLOORS]];
    }],
    ['reindex', 'the reindex run refuses to follow its space', (newId, cols, token) => {
      faults.fail('updateOne', `${newId}_reindex_run`, failure(token));
      return [['updateOne', `${newId}_reindex_run`]];
    }],
  ];
  for (const [c, what, arm] of storeCases) {
    it(`${what}: the space is whole under its old name, the answer is 503, and the retry completes`, async () => {
      let armed;
      const r = await refused(c, (newId, cols, token) => { armed = arm(newId, cols, token); });
      assertStoreAnswer(c, r, armed);
      assertWhole(c, r.where, { home: r.id, away: r.newId, collections: r.collections });
      await assertRetryCompletes(c, r);
    });
  }

  it('MCP: the same refusal leaves the space whole too', async () => {
    let armed;
    const r = await refused('mcp', (newId, cols, token) => {
      const name = `${idOf('mcp')}_${cols[cols.length - 1]}`;
      faults.fail('rename', name, failure(token));
      armed = [['rename', name]];
    }, { via: 'MCP' });
    assertStoreAnswer('mcp', r, armed);
    assertWhole('mcp', r.where, { home: r.id, away: r.newId, collections: r.collections });
    await assertRetryCompletes('mcp', r);
  });

  it('the files directory refuses (a non-empty one stands under the new name): the space is whole, that directory is untouched, the answer says nothing moved', async () => {
    const stranger = (newId) => path.join(dirOf(newId), 'keep.txt');
    const r = await refused('tree', (newId) => {
      fs.mkdirSync(dirOf(newId), { recursive: true });
      fs.writeFileSync(stranger(newId), 'not this space\'s');
    });
    assert.equal(r.a.status, 500, `answered ${r.a.status}, not 500: ${r.a.raw}`);
    assert.match(r.a.raw, /was not renamed/, `the answer does not say the rename did not happen: ${r.a.raw}`);
    assert.ok(!/will be resumed/.test(r.a.raw), `the answer promises a resume of a rename that was moved back: ${r.a.raw}`);
    assertWhole('tree', r.where, { home: r.id, away: r.newId, collections: r.collections });
    assert.equal(fs.readFileSync(stranger(r.newId), 'utf8'), 'not this space\'s', 'the move back touched the directory that stood under the new name');
    fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    await assertRetryCompletes('tree', r);
  });

  it('the config commit that ends the rename refuses: the space is whole under its old name', async () => {
    // The last store step of a rename moves the usage history. At that step the new id becomes a retired proxy id, once: the commit
    // that follows refuses it (409), and the retry's, with the reservation lifted, does not.
    const newId = `${idOf('commit')}-moved`;
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const realBulk = proto.bulkWrite;
    let planted = false;
    proto.bulkWrite = async function plant(...args) {
      if (this.collectionName === ACTIVITY && !planted) {
        planted = true;
        mutateConfig(cfg => { cfg.retiredSpaceIds = [...(cfg.retiredSpaceIds ?? []), newId]; });
      }
      return realBulk.apply(this, args);
    };
    try {
      const r = await refused('commit', () => {});
      mutateConfig(cfg => { cfg.retiredSpaceIds = (cfg.retiredSpaceIds ?? []).filter(s => s !== newId); });
      assert.ok(planted, 'the rename never reached its last store step, so its commit was not failed');
      assert.equal(r.a.status, 409, `the commit's refusal was answered ${r.a.status}, not 409: ${r.a.raw}`);
      assertWhole('commit', r.where, { home: r.id, away: r.newId, collections: r.collections });
      await assertRetryCompletes('commit', r);
    } finally {
      proto.bulkWrite = realBulk;
    }
  });

  it('the move back is refused too: the answer names what stays under the new name and how to finish, and the repeated rename completes', async () => {
    const stranger = (newId) => path.join(dirOf(newId), 'keep.txt');
    const r = await refused('undo', (newId, cols) => {
      // A step of ours refuses (the files directory), and every collection's move back is refused: the last one moved is the first asked.
      fs.mkdirSync(dirOf(newId), { recursive: true });
      fs.writeFileSync(stranger(newId), 'not this space\'s');
      for (const c of cols) faults.fail('rename', `${newId}_${c}`, failure(`back-${c}`));
    });
    assert.equal(r.a.status, 500, `answered ${r.a.status}, not 500: ${r.a.raw}`);
    assert.ok(!LEAK.test(r.a.raw), `the answer holds the driver's text: ${r.a.raw}`);
    for (const c of r.collections) {
      assert.ok(r.a.raw.includes(`${r.newId}_${c}`), `the answer does not name ${r.newId}_${c}, which stays under the new name: ${r.a.raw}`);
    }
    assert.match(r.a.raw, /repeat the same rename/i, `the answer does not say how to finish: ${r.a.raw}`);
    assert.deepEqual(r.where[r.newId].collections, r.collections, `what stays under the new name is not what the answer says: ${JSON.stringify(r.where[r.newId].collections)}`);
    fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    await assertRetryCompletes('undo', r);
  });

  it('the store refuses the move and the move back: it answers as the store (503), the marker stays, and the repeated rename completes', async () => {
    let armed;
    const r = await refused('split', (newId, cols, token) => {
      const forward = `${idOf('split')}_${cols[cols.length - 1]}`;
      faults.fail('rename', forward, failure(token));
      for (const c of cols) faults.fail('rename', `${newId}_${c}`, failure(`back-${c}`));
      armed = [['rename', forward]];
    });
    assertStoreAnswer('split', r, armed);
    assert.equal(getConfig().pendingSpaceOp?.newId, r.newId, 'the marker of a rename that could not be moved back is gone: nothing says it is unfinished');
    assert.ok(r.where[r.newId].collections.length > 0, 'nothing stays under the new name, so the move back was not the one refused');
    await assertRetryCompletes('split', r);
  });
});
