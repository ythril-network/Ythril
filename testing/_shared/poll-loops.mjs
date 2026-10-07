/**
 * Where a test or helper polls for a condition by hand — READ OUT OF THE SYNTAX TREE, not grepped.
 *
 * ## Why this exists (`Q-319`)
 *
 * A wait written by hand is a deadline, a sleep and a condition, and every copy decides the three again: how the
 * deadline is read, what is said when it passes, whether a thrown probe ends the wait, whether a probe that never
 * returns can outlast the deadline. About thirty loops did, in four dialects, and `testing/_shared/wait-for.mjs`
 * is the one place those decisions are made. A gate that finds a hand-written copy is how a thirty-first never
 * appears.
 *
 * ## The shape it looks for
 *
 * A `while`, `do` or `for` (including `for (;;)`) loop that has ALL of
 *
 * 1. **a deadline exit** — the loop's own condition, or an `if` in its body that leaves the loop (`break`,
 *    `return`, `throw`), reads the clock (`Date.now()`, `performance.now()`, `process.hrtime`, `new Date()`
 *    arithmetic), directly or through a name assigned from one (`const now = Date.now()`);
 * 2. **an awaited sleep** in its body — what a sleep IS is decided once, by `timer-sites.mjs` (`awaitsASleepIn`): a
 *    call named like one, `timers/promises`' `setTimeout` under any import spelling, a `new Promise` that arms a
 *    timer, or a function of the same file whose body arms one — nested functions excluded: a sleep inside a
 *    callback is not this loop's sleep;
 * 3. **a condition it tests** — an operand of the loop condition that is not the clock, an `if` in the body that
 *    does not read the clock, or a `try` whose body leaves the loop on success (retry until it stops throwing).
 *
 * Without the third it is a delay, not a wait (`while (Date.now() < end) await sleep(10)`); without the first it
 * is something the clock does not bound (a work queue); without the second it does not yield.
 *
 * **What it deliberately does not see, so nobody reads it as more:** a loop bounded by an attempt COUNT
 * (`for (let i = 0; i < 30; i++)`) and a recursive poll (`setTimeout(poll, …)`). Neither reads a deadline from the
 * clock; the question this module answers is the one the plan names.
 *
 * ## The marker
 *
 * A loop that asks a different question stays, with `// waits-differently: <reason>` in the comment block
 * directly above it. The reason has to say something: a bare marker or a one-word one does not exempt the loop,
 * because a marker that carries no reason is the loop without one. The comment is read by `timer-sites.mjs`'
 * `markerReason`, the same reader the fixed-delay and listener gates use: "directly above" and "a reason" mean one thing.
 *
 * Syntax only — no type checker. Parsing, locating a node and walking a body without entering a nested function are
 * `syntax-tree.mjs`'s; what a POLL is stays here.
 */
import { ts, parseSource, lineOf, walkOwnCode } from './syntax-tree.mjs';
import { awaitsASleepIn, markerReason } from './timer-sites.mjs';

const LOOP_KINDS = new Set([ts.SyntaxKind.WhileStatement, ts.SyntaxKind.DoStatement, ts.SyntaxKind.ForStatement]);

/** Does this expression read the clock anywhere in it (not through a nested function)? */
function readsClock(node) {
  let found = false;
  walkOwnCode(node, (n) => { if (readsClockHere(n)) found = true; });
  return found;
}

/**
 * Is this expression ITSELF a time — the clock, or arithmetic over it (`Date.now() + t`, `Math.max(Date.now(), x)`)?
 *
 * Narrower than {@link readsClock} on purpose, and for names only: `const probe = await post(url, { id: `x-${Date.now()}` })`
 * READS the clock and is not a time, and a name taken for one made the `if (probe.status === 201) break` after it
 * look like a deadline.
 */
function isTime(e) {
  if (ts.isParenthesizedExpression(e) || ts.isAsExpression(e) || ts.isNonNullExpression(e)) return isTime(e.expression);
  if (ts.isBinaryExpression(e)) return isTime(e.left) || isTime(e.right);
  if (ts.isPrefixUnaryExpression(e)) return isTime(e.operand);
  if (ts.isConditionalExpression(e)) return isTime(e.whenTrue) || isTime(e.whenFalse);
  if (ts.isCallExpression(e) && /^(Math\.\w+|Number|BigInt)$/.test(e.expression.getText())) return e.arguments.some(isTime);
  return readsClockHere(e);
}

/** Is this node exactly a clock read (not something merely containing one)? */
function readsClockHere(n) {
  if (ts.isCallExpression(n)) {
    const e = n.expression;
    if (/^(globalThis\.)?(Date\.now|performance\.now)$/.test(e.getText())) return true;
    if (/^process\.hrtime(\.bigint)?$/.test(e.getText())) return true;
    if (ts.isPropertyAccessExpression(e) && e.name.text === 'getTime' && ts.isNewExpression(e.expression)
      && e.expression.expression.getText() === 'Date') return true;
  }
  return ts.isNewExpression(n) && n.expression.getText() === 'Date' && (n.arguments ?? []).length === 0;
}

/** Names assigned from a time, anywhere in the file (`const now = Date.now()`, `const deadline = Date.now() + ms`). */
function clockNames(sf) {
  const names = new Set();
  const visit = (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer && isTime(n.initializer)) names.add(n.name.text);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left) && isTime(n.right)) {
      names.add(n.left.text);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** Does the loop's own body (not a nested function) await a sleep? `sleeps` is `timer-sites.mjs`' answer: the one definition. */
function awaitsSleep(loop, sleeps) {
  let found = false;
  const visit = (n) => {
    if (ts.isAwaitExpression(n) && sleeps(n.expression)) found = true;
  };
  const body = ts.isForStatement(loop) || ts.isWhileStatement(loop) || ts.isDoStatement(loop) ? loop.statement : loop;
  walkOwnCode(body, visit);
  return found;
}

const isConstant = (e) => e.kind === ts.SyntaxKind.TrueKeyword || ts.isNumericLiteral(e) || ts.isStringLiteralLike(e);

/** The operands of a condition, split at `&&`, `||`, `!` and parentheses. */
function leaves(expr) {
  const out = [];
  const go = (e) => {
    if (ts.isParenthesizedExpression(e)) return go(e.expression);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) return go(e.operand);
    if (ts.isBinaryExpression(e) && (e.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken
      || e.operatorToken.kind === ts.SyntaxKind.BarBarToken)) { go(e.left); go(e.right); return; }
    out.push(e);
  };
  go(expr);
  return out;
}

/** `assert.fail(...)` — a throw spelled as a call. */
const isAssertFail = (n) => ts.isCallExpression(n) && /^assert(\.strict)?\.fail$/.test(n.expression.getText());

/** Does this statement leave the loop it sits in — `break`, `return`, `throw` or `assert.fail`, not inside a nested function? */
function leaves_(stmt) {
  let hit = false;
  const v = (n) => {
    if (ts.isBreakStatement(n) || ts.isReturnStatement(n) || ts.isThrowStatement(n) || isAssertFail(n)) hit = true;
  };
  walkOwnCode(stmt, v);
  return hit;
}

/**
 * Classify one loop: does it exit on the clock, and does it test a condition?
 * @returns {{ deadline: boolean, condition: boolean }}
 */
function classify(loop, clocked) {
  const timeish = (e) => readsClock(e) || usesName(e, clocked);
  let deadline = false;
  let condition = false;

  const cond = ts.isForStatement(loop) ? loop.condition : loop.expression;
  if (cond) {
    if (timeish(cond)) deadline = true;
    if (leaves(cond).some((l) => !timeish(l) && !isConstant(l))) condition = true;
  }

  const body = loop.statement;
  const visit = (n) => {
    if (ts.isIfStatement(n)) {
      if (timeish(n.expression)) {
        if (leaves_(n.thenStatement) || (n.elseStatement && leaves_(n.elseStatement))) deadline = true;
      } else if (!isConstant(n.expression)) {
        condition = true;
      }
    }
    // `assert.ok(Date.now() < deadline, 'never …')` — the deadline as an assertion rather than an `if`
    if (ts.isCallExpression(n) && /^assert(\.strict)?(\.ok)?$/.test(n.expression.getText())
      && n.arguments.length > 0 && timeish(n.arguments[0])) deadline = true;
    // retry-until-it-stops-throwing: the probe is the condition
    if (ts.isTryStatement(n) && leaves_(n.tryBlock)) condition = true;
  };
  walkOwnCode(body, visit);
  return { deadline, condition };
}

function usesName(expr, names) {
  let hit = false;
  const v = (n) => { if (ts.isIdentifier(n) && names.has(n.text)) hit = true; };
  walkOwnCode(expr, v);
  return hit;
}

/**
 * Every hand-written poll in one source text.
 *
 * @param {string} text
 * @param {string} [file]
 * @returns {Array<{ file: string, line: number, kind: string, reason: string|null, text: string }>}
 *   `reason` is the marker's reason when the loop carries one, else null — the caller decides what an exempt loop is.
 */
export function pollLoops(text, file = 'snippet.js') {
  const sf = parseSource(file, text);
  const clocked = clockNames(sf);
  const sleeps = awaitsASleepIn(sf);
  const out = [];
  const visit = (n) => {
    if (LOOP_KINDS.has(n.kind) && awaitsSleep(n, sleeps)) {
      const { deadline, condition } = classify(n, clocked);
      if (deadline && condition) {
        out.push({
          file,
          line: lineOf(sf, n),
          kind: ts.SyntaxKind[n.kind],
          reason: markerReason(sf, text, n, 'waits-differently'),
          text: n.getText(sf).split(/\r?\n/)[0].slice(0, 100),
        });
      }
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}
