/**
 * `testing/_shared/syntax-tree.mjs` — how a gate parses, locates and walks source — answers the same way for every gate.
 *
 * ## What this pins
 *
 * Three gate modules each wrote these three questions and the copies had parted: the script kind chosen by two different
 * extension patterns, a walk that skipped its root against one that visited it, two lists of what a function is. The
 * rows below are the answers every caller now shares:
 *
 * - a `.ts`, `.tsx`, `.mts` or `.cts` file is TypeScript (a type annotation is not a syntax error) and anything else is
 *   JavaScript;
 * - a line is 1-based and counts from the node's own start, not from the comment above it;
 * - a walk visits the root, never enters a nested function, and stops when a visit says `true`.
 *
 * Run: node --test testing/standalone/syntax-tree-reads-source-alike.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ts, parseSource, lineOf, walkOwnCode } from '../_shared/syntax-tree.mjs';

describe('parseSource reads the file as its name says', () => {
  // The parser reads `<T>x` as a type assertion in TypeScript and as markup in JavaScript, which is how the two differ here.
  const kindOf = (file) => parseSource(file, 'const y = <string>x;');
  for (const file of ['a.ts', 'a.tsx', 'a.mts', 'a.cts', 'dir/a.d.ts']) {
    it(`${file} is TypeScript`, () => {
      const sf = kindOf(file);
      assert.equal(sf.languageVariant, ts.LanguageVariant.Standard);
      assert.equal(sf.parseDiagnostics.length, 0, 'a type assertion is not an error in TypeScript');
    });
  }
  for (const file of ['a.js', 'a.mjs', 'a.cjs', 'snippet']) {
    it(`${file} is JavaScript`, () => assert.equal(kindOf(file).languageVariant, ts.LanguageVariant.JSX));
  }
});

describe('lineOf is 1-based and starts at the node, not at the comment above it', () => {
  it('counts from the first line', () => {
    const sf = parseSource('a.js', '// a comment\n\nconst x = 1;\nconst y = 2;\n');
    const [first, second] = sf.statements;
    assert.equal(lineOf(sf, first), 3);
    assert.equal(lineOf(sf, second), 4);
    assert.equal(lineOf(parseSource('a.js', 'foo();'), parseSource('a.js', 'foo();').statements[0]), 1);
  });
});

describe('walkOwnCode', () => {
  const body = parseSource('a.js', 'function outer() {\n  return 1;\n  const inner = () => { return 2; };\n  function nested() { return 3; }\n  class K { m() { return 4; } }\n  return 5;\n}').statements[0].body;
  const returns = (node) => {
    const seen = [];
    walkOwnCode(node, (n) => { if (ts.isReturnStatement(n)) seen.push(n.expression.getText()); });
    return seen;
  };

  it('never enters a nested function, arrow, or method: their returns are not the body\'s', () => {
    assert.deepEqual(returns(body), ['1', '5']);
  });

  it('visits the root itself', () => {
    const seen = [];
    walkOwnCode(body, (n) => { seen.push(ts.SyntaxKind[n.kind]); });
    assert.equal(seen[0], 'Block');
  });

  it('stops at the first visit that answers true, and says it found one', () => {
    let visits = 0;
    const found = walkOwnCode(body, (n) => { visits++; return ts.isReturnStatement(n) ? true : undefined; });
    assert.equal(found, true);
    const all = (() => { let c = 0; walkOwnCode(body, () => { c++; }); return c; })();
    assert.ok(visits < all, 'the walk went on after a visit said found');
  });

  it('answers false when nothing was found', () => {
    assert.equal(walkOwnCode(body, () => undefined), false);
  });
});
