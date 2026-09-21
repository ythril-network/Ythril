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
 *  - **Both refuse an unprivileged token.** The route these replaced accepted any valid token until 4.4
 *    precisely because no test asked, and the source gate that should have caught it was told to look away
 *    by a router-wide exemption. That route is removed in 5.0, and the last case here proves it is GONE
 *    rather than merely undocumented — a deletion and a route left mounted under a different guard read
 *    the same from the source, and differently from outside.
 *
 * ## Why an unknown subject is the fixture
 *
 * Triggering a real cycle needs peers that answer, and the assertions here are about the DOOR rather than
 * about replication — which the sync suites already cover end to end. An unknown network and an unknown
 * peer give a deterministic answer from each path without depending on anything being reachable.
 *
 * Run: node --test testing/integration/sync-doors.test.js   (needs the test stack: npm run test:up)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const MISSING_NET = `no-such-network-${RUN}`;
const MISSING_PEER = `no-such-peer-${RUN}`;

describe('the sync doors say what they sync', () => {
  let tokenA;
  let nobody;
  /*
   * A REAL network, because the answer-shape cases below cannot use an unknown one.
   *
   * They did, inherited from the route this replaced: `POST /api/notify/trigger` accepted any id and
   * answered 200 fire-and-forget, so an unknown network was a free deterministic fixture. The network door
   * VALIDATES ITS SUBJECT FIRST and answers 404 — which this file's own first case already asserted, and
   * which is the improvement. Its one member is deliberately unreachable: a cycle that reaches nobody is
   * still a cycle, and nothing here is about replication.
   */
  let networkId;

  before(async () => {
    tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
    // A token with NOTHING: not an instance admin, every area `none`, no spaces. This is the exact shape
    // that reached the retired `POST /api/notify/trigger` and got `200 {"status":"triggered"}` before 4.4.
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

    const net = await post(INSTANCES.a, tokenA, '/api/networks', {
      label: `sync-doors ${RUN}`, type: 'braintree', spaces: ['general'], votingDeadlineHours: 1,
    });
    assert.equal(net.status, 201, `could not create the fixture network: ${JSON.stringify(net.body)}`);
    networkId = net.body.id;
    const member = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/members`, {
      instanceId: `sync-doors-peer-${RUN}`, label: 'unreachable on purpose',
      url: 'http://sync-doors-peer.internal:3200', token: 'ythril_sync_doors_peer_token', direction: 'push',
    });
    assert.equal(member.status, 201, `could not add the fixture member: ${JSON.stringify(member.body)}`);
  });

  after(async () => {
    if (networkId) await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
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
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync`, {});
      assert.equal(r.status, 200, JSON.stringify(r.body));
      assert.equal(r.body.ok, true, '`ok` is gone from the fire-and-forget answer');
      assert.equal(r.body.status, 'triggered');
      assert.equal(r.body.networkId, networkId, 'the answer must echo the subject it acted on');
    });

    it('and `ok` AGREES with the outcome rather than being a constant', async () => {
      /*
       * THE FAILURE BRANCHES CANNOT BE REACHED DETERMINISTICALLY THROUGH THIS DOOR ANY MORE, and that is
       * the improvement rather than a hole. `notify-trigger-wait.test.js` produced `ok: false` by waiting
       * on a cycle for an unknown network — the old route accepted the id and the cycle threw. This door
       * refuses the id first, so the only remaining failures are a genuine throw and the timeout race,
       * neither of which a test can force without making itself flaky.
       *
       * So the case asserts the CONTRACT instead: `ok` is the one-bit summary of the HTTP outcome, in
       * whichever branch the cycle lands. A hard-coded `ok: true` on the 504 and 500 branches — the defect
       * this describe block exists for — breaks it.
       */
      const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/sync?wait=true&timeoutMs=1000`, {});
      assert.equal(typeof r.body.ok, 'boolean', `\`ok\` is missing from the waited answer: ${JSON.stringify(r.body)}`);
      assert.equal(r.body.ok, r.status === 200,
        `\`ok\` says ${r.body.ok} and the status is ${r.status}: ${JSON.stringify(r.body)}`);
      assert.ok(['completed', 'timeout', 'error'].includes(r.body.status),
        `unexpected waited status: ${JSON.stringify(r.body)}`);
    });
  });

  describe('and the door they replaced is GONE', () => {
    it('`POST /api/notify/trigger` is not served at all', async () => {
      /*
       * Asserted with a REQUEST rather than by reading the router, because the two answers a deletion can
       * produce look alike from the source and not from outside. `notifyRouter` still exists and still
       * serves `POST /api/notify`, so an unmatched sub-path falls through to the 404 handler — while a
       * route left mounted under a different guard would answer 401 or 403 and read, to anyone checking,
       * as "still there and protected".
       *
       * Sent with an ADMIN token on purpose: a no-rights token would be refused before routing on many
       * paths, so a 403 would prove nothing about whether the route exists.
       */
      const r = await post(INSTANCES.a, tokenA, '/api/notify/trigger', { networkId: MISSING_NET });
      assert.equal(r.status, 404, `the removed trigger still answers: ${JSON.stringify(r.body)}`);
    });
  });
});
