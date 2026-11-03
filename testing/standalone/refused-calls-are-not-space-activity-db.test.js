/**
 * A call the guard refused, or one for a space that does not exist, is not activity (Q-606).
 *
 * ## The rule
 *
 * The per-space counters key on the path segment of the request, and the audit middleware that feeds them runs before every guard, so until
 * now `GET /api/brain/spaces/<anything>/stats` made a pending counter for `<anything>` whatever the answer was: 401 to a caller with no
 * credential, 403 to one with no rights, a 404, a 429. The flush then stored a document per distinct string for 90 days and the admin
 * overview listed it. A refused caller is not use of a space (`04d-brain-ops-api.md`: an empty space must not gain activity).
 *
 * A call is counted when it was AUTHENTICATED (the request carries a token or a view read) and the answer is neither 403 nor 429, AND the
 * space it named is configured. Anything else leaves the counters alone; the audit row is written either way.
 *
 * ## How it is driven
 *
 * The real application (`appRouter`) behind a loopback server, real tokens, the harness Mongo; the counters read through
 * `peekSpaceActivity` (the module the application writes to), after a control request so every earlier response has finished.
 * Written red on d079607b3.
 *
 * Run: a Mongo the harness accepts, then `node --test testing/standalone/refused-calls-are-not-space-activity-db.test.js`
 * (a prior `npm run build:server`).
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openToolDoor } from './_tool-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { appRouter } from '../_shared/in-process-app.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = await mongoSkipReason();
const SPACE = 'activitychain';
const OTHER = 'activityother';
const area = (rung) => ({ knowledge: rung, files: rung, schema: rung, dataQuality: rung, networks: 'none' });

let door, loader, tokens, server, base, app, activity, store, admin, outsider, metered;

const facts = (id, bearer) => fetch(`${base}/api/brain/spaces/${encodeURIComponent(id)}/stats`, bearer ? { headers: { Authorization: `Bearer ${bearer}` } } : {});
const rowsOf = (space) => activity.peekSpaceActivity().filter(r => r.space === space);
const calls = (space) => rowsOf(space).reduce((n, r) => n + r.totals.n, 0);
/** A request the application counts, so every response sent before it has run its `finish` handler. */
async function settle() {
  const before = calls(SPACE);
  const r = await facts(SPACE, admin.plaintext);
  assert.equal(r.status, 200, `fixture check: the control read was answered ${r.status}`);
  await waitFor(() => calls(SPACE) !== before, 2_000, 10, undefined, { what: 'the control read to be counted' });
  assert.equal(calls(SPACE), before + 1, 'fixture check: the control read was not counted');
}

describe('a refused call, or one for an unknown space, is not space activity (real routes, real MongoDB)', { skip }, () => {
  before(async () => {
    delete process.env['SKIP_GLOBAL_RATE_LIMIT'];
    process.env['SKIP_AUTH_RATE_LIMIT'] = 'true';
    door = await openToolDoor({ suite: 'activitychain', spaces: [{ id: SPACE, label: 'Chain', folders: [] }, { id: OTHER, label: 'Other', folders: [] }] });
    loader = await import('../../server/dist/config/loader.js');
    tokens = await import('../../server/dist/auth/tokens.js');
    activity = await import('../../server/dist/metrics/space-activity.js');
    store = await import('../../server/dist/metrics/space-activity-store.js');
    admin = await tokens.createToken({ name: 'chain-admin', admin: true });
    outsider = await tokens.createToken({ name: 'chain-outsider', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [OTHER]: area('admin') } } });
    metered = await tokens.createToken({ name: 'chain-metered', rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: area('read') } }, rateLimitPerMinute: 1 });
    app = await appRouter();
    server = await listenOnLoopback(http.createServer((req, res) => { app.router(req, res); }));
    base = server.url;
    activity.drainSpaceActivity();
  });
  after(async () => {
    await server?.close();
    await app?.close();
    await door?.close();
  });

  it('control: an authenticated read of a configured space is counted', async () => {
    activity.drainSpaceActivity();
    await settle();
    assert.equal(calls(SPACE), 1);
  });

  it('a request with no credential for an unknown space makes no key (401)', async () => {
    activity.drainSpaceActivity();
    const ids = Array.from({ length: 10 }, (_, i) => `invented-${i}`);
    for (const id of ids) assert.equal((await facts(id)).status, 401);
    await settle();
    assert.deepEqual(activity.peekSpaceActivity().map(r => r.space).filter(s => s !== SPACE), [], 'an unauthenticated request minted a counter for an id it made up');
  });

  it('a request with no credential for a configured space does not count (401)', async () => {
    activity.drainSpaceActivity();
    assert.equal((await facts(SPACE)).status, 401);
    await settle();
    assert.equal(calls(SPACE), 1, 'a refused caller was counted as use of the space (only the control read is use)');
  });

  it('a token with no rights on the space does not count (403)', async () => {
    activity.drainSpaceActivity();
    const r = await facts(SPACE, outsider.plaintext);
    assert.ok(r.status === 403 || r.status === 404, `fixture check: the outsider was answered ${r.status}`);
    await settle();
    assert.equal(calls(SPACE), 1, `a call answered ${r.status} was counted as use of the space`);
  });

  it('an authenticated call for a space that does not exist makes no key (404)', async () => {
    activity.drainSpaceActivity();
    const r = await facts('no-such-space-at-all', admin.plaintext);
    assert.equal(r.status, 404, `fixture check: the unknown space was answered ${r.status}`);
    await settle();
    assert.deepEqual(activity.peekSpaceActivity().map(x => x.space).filter(s => s !== SPACE), [], 'a made-up id was counted as a space');
  });

  it('a call the rate limit refused does not count (429)', async () => {
    activity.drainSpaceActivity();
    const answers = [];
    for (let i = 0; i < 4; i++) answers.push((await facts(SPACE, metered.plaintext)).status);
    assert.equal(answers[0], 200, `fixture check: the first metered read was answered ${answers[0]}`);
    assert.ok(answers.includes(429), `fixture check: the per-token limit of 1 a minute never refused: ${answers}`);
    await settle();
    const admitted = answers.filter(s => s === 200).length;
    assert.equal(calls(SPACE), admitted + 1,
      `the space shows ${calls(SPACE)} calls for ${admitted} admitted metered reads and the control (answers ${answers}): a 429 was counted`);
  });

  describe('the admin overview lists configured spaces only', () => {
    it('a stored row of an id the config no longer holds (the tail an earlier release left) is not shown', async () => {
      loader.mutateConfig((cfg) => { cfg.spaces.push({ id: 'ghost-tail', label: 'ghost', folders: [], meta: {} }); });
      activity.drainSpaceActivity();
      activity.recordSpaceCall('ghost-tail', 'read', { ms: 1 });
      activity.recordSpaceCall(SPACE, 'read', { ms: 1 });
      await store.flushSpaceActivity(Date.now());
      loader.mutateConfig((cfg) => { cfg.spaces = cfg.spaces.filter(s => s.id !== 'ghost-tail'); });
      const r = await fetch(`${base}/api/admin/space-activity?hours=24`, { headers: { Authorization: `Bearer ${admin.plaintext}` } });
      assert.equal(r.status, 200);
      const ids = (await r.json()).spaces.map(s => s.space);
      assert.ok(ids.includes(SPACE), `fixture check: the configured space is not in the overview: ${ids}`);
      assert.ok(!ids.includes('ghost-tail'), `the overview lists an id no space has: ${ids}`);
    });
  });
});
