/**
 * A space crosses the wire under its NETWORK id, everywhere (`Q-133`).
 *
 * ## The defect
 *
 * A rename keeps the space's OLD id as its network id (`spaceMap[oldId] = newId`) so peers keep syncing. But the
 * invite answers sent the publisher's LOCAL ids, so a joiner created `y-project-template` with no alias — and every
 * exchange after the join named the space `y-twin`, which the joiner then adopted as a second, empty space. Owner,
 * 2026-09-28: *"y-project-template arrives still as y-twin on new-joiners."*
 *
 * ## The rule these cases pin
 *
 * - spaceMap may hold several keys for one local space. The FIRST is its network id; later keys are inbound
 *   aliases, kept so a member that joined when the space had another local name still reaches it.
 * - One module decides every alias (`sync/space-map.ts`): no self-alias, no overwrite, no local with two network ids.
 * - The join resolves every space through ONE function, and every refusal is decided before anything is written.
 * - A member that joined before the fix heals — from its UPSTREAM only, only onto a space no announced id reaches.
 * - Rounds keep `spaceId` (older peers apply it raw) and gain `networkSpaceId`, which a receiver prefers.
 * - A rename re-keys what is keyed by the local id; a boot migration re-keys what an older rename left behind and
 *   never drops a layer, an origin or an alias.
 *
 * Run: node --test testing/standalone/a-space-crosses-the-wire-under-its-network-id.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const spaceMap = await import('../../server/dist/sync/space-map.js');
const networkSpaces = await import('../../server/dist/networks/network-spaces.js');
const { applySpaceRenameToConfig } = await import('../../server/dist/spaces/rename.js');
/** A module that may not exist yet: its absence is a failure of every case that needs it, never a skip. */
const optional = async (p) => { try { return await import(p); } catch { return {}; } };
const joinSpaces = await optional('../../server/dist/networks/join-spaces.js');
const migrate = await optional('../../server/dist/config/migrate-network-space-keys.js');
const selfRecord = await optional('../../server/dist/networks/self-record.js');

const PUB = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';
const fn = (mod, name) => {
  assert.equal(typeof mod[name], 'function', `${name} does not exist — the rule it carries has no home`);
  return mod[name];
};
const pubsubSubscriber = (over = {}) => ({
  id: 'n1', type: 'pubsub', spaces: ['y-project-template'], members: [{ instanceId: PUB, label: 'pub', url: 'http://p', direction: 'pull' }],
  ...over,
});

describe('one module decides every alias', () => {
  it('reverseSpaceMap answers the FIRST key for a local, as localToRemote does', () => {
    const net = { spaces: ['c'], spaceMap: { a: 'c', b: 'c' } };
    const rev = fn(spaceMap, 'reverseSpaceMap')(net);
    assert.equal(rev.get('c'), 'a', 'the network id is the first key; a later key is an inbound alias');
    assert.equal(spaceMap.localToRemote(net, 'c'), 'a');
  });

  it('recordSpaceAlias records a new alias, and refuses a self-alias, an overwrite, and a second network id', () => {
    const record = fn(spaceMap, 'recordSpaceAlias');
    const net = { spaces: ['local'], spaceMap: {} };
    assert.equal(record(net, 'remote', 'local'), null);
    assert.deepEqual(net.spaceMap, { remote: 'local' });
    assert.ok(record(net, 'x', 'x'), 'a self-alias is refused');
    assert.ok(record(net, 'remote', 'elsewhere'), 'an existing alias is not overwritten');
    assert.ok(record(net, 'another', 'local'), 'a local that already has a network id gets no second one');
    assert.ok(record(net, '__proto__', 'local'), 'an id that is not a space id is refused before it is written');
    assert.deepEqual(net.spaceMap, { remote: 'local' }, 'no refusal wrote anything');
  });

  it('networkIdTaken: a new space may not take a network id another space already syncs under', () => {
    const taken = fn(spaceMap, 'networkIdTaken');
    const net = { spaces: ['y-project-template'], spaceMap: { 'y-twin': 'y-project-template' } };
    assert.equal(taken(net, 'y-twin'), true, 'a new local y-twin would collide with the renamed space');
    assert.equal(taken(net, 'y-project-template'), false, 'the renamed space itself is not a collision');
    assert.equal(taken(net, 'fresh'), false);
  });
});

describe('a rename keeps the network id, keeps inbound aliases, and re-keys what it owns', () => {
  const pubCfg = (net) => ({ spaces: [{ id: 'a', label: 'a' }], tokens: [], networks: [net] });

  it('A->B->C keeps A as the network id and B as an inbound alias, in that order', () => {
    const cfg = pubCfg({ id: 'n1', type: 'pubsub', spaces: ['a'], members: [] });
    applySpaceRenameToConfig(cfg, cfg.spaces[0], 'a', 'b');
    applySpaceRenameToConfig(cfg, cfg.spaces[0], 'b', 'c');
    assert.deepEqual(Object.entries(cfg.networks[0].spaceMap), [['a', 'c'], ['b', 'c']]);
    assert.equal(spaceMap.localToRemote(cfg.networks[0], 'c'), 'a');
  });

  it('renaming a mapped space back to its network id deletes the alias rather than writing a self-alias', () => {
    const cfg = pubCfg({ id: 'n1', type: 'pubsub', spaces: ['a'], spaceMap: { net: 'a' }, members: [] });
    applySpaceRenameToConfig(cfg, cfg.spaces[0], 'a', 'net');
    assert.equal(cfg.networks[0].spaceMap?.net, undefined, 'a self-alias is left behind');
    assert.deepEqual(cfg.networks[0].spaces, ['net']);
  });

  it('re-keys the schema layer, the origin and a pending entry that were keyed by the old local id', () => {
    const cfg = pubCfg({
      id: 'n1', type: 'pubsub', spaces: ['a'], members: [],
      schemaLayers: { a: { purpose: 'p' } }, spaceOrigins: { a: PUB },
      pendingSpaces: [{ networkId: 'z', localId: 'a', from: PUB, at: '2026-01-01T00:00:00Z', why: 'w' }],
    });
    applySpaceRenameToConfig(cfg, cfg.spaces[0], 'a', 'b');
    const net = cfg.networks[0];
    assert.deepEqual(Object.keys(net.schemaLayers), ['b'], 'the layer was left under the old key');
    assert.deepEqual(Object.keys(net.spaceOrigins), ['b'], 'the origin was left under the old key');
    assert.equal(net.pendingSpaces[0].localId, 'b');
  });
});

describe('the join resolves every space through one function, refusing before any write', () => {
  const resolve = () => fn(joinSpaces, 'resolveJoinSpaces');

  it('a renamed space is joined under the publisher\'s current name, aliased from the network id', () => {
    const r = resolve()({ spaces: ['y-project-template'], networkSpaces: ['y-twin'] }, undefined, undefined, []);
    assert.equal(r.ok, true, JSON.stringify(r));
    assert.deepEqual(r.entries, [{ networkId: 'y-twin', localId: 'y-project-template' }]);
  });

  it('an answer without networkSpaces (an older inviter) resolves as today: the shown name is the network id', () => {
    const r = resolve()({ spaces: ['a'] }, undefined, undefined, []);
    assert.deepEqual(r.entries, [{ networkId: 'a', localId: 'a' }]);
  });

  it('a malformed networkSpaces is ignored, never trusted', () => {
    for (const bad of [['x', 'y'], [1], ['BAD ID'], ['dup', 'dup']]) {
      const r = resolve()({ spaces: bad.length === 2 ? ['p', 'q'] : ['p'], networkSpaces: bad }, undefined, undefined, []);
      assert.equal(r.ok, true);
      assert.deepEqual(r.entries.map(e => e.networkId), r.entries.map(e => e.localId), `trusted ${JSON.stringify(bad)}`);
    }
  });

  it('a requested key works by the shown name or by the network id, for that entry only', () => {
    const answer = { spaces: ['y-project-template', 'y-tickets'], networkSpaces: ['y-twin', 'y-tickets'] };
    for (const key of ['y-project-template', 'y-twin']) {
      const r = resolve()(answer, { [key]: 'mine' }, undefined, ['mine']);
      assert.deepEqual(r.entries, [{ networkId: 'y-twin', localId: 'mine' }, { networkId: 'y-tickets', localId: 'y-tickets' }], key);
    }
  });

  it('a key that is one entry\'s shown name and another entry\'s network id is refused, not guessed', () => {
    // x->y then z->x on the publisher: shown [y, x], network ids [x, z].
    const r = resolve()({ spaces: ['y', 'x'], networkSpaces: ['x', 'z'] }, { x: 'foo' }, undefined, []);
    assert.equal(r.ok, false);
    assert.equal(r.code, 'join_mapping_collision');
  });

  it('two entries on one local, or a network id already aliased here to another local, are refused', () => {
    const two = resolve()({ spaces: ['a', 'b'], networkSpaces: ['a', 'b'] }, { a: 'same', b: 'same' }, undefined, []);
    assert.equal(two.ok, false, 'two network spaces landing on one local space');
    const existing = { spaces: ['l1'], spaceMap: { n: 'l1' } };
    const again = resolve()({ spaces: ['s'], networkSpaces: ['n'] }, { s: 'l2' }, existing, ['l1', 'l2']);
    assert.equal(again.ok, false, 'the network id already reaches another local space here');
    assert.equal(again.code, 'network_id_aliased');
  });
});

describe('a member that joined before the fix heals — from its upstream, onto a dead space only', () => {
  const heal = () => fn(networkSpaces, 'healSpaceAliases');

  it('the reported case: y-twin announced, y-project-template carried with no alias -> healed', () => {
    const out = heal()(pubsubSubscriber(), PUB, ['y-twin'], { 'y-twin': 'y-project-template' });
    assert.deepEqual(out, [{ networkId: 'y-twin', localId: 'y-project-template' }]);
  });

  it('never from a member that is not the upstream', () => {
    assert.deepEqual(heal()(pubsubSubscriber(), OTHER, ['y-twin'], { 'y-twin': 'y-project-template' }), []);
  });

  it('never onto a space the upstream announces under its own id (the chained-rename case)', () => {
    // Publisher: b->c then a->b. Announced [a, b], names {a: b, b: c}. Our b holds what the network calls b.
    const net = pubsubSubscriber({ spaces: ['b', 'c'] });
    assert.deepEqual(heal()(net, PUB, ['a', 'b'], { a: 'b', b: 'c' }), [], 'a live space was re-pointed');
  });

  it('never when two announced ids would land on one local space', () => {
    assert.deepEqual(heal()(pubsubSubscriber(), PUB, ['n1', 'n2'], { n1: 'y-project-template', n2: 'y-project-template' }), []);
  });

  it('never for a dismissed id — the operator\'s answer wins', () => {
    const net = pubsubSubscriber({ dismissedSpaces: ['y-twin'] });
    assert.deepEqual(heal()(net, PUB, ['y-twin'], { 'y-twin': 'y-project-template' }), []);
  });

  it('refuses a malformed or oversized spaceNames without throwing', () => {
    for (const bad of [null, 'x', ['y-twin'], { 'y-twin': 'NOT A SPACE ID' }, { __proto__: 'y-project-template' }]) {
      assert.deepEqual(heal()(pubsubSubscriber(), PUB, ['y-twin'], bad), [], JSON.stringify(bad));
    }
    const many = Object.fromEntries(Array.from({ length: 60 }, (_, i) => [`n${i}`, `l${i}`]));
    const big = heal()(pubsubSubscriber({ spaces: Array.from({ length: 60 }, (_, i) => `l${i}`) }), PUB, Object.keys(many), many);
    assert.ok(big.length <= 50, `healed ${big.length} from one announcement`);
  });

  it('the self-record carries spaceNames toward a subscriber, and only for spaces whose ids differ', () => {
    const build = fn(selfRecord, 'selfRecordFor');
    const cfg = { instanceId: PUB, instanceLabel: 'pub', networks: [] };
    const net = { id: 'n1', type: 'pubsub', spaces: ['y-project-template', 'y-tickets'], spaceMap: { 'y-twin': 'y-project-template' }, members: [{ instanceId: OTHER, direction: 'push' }] };
    const rec = build(cfg, net, { instanceId: OTHER, direction: 'push' });
    assert.deepEqual(rec.spaces, ['y-twin', 'y-tickets']);
    assert.deepEqual(rec.spaceNames, { 'y-twin': 'y-project-template' });
  });
});

describe('rounds name their space by the network id too, additively', () => {
  it('a receiver prefers networkSpaceId and falls back to spaceId', () => {
    const local = fn(spaceMap, 'roundSpaceLocalId');
    const receiver = { spaces: ['theirs'], spaceMap: { net: 'theirs' } };
    assert.equal(local(receiver, { spaceId: 'publisher-local', networkSpaceId: 'net' }), 'theirs');
    assert.equal(local(receiver, { spaceId: 'net' }), 'theirs', 'a round from an older proposer still resolves');
    assert.equal(local(receiver, { spaceId: 'x', networkSpaceId: 'unknown' }), null, 'nothing outside the network');
  });
});

describe('the boot migration re-keys what an older rename left behind, and drops nothing', () => {
  it('a layer and an origin under an old local name move to the space the alias names; an orphan stays', () => {
    const run = fn(migrate, 'migrateNetworkSpaceKeys');
    const cfg = { networks: [{
      id: 'n1', spaces: ['y-project-template'], spaceMap: { 'y-twin': 'y-project-template' },
      schemaLayers: { 'y-twin': { purpose: 'old' }, gone: { purpose: 'orphan' } }, spaceOrigins: { 'y-twin': PUB },
    }] };
    assert.equal(run(cfg), true);
    const net = cfg.networks[0];
    assert.deepEqual(net.schemaLayers['y-project-template'], { purpose: 'old' });
    assert.equal(net.spaceOrigins['y-project-template'], PUB);
    assert.deepEqual(net.schemaLayers.gone, { purpose: 'orphan' }, 'an unmapped layer was dropped');
    assert.deepEqual(net.spaceMap, { 'y-twin': 'y-project-template' }, 'an alias was dropped');
    assert.equal(run(cfg), false, 'a second run changed something — not idempotent');
  });

  it('a layer the carried space already has is not overwritten by the stale one', () => {
    const run = fn(migrate, 'migrateNetworkSpaceKeys');
    const cfg = { networks: [{ id: 'n1', spaces: ['l'], spaceMap: { k: 'l' }, schemaLayers: { k: { purpose: 'stale' }, l: { purpose: 'live' } } }] };
    run(cfg);
    assert.deepEqual(cfg.networks[0].schemaLayers.l, { purpose: 'live' });
  });
});
