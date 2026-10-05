/**
 * Where does the TEXT of a caught error leave its catch — into an answer, or into a record that is served later?
 *
 * ## The question this answers, and why it is derived rather than listed
 *
 * A driver error's message names the host, the port and the namespace it failed on (`connection 5 to 172.16.0.9:27017
 * closed`, `getaddrinfo ENOTFOUND mongo-a.internal`). Every door that answers an error's own text hands that to a caller
 * who may be anonymous, and every record that stores it (a job's `lastError`, a sync cycle's error list) hands it to
 * whoever reads the record later. There are some forty catches of the first kind and a handful of the second, spread
 * over thirty-odd files; a hand-written list of them is the list that misses the forty-first, so this reads them from
 * the source: **every catch scope, every use of the caught binding or of anything computed from it, and where that use
 * goes.**
 *
 * ## What counts as the error's text leaving
 *
 * A use of the binding (or an alias of it: `const msg = err instanceof Error ? err.message : String(err)`) that
 * reaches one of these EXITS:
 *
 *  - **a response**: an argument of `res.json(...)`, `res.status(n).json(...)`, `res.send(...)`, `res.end(...)`, or of a
 *    call that is handed `res` itself (a sender: `sendThing(res, 500, msg)`);
 *  - **an act's answer**: the `error` property of an object literal that is RETURNED (`return { status: 502, error: ... }`,
 *    the shape the join and rename acts answer in) or handed to a response;
 *  - **a list of failures**: an argument of ANY `.push(...)`, whatever the list is called — `errors.push(...)`,
 *    `failed.push({ id, error: err.message })`, `results.push(...)` — when the argument reads the binding or an alias of it:
 *    `err.message`, `String(err)`, `${err}`, `err` itself, an alias of any of those, or an object literal with such a value.
 *    A list a caller reads or a record stores later (a sync cycle's history, a bulk answer's `failed`) is never named
 *    for what it holds. This used to be recognised by the list's NAME (`errors`, `error`, `errorMessages`), which is how
 *    a bulk-resolve's `failed.push({ id, error: err.message })` went unseen; a push that only collects text for a log
 *    line is flagged too and needs its reason in `EXEMPT`, the price of not trusting a name;
 *  - **a literal**: the rule is about the VALUE, not the call it goes through. Inside a catch, any array-literal element or
 *    object-literal property value (`{ detail: err.message }`, `[\`dbStats: ${err.message}\`]`, the shorthand `{ detail }`
 *    of an alias) that reads the binding's text is an exit wherever the literal goes — returned, assigned, spread into a
 *    response, handed to a function. The push form above is one case of it. A literal that is an argument of a LOGGER
 *    (`log.*`, `logger.*`, `console.*`, `reportServerFailure`, `reportDriverFailure`) is not an exit: that is where the
 *    text is supposed to go. A nested literal is judged at its leaf value, once;
 *  - **a stored failure**: an argument of a call to a function that WRITES a `lastError` — derived, not named: any
 *    function whose body has a `lastError` property gets its error-ish parameter (`errorMessage`, `msg`, `err`) read as
 *    the stored text.
 *
 * ## What does not
 *
 *  - **A sanitizer.** A use inside a call of one of `SANITIZERS` — the one function that renders an error for an
 *    answer — is the rule being followed. Senders are derived: a top-level function that takes `res` and calls a
 *    sanitizer is a sanitizer too (a `sendCaughtFailure(res, err)` needs no entry here).
 *  - **Our own error class.** A use inside `if (err instanceof OwnClass) { ... }` (or the true arm of `err instanceof
 *    OwnClass ? ... : ...`), where `OwnClass` is declared under `server/src`. Our own refusal's words are ours to say;
 *    the narrowing is what proves the error is one of ours, and `err instanceof Error` (the builtin) proves nothing. A guard
 *    that leaves for any other class (`if (!(err instanceof OwnClass)) throw err;`) narrows the statements after it.
 *  - **A boolean made of the error.** `err instanceof C` and `re.test(text)` let none of the text out, so a value computed
 *    only from them (`const unreadable = err instanceof StoredFileUnreadable`) is not tainted.
 *
 * Read with the TypeScript AST: a comment explaining the rule can neither satisfy nor trip it, and the shapes above are
 * parsed rather than pattern-matched. No checker is built (it would read every file's types): everything here is
 * syntactic, and what a syntax cannot see is said in the test that uses this.
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const require = createRequire(path.resolve('package.json'));
const ts = require('typescript');

const RESPONSE_METHODS = new Set(['json', 'send', 'end']);
const ERROR_PARAM = /^(?:err|error|errorMessage|errMsg|msg|message)$/i;

const lineOf = (sf, node) => sf.getLineAndCharacterOfPosition(node.getStart()).line + 1;
const snippet = node => node.getText().replace(/\s+/g, ' ').slice(0, 120);

/** Reporters whose whole job is to write a failure to the log: the text goes where a driver's text is supposed to go. */
const LOG_REPORTERS = new Set(['reportServerFailure', 'reportDriverFailure', 'reportRecurringDriverFailure']);

/** Is this callee a logger — `log.warn`, `logger.error`, `console.log`, or one of `LOG_REPORTERS`? */
function isLogger(callee) {
  if (ts.isIdentifier(callee)) return LOG_REPORTERS.has(callee.text);
  const root = rootOf(callee);
  return !!root && /^(?:log|logger|console)$/.test(root.text);
}

/** The root identifier of `a.b(c).d(e)` — `a`. */
function rootOf(expr) {
  let e = expr;
  while (e && (ts.isCallExpression(e) || ts.isPropertyAccessExpression(e) || ts.isElementAccessExpression(e)
    || ts.isNonNullExpression(e) || ts.isParenthesizedExpression(e))) e = e.expression;
  return e && ts.isIdentifier(e) ? e : null;
}

/** Every top-level function of a file as `name -> { node, params }`, `export`ed or not, `const f = () =>` included. */
function topLevelFunctions(sf) {
  const out = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, { node: st, params: st.parameters });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.set(d.name.text, { node: init, params: init.parameters });
        }
      }
    }
  }
  return out;
}

const has = (node, pred) => { let hit = false; const v = n => { if (!hit) { if (pred(n)) hit = true; else ts.forEachChild(n, v); } }; v(node); return hit; };

/** Does this function's body write a `lastError`? (An object-literal property, long or shorthand, of that name.) */
const writesLastError = node => has(node.body ?? node, n =>
  (ts.isPropertyAssignment(n) || ts.isShorthandPropertyAssignment(n)) && n.name && ts.isIdentifier(n.name) && n.name.text === 'lastError');

/**
 * Parse every source and derive what the walk needs about the whole set: the classes the repo declares (an `instanceof`
 * one of them proves the error is ours), the sanitizers (the named ones, and every sender that calls one), and the
 * functions that store a failure.
 */
export function readSources(sources, { sanitizers: named, deciders = [] }) {
  const files = new Map();
  const ownClasses = new Set();
  for (const [file, text] of sources) {
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    files.set(file, sf);
    const v = n => {
      if (ts.isClassDeclaration(n) && n.name) ownClasses.add(n.name.text);
      ts.forEachChild(n, v);
    };
    v(sf);
  }
  const functions = new Map();
  for (const sf of files.values()) for (const [name, f] of topLevelFunctions(sf)) functions.set(name, f);

  // Derived sanitizers, three rounds (a sender of a sender, a text-maker built on a text-maker): a top-level function that
  // calls a sanitizer or a DECIDER (`isDriverSide`, the predicate a text is chosen by) mediates what it is handed — whether it
  // takes `res` and answers (a sender) or returns the text a failure is stored with (a text-maker, which is also the shape of
  // a writer that renders the error itself before it stores it).
  const sanitizers = new Set(named);
  const decisive = new Set([...named, ...deciders]);
  for (let round = 0; round < 3; round++) {
    for (const [name, f] of functions) {
      if (sanitizers.has(name) || decisive.has(name)) continue;
      if (has(f.node, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && (sanitizers.has(n.expression.text) || deciders.includes(n.expression.text)))) {
        sanitizers.add(name);
        decisive.add(name);
      }
    }
  }

  // Stored-failure writers and the index of the parameter that carries the text.
  const writers = new Map();
  for (const [name, f] of functions) {
    if (!writesLastError(f.node)) continue;
    const at = f.params.findIndex(p => ts.isIdentifier(p.name) && ERROR_PARAM.test(p.name.text));
    if (at >= 0) writers.set(name, at);
  }
  return { files, ownClasses, sanitizers, writers, functions };
}

/**
 * Every catch scope of a file: the `catch (e)` clauses and the callbacks of `.catch(cb)`, each with the name its error
 * is bound to and the node to read.
 */
function scopesOf(sf) {
  const scopes = [];
  const v = n => {
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) {
      scopes.push({ bind: n.variableDeclaration.name.text, body: n.block, kind: 'catch' });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch') {
      const cb = n.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name)) {
        scopes.push({ bind: cb.parameters[0].name.text, body: cb.body, kind: '.catch' });
      }
    }
    ts.forEachChild(n, v);
  };
  v(sf);
  return scopes;
}

/** Does this condition test a tainted name against a class this repo declares (`err instanceof Refusal`)? */
function instanceOfOwnClass(cond, tainted, env) {
  return has(cond, n => ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    && ts.isIdentifier(n.left) && tainted.has(n.left.text) && ts.isIdentifier(n.right) && env.ownClasses.has(n.right.text));
}

/** `!(err instanceof Own)`, exactly: the guard whose true arm is "this is not one of ours". */
function negatedOwnTest(cond, tainted, env) {
  let c = cond;
  if (!(ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken)) return false;
  c = c.operand;
  while (ts.isParenthesizedExpression(c)) c = c.expression;
  return instanceOfOwnClass(c, tainted, env);
}

/** Does this statement end its block by leaving it — a `throw` or `return`, bare or as the last statement of a block? */
function leaves(st) {
  if (ts.isThrowStatement(st) || ts.isReturnStatement(st)) return true;
  return ts.isBlock(st) && st.statements.length > 0 && leaves(st.statements[st.statements.length - 1]);
}

/** Is `node` inside the true arm of an `instanceof OwnClass` test, between it and `stop`? */
function ownNarrowed(node, stop, tainted, env) {
  for (let p = node; p && p !== stop; p = p.parent) {
    const q = p.parent;
    if (!q) break;
    // A guard that leaves for any other class (`if (!(err instanceof Own)) throw err;`) narrows every statement after it.
    if (ts.isBlock(q) && ts.isStatement(p)) {
      for (const s of q.statements) {
        if (s === p) break;
        if (ts.isIfStatement(s) && !s.elseStatement && leaves(s.thenStatement) && negatedOwnTest(s.expression, tainted, env)) return true;
      }
    }
    if (ts.isIfStatement(q) && q.thenStatement === p && instanceOfOwnClass(q.expression, tainted, env)) return true;
    if (ts.isConditionalExpression(q) && q.whenTrue === p && instanceOfOwnClass(q.condition, tainted, env)) return true;
  }
  return false;
}

/**
 * Reads of a tainted name inside `node`, as `{ reads, sanitized }`: `reads` the uses that are NOT inside a sanitizer call
 * or a narrowing to one of our own classes, `sanitized` the uses that are (kept, so a floor can count the population).
 */
function readsIn(node, tainted, env) {
  const out = { reads: 0, sanitized: 0 };
  const instanceOfOwn = cond => instanceOfOwnClass(cond, tainted, env);
  const walk = (n, state) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && env.sanitizers.has(n.expression.text)) {
      ts.forEachChild(n, c => walk(c, { ...state, sanitized: true }));
      return;
    }
    if (ts.isIfStatement(n) && instanceOfOwn(n.expression)) {
      walk(n.thenStatement, { ...state, own: true });
      if (n.elseStatement) walk(n.elseStatement, state);
      return;
    }
    if (ts.isConditionalExpression(n) && instanceOfOwn(n.condition)) {
      walk(n.whenTrue, { ...state, own: true });
      walk(n.whenFalse, state);
      return;
    }
    // Two uses that make a BOOLEAN of the error and let none of its text out: `err instanceof C`, and `re.test(text)`.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) { walk(n.right, state); return; }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'test') {
      walk(n.expression.expression, state);
      return;
    }
    if (ts.isIdentifier(n) && tainted.has(n.text)) {
      const p = n.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || (ts.isVariableDeclaration(p) && p.name === n) || (ts.isParameter(p) && p.name === n)
        || (ts.isBindingElement(p) && p.name === n);
      if (!isName) { if (state.own) out.sanitized++; else if (state.sanitized) out.sanitized++; else out.reads++; }
      return;
    }
    ts.forEachChild(n, c => walk(c, state));
  };
  walk(node, {});
  return out;
}

/**
 * Every exit of the error's text in a file, as `{ file, line, form, text, flagged }` — `flagged` when the text leaves
 * unfiltered, false when it leaves only through a sanitizer or only as one of our own errors.
 */
export function exitsIn(file, env) {
  const sf = env.files.get(file);
  const found = [];
  const seen = new Set();
  for (const scope of scopesOf(sf)) {
    const tainted = new Set([scope.bind]);
    // Aliases, in source order: a declaration whose initializer reads a tainted name unfiltered is itself tainted.
    const decls = [];
    const dv = n => { if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) decls.push(n); ts.forEachChild(n, dv); };
    dv(scope.body);
    for (const d of decls) if (!ownNarrowed(d, scope.body, tainted, env) && readsIn(d.initializer, tainted, env).reads > 0) tainted.add(d.name.text);
    const record = (node, form, argument) => {
      if (seen.has(node)) return;
      let r = readsIn(argument, tainted, env);
      if (r.reads > 0 && ownNarrowed(node, scope.body, tainted, env)) r = { reads: 0, sanitized: r.sanitized + r.reads };
      if (r.reads === 0 && r.sanitized === 0) return;
      seen.add(node);
      found.push({ file, line: lineOf(sf, node), form, text: snippet(node), flagged: r.reads > 0 });
    };
    const returned = o => {
      for (let p = o.parent; p; p = p.parent) {
        if (ts.isReturnStatement(p)) return true;
        if (ts.isArrowFunction(p) && p.body === o) return true;
        if (ts.isBlock(p) || ts.isFunctionLike(p)) return false;
      }
      return false;
    };
    const underRecorded = n => { for (let p = n.parent; p && p !== scope.body; p = p.parent) if (seen.has(p)) return true; return false; };
    /** A value inside a literal that reads the error's text unfiltered, wherever the literal goes (unless to a logger). */
    const literalValue = (n, value) => {
      if (ts.isObjectLiteralExpression(value) || ts.isArrayLiteralExpression(value)) return;
      if (seen.has(n) || underRecorded(n)) return;
      record(n, 'literal', value);
    };
    const ev = (n, inLog = false) => {
      if (ts.isCallExpression(n) && isLogger(n.expression)) inLog = true;
      if (ts.isCallExpression(n)) {
        const callee = n.expression;
        // a response
        if (ts.isPropertyAccessExpression(callee) && RESPONSE_METHODS.has(callee.name.text)) {
          const root = rootOf(callee.expression);
          if (root && /^res(ponse)?$/.test(root.text)) for (const a of n.arguments) record(n, 'response', a);
        }
        // a sanitizing sender: counted in the population, never flagged
        if (ts.isIdentifier(callee) && env.sanitizers.has(callee.text)
          && n.arguments.some(a => ts.isIdentifier(a) && /^res(ponse)?$/.test(a.text))) record(n, 'sanitized sender', n);
        // a call handed `res` itself: a sender
        if (ts.isIdentifier(callee) && !env.sanitizers.has(callee.text)
          && n.arguments.some(a => ts.isIdentifier(a) && /^res(ponse)?$/.test(a.text))) {
          for (const a of n.arguments) if (!(ts.isIdentifier(a) && /^res(ponse)?$/.test(a.text))) record(n, 'sender', a);
        }
        // a list of failures: ANY `.push(...)`, whatever the list is called (see the docblock)
        if (ts.isPropertyAccessExpression(callee) && callee.name.text === 'push') {
          for (const a of n.arguments) record(n, 'failure list', a);
        }
        // a stored failure
        if (ts.isIdentifier(callee) && env.writers.has(callee.text)) {
          const a = n.arguments[env.writers.get(callee.text)];
          if (a) record(n, 'stored failure', a);
        }
      }
      // an act's answer: an `error` property of a returned object literal, or of one handed to a response
      if (ts.isPropertyAssignment(n) && ts.isIdentifier(n.name) && n.name.text === 'error' && ts.isObjectLiteralExpression(n.parent)) {
        const o = n.parent;
        const inResponse = ts.isCallExpression(o.parent) && ts.isPropertyAccessExpression(o.parent.expression)
          && RESPONSE_METHODS.has(o.parent.expression.name.text);
        if (returned(o) && !inResponse) record(n, 'act answer', n.initializer);
      }
      // a literal: the rule about the value, after the forms above have had their say about the same node
      if (!inLog) {
        if (ts.isArrayLiteralExpression(n)) for (const el of n.elements) literalValue(el, ts.isSpreadElement(el) ? el.expression : el);
        if (ts.isPropertyAssignment(n)) literalValue(n, n.initializer);
        if (ts.isShorthandPropertyAssignment(n)) literalValue(n, n.name);
      }
      ts.forEachChild(n, c => ev(c, inLog));
    };
    ev(scope.body);
  }
  return found;
}

/** Every exit in every source, with the derived sets that were used. */
export function analyse(sources, opts) {
  const env = readSources(sources, opts);
  const exits = [];
  for (const file of env.files.keys()) exits.push(...exitsIn(file, env));
  return { exits, env };
}
