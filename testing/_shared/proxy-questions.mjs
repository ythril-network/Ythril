/**
 * Where the server asks "is this space a proxy?" and "which configured spaces own collections?" — READ OUT
 * OF THE SYNTAX TREE, not grepped.
 *
 * ## Why this exists (`Q-80`, `Q-98`)
 *
 * The proxy question was answered about forty times in two spellings: a truthy `proxyFor` and a non-empty
 * `proxyFor`. They disagree on the one value only a hand-edited config can produce — `proxyFor: []` — so such
 * a space was served as a real one and never embedded, scanned or pruned, and deleting it leaked its
 * collections. And *"for each configured space, skip the proxies"* was written by hand at every loop that
 * wanted it, while `initAllSpaces` — which did not write it — created collections for every proxy at every boot.
 *
 * ## Why a syntax tree and not a regex
 *
 * The first sweep for this work used a regex over `.spaces.filter(` and `for (… of … .spaces)`, and missed
 * three of the loops outright: each assigned the list to a variable first (`const spaces = getConfig().spaces`,
 * `const spaceIds = getConfig().spaces.map(s => s.id)`) and iterated THAT. The same sweep had to filter out
 * `proxyFor` reads that are data rather than tests (`.join(`, `{ proxyFor: … }`), and a line-based filter
 * dropped three ternary tests that happened to share a line with one. Both are questions about what an
 * expression IS, which is what a parser answers and a pattern guesses at.
 *
 * Syntax only — no type checker. A config space list is found by DATA FLOW from `getConfig()`: its `.spaces`,
 * any name bound to it, and any `.filter`/`.map` chain over either. A `Config`-typed parameter counts too.
 *
 * ## Two questions, two gates, one derivation
 *
 * `a-proxy-is-asked-one-way.test.js` reads {@link proxyTests}; `every-concrete-space-loop-uses-one-helper.test.js`
 * reads {@link configSpaceIterations}. They share this module so the two cannot disagree about what a proxy
 * test looks like.
 */
import { readTrackedSources } from '../standalone/_sources.mjs';
import { ts, parseSource, lineOf } from './syntax-tree.mjs';

/**
 * The functions that ARE the answers. Everything else asks them.
 *
 * `normaliseLoadedConfig` is here because it is the one place that must see the value the others never will: it
 * removes an empty member list on load, which is what lets `isProxy` be the only reading of one. It cannot ask
 * `isProxy` — `spaces/proxy.ts` imports the loader.
 */
export const ANSWERS = [
  { file: 'server/src/spaces/proxy.ts', fn: 'isProxy' },
  { file: 'server/src/spaces/proxy.ts', fn: 'concreteSpaces' },
  { file: 'server/src/spaces/proxy.ts', fn: 'isWildcardProxy' },
  { file: 'server/src/config/loader.ts', fn: 'normaliseLoadedConfig' },
];

/** Calls whose body reaches a space's collections directly. */
const COLLECTION_REACHERS = new Set(['col', 'spaceCollection', 'initSpace', 'reconcileSpaceSearchIndexes']);
/** Array methods that walk the list with a callback. */
const WALKERS = new Set(['filter', 'map', 'forEach', 'some', 'every', 'flatMap', 'find', 'findIndex', 'reduce']);

/** Parse every tracked server source once. */
export function serverSources() {
  return readTrackedSources(['server/src'], { floor: 300, specs: false })
    .filter(s => !s.file.endsWith('.test.ts'))
    .map(s => ({ ...s, sf: parseSource(s.file, s.text) }));
}

/** Parse one snippet — for the self-tests that keep this instrument honest. */
export function parseSnippet(text, file = 'snippet.ts') {
  return { file, text, sf: parseSource(file, text) };
}

function enclosingFunctionName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if (ts.isFunctionDeclaration(n) && n.name) return n.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) {
      return n.parent.name.text;
    }
  }
  return null;
}

function isAnswerSite(file, node) {
  const fn = enclosingFunctionName(node);
  return ANSWERS.some(a => a.file === file && a.fn === fn);
}

function unwrap(node) {
  let n = node;
  while (n.parent && (ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent))) n = n.parent;
  return n;
}

/** Is `node` (an expression naming a member list) used as a TEST of whether it holds anything? */
function isTestPosition(node) {
  const n = unwrap(node);
  const p = n.parent;
  if (!p) return false;
  if (ts.isPropertyAccessExpression(p) && p.expression === n) return p.name.text === 'length';
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
  if (ts.isBinaryExpression(p)) {
    const op = p.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken || op === ts.SyntaxKind.BarBarToken) return true;
    if (op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsEqualsToken
      || op === ts.SyntaxKind.EqualsEqualsToken || op === ts.SyntaxKind.ExclamationEqualsToken) return true;
    return false;
  }
  if (ts.isConditionalExpression(p)) return p.condition === n;
  if (ts.isIfStatement(p) || ts.isWhileStatement(p) || ts.isDoStatement(p)) return p.expression === n;
  if (ts.isCallExpression(p) && ts.isIdentifier(p.expression) && p.expression.text === 'Boolean') return true;
  return false;
}

/**
 * Every place a `proxyFor` value is TESTED — for truthiness, emptiness or length — with where it is.
 *
 * Reads of the list as data (`.join(`, `.includes(`, `[0]`, `{ proxyFor: x.proxyFor }`, an assignment) are not
 * tests and are not returned. A bare identifier named `proxyFor` (a destructured record or body) is a test
 * site too: `if (proxyFor && …)` asks the question exactly as `space.proxyFor` does.
 */
export function proxyTests(sources) {
  const out = [];
  for (const { file, sf } of sources) {
    const visit = (node) => {
      let subject = null;
      if (ts.isPropertyAccessExpression(node) && node.name.text === 'proxyFor') subject = node;
      else if (ts.isElementAccessExpression(node) && ts.isStringLiteralLike(node.argumentExpression)
        && node.argumentExpression.text === 'proxyFor') subject = node;
      else if (ts.isIdentifier(node) && node.text === 'proxyFor' && node.parent
        && !(ts.isPropertyAccessExpression(node.parent) && node.parent.name === node)
        && !ts.isPropertySignature(node.parent) && !ts.isPropertyAssignment(node.parent)
        && !ts.isBindingElement(node.parent) && !ts.isParameter(node.parent)
        && !ts.isShorthandPropertyAssignment(node.parent) && !ts.isVariableDeclaration(node.parent)
        && !ts.isPropertyDeclaration(node.parent)) subject = node;
      if (subject && isTestPosition(subject) && !isAnswerSite(file, subject)) {
        out.push({ file, line: lineOf(sf, subject), text: unwrap(subject).parent.getText(sf).slice(0, 120) });
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}

/**
 * Does this proxy test EXCLUDE proxies — a negation (`!isProxy(s)`, `!s.proxyFor`) or a guard whose branch is a
 * `continue`/`return` — rather than SELECT them? Selecting them is a different question: a rename rewriting every
 * proxy's member list walks all spaces and acts on the proxies, and that loop is correct as it stands.
 */
function skipsWhenTrue(node) {
  let n = node;
  // Climb through `.length`, parentheses and the `&&`/`||` a test is part of.
  for (;;) {
    const p = n.parent;
    if (!p) return false;
    if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === 'length') { n = p; continue; }
    if (ts.isParenthesizedExpression(p) || ts.isBinaryExpression(p)) { n = p; continue; }
    if (ts.isIfStatement(p) && p.expression === n) {
      const t = ts.isBlock(p.thenStatement) && p.thenStatement.statements.length === 1 ? p.thenStatement.statements[0] : p.thenStatement;
      return ts.isContinueStatement(t) || ts.isReturnStatement(t);
    }
    return false;
  }
}

function isGetConfigCall(node) {
  return ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === 'getConfig';
}

/** Names in this file bound to `getConfig()` or typed `Config`, and names bound to a config space list. */
function configBindings(sf) {
  const configNames = new Set();
  const listNames = new Set();
  let changed = true;
  const isConfigExpr = (e) => {
    const x = ts.isParenthesizedExpression(e) ? e.expression : e;
    return isGetConfigCall(x) || (ts.isIdentifier(x) && configNames.has(x.text));
  };
  // Pass until stable: a list alias can be bound from another alias.
  while (changed) {
    changed = false;
    const bind = (name, init) => {
      if (!init) return;
      if (isConfigExpr(init) && !configNames.has(name)) { configNames.add(name); changed = true; }
      if (isConfigSpaceList(init, isConfigExpr, listNames) && !listNames.has(name)) { listNames.add(name); changed = true; }
    };
    const visit = (node) => {
      if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name)) bind(node.name.text, node.initializer);
      if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(node.left)) {
        bind(node.left.text, node.right);
      }
      if (ts.isParameter(node) && ts.isIdentifier(node.name) && node.type && node.type.getText(sf) === 'Config'
        && !configNames.has(node.name.text)) { configNames.add(node.name.text); changed = true; }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return { isConfigExpr, listNames };
}

/** Is `e` a list of the configured spaces (or ids of them), by data flow from `getConfig()`? */
function isConfigSpaceList(e, isConfigExpr, listNames) {
  let x = e;
  while (ts.isParenthesizedExpression(x) || ts.isNonNullExpression(x) || ts.isAsExpression(x)) x = x.expression;
  if (ts.isBinaryExpression(x) && x.operatorToken.kind === ts.SyntaxKind.QuestionQuestionToken) return isConfigSpaceList(x.left, isConfigExpr, listNames);
  if (ts.isIdentifier(x)) return listNames.has(x.text);
  if (ts.isPropertyAccessExpression(x) && x.name.text === 'spaces') return isConfigExpr(x.expression);
  if (ts.isCallExpression(x) && ts.isPropertyAccessExpression(x.expression)
    && ['filter', 'map', 'slice'].includes(x.expression.name.text)) {
    return isConfigSpaceList(x.expression.expression, isConfigExpr, listNames);
  }
  return false;
}

/**
 * Every walk over the configured spaces: a `for…of`, an array method with a callback, or any call handed the
 * list together with a function (`mapLimit(spaces, n, fn)`). For each, whether its body skips proxies by hand
 * and whether it reaches a space collection directly.
 */
export function configSpaceIterations(sources) {
  const out = [];
  for (const { file, sf } of sources) {
    const { isConfigExpr, listNames } = configBindings(sf);
    const isList = (e) => isConfigSpaceList(e, isConfigExpr, listNames);
    const report = (node, bodies) => {
      if (isAnswerSite(file, node)) return;
      const inner = { proxySkip: false, reaches: false };
      for (const b of bodies) {
        const walk = (n) => {
          if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
            if ((n.expression.text === 'isProxy' || n.expression.text === 'isProxySpace') && skipsWhenTrue(n)) inner.proxySkip = true;
            if (COLLECTION_REACHERS.has(n.expression.text)) inner.reaches = true;
          }
          if (ts.isPropertyAccessExpression(n) && n.name.text === 'proxyFor' && isTestPosition(n) && skipsWhenTrue(n)) {
            inner.proxySkip = true;
          }
          ts.forEachChild(n, walk);
        };
        walk(b);
      }
      out.push({ file, line: lineOf(sf, node), text: node.getText(sf).split('\n')[0].slice(0, 120), ...inner });
    };
    const visit = (node) => {
      if (ts.isForOfStatement(node) && isList(node.expression)) report(node, [node.statement]);
      else if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression)
        && WALKERS.has(node.expression.name.text) && isList(node.expression.expression)) {
        report(node, node.arguments.filter(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a)));
      } else if (ts.isCallExpression(node) && node.arguments.some(a => isList(a))
        && node.arguments.some(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a))) {
        report(node, node.arguments.filter(a => ts.isArrowFunction(a) || ts.isFunctionExpression(a)));
      }
      ts.forEachChild(node, visit);
    };
    visit(sf);
  }
  return out;
}
