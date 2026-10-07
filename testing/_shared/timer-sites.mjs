/**
 * Where a test waits a fixed time, or binds a server, by hand — READ OUT OF THE SYNTAX TREE, and the ONE definition of
 * "a sleep" and of "the comment that says why" for every gate that asks (`Q-375`).
 *
 * ## The questions it answers
 *
 * - {@link fixedDelays}: where is a promise that does nothing but resolve after a timer, with nobody to cancel it
 *   (`await new Promise(r => setTimeout(r, ms))`, `await setTimeout(ms)` from `node:timers/promises`, a helper that IS
 *   that promise)? Each is a place a test guessed how long something takes.
 * - {@link listenerSites}: where is a `.listen(...)` call? Each is a test server that has to be ended again, bound to the
 *   right interface, by a helper (`local-server.mjs`) or by an author who says why not.
 * - {@link awaitedSleeps}: which awaited calls are a sleep? The same question `poll-loops.mjs` asks of a loop body, so it
 *   takes its answer from {@link awaitsASleepIn} below, never from a name list of its own.
 *
 * ## What it prevents
 *
 * `a-poll-is-written-once` decided what a sleep is by its own name list and its own body rule, and the gate for the
 * fixed delay decided it a second time. Two gates reading one rule with two readers is the defect this repository
 * produces most: the weaker reader wins, and a helper written under a name neither list holds is a sleep to neither. The
 * comment above a site was read in two places for the same reason. Both are here, once.
 *
 * ## What counts, and the decisions the plan left open
 *
 * - A local sleep is a function whose WHOLE body is the delay promise (`const tick = () => new Promise(...)`), found at
 *   its definition and judged by its body, never by its name: `const delay = () => computeBackoff()` is not one.
 * - A promise RETURNED from a helper that does other things too (`log(); return new Promise(...)`) is that helper's
 *   backoff, not a stand-alone delay; an executor that does anything besides arm the timer waits for that other thing too.
 *   Neither is a {@link fixedDelays} finding. Both still WAIT, so {@link awaitedSleeps} and the poll gate count them.
 * - A timer is the global `setTimeout` or `timers/promises`' under any import spelling. A socket's own `.setTimeout` is a
 *   limit, not a delay.
 *
 * ## The markers
 *
 * `// waits-differently: <reason>` (a delay or a poll) and `// own-listener: <reason>` (a listener), in the comment block
 * directly above the statement. A reason of two words or more: a bare marker or a one-word one is the site without one.
 * A delay marker above a LOOP covers the delays in that loop's own code; a marker above a function covers nothing inside
 * it. A listener in a `new Promise(...)` executor is exempt by a marker above the statement holding the `new Promise`, or
 * above its own.
 *
 * Syntax only — no type checker. Parsing, locating a node and walking a body are `syntax-tree.mjs`'s.
 */
import { ts, parseSource, lineOf } from './syntax-tree.mjs';

/** Names that are a sleep wherever they are imported from. A same-file function is judged by its body, never by this list. */
const SLEEP_NAMES = /^(sleep|sleepMs|delay|pause|nap|snooze|wait)$/i;

/** `<tag>: <reason>` — at least two words, so the reason says something. Built fresh per use (a global regex shares state). */
const markerPattern = (tag) => new RegExp(`${tag}:[ \\t]*(\\S+[ \\t]+\\S.*)`);

const TIMERS_PROMISES = /^(node:)?timers\/promises$/;

const STATEMENTS = new Set([
  ts.SyntaxKind.VariableStatement, ts.SyntaxKind.ExpressionStatement, ts.SyntaxKind.ReturnStatement,
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement,
]);
const LOOPS = new Set([
  ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.ForStatement,
  ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.ForInStatement,
]);

const isFunctionNode = (n) => ts.isArrowFunction(n) || ts.isFunctionExpression(n)
  || ts.isFunctionDeclaration(n) || ts.isMethodDeclaration(n);
const unparenthesised = (e) => (ts.isParenthesizedExpression(e) ? unparenthesised(e.expression) : e);

// ---------------------------------------------------------------------------------------------------------------------
// the marker: the one reader of the comment block above a node
// ---------------------------------------------------------------------------------------------------------------------

/**
 * The reason a `// <tag>: <reason>` comment gives, in the comment block DIRECTLY above `node` (the last comment ends on
 * the line before the node, or on its line, with no blank line between), or null.
 *
 * The one place a gate reads the comment above a node: the poll gate (`poll-loops.mjs`) and the delay and listener
 * classifiers below all ask it, so "directly above" and "a reason of two words" mean one thing.
 *
 * @param {import('typescript').SourceFile} sf
 * @param {string} text the source `sf` was parsed from
 * @param {import('typescript').Node} node
 * @param {string} tag `waits-differently` or `own-listener`
 * @returns {string|null}
 */
export function markerReason(sf, text, node, tag) {
  const ranges = ts.getLeadingCommentRanges(text, node.getFullStart()) ?? [];
  const lineOfPos = (pos) => sf.getLineAndCharacterOfPosition(pos).line;
  const pattern = markerPattern(tag);
  let nextLine = lineOfPos(node.getStart(sf));
  for (let i = ranges.length - 1; i >= 0; i--) {
    const r = ranges[i];
    if (lineOfPos(r.end) < nextLine - 1) return null; // a blank line: this comment belongs to something above
    const found = text.slice(r.pos, r.end).match(pattern);
    if (found) return found[1].replace(/\s*\*\/\s*$/, '').trim();
    nextLine = lineOfPos(r.pos);
  }
  return null;
}

/**
 * The statement a site belongs to, and the statements above it that may carry its marker.
 *
 * Walks up from `start`, stopping at a function (its body is another function's code) except a `new Promise` executor,
 * which is part of the statement that holds it. `loopsOnly` is a delay's rule: its own statement, or a loop around it;
 * a listener's is any statement on the way up.
 */
function markerAbove(sf, text, start, tag, { loopsOnly }) {
  let own = null;
  for (let n = start; n && n !== sf; n = n.parent) {
    if (n !== start && isFunctionNode(n) && !(n.parent && ts.isNewExpression(n.parent))) return null;
    if (!STATEMENTS.has(n.kind)) continue;
    own ??= n;
    if (loopsOnly && n !== own && !LOOPS.has(n.kind)) continue;
    const reason = markerReason(sf, text, n, tag);
    if (reason) return reason;
  }
  return null;
}

// ---------------------------------------------------------------------------------------------------------------------
// timers: what arms one
// ---------------------------------------------------------------------------------------------------------------------

/** The names `node:timers/promises` is bound to in this file: `named` (`setTimeout`, under any rename) and `spaces` (`timers.setTimeout`). */
function timersPromisesBindings(sf) {
  const named = new Set();
  const spaces = new Set();
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !TIMERS_PROMISES.test(st.moduleSpecifier.text)) continue;
    const clause = st.importClause;
    if (!clause) continue;
    if (clause.name) spaces.add(clause.name.text);
    const bound = clause.namedBindings;
    if (bound && ts.isNamespaceImport(bound)) spaces.add(bound.name.text);
    if (bound && ts.isNamedImports(bound)) {
      for (const el of bound.elements) if ((el.propertyName ?? el.name).text === 'setTimeout') named.add(el.name.text);
    }
  }
  return { named, spaces };
}

/** `setTimeout(...)` or `globalThis.setTimeout(...)` — the global timer, unless this file imported another under that name. */
function armsGlobalTimer(call, bound) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return e.text === 'setTimeout' && !bound.named.has('setTimeout');
  return ts.isPropertyAccessExpression(e) && e.expression.getText() === 'globalThis' && e.name.text === 'setTimeout';
}

/** A call of `node:timers/promises`' `setTimeout`, under whatever name or member the file reaches it by. */
function callsTimersPromises(call, bound) {
  const e = call.expression;
  if (ts.isIdentifier(e)) return bound.named.has(e.text);
  return ts.isPropertyAccessExpression(e) && ts.isIdentifier(e.expression)
    && bound.spaces.has(e.expression.text) && e.name.text === 'setTimeout';
}

/** Does anything in `node` arm a timer — the global one or `timers/promises`', never a socket's `.setTimeout`? */
function armsATimer(node, bound) {
  let hit = false;
  const visit = (n) => {
    if (hit) return;
    if (ts.isCallExpression(n) && (armsGlobalTimer(n, bound) || callsTimersPromises(n, bound))) { hit = true; return; }
    ts.forEachChild(n, visit);
  };
  visit(node);
  return hit;
}

/** `new Promise(r => setTimeout(r, ms))` and nothing else: the executor arms the one timer, which resolves the promise. */
function isDelayPromise(n, bound) {
  if (!n || !ts.isNewExpression(n) || n.expression.getText() !== 'Promise' || n.arguments?.length !== 1) return false;
  const executor = n.arguments[0];
  if (!(ts.isArrowFunction(executor) || ts.isFunctionExpression(executor))
    || executor.parameters.length < 1 || !ts.isIdentifier(executor.parameters[0].name)) return false;
  const resolve = executor.parameters[0].name.text;
  let call;
  if (ts.isBlock(executor.body)) {
    const [only] = executor.body.statements;
    if (executor.body.statements.length !== 1 || !ts.isExpressionStatement(only)) return false;
    call = unparenthesised(only.expression);
  } else {
    call = unparenthesised(executor.body);
  }
  if (!ts.isCallExpression(call) || !armsGlobalTimer(call, bound) || call.arguments.length < 2) return false;
  const callback = call.arguments[0];
  if (ts.isIdentifier(callback)) return callback.text === resolve;
  if ((ts.isArrowFunction(callback) || ts.isFunctionExpression(callback)) && callback.parameters.length === 0 && !ts.isBlock(callback.body)) {
    const inner = unparenthesised(callback.body);
    return ts.isCallExpression(inner) && inner.arguments.length === 0 && inner.expression.getText() === resolve;
  }
  return false;
}

/** The delay promise a function IS (its expression body, or the single `return` of its block body), or null. */
function soleDelayPromise(fn, bound) {
  const body = fn.body;
  if (!body) return null;
  if (!ts.isBlock(body)) return isDelayPromise(unparenthesised(body), bound) ? unparenthesised(body) : null;
  if (body.statements.length !== 1) return null;
  const [only] = body.statements;
  if (ts.isReturnStatement(only) && only.expression && isDelayPromise(unparenthesised(only.expression), bound)) return unparenthesised(only.expression);
  return null;
}

/** The functions this file defines by name (a declaration, or a variable holding an arrow or function expression). */
function localFunctions(sf) {
  const found = new Map();
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n) && n.name && n.body) found.set(n.name.text, n);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) found.set(n.name.text, n.initializer);
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return found;
}

// ---------------------------------------------------------------------------------------------------------------------
// the one definition of "an awaited call is a sleep"
// ---------------------------------------------------------------------------------------------------------------------

/**
 * A predicate over one source file: does this operand of an `await` wait on a timer?
 *
 * Built once per file. An operand sleeps when it holds a call that is a sleep, or a `new Promise` whose executor arms a
 * timer. A call is a sleep by what it IS, in this order: a function of this file is judged by its body (it arms a
 * timer); `node:timers/promises`' `setTimeout` under any import spelling is one; any other callee is judged by its
 * name (`SLEEP_NAMES`), because an imported helper's body is another file's.
 *
 * It answers "does this wait", not "is this a stand-alone delay" — a backoff helper and a race against a timeout wait
 * too. That is the poll gate's question about a loop body and this module's about an `await`, one rule for both.
 *
 * @param {import('typescript').SourceFile} sf
 * @returns {(operand: import('typescript').Node) => boolean}
 */
export function awaitsASleepIn(sf) {
  const bound = timersPromisesBindings(sf);
  const locals = localFunctions(sf);
  const isSleepCall = (call) => {
    const e = call.expression;
    if (ts.isIdentifier(e) && locals.has(e.text)) return armsATimer(locals.get(e.text).body, bound);
    if (callsTimersPromises(call, bound)) return true;
    const name = ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    return name !== null && SLEEP_NAMES.test(name);
  };
  return (operand) => {
    let hit = false;
    const visit = (n) => {
      if (hit) return;
      if (ts.isCallExpression(n) && isSleepCall(n)) { hit = true; return; }
      // `new Promise(r => setTimeout(r, n))` — the executor is a nested function, entered on purpose.
      if (ts.isNewExpression(n) && n.expression.getText() === 'Promise' && armsATimer(n, bound)) { hit = true; return; }
      ts.forEachChild(n, visit);
    };
    visit(operand);
    return hit;
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// the three questions
// ---------------------------------------------------------------------------------------------------------------------

const finding = (sf, file, site, kind, reason) => ({
  file, line: lineOf(sf, site), kind, reason, text: site.getText(sf).split(/\r?\n/)[0].slice(0, 100),
});

/**
 * Every stand-alone fixed delay in one source text, in line order.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {Array<{ file: string, line: number, kind: string, reason: string|null, text: string }>}
 *   `reason` is the `waits-differently` marker's reason, else null — the caller decides what an exempt site is.
 */
export function fixedDelays(text, file = 'snippet.js') {
  const sf = parseSource(file, text);
  const bound = timersPromisesBindings(sf);
  const out = [];
  const visit = (n) => {
    if (ts.isAwaitExpression(n)) {
      const operand = unparenthesised(n.expression);
      const kind = isDelayPromise(operand, bound) ? 'inline-delay'
        : ts.isCallExpression(operand) && callsTimersPromises(operand, bound) ? 'timers-promises-delay' : null;
      if (kind) out.push(finding(sf, file, operand, kind, markerAbove(sf, text, n, 'waits-differently', { loopsOnly: true })));
    }
    if (isFunctionNode(n)) {
      const promise = soleDelayPromise(n, bound);
      if (promise) {
        // The function IS the delay, so its own definition is the statement the marker sits above.
        const reason = markerReason(sf, text, n, 'waits-differently') ?? markerAbove(sf, text, n, 'waits-differently', { loopsOnly: true });
        out.push(finding(sf, file, promise, 'local-sleep', reason));
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out.sort((a, b) => a.line - b.line);
}

/**
 * Every `.listen(...)` call in one source text: a server this file starts itself.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {Array<{ file: string, line: number, kind: string, reason: string|null, text: string }>}
 *   `reason` is the `own-listener` marker's reason, else null.
 */
export function listenerSites(text, file = 'snippet.js') {
  const sf = parseSource(file, text);
  const out = [];
  const visit = (n) => {
    if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'listen') {
      out.push(finding(sf, file, n, 'listen', markerAbove(sf, text, n, 'own-listener', { loopsOnly: false })));
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/**
 * Every awaited call in one source text that waits on a timer (see {@link awaitsASleepIn}).
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {Array<{ file: string, line: number, name: string|null }>}
 */
export function awaitedSleeps(text, file = 'snippet.js') {
  const sf = parseSource(file, text);
  const sleeps = awaitsASleepIn(sf);
  const out = [];
  const visit = (n) => {
    if (ts.isAwaitExpression(n)) {
      const operand = unparenthesised(n.expression);
      if (sleeps(operand)) {
        const e = ts.isCallExpression(operand) ? operand.expression : null;
        const name = e && ts.isIdentifier(e) ? e.text : e && ts.isPropertyAccessExpression(e) ? e.name.text : null;
        out.push({ file, line: lineOf(sf, n), name });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
