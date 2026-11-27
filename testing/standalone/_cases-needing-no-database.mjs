/**
 * Which cases of a database test file read the mounted routes and never touch the database — the question, answered once (Q-969).
 *
 * ## Why a module
 *
 * The local preflight runs the pure tier only. A case that derives its subjects from `mountedRoutes()` and checks a table (every
 * derived route has a request, every derived door has a case) needs no database, but while it sits in a `-db` file it runs only in
 * CI. Bundle-272's Full run 45779013515 failed on exactly such a case, `the subjects are derived from the mounts, have a floor, and
 * every one has a request`, which a new route (the SPARQL Update door) broke: a whole bundle cycle went to CI to learn what a local
 * run would have said in a second.
 *
 * ## What is judged, per case
 *
 * A case (`it` body, read through `testBodies`) is NAMED when both hold:
 *
 * - it reads the routes: the case, or a binding it reaches (a const, a function, a hook assignment, followed through function bodies),
 *   calls `mountedRoutes` / `mountedRoutesWithSource`, or uses a name imported from a test helper that does;
 * - it touches no database: no binding it reaches holds live state. A binding is live when a value assigned to it awaits (`door =
 *   await openPushDoor(...)`, `const env = skip ? null : await open...(...)`), when a hook assigns it the result of a call or `new`,
 *   or when its value is built from another live binding; and any `open...`, `listen...`, `appRouter`, `createApp` or `fetch` the
 *   case reaches is live too. A function a case reaches is read through its body (it runs at case time); a function a const's value
 *   only calls at load is not (a table built by a function over `rest` does not make a case that reads the table's routes a case
 *   that sends a request).
 *
 * A file that keeps its database cases and loses only the pure ones is judged per case, so it passes. Names the case declares
 * itself (`const { routeMapContents } = await import(...)`) are its own and are not state.
 *
 * ## The floor is inside
 *
 * `databaseTestFiles` throws below a floor of files and `routeCasesWithoutDatabase` is asked of a parsed file, so a scan that
 * reads nothing cannot report clean.
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { ts, parseSource, lineOf, walkOwnCode, walkEveryNode } from '../_shared/syntax-tree.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { testBodies } from './_test-bodies.mjs';

/** The functions that list what the server mounts. */
export const ROUTE_LISTERS = Object.freeze(['mountedRoutes', 'mountedRoutesWithSource']);

/** Names that open a database, a server or the app when called: reaching one makes a case a database case. */
const OPENS = /^(open[A-Z]\w*|listen[A-Z]\w*|appRouter|createApp|fetch)$/;

const FLOOR_FILES = 400;

/** The `-db` test files of `testing/standalone`, as tracked paths. Throws when the listing is implausibly short. */
export function databaseTestFiles({ root = REPO_ROOT } = {}) {
  const files = trackedSources('testing/standalone', { ext: ['-db.test.js'], floor: 50, root }).filter(f => f.endsWith('-db.test.js'));
  if (files.length < FLOOR_FILES) throw new Error(`only ${files.length} -db test file(s) listed under testing/standalone, below the floor of ${FLOOR_FILES}: the listing is broken, not the tests`);
  return files;
}

const isFn = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n);
const describeCallback = (f) => ts.isCallExpression(f.parent) && /^(describe|suite)(\.\w+)?$/.test(f.parent.expression.getText());

/** Whether a declaration sits where later code can read it as shared state: the file, or the callback of a `describe`. */
function atStateScope(node) {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p) && !describeCallback(p)) return false;
  return true;
}

const namesBound = (name) => {
  if (ts.isIdentifier(name)) return [name.text];
  const out = [];
  walkEveryNode(name, (n) => { if (ts.isBindingElement(n) && ts.isIdentifier(n.name)) out.push(n.name.text); });
  return out;
};

/** Every name bound at state scope: `name -> [{ fn } | { value, assigned }]`, each entry a function, a value or an assignment. */
function bindingsOf(sf) {
  const byName = new Map();
  const add = (name, entry) => byName.set(name, [...(byName.get(name) ?? []), entry]);
  walkEveryNode(sf, (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body && atStateScope(n)) add(n.name.text, { fn: n });
    else if (ts.isVariableDeclaration(n) && n.initializer && atStateScope(n)) {
      for (const name of namesBound(n.name)) add(name, isFn(n.initializer) ? { fn: n.initializer } : { value: n.initializer });
    } else if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
      add(n.left.text, { value: n.right, assigned: true });
    }
  });
  return byName;
}

/** The names a file imports from a module that lists the mounted routes: a case using one of them reads the routes too. */
function routeNamesImported(sf, file, root) {
  const out = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteralLike(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
    let text;
    try { text = readFileSync(join(root, dirname(file), st.moduleSpecifier.text), 'utf8'); } catch { continue; }
    if (!ROUTE_LISTERS.some(r => text.includes(`${r}(`))) continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) out.add(clause.name.text);
    const nb = clause.namedBindings;
    if (nb && ts.isNamespaceImport(nb)) out.add(nb.name.text);
    else if (nb) for (const el of nb.elements) out.add(el.name.text);
  }
  return out;
}

/** The identifier names a node mentions, as references (a property name or an object key is not one). `own` leaves nested functions out. */
function refsOf(node, { own = false } = {}) {
  const out = new Set();
  const visit = (n) => {
    if (ts.isIdentifier(n)) {
      const p = n.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n) || (ts.isBindingElement(p) && p.propertyName === n);
      if (!isName) out.add(n.text);
    }
  };
  if (own) walkOwnCode(node, (n) => { visit(n); return false; });
  else walkEveryNode(node, visit);
  return out;
}

const hasOwn = (node, test) => walkOwnCode(node, (n) => test(n) === true);

/** Names a callback declares for itself (parameters and variables anywhere in it). */
function declaredIn(fn) {
  const out = new Set();
  for (const p of fn.parameters) for (const n of namesBound(p.name)) out.add(n);
  walkEveryNode(fn, (n) => { if (ts.isVariableDeclaration(n)) for (const name of namesBound(n.name)) out.add(name); });
  return out;
}

/**
 * The cases of `text` (a test file named `file`) that read the routes and touch no database.
 *
 * @returns {{ name: string, line: number }[]}
 */
export function routeCasesWithoutDatabase(file, text, { root = REPO_ROOT } = {}) {
  const sf = parseSource(file, text);
  const bindings = bindingsOf(sf);
  const routeNames = new Set([...ROUTE_LISTERS, ...routeNamesImported(sf, file, root)]);

  /** Whether the names reach a route lister, following every binding through functions and values alike. */
  const readsRoutes = (start) => {
    const seen = new Set();
    const queue = [...start];
    while (queue.length) {
      const name = queue.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      if (routeNames.has(name)) return true;
      for (const e of bindings.get(name) ?? []) for (const r of refsOf(e.fn ?? e.value)) queue.push(r);
    }
    return false;
  };

  /** Whether the names reach live state: a function is read through its body only where `call` says it runs at case time. */
  const touchesDatabase = (start) => {
    const seen = new Set();
    const queue = [...start].map(name => ({ name, call: true }));
    while (queue.length) {
      const { name, call } = queue.pop();
      const key = `${call ? 'c' : 'v'}:${name}`;
      if (seen.has(key) || (!call && seen.has(`c:${name}`))) continue;
      seen.add(key);
      if (OPENS.test(name)) return true;
      for (const e of bindings.get(name) ?? []) {
        if (e.fn) {
          if (call) for (const r of refsOf(e.fn)) queue.push({ name: r, call: true });
          continue;
        }
        if (hasOwn(e.value, n => ts.isAwaitExpression(n))) return true;
        if (e.assigned && hasOwn(e.value, n => ts.isCallExpression(n) || ts.isNewExpression(n))) return true;
        for (const r of refsOf(e.value, { own: true })) queue.push({ name: r, call: false });
      }
    }
    return false;
  };

  const out = [];
  for (const { name, fn } of testBodies(sf)) {
    const own = declaredIn(fn);
    const refs = [...refsOf(fn)].filter(r => !own.has(r));
    if (readsRoutes(refs) && !touchesDatabase(refs)) out.push({ name, line: lineOf(sf, fn) });
  }
  return out;
}
