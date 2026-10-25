/**
 * The kinds that fork, as a test reads them: the set from the planner, one fixture per member, and the one id a fork
 * of a body must have (Q-624, design rev 4 sections 1, 3 and 16).
 *
 * ## What it prevents
 *
 * A fork test written over "facts" is the defect Q-624 removes, and a test written over a hand list of four kinds is the same
 * defect with a later expiry date: the day a fifth kind forks, the test says nothing about it. So the SET is read from the
 * planner (`FORKING_FAMILIES`, `sync/upsert-plan.ts`), floored, and every member must have a fixture here: a family the planner
 * gains and this file lacks FAILS, loudly, instead of being skipped.
 *
 * What is chosen here, not derived, and why that is allowed: a fixture is literal (`CLAUDE.md`, "A test fixture is allowed to be
 * literal"). Which field a case edits to make two copies say different things is the one per-kind value no module states
 * for the tests; the design's `mainField` (section 9) is the same value and is the presentation field Review shows.
 *
 * ## The fork id is computed by the module that owns it
 *
 * `forkIdFor` (the id from a subject, a seq and a text) and `authoredContentHash` (the text from a body) are the server's. A
 * test that spelled its own id would assert the code equals itself; one that asks them for the id the design says
 * (`forkIdFor(forkOf, seq, authoredContentHash(family, body).text)`, section 3) asserts the rule. Both are imported from
 * `server/dist` when asked, so a file that never asks them still loads on a build that lacks them.
 *
 * One owner: this file is owned by the Q-624 test slice t2 (`test/q624-t2`). Other slices that need the same set or the same
 * id take it from here once merged, and write no second copy.
 */
import assert from 'node:assert/strict';
import { build } from './_push-door.mjs';

/** One fixture per family: the builder, the body field two copies are made to differ in, the single route, the record type. */
export const FORK_FIXTURE = Object.freeze({
  facts:    { build: build.fact,   field: MAIN_FIELD.facts,    single: '/facts',    type: 'fact',   word: 'fact' },
  entities: { build: build.entity, field: MAIN_FIELD.entities, single: '/entities', type: 'entity', word: 'entity' },
  edges:    { build: build.edge,   field: MAIN_FIELD.edges,    single: '/edges',    type: 'edge',   word: 'edge' },
  chrono:   { build: build.chrono, field: MAIN_FIELD.chrono,   single: '/chrono',   type: 'chrono', word: 'chrono entry' },
});

/** The families that fork, read from the planner, floored, each with a fixture. Throws when the planner states none. */
export async function forkingFamilies() {
  const plan = await import('../../server/dist/sync/upsert-plan.js');
  assert.ok(Array.isArray(plan.FORKING_FAMILIES),
    'sync/upsert-plan.ts exports no FORKING_FAMILIES: the set of kinds that fork is not stated anywhere a test can read it (design section 1)');
  assert.ok(plan.FORKING_FAMILIES.length >= 4,
    `only ${plan.FORKING_FAMILIES.length} forking famil(ies) stated: ${plan.FORKING_FAMILIES} (design section 1 names four)`);
  const missing = plan.FORKING_FAMILIES.filter(f => !(f in FORK_FIXTURE));
  assert.deepEqual(missing, [], `forking families with no fixture in _fork-kinds.mjs: ${missing} — add one, or the kind is not tested`);
  return [...plan.FORKING_FAMILIES];
}

/** The body text of `doc` as the fork id derives from it: `authoredContentHash(family, doc).text`. */
export async function bodyTextOf(family, doc) {
  const mod = await import('../../server/dist/sync/authored-content.js');
  assert.equal(typeof mod.authoredContentHash, 'function', 'sync/authored-content.js exports no authoredContentHash (design section 2)');
  const hashed = await mod.authoredContentHash(family, doc);
  assert.equal(typeof hashed?.text, 'string', 'authoredContentHash(family, doc) must return { text, hash, normalised } (design section 2)');
  return hashed.text;
}

/** The id a fork of `subjectId`, at `seq`, carrying `doc`'s body must have: section 3's equation. */
export async function forkIdOf(family, subjectId, seq, doc) {
  const { forkIdFor } = await import('../../server/dist/sync/upsert-plan.js');
  return forkIdFor(subjectId, seq, await bodyTextOf(family, doc));
}

/** A document of `family` in `space` whose `field` says `text`, authored by `author` when given. */
export function copyOf(family, space, id, seq, text, extra = {}) {
  const fx = FORK_FIXTURE[family];
  return fx.build(space, id, seq, { [fx.field]: text, ...extra });
}

/**
 * The three doors an arrival comes through that take a page of copies, each with one way to deliver `docsBySpace` (local space id
 * -> the documents of `family` it is handed): the single route, `POST /batch-upsert`, and the pull (the real engine against the
 * door's fake peer, which serves every space of the map in one cycle). The one place that spells them, because a door a test
 * leaves out is the door the rule silently stopped covering (`a-fork-keeps-its-copys-created-at-db` wrote them by hand).
 *
 * @param door  an `openPullDoor` door
 * @param token the pushing token, proving the peer the pull reads from
 */
export function arrivalDoors(door, token) {
  const at = (space) => ({ spaceId: space, networkId: door.NET, token });
  return {
    single: async (family, docsBySpace) => {
      for (const [space, docs] of Object.entries(docsBySpace)) {
        for (const doc of docs) await door.push(FORK_FIXTURE[family].single, doc, at(space));
      }
    },
    batch: async (family, docsBySpace) => {
      for (const [space, docs] of Object.entries(docsBySpace)) await door.push('/batch-upsert', { [family]: docs }, at(space));
    },
    pull: async (family, docsBySpace) => {
      for (const [space, docs] of Object.entries(docsBySpace)) door.state.records[space] = { [family]: docs };
      await door.sync();
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
// What the Q-624 fork tests of the resolve, delete, re-key and mesh slice share (was `_q624-fork-fixtures.mjs`, folded here at the merge: one module for
// which kinds fork and how a row of each is built, since the two overlapped in the kind table and in the fork id). The mesh helper stays its own file.
//
//  - `FORK_KINDS` / `assertCoversForkingFamilies`: *which kinds fork, and how is a row of each built.*
//  - `forkIdOfBody` / `seedFork`: *what id does a fork row of this body carry* (design section 3), and storing one under it. Synchronous: it reads the modules
//    `initForkFixtures()` loaded after the door set `CONFIG_PATH`. The ASYNC `forkIdOf` above answers the same question for a test that has the family, the
//    subject, the seq and the document and loads the modules itself.
//  - `reviewDoors`: *what does each door answer for Review's list and resolve*, the five required resolve parameters read from the store at the call.
// ═══════════════════════════════════════════════════════════════════════════════════════════════════════════
import { handlerFor, fakeRes } from './_vote-round-instance.mjs';
import { MAIN_FIELD } from './_fork-body-fixtures.mjs';

// The server modules read `CONFIG_PATH` when first imported, so they are imported after the door has set it: `initForkFixtures()` in `before`.
let upsertPlan; let leaf;
export async function initForkFixtures() {
  upsertPlan = await import('../../server/dist/sync/upsert-plan.js');
  leaf = await import('../../server/dist/sync/authored-content.js').catch(() => undefined);
}

export const leafExists = () => leaf !== undefined;

const ALT_TEXT = Object.freeze({ facts: 'the other version', entities: 'The Other Version', edges: 'the other version', chrono: 'the other version' });
/**
 * Per forking kind (the record type, not the collection): the collection (`family`), the field Review shows by word (`main`), a builder of a minimal row and the
 * body that makes a second version of it. DERIVED from `FORK_FIXTURE` above, which is the one table of how a row of each family is built, so a family is added in
 * one place. An edge fork holds its subject's five identity fields, so its row names its endpoint kinds as the other kinds' rows need not.
 */
export const FORK_KINDS = Object.freeze(Object.fromEntries(Object.entries(FORK_FIXTURE).map(([family, fx]) => [fx.type, {
  family,
  main: fx.field,
  row: (S, id, seq, x = {}) => fx.build(S, id, seq, { ...(family === 'edges' ? { fromKind: 'entity', toKind: 'entity' } : {}), ...x }),
  alt: { [fx.field]: ALT_TEXT[family] },
}])));
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
// The id derives from `forkAt`, the shared version the copies diverged at, never from the row's own `seq`, which is a local stamp (parent decision, 2026-10-25).
export const forkIdOfBody = (family, forkOf, row) => upsertPlan.forkIdFor(forkOf, row.forkAt ?? row.seq, bodyText(family, { ...row, forkOf }));

/**
 * Store a fork of `parentId`: the `extra` body over the kind's minimal row, at the parent's seq, under its derived id. Returns the stored row.
 * An edge fork holds its subject's five identity fields, which the pre-Q-624 identity index refuses, and the refusal says so.
 */
export async function seedFork(door, S, kind, parentId, seq, extra = {}) {
  const k = FORK_KINDS[kind];
  // A carried row's position is its seq (as `a-scanner-reads-every-record-of-a-tie-db` seeds): a row with none is invisible to every position reader.
  const row = { ...k.row(S, 'placeholder', seq, { pos: seq, posAtSeq: seq, ...extra }), forkOf: parentId, forkAt: extra.forkAt ?? seq };
  row._id = forkIdOfBody(k.family, parentId, row);
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
