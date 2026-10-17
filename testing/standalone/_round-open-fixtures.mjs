/**
 * Networks, spaces and doors for the tests that ask what a round DOES the moment this instance proposes it — answered once.
 *
 * ## The question it answers
 *
 * *"On a network of this type with this many other members, holding a space with data in it: what does the operator's own door
 * (REST or tool) do to that space, and what does it answer?"* Every row of bundle-106 PR A's open-path tests (acts at open,
 * D-36, the doors' answers, the owed acts, pub/sub's local acts) needs the same four things: an instance with a real config
 * on disk, a real Mongo, a seeded space, and the doors called the way production calls them. Written per test, the copy that
 * drifts is the one that calls a door with a body the production door would refuse.
 *
 * ## The guards a hand-written copy drops
 *
 * - **A seeded space has DATA in it** ({@link seedFacts}). A wipe test over an empty space cannot tell a wipe that ran from one
 *   that did not.
 * - **Absence is asserted after the quiescence signal, and next to a positive twin** (design v5 X19): {@link requireExport} makes
 *   a rule whose machinery does not exist yet fail with the design's name for it, never with a `TypeError`.
 * - **A door is called with `confirm: true`** unless the row says otherwise ({@link doors}).
 *
 * ## What it does not do
 *
 * It does not pick what to assert, and it never replaces a body of the server: hooks come from `setSpaceActHooksForTest`
 * (design v5 section 2.5), which runs INSIDE the real bodies.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { bootInstance, handlerFor, fakeRes } from './_vote-round-instance.mjs';

export const SELF = 'aaaaaaaa-0000-4000-8000-000000005e1f';
export const M1 = 'aaaaaaaa-0000-4000-8000-0000000000a1';
export const M2 = 'aaaaaaaa-0000-4000-8000-0000000000a2';
export const M3 = 'aaaaaaaa-0000-4000-8000-0000000000a3';
export const ADMIN = Object.freeze({ rights: { instanceAdmin: true } });

/** Point `CONFIG_PATH` and `DATA_ROOT` at a fresh temp directory. Call BEFORE the first import of the server. */
export function tempInstance(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  process.env['CONFIG_PATH'] = path.join(dir, 'config.json');
  process.env['DATA_ROOT'] = path.join(dir, 'data');
  return dir;
}

export const member = (instanceId, extra = {}) => ({
  instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example.com`, tokenHash: 'h', direction: 'both', ...extra,
});

/** A network of `type` carrying `spaces`, with `memberIds` as its other members. `selfIsOrganiser` makes this instance its creator. */
export function networkOf(type, memberIds, { id = 'net-1', spaces = ['general', 'notes'], extra = {}, memberExtra = {} } = {}) {
  return {
    id, label: `Net ${id}`, type, origin: 'created', syncSchedule: '', spaces: [...spaces], votingDeadlineHours: 24,
    createdAt: '2026-01-01T00:00:00.000Z', members: memberIds.map(m => member(m, memberExtra)), pendingRounds: [], ...extra,
  };
}

export const spaceRow = (id, extra = {}) => ({ id, label: id, folders: [], completeLinkage: true, ...extra });

/** Boot an instance holding `spaces` and `networks`, with a peer token for every member. */
export async function boot(dir, { networks, spaces = ['notes'], instanceId = SELF, peerTokens, extra = {} }) {
  return bootInstance(dir, {
    instanceId, networks, extra,
    spaces: [{ id: 'general', label: 'General', builtIn: true, folders: [] }, ...spaces.map(s => spaceRow(s))],
    peerTokens: peerTokens ?? Object.fromEntries([M1, M2, M3].map(m => [m, `token-${m.slice(-2)}`])),
  });
}

/** Put `n` facts in a space, straight into its collection: the data a wipe or a deletion must take, or must not. */
export async function seedFacts(mongo, space, n = 3, tag = 'seed') {
  await mongo.col(`${space}_facts`).insertMany(Array.from({ length: n }, (_, i) => ({ _id: `${space}-${tag}-${i}`, spaceId: space, fact: `${tag} ${i}` })));
}
export const factCount = (mongo, space) => mongo.col(`${space}_facts`).countDocuments({});

/** `module[name]` or a failure naming the design's own word for it: a rule whose machinery is absent is red for THAT reason. */
export async function requireExport(specifier, name, why) {
  const mod = await requireModule(specifier, why);
  assert.equal(typeof mod[name], 'function', `${sourceOf(specifier)} does not export ${name} — ${why}`);
  return mod[name];
}

const sourceOf = (specifier) => specifier.replace('../../server/dist/', 'server/src/').replace(/\.js$/, '.ts');

/**
 * A built server module, or `null` when THAT module is absent from the build. Only `ERR_MODULE_NOT_FOUND` naming the module itself is an
 * absence: one raised for a module IT imports means it is built and broken, and is rethrown, as is every other load failure - a swallowed
 * one would quietly run a row's base-build half against a build that has the module.
 */
export async function loadModuleIfBuilt(specifier) {
  try { return await import(specifier); } catch (err) {
    if (err?.code === 'ERR_MODULE_NOT_FOUND' && String(err.message).includes(specifier.split('/').at(-1))) return null;
    throw err;
  }
}

/**
 * A built server module, or a failure NAMING the design's file. Exists because the guard was written four times: a module the design adds
 * is absent on the base commit, and a raw ERR_MODULE_NOT_FOUND reads as a broken harness rather than as the row's red.
 */
export async function requireModule(specifier, why) {
  return (await loadModuleIfBuilt(specifier)) ?? assert.fail(`${sourceOf(specifier)} does not exist — ${why}`);
}

/** The rounds of `network` of one type, read live from the config. */
export const roundsOf = (loader, networkId, type) =>
  (loader.getConfig().networks.find(n => n.id === networkId)?.pendingRounds ?? []).filter(r => !type || r.type === type);

/**
 * A route's own handler called as a request reaches it, answering `{ code, body }` — and `204`, which ends with `res.status(204).end()` and no body
 * (the shared `fakeRes` has no `end`, so a door that answers 204 would throw inside the harness instead of answering).
 */
export async function route(router, method, routePath, { params = {}, body = {}, query = {}, authToken } = {}) {
  const res = { ...fakeRes(), end() { this.sent = true; return this; } };
  await handlerFor(router, method, routePath)({ method: method.toUpperCase(), params, body, query, authToken, headers: {}, get: () => undefined }, res);
  assert.ok(res.sent, `${method.toUpperCase()} ${routePath} settled without answering`);
  return { code: res.code, body: res.body };
}

/** The app's own router (the admin wipe route is registered inline on it), so the handler that runs is production's. */
async function appRouter() {
  const { createApp } = await import('../../server/dist/app.js');
  const app = createApp();
  return app.router ?? app._router;
}

/** The tool's own handler, as an instance administrator. */
async function callTool(module, name, args, rights = ADMIN.rights) {
  const tool = (await import(`../../server/dist/mcp/tools/${module}.js`))[`${name}Tool`];
  assert.ok(tool?.handle, `no ${name}Tool export on mcp/tools/${module}.js — re-anchor this harness`);
  // A handler REFUSES by throwing, and the dispatcher (`callTool`) answers the throw as an error result (400 on the REST tool door):
  // read here the way the dispatcher reads it, so a refusal is `isError` and not a harness crash.
  let out;
  try { out = await tool.handle({ args, rights, callSpace: args['space'] }); } catch (err) {
    return { isError: true, structured: undefined, text: `Error: ${err instanceof Error ? err.message : String(err)}` };
  }
  return { isError: out.isError === true, structured: out.structuredContent, text: (out.content ?? []).map(c => c.text ?? '').join('\n') };
}

/**
 * The operator's doors for the space acts, each answering `{ code, body }` (REST) or `{ isError, structured, text }` (MCP). `authToken`
 * is an instance administrator unless a row passes another.
 */
export const doors = {
  async deleteSpace(id, body = { confirm: true }, authToken = ADMIN) {
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    return route(spacesRouter, 'delete', '/:id', { params: { id }, body, authToken });
  },
  async wipeSpace(spaceId, body = { confirm: true }, authToken = ADMIN) {
    return route(await appRouter(), 'post', '/api/admin/spaces/:spaceId/wipe', { params: { spaceId }, body, authToken });
  },
  wipeTool: (args, rights) => callTool('spaces', 'delete_space_data', { confirm: true, ...args }, rights),
  addSpace: async (id, spaceId, authToken = ADMIN) => {
    const { crudRouter } = await import('../../server/dist/api/networks/crud.js');
    return route(crudRouter, 'post', '/:id/spaces', { params: { id }, body: { spaceId }, authToken });
  },
  addMember: async (id, body, authToken = ADMIN) => {
    const { membersRouter } = await import('../../server/dist/api/networks/members.js');
    return route(membersRouter, 'post', '/:id/members', { params: { id }, body, authToken });
  },
  removeMember: async (id, instanceId, authToken = ADMIN) => {
    const { membersRouter } = await import('../../server/dist/api/networks/members.js');
    return route(membersRouter, 'delete', '/:id/members/:instanceId', { params: { id, instanceId }, authToken });
  },
  memberAddTool: (args) => callTool('network-join', 'network_member_add', args),
  memberRemoveTool: (args) => callTool('network-join', 'network_member_remove', args),
};

/** Poll `read()` until it answers true, at most `maxTurns` event-loop turns: a stated condition, never a number of milliseconds. */
export async function until(read, what, maxTurns = 4000) {
  for (let i = 0; i < maxTurns; i++) {
    if (await read()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail(`never reached: ${what}`);
}

/**
 * Wait until the harness database accepts a new collection. `openTestMongo` drops the database on entry and returns before the server has
 * finished ("Cannot create collection ... database is in the process of being dropped"), so the first space a test creates fails and its
 * deferred work is lost — which reads as the rule under test not holding. Polls the database's own answer, never a delay.
 */
export async function databaseTakesCollections(mongo) {
  for (let i = 0; i < 2000; i++) {
    try { await mongo.getDb().createCollection('_probe'); await mongo.getDb().collection('_probe').drop(); return; } catch { await mongo.getDb().command({ ping: 1 }); }
  }
  assert.fail('the harness database never became ready for new collections');
}

/**
 * Create and remove one throwaway space, so the modules a space's creation loads lazily (dynamic imports, index builders) are loaded BEFORE a
 * test starts waiting for a deferred add: a cold first creation takes longer than any honest quiet window, and an absence read before it
 * ends is a wrong answer in the rule's favour. Needs the config booted and Mongo open.
 */
export async function warmSpaceCreation() {
  const { createSpace, removeSpace } = await import('../../server/dist/spaces/lifecycle.js');
  await createSpace({ id: 'warm-up', label: 'Warm up' }, { tokenId: null });
  await removeSpace('warm-up');
}

/** The runner module, or a failure naming the design's file: a row that needs a seam is red for ITS absence, never for a module-not-found trace. */
export const requireRunner = (why = 'the one space-act runner') => requireModule('../../server/dist/spaces/space-act-runner.js', `design v5 section 2.5: ${why}`);
export const requireFence = (why = 'the one fence that counts a space\'s transfers') => requireModule('../../server/dist/sync/space-transfer-fence.js', `design v5 section 3.3a: ${why}`);

/** `a` with `condition()` polled through round trips to Mongo, at most `bound` of them: for a defect WAITED FOR where the base commit's deferred work cannot be awaited. */
export async function untilOrBound(mongo, condition, bound = 800) {
  for (let i = 0; i < bound && !(await condition()); i++) await mongo.getDb().command({ ping: 1 });
  return condition();
}

/**
 * The gossip pass's retry of every held round, through the one settle step where it exists, awaiting the acts it started; on the base commit
 * through `applyRoundConclusion`, the same retry in its old spelling, whose deferred work is not awaitable (the caller waits for the outcome
 * it is looking for with {@link untilOrBound}).
 */
export async function retryEveryHeldRound(loader, netIndex = 0) {
  const mod = await import('../../server/dist/networks/round-conclusion.js');
  const cfg = loader.getConfig();
  const net = cfg.networks[netIndex];
  const held = [...net.pendingRounds];
  if (typeof mod.settleRounds === 'function') {
    // Saved at once, as the gossip pass saves what its settle wrote: a marking left in memory is read away by any writer's reload.
    const out = mod.settleRounds(net, cfg, [], 'retry', Date.now(), held);
    if (out.wrote) loader.saveConfig(cfg);
    return out.settled;
  }
  mod.applyRoundConclusion(net, cfg, [], 'retry', held);
  return undefined;
}
