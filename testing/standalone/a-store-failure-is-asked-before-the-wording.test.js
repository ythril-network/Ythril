/**
 * A catch that reads an error's WORDING asks the store first (bundle-53 G7, `Q-335`).
 *
 * ## What this prevents
 *
 * Three acts decided a refusal from what a lookup threw: `renameSpaceAct`, `applySpaceCreate` and the link route's
 * `addLink` catch each tested `err.message` for "not found" or "already exists" and answered what matched. A driver
 * error whose text holds one of those words — a `MongoServerError` that names a collection that "already exists", a
 * network error quoting a host that was "not found" — was read as the CALLER's refusal (a 409, a 404) while the store was
 * failing. The text is what a failing store says about itself and is in nobody's control, so a wording test is only
 * sound on an error the store has already been asked about: `refusalText` / `throwIfStoreSide` / `storeFailureAnswer` /
 * `classifyReadFailure` / `isStoreUnreachable` first, the wording after.
 *
 * ## The rule, and what counts
 *
 * The subjects are every `catch` clause (and every `.catch(cb)` callback) under `server/src` whose body TESTS the caught
 * error's text: `includes` / `startsWith` / `endsWith` / `indexOf` / `match` / `search` called on the error's message (the
 * message, `String(err)`, a template or concatenation of it, or a variable assigned from any of those), or a
 * `.test(...)` / `.exec(...)` handed one. The FIRST such test must come after a call to one of the five asks above that is
 * handed the caught error, and that call must run on every path: a top-level statement of the catch body, in a condition,
 * or in an initialiser, and never under an `if` branch, a `&&` / `||` / `?:` arm or a nested block. Anything else sits in
 * {@link EXEMPT_BY_FUNCTION} with a `why`.
 *
 * ## What it does NOT cover, so nobody reads it as more
 *
 * - A predicate FUNCTION that reads wording (`isMaxTimeExpired` and its kind): the catch that calls it never writes the
 *   test, so it is not seen. What the predicate decides is that function's own question.
 * - A comparison (`err.message === '…'`, a `switch` over the text) and a test on `err.name` or `err.code`: neither reads
 *   free text. The names of classes are `a-store-failure-is-known-by-its-class`'s.
 * - A wording test in a function the catch hands its error to, and one in a callback nested inside the catch body (a
 *   nested function is another function's code).
 * - A catch whose binding is destructured, or absent.
 *
 * The derivation is read out of the syntax tree, so a catch in a comment or a string is not one, and a rule written as
 * "the three sites" would not survive a fourth. The exemption rows are by FUNCTION and never by line: the lines move.
 *
 * Run: node --test testing/standalone/a-store-failure-is-asked-before-the-wording.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { ts, parseSource, lineOf, walkOwnCode } from '../_shared/syntax-tree.mjs';

/** The calls that put the store's question before a wording test. */
const ASKS = new Set(['refusalText', 'throwIfStoreSide', 'storeFailureAnswer', 'classifyReadFailure', 'isStoreUnreachable']);
/** Methods that read free text: called ON the error's text. */
const TEXT_METHODS = new Set(['includes', 'startsWith', 'endsWith', 'indexOf', 'match', 'matchAll', 'search']);
/** Methods that read free text: handed the error's text as the first argument. */
const PATTERN_METHODS = new Set(['test', 'exec']);
/** Properties of an error that are its words. */
const TEXT_PROPS = new Set(['message', 'errmsg', 'stack']);
/** Methods that return the same words, reshaped. */
const RESHAPE = new Set(['toString', 'toLowerCase', 'toUpperCase', 'trim', 'trimStart', 'trimEnd', 'normalize']);

/**
 * Catches that test wording and legitimately do it first — each reasoned in bundle-53 addendum B: a probe, or a degrade
 * path whose subject is not a request the store is failing. Keyed `file :: function`, never by line.
 *
 * What the plan's list also named — `predicate-recall`, the vector index, `embed-queue`, `ready.ts` — reads wording in
 * PREDICATE FUNCTIONS (`isIndexRequired`-shaped: a function that is handed the error and returns a boolean), not in a
 * catch body, so they are not subjects here and a row for them would excuse nothing (the last test refuses such a row).
 */
export const EXEMPT_BY_FUNCTION = new Map([
  ['server/src/brain/lexical-search.ts :: lexicalSearch', 'a search that degrades: the wording chooses a fallback for a missing text index, and every outcome is an answer in our words'],
  ['server/src/db/mongo.ts :: checkVectorSearchAvailability', 'a capability PROBE: it asks the server whether a stage exists, so the words are the answer, not a refusal'],
  ['server/src/config/loader.ts :: validateOidcBlock', 'the catch re-reads the message of an error THIS function threw two lines above, before any store is involved'],
  ['server/src/local-agent-connector/index.ts :: ensureDnsRoute', 'the error is a cloudflared child process\'s output, which is not the store; the catch rethrows anything it does not recognise'],
  ['server/src/files/converters/describe.ts :: describeDocument', 'a converter degrade path: a timeout of the describing model is reported as "timed out", and nothing here reaches the store'],
]);

/** Walk the whole subtree, nested functions included (an alias is read wherever it is mentioned). */
function everyNode(node, visit) {
  visit(node);
  ts.forEachChild(node, c => everyNode(c, visit));
}

/** Does `expr` mention any name of `names`? */
function mentions(expr, names) {
  let found = false;
  everyNode(expr, n => { if (ts.isIdentifier(n) && names.has(n.text)) found = true; });
  return found;
}

/**
 * Is `expr` the error's words — the error, a variable derived from it, its `message`, `String(err)`, a template or a
 * concatenation holding them, or the same reshaped (`toLowerCase`, `trim`)?
 */
function readsText(expr, names) {
  if (ts.isParenthesizedExpression(expr) || ts.isAsExpression(expr) || ts.isNonNullExpression(expr)) return readsText(expr.expression, names);
  if (ts.isIdentifier(expr)) return names.has(expr.text);
  if (ts.isPropertyAccessExpression(expr)) return TEXT_PROPS.has(expr.name.text) && readsText(expr.expression, names);
  if (ts.isTemplateExpression(expr)) return expr.templateSpans.some(s => readsText(s.expression, names));
  if (ts.isBinaryExpression(expr)) {
    return expr.operatorToken.kind === ts.SyntaxKind.PlusToken && (readsText(expr.left, names) || readsText(expr.right, names));
  }
  if (ts.isConditionalExpression(expr)) return readsText(expr.whenTrue, names) || readsText(expr.whenFalse, names);
  if (ts.isCallExpression(expr)) {
    const callee = expr.expression;
    if (ts.isIdentifier(callee) && callee.text === 'String') return expr.arguments.length > 0 && readsText(expr.arguments[0], names);
    if (ts.isPropertyAccessExpression(callee) && RESHAPE.has(callee.name.text)) return readsText(callee.expression, names);
  }
  return false;
}

/** The variables of `body` derived from the caught error, to a fixpoint (`const lower = msg.toLowerCase()`). */
function derivedNames(body, id) {
  const names = new Set([id]);
  for (let pass = 0; pass < 4; pass++) {
    let grew = false;
    everyNode(body, n => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
        && !names.has(n.name.text) && mentions(n.initializer, names)) { names.add(n.name.text); grew = true; }
    });
    if (!grew) break;
  }
  return names;
}

/** Does the node sit on a path that is NOT always taken, between it and `root`? */
function isConditionalWithin(node, root) {
  for (let child = node, p = node.parent; p && child !== root; child = p, p = p.parent) {
    if (ts.isIfStatement(p) && child !== p.expression) return true;
    if (ts.isConditionalExpression(p) && child !== p.condition) return true;
    if (ts.isBinaryExpression(p) && child === p.right
      && [ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken].includes(p.operatorToken.kind)) return true;
    if (p !== root && (ts.isBlock(p) || ts.isCaseClause(p) || ts.isDefaultClause(p) || ts.isIterationStatement(p, false) || ts.isTryStatement(p) || ts.isCatchClause(p))) return true;
  }
  return false;
}

/** The function a node is in, named the way a reader finds it: its own name, its variable's, or the call it is handed to. */
function enclosingFunction(node, sf) {
  for (let p = node.parent; p; p = p.parent) {
    if (!ts.isFunctionLike(p)) continue;
    if (p.name && ts.isIdentifier(p.name)) return p.name.text;
    const holder = p.parent;
    if (holder && ts.isVariableDeclaration(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
    if (holder && ts.isPropertyAssignment(holder) && ts.isIdentifier(holder.name)) return holder.name.text;
    if (holder && ts.isCallExpression(holder)) {
      const first = holder.arguments.find(a => ts.isStringLiteralLike(a));
      return `${holder.expression.getText(sf)}${first ? ` ${first.text}` : ''}`;
    }
  }
  return '(module)';
}

/**
 * Every catch that tests the caught error's wording, with where its first test is and whether the store was asked
 * on every path before it.
 *
 * @returns {Array<{ file: string, fn: string, line: number, wordingLine: number, asked: boolean }>}
 */
export function wordingCatches(text, file) {
  const sf = parseSource(file, text);
  const out = [];
  const consider = (idNode, body, anchor) => {
    if (!idNode || !ts.isIdentifier(idNode) || !body) return;
    const names = derivedNames(body, idNode.text);
    const tests = [];
    const asks = [];
    walkOwnCode(body, n => {
      if (!ts.isCallExpression(n)) return;
      const callee = n.expression;
      const name = ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : null;
      if (name === null) return;
      if (ts.isPropertyAccessExpression(callee)) {
        if (TEXT_METHODS.has(name) && readsText(callee.expression, names)) tests.push(n);
        else if (PATTERN_METHODS.has(name) && n.arguments.length > 0 && readsText(n.arguments[0], names)) tests.push(n);
      }
      if (ASKS.has(name) && n.arguments.some(a => mentions(a, names))) asks.push(n);
    });
    if (tests.length === 0) return;
    const first = tests.reduce((a, b) => (a.getStart(sf) <= b.getStart(sf) ? a : b));
    const asked = asks.some(a => a.getStart(sf) < first.getStart(sf) && !isConditionalWithin(a, body));
    out.push({ file, fn: enclosingFunction(anchor, sf), line: lineOf(sf, anchor), wordingLine: lineOf(sf, first), asked });
  };
  const visit = (n) => {
    if (ts.isCatchClause(n) && n.variableDeclaration) consider(n.variableDeclaration.name, n.block, n);
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch') {
      const cb = n.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0]) consider(cb.parameters[0].name, cb.body, cb);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

const exemptionFor = (s) => EXEMPT_BY_FUNCTION.get(`${s.file} :: ${s.fn}`) ?? EXEMPT_BY_FUNCTION.get(`${s.file} :: *`);
const where = (s) => `${s.file}:${s.line} in ${s.fn} (first wording test at line ${s.wordingLine})`;

const src = (...lines) => lines.join('\n');
const found = (text) => wordingCatches(text, 'server/src/snippet.ts');

describe('the detector finds a wording test in every spelling it is written in', () => {
  const MUST_BE_FOUND_UNASKED = {
    'an alias of the message, tested with includes': src(
      'async function a() { try { await x(); } catch (err) {',
      '  const msg = err instanceof Error ? err.message : String(err);',
      '  if (msg.includes("already exists")) return 409;',
      '  throwIfStoreSide(err);',
      '} }'),
    'err.message tested directly': src(
      'async function a() { try { await x(); } catch (err) { if (err.message.startsWith("nope")) return 1; } }'),
    'a regex tested against the message': src(
      'async function a() { try { await x(); } catch (e) { const m = String(e); if (/not found$/.test(m)) return 404; throw e; } }'),
    'a reshaped message': src(
      'async function a() { try { await x(); } catch (e) { if (e.message.toLowerCase().endsWith("gone")) return 1; } }'),
    'match on a template of the error': src(
      'async function a() { try { await x(); } catch (e) { const m = `failed: ${e}`; if (m.match(/gone/)) return 1; } }'),
    'a .catch callback': src(
      'function a() { return x().catch(e => { if (e.message.includes("nope")) return 1; }); }'),
    'an ask that runs only on one branch does not count': src(
      'async function a() { try { await x(); } catch (e) { if (flag) throwIfStoreSide(e); if (e.message.includes("nope")) return 1; } }'),
    'an ask AFTER the wording does not count': src(
      'async function a() { try { await x(); } catch (e) { if (e.message.includes("nope")) return 1; throwIfStoreSide(e); } }'),
    'an ask handed a different error does not count': src(
      'async function a() { try { await x(); } catch (e) { throwIfStoreSide(other); if (e.message.includes("nope")) return 1; } }'),
  };
  for (const [name, text] of Object.entries(MUST_BE_FOUND_UNASKED)) {
    it(`finds: ${name}`, () => {
      const r = found(text);
      assert.equal(r.length, 1, 'the catch is a subject');
      assert.equal(r[0].asked, false, 'and it is not asked first');
    });
  }

  const MUST_BE_ASKED = {
    'refusalText before the wording': src(
      'async function a() { try { await x(); } catch (e) { const m = refusalText(e); if (m.includes("nope")) return 1; } }'),
    'throwIfStoreSide as its own statement': src(
      'async function a() { try { await x(); } catch (e) { throwIfStoreSide(e); if (e.message.includes("nope")) return 1; } }'),
    'isStoreUnreachable in a condition that rethrows': src(
      'async function a() { try { await x(); } catch (e) { if (isStoreUnreachable(e)) throw e; if (e.message.includes("nope")) return 1; } }'),
    'storeFailureAnswer before the wording': src(
      'async function a() { try { await x(); } catch (e) { const f = storeFailureAnswer(e, "op"); if (f) return f; if (String(e).includes("nope")) return 1; } }'),
  };
  for (const [name, text] of Object.entries(MUST_BE_ASKED)) {
    it(`accepts: ${name}`, () => {
      const r = found(text);
      assert.equal(r.length, 1);
      assert.equal(r[0].asked, true);
    });
  }

  const MUST_NOT_BE_A_SUBJECT = {
    'a catch that tests a code, not words': src(
      'async function a() { try { await x(); } catch (e) { if (e.code === 11000) return 1; if (String(e.code).startsWith("E")) return 2; } }'),
    'a catch that tests some other string': src(
      'async function a() { try { await x(); } catch (e) { if (name.includes("nope")) return 1; throw e; } }'),
    'wording read inside a nested callback': src(
      'async function a() { try { await x(); } catch (e) { list.forEach(() => e.message.includes("nope")); } }'),
    'a catch with no binding': src('async function a() { try { await x(); } catch { if (name.includes("nope")) return 1; } }'),
    'a wording test in a comment or a string': src(
      'async function a() { try { await x(); } catch (e) { const s = "e.message.includes(1)"; /* e.message.includes(2) */ throw e; } }'),
  };
  for (const [name, text] of Object.entries(MUST_NOT_BE_A_SUBJECT)) {
    it(`ignores: ${name}`, () => assert.deepEqual(found(text), []));
  }
});

describe('every catch that reads an error\'s wording asks the store first', () => {
  const sources = readTrackedSources('server/src', { ext: ['.ts'], floor: 200 });
  const all = sources.flatMap(s => wordingCatches(s.text, s.file));

  it('the scan sees the catches it is about (floor)', () => {
    assert.ok(sources.length >= 200, `${sources.length} source files scanned`);
    assert.ok(all.length >= 5, `only ${all.length} catch(es) test wording — the derivation is broken, not the code`);
    // The satisfied shape must be seen too, or a detector that finds nothing asked passes every loop below.
    assert.ok(all.filter(s => s.asked).length >= 3, 'no catch is seen asking first: the detector cannot tell the two shapes apart');
  });

  it('no unexempted catch tests wording before the store is asked', () => {
    const bad = all.filter(s => !s.asked && !exemptionFor(s));
    assert.deepEqual(bad.map(where), [],
      'a catch reads an error\'s text before the store was asked. `refusalText(err)` (or `throwIfStoreSide`) first, on every path; a probe '
      + 'or a degrade path goes in EXEMPT_BY_FUNCTION with its reason');
  });

  it('every exemption still excuses a catch that needs it', () => {
    const needed = new Set(all.filter(s => !s.asked).map(s => exemptionFor(s)).filter(Boolean));
    for (const [row, why] of EXEMPT_BY_FUNCTION) {
      assert.ok(why.split(/\s+/).length >= 6, `${row}: a reason that says something`);
      assert.ok(needed.has(why), `${row} excuses nothing now: delete the row`);
    }
  });
});
