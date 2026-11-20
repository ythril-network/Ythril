/**
 * Which token a call is made with: does a call in a test file reach the suite's SHARED token, the one every file reads from
 * `testing/sync/configs/<x>/token.txt`?
 *
 * ## What it answers, and what it prevents
 *
 * `a-heavy-call-in-a-stack-test-spends-its-own-tokens-budget` needs one question about a call site: "is the bearer of this call the shared
 * setup token?". The heavy-call limit is counted per token, so a call made with the shared token spends a budget every other file of
 * the job spends too (main run 44736302108: a 429 in `schema-validation.test.js` from slots two earlier files had spent).
 *
 * A token is SHARED when its value comes, by plain forwarding, from a read of `token.txt`: the read itself, a variable assigned from it, a
 * function that returns it (`function token() { return tokenA; }`), an imported function whose declaration reads it, a parameter whose
 * every caller in the file passes it, a session opened with it (`openMcpSession(<shared>)`). A value computed FROM a shared token by
 * calling the server (`const tok = await mint(...)`, where `mint` posts to `/api/tokens` with the shared token as the authority) is NOT
 * shared: that is a token of its own, which is the whole point. So the walk follows forwarding, never "an identifier somewhere in the
 * arguments".
 *
 * `OWN_TOKEN_MODULE` is the one module whose own text reads `token.txt` and whose products are clean by definition.
 *
 * Syntax only, no types, one file at a time (an import is followed one hop, to the declaration it names). A call whose bearer cannot be
 * traced (a parameter of a function nothing in the file calls) is read as not shared, and the gate's planted cases show the shapes it
 * does follow.
 */
import path from 'node:path';
import { ts, parseSource, unwrapExpression } from '../_shared/syntax-tree.mjs';

/** The module a stack-suite file takes its own token from; the one module whose reading of the shared token is the point. */
export const OWN_TOKEN_MODULE = 'testing/_shared/own-token.mjs';

/**
 * Functions that return a handle carrying the token they were given, so what they return is as shared as their argument. Not a list of
 * heavy doors (those are derived from the product); a list of the one kind of helper that hides a token inside a value.
 */
export const TOKEN_CARRIERS = Object.freeze(['openMcpSession', 'readFileSync']);

const isFn = (n) => ts.isFunctionLike(n) && !ts.isMethodSignature(n);

function walk(node, visit, { intoFunctions = true } = {}) {
  const go = (n) => {
    if (visit(n) === false) return;
    if (!intoFunctions && isFn(n) && n !== node) return;
    ts.forEachChild(n, go);
  };
  go(node);
}

/** Whether any string in `node` (comments are not strings) names `token.txt`. */
function readsTokenFile(node, { intoFunctions }) {
  let found = false;
  walk(node, (n) => {
    if (found) return false;
    if ((ts.isStringLiteralLike(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) && n.text.includes('token.txt')) found = true;
  }, { intoFunctions });
  return found;
}

/** The index of one file: its functions, variable definitions, imports and the calls it makes by name. */
function indexOf(file, text) {
  const sf = parseSource(file, text);
  const fns = new Map();
  const defs = new Map();
  const imports = new Map();
  const calls = new Map();
  const add = (map, k, v) => { if (!map.has(k)) map.set(k, []); map.get(k).push(v); };
  walk(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name) add(fns, n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) {
      const init = unwrapExpression(n.initializer);
      if (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) add(fns, n.name.text, init);
      else add(defs, n.name.text, n.initializer);
    }
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) add(defs, n.left.text, n.right);
    if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier) && n.importClause?.namedBindings && ts.isNamedImports(n.importClause.namedBindings)) {
      for (const el of n.importClause.namedBindings.elements) imports.set(el.name.text, { spec: n.moduleSpecifier.text, imported: (el.propertyName ?? el.name).text });
    }
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) add(calls, n.expression.text, n);
  });
  return { file, sf, fns, defs, imports, calls };
}

/**
 * @param {{ file: string, text: string }[]} files the files in scope (repo-relative posix paths)
 * @param {(file: string) => string | null} readModule the text of a repo-relative file, or null when there is none
 */
export function tokenFlow(files, readModule) {
  const indexes = new Map();
  const indexFor = (file, text) => { if (!indexes.has(file)) indexes.set(file, indexOf(file, text)); return indexes.get(file); };

  /** The declaration `name` in `file`'s top level, or null. */
  const declarationIn = (file, name) => {
    const text = readModule(file);
    if (text == null) return null;
    const ix = indexFor(file, text);
    const node = ix.fns.get(name)?.[0] ?? ix.defs.get(name)?.[0];
    return node && !ts.isFunctionDeclaration(node) ? node.parent : (node ?? null);
  };

  const resolveImport = (ix, spec) => {
    if (!spec.startsWith('.')) return null;
    const base = path.posix.normalize(path.posix.join(path.posix.dirname(ix.file), spec));
    return [base, `${base}.js`, `${base}.mjs`].find(f => readModule(f) != null) ?? null;
  };

  const importedIsShared = (ix, name) => {
    const imp = ix.imports.get(name);
    const target = imp && resolveImport(ix, imp.spec);
    if (!target || target === OWN_TOKEN_MODULE) return false;
    const decl = declarationIn(target, imp.imported);
    return decl != null && readsTokenFile(decl, { intoFunctions: true });
  };

  const returnsOf = (fn) => {
    if (!fn.body) return [];
    if (!ts.isBlock(fn.body)) return [fn.body];
    const out = [];
    walk(fn.body, (n) => { if (ts.isReturnStatement(n) && n.expression) out.push(n.expression); }, { intoFunctions: false });
    return out;
  };

  function shared(expr, ix, seen) {
    const e = unwrapExpression(expr);
    if (!e) return false;
    if (readsTokenFile(e, { intoFunctions: false })) return true;
    if (ts.isIdentifier(e)) return identifierShared(e, ix, seen);
    if (ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)) return shared(e.expression, ix, seen);
    if (ts.isConditionalExpression(e)) return shared(e.whenTrue, ix, seen) || shared(e.whenFalse, ix, seen);
    if (ts.isBinaryExpression(e) && [ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.AmpersandAmpersandToken].includes(e.operatorToken.kind)) {
      return shared(e.left, ix, seen) || shared(e.right, ix, seen);
    }
    if (ts.isCallExpression(e)) return callShared(e, ix, seen);
    return false;
  }

  function callShared(call, ix, seen) {
    const callee = unwrapExpression(call.expression);
    if (ts.isPropertyAccessExpression(callee)) {
      if (TOKEN_CARRIERS.includes(callee.name.text)) return call.arguments.some(a => shared(a, ix, seen));
      return ['trim', 'toString', 'replace', 'slice'].includes(callee.name.text) && shared(callee.expression, ix, seen);
    }
    if (!ts.isIdentifier(callee)) return false;
    const name = callee.text;
    if (TOKEN_CARRIERS.includes(name) && call.arguments.some(a => shared(a, ix, seen))) return true;
    for (const fn of ix.fns.get(name) ?? []) {
      const key = `${ix.file}#fn:${name}`;
      if (seen.has(key)) continue;
      seen.add(key);
      if (returnsOf(fn).some(r => shared(r, ix, seen))) return true;
    }
    return importedIsShared(ix, name);
  }

  function identifierShared(id, ix, seen) {
    const name = id.text;
    // A parameter of an enclosing function: shared when a call of that function in this file passes a shared value in its place.
    for (let p = id.parent; p; p = p.parent) {
      if (!isFn(p) || !p.parameters) continue;
      const at = p.parameters.findIndex(x => ts.isIdentifier(x.name) && x.name.text === name);
      if (at < 0) continue;
      const fname = ts.isFunctionDeclaration(p) ? p.name?.text : (ts.isVariableDeclaration(p.parent) && ts.isIdentifier(p.parent.name) ? p.parent.name.text : null);
      if (!fname) return false;
      const key = `${ix.file}#param:${fname}:${at}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return (ix.calls.get(fname) ?? []).some(c => c.arguments[at] && shared(c.arguments[at], ix, seen));
    }
    const key = `${ix.file}#var:${name}`;
    if (seen.has(key)) return false;
    seen.add(key);
    if ((ix.defs.get(name) ?? []).some(rhs => shared(rhs, ix, seen))) return true;
    return importedIsShared(ix, name);
  }

  /** Value-position identifiers under `node` (not a property's name, not a declaration's name). */
  const referencesIn = (node) => {
    const out = [];
    walk(node, (n) => {
      if (!ts.isIdentifier(n)) return;
      const p = n.parent;
      if (ts.isPropertyAccessExpression(p) && p.name === n) return;
      if ((ts.isPropertyAssignment(p) || ts.isBindingElement(p) || ts.isParameter(p) || ts.isVariableDeclaration(p)) && p.name === n) return;
      out.push(n);
    });
    return out;
  };

  /**
   * The first shared token a call reaches, as `{ name }`, or null. The call is the nearest call whose arguments hold `site`; with none (a
   * body built in a variable, then sent) it is the whole function around `site`. The walk goes into every local function the call names,
   * because a helper (`viaRest(tool, args)`) is where the bearer is written.
   */
  function sharedTokenAt(file, text, site) {
    const ix = indexFor(file, text);
    let unit = null;
    for (let p = site.parent; p; p = p.parent) {
      if (ts.isCallExpression(p) && p.arguments.some(a => a.pos <= site.pos && site.end <= a.end)) { unit = p; break; }
      if (isFn(p)) break;
    }
    unit ??= (() => { for (let p = site.parent; p; p = p.parent) if (isFn(p) || ts.isSourceFile(p)) return p; return ix.sf; })();
    const visited = new Set();
    const queue = [unit];
    while (queue.length) {
      const node = queue.pop();
      for (const id of referencesIn(node)) {
        const asCall = ts.isCallExpression(id.parent) && id.parent.expression === id;
        if (asCall ? callShared(id.parent, ix, new Set()) : identifierShared(id, ix, new Set())) return { name: id.text };
        for (const fn of ix.fns.get(id.text) ?? []) {
          if (visited.has(fn)) continue;
          visited.add(fn);
          queue.push(fn);
        }
      }
    }
    return null;
  }

  return { sharedTokenAt, indexFor };
}
