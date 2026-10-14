/**
 * The questions a move's MARKER answers live in their own module, `files/move-markers.ts`; the collection they are asked of is
 * opened by `files/tombstone-store.ts`; and `files/tombstones.ts` keeps the tombstone lifecycle — with no import cycle among the
 * three and no one of them over the size ceiling (Q-462, bundle-113 design-r4).
 *
 * ## The defect this holds
 *
 * `files/tombstones.ts` held three things at once: the tombstone lifecycle (written pending, settled, published, pruned, applied
 * against arrivals), the move's marker (is this move still owed? forget it, record an attempt, remove a marker row unless the
 * move is owed), and the collection both are read through. It grew past the size ceiling that holds a source file to one concern, and the marker
 * block — the part `no-remover-drops-an-owed-move-marker` and G5 (`move-marker-queries-are-read-through-the-pager`) hold — could
 * not be named as one place, so a rule about "the marker's questions" had to be stated as a list of functions in a file that is
 * mostly something else. The split is the cheapest honest way under the ceiling: it is not a FROZEN row.
 *
 * ## The shape it must have
 *
 * - `tombstone-store.ts` — the collection primitives and the types both blocks need (`tombstonesOf`, `StoredFileTombstone`,
 *   `MoveMarker`, `PrunableRow`, the keyset `ask`, the by-path read, the query registry, the wipe generation).
 * - `move-markers.ts` — the marker block. It imports the store, never `tombstones.ts`.
 * - `tombstones.ts` — the lifecycle, importing both. **`settleBegunMove` stays here**: it is the one marker-keyed act that must
 *   publish a tombstone, and a copy of it in `move-markers.ts` would make that module import `tombstones.ts` back, which is the
 *   cycle. Edges: tombstones -> store, tombstones -> markers, markers -> store, and nothing else among the three.
 *
 * ## What is a list here and what is derived
 *
 * The marker block's NAMES are the plan's own list (design-r4 Q-462, ret-probes P7) — a ruling about where named things go, so
 * it is stated. Everything that could go stale is read out of the tree: who defines or re-exports a name (a second door counts,
 * and it is what a compatibility shim in `tombstones.ts` would be), which sources still import a moved name from the old
 * module, the import graph, and the size measure (`_oversize-files.mjs`, the one measurement). Each derivation carries a floor.
 *
 * Reads TRACKED sources: a new module is seen once it is `git add`ed.
 *
 * Run: node --test testing/standalone/the-move-marker-block-is-its-own-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { CEILING, FROZEN, codeLines } from './_oversize-files.mjs';
import { exportedNames, namesImportedFrom, relativeImports, topLevelDeclarations } from './_module-shape.mjs';

const TOMBSTONES = 'server/src/files/tombstones.ts';
const STORE = 'server/src/files/tombstone-store.ts';
const MARKERS = 'server/src/files/move-markers.ts';

/** What `move-markers.ts` defines and exports: the marker block, by the plan's own list. Each is a question about a move's marker. */
const MARKER_BLOCK = [
  'moveIsOwed', 'moveMarkerOf', 'createMoveMarkerPager', 'removeUnlessOwed', 'forgetFinishedMove', 'movesBegunInto',
  'recordMoveAttempt', 'abandonMove', 'moveCarriesRecordsAt', 'MOVE_MARKER_KEEP_MS',
];

/** What stays in `tombstones.ts`, and why: it publishes a tombstone, so moving it would make the marker module import its caller. */
const STAYS_IN_TOMBSTONES = { settleBegunMove: 'settles the pending tombstones a move left; the marker module must not import tombstones.ts' };

/** What `tombstone-store.ts` defines and exports: what BOTH other modules read the collection through. */
const STORE_PRIMITIVES = [
  'tombstonesOf', 'StoredFileTombstone', 'MoveMarker', 'PrunableRow', 'ask', 'tombstonesAtPaths', 'FILE_TOMBSTONE_QUERIES', 'wipeGenerationOf',
  'FILE_TOMBSTONE_SETTLE_BATCH',
];

const serverSources = () => trackedSources('server/src', { ext: ['.ts'], floor: 100, specs: false });
const read = (f) => readFileSync(join(REPO_ROOT, f), 'utf8');
const sources = serverSources();
const has = (f) => sources.includes(f);

describe('the three modules exist and each name is defined once, where the split puts it', () => {
  it('files/move-markers.ts and files/tombstone-store.ts exist among the tracked sources', () => {
    assert.ok(has(MARKERS), `${MARKERS} does not exist: the marker block is still inside ${TOMBSTONES}`);
    assert.ok(has(STORE), `${STORE} does not exist: the collection is still opened by ${TOMBSTONES}`);
    assert.ok(has(TOMBSTONES), `${TOMBSTONES} is gone — the lifecycle module is not part of this split`);
  });

  it('move-markers.ts defines and exports every name of the marker block', () => {
    assert.ok(has(MARKERS), `${MARKERS} does not exist`);
    const text = read(MARKERS);
    const defined = new Map(topLevelDeclarations(MARKERS, text).map(d => [d.name, d]));
    const exported = exportedNames(MARKERS, text);
    assert.deepEqual(MARKER_BLOCK.filter(n => !defined.has(n)), [], `${MARKERS} does not define these names`);
    assert.deepEqual(MARKER_BLOCK.filter(n => !exported.has(n)), [], `${MARKERS} defines but does not export these names: tombstones.ts and the housekeeping that finishes a move read them`);
  });

  it('tombstones.ts neither defines nor re-exports a name of the marker block — no second door, no shim', () => {
    const text = read(TOMBSTONES);
    const declared = new Set(topLevelDeclarations(TOMBSTONES, text).map(d => d.name));
    const exported = exportedNames(TOMBSTONES, text);
    const still = MARKER_BLOCK.filter(n => declared.has(n) || exported.has(n));
    assert.deepEqual(still, [],
      `${TOMBSTONES} still defines or exports these marker names: a name with two doors is read from either, which is how a rule `
      + 'about the marker ends up held at one of them (a re-export is the shim a split leaves behind)');
  });

  it('each name of the marker block is defined in exactly one server source, and it is move-markers.ts', () => {
    const definers = new Map(MARKER_BLOCK.map(n => [n, []]));
    for (const f of sources) {
      for (const d of topLevelDeclarations(f, read(f))) if (definers.has(d.name)) definers.get(d.name).push(f);
    }
    for (const [name, files] of definers) assert.deepEqual(files, [MARKERS], `${name} is defined in ${JSON.stringify(files)}, not only in ${MARKERS}`);
  });

  it('no server source imports a name of the marker block from tombstones.ts', () => {
    const known = new Set(sources);
    const stale = [];
    for (const f of sources) {
      if (f === TOMBSTONES) continue;
      for (const n of namesImportedFrom(f, read(f), TOMBSTONES, known)) if (MARKER_BLOCK.includes(n)) stale.push(`${f}: ${n}`);
    }
    assert.deepEqual(stale, [], 'these sources still read a marker name from tombstones.ts — import it from files/move-markers.js');
  });

  it('settleBegunMove stays in tombstones.ts, exported, and is not defined in the marker module', () => {
    const text = read(TOMBSTONES);
    for (const name of Object.keys(STAYS_IN_TOMBSTONES)) {
      const d = topLevelDeclarations(TOMBSTONES, text).find(x => x.name === name);
      assert.ok(d?.exported, `${name} must stay defined and exported in ${TOMBSTONES} (${STAYS_IN_TOMBSTONES[name]})`);
      if (has(MARKERS)) {
        assert.ok(!topLevelDeclarations(MARKERS, read(MARKERS)).some(x => x.name === name), `${MARKERS} defines ${name}: it would then have to import tombstones.ts back — the cycle`);
      }
    }
  });

  it('tombstone-store.ts defines and exports what both modules read the collection through, and tombstones.ts no longer defines it', () => {
    assert.ok(has(STORE), `${STORE} does not exist`);
    const text = read(STORE);
    const defined = new Set(topLevelDeclarations(STORE, text).map(d => d.name));
    const exported = exportedNames(STORE, text);
    assert.deepEqual(STORE_PRIMITIVES.filter(n => !defined.has(n)), [], `${STORE} does not define these names`);
    assert.deepEqual(STORE_PRIMITIVES.filter(n => !exported.has(n)), [], `${STORE} does not export these names: the other two modules cannot reach them`);
    const inTombstones = new Set(topLevelDeclarations(TOMBSTONES, read(TOMBSTONES)).map(d => d.name));
    assert.deepEqual(STORE_PRIMITIVES.filter(n => inTombstones.has(n)), [], `${TOMBSTONES} still defines these store primitives: a second copy of the collection's door`);
  });
});

/**
 * The import graph among the three, from the source (type imports INCLUDED: the types both blocks need live in the store exactly
 * so that no type has to be imported back), and the runtime graph over the whole server tree for a cycle that runs through any
 * other module.
 */
function edgesOf(file, known) {
  return relativeImports(file, read(file), known);
}

/** Does `start` reach itself over `graph` (Map<string, Set<string>>)? Returns the path or null. */
export function cycleThrough(start, graph) {
  const seen = new Set();
  const walk = (node, path) => {
    for (const next of graph.get(node) ?? []) {
      if (next === start) return [...path, next];
      if (seen.has(next)) continue;
      seen.add(next);
      const found = walk(next, [...path, next]);
      if (found) return found;
    }
    return null;
  };
  return walk(start, [start]);
}

describe('the cycle finder (synthetic graphs): a gate that matched nothing would fail these', () => {
  it('finds a direct and an indirect cycle, and none in a chain', () => {
    const g = (o) => new Map(Object.entries(o).map(([k, v]) => [k, new Set(v)]));
    assert.deepEqual(cycleThrough('a', g({ a: ['b'], b: ['a'] })), ['a', 'b', 'a']);
    assert.deepEqual(cycleThrough('a', g({ a: ['b'], b: ['c'], c: ['a'] })), ['a', 'b', 'c', 'a']);
    assert.equal(cycleThrough('a', g({ a: ['b'], b: ['c'], c: [] })), null);
  });
});

describe('tombstones.ts, tombstone-store.ts and move-markers.ts form no import cycle, and the edges run one way', () => {
  const known = new Set(sources);

  it('the edges are tombstones -> store, tombstones -> markers, markers -> store, and no others among the three', () => {
    for (const f of [TOMBSTONES, STORE, MARKERS]) assert.ok(has(f), `${f} does not exist, so no edge of the split can be checked`);
    const among = (f) => new Set(edgesOf(f, known).map(e => e.to).filter(t => [TOMBSTONES, STORE, MARKERS].includes(t)));
    assert.deepEqual([...among(TOMBSTONES)].sort(), [MARKERS, STORE].sort(), `${TOMBSTONES} must import both the store and the marker module`);
    assert.deepEqual([...among(MARKERS)], [STORE], `${MARKERS} must import the store and nothing else of the three (never ${TOMBSTONES}, even as a type)`);
    assert.deepEqual([...among(STORE)], [], `${STORE} must import neither of the other two: it is the bottom of the split`);
  });

  it('no one of the three reaches itself through the runtime imports of the whole server tree', () => {
    for (const f of [TOMBSTONES, STORE, MARKERS]) assert.ok(has(f), `${f} does not exist`);
    const graph = new Map();
    let edges = 0;
    for (const f of sources) {
      const deps = new Set(edgesOf(f, known).filter(e => e.runtime).map(e => e.to));
      edges += deps.size;
      graph.set(f, deps);
    }
    assert.ok(edges >= 300, `only ${edges} runtime imports resolved: the reader is looking at the wrong thing`);
    const cycles = [TOMBSTONES, STORE, MARKERS].map(f => cycleThrough(f, graph)).filter(Boolean).map(p => p.join(' -> '));
    assert.deepEqual(cycles, [], 'a module of the split imports itself back at runtime, through the path shown');
  });
});

describe('the split lands under the size ceiling and does not need a FROZEN row', () => {
  it('each of the three has code lines at or under CEILING and no FROZEN entry', () => {
    const rows = [];
    for (const f of [TOMBSTONES, STORE, MARKERS]) {
      assert.ok(has(f), `${f} does not exist`);
      const n = codeLines(read(f));
      rows.push(`${f}: ${n}`);
      assert.ok(n <= CEILING, `${f} has ${n} code lines, over the ceiling of ${CEILING} — the split has to leave every module under it, not move the excess`);
      assert.equal(FROZEN[f], undefined, `${f} has a FROZEN row: the split is meant to need none (a ratchet entry would hand back the headroom it just made)`);
    }
    assert.ok(rows.length === 3);
  });

  it('the marker module is a real module and not a stub that lets the others pass: it holds the marker block', () => {
    assert.ok(has(MARKERS), `${MARKERS} does not exist`);
    assert.ok(codeLines(read(MARKERS)) >= 100, `${MARKERS} is under 100 code lines: the marker block (the owed question, the remover, the pager, the attempt record) is not in it`);
    assert.ok(codeLines(read(STORE)) >= 50, `${STORE} is under 50 code lines: the collection primitives are not in it`);
  });
});
