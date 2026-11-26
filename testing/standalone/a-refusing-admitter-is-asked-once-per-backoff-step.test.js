/**
 * A member that refuses the schema is not asked again for a backoff, doubling to a day (`Q-966`, review F8).
 *
 * A refusal of the network's schema (a 403 `schema_rung`, a missing door, a layer the reader refuses) is as permanent as the member's rights are:
 * the heal asked again every cycle, and warned every cycle, for as long as the member stayed in the network. A refusal is now recorded against
 * that member and space, and not asked again until its backoff ends: ten minutes, then doubling, never more than a day. A member that answers is
 * forgotten, so a right granted later is found at the first ask after the backoff.
 *
 * The peer is a real HTTP listener that refuses with 403; the clock is node's own mock of `Date`, ticked, so no test waits for a backoff.
 *
 * Run: node --test testing/standalone/a-refusing-admitter-is-asked-once-per-backoff-step.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after, mock } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { listenOnPrivateAddress } from '../_shared/local-server.mjs';
import { privateHostAddress, privateAddressSkipReason } from './_private-address.mjs';

process.env['SYNC_ALLOW_PRIVATE_PEERS'] = 'true';
const skip = privateAddressSkipReason();
const MIN = 60_000;
const HOUR = 60 * MIN;

let door;
let asks = 0;
/** What the door answers: a 403 refusal, or a 200 whose layer the reader refuses whole (a validation mode that does not exist). */
let answer = 'forbidden';
let fetchNetworkLayer;

before(async () => {
  if (skip) return;
  ({ fetchNetworkLayer } = await import('../../server/dist/sync/space-meta-pull.js'));
  door = await listenOnPrivateAddress(http.createServer((req, res) => {
    if (!String(req.url).startsWith('/api/sync/meta')) { res.statusCode = 404; res.end(); return; }
    asks += 1;
    res.setHeader('content-type', 'application/json');
    if (answer === 'malformed') {
      res.statusCode = 200;
      res.end(JSON.stringify({ meta: { validationMode: 'sideways' }, network: { validationMode: 'sideways' }, networkSeeded: true }));
      return;
    }
    res.statusCode = 403;
    res.end(JSON.stringify({ error: 'the token may not read this space\'s schema', code: 'schema_rung' }));
  }), privateHostAddress());
  mock.timers.enable({ apis: ['Date'], now: Date.now() });
});

after(async () => {
  mock.timers.reset();
  await door?.close();
});

/** One ask of the admitter `memberId` for `space` of network `net`, as the heal makes it. */
const ask = (net, memberId, space) => fetchNetworkLayer({
  networkId: net, peerUrl: door.url, from: `member ${memberId}`, spaceId: space, remoteSpaceId: space,
  init: { headers: { Authorization: 'Bearer t' } }, voted: true, memberId,
});

describe('a member that refuses the network\'s schema', { skip }, () => {
  before(() => { answer = 'forbidden'; });

  it('is asked once, not again within ten minutes, and again after them', async () => {
    asks = 0;
    await ask('net-f8-a', 'm1', 'space-1');
    assert.equal(asks, 1, 'the first ask must go out');
    mock.timers.tick(MIN);
    await ask('net-f8-a', 'm1', 'space-1');
    assert.equal(asks, 1, 'a refusal was asked again after one minute');
    mock.timers.tick(10 * MIN);
    await ask('net-f8-a', 'm1', 'space-1');
    assert.equal(asks, 2, 'the backoff ended and the member was not asked');
  });

  it('doubles the wait at each refusal', async () => {
    asks = 0;
    await ask('net-f8-b', 'm1', 'space-1');
    mock.timers.tick(10 * MIN);
    await ask('net-f8-b', 'm1', 'space-1');
    assert.equal(asks, 2);
    mock.timers.tick(19 * MIN);
    await ask('net-f8-b', 'm1', 'space-1');
    assert.equal(asks, 2, 'the second backoff is shorter than twenty minutes');
    mock.timers.tick(MIN);
    await ask('net-f8-b', 'm1', 'space-1');
    assert.equal(asks, 3, 'the second backoff is longer than twenty minutes');
  });

  it('never waits more than a day', async () => {
    asks = 0;
    for (let i = 0; i < 14; i++) {
      await ask('net-f8-c', 'm1', 'space-1');
      mock.timers.tick(24 * HOUR);
    }
    assert.equal(asks, 14, 'after a day the member is asked again, however often it refused');
  });

  it('is remembered per member and per space: another space, another member and another network are asked at once', async () => {
    asks = 0;
    await ask('net-f8-d', 'm1', 'space-1');
    await ask('net-f8-d', 'm1', 'space-2');
    await ask('net-f8-d', 'm2', 'space-1');
    await ask('net-f8-e', 'm1', 'space-1');
    assert.equal(asks, 4);
    await ask('net-f8-d', 'm1', 'space-1');
    assert.equal(asks, 4, 'the refused member and space were asked again at once');
  });
});

describe('a member that answers with a layer the reader refuses whole', { skip }, () => {
  before(() => { answer = 'malformed'; });
  after(() => { answer = 'forbidden'; });

  it('is asked again after ten minutes, then after twenty, never at once, and the wait doubles', async () => {
    asks = 0;
    await ask('net-n5-a', 'm1', 'space-1');
    assert.equal(asks, 1, 'the first ask must go out');
    mock.timers.tick(MIN);
    await ask('net-n5-a', 'm1', 'space-1');
    assert.equal(asks, 1, 'a refused layer was asked again after one minute');
    mock.timers.tick(10 * MIN);
    await ask('net-n5-a', 'm1', 'space-1');
    assert.equal(asks, 2, 'the first backoff ended and the member was not asked');
    mock.timers.tick(10 * MIN);
    await ask('net-n5-a', 'm1', 'space-1');
    assert.equal(asks, 2, 'a malformed layer was asked again after ten minutes the second time: the wait never doubled');
    mock.timers.tick(10 * MIN);
    await ask('net-n5-a', 'm1', 'space-1');
    assert.equal(asks, 3, 'the second backoff (twenty minutes) ended and the member was not asked');
  });
});
