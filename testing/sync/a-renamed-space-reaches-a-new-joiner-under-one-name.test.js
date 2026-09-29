/**
 * A space renamed on its publisher reaches a new joiner as ONE space, under the publisher's current name (`Q-133`).
 *
 * Owner, 2026-09-28: *"y-project-template arrives still as y-twin on new-joiners."* A rename keeps the old id as the
 * space's network id; the invite answer handed the joiner the new LOCAL name with no alias, and every exchange after
 * the join named the space by its network id — which the joiner adopted as a second, empty space.
 *
 * B publishes a pub/sub network carrying OLD, renames OLD to NEW, and A joins by invite with no mapping of its own.
 *
 * - A carries NEW, aliased from the network id: spaceMap is exactly { OLD: NEW }.
 * - After a sync, A holds no space OLD and nothing pending for OLD.
 * - A record B writes in NEW arrives in A's NEW.
 * - The heal: with A's alias removed by hand (a member that joined before the fix), one cycle from its upstream puts
 *   it back and adopts nothing; a second cycle changes nothing.
 *
 * Run: node --test testing/sync/a-renamed-space-reaches-a-new-joiner-under-one-name.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import {
  INSTANCES, post, patch, del, delWithBody, dockerExec, readContainerConfig, triggerSync, waitFor, readCollection,
} from './helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, 'configs');
const RUN = Date.now();
const OLD = `q133-old-${RUN}`;
const NEW = `q133-new-${RUN}`;

let tokenA, tokenB, networkId;

const netOnA = () => readContainerConfig('ythril-a').networks.find(n => n.id === networkId);
const spacesOnA = () => readContainerConfig('ythril-a').spaces.map(s => s.id);

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  tokenB = fs.readFileSync(path.join(CONFIGS, 'b', 'token.txt'), 'utf8').trim();
  const s = await post(INSTANCES.b, tokenB, '/api/spaces', { id: OLD, label: OLD });
  assert.equal(s.status, 201, JSON.stringify(s.body));
  const net = await post(INSTANCES.b, tokenB, '/api/networks', { label: `q133-${RUN}`, type: 'pubsub', spaces: [OLD] });
  assert.equal(net.status, 201, JSON.stringify(net.body));
  networkId = net.body.id;
  const ren = await patch(INSTANCES.b, tokenB, `/api/spaces/${OLD}/rename`, { newId: NEW });
  assert.equal(ren.status, 200, `rename on the publisher: ${JSON.stringify(ren.body)}`);

  const inv = await post(INSTANCES.b, tokenB, '/api/invite/generate', { networkId });
  assert.equal(inv.status, 201, JSON.stringify(inv.body));
  const join = await post(INSTANCES.a, tokenA, '/api/networks/join-remote', {
    handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-b:3200/api/invite/apply', rsaPublicKeyPem: inv.body.rsaPublicKeyPem,
    networkId, myUrl: 'http://ythril-a:3200',
  });
  assert.equal(join.status, 200, JSON.stringify(join.body));
});

after(async () => {
  if (networkId) {
    await del(INSTANCES.a, tokenA, `/api/networks/${networkId}`).catch(() => {});
    await del(INSTANCES.b, tokenB, `/api/networks/${networkId}`).catch(() => {});
  }
  for (const id of [OLD, NEW]) await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${NEW}`, { confirm: true }).catch(() => {});
});

/** A full cycle from both ends, so the members exchange (announcement and heal) has run in each direction. */
async function cycle() {
  // `?wait=true`: the cycle has RUN when this returns, so the assertions after it read its result, not a race with it.
  for (const [base, token] of [[INSTANCES.a, tokenA], [INSTANCES.b, tokenB]]) {
    const r = await post(base, token, `/api/networks/${networkId}/sync?wait=true`, {});
    assert.equal(r.status, 200, `sync on ${base}: ${r.status} ${JSON.stringify(r.body)}`);
  }
}

describe('a new joiner of a renamed space', () => {
  it('carries the publisher\'s current name, aliased from the network id — exactly', () => {
    assert.deepEqual(netOnA()?.spaceMap ?? {}, { [OLD]: NEW },
      'the joiner recorded no alias, so the network id will arrive as a second space');
    assert.deepEqual(netOnA()?.spaces, [NEW]);
  });

  it('holds no second space and nothing pending after a sync', async () => {
    await cycle();
    assert.ok(!spacesOnA().includes(OLD), `the network id was adopted as a space of its own on A: ${JSON.stringify(spacesOnA())}`);
    const pending = (netOnA()?.pendingSpaces ?? []).map(p => p.networkId);
    assert.ok(!pending.includes(OLD), `the network id is pending on A: ${JSON.stringify(pending)}`);
  });

  it('receives the publisher\'s records in that one space', async () => {
    const r = await post(INSTANCES.b, tokenB, `/api/brain/spaces/${NEW}/entities`, { name: `q133-entity-${RUN}`, type: 'thing', tags: [], properties: {} });
    assert.ok(r.status < 300, JSON.stringify(r.body));
    await waitFor(async () => {
      await triggerSync(INSTANCES.a, tokenA, networkId);
      const r = await readCollection(INSTANCES.a, tokenA, NEW, 'entities', { filter: { name: `q133-entity-${RUN}` } });
      return (r.results ?? []).length === 1;
    }, 30_000, 1_000, 'the record B wrote never reached A\'s NEW');
    assert.ok(!spacesOnA().includes(OLD));
  });
});

describe('a name the network still uses, and a join that would re-point an aliased space, are refused', () => {
  // x -> y on the publisher: the network still calls y `x`. So `x` may not be taken by another space there, and a
  // second join that asked for the network's `x` to go somewhere new here would move a space that already syncs.
  const X = `q133x-${RUN}`, Y = `q133y-${RUN}`, Z = `q133z-${RUN}`, FOO = `q133foo-${RUN}`;
  let ambNet;

  before(async () => {
    for (const id of [X, Z]) assert.equal((await post(INSTANCES.b, tokenB, '/api/spaces', { id, label: id })).status, 201);
    const n = await post(INSTANCES.b, tokenB, '/api/networks', { label: `q133amb-${RUN}`, type: 'pubsub', spaces: [X, Z] });
    assert.equal(n.status, 201, JSON.stringify(n.body));
    ambNet = n.body.id;
    assert.equal((await patch(INSTANCES.b, tokenB, `/api/spaces/${X}/rename`, { newId: Y })).status, 200);
  });

  it('the publisher refuses renaming another space onto the name the network still uses', async () => {
    const r = await patch(INSTANCES.b, tokenB, `/api/spaces/${Z}/rename`, { newId: X });
    assert.equal(r.status, 409, `a second space took the network's name for the renamed one: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.code, 'space_name_in_use');
  });

  after(async () => {
    if (ambNet) await del(INSTANCES.b, tokenB, `/api/networks/${ambNet}`).catch(() => {});
    for (const id of [X, Y]) await delWithBody(INSTANCES.b, tokenB, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
    for (const id of [X, Y, Z, FOO]) await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${id}`, { confirm: true }).catch(() => {});
  });

  const invite = async (spaceMap) => {
    const inv = await post(INSTANCES.b, tokenB, '/api/invite/generate', { networkId: ambNet });
    assert.equal(inv.status, 201, JSON.stringify(inv.body));
    return {
      handshakeId: inv.body.handshakeId, inviteUrl: 'http://ythril-b:3200/api/invite/apply',
      rsaPublicKeyPem: inv.body.rsaPublicKeyPem, networkId: ambNet, myUrl: 'http://ythril-a:3200', ...(spaceMap ? { spaceMap } : {}),
    };
  };

  it('a join landing two network spaces on one local space answers the same code and sentence on both doors, and creates nothing', async () => {
    // The renamed space by its shown name, the other by its own: both onto FOO. (A second join of the same network
    // through the same inviter is refused by the inviter before this instance resolves anything, so the
    // `network_id_aliased` case is pinned by the resolver's truth table instead.)
    const map = { [Y]: FOO, [Z]: FOO };
    const rest = await post(INSTANCES.a, tokenA, '/api/networks/join-remote', await invite(map));
    assert.equal(rest.status, 400, `two spaces were joined into one: ${rest.status} ${JSON.stringify(rest.body)}`);
    assert.equal(rest.body.code, 'join_mapping_collision');
    const { openMcpSession } = await import('./mcp-session.js');
    const s = await openMcpSession(tokenA, INSTANCES.a);
    try {
      const r = await s.callTool('network_join_remote', await invite(map));
      assert.equal(r?.content?.[0]?.text, `Error (400): ${rest.body.error}`);
    } finally { s.close(); }
    const cfg = readContainerConfig('ythril-a');
    assert.ok(!cfg.networks.some(n => n.id === ambNet), 'a refused join left a network behind');
    assert.ok(!cfg.spaces.some(sp => [X, Y, Z, FOO].includes(sp.id)), 'a refused join created a space');
  });
});

describe('a member that joined before the fix heals from its upstream', () => {
  it('its alias, removed by hand, is put back by one cycle, and nothing is adopted', async () => {
    const script = [
      `const fs=require('fs');const p='/config/config.json';`,
      `const c=JSON.parse(fs.readFileSync(p,'utf8'));`,
      `const n=c.networks.find(x=>x.id==='${networkId}');`,
      `if(n&&n.spaceMap){delete n.spaceMap['${OLD}'];}`,
      `fs.writeFileSync(p,JSON.stringify(c,null,2));process.stdout.write('ok');`,
    ].join('');
    dockerExec(`docker exec ythril-a node -e "${script}"`);
    const reload = await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {});
    assert.ok(reload.status < 300, `reload-config: ${reload.status}`);
    // The sentinel: without it a flush of the in-memory config could restore the alias and pass this test unhealed.
    assert.equal(netOnA()?.spaceMap?.[OLD], undefined, 'the alias was not removed, so the heal below proves nothing');

    await cycle();
    assert.deepEqual(netOnA()?.spaceMap ?? {}, { [OLD]: NEW }, 'the upstream\'s announcement did not heal the alias');
    assert.ok(!spacesOnA().includes(OLD), 'the heal adopted the network id as a space instead');

    const before = JSON.stringify(netOnA());
    await cycle();
    const afterNet = { ...netOnA() };
    // Watermarks and sync stamps move every cycle; the alias, spaces and pending set must not.
    for (const k of ['spaceMap', 'spaces', 'pendingSpaces', 'dismissedSpaces']) {
      assert.deepEqual(afterNet[k], JSON.parse(before)[k], `a second cycle changed ${k}`);
    }
  });

  it('where the heal does not apply, the operator repairs it by accepting the network\'s name onto the carried space', async () => {
    // A dismissed id is never healed — the operator's answer wins — so this is the path a member takes when it
    // dismissed the duplicate, and the one a member of a voted network (which has no upstream) always takes.
    const script = [
      `const fs=require('fs');const p='/config/config.json';`,
      `const c=JSON.parse(fs.readFileSync(p,'utf8'));`,
      `const n=c.networks.find(x=>x.id==='${networkId}');`,
      `if(n&&n.spaceMap){delete n.spaceMap['${OLD}'];}`,
      `n.dismissedSpaces=['${OLD}'];`,
      `fs.writeFileSync(p,JSON.stringify(c,null,2));process.stdout.write('ok');`,
    ].join('');
    dockerExec(`docker exec ythril-a node -e "${script}"`);
    assert.ok((await post(INSTANCES.a, tokenA, '/api/admin/reload-config', {})).status < 300);
    await cycle();
    assert.equal(netOnA()?.spaceMap?.[OLD], undefined, 'a dismissed id was healed — the operator\'s dismissal was overridden');

    const r = await post(INSTANCES.a, tokenA, `/api/networks/${networkId}/pending-spaces`, { spaceId: OLD, action: 'accept', mapTo: NEW });
    assert.equal(r.status, 200, `accepting the network's name onto the carried space was refused: ${r.status} ${JSON.stringify(r.body)}`);
    assert.deepEqual(netOnA()?.spaceMap ?? {}, { [OLD]: NEW });
    assert.ok(!spacesOnA().includes(OLD), 'the repair created a second space');
    assert.ok(!(netOnA()?.dismissedSpaces ?? []).includes(OLD), 'the id stays dismissed although it now syncs');
  });
});
