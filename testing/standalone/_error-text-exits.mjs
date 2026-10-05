/**
 * Where does the TEXT of a caught error leave its catch — into an answer, or into a record that is served later?
 *
 * ## The question this answers, and why it is derived rather than listed
 *
 * A driver error's message names the host, the port and the namespace it failed on (`connection 5 to 172.16.0.9:27017
 * closed`, `getaddrinfo ENOTFOUND mongo-a.internal`). Every door that answers an error's own text hands that to a caller
 * who may be anonymous, and every record that stores it (a job's `lastError`, a sync cycle's error list, a webhook
 * delivery, an ingest run) hands it to whoever reads the record later. The catches of the first kind and the second are
 * spread over most of the server; a hand-written list of them is the list that misses the next one, so this reads them
 * from the source: **every catch scope, every use of the caught binding or of anything computed from it, and where that
 * use goes.**
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
 *  - **a property assignment**: `run.error = err.message`, `delivery.error = ...`, `out['why'] = String(err)` — the text
 *    written onto an object that is returned, stored or served later (an ingest run `ingest_status` answers, a webhook
 *    delivery kept in the history). Which object it is cannot be told from the syntax, so every assignment of the text
 *    onto a property is an exit;
 *  - **a returned text**: `return err.message` from a function whose caller puts the return into an answer, a pushed
 *    list or a stored record. The return alone is not the exit (a helper whose callers only log it is fine), so this
 *    is derived in two steps: a function whose catch RETURNS the text unfiltered is a text-maker (`firstMissingEnd` in
 *    `brain/bulk.ts` returned `err.message` for the batch to put in its `errors`), a function that returns a text-maker's
 *    result is one too, and every CALL of a text-maker is read like a use of the caught binding: its result is tainted, and
 *    where it goes is judged by the forms above, in the caller;
 *  - **a stored failure**: an argument of a call to a function that WRITES a `lastError` — derived, not named: any
 *    function whose body has a `lastError` property gets its error-ish parameter (`errorMessage`, `msg`, `err`) read as
 *    the stored text.
 *
 * ## What does not
 *
 *  - **A sanitizer.** A use inside a call of one of the named sanitizers — the one function that renders an error for an
 *    answer — is the rule being followed. Senders and text-makers are DERIVED and are held to the rule themselves: a
 *    top-level function that calls a sanitizer (or asks a decider, `isDriverSide`) is a sanitizer only when nothing the
 *    function itself does with its error parameters lets the text out unfiltered, by any of the forms above or by
 *    returning it. A helper that logs through `caughtFailureText` and returns the raw text is NOT one: calling a
 *    sanitizer is not the same as handing on only what it said. `sendReadFailure(res, where, err)` is the real-tree case.
 *  - **Our own error class.** A use inside `if (err instanceof OwnClass) { ... }` (or the true arm of `err instanceof
 *    OwnClass ? ... : ...`), where `OwnClass` is declared under `server/src`. Our own refusal's words are ours to say;
 *    the narrowing is what proves the error is one of ours, and `err instanceof Error` (the builtin) proves nothing. A
 *    guard that leaves for any other class (`if (!(err instanceof OwnClass)) throw err;`) narrows the statements after it.
 *    The polarity is read: the arm of `!(err instanceof OwnClass)` that holds the error is NOT narrowed. A call of a
 *    decider (`isDriverSide(err)`) narrows the same way, to the arm where it answered false.
 *  - **A boolean made of the error.** `err instanceof C`, `re.test(text)` and a decider call let none of the text out, so a
 *    value computed only from them (`const unreadable = err instanceof StoredFileUnreadable`) is not tainted.
 *  - **A label.** `err.name`, `err.code` and `err.codeName` are the class and the code of the failure, never its message.
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
/** The parameters of a helper that carry a caught error into it: what a candidate sanitizer is held to. */
const ERROR_ARG = /^(?:e|err|error|cause|failure|exception|reason|errorMessage|errMsg|msg|message)$/i;
/** Properties of an error that are its class label or code, never its message: `err.name`, `err.code`, `err.codeName`. */
const LABEL_PROPS = new Set(['name', 'code', 'codeName']);

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

/** `(x as T)!` is `x`: the expression with its parentheses, assertions and non-null marks taken off. */
function unwrap(e) {
  let x = e;
  while (x && (ts.isParenthesizedExpression(x) || ts.isAsExpression(x) || ts.isNonNullExpression(x) || ts.isTypeAssertionExpression(x))) x = x.expression;
  return x;
}

/** Every top-level function of a file as `name -> { node, params, sf }`, `export`ed or not, `const f = () =>` included. */
function topLevelFunctions(sf) {
  const out = new Map();
  for (const st of sf.statements) {
    if (ts.isFunctionDeclaration(st) && st.name) out.set(st.name.text, { node: st, params: st.parameters, sf });
    if (ts.isVariableStatement(st)) {
      for (const d of st.declarationList.declarations) {
        const init = d.initializer;
        if (ts.isIdentifier(d.name) && init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
          out.set(d.name.text, { node: init, params: init.parameters, sf });
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

/** The nearest function-like node around `n`, or null at the top of the file. */
function nearestFunction(n) {
  for (let p = n.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p;
  return null;
}

/** The name a function is known by: its own, or the variable / property it is assigned to. `null` for a callback. */
function functionNameOf(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return null;
}

/** Is this node a call of a text-maker — `f(...)`, `this.f(...)`, `obj.f(...)` for a name in `env.textMakers`? */
function isTextMakerCall(n, env) {
  if (!ts.isCallExpression(n) || env.textMakers.size === 0) return false;
  const c = n.expression;
  return (ts.isIdentifier(c) && env.textMakers.has(c.text)) || (ts.isPropertyAccessExpression(c) && env.textMakers.has(c.name.text));
}

/** The catch scopes of a file: the `catch (e)` clauses and the callbacks of `.catch(cb)`. */
function catchScopesOf(sf) {
  const scopes = [];
  const v = n => {
    if (ts.isCatchClause(n) && n.variableDeclaration && ts.isIdentifier(n.variableDeclaration.name)) {
      scopes.push({ bind: [n.variableDeclaration.name.text], body: n.block, kind: 'catch' });
    }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'catch') {
      const cb = n.arguments[0];
      if (cb && (ts.isArrowFunction(cb) || ts.isFunctionExpression(cb)) && cb.parameters[0] && ts.isIdentifier(cb.parameters[0].name)) {
        scopes.push({ bind: [cb.parameters[0].name.text], body: cb.body, kind: '.catch' });
      }
    }
    ts.forEachChild(n, v);
  };
  v(sf);
  return scopes;
}

/** The top-level statements of a file that call a text-maker: scopes with no caught binding, tainted only by those calls. */
function textMakerScopesOf(sf, env) {
  return sf.statements.filter(st => has(st, n => isTextMakerCall(n, env))).map(st => ({ bind: [], body: st, kind: 'caller' }));
}

/** Does this condition test a tainted name against a class this repo declares (`err instanceof Refusal`)? */
function instanceOfOwnClass(c, tainted, env) {
  return ts.isBinaryExpression(c) && c.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword
    && ts.isIdentifier(c.left) && tainted.has(c.left.text) && ts.isIdentifier(c.right) && env.ownClasses.has(c.right.text);
}

/**
 * Which arm of a condition holds an error that is not the driver's: `{ then, else }`. `err instanceof Own` proves it in the
 * true arm; a decider call (`isDriverSide(err)`) in the false arm; `!` swaps them; `a && b` proves the true arm when either
 * does and the false arm only when both do; `a || b` the reverse.
 */
function ownArms(cond, tainted, env) {
  const none = { then: false, else: false };
  const c = unwrap(cond);
  if (!c) return none;
  if (ts.isPrefixUnaryExpression(c) && c.operator === ts.SyntaxKind.ExclamationToken) {
    const a = ownArms(c.operand, tainted, env);
    return { then: a.else, else: a.then };
  }
  if (ts.isBinaryExpression(c)) {
    const op = c.operatorToken.kind;
    if (op === ts.SyntaxKind.InstanceOfKeyword) return instanceOfOwnClass(c, tainted, env) ? { then: true, else: false } : none;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = ownArms(c.left, tainted, env), r = ownArms(c.right, tainted, env);
      return { then: l.then || r.then, else: l.else && r.else };
    }
    if (op === ts.SyntaxKind.BarBarToken) {
      const l = ownArms(c.left, tainted, env), r = ownArms(c.right, tainted, env);
      return { then: l.then && r.then, else: l.else || r.else };
    }
    return none;
  }
  if (ts.isCallExpression(c) && ts.isIdentifier(c.expression) && env.deciders.has(c.expression.text)
    && c.arguments.some(a => { const x = unwrap(a); return ts.isIdentifier(x) && tainted.has(x.text); })) return { then: false, else: true };
  return none;
}

/** Does this statement end its block by leaving it — a `throw` or `return`, bare or as the last statement of a block? */
function leaves(st) {
  if (ts.isThrowStatement(st) || ts.isReturnStatement(st)) return true;
  return ts.isBlock(st) && st.statements.length > 0 && leaves(st.statements[st.statements.length - 1]);
}

/** Is `node` inside an arm that holds an error which is not the driver's, between it and `stop`? */
function ownNarrowed(node, stop, tainted, env) {
  for (let p = node; p && p !== stop; p = p.parent) {
    const q = p.parent;
    if (!q) break;
    // A guard that leaves when the error is NOT ours (`if (!(err instanceof Own)) throw err;`, `if (isDriverSide(err)) return …;`)
    // narrows every statement after it.
    if (ts.isBlock(q) && ts.isStatement(p)) {
      for (const s of q.statements) {
        if (s === p) break;
        if (ts.isIfStatement(s) && !s.elseStatement && leaves(s.thenStatement) && ownArms(s.expression, tainted, env).else) return true;
      }
    }
    if (ts.isIfStatement(q)) {
      const arms = ownArms(q.expression, tainted, env);
      if (q.thenStatement === p && arms.then) return true;
      if (q.elseStatement === p && arms.else) return true;
    }
    if (ts.isConditionalExpression(q)) {
      const arms = ownArms(q.condition, tainted, env);
      if (q.whenTrue === p && arms.then) return true;
      if (q.whenFalse === p && arms.else) return true;
    }
  }
  return false;
}

/**
 * Reads of a tainted name inside `node`, as `{ reads, sanitized }`: `reads` the uses that are NOT inside a sanitizer call
 * or a narrowing to an error that is not the driver's, `sanitized` the uses that are (kept, so a floor can count the
 * population). A call of a text-maker is a read of the text it returns.
 */
function readsIn(node, tainted, env) {
  const out = { reads: 0, sanitized: 0 };
  const count = state => { if (state.own || state.sanitized) out.sanitized++; else out.reads++; };
  const walk = (n, state) => {
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && env.sanitizers.has(n.expression.text)) {
      ts.forEachChild(n, c => walk(c, { ...state, sanitized: true }));
      return;
    }
    // A decider answers a boolean and lets none of the text out.
    if (ts.isCallExpression(n) && ts.isIdentifier(n.expression) && env.deciders.has(n.expression.text)) return;
    if (isTextMakerCall(n, env)) { count(state); return; }
    if (ts.isIfStatement(n)) {
      const arms = ownArms(n.expression, tainted, env);
      if (arms.then || arms.else) {
        walk(n.thenStatement, { ...state, own: state.own || arms.then });
        if (n.elseStatement) walk(n.elseStatement, { ...state, own: state.own || arms.else });
        return;
      }
    }
    if (ts.isConditionalExpression(n)) {
      const arms = ownArms(n.condition, tainted, env);
      if (arms.then || arms.else) {
        walk(n.whenTrue, { ...state, own: state.own || arms.then });
        walk(n.whenFalse, { ...state, own: state.own || arms.else });
        return;
      }
    }
    // Two uses that make a BOOLEAN of the error and let none of its text out: `err instanceof C`, and `re.test(text)`.
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword) { walk(n.right, state); return; }
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'test') {
      walk(n.expression.expression, state);
      return;
    }
    // The class and the code of a failure are labels, not its message.
    if (ts.isPropertyAccessExpression(n) && LABEL_PROPS.has(n.name.text)) {
      const base = unwrap(n.expression);
      if (ts.isIdentifier(base) && tainted.has(base.text)) return;
    }
    if (ts.isIdentifier(n) && tainted.has(n.text)) {
      const p = n.parent;
      const isName = (ts.isPropertyAccessExpression(p) && p.name === n) || (ts.isPropertyAssignment(p) && p.name === n)
        || (ts.isVariableDeclaration(p) && p.name === n) || (ts.isParameter(p) && p.name === n)
        || (ts.isBindingElement(p) && p.name === n);
      if (!isName) count(state);
      return;
    }
    ts.forEachChild(n, c => walk(c, state));
  };
  walk(node, {});
  return out;
}

/** Calls that turn their argument into text and nothing else: what comes out is still the error's words. */
const TEXT_OF = new Set(['String', 'messageOf', 'stringify']);

/**
 * Is the VALUE of this expression the error's own words — `err.message`, `String(err)`, `${err}`, `a ? err.message : b`,
 * `err.message.slice(0, 200)`, a text-maker's result — and not merely something computed with the error in reach
 * (`recordFailure(err)`, `[]`)? A returned value is judged by this before its function becomes a text-maker: a function
 * that returns `swallowIndexError(err)` is not handing the text on, and calling every such function a text-maker would
 * taint every caller of it.
 */
function carriesText(expr, tainted, env) {
  const e = unwrap(expr);
  if (!e) return false;
  if (ts.isIdentifier(e)) return tainted.has(e.text);
  if (ts.isAwaitExpression(e)) return carriesText(e.expression, tainted, env);
  if (ts.isPropertyAccessExpression(e)) return !LABEL_PROPS.has(e.name.text) && carriesText(e.expression, tainted, env);
  if (ts.isTemplateExpression(e)) return e.templateSpans.some(s => carriesText(s.expression, tainted, env));
  if (ts.isBinaryExpression(e)) return carriesText(e.left, tainted, env) || carriesText(e.right, tainted, env);
  if (ts.isConditionalExpression(e)) return carriesText(e.whenTrue, tainted, env) || carriesText(e.whenFalse, tainted, env);
  if (isTextMakerCall(e, env)) return true;
  if (ts.isCallExpression(e)) {
    const c = e.expression;
    if (ts.isIdentifier(c) && TEXT_OF.has(c.text)) return e.arguments.some(a => carriesText(a, tainted, env));
    // A method of the text itself: `err.message.slice(0, 200)`, `msg.trim()`.
    if (ts.isPropertyAccessExpression(c)) return carriesText(c.expression, tainted, env);
  }
  return false;
}

/**
 * Every exit of the text of the names in `scope.bind` (and of text-maker calls) inside `scope.body`, as
 * `{ found, returns }`: `found` is `{ file, line, form, text, flagged }` — `flagged` when the text leaves unfiltered, false
 * when it leaves only through a sanitizer or only as an error that is not the driver's — and `returns` the names of the
 * functions whose `return` carries the text out unfiltered (their callers are judged in `exitsIn`).
 *
 * `strictFn`: the function a candidate sanitizer is being judged as. A `return` of the text from IT is an exit then, flagged
 * at once: a sanitizer's return is the answer.
 */
function scanScope(file, sf, scope, env, strictFn = null) {
  const found = [];
  const returns = new Set();
  const seen = new Set();
  const tainted = new Set(scope.bind);
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
  const returnOf = (n, expr) => {
    const fn = nearestFunction(n);
    if (strictFn && fn === strictFn) { record(n, 'returned text', expr); return; }
    const name = fn && functionNameOf(fn);
    if (!name) return;
    if (!carriesText(expr, tainted, env)) return;
    const r = readsIn(expr, tainted, env);
    if (r.reads > 0 && !ownNarrowed(n, scope.body, tainted, env)) returns.add(name);
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
    // a property assignment: the text written onto an object (`run.error = …`)
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken
      && (ts.isPropertyAccessExpression(n.left) || ts.isElementAccessExpression(n.left))) record(n, 'property assignment', n.right);
    // a returned text: collected for the text-makers, or an exit at once for a candidate sanitizer
    if (ts.isReturnStatement(n) && n.expression) returnOf(n, n.expression);
    // a literal: the rule about the value, after the forms above have had their say about the same node
    if (!inLog) {
      if (ts.isArrayLiteralExpression(n)) for (const el of n.elements) literalValue(el, ts.isSpreadElement(el) ? el.expression : el);
      if (ts.isPropertyAssignment(n)) literalValue(n, n.initializer);
      if (ts.isShorthandPropertyAssignment(n)) literalValue(n, n.name);
    }
    ts.forEachChild(n, c => ev(c, inLog));
  };
  ev(scope.body);
  // An arrow whose body IS the expression returns it.
  if (strictFn && scope.body === strictFn.body && !ts.isBlock(scope.body)) record(scope.body, 'returned text', scope.body);
  return { found, returns };
}

/**
 * Does this candidate sanitizer let the text of its own error parameters out unfiltered — by any exit form, or by returning
 * it? The check that makes "calls a sanitizer" mean "hands on only what the sanitizer said".
 */
function leaksItsParameters(f, env) {
  const bind = f.params.filter(p => ts.isIdentifier(p.name) && ERROR_ARG.test(p.name.text)).map(p => p.name.text);
  // A function that takes no error is not something an error is handed to: it cannot be a sanitizer of one.
  if (bind.length === 0) return true;
  const { found } = scanScope('candidate', f.sf, { bind, body: f.node.body ?? f.node, kind: 'candidate' }, env, f.node);
  return found.some(e => e.flagged);
}

/**
 * Parse every source and derive what the walk needs about the whole set: the classes the repo declares (an `instanceof`
 * one of them proves the error is ours), the functions that store a failure, the sanitizers (the named ones, and the
 * top-level functions that call one — or ask a decider — and do not leak their own error parameters), and the
 * text-makers (functions that return a caught error's text, directly or through another text-maker).
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

  // Stored-failure writers and the index of the parameter that carries the text.
  const writers = new Map();
  for (const [name, f] of functions) {
    if (!writesLastError(f.node)) continue;
    const at = f.params.findIndex(p => ts.isIdentifier(p.name) && ERROR_PARAM.test(p.name.text));
    if (at >= 0) writers.set(name, at);
  }

  const env = { files, ownClasses, sanitizers: new Set(named), deciders: new Set(deciders), textMakers: new Set(), writers, functions, derived: new Set() };

  // Derived sanitizers, to a fixpoint (a sender of a sender, a text-maker built on a text-maker). A candidate joins only
  // when it CALLS a sanitizer or a decider and nothing it does with its own error parameters leaks them; joining makes
  // more candidates pass, never fewer, so the order the functions are tried in does not change the result.
  const callsMediator = node => has(node.body ?? node, n => ts.isCallExpression(n) && ts.isIdentifier(n.expression)
    && (env.sanitizers.has(n.expression.text) || env.deciders.has(n.expression.text)));
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, f] of functions) {
      if (env.sanitizers.has(name) || env.deciders.has(name)) continue;
      if (!callsMediator(f.node) || leaksItsParameters(f, env)) continue;
      env.sanitizers.add(name);
      env.derived.add(name);
      changed = true;
    }
  }

  // Text-makers, to a fixpoint: a function whose catch (or whose body, through another text-maker) returns the text unfiltered.
  for (let changed = true; changed;) {
    changed = false;
    for (const [file, sf] of files) {
      for (const scope of [...catchScopesOf(sf), ...textMakerScopesOf(sf, env)]) {
        for (const name of scanScope(file, sf, scope, env).returns) {
          if (!env.textMakers.has(name)) { env.textMakers.add(name); changed = true; }
        }
      }
    }
  }
  for (const name of env.textMakers) { env.sanitizers.delete(name); env.derived.delete(name); }
  return env;
}

/**
 * Every exit of the error's text in a file, as `{ file, line, form, text, flagged }` — `flagged` when the text leaves
 * unfiltered, false when it leaves only through a sanitizer or only as an error that is not the driver's. The scopes are
 * the catches, and every top-level statement that calls a text-maker (the text-maker's result is the tainted value there).
 */
export function exitsIn(file, env) {
  const sf = env.files.get(file);
  const out = [];
  const keys = new Set();
  for (const scope of [...catchScopesOf(sf), ...textMakerScopesOf(sf, env)]) {
    for (const e of scanScope(file, sf, scope, env).found) {
      const key = `${e.line}|${e.form}|${e.text}`;
      if (keys.has(key)) continue;
      keys.add(key);
      out.push(e);
    }
  }
  return out;
}

/** Every exit in every source, with the derived sets that were used. */
export function analyse(sources, opts) {
  const env = readSources(sources, opts);
  const exits = [];
  for (const file of env.files.keys()) exits.push(...exitsIn(file, env));
  return { exits, env };
}
