/**
 * Where a source pages by `_id` by hand: the shapes of an `_id` keyset, found on a TypeScript syntax tree (`Q-481`, design rev 4
 * item 7). The question it answers is "which functions write an `_id` page or an `_id` cursor themselves", for the gate that holds
 * every such function to `db/id-keyset-page.ts` or a reasoned exemption.
 *
 * ## The shapes
 *
 * An `_id` RANGE condition whose bound is not a literal (a cursor, not a constant), in any of the spellings it has taken:
 *
 *  - `object literal`   — `{ _id: { $gt: after } }`, any of `$gt`, `$gte`, `$lt` (a descending cursor), `$lte`;
 *  - `variable-bound`   — `{ _id: cursor }` where `cursor` is declared `= { $gt: after }`;
 *  - `_id assignment`   — `filter._id = { $gt: after }`, or `filter['_id'] = …`;
 *  - `computed key`     — `{ [KEY]: { $gt: after } }` where `KEY` is typed as the literal `'_id'` (needs the checker);
 *  - `$expr`            — `{ $expr: { $gt: ['$_id', after] } }`;
 *
 * and a read whose FIRST sort key is `_id` and which carries a limit:
 *
 *  - `sort-limit chain` — `.find(…).sort({ _id: 1 }).limit(n)`, in either order;
 *  - `find options`     — `{ sort: { _id: 1 }, limit: n }` in one object;
 *  - `pipeline`         — an aggregate array holding `{ $sort: { _id: … } }` and a `$limit` stage.
 *
 * A sort whose first key is another field (`{ createdAt: 1, _id: 1 }`) is a tie-break under another order, not an `_id` page;
 * a range with a literal bound (`{ _id: { $gt: '' } }`) is a constant, not a cursor; `$in` is a list of ids, not a range.
 *
 * ## What it prevents
 *
 * Matching these by text: a comment that quotes the shape, a CRLF checkout against an LF CI, and a window counted in characters
 * all decide a text match. The tree has no comments and no line endings. The `computed key` shape needs the checker; a source
 * parsed without one (the `scripts/` tree, which no tsconfig types) is held to every other shape.
 */
import ts from 'typescript';

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte']);

/** The literal text a property name stands for, or undefined when it is computed and not resolvable. */
function nameText(name, checker) {
  if (!name) return undefined;
  if (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) {
    const e = name.expression;
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return e.text;
    if (checker) {
      const t = checker.getTypeAtLocation(e);
      if (t.isStringLiteral()) return { computed: t.value };
    }
  }
  return undefined;
}
const plainName = (name, checker) => { const n = nameText(name, checker); return typeof n === 'object' ? n.computed : n; };

/** A constant: a string, number, boolean, null or a template with no substitution. A cursor is anything else. */
function isLiteral(e) {
  while (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || (ts.isTypeAssertionExpression?.(e))) e = e.expression;
  return ts.isStringLiteral(e) || ts.isNumericLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)
    || e.kind === ts.SyntaxKind.TrueKeyword || e.kind === ts.SyntaxKind.FalseKeyword || e.kind === ts.SyntaxKind.NullKeyword
    || (ts.isPrefixUnaryExpression(e) && ts.isNumericLiteral(e.operand));
}

const unwrap = (e) => {
  while (e && (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e) || ts.isSatisfiesExpression?.(e))) e = e.expression;
  return e;
};

/** An object literal that holds a range operator with a non-literal bound. */
function isRangeOnCursor(e, checker) {
  e = unwrap(e);
  if (!e || !ts.isObjectLiteralExpression(e)) return false;
  return e.properties.some(p => ts.isPropertyAssignment(p) && RANGE_OPS.has(plainName(p.name, checker)) && !isLiteral(p.initializer));
}

/** The initializer an identifier was declared with, in this file (syntax) or anywhere (checker). */
function initializerOf(id, checker) {
  if (checker) {
    const sym = checker.getSymbolAtLocation(id);
    const decl = sym?.valueDeclaration ?? sym?.declarations?.[0];
    if (decl && ts.isVariableDeclaration(decl)) return decl.initializer;
    return undefined;
  }
  let found;
  const visit = (n) => {
    if (found) return;
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.name.text === id.text && n.pos < id.pos) found = n.initializer;
    ts.forEachChild(n, visit);
  };
  visit(id.getSourceFile());
  return found;
}

/** The name of the function a node sits in, as the gate keys it: the nearest named function, method or declared arrow. */
export function enclosingName(node) {
  for (let n = node.parent; n; n = n.parent) {
    if ((ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n) || ts.isFunctionExpression(n)) && n.name) return n.name.getText();
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isVariableDeclaration(n.parent) && ts.isIdentifier(n.parent.name)) return n.parent.name.text;
    if ((ts.isArrowFunction(n) || ts.isFunctionExpression(n)) && n.parent && ts.isPropertyAssignment(n.parent)) return plainName(n.parent.name) ?? '?';
  }
  return '<module>';
}

/** The method names of a call chain the node sits in: `.find(…).sort(…).limit(…)` gives find, sort, limit. */
function chainOf(node) {
  let top = node;
  while (top.parent && ((ts.isPropertyAccessExpression(top.parent) && top.parent.expression === top)
    || (ts.isCallExpression(top.parent) && top.parent.expression === top)
    || ts.isNonNullExpression(top.parent) || ts.isParenthesizedExpression(top.parent) || ts.isAsExpression(top.parent))) top = top.parent;
  const names = [];
  let e = top;
  for (;;) {
    e = unwrap(e);
    if (ts.isCallExpression(e)) { e = e.expression; continue; }
    if (ts.isPropertyAccessExpression(e)) { names.push(e.name.text); e = e.expression; continue; }
    break;
  }
  return names;
}

/** The first property name of an object literal, or undefined. */
const firstKey = (obj, checker) => {
  obj = unwrap(obj);
  if (!obj || !ts.isObjectLiteralExpression(obj)) return undefined;
  const p = obj.properties[0];
  return p && ts.isPropertyAssignment(p) ? plainName(p.name, checker) : undefined;
};

/**
 * Every `_id` keyset shape in `sf`, each `{ fn, shape, line, text }`. `checker` (optional) resolves computed keys and identifiers
 * across files; without it a computed key is not resolved and an identifier is looked up in the same file.
 */
export function idKeysetShapes(sf, checker) {
  const out = [];
  const add = (node, shape) => out.push({
    fn: enclosingName(node), shape, line: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1, text: node.getText(sf).slice(0, 160),
  });
  const visit = (n) => {
    // { _id: { $gt: x } }, { _id: cursor }, { [KEY]: { $gt: x } }
    if (ts.isPropertyAssignment(n)) {
      const nt = nameText(n.name, checker);
      const isId = nt === '_id' || (typeof nt === 'object' && nt.computed === '_id');
      if (isId) {
        const init = unwrap(n.initializer);
        if (isRangeOnCursor(init, checker)) add(n, typeof nt === 'object' ? 'computed key' : 'object literal');
        else if (init && ts.isIdentifier(init) && isRangeOnCursor(initializerOf(init, checker), checker)) add(n, 'variable-bound');
      }
      // { $gt: ['$_id', x] }
      if (RANGE_OPS.has(plainName(n.name, checker))) {
        const arr = unwrap(n.initializer);
        if (arr && ts.isArrayLiteralExpression(arr) && arr.elements.length === 2) {
          const [a, b] = arr.elements;
          const ref = (x) => (ts.isStringLiteral(x) || ts.isNoSubstitutionTemplateLiteral(x)) && x.text === '$_id';
          if ((ref(a) && !isLiteral(b)) || (ref(b) && !isLiteral(a))) add(n, '$expr');
        }
      }
      // { sort: { _id: … }, limit: … }
      if (plainName(n.name, checker) === 'sort' && firstKey(n.initializer, checker) === '_id' && ts.isObjectLiteralExpression(n.parent)
        && n.parent.properties.some(p => (ts.isPropertyAssignment(p) || ts.isShorthandPropertyAssignment(p)) && plainName(p.name, checker) === 'limit')) {
        add(n.parent, 'find options');
      }
    }
    // filter._id = { $gt: x }, filter['_id'] = …
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const l = n.left;
      const isId = (ts.isPropertyAccessExpression(l) && l.name.text === '_id')
        || (ts.isElementAccessExpression(l) && ts.isStringLiteral(l.argumentExpression) && l.argumentExpression.text === '_id');
      if (isId && isRangeOnCursor(n.right, checker)) add(n, '_id assignment');
    }
    // .sort({ _id: … }) in a chain that also limits
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'sort'
      && firstKey(n.arguments[0], checker) === '_id') {
      const chain = chainOf(n);
      if (chain.includes('limit') && (chain.includes('find') || chain.includes('aggregate'))) add(n, 'sort-limit chain');
    }
    // [ …, { $sort: { _id: … } }, …, { $limit: n } ]
    if (ts.isArrayLiteralExpression(n)) {
      const stages = n.elements.map(unwrap).filter(e => e && ts.isObjectLiteralExpression(e));
      const sortStage = stages.find(s => s.properties.some(p => ts.isPropertyAssignment(p) && plainName(p.name, checker) === '$sort' && firstKey(p.initializer, checker) === '_id'));
      const limitStage = stages.some(s => s.properties.some(p => ts.isPropertyAssignment(p) && plainName(p.name, checker) === '$limit'));
      if (sortStage && limitStage) add(n, 'pipeline');
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
