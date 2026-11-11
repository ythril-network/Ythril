/**
 * Which test cases only restate a constant's value - the cases `a-test-can-fail-for-a-real-defect` refuses.
 *
 * ## What it prevents
 *
 * A case whose every assertion compares a named constant with a literal (`assert.equal(CAP, 10)`,
 * `assert.deepEqual(mod.ALLOWED.length, 12)`) can fail only when someone edits the constant, never when the code
 * is wrong: it asserts that the source says what the source says. The constant is already the one place the value
 * lives; the case adds a second copy that must be edited in step, and a reviewer reads a green tick as coverage.
 *
 * ## The failure that bought it (Q-732)
 *
 * Owner, 2026-11-10: "tests that do not really test something should be removed. Like testing a constant for it's
 * value or similar nonsense". At d113c922 this scan finds 61 such sites (`a-push-forks-once-within-the-cap-db`,
 * `code-attempts`, `store-answers`, `a-release-is-dated-the-day-its-tag-is-cut`, and others). The gate keeps new ones
 * out; the cases found are removed by the change that adds it.
 *
 * ## The rule
 *
 * A case is flagged when its OWN code (not a nested function's) holds at least one assertion and EVERY assertion
 * compares a restated constant with a literal, either argument order:
 *
 * - restated constant: an identifier, or a property access whose last name, matches `/^[A-Z][A-Z0-9_]{2,}$/` (`CAP`,
 *   `mod.FORCE_LABEL`), or a member of such an expression (`MODEL_SLOT_DEFAULT_MS.embed`, `mod.KINDS.length`);
 * - literal: a number, a string or no-substitution template, `true`, `false`, `null`, a unary minus of a number,
 *   arithmetic of literals (`10 * 60_000`; a name the same file declares `const NAME = <literal>` counts as a literal
 *   inside arithmetic, so `15 * MIN` is one), or an array or object literal whose elements are all literals;
 * - assertion: `assert.equal`, `strictEqual`, `deepEqual`, `deepStrictEqual` (also `assert.strict.*`), or
 *   `expect(a).toBe(b)`, `.toEqual(b)`, `.toStrictEqual(b)`. Any OTHER assertion call (`assert.ok`, `assert.throws`,
 *   `assert.match`, `expect(x).not.toBe(y)`, an assertion on a call's result) is an assertion that does not restate, so
 *   the case is not flagged: the case checks something else too.
 *
 * A constant compared with a computed value (`assert.equal(CAP, other.length + 1)`, a live server's answer, a value
 * read from a doc) is not a literal, so it is not flagged. Nor is a capitalised name the same file declares as the result
 * of a call (`const WALKERS = SOURCES.filter(...)`): that is a scan's answer, not a restated constant. The syntax tree ignores comments and strings; nothing here
 * is a regular expression over source text.
 */
import { ts, parseSource, lineOf, walkOwnCode, walkEveryNode, unwrapExpression } from '../_shared/syntax-tree.mjs';
import { testBodies, calleeText } from './_test-bodies.mjs';

const CONSTANT_NAME = /^[A-Z][A-Z0-9_]{2,}$/;
const EQUALITY_CALL = /^assert(?:\.strict)?\.(?:equal|strictEqual|deepEqual|deepStrictEqual)$/;
const EXPECT_MATCHER = /^(?:toBe|toEqual|toStrictEqual)$/;
const ARITHMETIC = new Set([
  ts.SyntaxKind.PlusToken, ts.SyntaxKind.MinusToken, ts.SyntaxKind.AsteriskToken,
  ts.SyntaxKind.SlashToken, ts.SyntaxKind.PercentToken, ts.SyntaxKind.AsteriskAsteriskToken,
]);

/** An identifier or property access named like a constant, or a member of one (`.length`, `MODEL_SLOT_DEFAULT_MS.embed`). */
function isRestatedConstant(node, computed) {
  const e = unwrapExpression(node);
  if (ts.isIdentifier(e)) return CONSTANT_NAME.test(e.text) && !computed.has(e.text);
  if (!ts.isPropertyAccessExpression(e)) return false;
  let root = unwrapExpression(e.expression);
  while (ts.isPropertyAccessExpression(root)) root = unwrapExpression(root.expression);
  if (ts.isIdentifier(root) && computed.has(root.text)) return false;
  return CONSTANT_NAME.test(e.name.text) || isRestatedConstant(e.expression, computed);
}

/**
 * The names this file declares `const NAME = <computed>` (a call, a chain of calls, a `new`, a scan's result): a live value
 * named in capitals by habit (`const WALKERS = SOURCES.filter(...)`), which a case that asserts on it is checking, not restating.
 * An alias (`const CAP = mod.CAP`), a literal and an import are not computed.
 */
function computedConstants(sf, units) {
  const computed = new Set();
  walkEveryNode(sf, (n) => {
    if (!ts.isVariableDeclaration(n) || !ts.isIdentifier(n.name) || !n.initializer || !CONSTANT_NAME.test(n.name.text)) return;
    const init = unwrapExpression(n.initializer);
    if (ts.isIdentifier(init) || ts.isPropertyAccessExpression(init) || ts.isElementAccessExpression(init)) return;
    if (isLiteral(init, units)) return;
    computed.add(n.name.text);
  });
  return computed;
}

/** Does `node` say only a value? `units` are the names this file declares as `const NAME = <literal>`; they count inside arithmetic. */
function isLiteral(node, units, inArithmetic = false) {
  const e = unwrapExpression(node);
  if (ts.isNumericLiteral(e) || ts.isStringLiteralLike(e)) return true;
  if (e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword) return true;
  if (ts.isIdentifier(e)) return inArithmetic && units.has(e.text);
  if (ts.isPrefixUnaryExpression(e)) return e.operator === ts.SyntaxKind.MinusToken && ts.isNumericLiteral(unwrapExpression(e.operand));
  if (ts.isBinaryExpression(e)) {
    return ARITHMETIC.has(e.operatorToken.kind) && isLiteral(e.left, units, true) && isLiteral(e.right, units, true);
  }
  if (ts.isArrayLiteralExpression(e)) return e.elements.every(x => isLiteral(x, units));
  if (ts.isObjectLiteralExpression(e)) return e.properties.every(p => ts.isPropertyAssignment(p) && isLiteral(p.initializer, units));
  return false;
}

/** The names `sf` declares `const NAME = <literal>`, in source order so one may be built from an earlier one. */
function literalConstants(sf) {
  const units = new Set();
  walkEveryNode(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (n.parent.flags & ts.NodeFlags.Const) && isLiteral(n.initializer, units)) units.add(n.name.text);
  });
  return units;
}

/** The root of `expect(a).not.toBe` style chains: the `expect(...)` call, or null. */
function expectRoot(callee) {
  let e = callee;
  while (ts.isPropertyAccessExpression(e)) e = e.expression;
  return ts.isCallExpression(e) && ts.isIdentifier(e.expression) && e.expression.text === 'expect' ? e : null;
}

/**
 * What a call is as an assertion: `null` (not one), `'other'` (an assertion that does not restate a constant), or
 * `[a, b]` (an equality assertion and its two compared expressions).
 */
function assertionOf(call) {
  const callee = call.expression;
  const text = calleeText(call);
  if (EQUALITY_CALL.test(text)) return call.arguments.length >= 2 ? [call.arguments[0], call.arguments[1]] : 'other';
  if (ts.isPropertyAccessExpression(callee)) {
    const root = expectRoot(callee);
    if (root) {
      const direct = callee.expression === root && EXPECT_MATCHER.test(callee.name.text);
      return direct && root.arguments.length >= 1 && call.arguments.length >= 1 ? [root.arguments[0], call.arguments[0]] : 'other';
    }
  }
  if (ts.isIdentifier(callee) && callee.text === 'expect') return null; // the inner call of `expect(a).toBe(b)`
  if (/(?:^|\.)assert(?:\.|$)/.test(text)) return 'other';
  return null;
}

const restates = ([a, b], units, computed) => (isRestatedConstant(a, computed) && isLiteral(b, units)) || (isRestatedConstant(b, computed) && isLiteral(a, units));

/** The flagged cases of one file's text. */
export function restatedConstantCasesIn(file, text) {
  const sf = parseSource(file, text);
  const units = literalConstants(sf);
  const computed = computedConstants(sf, units);
  const out = [];
  for (const { name, fn } of testBodies(sf)) {
    let assertions = 0;
    let restating = 0;
    walkOwnCode(fn.body ?? fn, (n) => {
      if (!ts.isCallExpression(n)) return false;
      const a = assertionOf(n);
      if (a === null) return false;
      assertions++;
      if (a !== 'other' && restates(a, units, computed)) restating++;
      return false;
    });
    if (assertions > 0 && restating === assertions) out.push({ file, line: lineOf(sf, fn.parent ?? fn), title: name });
  }
  return out;
}

/**
 * Every case in `files` ([{ file, text }]) that only restates a constant, as `[{ file, line, title }]` in file then
 * source order.
 */
export function restatedConstantCases({ files }) {
  return files.flatMap(({ file, text }) => restatedConstantCasesIn(file, text.replace(/\r\n/g, '\n')));
}
