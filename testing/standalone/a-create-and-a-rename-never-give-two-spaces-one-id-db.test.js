/**
 * A space create and a space rename never give two configured spaces one id (Q-978, second review, finding F1).
 *
 * ## The finding
 *
 * `createSpace` checked that its id was free, awaited the creation of the space's collections and counter, and pushed the space to
 * the config without asking again. A rename of another space to that id, registered after the check and before the push, passed its own
 * checks (the id was not configured yet), moved its collections under the id the create was building on, and committed. The create then
 * pushed its space: the config held the id twice, the created space owned the renamed space's collections, counter and facts, and
 * deleting either dropped both spaces' data. `commitRename` did not ask whether its new id was still free either.
 *
 * ## What is asserted
 *
 * - (a) a create is running (held inside the creation of its collections); a rename to its id is refused (409, "already exists"), the create
 *   completes, the id is configured once, and the renamed space stands whole under its own id.
 * - (b) a rename is running (held at its first collection move); a create of its new id is refused (409), the rename completes, and the id
 *   is configured once.
 * - (c) two creates of one id at once: one answers 201, the other 409, and the id is configured once.
 * - (d) something else configures the new id while a rename runs: the rename's commit refuses (it never puts a second space under the id),
 *   the space is whole under its old id, and the id is configured once.
 * - (e) the claim is released on every path: a create that throws leaves its id free, so the same create, and a rename to that id, go through.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-create-and-a-rename-never-give-two-spaces-one-id-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor, build } from './_push-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
for (const k of ['SKIP_GLOBAL_RATE_LIMIT', 'SKIP_AUTH_RATE_LIMIT', 'SKIP_SYNC_RATE_LIMIT']) process.env[k] = 'true';
process.env['YTHRIL_RATE_LIMIT_PER_MINUTE'] ??= '1000000';

const CASES = ['a', 'b', 'c', 'd', 'e'];
const idOf = (c) => `cr-${c}`;
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

let door, base, adminKey, server, getConfig, mutateConfig, db, collProto;

async function rest(method, url, body) {
  const init = { method, headers: { Authorization: `Bearer ${adminKey}`, 'Content-Type': 'application/json' } };
  if (body !== undefined) init.body = JSON.stringify(body);
  const r = await fetch(`${base}${url}`, init);
  return { status: r.status, raw: await r.text() };
}
const underPrefix = async (p) => (await db.listCollections({}, { nameOnly: true }).toArray())
  .map(c => c.name).filter(n => n.startsWith(`${p}_`)).sort();
const configured = (id) => getConfig().spaces.filter(s => s.id === id).length;
const seed = (id) => db.collection(`${id}_facts`).insertOne(build.fact(id, randomUUID(), 1));

/** Hold the creation of the next space's collections (the first `listCollections` called from `initSpace`) until `release()`. */
function holdNextInitSpace() {
  const dbProto = Object.getPrototypeOf(db);
  const real = dbProto.listCollections;
  let release;
  const gate = new Promise(r => { release = r; });
  let held = false;
  dbProto.listCollections = function holdInitSpace(...args) {
    const cur = real.apply(this, args);
    if (!held && /initSpace/.test(String(new Error().stack))) {
      held = true;
      const realToArray = cur.toArray.bind(cur);
      cur.toArray = async () => { await gate; return realToArray(); };
    }
    return cur;
  };
  return { release: () => release(), restore: () => { dbProto.listCollections = real; }, held: () => held };
}

/** Hold the first collection move of `<prefix>_*` until `release()`: a rename that is running and has not moved anything. */
function holdRenameOf(prefix) {
  const real = collProto.rename;
  let release;
  const gate = new Promise(r => { release = r; });
  let reached = false;
  collProto.rename = async function holdMove(...args) {
    if (String(this.collectionName).startsWith(`${prefix}_`)) { reached = true; await gate; }
    return real.apply(this, args);
  };
  return { release: () => release(), restore: () => { collProto.rename = real; }, reached: () => reached };
}

async function until(what, fn) {
  for (let i = 0; i < 100; i++) { if (fn()) return; await sleep(50); }
  assert.fail(`never reached: ${what}`);
}

describe('a create and a rename never give two spaces one id', { skip }, () => {
  before(async () => {
    door = await openPushDoor({ suite: 'crrace', spaces: CASES.map(c => ({ id: idOf(c), label: idOf(c), folders: [], meta: { suppressEmbeddings: true } })) });
    ({ getConfig, mutateConfig } = await import('../../server/dist/config/loader.js'));
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
    base = server.url;
    db = door.mongo.getDb();
    collProto = Object.getPrototypeOf(door.mongo.col('probe'));
  });
  after(async () => { await server?.close(); await door?.close(); });

  it('(a) a rename to the id of a create that is running is refused, and the create completes alone', async () => {
    const id = idOf('a'), newId = `${id}-new`;
    await seed(id);
    const hold = holdNextInitSpace();
    let created, renamed;
    try {
      const create = rest('POST', '/api/spaces', { id: newId, label: 'created' });
      await until('the create is inside the creation of its collections', hold.held);
      renamed = await rest('PATCH', `/api/spaces/${id}/rename`, { newId });
      hold.release();
      created = await create;
    } finally { hold.restore(); hold.release(); }
    assert.equal(renamed.status, 409, `the rename to an id being created answered ${renamed.status}: ${renamed.raw}`);
    assert.equal(created.status, 201, `the create answered ${created.status}: ${created.raw}`);
    assert.equal(configured(newId), 1, `the id is configured ${configured(newId)} times`);
    assert.equal(configured(id), 1, 'the renamed space left the config');
    assert.ok((await underPrefix(id)).includes(`${id}_facts`), 'the refused rename took the collections of the space');
    assert.equal((await db.collection(`${newId}_facts`).countDocuments({})), 0, 'the created space holds facts of the other space');
  });

  it('(b) a create of the new id of a rename that is running is refused, and the rename completes', async () => {
    const id = idOf('b'), newId = `${id}-new`;
    await seed(id);
    const hold = holdRenameOf(id);
    let renaming, created;
    try {
      renaming = rest('PATCH', `/api/spaces/${id}/rename`, { newId });
      await until('the rename is moving its collections', hold.reached);
      created = await rest('POST', '/api/spaces', { id: newId, label: 'created' });
      hold.release();
    } finally { hold.restore(); hold.release(); }
    const renamed = await renaming;
    assert.equal(created.status, 409, `the create of an id a rename is moving collections to answered ${created.status}: ${created.raw}`);
    assert.equal(renamed.status, 200, `the rename answered ${renamed.status}: ${renamed.raw}`);
    assert.equal(configured(newId), 1, `the id is configured ${configured(newId)} times`);
    assert.equal(configured(id), 0, 'the old id is still configured');
    assert.ok((await underPrefix(newId)).includes(`${newId}_facts`), 'the renamed space is not under its new id');
  });

  it('(c) two creates of one id at once: one is created, the other refused', async () => {
    const newId = `${idOf('c')}-new`;
    const hold = holdNextInitSpace();
    let first, second;
    try {
      const a = rest('POST', '/api/spaces', { id: newId, label: 'first' });
      await until('the first create is inside the creation of its collections', hold.held);
      second = await rest('POST', '/api/spaces', { id: newId, label: 'second' });
      hold.release();
      first = await a;
    } finally { hold.restore(); hold.release(); }
    assert.deepEqual([first.status, second.status], [201, 409], `answers ${first.status} ${first.raw} / ${second.status} ${second.raw}`);
    assert.equal(configured(newId), 1, `the id is configured ${configured(newId)} times`);
  });

  it('(d) a rename whose new id was configured meanwhile is refused at its commit and leaves its space whole', async () => {
    const id = idOf('d'), newId = `${id}-new`;
    await seed(id);
    const hold = holdRenameOf(id);
    let renaming;
    try {
      renaming = rest('PATCH', `/api/spaces/${id}/rename`, { newId });
      await until('the rename is moving its collections', hold.reached);
      mutateConfig(cfg => { cfg.spaces.push({ id: newId, label: 'configured meanwhile', builtIn: false, folders: [], completeLinkage: true }); });
      hold.release();
    } finally { hold.restore(); hold.release(); }
    const renamed = await renaming;
    try {
      assert.notEqual(renamed.status, 200, `the rename committed over a configured id: ${renamed.raw}`);
      assert.equal(configured(newId), 1, `the id is configured ${configured(newId)} times`);
      assert.equal(configured(id), 1, 'the renamed space left the config');
      assert.ok((await underPrefix(id)).includes(`${id}_facts`), 'the refused rename left the collections away from the old id');
      assert.deepEqual(await underPrefix(newId), [], 'collections of the refused rename stay under the other space\'s id');
    } finally {
      mutateConfig(cfg => { cfg.spaces = cfg.spaces.filter(s => s.id !== newId); });
    }
  });

  it('(e) a create that fails gives its id back: the same create and a rename to it go through', async () => {
    const id = idOf('e'), newId = `${id}-new`;
    await seed(id);
    const dbProto = Object.getPrototypeOf(db);
    const real = dbProto.listCollections;
    dbProto.listCollections = function failInitSpace(...args) {
      if (/initSpace/.test(String(new Error().stack))) { dbProto.listCollections = real; throw new Error('listing refused for this case'); }
      return real.apply(this, args);
    };
    let failed;
    try { failed = await rest('POST', '/api/spaces', { id: newId, label: 'created' }); } finally { dbProto.listCollections = real; }
    assert.ok(failed.status >= 400, `the create that threw answered ${failed.status}: ${failed.raw}`);
    assert.equal(configured(newId), 0, 'the failed create is in the config');
    const renamed = await rest('PATCH', `/api/spaces/${id}/rename`, { newId });
    assert.equal(renamed.status, 200, `a rename to the id of a create that failed answered ${renamed.status}: ${renamed.raw}`);
    assert.equal(configured(newId), 1);
  });
});
