/**
 * Nothing that removes a file tombstone, or the marker a move leaves on one, may do so without asking whether the move is OWED
 * (bundle-44, Q-345; plan rev 3 D4).
 *
 * ## The defect this holds
 *
 * A move a failure stopped after its bytes is known to be unfinished by ONE thing: the `move` marker on its tombstone rows. The
 * marker went in nine places that each decided for themselves, and not one asked whether the record was still at the source: the
 * settle forgot it ten minutes on, the prune took its row a day on, a supersede or a drop removed the row that carried it.
 * Each looked right where it stood (a marker nobody will look for is clutter), and the move stranded all the same.
 *
 * `moveIsOwed` (`files/move-markers.ts` since Q-462 split the marker block out of `files/tombstones.ts`) is the one question — is this move still owed? — and a remover that does not consult it
 * is the next copy. The rule is held HERE for every remover, not for the nine that exist: the sites are DERIVED from the source,
 * so a tenth remover written next year is caught by the file that holds the other nine.
 *
 * ## What counts as a site, and what counts as asking
 *
 * A SITE is a top-level function, in a source file that names the file-tombstone collection (`tombstonesOf`, or the collection key
 * `fileTombstones` / `file_tombstones`), whose body — nested closures included — either
 *
 * - deletes a row of it: a `.deleteMany(`, `.deleteOne(`, `.findOneAndDelete(` or `.drop(` call, or a `deleteMany` / `deleteOne`
 *   operation inside a bulk write; or
 * - `$unset`s the `move` marker;
 *
 * and, anywhere in `server/src`, any function that CALLS one that unsets the marker (the caller that decides when to forget a move
 * is the remover that matters: `clearFinishedMoveMarkers` and the move's own completion never delete a row themselves).
 *
 * A site ASKS when its body CALLS `moveIsOwed` — a call, read from the syntax tree, never a mention: an import of the name, a
 * comment, or a string that says it does not count — or calls a function (named uniquely in `server/src`) that asks, transitively.
 * The tree is parsed from the original source, so comments are not code and reported lines are the original file's.
 *
 * A site that must not ask is listed in `EXEMPT` WITH ITS REASON; an entry whose site is gone, or that has no reason, fails.
 *
 * ## Seen red
 *
 * The three checks over the real source are red until the move's owed question exists and every remover asks it. The matcher is held
 * by synthetic sources (a remover that asks, one that does not, one that only mentions the name, one that asks through a helper
 * in another file, a caller of the marker's remover), so a gate that matched nothing would fail those rather than pass.
 *
 * Run: node --test testing/standalone/no-remover-drops-an-owed-move-marker.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { parseSource, lineOf, ts } from '../_shared/syntax-tree.mjs';

/** The one question every remover asks. */
const OWED_CHECK = 'moveIsOwed';
/**
 * Where the question lives: the move-marker module (Q-462). Re-pointed deliberately from `tombstones.ts`, which keeps the lifecycle
 * and the space wipe (`EXEMPT` below) but no longer defines the question. The derivation's floor on this file (a remover found in
 * it) is kept: the marker's own removers (`removeUnlessOwed`, `forgetFinishedMove`) live here now, and a derivation that found none
 * in the module would be looking in the wrong place.
 */
const OWED_CHECK_HOME = 'server/src/files/move-markers.ts';

/**
 * Removers that must NOT ask, by `<file>#<function>`, each with the reason. Not a place to put a remover that is inconvenient:
 * an entry is a claim that no move can be owed where it runs.
 */
const EXEMPT = new Map([
  ['server/src/files/tombstones.ts#forgetFileTombstonesOf',
    'the space wipe: it forgets every tombstone and every marker of the space by design — the space no longer holds the files a move would carry, so nothing is owed in it'],
]);

/** The fewest sites that mean the derivation looked at the right place (far under what is held, so a removal is not a tripwire). */
const SITE_FLOOR = 5;

const COLLECTION_NAMES = new Set(['fileTombstones', 'file_tombstones']);
const DELETERS = new Set(['deleteMany', 'deleteOne', 'findOneAndDelete', 'drop']);

/** The name a property or member is spelled with, when it is a plain name. */
const nameOf = (n) => (n && (ts.isIdentifier(n) || ts.isStringLiteralLike(n)) ? n.text : undefined);

/** Every top-level function-like declaration of a parsed file: `{ name, node }`. */
function topLevelFunctions(sf) {
  const out = [];
  const isFn = (e) => e && (ts.isArrowFunction(e) || ts.isFunctionExpression(e));
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name && st.body) out.push({ name: st.name.text, node: st });
    else if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) if (ts.isIdentifier(d.name) && isFn(d.initializer)) out.push({ name: d.name.text, node: d.initializer });
    } else if (ts.isClassDeclaration(st) && st.name) {
      for (const m of st.members) if (ts.isMethodDeclaration(m) && m.body && nameOf(m.name)) out.push({ name: `${st.name.text}.${nameOf(m.name)}`, node: m });
    }
  }
  return out;
}

/** What one function body does, read from its syntax tree (nested closures included; comments are not nodes). */
function factsOf(node) {
  const f = { touchesCollection: false, removes: null, unsetsMove: false, calls: new Set(), asks: false };
  const visit = (n) => {
    if (ts.isIdentifier(n) && n.text === 'tombstonesOf') f.touchesCollection = true;
    if (ts.isStringLiteralLike(n) && (COLLECTION_NAMES.has(n.text) || /_file_tombstones/.test(n.text))) f.touchesCollection = true;
    if ((ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n) || ts.isPropertyAccessExpression(n)) && COLLECTION_NAMES.has(nameOf(n.name) ?? '')) f.touchesCollection = true;
    if (ts.isCallExpression(n)) {
      const callee = n.expression;
      if (ts.isIdentifier(callee)) { f.calls.add(callee.text); if (callee.text === OWED_CHECK) f.asks = true; }
      else if (ts.isPropertyAccessExpression(callee)) {
        if (callee.name.text === OWED_CHECK) f.asks = true;
        if (DELETERS.has(callee.name.text)) f.removes ??= n;
      }
    }
    if (ts.isObjectLiteralExpression(n)) {
      for (const p of n.properties) {
        const key = nameOf(p.name);
        if (key === 'deleteMany' || key === 'deleteOne') f.removes ??= p;
        if (key === '$unset' && ts.isPropertyAssignment(p) && ts.isObjectLiteralExpression(p.initializer)
          && p.initializer.properties.some(q => nameOf(q.name) === 'move')) { f.unsetsMove = true; f.removes ??= p; }
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return f;
}

/**
 * The sites in `sources` (`[{ file, text }]`) and whether each asks, by the rule in the module docblock.
 * @returns {{ sites: Array<{ key: string, file: string, name: string, line: number, why: string, asks: boolean }>, declared: Set<string> }}
 */
export function analyse(sources) {
  const decls = [];
  for (const { file, text } of sources) {
    const sf = parseSource(file, text);
    for (const { name, node } of topLevelFunctions(sf)) decls.push({ file, name, key: `${file}#${name}`, facts: factsOf(node), line: lineOf(sf, node) });
  }
  // A name defined once in the whole set can be followed; one defined twice is ambiguous, and an ambiguous call asks nothing.
  const byName = new Map();
  for (const d of decls) byName.set(d.name, [...(byName.get(d.name) ?? []), d]);
  const unique = (name) => (byName.get(name)?.length === 1 ? byName.get(name)[0] : undefined);

  const asks = (d, seen = new Set()) => {
    if (d.facts.asks) return true;
    if (seen.has(d.key)) return false;
    seen.add(d.key);
    for (const c of d.facts.calls) {
      const callee = unique(c);
      if (callee && callee.key !== d.key && asks(callee, seen)) return true;
    }
    return false;
  };

  const unsetters = new Set(decls.filter(d => d.facts.touchesCollection && d.facts.unsetsMove).map(d => d.name));
  const sites = [];
  for (const d of decls) {
    const removes = d.facts.touchesCollection && d.facts.removes;
    const callsAnUnsetter = !removes && [...d.facts.calls].some(c => unsetters.has(c));
    if (!removes && !callsAnUnsetter) continue;
    sites.push({
      key: d.key, file: d.file, name: d.name, line: d.line, asks: asks(d),
      why: removes ? (d.facts.unsetsMove ? 'unsets the move marker' : 'deletes file-tombstone rows') : 'calls the function that unsets the move marker',
    });
  }
  return { sites, declared: new Set(decls.map(d => d.key)) };
}

/** The sites that neither ask nor carry a reasoned exemption. */
export const unguarded = (sites, exempt = EXEMPT) => sites.filter(s => !s.asks && !exempt.has(s.key));

/** Every tracked source of the server, read. The floor is inside `trackedSources`: an empty listing throws. */
function serverSources() {
  return trackedSources('server/src', { ext: ['.ts'], floor: 100, specs: false })
    .map(file => ({ file, text: readFileSync(join(REPO_ROOT, file), 'utf8') }));
}

const src = (file, text) => ({ file, text });
const TOMB = 'server/src/files/tombstones.ts';

describe('the matcher: what is a remover and what asks (synthetic sources)', () => {
  const remover = (body) => `const tombstonesOf = (s) => col(s);\nexport async function drop(s) { ${body} }\n`;

  it('a function that deletes file-tombstone rows is a site, and without the question it is unguarded', () => {
    const { sites } = analyse([src(TOMB, remover('await tombstonesOf(s).deleteMany({});'))]);
    assert.deepEqual(sites.map(s => [s.name, s.asks]), [['drop', false]]);
    assert.deepEqual(unguarded(sites, new Map()).map(s => s.name), ['drop']);
  });

  it('one that calls the question is guarded', () => {
    const { sites } = analyse([src(TOMB, remover('if (await moveIsOwed(s, a, b)) return; await tombstonesOf(s).deleteMany({});'))]);
    assert.deepEqual(sites.map(s => [s.name, s.asks]), [['drop', true]]);
  });

  it('a comment, a string and an import that only NAME the question do not make it asked', () => {
    const text = `import { moveIsOwed } from './x.js';\n// moveIsOwed(s) is consulted here\n/* moveIsOwed */\n`
      + `const tombstonesOf = (s) => col(s);\nexport async function drop(s) { const why = 'moveIsOwed'; await tombstonesOf(s).deleteMany({}); }\n`;
    const { sites } = analyse([src(TOMB, text)]);
    assert.deepEqual(sites.map(s => [s.name, s.asks]), [['drop', false]], 'a mention was taken for a call');
  });

  it('asking through a helper — in another file, by a unique name — counts; through an ambiguous name it does not', () => {
    const helper = src('server/src/files/owed.ts', 'export async function checkedFirst(s) { return moveIsOwed(s); }\n');
    const viaHelper = analyse([src(TOMB, remover('if (await checkedFirst(s)) return; await tombstonesOf(s).deleteMany({});')), helper]);
    assert.deepEqual(viaHelper.sites.map(s => s.asks), [true]);
    const twin = src('server/src/files/other.ts', 'export async function checkedFirst(s) { return 1; }\n');
    const ambiguous = analyse([src(TOMB, remover('if (await checkedFirst(s)) return; await tombstonesOf(s).deleteMany({});')), helper, twin]);
    assert.deepEqual(ambiguous.sites.map(s => s.asks), [false], 'an ambiguous name was followed');
  });

  it('a bulk delete operation and the unset of the move marker are removers; the caller of the latter is a site too', () => {
    const text = `const tombstonesOf = (s) => col(s);\n`
      + `export async function supersede(s) { return tombstonesOf(s).bulkWrite([{ deleteMany: { filter: {} } }]); }\n`
      + `export async function forget(s) { return tombstonesOf(s).updateMany({}, { $unset: { move: '' } }); }\n`;
    const caller = src('server/src/files/move-cascade.ts', 'export async function finish(s) { await forget(s); }\nexport async function unrelated(s) { await other(s); }\n');
    const { sites } = analyse([src(TOMB, text), caller]);
    assert.deepEqual(sites.map(s => s.name).sort(), ['finish', 'forget', 'supersede']);
    assert.equal(sites.find(s => s.name === 'forget').why, 'unsets the move marker');
  });

  it('a delete in a file that does not name the file-tombstone collection is not a site', () => {
    const { sites } = analyse([src('server/src/other/thing.ts', 'export async function wipe(c) { await c.deleteMany({}); }\n')]);
    assert.deepEqual(sites, []);
  });

  it('a site in the exemption table is not reported, and an unlisted one is', () => {
    const { sites } = analyse([src(TOMB, remover('await tombstonesOf(s).deleteMany({});'))]);
    assert.deepEqual(unguarded(sites, new Map([[`${TOMB}#drop`, 'reason']])), []);
    assert.deepEqual(unguarded(sites, new Map([[`${TOMB}#elsewhere`, 'reason']])).map(s => s.name), ['drop']);
  });
});

describe('every remover of a file tombstone or of its move marker asks whether the move is owed (the real source)', () => {
  const sources = serverSources();
  const { sites, declared } = analyse(sources);

  it('the question exists: files/move-markers.ts defines and exports moveIsOwed', () => {
    const text = sources.find(s => s.file === OWED_CHECK_HOME)?.text;
    assert.ok(text, `${OWED_CHECK_HOME} is not among the tracked sources — re-anchor this gate`);
    const sf = parseSource(OWED_CHECK_HOME, text);
    const fn = sf.statements.find(st => ts.isFunctionDeclaration(st) && st.name?.text === OWED_CHECK);
    assert.ok(fn, `${OWED_CHECK_HOME} defines no function ${OWED_CHECK}: there is no question for a remover to ask (plan D4)`);
    assert.ok(fn.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword), `${OWED_CHECK} is not exported: the move's own cascade and the media worker cannot ask it`);
  });

  it('the derivation found the removers it is about (a floor, and the file that holds the marker)', () => {
    assert.ok(sites.length >= SITE_FLOOR, `only ${sites.length} remover(s) found: the derivation looked in the wrong place — ${JSON.stringify(sites.map(s => s.key))}`);
    assert.ok(sites.some(s => s.file === OWED_CHECK_HOME), `no remover found in ${OWED_CHECK_HOME}, which holds the move's marker block`);
    assert.ok(sites.some(s => s.why === 'unsets the move marker'), 'no function that unsets the move marker was found: the marker\'s remover is the one this gate is for');
  });

  it('every remover asks moveIsOwed, or is exempt with its reason', () => {
    const bad = unguarded(sites);
    assert.deepEqual(bad.map(s => `${s.file}:${s.line} ${s.name} — ${s.why}`), [],
      `${bad.length} remover(s) of a file tombstone or its move marker never ask ${OWED_CHECK}: a move a failure stopped after its bytes is forgotten behind the retry's back, and its records stranded`);
  });

  it('every exemption names a remover that still exists and says why', () => {
    const keys = new Set(sites.map(s => s.key));
    for (const [key, reason] of EXEMPT) {
      assert.ok(declared.has(key), `${key} is exempt but no such function exists any more — remove the entry`);
      assert.ok(keys.has(key), `${key} is exempt but no longer removes a file tombstone or its marker — remove the entry`);
      assert.ok(typeof reason === 'string' && reason.trim().length >= 30, `${key} is exempt with no reason`);
    }
  });
});
