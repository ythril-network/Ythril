/**
 * The test code in this repository, parsed — where its tests are and what a branch of one does.
 *
 * ## Why it is a module
 *
 * Four gates ask a question about how a TEST ends or skips (`a-test-that-finds-its-input-absent-says-so`,
 * `a-skip-that-expects-ci-lives-in-a-listed-file`, `a-test-needing-the-embedder-asks-requireembedding`,
 * `a-private-address-skip-is-one-module`). A regular expression over the text answers them wrongly in both
 * directions: it reads a quoted fixture as code (the gate that polices `expected-in-ci:` would refuse its own
 * fixtures), and it cannot tell a `return` that ends a TEST from one that ends a helper inside it. The syntax
 * tree can, so the parse is written once and every one of them reads through it. How to parse, locate and walk a tree
 * is `_shared/syntax-tree.mjs` (`parseSource`, `lineOf`, `walkOwnCode`) — this module is only what a TEST is.
 *
 * ## The floor is inside
 *
 * An empty listing, or a parse that finds no tests, passes every loop written over it and reports success
 * about nothing. `testSources` and `testBodies` throw on an implausibly small answer rather than returning it.
 */
import { ts } from '../_shared/syntax-tree.mjs';
import { readTrackedSources, TEST_FILE_SUFFIXES } from './_sources.mjs';

/**
 * Where the parsed gates look for test code. What makes a file a TEST file is `_sources.mjs`'s; this is only where
 * these gates read, and the floor is theirs: far more tests live here than the whole-repository floor asks for.
 */
const TEST_FOLDERS = ['testing', 'client/src'];
const BODY_FLOOR = 800;

/** Every tracked test file under {@link TEST_FOLDERS}, read. */
export function testFiles() {
  return readTrackedSources(TEST_FOLDERS, { ext: [...TEST_FILE_SUFFIXES], floor: BODY_FLOOR });
}

/** Every tracked file that can hold test code or the helper a test skips through — tests AND their `.mjs` helpers. */
export function testAndHelperFiles() {
  return readTrackedSources(TEST_FOLDERS, { ext: [...TEST_FILE_SUFFIXES, '.mjs'], floor: BODY_FLOOR });
}

/** The text of a call's callee: `t.skip`, `assert.equal`, `it`. */
export const calleeText = (call) => call.expression.getText();

/** The last name of a call's callee: `skip` for `t.skip(...)`, `requireEmbedding` for `requireEmbedding(...)`. */
export function calleeName(call) {
  const e = call.expression;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  if (ts.isIdentifier(e)) return e.text;
  return e.getText();
}

/**
 * The bodies of the tests a file registers: the callback of `it(...)`, `test(...)`, `it.only(...)` and of
 * `t.test(...)` / `ctx.test(...)` (node:test subtests). `it.skip` is left out on purpose — its callback never runs.
 *
 * @returns {Array<{ name: string, fn: ts.FunctionLikeDeclaration }>}
 */
export function testBodies(sf) {
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n)) {
      const callee = calleeText(n);
      if (/^(it|test)(\.only)?$/.test(callee) || /\.test$/.test(callee)) {
        const fn = [...n.arguments].reverse().find(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a));
        const first = n.arguments[0];
        if (fn) out.push({ name: first && ts.isStringLiteralLike(first) ? first.text : '(unnamed)', fn });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * The text a string-ish node says without its substitutions: a plain literal's text, or a template's literal
 * parts joined. What a gate reads when it asks "does this reason name the cause".
 */
export function staticText(node) {
  if (ts.isStringLiteralLike(node)) return node.text;
  if (ts.isTemplateExpression(node)) return node.head.text + node.templateSpans.map(s => s.literal.text).join('');
  return null;
}

/**
 * A node sits where its value becomes a skip reason or a skip condition: an argument of `skip(...)`, the value of
 * a `skip:` option, a binding or a helper whose name says skip (`const skip = …`, `function corpusSkipReason()`).
 *
 * The climb ends at the first statement that is not a `return`: what a string sits in further up is not what it is
 * FOR. That is what keeps a fixture, a message or a docblock that merely MENTIONS a skip reason from being read as one.
 */
export function inSkipPosition(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isExpressionStatement(p) || ts.isIfStatement(p) || ts.isForOfStatement(p) || ts.isForStatement(p)) return false;
    if (ts.isCallExpression(p) && calleeName(p) === 'skip') return true;
    if (ts.isPropertyAssignment(p) && /^skip/i.test(p.name.getText())) return true;
    if (ts.isShorthandPropertyAssignment(p) && /^skip/i.test(p.name.getText())) return true;
    if (ts.isVariableDeclaration(p) && /skip/i.test(p.name.getText())) return true;
    if (ts.isFunctionDeclaration(p) && /skip/i.test(p.name?.text ?? '')) return true;
  }
  return false;
}
