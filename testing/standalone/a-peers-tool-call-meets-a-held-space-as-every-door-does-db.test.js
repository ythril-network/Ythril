/**
 * A peer's tool call meets a held space exactly as a peer's sync request does: refused AND counted when it is held, admitted AND counted by the
 * fence while it runs when it is not (bundle-106 PR A, the duplicate-rule sweep of the diff).
 *
 * ## What was true before
 *
 * The sync doors and the rights doors answer a peer that meets a held space through one rule: count the refusal in
 * `ythril_space_held_refusals_total`, answer `423 space_held`, and admit anything that is not held as a transfer of the space, counted in the fence
 * until it ends, so an act registered meanwhile waits for it. The tool dispatch (`/mcp` and `POST /api/<tool>`) had its own copy of the first
 * half only: it refused without counting and admitted without entering the fence. So a peer's `recall` of a space could be reading while a wipe of that
 * space began deleting it, and the metric an operator watches for held peers under-counted every refusal this door made.
 *
 * ## What holds now
 *
 * - a peer token naming a held space in an MCP call is refused, and that refusal is one more in `ythril_space_held_refusals_total`;
 * - a peer token naming a free space is admitted, and `spaceTransfersRunning` of that space is one while the tool's handler runs and zero after the call
 *   ends, however it ends (an answer, a handler that throws);
 * - an instance-admin token is the operator's own tooling: neither refused nor counted in the fence.
 *
 * ## How it is driven
 *
 * The REAL application over a loopback socket, a real peer token and the real MCP transport. The fence is read from inside the handler: the tool's `handle` is
 * wrapped for the length of one test and put back afterwards, so the count is read while the call is in flight, not inferred from its answer.
 *
 * ## Seen red
 *
 * Before the fold, at 72f2a5d3: the refusal row sees no increment of the counter, and the admitted rows read zero from inside the handler.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-peers-tool-call-meets-a-held-space-as-every-door-does-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { listenOnLoopback } from '../_shared/local-server.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const HELD = 'toolheld';
const FREE = 'toolfree';
const HOUR = 3_600_000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();

let door, loader, server, peerKey, adminKey, fence, metrics, tools;

const wipeRound = () => ({
  roundId: 'tm-w', type: 'space_wipe', spaceId: HELD, subjectInstanceId: door.instanceId, subjectLabel: 'x', subjectUrl: '',
  openedAt: iso(NOW - HOUR), deadline: iso(NOW + 23 * HOUR), votes: [{ instanceId: door.instanceId, vote: 'yes', castAt: iso(NOW - HOUR) }],
  concluded: true, passed: true, appliedHere: true, proposedHere: true,
});

async function mcp(key, name, args) {
  const r = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }),
  });
  const raw = await r.text();
  const data = raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
  const rpc = JSON.parse(data);
  return { isError: rpc.result?.isError === true, text: (rpc.result?.content ?? []).map(c => c.text ?? '').join('\n') };
}

/** Every refusal the counter holds, across doors: the one number an operator reads. */
async function refusalsCounted() {
  const { values } = await metrics.spaceHeldRefusalsTotal.get();
  return values.reduce((n, v) => n + v.value, 0);
}

/** Run `fn` with the recall tool's handler reading the fence of `space` from inside the call; the handler is put back afterwards. */
async function withFenceProbe(space, fn, { throws = false } = {}) {
  const tool = tools.TOOLS_BY_NAME.get('recall');
  const original = tool.handle;
  const seen = [];
  tool.handle = async () => {
    seen.push(fence.spaceTransfersRunning(space));
    if (throws) throw new Error('the handler failed');
    // The real recall would wait on a vector search this stack does not have; the fence is what is under test.
    return { content: [{ type: 'text', text: 'probe' }] };
  };
  try { await fn(); } finally { tool.handle = original; }
  return seen;
}

describe('a peer\'s tool call meets a held space as every door does', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'toolheld', spaces: [HELD, FREE], type: 'club', direction: 'both', files: true });
    loader = await import('../../server/dist/config/loader.js');
    fence = await import('../../server/dist/sync/space-transfer-fence.js');
    metrics = await import('../../server/dist/metrics/registry.js');
    tools = await import('../../server/dist/mcp/tools/index.js');
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({ name: 'peer', peerInstanceId: PEER, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [HELD]: area, [FREE]: area } } })).plaintext;
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    const { createApp } = await import('../../server/dist/app.js');
    server = await listenOnLoopback(http.createServer(createApp()));
  });
  after(async () => { await server?.close(); await door?.close(); });

  beforeEach(async () => {
    await door.reset();
    loader.mutateConfig((cfg) => { const net = cfg.networks.find(n => n.id === door.NET); net.pendingRounds = [wipeRound()]; net.spaces = [HELD, FREE]; });
  });

  it('a peer token naming the held space is refused and the refusal is counted', async () => {
    const before = await refusalsCounted();
    const r = await mcp(peerKey, 'recall', { query: 'hello', space: HELD });
    assert.ok(r.isError && /held/i.test(r.text), `MCP answered a peer's recall of a held space with: ${r.isError ? 'error' : 'result'} ${r.text.slice(0, 160)}`);
    assert.equal(await refusalsCounted() - before, 1, 'the tool door refused a peer for a held space and the refusals counter did not move');
  });

  it('a peer token naming a free space is admitted: the fence counts the call while its handler runs, and is empty after it', async () => {
    let answer;
    const seen = await withFenceProbe(FREE, async () => { answer = await mcp(peerKey, 'recall', { query: 'hello', space: FREE }); });
    assert.deepEqual(seen, [1], `the handler ran ${seen.length} time(s) and read the fence of '${FREE}' as ${JSON.stringify(seen)}: a peer's admitted tool call was not counted while it ran, so an act registered meanwhile would delete under it`);
    assert.ok(answer, 'no answer');
    assert.equal(fence.spaceTransfersRunning(FREE), 0, 'the fence still counts the call after it ended');
  });

  it('the count is released when the handler throws', async () => {
    const seen = await withFenceProbe(FREE, async () => { await mcp(peerKey, 'recall', { query: 'hello', space: FREE }); }, { throws: true });
    assert.deepEqual(seen, [1], 'the handler did not run inside the fence');
    assert.equal(fence.spaceTransfersRunning(FREE), 0, 'a handler that threw left its count in the fence: every later act on the space would wait for it');
  });

  it('an instance-admin token is the operator\'s own tooling: not refused, not counted', async () => {
    const before = await refusalsCounted();
    const seen = await withFenceProbe(HELD, async () => {
      const r = await mcp(adminKey, 'recall', { query: 'hello', space: HELD });
      assert.ok(!/space_held|is held/i.test(r.text), `an admin token was held as if it were the exchange: ${r.text.slice(0, 160)}`);
    });
    assert.deepEqual(seen, [0], 'an admin token\'s call was counted in the fence as a peer transfer');
    assert.equal(await refusalsCounted(), before, 'an admin token\'s call moved the held-refusals counter');
  });
});
