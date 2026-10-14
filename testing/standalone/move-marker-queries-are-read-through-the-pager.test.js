/**
 * G5 (Q-461, plan order Q-462 first): the questions a move's MARKER is asked are spelled in `files/move-markers.ts` and nowhere
 * else, and the walk over the markers goes through that module's pager (`createMoveMarkerPager`), whose cursor is what stops a
 * pass beginning at the head of the window every time.
 *
 * ## The defect this holds
 *
 * The marker is read three ways: a WALK (every move begun before an instant, in `(from, to)` order, resumed), a PATH-SET read (the
 * moves out of, or into, some paths) and a POINT read (the marker of one named move). A walk written by hand — a `find` on
 * `move.from` with a `limit` and no cursor — looks at the same first moves for ever once they cannot be cleared or finished, and
 * the moves behind them never get a look (`clearing-finished-move-markers-is-a-guarded-walk-db`). The pager exists so a walk has
 * one place to be right; this gate is what stops the next pass from writing its own. And a marker query shape spelled outside
 * the module is a reader the marker block's rules (`no-remover-drops-an-owed-move-marker`, the owed question) never see.
 *
 * ## What a marker query shape is, derived
 *
 * A top-level unit (a function, or a const such as a registry of query builders) of any server source that, in CODE read from the
 * syntax tree (a comment or a string that mentions the name is not code):
 *
 * - names `'move.from'` or `'move.to'` as a property key — except as the operand of an `$exists`-only object (`{ 'move.from':
 *   { $exists: true } }` asks whether a row CARRIES a marker, not which move it is: the prune and the pending-row drop ask it
 *   and are not marker readers), and except inside an index specification (`keys: { 'move.from': 1 }`, which reads nothing); or
 * - calls `moveMarker(...)`, the by-key equality shape; or
 * - names a marker query builder (`.moveMarkers`, `.movesFrom`, `.movesInto`) as a property.
 *
 * ## The rules
 *
 * 1. Every unit that spells a marker query shape is in `move-markers.ts`, or is a POINT read carved out BY NAME with its reason.
 * 2. The unpaged walk (`movesBegunBefore`) is not exported and no other source names it: a walk is `createMoveMarkerPager`.
 * 3. Inside `move-markers.ts`, a unit that READS rows over a marker shape is the pager's own walk or a carved-out bounded read,
 *    by name with its reason — so a second walk added to the module is refused as a new one.
 * 4. The passes that walk markers (the settle's clearing, the housekeeping that finishes an owed move) each hold a pager made by
 *    `createMoveMarkerPager`, imported from `move-markers.ts`.
 *
 * A carve-out whose function is gone, or no longer reads over a marker shape, is a stale exemption and fails.
 *
 * Reads TRACKED sources: a new module is seen once it is `git add`ed.
 *
 * Run: node --test testing/standalone/move-marker-queries-are-read-through-the-pager.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { exportedNames, namesImportedFrom, topLevelDeclarations } from './_module-shape.mjs';
import { ts } from '../_shared/syntax-tree.mjs';
import { blankComments } from './_strip-comments.mjs';

/** The module every marker query shape lives in. */
const HOME = 'server/src/files/move-markers.ts';
/** The walk's one door. */
const PAGER = 'createMoveMarkerPager';
/** The generator behind the pager: the walk itself. Private to the module. */
const UNPAGED_WALK = 'movesBegunBefore';
/** The units that ARE the walk (rule 3): the pager and the generator it runs. */
const WALK_UNITS = new Set([PAGER, UNPAGED_WALK]);

const MARKER_KEYS = new Set(['move.from', 'move.to']);
const SHAPE_BUILDERS = new Set(['moveMarkers', 'movesFrom', 'movesInto']);
const SHAPE_HELPER = 'moveMarker';
const READ_CALLEES = new Set(['find', 'findOne', 'aggregate', 'countDocuments', 'distinct', 'readStoredById']);
const READ_FUNCTIONS = new Set(['ask', 'tombstonesAtPaths']);

/**
 * Point reads carved out BY NAME, each with the reason it is not a walk. Not a place for a read that is inconvenient: an entry is a
 * claim that the read is bounded by a key or a path set the caller holds, so it cannot fall into the head-of-the-window defect.
 * `where` is the file the unit must be in — `HOME` for a unit of the module, or the named exception outside it.
 */
const POINT_READS = new Map([
  ['moveMarkerOf', { where: HOME, why: 'the marker of ONE move, by its (from, to) key: a point read' }],
  ['removeUnlessOwedUnlocked', { where: HOME, why: 'the survivor probe — one findOne asking whether another row of ONE move remains — taken under the remover lock' }],
  ['movesBegunFrom', { where: HOME, why: 'the moves out of the caller\'s own paths: a chunked $in on an index, bounded by the paths it was given, not a walk of markers' }],
  ['movesBegunInto', { where: HOME, why: 'the moves into the caller\'s own path: the same bounded read the other way round' }],
  ['settleBegunMove', { where: 'server/src/files/tombstones.ts', why: 'the pending rows of ONE named move, by its (from, to) key — the lifecycle settles them; it stays beside the publish it ends in so the marker module never imports tombstones.ts' }],
]);

/** The sites a unit's own code spells, read from its syntax tree. */
function factsOf(unit) {
  const f = { shape: [], reads: false };
  const isExistsOnly = (init) => init && ts.isObjectLiteralExpression(init) && init.properties.length > 0
    && init.properties.every(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && p.name?.text === '$exists');
  const inIndexSpec = (n) => {
    // `keys: { 'move.from': 1 }` — the object literal that is the value of a property named `keys`.
    const lit = n.parent;
    return lit && ts.isObjectLiteralExpression(lit) && lit.parent && ts.isPropertyAssignment(lit.parent)
      && (lit.parent.name?.text === 'keys');
  };
  const visit = (n) => {
    if (ts.isPropertyAssignment(n) && n.name && (ts.isStringLiteral(n.name) || ts.isIdentifier(n.name))) {
      const key = n.name.text;
      if (MARKER_KEYS.has(key) && !isExistsOnly(n.initializer) && !inIndexSpec(n)) f.shape.push(`key ${key}`);
      if (SHAPE_BUILDERS.has(key)) f.shape.push(`builder ${key}`);
    }
    if (ts.isPropertyAccessExpression(n) && SHAPE_BUILDERS.has(n.name.text)) f.shape.push(`builder ${n.name.text}`);
    if (ts.isCallExpression(n)) {
      const c = n.expression;
      if (ts.isIdentifier(c) && c.text === SHAPE_HELPER) f.shape.push(`call ${SHAPE_HELPER}`);
      if ((ts.isIdentifier(c) && READ_FUNCTIONS.has(c.text)) || (ts.isPropertyAccessExpression(c) && READ_CALLEES.has(c.name.text))) f.reads = true;
    }
    ts.forEachChild(n, visit);
  };
  visit(unit.node);
  return f;
}

/**
 * Every unit of `sources` (`[{ file, text }]`) that spells a marker query shape, with whether it reads: the derivation both rules
 * are held over. `declared` is every unit name seen, for the stale-exemption check.
 * @returns {{ units: Array<{ file: string, name: string, shape: string[], reads: boolean }>, declared: Set<string> }}
 */
export function analyse(sources) {
  const units = [];
  const declared = new Set();
  for (const { file, text } of sources) {
    for (const d of topLevelDeclarations(file, text)) {
      if (d.kind !== 'function' && d.kind !== 'const') continue;
      declared.add(`${file}#${d.name}`);
      const f = factsOf(d);
      if (f.shape.length > 0) units.push({ file, name: d.name, shape: [...new Set(f.shape)], reads: f.reads });
    }
  }
  return { units, declared };
}

/** Rule 1: the units that spell a marker query shape outside the module and are not carved out. */
export const spelledOutsideTheHome = (units, home = HOME, carved = POINT_READS) =>
  units.filter(u => u.file !== home && carved.get(u.name)?.where !== u.file);

/** Rule 3: the units of the module that READ over a marker shape and are neither the walk nor carved out. */
export const readsThatAreNotTheWalk = (units, home = HOME, carved = POINT_READS, walk = WALK_UNITS) =>
  units.filter(u => u.file === home && u.reads && !walk.has(u.name) && carved.get(u.name)?.where !== u.file);

const src = (file, text) => ({ file, text });
const OTHER = 'server/src/files/other.ts';

describe('the matcher: what is a marker query shape and what is not (synthetic sources)', () => {
  const one = (text, file = OTHER) => analyse([src(file, text)]).units.map(u => [u.name, u.reads]);

  it('a filter keyed on move.from or move.to is a shape, and the by-key helper and a builder are too', () => {
    assert.deepEqual(one(`export async function a(c) { return c.find({ 'move.from': { $in: [] } }).toArray(); }`), [['a', true]]);
    assert.deepEqual(one(`export async function b(c, f, t) { return c.findOne(moveMarker(f, t)); }`), [['b', true]]);
    assert.deepEqual(one(`export async function c(s) { return ask(s, Q.moveMarkers({ before: '' }), {}); }`), [['c', true]]);
    assert.deepEqual(one(`export const REGISTRY = { movesInto: () => ({}) };`), [['REGISTRY', false]]);
  });

  it('an $exists predicate, an index specification, a comment and a string are not a shape', () => {
    assert.deepEqual(one(`export async function d(c) { return c.deleteMany({ 'move.from': { $exists: false } }); }`), []);
    assert.deepEqual(one(`export const INDEXES = [{ keys: { 'move.from': 1, 'move.to': 1 }, options: { sparse: true } }];`), []);
    assert.deepEqual(one(`// find({ 'move.from': 1 })\n/* moveMarker(a, b) */\nexport async function e() { const why = "'move.from': { $in: [] }"; return why; }`), []);
    assert.deepEqual(one(`export async function f(c) { return c.find({ 'move.attempts': 1 }); }`), [], 'another key under move is not the marker shape');
  });

  it('rule 1: a shape outside the module is reported, carved out by name and file it is not, and one in the module never is', () => {
    const outside = analyse([src(OTHER, `export async function walk(c) { return c.find({ 'move.from': { $gt: '' } }).limit(5).toArray(); }`)]).units;
    assert.deepEqual(spelledOutsideTheHome(outside).map(u => u.name), ['walk']);
    assert.deepEqual(spelledOutsideTheHome(outside, HOME, new Map([['walk', { where: OTHER, why: 'x' }]])), []);
    assert.deepEqual(spelledOutsideTheHome(outside, HOME, new Map([['walk', { where: 'server/src/elsewhere.ts', why: 'x' }]])).map(u => u.name), ['walk'],
      'a carve-out holds only in the file it names');
    const inside = analyse([src(HOME, `export async function w(c) { return c.find({ 'move.from': { $gt: '' } }).toArray(); }`)]).units;
    assert.deepEqual(spelledOutsideTheHome(inside), []);
  });

  it('rule 3: a second read over a marker shape inside the module is reported unless it is the walk or carved out', () => {
    const inside = analyse([src(HOME, `export async function w(c) { return c.find({ 'move.from': { $gt: '' } }).toArray(); }\n`
      + `export async function ${UNPAGED_WALK}(s) { return ask(s, Q.moveMarkers({}), {}); }\n`
      + `export async function moveMarkerOf(c, f, t) { return c.findOne(moveMarker(f, t)); }\n`
      + `export async function forget(c, f, t) { return c.updateMany(moveMarker(f, t), {}); }\n`)]).units;
    assert.deepEqual(readsThatAreNotTheWalk(inside).map(u => u.name), ['w'], 'a write is not a read; the generator and a named point read are allowed');
  });
});

describe('every marker query shape is spelled in files/move-markers.ts, and the walk goes through its pager (the real source)', () => {
  const files = trackedSources('server/src', { ext: ['.ts'], floor: 100, specs: false });
  const sources = files.map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));
  const { units, declared } = analyse(sources);

  it('the module exists and the derivation found the shapes it is about (a floor, and the module among them)', () => {
    assert.ok(files.includes(HOME), `${HOME} does not exist: there is no module for the marker's questions to live in (Q-462 lands first)`);
    assert.ok(units.length >= 4, `only ${units.length} unit(s) spell a marker query shape: the derivation looked in the wrong place — ${JSON.stringify(units.map(u => `${u.file}#${u.name}`))}`);
    assert.ok(units.some(u => u.file === HOME), `no unit of ${HOME} spells a marker query shape`);
  });

  it('rule 1: no unit outside the module spells a marker query shape, bar the named point reads', () => {
    const bad = spelledOutsideTheHome(units).map(u => `${u.file}#${u.name} (${u.shape.join(', ')})`);
    assert.deepEqual(bad, [],
      `these spell a marker query shape outside ${HOME}: a marker read written there is never held to the pager or to the owed question — `
      + 'move it into the module, or carve out the point read by name with its reason in POINT_READS');
  });

  it('rule 2: the unpaged walk is private to the module and no other source names it', () => {
    assert.ok(files.includes(HOME), `${HOME} does not exist`);
    assert.ok(!exportedNames(HOME, readFileSync(join(REPO_ROOT, HOME), 'utf8')).has(UNPAGED_WALK),
      `${HOME} exports ${UNPAGED_WALK}: a pass would walk from the head every time; the one door is ${PAGER}`);
    const known = new Set(files);
    const users = sources.filter(s => s.file !== HOME && namesImportedFrom(s.file, s.text, HOME, known).has(UNPAGED_WALK)).map(s => s.file);
    assert.deepEqual(users, [], `these import ${UNPAGED_WALK}: walk through ${PAGER} so the pass resumes after the last move it saw`);
  });

  it('rule 3: inside the module, a read over a marker shape is the pager\'s own walk or a carved-out bounded read', () => {
    assert.ok(files.includes(HOME), `${HOME} does not exist: the rule would hold of an empty module`);
    assert.ok(units.some(u => u.file === HOME && u.reads), `no unit of ${HOME} reads over a marker shape: the derivation looked in the wrong place`);
    const bad = readsThatAreNotTheWalk(units).map(u => `${u.file}#${u.name} (${u.shape.join(', ')})`);
    assert.deepEqual(bad, [], `these read rows over a marker shape in ${HOME} and are neither the walk nor named in POINT_READS with their reason`);
  });

  it('rule 4: the passes that walk the markers each make a pager with createMoveMarkerPager, imported from the module', () => {
    const known = new Set(files);
    const makers = sources.filter(s => s.file !== HOME && /\bcreateMoveMarkerPager\s*\(/.test(blankComments(s.text)));
    assert.ok(makers.length >= 2, `only ${makers.length} source(s) make a marker pager: the settle's clearing and the housekeeping that finishes an owed move each hold one`);
    const notFromHome = makers.filter(s => !namesImportedFrom(s.file, s.text, HOME, known).has(PAGER)).map(s => s.file);
    assert.deepEqual(notFromHome, [], `these call ${PAGER} but do not import it from ${HOME}`);
  });

  it('every carved-out point read names a unit that still exists, where it says, and still reads over a marker shape', () => {
    for (const [name, { where, why }] of POINT_READS) {
      assert.ok(typeof why === 'string' && why.trim().length >= 30, `${name} is carved out with no reason`);
      assert.ok(declared.has(`${where}#${name}`), `${where}#${name} is carved out but no longer exists there — remove or re-point the entry`);
      const u = units.find(x => x.file === where && x.name === name);
      assert.ok(u?.reads, `${where}#${name} is carved out as a read over a marker shape but no longer is one — remove the entry`);
    }
  });
});
