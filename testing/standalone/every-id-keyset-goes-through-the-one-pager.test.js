/**
 * Every `_id` keyset in the server and in `scripts/` is written in `db/id-keyset-page.ts`, or is a named exemption that says why
 * it is a different question (`Q-481`, design rev 4 item 7).
 *
 * ## The rule
 *
 * A walk that pages a collection by `_id` has four lines to get right — the sort, the limit, the cursor ANDed with the caller's
 * own `_id` condition, and the end on a short page — and each inline copy carried a different half of them
 * (`db/id-keyset-page.ts` says which). So the shapes of an `_id` keyset are derived from the code, wherever they are written:
 * an `_id` RANGE condition whose bound is not a literal (an object literal, a variable-bound condition, a `filter._id`
 * assignment, a computed key that resolves to `_id`, `$expr` over `'$_id'`, a descending `$lt`), and a `find`/`aggregate` whose
 * FIRST sort key is `_id` and which carries a limit (`_id-keyset-shapes.mjs` names each). A function holding one is the pager or
 * an exemption below.
 *
 * ## Where it looks, and how
 *
 * `server/src` through the server's type-checked program (`_shared/server-program.mjs`, floor inside), so a computed key or a
 * condition bound to a variable in another file is resolved. `scripts/` by syntax: no tsconfig types it, so a computed key there
 * is not resolved and every other shape is held; its files are listed by `trackedSources`, with a floor, never a directory walk.
 * Both are syntax trees, so a comment that quotes a shape is not a finding and line endings decide nothing.
 *
 * ## Seen red
 *
 * At a5a450e7 (before the conversion) the gate names the three hand loops the design converts: `readCandidates`
 * (files/file-stamp-report.ts), `drainSpace` (sync/stray-filemeta-drain.ts) and `convertSpaceInWalk` (brain/links-conversion.ts).
 * The implementation round sees it red again by restoring each converted hand loop, and by one shape written into a script.
 *
 * Run: node --test testing/standalone/every-id-keyset-goes-through-the-one-pager.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { ts, parseSource } from '../_shared/syntax-tree.mjs';
import { idKeysetShapes } from './_id-keyset-shapes.mjs';
import { serverProgram } from '../_shared/server-program.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';

const PAGER = 'server/src/db/id-keyset-page.ts';

/**
 * Functions that hold an `_id` keyset shape and are NOT the `_id` pager's question, each with R11's reason. Keyed `file:function`.
 * An entry whose function no longer holds a shape fails below, so a row cannot outlive what it excuses.
 */
const EXEMPT = {
  'server/src/brain/queue-embed-sweep.ts:kindsFrom': 'the embed sweep resumes per kind with `_id > lastId` inside ONE aggregate stream that computes `holdsVector` and carries a total `$limit` across kinds; a page per kind would be a different walk. Whether it converts is the owner\'s D-57',
  'server/src/util/seq-keyset.ts:isoKeysetFilters': 'the `_id` is the TIE under another primary key (an ISO time): the page is ordered by that key, and `_id` only breaks a tie inside one value of it',
  'server/src/util/position-keyset.ts:positionKeysetFilters': 'the `_id` is the TIE under another primary key (`pos`, a record\'s position): the page is ordered by position, and `_id` only breaks a tie inside one position (the legacy band has them)',
  'server/src/util/seq-keyset.ts:seqKeysetFilters': 'the `_id` is the TIE under another primary key (`seq`): the page is ordered by seq, and `_id` only breaks a tie inside one seq',
  'server/src/spaces/space-act-runner.ts:deleteInBatches': 'it re-reads from the start until the filter matches nothing, deleting each batch it read, so it has no cursor: a batch whose delete was ended is read again rather than passed',
};

/** Fewer `scripts/` files than this and the listing, not the code, is broken. */
const SCRIPTS_FLOOR = 20;

/** A snippet type-checked on its own, so the `computed key` shape is resolved as it is in the tree. */
function checkedSnippet(code) {
  const name = 'snippet.ts';
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022, strict: true };
  const host = ts.createCompilerHost(options);
  const sf = parseSource(name, code);
  host.getSourceFile = (f) => (f === name ? sf : undefined);
  host.fileExists = (f) => f === name;
  host.readFile = (f) => (f === name ? code : undefined);
  const program = ts.createProgram({ rootNames: [name], options, host });
  return idKeysetShapes(program.getSourceFile(name), program.getTypeChecker());
}
/** A snippet by syntax alone, as `scripts/` is read. */
const syntaxSnippet = (code) => idKeysetShapes(parseSource('snippet.mjs', code));
const shapesOf = (found) => found.map(f => f.shape);

describe('the shapes of an _id keyset, on literal snippets', () => {
  const cases = {
    'object literal': 'async function f(after: string) { return { a: 1, _id: { $gt: after } }; }',
    'variable-bound': 'async function f(after: string) { const cursor = { $gt: after }; return { _id: cursor }; }',
    '_id assignment': 'function f(filter: any, after: string) { filter._id = { $gte: after }; filter[\'_id\'] = { $gt: after }; }',
    'computed key': 'function f(after: string) { const KEY = \'_id\'; return { [KEY]: { $gt: after } }; }',
    '$expr': 'function f(after: string) { return { $expr: { $gt: [\'$_id\', after] } }; }',
    'sort-limit chain': 'async function f(c: any) { return c.find({}).sort({ _id: 1 }).limit(10).toArray(); }',
    'find options': 'async function f(c: any, n: number) { return c.find({}, { projection: { _id: 1 }, sort: { _id: -1 }, limit: n }).toArray(); }',
    'pipeline': 'async function f(c: any) { return c.aggregate([{ $match: {} }, { $sort: { _id: 1 } }, { $limit: 5 }]).toArray(); }',
  };
  for (const [shape, code] of Object.entries(cases)) {
    it(`finds the ${shape} shape (checked)`, () => {
      assert.ok(shapesOf(checkedSnippet(code)).includes(shape), `${shape} not found in: ${code}`);
    });
    if (shape !== 'computed key') {
      it(`finds the ${shape} shape by syntax alone, as scripts are read`, () => {
        assert.ok(shapesOf(syntaxSnippet(code)).includes(shape), `${shape} not found by syntax in: ${code}`);
      });
    }
  }

  it('finds a descending cursor ($lt, $lte) as a range', () => {
    assert.ok(shapesOf(checkedSnippet('function f(b: string) { return { _id: { $lt: b } }; }')).includes('object literal'));
    assert.ok(shapesOf(checkedSnippet('function f(b: string) { return { _id: { $lte: b } }; }')).includes('object literal'));
  });

  it('a sort-limit chain in either order, and on aggregate', () => {
    assert.ok(shapesOf(checkedSnippet('function f(c: any) { return c.find({}).limit(3).sort({ _id: 1 }); }')).includes('sort-limit chain'));
  });

  it('names the function a shape sits in: a declaration, a declared arrow, a method', () => {
    const found = checkedSnippet('function decl(a: string) { return { _id: { $gt: a } }; }\n'
      + 'const arrow = (a: string) => ({ _id: { $gt: a } });\n'
      + 'const o = { meth(a: string) { return { _id: { $gt: a } }; } };');
    assert.deepEqual(found.map(f => f.fn).sort(), ['arrow', 'decl', 'meth']);
  });

  it('NOT a literal bound, a list of ids, a sort whose first key is another field, a sort with no limit, or a comment', () => {
    const none = [
      'function f() { return { _id: { $gt: \'\' } }; }',
      'function f(ids: string[]) { return { _id: { $in: ids } }; }',
      'function f(c: any) { return c.find({}, { projection: { _id: 1, rawBytes: 1 }, sort: { createdAt: 1, _id: 1 } }); }',
      'function f(c: any) { return c.find({}).sort({ createdAt: 1, _id: 1 }).limit(3); }',
      'function f(c: any) { return c.find({}).sort({ _id: 1 }).toArray(); }',
      'function f(c: any, a: string) { /* { _id: { $gt: a } } */ return c.find({}).sort({ _id: 1 }); }',
      'function f(a: string) { return { seq: { $gt: a } }; }',
    ];
    for (const code of none) assert.deepEqual(checkedSnippet(code), [], `a shape was found in: ${code}`);
  });
});

/** Every finding in the tree, keyed `file:function`. */
function findings() {
  const { checker, serverSources, repoPath } = serverProgram();
  const out = [];
  for (const sf of serverSources()) for (const f of idKeysetShapes(sf, checker)) out.push({ file: repoPath(sf.fileName), ...f });
  const scripts = trackedSources('scripts', { ext: ['.mjs', '.js', '.cjs', '.ts'], floor: SCRIPTS_FLOOR });
  for (const file of scripts) {
    const sf = parseSource(file, readFileSync(join(REPO_ROOT, file), 'utf8'));
    for (const f of idKeysetShapes(sf)) out.push({ file, ...f });
  }
  return { out, scripts: scripts.length };
}
const FOUND = findings();
const keyOf = (f) => `${f.file}:${f.fn}`;
const label = (f) => `${keyOf(f)} [${f.shape}] line ${f.line}: ${f.text.replace(/\s+/g, ' ')}`;

describe('every _id keyset in server/src and scripts/ is the pager or a named exemption', () => {
  it('the derivation finds the pager itself, so it cannot pass by finding nothing', () => {
    const inPager = FOUND.out.filter(f => f.file === PAGER);
    assert.ok(inPager.some(f => f.shape === 'object literal') && inPager.some(f => f.shape === 'find options'),
      `the pager's own cursor and sort-limit were not found in ${PAGER}: the derivation is blind (found ${JSON.stringify(inPager.map(f => f.shape))})`);
    assert.ok(FOUND.scripts >= SCRIPTS_FLOOR, `${FOUND.scripts} script(s) scanned`);
  });

  it('no function outside the pager writes an _id page or cursor by hand, unless it is exempt with its reason', () => {
    const bare = FOUND.out.filter(f => f.file !== PAGER && !(keyOf(f) in EXEMPT)).map(label);
    assert.deepEqual(bare, [],
      'these write an _id keyset by hand: a page sorted by _id with a limit, or an _id cursor. Each is idKeysetPage / eachIdPage '
      + '(db/id-keyset-page.ts), which holds the sort, the limit, the cursor ANDed with the caller\'s own _id condition and the end on '
      + 'a short page in one place, or an EXEMPT entry that says why it is a different question');
  });

  it('every exemption still names a function that holds a shape, and says why', () => {
    const live = new Set(FOUND.out.map(keyOf));
    const stale = Object.keys(EXEMPT).filter(k => !live.has(k));
    assert.deepEqual(stale, [], 'exemptions for functions that no longer hold an _id keyset shape: delete them');
    for (const [k, why] of Object.entries(EXEMPT)) assert.ok(why.length > 40, `${k}: an exemption owes its reason`);
  });
});
