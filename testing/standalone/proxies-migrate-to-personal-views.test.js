/**
 * A pre-6.0 proxy space becomes personal views, by one pure transform on the parsed config (Q-531, bundle-100, plan rev 3.2).
 *
 * ## The rule (plan rev 3.1 "Migration", rev 3.2 "Migration" and the data-integrity/integration vets)
 *
 * `migrateProxiesToViews(parsed)` in `config/migrate-proxies-to-views.ts` is a PURE transform of the parsed config object, called by
 * name in `loadConfig` and in `reloadConfig`; it never calls `getConfig()`, `saveConfig()` or `mutateConfig()` (a reload must not save:
 * its contract, loader.ts). It leaves the migrated config in place on the object it was handed, or returns it as `result.config`:
 *
 * - only a NON-EMPTY `proxyFor` is a proxy: `proxyFor: []` is a real space and stays one (Q-80);
 * - each LIVE instance-admin token gets its own copy (`@<old id>`, the same members, `migratedFrom: <old id>`), owned by
 *   `token:<id>`, or `oauth:<clientId>` for a connector token; an expired admin token and a non-admin token get none;
 * - no live instance-admin token: the definitions are kept in `unclaimedViews`, never lost;
 * - idempotent by ORIGIN (owner, migratedFrom), not by name: a second run, and a re-upgrade of a restored 5.x config, add no copy;
 *   a copy whose name an unrelated view of that owner already holds becomes `@<name>-2`;
 * - the old id leaves `config.spaces`, every network (its spaces list, its alias map, its schema layer and origin: the pure part of
 *   `removeSpaceFromNetwork`, extracted and shared, never a second copy) and every token row (`perSpace`, `spaceAdmin.spaces`);
 * - the old id is reserved in `retiredSpaceIds`; a reserved id that is a live space again (created after a rollback) loses the
 *   reservation: the live space wins;
 * - a webhook subscription that named ONLY retired ids is disabled, never emptied (an empty list means every space); one that
 *   named others keeps them. `subscriptionAfterRetiredIds(subscription, retiredIds)` is that decision, exported by the same module
 *   for the DB-phase boot step (subscriptions live in Mongo).
 *
 * ## Seen red
 *
 * At 18e8d598 there is no `config/migrate-proxies-to-views.js` in server/dist (every case: ERR_MODULE_NOT_FOUND), and loadConfig and
 * reloadConfig call no `migrateProxiesToViews(`. The cases assert identities (owner keys, ids, members, origins), not counts.
 *
 * Run: npm run build:server, then node --test testing/standalone/proxies-migrate-to-personal-views.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { bodyOf } from './_structural-window.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/config/migrate-proxies-to-views.ts';
const load = () => import('../../server/dist/config/migrate-proxies-to-views.js');

const HOUR = 3_600_000;
const future = new Date(Date.now() + 24 * HOUR).toISOString();
const past = new Date(Date.now() - 24 * HOUR).toISOString();
const rungs = (r) => ({ knowledge: r, files: r, schema: r, dataQuality: r, networks: r });
const adminRights = () => ({ instanceAdmin: true, createSpaces: true, floor: rungs('admin'), perSpace: {}, spaceAdmin: { floor: true, spaces: [] } });

/** A 5.x config: two real spaces, a proxy over them, a hand-edited empty proxy list, tokens of every kind, one network naming the proxy. */
function fixture({ admins = true } = {}) {
  return {
    instanceId: 'q531-migrate', instanceLabel: 'M',
    tokens: [
      ...(admins ? [
        { id: 'adm-pat', name: 'admin pat', hash: 'x', prefix: 'p', createdAt: past, lastUsed: null, expiresAt: null, rights: adminRights() },
        { id: 'adm-conn', name: 'admin connector', hash: 'x', prefix: 'p', createdAt: past, lastUsed: null, expiresAt: future, oauthClientId: 'client-9', rights: adminRights() },
      ] : []),
      { id: 'adm-expired', name: 'expired admin', hash: 'x', prefix: 'p', createdAt: past, lastUsed: null, expiresAt: past, rights: adminRights() },
      { id: 'reader', name: 'reader', hash: 'x', prefix: 'p', createdAt: past, lastUsed: null, expiresAt: null,
        rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { team: rungs('read'), qa: rungs('read') }, spaceAdmin: { floor: false, spaces: ['team', 'qa'] } } },
    ],
    spaces: [
      { id: 'qa', label: 'qa', folders: [] },
      { id: 'ops', label: 'ops', folders: [] },
      { id: 'team', label: 'Team', folders: [], proxyFor: ['qa', 'ops'] },
      { id: 'handedit', label: 'hand edited', folders: [], proxyFor: [] },
    ],
    networks: [{
      id: 'net-1', label: 'n', type: 'club', members: [], votes: [], spaces: ['team', 'qa'],
      spaceMap: { 'team-remote': 'team', 'qa-remote': 'qa' }, schemaLayers: { team: { types: {} }, qa: { types: {} } }, spaceOrigins: { team: 'peer-1', qa: 'peer-1' },
    }],
  };
}

async function migrate(cfg) {
  const { migrateProxiesToViews } = await load();
  const result = migrateProxiesToViews(cfg);
  return result?.config ?? cfg;
}

/** The identities a migrated copy carries, sorted: what a wrong owner, member list or origin would change. */
const copies = (cfg, origin) => (cfg.views ?? []).filter(v => v.migratedFrom === origin)
  .map(v => ({ id: v.id, ownerId: v.ownerId, members: v.members, migratedFrom: v.migratedFrom })).sort((a, b) => a.ownerId.localeCompare(b.ownerId));

describe('pre-6.0 proxies migrate to personal views (Q-531)', () => {
  it('only a non-empty proxyFor is a proxy: `proxyFor: []` stays a real space', async () => {
    const after = await migrate(fixture());
    const ids = after.spaces.map(s => s.id);
    assert.ok(ids.includes('handedit'), `a hand-edited empty proxy list was migrated away: spaces are ${ids}`);
    assert.deepEqual(copies(after, 'handedit'), [], 'a real space was turned into views');
    assert.ok(!(after.retiredSpaceIds ?? []).includes('handedit'), 'a real space id was retired');
  });

  it('each live instance-admin token gets its own copy, keyed token:<id> or oauth:<clientId>; expired and non-admin tokens get none', async () => {
    const after = await migrate(fixture());
    assert.deepEqual(copies(after, 'team'), [
      { id: '@team', ownerId: 'oauth:client-9', members: ['qa', 'ops'], migratedFrom: 'team' },
      { id: '@team', ownerId: 'token:adm-pat', members: ['qa', 'ops'], migratedFrom: 'team' },
    ]);
  });

  it('with no live instance-admin token the definition is kept in unclaimedViews, never lost', async () => {
    const after = await migrate(fixture({ admins: false }));
    assert.deepEqual(copies(after, 'team'), [], 'a view was given to a token that is not a live instance admin');
    const kept = (after.unclaimedViews ?? []).map(v => ({ name: v.name, members: v.members, migratedFrom: v.migratedFrom }));
    assert.deepEqual(kept, [{ name: 'team', members: ['qa', 'ops'], migratedFrom: 'team' }]);
  });

  it('idempotent by origin: a second run, and a re-upgrade of a restored 5.x config, add no copy; an unrelated name collision gets -2', async () => {
    const once = await migrate(fixture());
    const first = copies(once, 'team');
    const twice = await migrate(structuredClone(once));
    assert.deepEqual(copies(twice, 'team'), first, 'a second run changed the migrated copies');
    // A rollback restored the 5.x space list while the views stayed: the proxy is back beside its own earlier copies.
    const restored = structuredClone(once);
    restored.spaces.push({ id: 'team', label: 'Team', folders: [], proxyFor: ['qa', 'ops'] });
    restored.retiredSpaceIds = (restored.retiredSpaceIds ?? []).filter(id => id !== 'team');
    const again = await migrate(restored);
    assert.deepEqual(copies(again, 'team'), first, 're-upgrading a restored config made a second copy of a proxy already migrated for that owner');
    // An unrelated view of one owner already holds the name: that owner's copy is renamed, the other owner's is not.
    const taken = fixture();
    taken.views = [{ id: '@team', name: 'team', ownerId: 'token:adm-pat', members: ['qa'], createdAt: past }];
    const renamed = await migrate(taken);
    assert.deepEqual(copies(renamed, 'team').map(v => [v.ownerId, v.id]), [['oauth:client-9', '@team'], ['token:adm-pat', '@team-2']]);
    assert.ok(renamed.views.some(v => v.id === '@team' && v.ownerId === 'token:adm-pat' && !v.migratedFrom), 'the owner\'s own @team was replaced');
  });

  it('the old id leaves config.spaces, every network (spaces, alias, schema layer, origin) and every token row, and is reserved', async () => {
    const after = await migrate(fixture());
    const leftovers = [];
    if (after.spaces.some(s => s.id === 'team')) leftovers.push('config.spaces');
    const net = after.networks.find(n => n.id === 'net-1');
    if (net.spaces.includes('team')) leftovers.push('network spaces');
    if (Object.values(net.spaceMap ?? {}).includes('team')) leftovers.push('network spaceMap');
    if (net.schemaLayers?.team) leftovers.push('network schemaLayers');
    if (net.spaceOrigins?.team) leftovers.push('network spaceOrigins');
    const reader = after.tokens.find(t => t.id === 'reader');
    if (reader.rights.perSpace.team) leftovers.push('token perSpace');
    if (reader.rights.spaceAdmin.spaces.includes('team')) leftovers.push('token spaceAdmin.spaces');
    assert.deepEqual(leftovers, [], 'the retired proxy id is still named');
    // The member rows and the network's other space are untouched (the cleanup is of the one id, not of everything near it).
    assert.deepEqual([net.spaces, net.spaceMap, Object.keys(net.schemaLayers), reader.rights.spaceAdmin.spaces, Object.keys(reader.rights.perSpace)],
      [['qa'], { 'qa-remote': 'qa' }, ['qa'], ['qa'], ['qa']]);
    assert.deepEqual(after.retiredSpaceIds, ['team']);
  });

  it('a retired id that is a live space again loses its reservation (the live space wins)', async () => {
    const cfg = fixture();
    cfg.retiredSpaceIds = ['crew'];
    cfg.spaces.push({ id: 'crew', label: 'crew, created after a rollback', folders: [] });
    const after = await migrate(cfg);
    assert.ok(after.spaces.some(s => s.id === 'crew'), 'the live space was removed');
    assert.ok(!after.retiredSpaceIds.includes('crew'), `the reservation of a live space id was kept: ${after.retiredSpaceIds}`);
    assert.ok(after.retiredSpaceIds.includes('team'), 'the proxy migrated in the same run was not reserved');
  });

  it('a webhook subscription naming only retired ids is disabled, not emptied; one naming others keeps them', async () => {
    const { subscriptionAfterRetiredIds } = await load();
    const only = subscriptionAfterRetiredIds({ id: 'w1', url: 'https://h', secret: 's', spaces: ['team'], events: [], enabled: true }, ['team']);
    assert.deepEqual([only.enabled, only.spaces], [false, ['team']], 'emptying it would subscribe it to every space');
    const mixed = subscriptionAfterRetiredIds({ id: 'w2', url: 'https://h', secret: 's', spaces: ['team', 'qa'], events: [], enabled: true }, ['team']);
    assert.deepEqual([mixed.enabled, mixed.spaces], [true, ['qa']]);
    const all = subscriptionAfterRetiredIds({ id: 'w3', url: 'https://h', secret: 's', spaces: [], events: [], enabled: true }, ['team']);
    assert.deepEqual([all.enabled, all.spaces], [true, []], 'an every-space subscription is not about the retired id');
  });

  it('loadConfig and reloadConfig call the transform by name; it never reads or saves the live config; reload saves nothing', () => {
    const loader = stripComments(readFileSync(join(REPO_ROOT, 'server/src/config/loader.ts'), 'utf8'));
    const load_ = bodyOf(loader, 'loadConfig');
    const reload = bodyOf(loader, 'reloadConfig');
    assert.match(load_, /\bmigrateProxiesToViews\s*\(/, 'loadConfig does not call migrateProxiesToViews (rollback-is-documented reads migrate* calls in its body)');
    assert.match(reload, /\bmigrateProxiesToViews\s*\(/, 'reloadConfig does not call migrateProxiesToViews: a restored 5.x config would bring a proxy back as a writable space');
    assert.doesNotMatch(reload, /\bsaveConfig\s*\(/, 'reloadConfig saves');
    let mod;
    try { mod = stripComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8')); } catch { assert.fail(`${MODULE} does not exist`); }
    assert.doesNotMatch(mod, /\b(?:getConfig|saveConfig|mutateConfig|saveConfigSoon)\s*\(/, 'the migration reads or writes the live config; it must transform the object it is handed');
  });

  it('the network cleanup is the pure part of removeSpaceFromNetwork, shared, not a second copy', () => {
    let mod;
    try { mod = stripComments(readFileSync(join(REPO_ROOT, MODULE), 'utf8')); } catch { assert.fail(`${MODULE} does not exist`); }
    const spaces = stripComments(readFileSync(join(REPO_ROOT, 'server/src/networks/network-spaces.ts'), 'utf8'));
    const remove = bodyOf(spaces, 'removeSpaceFromNetwork');
    const imported = [...mod.matchAll(/import\s*\{([^}]*)\}\s*from\s*'[^']*networks\/(?:network-spaces|take-space-out-of-network)\.js'/g)].flatMap(m => m[1].split(',').map(s => s.trim().split(/\s+as\s+/)[0]).filter(Boolean));
    const shared = imported.filter(name => new RegExp(String.raw`\b${name}\s*\(`).test(remove));
    assert.ok(shared.length > 0, `the migration imports [${imported.join(', ')}] from networks/ (network-spaces.js or its leaf take-space-out-of-network.js) and removeSpaceFromNetwork calls none of them: the network cleanup has two copies`);
    assert.doesNotMatch(mod, /\bforgetSpaceAliases\s*\(|schemaLayers\b/, 'the migration edits a network by hand instead of through the shared transform');
  });
});
