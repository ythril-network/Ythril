/**
 * A door governed by a READ rung never writes a space.
 *
 * ## The rule, and why it needs a gate rather than a review
 *
 * A token holding `read` on a space may call every door priced at `read` — and the rung is the whole of what
 * that token was granted. A read door that writes the space hands a read-only token a write the rights matrix
 * says it does not have, and it does so invisibly: the call succeeds, answers what it was asked, and leaves a
 * record, a file or a counter behind on the side.
 *
 * `Q-92` removed the one known case — `recall` and its siblings spilled an oversized answer into the space's
 * own file tree — but nothing stopped the next one. This gate is that something (`Q-97`).
 *
 * ## What it derives, so nothing here is a list
 *
 * - **The doors**, from the rights tables themselves (`auth/space-rights.ts`): every `TOOL_RIGHTS` row at
 *   `read`, every `ROUTE_RIGHTS` row at `read` whatever its method (`POST /api/brain/recall` is a read), every
 *   mounted GET with no row, and every mounted GET on a `NOT_AREA_SCOPED` path. A GET whose row asks for
 *   more than `read` is not a read door and is left out.
 * - **The walk**, from `_call-graph.mjs`: a tool is rooted at its `handle` by the name the table prices it
 *   under, plus the dispatch every tool call runs through (`_tool-dispatch.mjs`); a route at its inline
 *   handler and middleware. It follows what a call CAUSES — closures, functions handed on, a module's
 *   methods — to exhaustion.
 * - **The writers**, from `_space-writers.mjs`: every mutator on a space collection through whatever alias
 *   reaches it, the space file tree, and the per-space sequence counter.
 *
 * ## The one named exception, and why it is not a hole
 *
 * **The `/api/sync/*` GETs** are how a peer reads this instance, and two of them — the file manifest and the
 * Merkle root — REBUILD the space's file-hash cache (`{space}_file_hashes`) as they read: hashing every file
 * on every sync cycle was the cost the cache exists to avoid. The cache is local machinery, never replicated
 * and never answered from as content. So the exception is scoped to what makes it an exception: a sync GET
 * may reach a write on THAT collection and nothing else, and a sync GET that reaches any other space write
 * fails exactly like any other read door.
 *
 * ## What it cannot see, stated rather than implied
 *
 * A method on a class instance (`new X().m()`), `this.m()`, and a function looked up at runtime
 * (`handler.handle(ctx)` in the dispatch). `_call-graph.mjs` names each; the orphan check below makes sure no
 * space write is written in a shape the index cannot attribute to a function at all.
 *
 * Run: node --test testing/standalone/a-read-never-writes-a-space.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, toolHandlerRoot, routeHandlerRoots, walkFrom, pathTo } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { spaceWriters, SPACE_KINDS } from './_space-writers.mjs';
import { DISPATCH_SOURCES } from './_tool-dispatch.mjs';
import { TOOL_RIGHTS, ROUTE_RIGHTS, NOT_AREA_SCOPED_PATHS } from '../../server/dist/auth/space-rights.js';
import { SPACE_COLLECTIONS } from '../../server/dist/db/space-collection.js';

const INDEX = moduleIndex('server/src');
const ROUTES = mountedRoutes();
// Registered BEFORE the writers are derived, so a write inside an inline handler belongs to its route.
const ROUTE_ROOTS = new Map(ROUTES.map(r => [`${r.method} ${r.path}`, routeHandlerRoots(INDEX, r)]));

/*
 * Floors on every enumeration, set a little under what the tree held when this was written. Raise them as it
 * grows; a run below one means the derivation stopped matching, and a thin set makes every door clean. The
 * ALIAS floor is the one that proves the alias resolution is live: with it disabled, most of those sites
 * fall to `unknown` and this throws.
 */
// `space` lowered from 170 when the plan/commit split folded the create/converge writers' direct writes into
// one commit (`Q-99` part 3): the sites went because the copies did, not because the scan broke.
const WRITERS = spaceWriters(INDEX, { floors: { space: 150, alias: 65, files: 40 } });
const WRITER_FUNCTION_FLOOR = 110;
const READ_DOOR_FLOOR = 100;

/** The cache a sync GET may rebuild — the one space collection that is local machinery a read maintains. */
const SYNC_READ_CACHE = SPACE_COLLECTIONS.fileHashes;
const isSyncGet = door => door.method === 'GET' && door.path.startsWith('/api/sync/');

/** The keys of the function(s) every tool call runs through before its handler. */
function dispatchRoots() {
  const keys = [...INDEX.bodies.keys()].filter(k => DISPATCH_SOURCES.some(f => k === `${f}:callTool`));
  assert.ok(keys.length > 0, `no callTool in ${DISPATCH_SOURCES.join(', ')} — re-anchor the tool door's dispatch root`);
  return keys;
}

function readDoors() {
  const doors = [];
  for (const row of TOOL_RIGHTS.filter(r => r.needs === 'read')) {
    doors.push({ label: `MCP ${row.tool}`, roots: [toolHandlerRoot(INDEX, row.tool), ...dispatchRoots()] });
  }
  const rowed = new Map(ROUTE_RIGHTS.map(r => [`${r.method} ${r.route}`, r]));
  for (const row of ROUTE_RIGHTS.filter(r => r.needs === 'read')) {
    const key = `${row.method} ${row.route}`;
    assert.ok(ROUTE_ROOTS.has(key), `ROUTE_RIGHTS prices ${key} at read, and no mounted route serves it — a door `
      + 'that cannot be rooted is one this gate would pass over');
  }
  for (const route of ROUTES) {
    const key = `${route.method} ${route.path}`;
    const row = rowed.get(key);
    const read = row ? row.needs === 'read' : route.method === 'GET';
    if (!read) continue;
    const why = row ? 'ROUTE_RIGHTS read row' : NOT_AREA_SCOPED_PATHS.has(route.path) ? 'NOT_AREA_SCOPED GET' : 'unrowed GET';
    doors.push({ label: `${key} (${why})`, method: route.method, path: route.path, roots: ROUTE_ROOTS.get(key) });
  }
  return doors;
}

const DOORS = readDoors();

/*
 * A REST door that IS a tool: `POST /api/brain/recall` answers through `callTool({ name: 'recall', … })`, and
 * the handler is looked up at runtime — so without this edge the REST half of recall roots at a route that
 * reaches nothing, and passes. Found by the first red run of this gate: the spill re-introduced into
 * `recall` failed `MCP recall` and not its REST twin. Only a LITERAL name is resolved; the generic
 * `POST /api/:tool` names the tool from the path and is a door at no fixed rung, so it is not a read door.
 */
const DISPATCH_BY_NAME = /\bcallTool\s*\(\s*\{\s*name:\s*['"]([a-z_]+)['"]/g;
const dispatchedTools = entry => [...entry.body.matchAll(DISPATCH_BY_NAME)].map(m => toolHandlerRoot(INDEX, m[1]));

/** Every space write a door reaches, with the path to it — one per writing function. */
function writesReachedBy(door) {
  const { seen, parent } = walkFrom(INDEX, door.roots, { closures: true, edges: dispatchedTools });
  const out = [];
  for (const key of seen) {
    for (const site of WRITERS.byKey.get(key) ?? []) {
      if (!SPACE_KINDS.has(site.kind)) continue;
      out.push({ site, path: pathTo(parent, key) });
    }
  }
  return out;
}

const show = ({ site, path }) => `      ${path.map(k => k.replace(/^server\/src\//, '')).join('\n        -> ')}\n`
  + `        writes: ${site.file}:${site.line} .${site.op}() on ${site.receiver} — ${site.kind}: ${site.why}`;

describe('a door governed by a read rung never writes a space', () => {
  it('the derived sets are not thin', () => {
    const writing = [...WRITERS.byKey].filter(([, list]) => list.some(s => SPACE_KINDS.has(s.kind))).length;
    assert.ok(writing >= WRITER_FUNCTION_FLOOR,
      `only ${writing} function(s) write a space, below the floor of ${WRITER_FUNCTION_FLOOR} — the writer derivation `
      + 'broke, and every read door would report clean.');
    assert.ok(DOORS.length >= READ_DOOR_FLOOR,
      `only ${DOORS.length} read door(s) derived, below the floor of ${READ_DOOR_FLOOR} — the door derivation broke.`);
    assert.ok(DOORS.some(d => d.label.startsWith('MCP ')) && DOORS.some(d => /ROUTE_RIGHTS read row/.test(d.label))
      && DOORS.some(d => /unrowed GET/.test(d.label)) && DOORS.some(d => /NOT_AREA_SCOPED GET/.test(d.label)),
    'one of the four door populations derived to nothing: '
      + `${['MCP ', 'ROUTE_RIGHTS read row', 'unrowed GET', 'NOT_AREA_SCOPED GET'].map(p => `${p.trim()}: ${DOORS.filter(d => d.label.includes(p)).length}`).join(', ')}`);
  });

  it('the writer set holds the writers this rule was written about', () => {
    // Anchors, not the set: each is a writer the ticket named, found by a DIFFERENT path through the
    // derivation — a helper-returned collection, the counter, the file tree, a direct open.
    for (const key of ['server/src/brain/embed-queue.ts:enqueueEmbedJob', 'server/src/util/seq.ts:bumpSeq',
      'server/src/files/stored-bytes.ts:writeStored', 'server/src/files/file-meta.ts:upsertFileMeta']) {
      assert.ok(writesReachedBy({ roots: [key] }).length > 0,
        `${key} reaches no space write — the derivation lost a whole path through it`);
    }
  });

  it('every write-rung tool reaches a writer, so the walk and the writer set meet', () => {
    // The converse of the rule, and what makes a clean run mean something: a walk that reached nothing, or a
    // writer set nothing reached, would pass every read door too.
    const hollow = TOOL_RIGHTS.filter(r => r.needs === 'write')
      .filter(r => writesReachedBy({ roots: [toolHandlerRoot(INDEX, r.tool)] }).length === 0).map(r => r.tool);
    assert.deepEqual(hollow, [], `write-rung tool(s) that reach no space writer: ${hollow.join(', ')}. Either the walk `
      + 'lost the path to their writes or the writer derivation lost the writes — a read door would pass the same way.');
  });

  it('no space write sits where the index cannot attribute it to a function', () => {
    const orphans = WRITERS.orphans.filter(o => SPACE_KINDS.has(o.kind));
    assert.deepEqual(orphans.map(o => `${o.file}:${o.line} .${o.op}() — ${o.why}`), [],
      'a space write outside every indexed function (a class method, a module-level statement) is one no walk can '
      + 'reach, so this gate would pass over it. Move it into a function, or teach _call-graph.mjs the shape.');
  });

  it('no read door reaches a write into a space', () => {
    const offenders = [];
    for (const door of DOORS) {
      const reached = writesReachedBy(door)
        .filter(w => !(isSyncGet(door) && w.site.kind === 'space' && w.site.collection === SYNC_READ_CACHE));
      if (reached.length > 0) offenders.push(`  ${door.label}\n${reached.map(show).join('\n')}`);
    }
    assert.deepEqual(offenders, [],
      `${offenders.length} read door(s) reach a write into a space — a token holding only 'read' can cause each of `
      + `these:\n\n${offenders.join('\n\n')}\n\nA read that must maintain something is writing it somewhere other than `
      + 'the space (an instance collection, a local cache outside the space), or it is not a read.');
  });

  it('the sync exception is only ever the hash cache, and it is still needed', () => {
    const sync = DOORS.filter(isSyncGet);
    assert.ok(sync.length > 0, 'no /api/sync GET derived — the exception names a population that no longer exists');
    const cacheWrites = sync.flatMap(d => writesReachedBy(d)).filter(w => w.site.collection === SYNC_READ_CACHE);
    // If nothing reaches the cache any more, the exception is dead weight that would excuse the next one.
    assert.ok(cacheWrites.length > 0,
      `no sync GET writes ${SYNC_READ_CACHE} any more — delete the exception rather than leave it excusing a future write`);
  });
});
