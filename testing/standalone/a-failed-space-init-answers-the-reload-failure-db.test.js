/**
 * `POST /api/admin/reload-config` answers a space whose init failed, and the failure is counted and held (bundle-53 G21, Q-274).
 *
 * ## What was wrong
 *
 * The reload's space init was a bare loop in the route's own function. A space that threw stopped the loop (so the spaces after
 * it were never initialised), the route answered `500` with the DRIVER'S text for the one failure it had seen, a store-side
 * failure was answered the same way, the rejected reload did not move `ythril_config_reload_failed_total` unless the file
 * WATCHER had run it, and `ythril_config_reload_pending` — which says "what is running is older than what is on disk" — went
 * back to 0 on the next quiet reload although a space was still un-initialised.
 *
 * ## What this holds, through the whole app
 *
 * The route is reached as a caller reaches it (`createApp`, the precedent of `a-write-timeout-answers-503-on-every-door-db`),
 * because the part that matters is what the app's own handler answers and counts, and a live instance has no way to fail one
 * space's init (the integration suite keeps its happy-path reload assertion). A space that cannot be initialised is a real one:
 * its `_facts` collection is a view, which refuses an index.
 *
 *  1. an ordinary failure answers `500` in words of ours naming the space, with none of the driver's text;
 *  2. `ythril_config_reload_failed_total` moved by exactly one, `ythril_config_reload_pending` is 1;
 *  3. a failure on the STORE's side in one space answers `503` with `Retry-After`, `retryable: true` — `errorChain` walks the
 *     aggregate the reload throws, so the store-side member decides the answer;
 *  4. the reload that follows once the cause is gone answers 200, initialises the space, and clears the pending gauge;
 *  5. a quiet reload while a space is still owed does NOT report the config as applied.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-failed-space-init-answers-the-reload-failure-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openStalledWriteDoors } from './_stalled-write-doors.mjs';
import { withCollectionAsView, driverWriteFailures, failWrites } from './_write-faults.mjs';

const skip = await mongoSkipReason();

const SUITE = 'reloadinit';
const BAD = 'reloadbad';
const STORE = 'reloadstore';
/** What the driver says about a view that refuses an index, and what a dead store's error names — none of it may reach a caller. */
const DRIVER_TEXT = /Mongo\w*Error|CommandNotSupportedOnView|\bview\b|reloadbad_facts|reloadstore_facts|ECONNREFUSED|127\.0\.0\.1|ServerSelection/i;

describe('POST /api/admin/reload-config answers a space whose init failed', { skip }, () => {
  let doors, db, registry, lifecycle, configPath;

  before(async () => {
    doors = await openStalledWriteDoors({ suite: SUITE, spaces: [] });
    db = doors.env.door.mongo.getDb();
    registry = await import('../../server/dist/metrics/registry.js');
    lifecycle = await import('../../server/dist/spaces/lifecycle.js');
    configPath = process.env['CONFIG_PATH'];
    // The file watcher (`createApp` starts it) would reload on its own the moment this test edits the file; this test calls
    // the route itself, once per edit, so the watcher is taken off the file.
    fs.unwatchFile(configPath);
    await (await import('../../server/dist/config/loader.js')).flushConfig();
  });
  after(async () => { await doors?.close(); });

  /** Add a space to config.json ON DISK, the way an operator's hand edit does; memory does not know it until a reload. */
  function addSpaceOnDisk(id) {
    const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
    if (!cfg.spaces.some(s => s.id === id)) {
      cfg.spaces.push({ id, label: id, folders: [], completeLinkage: true, meta: { suppressEmbeddings: true } });
      fs.writeFileSync(configPath, JSON.stringify(cfg, null, 2), { mode: 0o600 });
    }
  }
  const reload = async () => {
    const res = await fetch(`${doors.env.base}/api/admin/reload-config`, {
      method: 'POST', headers: { Authorization: `Bearer ${doors.env.adminKey}`, 'Content-Type': 'application/json' }, body: '{}',
    });
    const text = await res.text();
    let body; try { body = JSON.parse(text); } catch { body = undefined; }
    return { status: res.status, headers: res.headers, body, text };
  };
  const metric = async (name) => {
    const m = new RegExp(`^${name} (\\S+)$`, 'm').exec(await registry.register.metrics());
    assert.ok(m, `the scrape holds no ${name}`);
    return Number(m[1]);
  };

  it('control: with nothing wrong the route answers 200 and the gauge is 0', async () => {
    const r = await reload();
    assert.equal(r.status, 200, r.text);
    assert.equal(await metric('ythril_config_reload_pending'), 0);
  });

  it('an ordinary init failure answers 500 in our words naming the space, counts, and holds the pending gauge', async () => {
    const failedBefore = await metric('ythril_config_reload_failed_total');
    addSpaceOnDisk(BAD);
    let r;
    await withCollectionAsView(db, `${BAD}_facts`, 'reloadbad_nothing', async () => { r = await reload(); });

    assert.equal(r.status, 500, `the route answered ${r.status}: ${r.text.slice(0, 300)}`);
    assert.match(r.body?.error ?? '', new RegExp(BAD), `the answer does not name the space that failed: ${r.text.slice(0, 300)}`);
    assert.doesNotMatch(r.text, DRIVER_TEXT, `the answer carries the driver's text: ${r.text.slice(0, 300)}`);
    assert.equal(await metric('ythril_config_reload_failed_total'), failedBefore + 1, 'the rejected reload did not move ythril_config_reload_failed_total');
    assert.equal(await metric('ythril_config_reload_pending'), 1, 'ythril_config_reload_pending is not set while a space is un-initialised');
    assert.deepEqual(lifecycle.spacesOwedInit(), [BAD]);
  });

  it('a quiet reload while the space is still owed does not report the config applied', async () => {
    let r;
    await withCollectionAsView(db, `${BAD}_facts`, 'reloadbad_nothing', async () => { r = await reload(); });
    assert.equal(r.status, 500, `a reload that could not initialise the owed space answered ${r.status}: ${r.text.slice(0, 300)}`);
    assert.equal(await metric('ythril_config_reload_pending'), 1);
  });

  it('a failure on the STORE\'s side in one space answers 503 with Retry-After (errorChain walks the aggregate)', { timeout: 60_000 }, async () => {
    const failures = await driverWriteFailures(`ythril_harness_${SUITE}`);
    const mongo = doors.env.door.mongo;
    const patch = failWrites(Object.getPrototypeOf(mongo.col('probe')), ['createIndex']);
    try {
      // The bad space is healthy now (its view is gone, put back as a collection); the store-side fault is on the new one.
      addSpaceOnDisk(STORE);
      patch.fail('createIndex', `${STORE}_facts`, failures.storeGone.single);
      const failedBefore = await metric('ythril_config_reload_failed_total');
      const r = await reload();
      assert.equal(r.status, 503, `a store failure in one space answered ${r.status}: ${r.text.slice(0, 300)}`);
      assert.ok(r.headers.get('retry-after'), 'the 503 carries no Retry-After');
      assert.equal(r.body?.retryable, true, `the 503 does not say it is retryable: ${r.text.slice(0, 300)}`);
      assert.doesNotMatch(r.text, DRIVER_TEXT, `the 503 carries the driver's text: ${r.text.slice(0, 300)}`);
      assert.equal(await metric('ythril_config_reload_failed_total'), failedBefore + 1);
      assert.equal(await metric('ythril_config_reload_pending'), 1);
    } finally {
      patch.restore();
    }
  });

  it('once the cause is gone the next reload initialises what is owed, answers 200, and clears the gauge', async () => {
    const r = await reload();
    assert.equal(r.status, 200, `the retry answered ${r.status}: ${r.text.slice(0, 300)}`);
    assert.equal(await metric('ythril_config_reload_pending'), 0, 'the pending gauge stayed set after every owed space was initialised');
    assert.deepEqual(lifecycle.spacesOwedInit(), []);
    for (const id of [BAD, STORE]) {
      assert.ok((await db.collection(`${id}_facts`).indexes()).length > 1, `${id} was not initialised by the retry: no indexes`);
    }
  });
});
