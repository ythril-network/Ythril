/**
 * A space's in-flight transfer count returns to zero when its transfer ENDS BY ANY ROAD - an outbound turn that throws, an inbound client that
 * walks away mid-stream (bundle-106 R-X9b; design v5 section 3.3a, X9, REL F11).
 *
 * ## What it prevents
 *
 * An act that is registered for a space waits for the space's admitted transfers to end (`awaitSpaceTransfersDrained`), and the count it waits on is
 * kept by `enterSpaceTransfer` / `release`. A count that is released only on the success path leaks one per failure: the first turn that threw
 * (`engine.ts` throws on `incomplete`) or the first client that closed a stream early would leave the count above zero for ever, and every later wipe
 * or deletion of that space would wait on a transfer that no longer exists - `draining`, forever, with nothing wrong to report.
 *
 * ## What holds now
 *
 * - **Outbound:** a turn that throws releases in a `finally`. Driven with a peer that answers its page `500` (the sender throws on the incomplete
 *   transfer): after the cycle `spaceTransfersRunning(space) === 0`.
 * - **Inbound:** a peer's file download that the CLIENT abandons mid-stream is released on the response's close. Driven over a real socket through the
 *   real application (`createApp`, a peer token, the real auth and rung layers): the stream is held open by backpressure (the client has stopped
 *   reading), the count is read as ONE while it is open, the client destroys the connection, and the count returns to zero.
 *
 * ## The positive twin of each zero
 *
 * A zero read after the transfer proves nothing unless the count was one while it ran. Each row reads the count INSIDE the transfer (the fake peer's
 * handler, which runs while the turn is in flight; the open stream) and requires it to be at least one; the outbound row also runs the same cycle
 * against a peer that answers normally. No sleep and no timestamp: the abandon waits on the count itself, bounded.
 *
 * ## Seen red
 *
 * On the base `sync/space-transfer-fence.ts` does not exist: both rows fail for that. After the fix, by hand: move the outbound release out of the
 * `finally` -> the throwing-turn row red; release the inbound transfer only when the handler returns -> the stream row red (it stays at one while
 * the stream is open and is released at the close).
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-transfer-is-counted-until-it-ends-whatever-ends-it-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { requireFence } from './_round-open-fixtures.mjs';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER, PEER_AUTHOR } from './_pull-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const SPACE = 'transfercount';

let door, loader, engine, fence, server, peerKey;

/** The fence module, or a failure naming the design's file: a row that needs it is red for ITS absence. */

describe('a transfer is counted until it ends, whatever ends it', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'transfercount', spaces: [SPACE], type: 'club', direction: 'both', files: true });
    loader = await import('../../server/dist/config/loader.js');
    engine = await import('../../server/dist/sync/engine.js');
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({ name: 'peer', peerInstanceId: PEER, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [SPACE]: area } } })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
  });
  after(async () => { await server?.close(); await door?.close(); });

  beforeEach(async () => {
    await door.reset();
    loader.mutateConfig((cfg) => { const net = cfg.networks.find(n => n.id === door.NET); net.pendingRounds = []; net.spaces = [SPACE]; net.members[0].consecutiveFailures = 0; });
    await door.seedPeerRecords(SPACE, 'facts', [build.fact(SPACE, `${SPACE}-f`, 5, { author: PEER_AUTHOR })]);
  });

  /** One real cycle through the network runner; the count the peer's handler read while a request of the turn was in flight is `inFlight`. */
  async function cycle(answer) {
    const inFlight = [];
    door.state.family = async (req, res, family) => {
      if (req.query.spaceId === SPACE) inFlight.push(fence.spaceTransfersRunning(SPACE));
      await answer(req, res, family);
    };
    const out = await engine.runSyncForNetwork(door.NET);
    await door.settled();
    return { out, inFlight };
  }

  it('twin: an outbound turn that completes counts at least one while it runs and none after', async () => {
    fence = await requireFence();
    const { out, inFlight } = await cycle((req, res, family) => door.serveFamily(req, res, family));
    assert.equal(out.errors, 0, `the control cycle failed: ${JSON.stringify(out)}`);
    assert.ok(inFlight.length > 0 && inFlight.every(n => n >= 1), `the fence did not count the turn while it ran (read ${JSON.stringify(inFlight)}): a zero afterwards proves nothing`);
    assert.equal(fence.spaceTransfersRunning(SPACE), 0, 'a completed turn left its count standing');
  });

  it('R-X9b outbound: a turn that THROWS (the peer answers its page 500) releases its count', async () => {
    fence = await requireFence();
    const { out, inFlight } = await cycle((req, res) => { res.status(500).json({ error: 'the peer failed' }); });
    assert.ok(out.errors > 0, `the turn did not throw, so the row exercises nothing: ${JSON.stringify(out)}`);
    assert.ok(inFlight.length > 0 && inFlight.every(n => n >= 1), `the fence did not count the turn while it ran (read ${JSON.stringify(inFlight)})`);
    assert.equal(fence.spaceTransfersRunning(SPACE), 0, 'a turn that threw left its count standing: every later act on this space would wait for a transfer that is gone');
  });

  it('R-X9b inbound: a peer\'s download the client abandons mid-stream is counted while it is open and released at the close', async () => {
    fence = await requireFence();
    const files = await import('../../server/dist/files/files.js');
    await files.writeFileBytes(SPACE, 'big.bin', Buffer.alloc(48 * 1024 * 1024, 7));
    // The client reads the headers and then stops reading: the server's stream is held open by backpressure, not by a timer.
    const res = await new Promise((resolve, reject) => {
      const req = http.get(`${server.url}/api/files/${SPACE}?path=big.bin`, { headers: { Authorization: `Bearer ${peerKey}` } }, resolve);
      req.once('error', reject);
    });
    assert.equal(res.statusCode, 200, `the peer's download answered ${res.statusCode}: the stream the row abandons never opened`);
    res.pause();
    await waitFor(() => fence.spaceTransfersRunning(SPACE) >= 1, 10_000, 20, undefined, { what: 'the open inbound stream counted as a transfer of its space' });
    assert.equal(fence.spaceTransfersRunning(SPACE), 1, 'one stream, counted once');
    res.destroy();
    await waitFor(() => fence.spaceTransfersRunning(SPACE) === 0, 10_000, 20, undefined, { what: 'the abandoned stream released' });
  });
});
