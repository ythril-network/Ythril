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
const CASES = ['collection', 'repair', 'counter', 'floor', 'reindex', 'tree', 'commit', 'undo', 'split', 'mcp',
  'landcoll', 'landcounter', 'landfloor', 'keptcounter', 'leftover', 'repeat', 'commitwrite', 'markerclear', 'markerother', 'usage', 'warns'];
const idOf = (c) => `rf-${c}`;
const SPILLS = '_read_spills';
const MARK = 250_000;
/** What one case planted for the steps whose state is not under the space's prefix: the spill, the import report. */
const planted = new Map();

let door, faults, base, adminKey, callTool, ADMIN, server, getConfig, mutateConfig, db, versionMark, rdfFiles, spaceActStands;

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
/**
 * The collection of `id` that a rename moves LAST: the order `moveSpaceData` walks is the store's own listing, which is catalog order and not name order,
 * and it ends at the first collection the store refuses (a store failure is never collected). A fault armed on the name-sorted last collection moved
 * nothing before it whenever the listing put that one first, and the rename then had nothing to move back and cleared its marker: the case asserted a
 * marker that had no reason to stand (Full run 46061778730, Q-978's case 'the store refuses the move and the move back').
 */
const movedLast = async (id) => {
  const names = (await db.listCollections({}, { nameOnly: true }).toArray()).map(c => c.name).filter(n => n.startsWith(`${id}_`));
  return names[names.length - 1];
};
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
  // The five steps that have no collection of their own under the prefix: a read spill that names the space, its version mark, the
  // chunk-upload directory, an RDF import report and (above) the usage history. Each is moved by its own step, so each is asserted.
  const spillId = randomUUID();
  await db.collection(SPILLS).insertOne({ _id: spillId, kind: 'recall', issuedTo: 'rf', memberSpaceIds: [id], items: 0, rawBytes: 0,
    createdAt: new Date(), expiresAt: new Date(Date.now() + 3_600_000), request: {} });
  versionMark.followCounter(id, MARK);
  fs.mkdirSync(path.join(chunkDirOf(id), 'u1'), { recursive: true });
  fs.writeFileSync(path.join(chunkDirOf(id), 'u1', 'part0'), 'part');
  const importId = randomUUID();
  await rdfFiles.keepReport({ importId, space: id, status: 'done' });
  planted.set(id, { spillId, importId });
}
const chunkDirOf = (id) => path.join(process.env['DATA_ROOT'], '.chunks', id);

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
    // The `spaceId` of every document of every collection under the name, not of the facts alone: the rewrite covers them all.
    allSpaceIds: [...new Set((await Promise.all((await underPrefix(p)).map(c => db.collection(`${p}_${c}`).find({}).toArray()))).flat().map(d => d.spaceId).filter(s => s !== undefined))],
    spill: !!(await db.collection(SPILLS).findOne({ _id: planted.get(id)?.spillId, memberSpaceIds: p })),
    mark: versionMark.versionMarkOf(p) !== undefined,
    chunks: fs.existsSync(path.join(chunkDirOf(p), 'u1', 'part0')),
    rdf: (await rdfFiles.readReport(planted.get(id)?.importId ?? 'none', 0))?.space === p,
    usage: !!(await db.collection(ACTIVITY).findOne({ _id: `${p}:2026-01-01T00`, space: p })),
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
  assert.deepEqual(w[home].allSpaceIds, [home], `${label}: documents under '${home}' carry ${JSON.stringify(w[home].allSpaceIds)} in some collection`);
  for (const k of ['spill', 'mark', 'chunks', 'rdf', 'usage']) {
    assert.equal(w[home][k], true, `${label}: the ${k} of the space is not under '${home}'`);
    assert.equal(w[away][k], false, `${label}: the ${k} of the space is under '${away}'`);
  }
  assert.deepEqual(w.configIds, [home], `${label}: the config names ${JSON.stringify(w.configIds)}, not '${home}'`);
}

describe('a refused rename leaves the space whole', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'rfwhole',
      spaces: CASES.map(c => ({ id: idOf(c), label: idOf(c), folders: [], meta: { suppressEmbeddings: true } })) });
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ getConfig, mutateConfig } = await import('../../server/dist/config/loader.js'));
    versionMark = await import('../../server/dist/util/version-mark.js');
    rdfFiles = await import('../../server/dist/spaces/rdf-import-files.js');
    ({ spaceActStands } = await import('../../server/dist/spaces/space-act-runner.js'));
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
    await plant(newId, collections, token, await movedLast(id));
    const ask = () => (via === 'REST' ? rest('PATCH', `/api/spaces/${id}/rename`, { newId }) : mcp('space_rename', { space: id, newId }));
    const { result: a, lines } = await logLinesDuring(ask);
    return { id, newId, collections, ask, a, lines, where: await whereIs(id, newId) };
  }

  /** What stands for the space after a refusal: its marker and the act of its rename that is owed. */
  const standing = (id) => ({ marker: getConfig().pendingSpaceOp ?? null, act: spaceActStands(getConfig(), id)?.kind ?? null });

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
    ['collection', 'the last collection of the space refuses its move, the others already moved', (newId, cols, token, last) => {
      const name = last;
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
      const r = await refused(c, (newId, cols, token, last) => { armed = arm(newId, cols, token, last); });
      assertStoreAnswer(c, r, armed);
      assertWhole(c, r.where, { home: r.id, away: r.newId, collections: r.collections });
      assert.deepEqual(standing(r.id), { marker: null, act: null }, `${c}: a rename moved fully back still stands as an act or a marker`);
      assert.ok(!r.lines.some(l => /did not complete; it is retried automatically/.test(l)), `${c}: the log says a rename that moved fully back is retried automatically`);
      await assertRetryCompletes(c, r);
    });
  }

  it('MCP: the same refusal leaves the space whole too', async () => {
    let armed;
    const r = await refused('mcp', (newId, cols, token, last) => {
      const name = last;
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
    // Everything is back: the rename was refused and is over. Its act ends (the space takes writes again, nothing is queued, nothing is
    // retried behind the caller's back) and the user repeats the rename. A refusal that moved everything back says so in the log.
    assert.deepEqual(standing(r.id), { marker: null, act: null }, 'a rename moved fully back still stands as an act or a marker, so the space stays closed to writes');
    assert.ok(!r.lines.some(l => /did not complete; it is retried automatically/.test(l)), `the log says a rename that moved fully back is retried automatically: ${JSON.stringify(r.lines.filter(l => /retried automatically/.test(l)))}`);
    assert.ok(r.lines.some(l => /was refused/.test(l) && /moved back/.test(l)),`the log says nothing of the move back: ${JSON.stringify(r.lines.filter(l => /rename/i.test(l)))}`);
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
    // Something stays moved: the rename stays owed with its marker, so the space stays closed until it is finished.
    assert.equal(standing(r.id).act, 'rename', 'a rename that left collections under the new name no longer stands as an act');
    assert.equal(getConfig().pendingSpaceOp?.newId, r.newId, 'the marker of a rename that left collections under the new name is gone');
    fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    await assertRetryCompletes('undo', r);
  });

  it('the store refuses the move and the move back: it answers as the store (503), the marker stays, and the repeated rename completes', async () => {
    let armed;
    const r = await refused('split', (newId, cols, token, last) => {
      const forward = last;
      faults.fail('rename', forward, failure(token));
      for (const c of cols) faults.fail('rename', `${newId}_${c}`, failure(`back-${c}`));
      armed = [['rename', forward]];
    });
    assertStoreAnswer('split', r, armed);
    assert.equal(getConfig().pendingSpaceOp?.newId, r.newId, 'the marker of a rename that could not be moved back is gone: nothing says it is unfinished');
    assert.ok(r.where[r.newId].collections.length > 0, 'nothing stays under the new name, so the move back was not the one refused');
    await assertRetryCompletes('split', r);
  });

  // ── What the review of the first fix proved (the probe's P1-P4 are the first four cases here) ──────────────────────────────────────────────

  const strangerDir = (newId) => {
    fs.mkdirSync(dirOf(newId), { recursive: true });
    fs.writeFileSync(path.join(dirOf(newId), 'keep.txt'), 'not this space\'s');
  };

  for (const [c, what, method, name] of [
    ['landcoll', 'a collection', 'rename', (id) => `${id}_files`],
    ['landcounter', 'the counter document (its copy was written, the old one never deleted)', 'replaceOne', () => COUNTERS],
    ['landfloor', 'the change-feed floor (its copy was written, the old one never deleted)', 'updateOne', () => FLOORS],
  ]) {
    it(`a step that wrote and then failed is moved back too: ${what}`, async () => {
      let armed;
      const r = await refused(c, () => {
        const n = name(idOf(c));
        faults.fail(method, n, failure(`landed-${c}`), { land: true });
        armed = [[method, n]];
      });
      assertStoreAnswer(c, r, armed);
      assertWhole(c, r.where, { home: r.id, away: r.newId, collections: r.collections });
      await assertRetryCompletes(c, r);
    });
  }

  it('a counter a deleted space kept under the new id survives a refused rename, and the space\'s own counter is back under its name', async () => {
    const r = await refused('keptcounter', async (newId) => {
      await db.collection(COUNTERS).replaceOne({ _id: newId }, { _id: newId, seq: 50 }, { upsert: true });
      strangerDir(newId);
    });
    assert.equal(r.a.status, 500, `answered ${r.a.status}: ${r.a.raw}`);
    assert.deepEqual(await db.collection(COUNTERS).findOne({ _id: r.newId }), { _id: r.newId, seq: 50 }, 'the move back took or rewrote the counter the new id already held');
    assert.deepEqual(await db.collection(COUNTERS).findOne({ _id: r.id }), { _id: r.id, seq: 7 }, 'the space\'s own counter is not back as it was');
    assertWhole('keptcounter', { ...r.where, [r.newId]: { ...r.where[r.newId], counter: false } }, { home: r.id, away: r.newId, collections: r.collections });
    fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    await db.collection(COUNTERS).deleteOne({ _id: r.newId });
    await assertRetryCompletes('keptcounter', r);
  });

  it('a document in a collection under the new name that the rename did not move keeps its spaceId through a refusal, and gets the new one when the rename succeeds', async () => {
    const ghost = (newId) => db.collection(`${newId}_notes`).findOne({ _id: 'ghost' });
    const r = await refused('leftover', async (newId) => {
      await db.collection(`${newId}_notes`).insertOne({ _id: 'ghost', spaceId: 'ghost' });
      strangerDir(newId);
    });
    assert.equal(r.a.status, 500, `answered ${r.a.status}: ${r.a.raw}`);
    assertWhole('leftover', r.where, { home: r.id, away: r.newId, collections: r.collections });
    assert.equal((await ghost(r.newId))?.spaceId, 'ghost', 'the rename rewrote the spaceId of a document it never moved');
    fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    faults.clear();
    const done = await r.ask();
    assert.equal(done.status, 200, `the rename did not complete: ${done.raw}`);
    assert.equal((await ghost(r.newId))?.spaceId, r.newId, 'a rename that succeeds no longer rewrites the spaceId of the documents under the new name');
  });

  it('a repeated rename refused again never claims the space whole while the earlier attempt\'s collections stand under the new name, and its id is not given away meanwhile', async () => {
    const r = await refused('repeat', (newId, cols) => {
      strangerDir(newId);
      for (const c of cols) faults.fail('rename', `${newId}_${c}`, failure(`back-${c}`));
    });
    assert.equal(r.a.status, 500, `the first attempt answered ${r.a.status}: ${r.a.raw}`);
    assert.deepEqual(r.where[r.newId].collections, r.collections, 'the first attempt left nothing under the new name, so its move back was not refused');
    // The new id belongs to the rename that stands: a space created under it would meet the collections already there.
    const created = await rest('POST', '/api/spaces', { id: r.newId, label: 'taken' });
    assert.equal(created.status, 409, `a space was created under the id a standing rename moved collections to: ${created.status} ${created.raw}`);
    assert.ok(!getConfig().spaces.some(s => s.id === r.newId), 'the refused create is in the config');
    // The same rename again, refused at the same step. It moves back what it moved itself; the first attempt's collections stay under
    // the new name, and the answer says so and keeps the marker.
    faults.clear();
    const again = await r.ask();
    assert.equal(again.status, 500, `the repeat answered ${again.status}: ${again.raw}`);
    assert.ok(!/stands whole/.test(again.raw), `the repeat says the space stands whole while its collections stand under the new name: ${again.raw}`);
    assert.match(again.raw, /repeat the same rename/i, `the repeat does not say how to finish: ${again.raw}`);
    assert.equal(getConfig().pendingSpaceOp?.newId, r.newId, 'the repeat cleared the marker of a rename that stays under the new name');
    assert.equal(standing(r.id).act, 'rename', 'the repeat ended the act of a rename that stays under the new name');
    assert.deepEqual((await whereIs(r.id, r.newId))[r.newId].collections, r.collections, 'the collections of the first attempt are no longer under the new name');
    fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    await assertRetryCompletes('repeat', r);
  });

  it('the config write that commits the rename fails and the move back is refused: the config is read again, so it still names the space by its old id and the same rename completes', async () => {
    const id = idOf('commitwrite');
    const newId = `${id}-moved`;
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const realBulk = proto.bulkWrite;
    const realWrite = fs.writeFileSync;
    let failed = 0;
    // Armed at the last store step: the next write of config.json that names the new id (the commit's) fails, once.
    proto.bulkWrite = async function plant(...args) {
      if (this.collectionName === ACTIVITY && failed === 0) {
        fs.writeFileSync = function failTheCommit(file, data, ...rest) {
          if (failed === 0 && String(file).endsWith('config.json.tmp') && String(data).includes(`"id": "${newId}"`)) {
            failed++;
            fs.writeFileSync = realWrite;
            throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO', syscall: 'write' });
          }
          return realWrite.call(this, file, data, ...rest);
        };
      }
      return realBulk.apply(this, args);
    };
    try {
      const r = await refused('commitwrite', (n, cols) => { for (const c of cols) faults.fail('rename', `${n}_${c}`, failure(`back-${c}`)); });
      assert.equal(failed, 1, 'the commit\'s config write was not failed, so the rename never reached its commit');
      assert.deepEqual(getConfig().spaces.map(s => s.id).filter(s => s === id || s === newId), [id], 'the config in memory names the space by its new id although the file does not');
      assert.ok(r.where[newId].collections.length > 0, 'nothing stays under the new name, so the move back was not the one refused');
      await assertRetryCompletes('commitwrite', r);
    } finally {
      fs.writeFileSync = realWrite;
      proto.bulkWrite = realBulk;
    }
  });

  // ── What the second review proved (F2, F3, F4) ───────────────────────────────────────────────────────────────────────────────────────────────

  it('the marker cannot be cleared after a full move back: the rename stays owed, the answer says so, and another space\'s rename does not finish it behind that answer', async () => {
    const id = idOf('markerclear');
    const newId = `${id}-moved`;
    const realWrite = fs.writeFileSync;
    let armed = false, failed = 0;
    // The write that records the marker names the new id and arms the fault; the next write of config.json without a marker (the clear) fails, once.
    const plant = () => {
      strangerDir(newId);
      fs.writeFileSync = function failMarkerClear(file, data, ...rest) {
        if (String(file).endsWith('config.json.tmp')) {
          const s = String(data);
          if (s.includes('"pendingSpaceOp"') && s.includes(newId)) armed = true;
          else if (armed && failed === 0 && !s.includes('"pendingSpaceOp"')) {
            failed++;
            throw Object.assign(new Error('EIO: i/o error, write'), { code: 'EIO', syscall: 'write' });
          }
        }
        return realWrite.call(this, file, data, ...rest);
      };
    };
    let r;
    try {
      r = await refused('markerclear', plant);
    } finally {
      fs.writeFileSync = realWrite;
    }
    assert.equal(failed, 1, 'the marker clear was not failed, so the rename never reached it');
    assert.equal(r.a.status, 500, `answered ${r.a.status}: ${r.a.raw}`);
    assert.ok(!/stands whole/.test(r.a.raw), `the answer says the space stands whole while its marker stands: ${r.a.raw}`);
    assert.match(r.a.raw, /repeat the same rename/i, `the answer does not say how to finish: ${r.a.raw}`);
    assert.equal(getConfig().pendingSpaceOp?.newId, newId, 'the marker is not standing');
    assert.equal(standing(id).act, 'rename', 'the act of a rename whose marker stands has ended: the space refuses writes with nothing owed');
    // The cause (the directory under the new name) still stands: another space's rename settles the marker first and cannot finish it.
    const other = await rest('PATCH', `/api/spaces/${idOf('markerother')}/rename`, { newId: `${idOf('markerother')}-moved` });
    assert.notEqual(other.status, 200, `another space's rename finished the refused rename behind its answer: ${other.raw}`);
    assert.deepEqual(getConfig().spaces.map(s => s.id).filter(s => s === id || s === newId), [id], 'the refused rename was rolled forward');
    fs.rmSync(dirOf(newId), { recursive: true, force: true });
    await assertRetryCompletes('markerclear', r);
  });

  it('usage counted for the old id while a refused rename ran is kept by its move back', async () => {
    const id = idOf('usage');
    const bucketId = `${id}:2026-01-01T00`;
    const proto = Object.getPrototypeOf(door.mongo.col('probe'));
    const realBulk = proto.bulkWrite;
    let flushed = 0;
    // A flush of the old id's reads after its buckets moved: the `$inc` upsert every flush makes. Landed after the slice that deletes the old rows.
    proto.bulkWrite = async function flushAfterTheMove(...args) {
      const out = await realBulk.apply(this, args);
      if (this.collectionName === ACTIVITY && flushed === 0 && Array.isArray(args[0]) && args[0].some(op => op.deleteOne)) {
        flushed++;
        await this.updateOne({ _id: bucketId }, { $inc: { 'calls.recall.n': 5 }, $setOnInsert: { space: id, bucket: '2026-01-01T00', bucketAt: new Date() } }, { upsert: true });
      }
      return out;
    };
    try {
      const r = await refused('usage', async (newId) => {
        strangerDir(newId);
        await db.collection(ACTIVITY).replaceOne({ _id: bucketId }, { _id: bucketId, space: id, bucket: '2026-01-01T00', bucketAt: new Date(),
          calls: { recall: { n: 1, answered: 1, sumTopScore: 0.5, sumMs: 10, over1s: 0, maxMs: 10 } } }, { upsert: true });
      });
      assert.equal(flushed, 1, 'the usage step never ran its delete, so no flush was made after it');
      assert.equal(r.a.status, 500, `answered ${r.a.status}: ${r.a.raw}`);
      const back = await db.collection(ACTIVITY).findOne({ _id: bucketId });
      assert.equal(back?.calls?.recall?.n, 6, `the usage counted while the rename ran is lost: ${JSON.stringify(back?.calls)}`);
      assert.equal(back?.calls?.recall?.maxMs, 10, `the slowest call is not kept: ${JSON.stringify(back?.calls)}`);
      assert.equal(await db.collection(ACTIVITY).findOne({ _id: `${r.newId}:2026-01-01T00` }), null, 'a bucket stays under the new id');
      fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    } finally {
      proto.bulkWrite = realBulk;
    }
  });

  it('a refused rename logs neither the repair of the move back nor an index build on a collection that moved away', async () => {
    const r = await refused('warns', (newId) => strangerDir(newId));
    assert.equal(r.a.status, 500, `answered ${r.a.status}: ${r.a.raw}`);
    assertWhole('warns', r.where, { home: r.id, away: r.newId, collections: r.collections });
    // The rewrite of the move back puts the old id on documents the rename itself had given the new one: nothing was left stale, so nothing is warned of.
    const repair = r.lines.filter(l => l.includes(`Space '${r.id}': repaired`));
    assert.deepEqual(repair, [], 'the move back warns of a repair of documents the refused rename itself changed');
    fs.rmSync(dirOf(r.newId), { recursive: true, force: true });
    // An index build for a collection that no longer stands is not a failed index: the collections of a refused rename leave and come back.
    const { ensureCollectionSearchIndexes } = await import('../../server/dist/spaces/vector-index.js');
    const { result: outcome, lines } = await logLinesDuring(() => ensureCollectionSearchIndexes('rf-nowhere', 'facts', false));
    assert.equal(outcome, 'failed', `the build for a collection that is not there answered ${outcome}, so search never reached the create`);
    assert.deepEqual(lines.filter(l => /Failed to create vector search index/.test(l)), [], 'a collection that is not there is reported as a failed index');
  });
});
