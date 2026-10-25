/**
 * What the Q-624 fork tests of slice t3 share: how to seed a fork of any kind under an id that verifies, and how to reach Review's two
 * doors for any kind. Answered once, so no test writes its own copy of a rule the design states in one place (`CLAUDE.md`, "Reuse a module").
 *
 * ## The question each export answers
 *
 *  - `FORK_KINDS` / `assertCoversForkingFamilies`: *which kinds fork, and how is a row of each built.* The table says HOW; which families
 *    there are is `FORKING_FAMILIES` (`sync/upsert-plan.ts`, design §1), and `assertCoversForkingFamilies` fails when the table lacks one.
 *  - `forkIdOf` / `seedFork`: *what id does a fork row of this body carry.* `forkIdFor(forkOf, seq, authoredContentHash(family, row).text)`
 *    (design §3, M3). Before the hash leaf exists the id is text-derived, so a fixture can still be stored and the BEHAVIOUR under test
 *    fails for its own reason; `leafExists()` is asserted by the tests that are about the id itself.
 *  - `reviewDoors`: *what does each door answer for Review's list and resolve*, with the five required resolve parameters read from the
 *    store at the moment of the call, so a test states the keep and not four bookkeeping numbers.
 *
 * ## What it does not do
 *
 * It stubs nothing. Seeding writes the stored rows with one `insertMany`, as the existing fork tests do, because the subject of these
 * tests is what the server does with a fork, not how a peer made one.
 */
import assert from 'node:assert/strict';
import { build } from './_push-door.mjs';
import { handlerFor, fakeRes } from './_vote-round-instance.mjs';

// The server modules read `CONFIG_PATH` when first imported, so they are imported after the door has set it: `initForkFixtures()` in `before`.
let upsertPlan; let leaf;
export async function initForkFixtures() {
  upsertPlan = await import('../../server/dist/sync/upsert-plan.js');
  leaf = await import('../../server/dist/sync/authored-content.js').catch(() => undefined);
}

export const leafExists = () => leaf !== undefined;

/** Per forking kind: the collection (the family), the record type, the field Review shows by word, and a builder of a minimal row. */
export const FORK_KINDS = Object.freeze({
  fact:   { family: 'facts',    main: 'fact',        row: (S, id, seq, x = {}) => build.fact(S, id, seq, x),   alt: { fact: 'the other version' } },
  entity: { family: 'entities', main: 'name',        row: (S, id, seq, x = {}) => build.entity(S, id, seq, x), alt: { name: 'The Other Version' } },
  chrono: { family: 'chrono',   main: 'title',       row: (S, id, seq, x = {}) => build.chrono(S, id, seq, x), alt: { title: 'The other version' } },
  edge:   { family: 'edges',    main: 'description', row: (S, id, seq, x = {}) => build.edge(S, id, seq, { fromKind: 'entity', toKind: 'entity', ...x }), alt: { description: 'the other version' } },
});
export const kindOfFamily = (family) => Object.entries(FORK_KINDS).find(([, v]) => v.family === family)?.[0];

/** The table above covers every family the design says forks. Red until `FORKING_FAMILIES` exists. */
export function assertCoversForkingFamilies() {
  const families = upsertPlan.FORKING_FAMILIES;
  assert.ok(Array.isArray(families) && families.length >= 4,
    `sync/upsert-plan.js exports no FORKING_FAMILIES (got ${JSON.stringify(families)}): the one declaration of which kinds fork (design §1)`);
  for (const f of families) assert.ok(kindOfFamily(f), `FORKING_FAMILIES names '${f}', which this fixture table does not build`);
  for (const [k, v] of Object.entries(FORK_KINDS)) assert.ok(families.includes(v.family), `the fixture kind '${k}' is not in FORKING_FAMILIES`);
}

/** The body text a fork id is derived from: the hash leaf's, or (before it exists) a stand-in so the fixture can be stored. */
export function bodyText(family, row) {
  if (leaf) return leaf.authoredContentHash(family, row).text;
  const { _id, spaceId, seq, createdAt, updatedAt, author, forkOf, pos, posAtSeq, ...body } = row;
  return JSON.stringify(body);
}

/** The id a fork row carries: derived from its parent, its (shared) seq and its whole body. */
export const forkIdOf = (family, forkOf, row) => upsertPlan.forkIdFor(forkOf, row.seq, bodyText(family, { ...row, forkOf }));

/**
 * Store a fork of `parentId`: the `extra` body over the kind's minimal row, at the parent's seq, under its derived id. Returns the stored row.
 * An edge fork holds its subject's five identity fields, which the pre-Q-624 identity index refuses, and the refusal says so.
 */
export async function seedFork(door, S, kind, parentId, seq, extra = {}) {
  const k = FORK_KINDS[kind];
  // A carried row's position is its seq (as `a-scanner-reads-every-record-of-a-tie-db` seeds): a row with none is invisible to every position reader.
  const row = { ...k.row(S, 'placeholder', seq, { pos: seq, posAtSeq: seq, ...extra }), forkOf: parentId };
  row._id = forkIdOf(k.family, parentId, row);
  try { await door.coll(S, k.family).insertOne(row); } catch (err) {
    if (err?.code === 11000 && kind === 'edge') {
      throw new Error('a fork edge cannot be stored beside its subject: the edges identity index is the full five-field unique index, not the '
        + `partial one over { forkOf: null } (M2, design §5). ${err.message}`);
    }
    throw err;
  }
  return row;
}

/** A route by path and method anywhere under a router. */
export function findHandler(router, method, routePath) {
  const walk = (r) => {
    for (const layer of r.stack ?? []) {
      if (layer.route?.path === routePath && layer.route.methods[method]) return layer.route.stack.at(-1).handle;
      if (layer.handle?.stack) { const hit = walk(layer.handle); if (hit) return hit; }
    }
    return undefined;
  };
  return walk(router);
}

/** The first array a body holds, or the body when it is one. */
export const rowsOf = (body) => (Array.isArray(body) ? body : Object.values(body ?? {}).find(Array.isArray) ?? []);
export const forkIdOfRow = (r) => String(r?.forkId ?? r?._id ?? r?.id ?? r?.fork?._id);

/**
 * Review's doors for the space `S`: REST (the brain router's own handlers) and MCP (`callTool`). `resolve(kind, forkId, keep, over)` reads
 * the fork's seq and its parent's seq from the store for `ifMatchSeq` and `ifMatchParentSeq`; `over` replaces any parameter (a missing one is
 * `undefined`, a stale one is a number), so a test can state exactly what it sends.
 */
export async function reviewDoors(door, S) {
  const { brainRouter } = await import('../../server/dist/api/brain/index.js');
  const { callTool } = await import('../../server/dist/mcp/call-tool.js');
  const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
  const rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
  let serial = 0;
  const rest = async (method, routePath, { params = {}, body = {}, query = {} } = {}) => {
    const handler = findHandler(brainRouter, method, routePath);
    assert.ok(handler, `no ${method.toUpperCase()} ${routePath} on the brain router`);
    const res = { ...fakeRes(), end() { this.sent = true; return this; } };
    await handler({ method: method.toUpperCase(), params, body, query, authToken: { rights }, headers: {}, get: () => undefined }, res);
    assert.ok(res.sent, `${method} ${routePath} settled without answering`);
    return { ok: res.code < 400, status: res.code, body: res.body, sentence: res.body?.error };
  };
  const mcp = async (name, args) => {
    const id = `q624t3-${++serial}`;
    const out = await callTool({ name, args, caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: id, tokenLabel: id } });
    const text = (out.result.content ?? []).map(c => c.text ?? '').join('');
    return { ok: !out.result.isError, status: out.result.isError ? 409 : 200, body: out.result.structuredContent ?? null,
      sentence: out.result.isError ? text.replace(/^Error: /, '') : undefined, text };
  };
  const paramsOf = async (kind, forkId, keep, over = {}) => {
    const k = FORK_KINDS[kind];
    const fork = await door.coll(S, k.family).findOne({ _id: forkId });
    const parent = fork?.forkOf ? await door.coll(S, k.family).findOne({ _id: fork.forkOf }) : null;
    const base = { kind, keep, ifMatchSeq: fork?.seq, ifMatchParentSeq: parent?.seq };
    const merged = { ...base, ...over };
    return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
  };
  return {
    rest, mcp,
    list: {
      REST: (q = {}) => rest('get', '/spaces/:spaceId/forks', { params: { spaceId: S }, query: q }),
      MCP: (q = {}) => mcp('list_forks', { space: S, ...q }),
    },
    resolve: {
      REST: async (kind, forkId, keep, over) => rest('post', '/spaces/:spaceId/forks/:forkId/resolve', { params: { spaceId: S, forkId }, body: await paramsOf(kind, forkId, keep, over) }),
      MCP: async (kind, forkId, keep, over) => mcp('resolve_fork', { space: S, forkId, ...await paramsOf(kind, forkId, keep, over) }),
    },
  };
}

export { handlerFor };
