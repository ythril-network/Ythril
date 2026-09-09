/**
 * The two sync doors, against a live instance — because until this file they had none.
 *
 * `Q-21` gave each subject a door that says what it is: `POST /api/networks/:id/sync` for a network,
 * `POST /api/networks/peers/:peerId/sync` for one peer across every network it belongs to. Both were
 * driven by hand on a scratch instance before shipping and by nothing afterwards, which is the state this
 * repository has a rule about: a path exercised once by a person is not covered.
 *
 * ## What is worth asserting here rather than in a source-reading gate
 *
 * Three things, and none of them is visible from the source:
 *
 *  - **`ok` is still in the answer.** The UI's "Sync now" banner colours itself from `r.ok`, and enriching
 *    the response nearly dropped it — every SUCCESSFUL sync would have rendered "failed", with nothing
 *    failing anywhere, because an absent field is merely `undefined` to a typed client. A gate reading the
 *    handler cannot see that; a request can.
 *  - **The peer door is not shadowed by the network door.** `/api/networks/peers/x/sync` also matches
 *    `/api/networks/:id/sync` as a string, so whether Express routes it to the right handler is a fact
 *    about registration ORDER and pattern specificity, not about either handler.
 *  - **Both refuse an unprivileged token.** `/api/notify/trigger` accepted any valid token until 4.4
 *    precisely because no test asked, and the source gate that should have caught it was told to look away
 *    by a router-wide exemption.
 *
 * ## Why an unknown subject is the fixture
 *
 * Triggering a real cycle needs peers that answer, and the assertions here are about the DOOR rather than
 * about replication — which the sync suites already cover end to end. An unknown network and an unknown
 * peer give a deterministic answer from each path without depending on anything being reachable.
 *
 * Run: node --test testing/integration/sync-doors.test.js   (needs the test stack: npm run test:up)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const MISSING_NET = `no-such-network-${RUN}`;
const MISSING_PEER = `no-such-peer-${RUN}`;

describe('the sync doors say what they sync', () => {
  let tokenA;
  let nobody;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // A token with NOTHING: not an instance admin, every area `none`, no spaces. This is the exact shape
    // that reached `POST /api/notify/trigger` and got `200 {"status":"triggered"}` before 4.4.
    const minted = await post(INSTANCES.a, tokenA, '/api/tokens', {
      name: `sync-doors-nobody-${RUN}`,
      rights: {
        instanceAdmin: false, createSpaces: false,
        floor: { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none' },
        perSpace: {},
      },
    });
    assert.equal(minted.status, 201, `could not mint the no-rights token: ${JSON.stringify(minted.body)}`);
    nobody = minted.body.plaintext;
    assert.ok(nobody, 'the mint returned no plaintext — the fixture is wrong, not the code');
  });

  describe('the network door', () => {
    it('404s a network that does not exist', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${MISSING_NET}/sync`, {});
      assert.equal(r.status, 404, JSON.stringify(r.body));
    });

    it('refuses a token with no rights at all', async () => {
      const r = await post(INSTANCES.a, nobody, `/api/networks/${MISSING_NET}/sync`, {});
      assert.equal(r.status, 403, `a no-rights token reached the network sync door: ${JSON.stringify(r.body)}`);
    });
  });

  describe('the peer door', () => {
    it('404s a peer that is a member of no network, and names the id', async () => {
      // The SEC-16 check: an unvalidated id becomes the address the sync engine connects to, so it is
      // matched against the configured members rather than parsed or trusted.
      const r = await post(INSTANCES.a, tokenA, `/api/networks/peers/${MISSING_PEER}/sync`, {});
      assert.equal(r.status, 404, JSON.stringify(r.body));
      assert.match(r.body.error, new RegExp(MISSING_PEER), 'the refusal must name the id it rejected');
    });

    it('is NOT shadowed by the network door', async () => {
      /*
       * `/api/networks/peers/x/sync` also matches `/api/networks/:id/sync` with `peers` as the id. Both
       * handlers answer 404, so the STATUS cannot tell them apart — only the reason can.
       *
       * The test for that is which message came back, and not the absence of the word "network": the peer
       * refusal reads "peerId 'x' is not a registered member in any network", so a `doesNotMatch(/network/)`
       * fails on the correct answer. It did, first time.
       */
      const r = await post(INSTANCES.a, tokenA, `/api/networks/peers/${MISSING_PEER}/sync`, {});
      assert.notEqual(r.body.error, 'Network not found',
        'the network handler answered a peer path — check the route registration order');
      assert.match(r.body.error ?? '', /peerId/,
        'the peer handler names the argument it rejected; the network handler does not know about it');
    });

    it('refuses a token with no rights at all', async () => {
      const r = await post(INSTANCES.a, nobody, `/api/networks/peers/${MISSING_PEER}/sync`, {});
      assert.equal(r.status, 403, `a no-rights token reached the peer sync door: ${JSON.stringify(r.body)}`);
    });
  });

  describe('the answer shape is the same on every door', () => {
    it('carries `ok` beside `status`, which is what the UI colours its banner from', async () => {
      // Dropping `ok` while enriching the response would make every successful sync render as "failed",
      // and nothing would fail: the client types the field it wants and an absent one is `undefined`.
      const r = await post(INSTANCES.a, tokenA, `/api/notify/trigger`, { networkId: MISSING_NET });
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true, '`ok` is gone from the fire-and-forget answer');
      assert.equal(r.body.status, 'triggered');
    });

    it('and reports `ok: false` when a waited cycle fails', async () => {
      const r = await post(INSTANCES.a, tokenA, `/api/notify/trigger?wait=true`, { networkId: MISSING_NET });
      assert.equal(r.status, 500, JSON.stringify(r.body));
      assert.equal(r.body.ok, false, '`ok` must disagree with the success case, or it says nothing');
      assert.equal(r.body.status, 'error');
    });
  });

  describe('the deprecated door still works', () => {
    it('refuses a token with no rights, as it has since 4.4', async () => {
      const r = await post(INSTANCES.a, nobody, '/api/notify/trigger', { networkId: MISSING_NET });
      assert.equal(r.status, 403, `the deprecated trigger accepted a no-rights token: ${JSON.stringify(r.body)}`);
    });

    it('refuses both subjects at once, because they name different things', async () => {
      const r = await post(INSTANCES.a, tokenA, '/api/notify/trigger',
        { networkId: MISSING_NET, peerId: MISSING_PEER });
      assert.equal(r.status, 400, JSON.stringify(r.body));
    });
  });
});
