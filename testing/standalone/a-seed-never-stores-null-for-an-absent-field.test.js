/**
 * RULE: a seed document that means "no such field" is never stored as `null`. A property whose value is `undefined` that reaches a
 * MongoDB write (insertOne, insertMany, replaceOne, updateOne, updateMany, bulkWrite) goes through `bare()` (`_bare.mjs`) first.
 *
 * ## The failure that bought it (Q-792, part 9)
 *
 * `row('docs/a.pdf#chunk0', { description: undefined })` meant "a chunk row with no description key". The driver stores a key whose value is
 * `undefined` as `null`, so the seeded row HAD a description (null) and the test exercised the null case while its name said absent. The
 * derived-field test kept an inline strip inside `row()` for exactly that reason; nothing made the next seed helper do the same.
 *
 * ## What it reads
 *
 * Every tracked `*-db.test.(js|mjs)` and every `_*.mjs` helper under `testing/standalone/`, as a syntax tree (comments are not nodes, so a
 * comment that shows the bad shape is never a hit). A hit is an object literal holding a property whose value is `undefined` (or `void 0`, or
 * a conditional with an `undefined` branch) that FLOWS to a write: as an argument of the write call itself, of a same-file function that
 * writes (`seed(row(...))`), through a variable it is assigned to, or through a same-file function that returns it. A flow that passes through
 * `bare()` (imported from `_bare.mjs`) or a same-file function that only returns `bare(...)` is clean. `_fork-kinds.mjs` strips REQUEST
 * arguments, a different question, and is not a seed.
 *
 * ## Proof it can fail
 *
 * The control plants the real derived-field test with `bare(` taken out of it (its original `row()`), and the lint must flag it. The truth
 * table below drives each route a value takes to a write, and the routes that are clean.
 *
 * Run: node --test testing/standalone/a-seed-never-stores-null-for-an-absent-field.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { parseSource, lineOf, ts, unwrapExpression, walkEveryNode, walkOwnCode } from '../_shared/syntax-tree.mjs';
import { calleeNameOf } from './_expression-names.mjs';

const WRITE_VERBS = new Set(['insertOne', 'insertMany', 'replaceOne', 'updateOne', 'updateMany', 'bulkWrite']);
const DERIVED_TEST = 'testing/standalone/a-derived-field-writers-store-exactly-what-they-store-db.test.js';

/** Measured on the tree this was written against (801 files, 1521 write sites, 179 undefined-valued literals), kept a little under: a scan that reads fewer is broken. */
const FLOOR_FILES = 700;
const FLOOR_WRITE_SITES = 1300;
const FLOOR_UNDEFINED_LITERALS = 150;

const isUndefinedValue = (e) => {
  const x = unwrapExpression(e);
  if (!x) return false;
  if (ts.isIdentifier(x)) return x.text === 'undefined';
  if (ts.isVoidExpression(x)) return true;
  return ts.isConditionalExpression(x) && (isUndefinedValue(x.whenTrue) || isUndefinedValue(x.whenFalse));
};

/** The name a function is known by in its file: its declaration, the variable or property it is assigned to. */
function functionName(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && (ts.isVariableDeclaration(p) || ts.isPropertyAssignment(p)) && ts.isIdentifier(p.name)) return p.name.text;
  return undefined;
}

/** The expressions a function hands back: an arrow's expression body, or every `return` of its own body. */
function resultsOf(fn) {
  if (fn.body && !ts.isBlock(fn.body)) return [fn.body];
  const out = [];
  if (fn.body) walkOwnCode(fn.body, (n) => { if (ts.isReturnStatement(n) && n.expression) out.push(n.expression); });
  return out;
}

/**
 * What the lint finds in one file: `{ hits: [{ line, text }], writeSites, undefinedLiterals }`.
 * A hit is an `undefined`-valued property in an object literal that flows to a write without `bare()`.
 */
export function readSeeds(file, text) {
  const sf = parseSource(file, text);
  const fns = [];
  const calls = [];
  const idents = [];
  const literals = [];
  const barelocal = new Set();
  let writeSites = 0;
  walkEveryNode(sf, (n) => {
    if (ts.isFunctionLike(n) && !ts.isSourceFile(n) && n.body) fns.push(n);
    if (ts.isCallExpression(n)) {
      calls.push(n);
      const name = calleeNameOf(n);
      if (name && WRITE_VERBS.has(name) && ts.isPropertyAccessExpression(unwrapExpression(n.expression))) writeSites++;
    }
    if (ts.isIdentifier(n)) idents.push(n);
    if (ts.isObjectLiteralExpression(n) && n.properties.some(p => ts.isPropertyAssignment(p) && isUndefinedValue(p.initializer))) literals.push(n);
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && /(^|\/)_bare\.mjs$/.test(n.moduleSpecifier.text)) {
      for (const el of n.importClause?.namedBindings?.elements ?? []) if ((el.propertyName ?? el.name).text === 'bare') barelocal.add(el.name.text);
    }
  });

  /** A same-file function that only hands back a sanitised value is itself a sanitiser (`row = (id, over) => bare({ ... })`). */
  const sanitisers = new Set(barelocal);
  for (let changed = true; changed;) {
    changed = false;
    for (const fn of fns) {
      const name = functionName(fn);
      if (!name || sanitisers.has(name)) continue;
      const results = resultsOf(fn);
      if (results.length && results.every(r => { const c = unwrapExpression(r); return ts.isCallExpression(c) && sanitisers.has(calleeNameOf(c)); })) {
        sanitisers.add(name);
        changed = true;
      }
    }
  }

  const isDirectWrite = (c) => WRITE_VERBS.has(calleeNameOf(c)) && ts.isPropertyAccessExpression(unwrapExpression(c.expression));
  const fnsByName = new Map();
  for (const fn of fns) { const name = functionName(fn); if (name) fnsByName.set(name, [...(fnsByName.get(name) ?? []), fn]); }

  const refsOf = (name, within) => idents.filter(i => i.text === name && (!within || (i.pos >= within.pos && i.end <= within.end))
    && !(ts.isPropertyAccessExpression(i.parent) && i.parent.name === i)
    && !(ts.isPropertyAssignment(i.parent) && i.parent.name === i) && !(ts.isVariableDeclaration(i.parent) && i.parent.name === i)
    && !(ts.isParameter(i.parent) && i.parent.name === i) && !(ts.isBindingElement(i.parent) && i.parent.name === i)
    && !((ts.isPropertyAccessExpression(i.parent) || ts.isElementAccessExpression(i.parent)) && i.parent.expression === i));

  /**
   * Does what the caller passes as argument `idx` of `fn` reach a write inside it? A destructured parameter takes the values apart (the
   * document it writes is built key by key, so an `undefined` option is no key); an identifier parameter, or a rest element, keeps the object.
   */
  function paramFlows(fn, idx, seen, hops) {
    const param = fn.parameters[idx];
    if (!param) return false;
    const names = [];
    if (ts.isIdentifier(param.name)) names.push(param.name.text);
    else if (ts.isObjectBindingPattern(param.name)) {
      for (const el of param.name.elements) if (el.dotDotDotToken && ts.isIdentifier(el.name)) names.push(el.name.text);
    }
    return names.some(n => refsOf(n, fn).some(r => flows(r, seen, hops)));
  }

  /** Does the value `node` evaluates to reach a write call, without passing through a sanitiser? */
  function flows(node, seen = new Set(), hops = 0) {
    if (seen.has(node)) return false;
    seen.add(node);
    for (let cur = node; ;) {
      const p = cur.parent;
      if (!p || ts.isSourceFile(p)) return false;
      if (ts.isCallExpression(p) || ts.isNewExpression(p)) {
        if (p.expression === cur) return false;
        const name = calleeNameOf(p);
        const idx = p.arguments.indexOf(cur);
        if (name && idx >= 0) {
          if (sanitisers.has(name)) return false;
          if (ts.isCallExpression(p) && isDirectWrite(p)) return true;
          const defs = fnsByName.get(name);
          if (defs?.length) return defs.some(fn => paramFlows(fn, idx, seen, hops));
        }
      } else if (ts.isVariableDeclaration(p) && p.initializer === cur && ts.isIdentifier(p.name)) {
        return refsOf(p.name.text).some(r => flows(r, seen, hops));
      } else if (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === cur && ts.isIdentifier(p.left)) {
        return refsOf(p.left.text).some(r => flows(r, seen, hops));
      } else if (ts.isReturnStatement(p) || (ts.isArrowFunction(p) && p.body === cur)) {
        let fn = p;
        while (fn && !ts.isFunctionLike(fn)) fn = fn.parent;
        const name = fn && functionName(fn);
        if (!name || sanitisers.has(name) || hops >= 2) return false;
        return calls.some(c => calleeNameOf(c) === name && flows(c, seen, hops + 1));
      } else if (ts.isExpressionStatement(p) || ts.isBlock(p)) {
        return false;
      }
      cur = p;
    }
  }

  const hits = literals.filter(l => flows(l)).map(l => ({ line: lineOf(sf, l), text: l.getText(sf).slice(0, 100).replace(/\s+/g, ' ') }));
  return { hits, writeSites, undefinedLiterals: literals.length };
}

const inScope = (file) => /^testing\/standalone\/[^/]+-db\.test\.(js|mjs)$/.test(file) || /^testing\/standalone\/_[^/]+\.mjs$/.test(file);

let scanned;
/** The files in scope, read once for the whole file: the tree case and the control both want them. */
const scan = () => (scanned ??= readTrackedSources('testing/standalone', { ext: ['.js', '.mjs'], floor: 1000 }).filter(s => inScope(s.file)));

describe('a seed never stores null for a field it means to leave absent', () => {
  it('no -db test or seeding helper lets an undefined-valued property reach a Mongo write without bare()', (t) => {
    const sources = scan();
    assert.ok(sources.length >= FLOOR_FILES, `only ${sources.length} files read; the listing is broken`);
    let writeSites = 0;
    let literals = 0;
    const found = [];
    for (const { file, text } of sources) {
      const r = readSeeds(file, text);
      writeSites += r.writeSites;
      literals += r.undefinedLiterals;
      for (const h of r.hits) found.push(`${file}:${h.line}  ${h.text}`);
    }
    t.diagnostic(`read ${sources.length} files, ${writeSites} write sites, ${literals} undefined-valued literals`);
    assert.ok(writeSites >= FLOOR_WRITE_SITES, `only ${writeSites} write sites read; the reader is broken`);
    assert.ok(literals >= FLOOR_UNDEFINED_LITERALS, `only ${literals} undefined-valued literals read; the reader is broken`);
    assert.deepEqual(found, [], `a seed that means "no such field" is stored as null; wrap it in bare() from _bare.mjs:\n${found.join('\n')}`);
  });

  it('control: the derived-field test with bare() taken out of its row() is flagged, and the test as committed is not', () => {
    const real = scan().find(s => s.file === DERIVED_TEST);
    assert.ok(real, `${DERIVED_TEST} is not among the files read`);
    assert.ok(/\bbare\(/.test(real.text), 'the derived-field test no longer routes its row() through bare()');
    const planted = real.text.replace(/\bbare\(/g, '(');
    assert.ok(!/\bbare\(/.test(planted), 'the plant did not remove bare()');
    assert.ok(readSeeds('planted-derived.mjs', planted).hits.length > 0, 'the planted copy (row() without its strip) was not flagged');
    assert.deepEqual(readSeeds(real.file, real.text).hits, []);
  });

  describe('every route a value takes to a write (truth table)', () => {
    const IMPORT = "import { bare } from './_bare.mjs';\n";
    const flagged = (src) => readSeeds('table.mjs', src).hits.length;
    const cases = [
      ['directly in insertOne', 'await col.insertOne({ a: undefined });', 1],
      ['inside insertMany\'s array', 'await col.insertMany([{ a: 1 }, { a: undefined }]);', 1],
      ['as a replacement document', 'await col.replaceOne({ _id: 1 }, { a: undefined });', 1],
      ['inside $set of updateOne', 'await col.updateOne({ _id: 1 }, { $set: { a: undefined } });', 1],
      ['inside updateMany', 'await col.updateMany({}, { $set: { a: undefined } });', 1],
      ['inside a bulkWrite operation', 'await col.bulkWrite([{ insertOne: { document: { a: undefined } } }]);', 1],
      ['a void 0 value', 'await col.insertOne({ a: void 0 });', 1],
      ['a conditional with an undefined branch', 'await col.insertOne({ a: x ? 1 : undefined });', 1],
      ['through a variable', 'const d = { a: undefined }; await col.insertOne(d);', 1],
      ['through a spread', 'await col.insertOne({ ...{ a: undefined }, b: 1 });', 1],
      ['through a same-file writer', 'const seed = async (d) => { await col.insertOne(d); };\nawait seed({ a: undefined });', 1],
      ['through a nested call into a same-file writer', 'const seed = async (d) => { await col.insertOne(d); };\nconst row = (o) => ({ id: 1, ...o });\nawait seed(row({ a: undefined }));', 1],
      ['through a function that returns it', 'const mk = () => ({ a: undefined });\nawait col.insertOne(mk());', 1],
      ['wrapped in bare()', IMPORT + 'await col.insertOne(bare({ a: undefined }));', 0],
      ['through a same-file function that returns bare()', IMPORT + 'const row = (o) => bare({ id: 1, ...o });\nawait col.insertOne(row({ a: undefined }));', 0],
      ['into a writer that applies bare() itself', IMPORT + 'const seed = async (d) => { await col.insertOne(bare(d)); };\nawait seed({ a: undefined });', 0],
      ['a local function named bare, not the one from _bare.mjs', 'const bare = (d) => d;\nawait col.insertOne(bare({ a: undefined }));', 1],
      ['an assertion, which writes nothing', 'assert.deepEqual(await col.findOne({}), { a: undefined });', 0],
      ['a query filter on a read', 'await col.findOne({ a: undefined });', 0],
      ['a literal that is never written', 'const d = { a: undefined }; use(d);', 0],
      ['the shape named only in a comment', '// await col.insertOne({ a: undefined });\n/* col.insertMany([{ a: undefined }]) */\nawait col.insertOne({ a: 1 });', 0],
    ];
    for (const [name, src, want] of cases) {
      it(`${want ? 'flags' : 'passes'}: ${name}`, () => {
        assert.equal(flagged(src), want, src);
      });
    }
  });

  it('bare() keeps a stored document free of the key, nested ones included, and leaves every other value as it was', async () => {
    const { bare } = await import('./_bare.mjs');
    const when = new Date('2026-01-01T00:00:00.000Z');
    const doc = { a: 1, b: undefined, c: null, d: [1, undefined, { e: undefined, f: 2 }], g: { h: undefined, i: when }, j: 0, k: '' };
    const out = bare(doc);
    assert.deepEqual(Object.keys(out), ['a', 'c', 'd', 'g', 'j', 'k']);
    assert.equal(out.c, null, 'null is a value and stays');
    assert.deepEqual(out.d, [1, undefined, { f: 2 }], 'an array keeps its positions; only objects lose keys');
    assert.deepEqual(Object.keys(out.g), ['i']);
    assert.ok(out.g.i instanceof Date && out.g.i.getTime() === when.getTime(), 'a Date is not rebuilt as a plain object');
    assert.ok('b' in doc, 'the input was changed');
  });
});
