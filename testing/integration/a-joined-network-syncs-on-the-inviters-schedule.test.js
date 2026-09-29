/**
 * A joined network syncs on its own, on both doors (`Q-137`).
 *
 * The join registered the joiner's network with no schedule, which means manual-only: a subscriber never pulled, and
 * depended on the publisher pushing everything. The inviter's apply answer now carries its schedule and the joiner
 * adopts it; a schedule the caller states wins, and one the door would refuse is refused before any network exists.
 *
 * Run: node --test testing/integration/a-joined-network-syncs-on-the-inviters-schedule.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, del, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `q137-${RUN}`;
const INVITERS = '*/7 * * * *';

let adminA, adminB, mcpB;
const cleanup = { a: [], b: [] };

before(async () => {
  adminA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  adminB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  for (const [inst, tok] of [[INSTANCES.a, adminA], [INSTANCES.b, adminB]]) {
    const r = await post(inst, tok, '/api/spaces', { id: SPACE, label: SPACE });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  }
  mcpB = await openMcpSession(adminB, INSTANCES.b);
});

after(async () => {
  await mcpB?.close?.();
  for (const id of cleanup.a) await del(INSTANCES.a, adminA, `/api/networks/${id}`).catch(() => {});
  for (const id of cleanup.b) await del(INSTANCES.b, adminB, `/api/networks/${id}`).catch(() => {});
  await delWithBody(INSTANCES.a, adminA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, adminB, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

/** A closed network on A syncing every seven minutes, and an invite for B as B reaches A over the Docker network. */
async function invite(schedule = INVITERS) {
  const n = await post(INSTANCES.a, adminA, '/api/networks', {
    label: `q137-${RUN}-${cleanup.a.length}`, type: 'closed', spaces: [SPACE], votingDeadlineHours: 1,
    ...(schedule !== null ? { syncSchedule: schedule } : {}),
  });
  assert.equal(n.status, 201, JSON.stringify(n.body));
  cleanup.a.push(n.body.id);
  const gen = await post(INSTANCES.a, adminA, '/api/invite/generate', { networkId: n.body.id });
  assert.equal(gen.status, 201, JSON.stringify(gen.body));
  return { handshakeId: gen.body.handshakeId, inviteUrl: 'http://ythril-a:3200/api/invite/apply',
    rsaPublicKeyPem: gen.body.rsaPublicKeyPem, networkId: n.body.id, myUrl: 'http://ythril-b:3200' };
}
const scheduleOnB = async (networkId) => (await get(INSTANCES.b, adminB, `/api/networks/${networkId}`)).body?.syncSchedule;

describe('a joiner that states no schedule syncs on the inviter\'s', () => {
  it('over REST', async () => {
    const bundle = await invite();
    const r = await post(INSTANCES.b, adminB, '/api/networks/join-remote', bundle);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    cleanup.b.push(bundle.networkId);
    assert.equal(await scheduleOnB(bundle.networkId), INVITERS, 'the joined network has no schedule, so it never syncs on its own');
  });

  it('over MCP', async () => {
    const bundle = await invite();
    const r = await mcpB.callTool('network_join_remote', bundle);
    assert.ok(!r?.isError, r?.content?.[0]?.text);
    cleanup.b.push(bundle.networkId);
    assert.equal(await scheduleOnB(bundle.networkId), INVITERS);
  });

  it('an inviter that syncs manually hands the joiner the default, not manual', async () => {
    const { DEFAULT_JOIN_SYNC_SCHEDULE } = await import('../../server/dist/sync/schedule.js');
    // Without this, an absent constant and an absent schedule compare equal and the case passes on the defect.
    assert.ok(typeof DEFAULT_JOIN_SYNC_SCHEDULE === 'string' && DEFAULT_JOIN_SYNC_SCHEDULE.length > 0, 'there is no default schedule');
    const bundle = await invite(null); // null, not undefined: undefined would take the default parameter
    const r = await post(INSTANCES.b, adminB, '/api/networks/join-remote', bundle);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    cleanup.b.push(bundle.networkId);
    assert.equal(await scheduleOnB(bundle.networkId), DEFAULT_JOIN_SYNC_SCHEDULE);
  });
});

describe('a schedule the caller states', () => {
  it('wins over the inviter\'s, on both doors', async () => {
    const restBundle = await invite();
    const rest = await post(INSTANCES.b, adminB, '/api/networks/join-remote', { ...restBundle, syncSchedule: '*/3 * * * *' });
    assert.equal(rest.status, 200, JSON.stringify(rest.body));
    cleanup.b.push(restBundle.networkId);
    assert.equal(await scheduleOnB(restBundle.networkId), '*/3 * * * *');

    const mcpBundle = await invite();
    const r = await mcpB.callTool('network_join_remote', { ...mcpBundle, syncSchedule: '*/3 * * * *' });
    assert.ok(!r?.isError, r?.content?.[0]?.text);
    cleanup.b.push(mcpBundle.networkId);
    assert.equal(await scheduleOnB(mcpBundle.networkId), '*/3 * * * *');
  });

  it('that the door would refuse is refused on both doors, in one sentence, and no network is registered', async () => {
    const restBundle = await invite();
    const rest = await post(INSTANCES.b, adminB, '/api/networks/join-remote', { ...restBundle, syncSchedule: 'every 5m' });
    assert.equal(rest.status, 400, `an unrunnable schedule was accepted: ${rest.status} ${JSON.stringify(rest.body)}`);
    assert.match(rest.body.error, /\*\/5 \* \* \* \*/, 'the refusal does not say what to send instead');

    const mcpBundle = await invite();
    const r = await mcpB.callTool('network_join_remote', { ...mcpBundle, syncSchedule: 'every 5m' });
    assert.equal(r?.content?.[0]?.text, `Error (400): ${rest.body.error}`);

    for (const id of [restBundle.networkId, mcpBundle.networkId]) {
      const onB = await get(INSTANCES.b, adminB, `/api/networks/${id}`);
      assert.equal(onB.status, 404, `a refused join registered network ${id} anyway`);
    }
  });
});
