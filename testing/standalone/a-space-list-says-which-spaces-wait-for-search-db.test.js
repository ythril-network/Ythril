/**
 * `GET /api/spaces` says which spaces are waiting for the search service — derived per token, never stored (Q-113).
 *
 * ## Why it is a field on this route
 *
 * While search is down a space's indexes cannot be built, and the space stays `building` (it is no longer marked
 * `failed` for a service that was merely late). An operator looking at that badge for ten minutes needs to be told
 * WHY it is not moving, and whether it is the service or the space. `indexWaiting: true` (and `indexWaitingSince`,
 * when the wait began) answers it on the one listing every client already reads.
 *
 * ## The rules
 *
 *  - only a space that is `building` is ever `indexWaiting`, and only while search is down — a real build is a
 *    build, and `ready` and `failed` are facts about the space that no outage changes;
 *  - `indexStatus` itself is unchanged: the field is additive;
 *  - it is computed INSIDE the per-token visible-spaces map, so a scoped token is told about its own spaces and
 *    about nothing else (a hidden space's state must not leak through a second list);
 *  - it is derived at read time: the stored config never carries it (it would be stale the moment search
 *    returned, and it would replicate).
 *
 * Driven through the real app on an ephemeral port with real tokens; the outage is simulated below the server
 * (`_search-outage.mjs`) and the scratch database is real.
 *
 * Only this suite reaches the route in-process. MCP `list_spaces` carries no `indexStatus` and therefore gets no
 * `indexWaiting` either; the plan states that, and `mcp-rest-parity` does not govern a field the tool never had.
 *
 * Needs a MongoDB: `npm run test:up`, or a scratch one pointed at with YTHRIL_TEST_MONGO_PORT /
 * YTHRIL_TEST_MONGO_CREDS= — CI runs it against the test stack.
 *
 * Run: node --test testing/standalone/a-space-list-says-which-spaces-wait-for-search-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { installSearchOutage } from './_search-outage.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-waiting-'));
const CONFIG_PATH = path.join(tmpDir, 'config.json');
process.env['CONFIG_PATH'] = CONFIG_PATH;
process.env['DATA_ROOT'] = path.join(tmpDir, 'data');
process.env['SKIP_GLOBAL_RATE_LIMIT'] = 'true';
process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';

const sp = (id, indexStatus) => ({ id, label: id, folders: [], completeLinkage: true, ...(indexStatus ? { indexStatus } : {}) });
const SPACES = [sp('iw-wait', 'building'), sp('iw-ready', 'ready'), sp('iw-failed', 'failed'), sp('iw-hidden', 'building')];

let mongo, loader, readiness, outage, server, base, adminKey, scopedKey;
let outageStartedAt = 0;

const list = async (key) => {
  const r = await fetch(`${base}/api/spaces`, { headers: { Authorization: `Bearer ${key}` } });
  assert.equal(r.status, 200, `GET /api/spaces answered ${r.status}`);
  return Object.fromEntries((await r.json()).spaces.map(s => [s.id, s]));
};
const sinceMs = (v) => (typeof v === 'number' ? v : Date.parse(v));

describe('GET /api/spaces — indexWaiting', { skip }, () => {
  before(async () => {
    fs.writeFileSync(CONFIG_PATH, JSON.stringify({
      instanceId: 'waiting', instanceLabel: 'test', tokens: [], networks: [], spaces: SPACES,
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    mongo = await openTestMongo('indexwaiting');
    readiness = await import('../../server/dist/spaces/search-readiness.js');
    outage = installSearchOutage(mongo);
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    scopedKey = (await tokens.createToken({ name: 'scoped', spaces: ['iw-wait', 'iw-ready', 'iw-failed'] })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = createApp().listen(0, '127.0.0.1');
    await new Promise(r => server.once('listening', r));
    base = `http://127.0.0.1:${server.address().port}`;
  });

  after(async () => {
    await new Promise(r => server?.close(r));
    outage?.restore();
    readiness?.resetSearchReadyProbe();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('with search answering, a building space is just building: no indexWaiting anywhere', async () => {
    readiness.resetSearchReadyProbe();
    assert.equal(await readiness.searchAvailable(), true);
    const all = await list(adminKey);
    assert.equal(all['iw-wait'].indexStatus, 'building');
    for (const s of Object.values(all)) {
      assert.ok(!('indexWaiting' in s), `${s.id} says indexWaiting although search answers`);
      assert.ok(!('indexWaitingSince' in s), `${s.id} carries indexWaitingSince although search answers`);
    }
  });

  it('with search down, a building space is indexWaiting with a start time; ready and failed spaces are not', async () => {
    readiness.resetSearchReadyProbe();
    outageStartedAt = Date.now();
    outage.setDown(true);
    assert.equal(await readiness.searchAvailable(), false, 'fixture check: the simulated outage must read as down');
    const all = await list(adminKey);
    assert.equal(all['iw-wait'].indexWaiting, true);
    assert.equal(all['iw-hidden'].indexWaiting, true);
    const since = sinceMs(all['iw-wait'].indexWaitingSince);
    assert.ok(Number.isFinite(since), `indexWaitingSince is not a time: ${JSON.stringify(all['iw-wait'].indexWaitingSince)}`);
    assert.ok(since >= outageStartedAt - 5_000 && since <= Date.now() + 1_000,
      'indexWaitingSince must be when the wait began, not an arbitrary time');
    assert.equal(sinceMs(all['iw-hidden'].indexWaitingSince), since, 'one outage, one start time');
    for (const id of ['iw-ready', 'iw-failed']) {
      assert.ok(!('indexWaiting' in all[id]), `${id} (${all[id].indexStatus}) was called waiting — an outage does not change a fact about the space`);
    }
  });

  it('indexStatus is unchanged: the field is additive', async () => {
    const all = await list(adminKey);
    assert.deepEqual(['iw-wait', 'iw-ready', 'iw-failed', 'iw-hidden'].map(id => all[id].indexStatus),
      ['building', 'ready', 'failed', 'building']);
  });

  it('a scoped token is told about its own spaces and nothing else', async () => {
    const mine = await list(scopedKey);
    assert.deepEqual(Object.keys(mine).sort(), ['iw-failed', 'iw-ready', 'iw-wait']);
    assert.equal(mine['iw-wait'].indexWaiting, true);
    assert.ok(!('indexWaiting' in mine['iw-ready']));
    assert.ok(!('iw-hidden' in mine), 'a space outside the token\'s reach appeared in its list');
    const text = JSON.stringify(mine);
    assert.ok(!text.includes('iw-hidden'), 'the hidden space leaked into the scoped answer through another field');
  });

  it('it is derived, never stored: the config in memory and on disk carries no indexWaiting', async () => {
    await list(adminKey);
    for (const s of loader.getConfig().spaces) assert.ok(!('indexWaiting' in s) && !('indexWaitingSince' in s), `${s.id} stores it`);
    const onDisk = fs.readFileSync(CONFIG_PATH, 'utf8');
    assert.ok(!/indexWaiting/.test(onDisk), 'the stored config carries a derived field');
    assert.equal(loader.getConfig().spaces.find(s => s.id === 'iw-wait').indexStatus, 'building', 'listing changed a stored status');
  });

  it('when search returns the field is gone on the next read', async () => {
    readiness.noteSearchUp();
    const all = await list(adminKey);
    for (const s of Object.values(all)) assert.ok(!('indexWaiting' in s), `${s.id} still says waiting after search returned`);
    assert.equal(all['iw-wait'].indexStatus, 'building');
  });
});
