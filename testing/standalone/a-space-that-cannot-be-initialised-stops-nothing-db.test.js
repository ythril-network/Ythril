/**
 * One space that cannot be initialised does not stop the others at boot or at a reload (`Q-386`, the 5.6.6 patch).
 *
 * ## The defect it prevents
 *
 * Boot (`initAllSpaces`) and the config reload each walked the spaces calling `initSpace` with no `try` of their own, so the first space
 * whose init threw ended the walk. At boot every space AFTER it was never initialised (no collections, no indexes) and none of them was
 * given an `indexStatus` or handed to the index confirmation — the boot's catch-all line named a driver error and not the space. At a
 * reload the same loop ended the reload before it re-armed the schedulers (`rearmCronSchedulers`), so a changed schedule was ignored,
 * and the space that failed was not initialised again by the next reload: the reload that added it had already merged it into the
 * config, so nothing found it owed.
 *
 * ## What is held
 *
 *  - **boot**: the failing space is said ONCE, naming it; every other space is initialised and marked (`indexStatus`) and confirmed;
 *  - **reload**: the spaces behind the failing one are initialised, the schedulers are re-armed, the failing space is said once naming
 *    it, and the reload still FAILS (a `500` naming the space, in our words) — it did not apply everything;
 *  - **retry**: the next reload initialises the space that failed, though the config no longer lists it as new.
 *
 * ## How
 *
 * The real `initAllSpaces`, and the real `POST /api/admin/reload-config` on the real app, against the harness Mongo, with
 * `createCollection` refused for one space's collections: the driver's own throw, from the first step `initSpace` takes in a space with
 * none. The failing space is FIRST in the config, so a walk that stops at it initialises nothing after it.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-space-that-cannot-be-initialised-stops-nothing-db.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();
const BOOT_BAD = 'initbad';
const BOOT_OK = 'initok';
const RELOAD_BAD = 'reloadbad';
const RELOAD_OK = 'reloadok';
const FAILING = [BOOT_BAD, RELOAD_BAD];

describe('a space that cannot be initialised stops nothing', { skip }, () => {
  let door; let lifecycle; let loader; let dbProto; let realCreateCollection; let failing = true; let server; let base; let adminKey;

  const collectionsOf = async (space) =>
    (await door.mongo.getDb().listCollections().toArray()).map(c => c.name).filter(n => n.startsWith(`${space}_`));
  const dropCollectionsOf = async (space) => {
    for (const name of await collectionsOf(space)) await door.mongo.getDb().collection(name).drop();
  };
  const statusOf = (space) => loader.getConfig().spaces.find(s => s.id === space)?.indexStatus;
  /** `initSpace` says what it did in `Created collection …`; what these cases ask is whether the space's collections exist after. */
  const said = (lines, space, re) => lines.filter(l => re.test(l) && l.includes(`'${space}'`));

  before(async () => {
    door = await openPushDoor({ suite: 'initisolation', spaces: [
      { id: BOOT_BAD, label: 'bad', folders: [] },
      { id: BOOT_OK, label: 'ok', folders: [] },
    ] });
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    loader = await import('../../server/dist/config/loader.js');
    dbProto = Object.getPrototypeOf(door.mongo.getDb());
    realCreateCollection = dbProto.createCollection;
    dbProto.createCollection = function armedCreateCollection(name, ...rest) {
      if (failing && FAILING.some(id => String(name).startsWith(`${id}_`))) {
        return Promise.reject(new Error(`createCollection refused: simulated failure on ${name}`));
      }
      return realCreateCollection.call(this, name, ...rest);
    };
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });
  after(async () => {
    if (dbProto && realCreateCollection) dbProto.createCollection = realCreateCollection;
    (await import('../../server/dist/brain/dupe-scanner.js')).stopDupeScanner();
    await new Promise(r => server?.close(r));
    // The index confirmation boot starts runs on after the walk: let it settle before the connection goes.
    const until = Date.now() + 30_000;
    while (Date.now() < until && loader?.getConfig().spaces.some(s => s.indexStatus === 'building')) await new Promise(r => setTimeout(r, 200));
    await door?.close();
  });

  it('boot: the spaces after the failing one are initialised and marked, and the failing one is said once', { timeout: 120_000 }, async () => {
    for (const space of [BOOT_BAD, BOOT_OK]) await dropCollectionsOf(space);
    const { lines, result } = await logLinesDuring(() => lifecycle.initAllSpaces().then(() => 'returned', err => err));
    assert.ok((await collectionsOf(BOOT_OK)).includes(`${BOOT_OK}_facts`),
      `the space behind the failing one was not initialised (the boot ${result === 'returned' ? 'returned' : `threw: ${result?.message}`})`);
    assert.ok(['building', 'ready', 'failed'].includes(statusOf(BOOT_OK)),
      `the space behind the failing one was never marked or confirmed: indexStatus ${statusOf(BOOT_OK)}`);
    assert.equal(statusOf(BOOT_BAD), undefined, 'a space that did not initialise must not be marked');
    assert.equal(result, 'returned', `one space's failure ended the boot's init: ${result?.message}`);
    const mentions = said(lines, BOOT_BAD, /Space init failed/);
    assert.equal(mentions.length, 1, `the failing space is said ${mentions.length} time(s): ${lines.join(' | ')}`);
  });

  describe('a reload', () => {
    const post = () => fetch(`${base}/api/admin/reload-config`, { method: 'POST', headers: { authorization: `Bearer ${adminKey}` } });
    const rewriteConfigWith = (spaces, extra = {}) => {
      const cfg = JSON.parse(JSON.stringify(loader.getConfig()));
      for (const s of spaces) cfg.spaces.push({ id: s, label: s, folders: [] });
      Object.assign(cfg, extra);
      fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify(cfg, null, 2), { mode: 0o600 });
    };

    it('initialises the spaces behind the failing one, re-arms the schedulers, says the failure once, and still fails', { timeout: 120_000 }, async () => {
      rewriteConfigWith([RELOAD_BAD, RELOAD_OK], { dupeScanner: { enabled: true, schedule: '0 4 * * *' } });
      const { lines, result: res } = await logLinesDuring(() => post());
      const body = await res.json().catch(() => ({}));
      assert.ok((await collectionsOf(RELOAD_OK)).includes(`${RELOAD_OK}_facts`), 'the space behind the failing one was not initialised by the reload');
      assert.ok(lines.some(l => /Duplicate scanner scheduled \(0 4 \* \* \*\)/.test(l)),
        `the schedulers were not re-armed: ${lines.join(' | ')}`);
      const mentions = said(lines, RELOAD_BAD, /Space init failed/);
      assert.equal(mentions.length, 1, `the failing space is said ${mentions.length} time(s)`);
      assert.equal(res.status, 500, 'a reload that did not apply everything must not answer ok');
      assert.match(String(body.error), new RegExp(RELOAD_BAD), `the answer does not name the space: ${JSON.stringify(body)}`);
      assert.doesNotMatch(String(body.error), /createCollection|simulated/, 'the answer carries the driver\'s words');
    });

    it('initialises a space that failed at an earlier reload, though the file no longer lists it as new', { timeout: 120_000 }, async () => {
      failing = false;
      const res = await post();
      assert.equal(res.status, 200, JSON.stringify(await res.json().catch(() => null)));
      assert.ok((await collectionsOf(RELOAD_BAD)).includes(`${RELOAD_BAD}_facts`), 'the space that failed was not retried by the next reload');
    });
  });
});
