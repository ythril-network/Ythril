/**
 * Preflight runs NO database test file, in either mode, and `npm run preflight -- --static` is never mistaken for the push pass (Q-588).
 *
 * Two rules, one file, because they read the same text the same way:
 *
 * 1. **The run plan holds no database batch, whatever the flag.** Local preflight runs the pure standalone files only; the
 *    database files (`kind: 'db'` in `offlineRuns`) are CI's Full run, and a report (`scripts/trade.mjs`) measures what that
 *    costs and saves. The probe of the test database is gone with them: nothing local asks whether a stack is up.
 * 2. **`--static` leaves out the client unit suite, the production build and the bundle budgets, and is never the push pass.**
 *    Its verdict says "not a push pass" (the words `~/.claude/hooks/preflight-mark.js` refuses to record on exit 0); the full
 *    run's verdict says "Preflight PASSED" and never "not a push pass".
 *
 * ## The failure this prevents
 *
 * - **A database batch comes back.** The filter on `offlineRuns` is written as `!STATIC || r.kind === 'pure'` again, a second
 *   loop is added, or a probe returns "to report what could not run": the owner's decision (2026-10-22) is that the local run
 *   is pure only, and a plan that runs a database batch on a machine with no database reports suites that stood down as green.
 * - **It runs a suite after all.** A new step lands inside the static path and the "minute" becomes five.
 * - **It skips a gate.** The flag is written as an `if` around "the slow part", a step is added below it later, and the
 *   static run quietly leaves out one of the checks it exists to run.
 * - **It says PASSED.** `~/.claude/hooks/preflight-mark.js` records a pass on exit 0 and refuses one whose output says
 *   "not a push pass", which is what the static verdict says; a static run that prints
 *   `Preflight PASSED` is a push pass nobody earned. An unknown argument (`--statc`) that falls through to the FULL run is
 *   the mirror image: the person asked for a minute and got three, or asked for a subset and the mark records a full one.
 *
 * ## What it reads, and how
 *
 * `scripts/preflight.mjs` as TEXT: parsed, never run (running it runs the suites). Comments are not nodes of the tree, so a
 * sentence that names `Preflight PASSED` or the client command in prose counts for nothing. The rule is asserted over the
 * tree, not over a spelling of it:
 *
 * - the flag is whatever expression reads `'--static'` from the command line, and every guard is evaluated twice, once with
 *   the flag set and once without (`reachable`), so `if (!STATIC)`, `STATIC ? a : b`, `!STATIC && x()` and an inline
 *   `process.argv.includes('--static')` are all the same rule;
 * - a REGION is found by the call it makes (the client unit-test command, `build:prod`, the `client/angular.json` read, the
 *   TCP probe of the test database, a `--test` batch), never by a line number or a variable name. Each of the three static-skipped
 *   regions must be reachable in the full run and unreachable under `--static`; the probe region must not exist at all; the batch
 *   call is shared by every plan entry and must therefore sit in a loop whose list selects only kind `pure`, from a test the flag
 *   does not enter (`.filter(r => r.kind === 'pure')`, or an `if` in the loop body that leaves the iteration for a `db` run);
 * - every OTHER step call (`run`, `execSync`, `execFileSync`, `gate`) must be reachable under `--static`, so a step added
 *   later is static unless a guard says it is a suite.
 *
 * Seen red by the RULE, and by mutation: `analyse()` is run over the real file with the flag neutralised, with an unguarded
 * copy of a region's call inserted, with a probe put back, with the kind filter taken out (a db run put back into the plan) and
 * with the old `!STATIC ||` guard put back in front of it; each must name the region. The mutations are in memory and the file is
 * never written.
 *
 * Not edited by this gate's author, and not read by it: the five other readers of preflight's text
 * (`preflight-coverage`, `ci-workflow-is-sound`, `a-client-report-is-masked-before-upload`,
 * `a-test-child-environment-is-one-module`, `ci-workflow-fixture`). A flag that leaves the text in place keeps them green.
 *
 * Run: node --test testing/standalone/a-preflight-runs-no-database-batch-and-static-is-never-a-push-pass.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { scratchRoot as scratchRootOf } from '../../scripts/_shared/scratch-root.mjs';

/** The project's scratch root, made to exist (it is outside the checkout, and a fresh machine may not have it yet). */
const scratchRoot = () => { const d = scratchRootOf(); mkdirSync(d, { recursive: true }); return d; };
import { REPO_ROOT } from './_sources.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';
import { stripComments } from './_strip-comments.mjs';
import { TIMING_SCOPES } from '../_shared/timing-reporter.mjs';
import { timingReporterFlags } from '../_shared/timing-reporter-flags.mjs';

const STATIC_FLAG = '--static';
const PREFLIGHT_FILE = 'scripts/preflight.mjs';
const REAL = readFileSync(join(REPO_ROOT, PREFLIGHT_FILE), 'utf8');

/** How many step calls (`run`, `execSync`, `execFileSync`, `gate`) outside the skipped regions the file must be found to hold. */
const STEP_FLOOR = 8;
/** The steps the plan names as static, found by the command text of the call that makes them. A floor on WHICH, beside the derived rule. */
const NAMED_STATIC_STEPS = ['build:server', 'unrun-tests', 'surface-matrix-audit', 'lint:docs', 'todo:check', 'check-changelog', 'typecheck:client', 'git ls-files'];

// ───────────────────────────────────────────────────── reading the tree ─────────────────────────────────────────────────────

const visit = (node, fn) => { fn(node); ts.forEachChild(node, (c) => visit(c, fn)); };
const unwrap = (e) => { let n = e; while (ts.isParenthesizedExpression(n)) n = n.expression; return n; };
const isString = (n) => ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n);
const calleeName = (call) => {
  const c = call.expression;
  if (ts.isIdentifier(c)) return c.text;
  if (ts.isPropertyAccessExpression(c)) return c.name.text;
  return '';
};
const calleeText = (call) => call.expression.getText();

/** Every string piece written anywhere inside `node` (literals, template heads, middles and tails). */
function stringsIn(node) {
  const out = [];
  visit(node, (n) => {
    if (isString(n) || ts.isTemplateHead(n) || ts.isTemplateMiddle(n) || ts.isTemplateTail(n)) out.push(n.text);
  });
  return out;
}

const insideFunction = (node) => {
  for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return true;
  return false;
};

const EQ = [ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken];
const NE = [ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsToken];

/** An expression that tests the command line for the flag: `argv.includes('--static')`, `args.has(...)`, `x === '--static'`. */
function isFlagTest(e) {
  if (ts.isCallExpression(e) && ['includes', 'has'].includes(calleeName(e))) {
    const a = e.arguments[0];
    return Boolean(a) && isString(a) && a.text === STATIC_FLAG;
  }
  // `args.some(a => a === '--static')` is the flag; `args.some(a => a !== '--static')` is its opposite, an unknown-argument test.
  if (ts.isCallExpression(e) && calleeName(e) === 'some') {
    const fn = e.arguments[0];
    const body = fn && ts.isArrowFunction(fn) ? unwrap(fn.body) : null;
    return Boolean(body) && ts.isBinaryExpression(body) && EQ.includes(body.operatorToken.kind)
      && [body.left, body.right].filter(isString).some(x => x.text === STATIC_FLAG);
  }
  if (ts.isBinaryExpression(e) && [...EQ, ...NE].includes(e.operatorToken.kind)) {
    return [e.left, e.right].filter(isString).some(s => s.text === STATIC_FLAG);
  }
  return false;
}

/**
 * What `expr` is when the flag is `s` (true / false): `true`, `false`, or `undefined` when it depends on something else.
 * The one evaluator behind every guard, so `!STATIC`, `STATIC && x`, `STATIC ? a : b` and `!process.argv.includes('--static')` agree.
 */
function evalCond(expr, s, S) {
  const e = unwrap(expr);
  if (ts.isIdentifier(e)) return S.has(e.text) ? s : undefined;
  if (e.kind === ts.SyntaxKind.TrueKeyword) return true;
  if (e.kind === ts.SyntaxKind.FalseKeyword) return false;
  if (isFlagTest(e)) return ts.isBinaryExpression(e) && NE.includes(e.operatorToken.kind) ? !s : s;
  if (ts.isPropertyAccessExpression(e) && e.name.text === 'static') return s;
  if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.ExclamationToken) {
    const v = evalCond(e.operand, s, S);
    return v === undefined ? undefined : !v;
  }
  if (ts.isBinaryExpression(e)) {
    const k = e.operatorToken.kind;
    if (k === ts.SyntaxKind.AmpersandAmpersandToken) {
      const l = evalCond(e.left, s, S); const r = evalCond(e.right, s, S);
      if (l === false || r === false) return false;
      return l === true && r === true ? true : undefined;
    }
    if (k === ts.SyntaxKind.BarBarToken) {
      const l = evalCond(e.left, s, S); const r = evalCond(e.right, s, S);
      if (l === true || r === true) return true;
      return l === false && r === false ? false : undefined;
    }
    const eq = EQ.includes(k);
    const ne = NE.includes(k);
    if (eq || ne) {
      for (const [a, b] of [[e.left, e.right], [e.right, e.left]]) {
        const lit = unwrap(b);
        if (lit.kind !== ts.SyntaxKind.TrueKeyword && lit.kind !== ts.SyntaxKind.FalseKeyword) continue;
        const v = evalCond(a, s, S);
        if (v === undefined) return undefined;
        const same = v === (lit.kind === ts.SyntaxKind.TrueKeyword);
        return eq ? same : !same;
      }
    }
  }
  return undefined;
}

const turnsWith = (expr, S) => {
  const a = evalCond(expr, true, S); const b = evalCond(expr, false, S);
  return a !== undefined && b !== undefined && a !== b;
};

/** Does `expr` read the flag at all (any sub-expression whose value turns with it)? */
function readsFlag(expr, S) {
  let hit = false;
  visit(expr, (n) => { if (!hit && ts.isExpression(n) && turnsWith(n, S)) hit = true; });
  return hit;
}

/** Everything the file says about each named variable: declarations and plain assignments. */
function bindingsOf(sf) {
  const decls = new Map();
  const add = (name, expr) => decls.set(name, [...(decls.get(name) ?? []), expr]);
  visit(sf, (n) => {
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer) add(n.name.text, n.initializer);
    if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) add(n.left.text, n.right);
  });
  return decls;
}

/** The names that stand for the flag: a variable whose value is the flag, or is built from it by `!`, `&&`, `||` or `=== true`. */
function flagNames(decls) {
  const S = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, exprs] of decls) {
      if (S.has(name)) continue;
      if (exprs.some(x => turnsWith(x, S))) { S.add(name); changed = true; }
    }
  }
  return S;
}

/**
 * Is `node` run when the flag is `s`? Every enclosing `if`, `?:`, `&&` and `||` that the flag decides is asked; a function
 * boundary ends the question (what calls the function is not this walk's to follow).
 */
function reachable(node, s, S) {
  let child = node;
  for (let p = node.parent; p; child = p, p = p.parent) {
    // A declaration is called from somewhere this walk does not follow; an inline callback (`new Promise(r => { ... })`) runs where it is written.
    if (ts.isFunctionDeclaration(p) || ts.isMethodDeclaration(p)) return true;
    if (ts.isIfStatement(p)) {
      const v = evalCond(p.expression, s, S);
      if (child === p.thenStatement && v === false) return false;
      if (child === p.elseStatement && v === true) return false;
    } else if (ts.isConditionalExpression(p)) {
      const v = evalCond(p.condition, s, S);
      if (child === p.whenTrue && v === false) return false;
      if (child === p.whenFalse && v === true) return false;
    } else if (ts.isBinaryExpression(p) && child === p.right) {
      const l = evalCond(p.left, s, S);
      if (p.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken && l === false) return false;
      if (p.operatorToken.kind === ts.SyntaxKind.BarBarToken && l === true) return false;
    }
  }
  return true;
}

/** The strings an expression can print when the flag is `s`; `${}` stands for a part nobody can know from the text. */
function textsOf(expr, s, S) {
  const e = unwrap(expr);
  if (isString(e)) return [e.text];
  if (ts.isTemplateExpression(e)) {
    return [e.head.text + e.templateSpans.map(sp => '${}' + sp.literal.text).join('')];
  }
  if (ts.isConditionalExpression(e)) {
    const v = evalCond(e.condition, s, S);
    if (v === true) return textsOf(e.whenTrue, s, S);
    if (v === false) return textsOf(e.whenFalse, s, S);
    return [...textsOf(e.whenTrue, s, S), ...textsOf(e.whenFalse, s, S)];
  }
  if (ts.isBinaryExpression(e) && e.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const out = [];
    for (const l of textsOf(e.left, s, S)) for (const r of textsOf(e.right, s, S)) out.push(l + r);
    return out;
  }
  return ['${}'];
}

// ──────────────────────────────────────────── the regions, found by the call they make ───────────────────────────────────────────

const isRunner = (n) => ts.isCallExpression(n) && ['run', 'execSync', 'execFileSync', 'spawnSync', 'spawn', 'gate'].includes(calleeName(n));

/** Region keys and what finds each: a predicate over a node, never a line number or a variable name. */
const REGIONS = {
  // A call that RUNS the command, not one that merely names it (`failures.push({ name: 'build:prod' })` is a mention).
  'client-suite': (n) => isRunner(n) && stringsIn(n).some(s => /^npm run test(:client)?\b/.test(s) && /client/.test(s)),
  'client-build': (n) => isRunner(n) && stringsIn(n).some(s => /build:prod/.test(s)),
  'bundle-budgets': (n) => ts.isCallExpression(n) && ['readFileSync', 'readFile'].includes(calleeName(n)) && stringsIn(n).some(s => /angular\.json/.test(s)),
  'database-probe': (n) => (ts.isNewExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === 'Socket')
    || (ts.isCallExpression(n) && ['createConnection', 'connect'].includes(calleeName(n)) && /\bnet\b|socket/i.test(calleeText(n))),
  'database-batch': (n) => ts.isCallExpression(n) && ['execFileSync', 'spawnSync', 'spawn'].includes(calleeName(n))
    && n.arguments.some(a => ts.isArrayLiteralExpression(a) && a.elements.some(el => isString(el) && el.text === '--test')
      && a.elements.some(el => ts.isSpreadElement(el))),
};
/** The three things `--static` leaves out: the client suite, the production build and the bundle budgets. */
const SKIPPED_UNDER_STATIC = ['client-suite', 'client-build', 'bundle-budgets'];
/** Regions that must not exist at all: the probe of the test database went with the database batches (Q-588). */
const GONE = ['database-probe'];

const STEP_CALLEES = ['run', 'execSync', 'execFileSync', 'gate'];

function regionNodes(sf) {
  const out = Object.fromEntries(Object.keys(REGIONS).map(k => [k, []]));
  visit(sf, (n) => { for (const [k, pred] of Object.entries(REGIONS)) if (pred(n)) out[k].push(n); });
  return out;
}

/** Calls that are a step of the run and belong to no skipped region: what must still run under `--static`. */
function otherSteps(sf, regions) {
  const inRegion = (n) => Object.values(regions).flat().some(r => r === n || (r.pos <= n.pos && n.end <= r.end));
  const steps = [];
  visit(sf, (n) => {
    if (ts.isCallExpression(n) && STEP_CALLEES.includes(calleeName(n)) && !insideFunction(n) && !inRegion(n)) steps.push(n);
  });
  return steps;
}

const isLoop = (p) => ts.isForOfStatement(p) || ts.isForInStatement(p) || ts.isForStatement(p);

/** The expressions a loop around `node` iterates: its own and what each identifier in it was set to. */
function loopIterables(node, decls) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p)) return [];
    if (ts.isForOfStatement(p) || ts.isForInStatement(p)) {
      const exprs = [p.expression];
      visit(p.expression, (n) => { if (ts.isIdentifier(n) && decls.has(n.text)) exprs.push(...decls.get(n.text)); });
      return exprs;
    }
  }
  return [];
}

/** `x.kind === 'pure'` / `x.kind !== 'db'` (what a plan keeps) and `x.kind === 'db'` / `x.kind !== 'pure'` (what it drops): a bare comparison, nothing else in it. */
const kindComparison = (e0) => {
  const e = unwrap(e0);
  if (!ts.isBinaryExpression(e)) return null;
  const eq = EQ.includes(e.operatorToken.kind);
  if (!eq && !NE.includes(e.operatorToken.kind)) return null;
  const sides = [e.left, e.right].map(unwrap);
  const lit = sides.find(isString);
  if (!lit || !sides.some(x => !isString(x)) || !['pure', 'db'].includes(lit.text)) return null;
  return { keepsPure: (lit.text === 'pure') === eq, node: e };
};

/** The expression a `.filter(...)` callback returns (an arrow's body, or the one `return` of a block); null when `call` is not a filter. */
function filterPredicate(call) {
  if (!ts.isCallExpression(call) || calleeName(call) !== 'filter') return null;
  const fn = call.arguments[0];
  if (!fn || !(ts.isArrowFunction(fn) || ts.isFunctionExpression(fn))) return null;
  if (!ts.isBlock(fn.body)) return fn.body;
  return fn.body.statements.find(ts.isReturnStatement)?.expression ?? null;
}

/** Every `.filter(r => r.kind === 'pure')` in the list a loop around `node` iterates: the predicate is that comparison and nothing else, so the flag is not in it. */
function pureFilters(node, decls) {
  const out = [];
  for (const x of loopIterables(node, decls)) {
    visit(x, (n) => { const p = filterPredicate(n); if (p && kindComparison(p)?.keepsPure) out.push({ call: n, predicate: p }); });
  }
  return out;
}

/** The loop's own `if (r.kind === 'db') continue;` (or `!== 'pure'`): an `if` that is that bare comparison, leaves the iteration, and sits under no flag test inside the loop. */
function dbSkips(node, S) {
  const out = [];
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (!isLoop(p)) continue;
    visit(p.statement, (n) => {
      if (!ts.isIfStatement(n)) return;
      const c = kindComparison(n.expression);
      if (!c || c.keepsPure) return;
      let leaves = false;
      visit(n.thenStatement, (m) => { if (ts.isContinueStatement(m) || ts.isBreakStatement(m) || ts.isReturnStatement(m)) leaves = true; });
      let guarded = false;
      for (let a = n.parent; a && a !== p; a = a.parent) if (ts.isIfStatement(a) && readsFlag(a.expression, S)) guarded = true;
      if (leaves && !guarded) out.push(n);
    });
    break;
  }
  return out;
}

/**
 * Does the plan this `--test` batch runs hold only kind `pure`, whatever the flag? Two shapes, both stated by what they contain: the
 * list the loop iterates is filtered by a bare `kind === 'pure'` comparison, or the loop's own body leaves the iteration for a `db`
 * run. Neither may read the flag: a plan that selects by kind only under `--static` is the old plan, and runs the database half in
 * the full mode.
 */
function planHoldsOnlyPure(node, decls, S) {
  return pureFilters(node, decls).length > 0 || dbSkips(node, S).length > 0;
}

// ─────────────────────────────────────────────────── the rule, as violations ─────────────────────────────────────────────────────

const lineOf = (sf, n) => sf.getLineAndCharacterOfPosition(n.getStart(sf)).line + 1;

/** A cheap content key so two different sources never share a cached parse (`parseSource` caches by file name). */
function hashOf(text) {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) | 0;
  return h;
}
const parsed = (src, tag = 'src') => parseSource(`${PREFLIGHT_FILE}#${tag}#${hashOf(src)}`, src);

/**
 * Every way `src` breaks the static-preflight rule, each as `{ region, message }`. Empty means the rule holds. Nothing here
 * throws on a file that has no flag: it reports `flag` and goes on, so a mutation that removes the flag still names every region.
 */
function analyse(src, { floor = STEP_FLOOR } = {}) {
  const sf = parsed(src);
  const decls = bindingsOf(sf);
  const S = flagNames(decls);
  const v = [];
  const say = (region, message) => v.push({ region, message });

  // The flag is read from the command line, and an argument that is not it is refused.
  let turns = S.size > 0;
  visit(sf, (n) => { if (ts.isExpression(n) && isFlagTest(n)) turns = true; });
  if (!stringsIn(sf).includes(STATIC_FLAG)) say('flag', `${PREFLIGHT_FILE} never reads '${STATIC_FLAG}' from the command line`);
  else if (!turns) say('flag', `'${STATIC_FLAG}' is spelled in ${PREFLIGHT_FILE} but no expression turns with it`);

  const argvNames = new Set();
  const fromArgv = (x) => {
    let hit = false;
    visit(x, (n) => {
      if (ts.isPropertyAccessExpression(n) && n.getText() === 'process.argv') hit = true;
      if (ts.isIdentifier(n) && argvNames.has(n.text)) hit = true;
    });
    return hit;
  };
  for (let changed = true; changed;) {
    changed = false;
    for (const [name, exprs] of decls) {
      if (!argvNames.has(name) && exprs.some(fromArgv)) { argvNames.add(name); changed = true; }
    }
  }
  const refusals = [];
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) || calleeText(n) !== 'process.exit') return;
    const code = n.arguments[0];
    if (!code || !ts.isNumericLiteral(code) || code.text === '0' || code.text === '1') return;
    for (let p = n.parent; p && !ts.isFunctionLike(p); p = p.parent) {
      if (!ts.isIfStatement(p)) continue;
      const says = stringsIn(p.thenStatement).some(s => /unknown|unrecogni[sz]ed|argument|usage/i.test(s));
      if (fromArgv(p.expression) && says && reachable(n, true, S) && reachable(n, false, S)) refusals.push(n);
      break;
    }
  });
  if (refusals.length === 0) {
    say('refusal', `${PREFLIGHT_FILE} has no refusal of an unknown argument: a branch on the command line that names it and calls process.exit(<non-zero other than 1>), so '--statc' would run the FULL preflight`);
  }

  // The regions: kept by the full run, gone under --static.
  const regions = regionNodes(sf);
  for (const region of Object.keys(REGIONS).filter(k => !GONE.includes(k))) {
    if (regions[region].length === 0) say(region, `no call of the '${region}' region found in ${PREFLIGHT_FILE}: the rule would be asserted over nothing`);
  }
  // The probe of the test database is gone with the database batches: a socket opened to ask whether a stack is up is back.
  for (const region of GONE) {
    for (const n of regions[region]) say(region, `${region} (line ${lineOf(sf, n)}) is back in ${PREFLIGHT_FILE}: local preflight runs no database test, so nothing local asks whether a database is up`);
  }
  for (const region of SKIPPED_UNDER_STATIC) {
    for (const n of regions[region]) {
      const at = `line ${lineOf(sf, n)}`;
      if (reachable(n, true, S)) say(region, `${region} (${at}) still runs under ${STATIC_FLAG}: it needs a database or runs a suite`);
      if (!reachable(n, false, S)) say(region, `${region} (${at}) does not run in the full preflight`);
    }
  }
  for (const n of regions['database-batch']) {
    const at = `line ${lineOf(sf, n)}`;
    if (!reachable(n, false, S)) say('database-batch', `the batch call (${at}) does not run in the full preflight`);
    if (!reachable(n, true, S)) say('database-batch', `the batch call (${at}) is skipped under ${STATIC_FLAG} whole: the pure half (the timer and walk rule gates live there) must run`);
    if (!planHoldsOnlyPure(n, decls, S)) say('database-batch', `the batch call (${at}) can run a database batch: no loop around it selects only kind 'pure' from a test the flag does not enter, so a db run is in the plan in at least one mode`);
  }

  // Every other step runs under --static.
  const steps = otherSteps(sf, regions);
  // With no flag every step trivially "runs under --static": say so, so that is not read as the rule holding.
  if (!turns) say('steps', `no ${STATIC_FLAG} flag turns anything in ${PREFLIGHT_FILE}, so no step is static`);
  if (steps.length < floor) say('steps', `only ${steps.length} step call(s) found outside the skipped regions, floor ${floor}: the scan is broken or the file lost its steps`);
  for (const n of steps) {
    if (!reachable(n, true, S)) say('steps', `${n.getText().slice(0, 70)} (line ${lineOf(sf, n)}) is skipped under ${STATIC_FLAG}, and it is not a suite`);
    if (!reachable(n, false, S)) say('steps', `${n.getText().slice(0, 70)} does not run in the full preflight`);
  }
  for (const token of NAMED_STATIC_STEPS) {
    if (!steps.some(n => stringsIn(n).some(s => s.includes(token)))) say('steps', `no step call names '${token}': the plan lists it as a static step`);
  }

  // The verdict.
  const prints = [];
  visit(sf, (n) => { if (ts.isCallExpression(n) && /^console\.(log|error|info)$/.test(calleeText(n))) prints.push(n); });
  const passTexts = (s) => prints.filter(n => reachable(n, s, S))
    .flatMap(n => n.arguments.flatMap(a => textsOf(a, s, S))).filter(t => /passed/i.test(t));
  const underStatic = passTexts(true);
  const underFull = passTexts(false);
  if (underStatic.length === 0) say('verdict', `no pass verdict is printed under ${STATIC_FLAG}`);
  for (const t of underStatic) {
    if (/preflight passed/i.test(t)) say('verdict', `the full run's verdict is printed under ${STATIC_FLAG}: ${JSON.stringify(t.slice(0, 60))}`);
    else if (!/static/i.test(t)) say('verdict', `a pass verdict under ${STATIC_FLAG} does not say it is static: ${JSON.stringify(t.slice(0, 60))}`);
  }
  if (!underFull.some(t => t.includes('Preflight PASSED'))) say('verdict', "the full run no longer prints 'Preflight PASSED', the line the mark copies");
  const staticInFull = underFull.find(t => /static/i.test(t));
  if (staticInFull) say('verdict', `the full run prints a static verdict: ${JSON.stringify(staticInFull.slice(0, 60))}`);
  const notAPushPassInFull = underFull.find(t => /not a push pass/i.test(t));
  if (notAPushPassInFull) say('verdict', `the full run says "not a push pass": ${JSON.stringify(notAPushPassInFull.slice(0, 60))}; the mark would refuse the pass the full run exists to give`);

  // The timing scope.
  const scopes = [];
  visit(sf, (n) => {
    if (!ts.isCallExpression(n) || calleeName(n) !== 'timingReporterFlags') return;
    const obj = n.arguments.find(ts.isObjectLiteralExpression);
    const prop = obj?.properties.find(p => ts.isPropertyAssignment(p) && p.name.getText() === 'scope');
    scopes.push({ call: n, value: prop?.initializer });
  });
  if (scopes.length === 0) say('scope', `no timingReporterFlags call with a scope found in ${PREFLIGHT_FILE}`);
  for (const s of [true, false]) {
    const values = scopes.filter(x => reachable(x.call, s, S)).flatMap(x => (x.value ? textsOf(x.value, s, S) : ['${}']));
    if (s && (values.length === 0 || values.some(t => t !== 'static'))) {
      say('scope', `the static run labels its timing scope ${JSON.stringify(values)}, not 'static': its files would read as a subset of a full run's`);
    }
    if (!s && (values.length === 0 || values.some(t => t === 'static' || t.includes('${}')))) {
      say('scope', `the full run's timing scope is ${JSON.stringify(values)}: it must stay a literal scope that is not 'static'`);
    }
  }
  return v;
}

const report = (violations, region) => violations.filter(x => x.region === region).map(x => `  - ${x.message}`).join('\n');
const regionHolds = (src, region) => {
  const v = analyse(src);
  assert.equal(v.filter(x => x.region === region).length, 0, `${region}:\n${report(v, region)}`);
};

// ───────────────────────────────────────────────── mutations, in memory ──────────────────────────────────────────────────────

const edit = (src, edits) => [...edits].sort((a, b) => b.start - a.start)
  .reduce((text, e) => text.slice(0, e.start) + e.text + text.slice(e.end), src);

/** The flag taken out: every test of `'--static'` in the file becomes `false`, as if the script never read the command line. */
function neutraliseFlag(src) {
  const sf = parsed(src, 'neutralise');
  const edits = [];
  visit(sf, (n) => { if (ts.isExpression(n) && isFlagTest(n)) edits.push({ start: n.getStart(sf), end: n.getEnd(), text: 'false' }); });
  assert.ok(edits.length > 0, 'the mutation found no test of the flag to neutralise');
  return edit(src, edits);
}

/** An unguarded copy of the first call of `region`, inserted as a statement straight after the imports: that call now runs under every flag. */
function insertUnguardedCopy(src, region) {
  const sf = parsed(src, `copy-${region}`);
  const node = regionNodes(sf)[region][0];
  assert.ok(node, `the mutation found no '${region}' call to copy`);
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const at = imports.length ? imports[imports.length - 1].getEnd() : 0;
  return `${src.slice(0, at)}\n${node.getText()};\n${src.slice(at)}`;
}

/** The batch loop's selection, as the source ranges a mutation may rewrite: a `.filter` call (replaced by what it filters) or a loop-body `if` that skips db runs. */
function planSelection(src, tag) {
  const sf = parsed(src, tag);
  const decls = bindingsOf(sf);
  const S = flagNames(decls);
  const node = regionNodes(sf)['database-batch'][0];
  assert.ok(node, "the mutation found no 'database-batch' call");
  return { sf, node, filters: pureFilters(node, decls), skips: dbSkips(node, S) };
}

/**
 * A db run put back into the plan: the kind filter taken out of the batch loop's list (the `.filter(...)` call becomes what it
 * filtered), or the loop's `if` that skips db runs made empty. The plan then runs every kind, in both modes.
 */
function putDbRunBack(src) {
  const { sf, filters, skips } = planSelection(src, 'db-back');
  const edits = filters.map(({ call }) => ({ start: call.getStart(sf), end: call.getEnd(), text: call.expression.expression.getText() }))
    .concat(skips.map(n => ({ start: n.getStart(sf), end: n.getEnd(), text: ';' })));
  assert.ok(edits.length > 0, 'the mutation found no kind selection in the batch loop to take out');
  return edit(src, edits);
}

/**
 * The OLD guard put back in front of the selection: `!STATIC || <kind is pure>`, so the plan keeps every kind in the full mode and
 * only `--static` selects by kind. This is the plan the file had before Q-588, and it is the one the rule must not mistake for the
 * new one because it, too, names the kind and reads the flag.
 */
function putStaticOnlyGuardBack(src) {
  const { sf, filters, skips } = planSelection(src, 'static-only');
  const notStatic = `!process.argv.includes('${STATIC_FLAG}')`;
  const edits = filters.map(({ predicate }) => ({ start: predicate.getStart(sf), end: predicate.getEnd(), text: `${notStatic} || ${predicate.getText()}` }))
    .concat(skips.map(n => ({ start: n.expression.getStart(sf), end: n.expression.getEnd(), text: `${notStatic} ? false : ${n.expression.getText()}` })));
  assert.ok(edits.length > 0, 'the mutation found no kind selection in the batch loop to guard');
  return edit(src, edits);
}

/** The probe of the test database put back: a socket opened as a statement straight after the imports. */
function putProbeBack(src) {
  const sf = parsed(src, 'probe');
  const imports = sf.statements.filter(ts.isImportDeclaration);
  const at = imports.length ? imports[imports.length - 1].getEnd() : 0;
  return `${src.slice(0, at)}\nnew Socket().connect(27117, '127.0.0.1');\n${src.slice(at)}`;
}

// ─────────────────────────────────────────── the rule over the real file (red at base) ───────────────────────────────────────────

describe('scripts/preflight.mjs: no database batch in either mode, and --static (the real file, read as text)', () => {
  it('reads the flag from the command line', () => regionHolds(REAL, 'flag'));

  it('refuses an argument it does not know, so a mistyped flag never runs the full preflight silently', () => regionHolds(REAL, 'refusal'));

  for (const region of SKIPPED_UNDER_STATIC) {
    it(`the ${region} region runs in the full preflight and not under --static`, () => regionHolds(REAL, region));
  }

  it('the run plan holds no database batch in EITHER mode: the loop over offlineRuns selects only kind pure, from a test the flag does not enter', () => regionHolds(REAL, 'database-batch'));

  it('the probe of the test database is gone: no socket is opened to ask whether a stack is up', () => regionHolds(REAL, 'database-probe'));

  it("says how many database test files are not run here, and that CI's Full run runs them", () => {
    // The sentence is the half an operator reads; the count in it is computed, so only the words are asserted.
    assert.match(stripComments(REAL), /database test files are not run here; CI's Full run runs them/,
      "preflight no longer says '<n> database test files are not run here; CI's Full run runs them'");
  });

  it('every other step runs under --static: a step added later is static unless a guard says it is a suite', () => regionHolds(REAL, 'steps'));

  it('the static verdict is not the full run\'s "Preflight PASSED", and that string is never printed under --static', () => regionHolds(REAL, 'verdict'));

  it('the static verdict says "not a push pass", the words ~/.claude/hooks/preflight-mark.js refuses to record on exit 0', () => {
    // The mark records on exit 0, and a static run that passes exits 0: these words in the code (not a comment) are what
    // keep it from being recorded, whatever command the project's preflight slot names.
    assert.match(stripComments(REAL), /not a push pass/i, 'the static verdict no longer says "not a push pass", so preflight-mark would record it as the pass');
  });

  it('the full verdict says "Preflight PASSED" and never "not a push pass"', () => {
    const v = analyse(REAL).filter(x => x.region === 'verdict');
    assert.deepEqual(v, [], v.map(x => x.message).join('\n'));
    assert.match(stripComments(REAL), /Preflight PASSED/, 'the full run no longer prints the line the mark copies');
  });

  it("the static run labels its timing scope 'static', not 'subset'", () => regionHolds(REAL, 'scope'));

  it('the timing reporter accepts the scope the static run labels (its flags would otherwise throw)', () => {
    assert.ok(TIMING_SCOPES.includes('static'), `TIMING_SCOPES is ${JSON.stringify([...TIMING_SCOPES])}: a 'static' run's reporter flags would throw`);
    // Into a folder of its own: the default is the checkout's results folder, which a test must not create.
    const dir = mkdtempSync(join(scratchRoot(), 'flags-'));
    assert.doesNotThrow(() => timingReporterFlags({ suite: 'preflight', batch: 'pure-1', scope: 'static', dir }));
  });

  describe('mutated in memory, each must turn the rule red for the region it touched', () => {
    // A mutation says nothing about a file that was already red: the baseline is asserted first, so these fail with the rule at base
    // and mean something once it holds.
    const cleanBaseline = () => {
      const v = analyse(REAL);
      assert.equal(v.length, 0, `the real file does not hold the rule, so no mutation of it can be judged:\n${v.map(x => `  - [${x.region}] ${x.message}`).join('\n')}`);
    };

    it('the flag neutralised: every skipped region, the verdict and the scope go red', () => {
      cleanBaseline();
      const v = analyse(neutraliseFlag(REAL));
      for (const region of [...SKIPPED_UNDER_STATIC, 'verdict', 'scope', 'flag']) {
        assert.ok(v.some(x => x.region === region), `neutralising the flag left '${region}' green`);
      }
    });

    for (const region of [...SKIPPED_UNDER_STATIC, 'database-batch']) {
      it(`an unguarded copy of the ${region} call, moved into the static path, is named`, () => {
        cleanBaseline();
        const v = analyse(insertUnguardedCopy(REAL, region));
        assert.ok(v.some(x => x.region === region), `an unguarded ${region} call left the rule green`);
      });
    }

    it('a db run put back into the plan (the kind selection taken out of the batch loop) is named', () => {
      cleanBaseline();
      const v = analyse(putDbRunBack(REAL));
      assert.ok(v.some(x => x.region === 'database-batch'), 'a batch loop that runs every kind left the rule green');
    });

    it('the old `!--static ||` guard put back in front of the kind selection (db runs in the full mode only) is named', () => {
      cleanBaseline();
      const v = analyse(putStaticOnlyGuardBack(REAL));
      assert.ok(v.some(x => x.region === 'database-batch'), 'a plan that selects by kind only under --static left the rule green');
    });

    it('the probe of the test database put back is named', () => {
      cleanBaseline();
      const v = analyse(putProbeBack(REAL));
      assert.ok(v.some(x => x.region === 'database-probe'), 'a socket opened to the test database left the rule green');
    });

    it('the full verdict printed under --static is named', () => {
      cleanBaseline();
      const mutated = REAL.replace(/(['"`])Preflight STATIC/i, (m, q) => `${q}Preflight PASSED. STATIC`);
      assert.notEqual(mutated, REAL, 'the static verdict literal was not found to mutate');
      const v = analyse(mutated);
      assert.ok(v.some(x => x.region === 'verdict'), 'a static verdict that begins "Preflight PASSED" left the rule green');
    });

    it('"not a push pass" said by the full verdict is named', () => {
      cleanBaseline();
      const mutated = REAL.replace(/(['"`])Preflight PASSED/, (m, q) => `${q}Preflight PASSED - not a push pass`);
      assert.notEqual(mutated, REAL, 'the full verdict literal was not found to mutate');
      const v = analyse(mutated);
      assert.ok(v.some(x => x.region === 'verdict' && /not a push pass/.test(x.message)), 'a full verdict that says "not a push pass" left the rule green');
    });
  });
});

// ──────────────────────────────── the analyser itself, over literal samples (green at base: it guards the gate) ───────────────────

/** One right shape: a guard per region, a `.filter` on the batch list that keeps pure runs in both modes, a conditional verdict and scope. */
const SAMPLE_FILTER = `
import { execSync, execFileSync } from 'node:child_process';
const STATIC = process.argv.slice(2).includes('--static');
const unknown = process.argv.slice(2).filter(a => a !== '--static');
if (unknown.length > 0) { console.error('preflight: unknown argument ' + unknown[0]); process.exit(2); }
// Preflight PASSED. npm run test --workspace=client -- --reporter=json   (prose, not a call)
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
function gate(name) { run('node --test ' + name); }
const failures = [];
for (const g of ['a', 'b']) gate(g);
run('npm run build:server');
const runs = offlineRuns(split).filter(r => r.kind === 'pure');
for (const [i, r] of runs.entries()) {
  const flags = timingReporterFlags({ suite: 'preflight', batch: \`\${r.kind}-\${i}\`, scope: STATIC ? 'static' : 'subset' });
  execFileSync('node', ['--test', ...r.args, ...flags.args, ...r.files]);
}
execSync('git ls-files "testing/**/*.js"', { encoding: 'utf8' });
run('node scripts/unrun-tests.mjs');
run('node scripts/surface-matrix-audit.mjs');
run('npm run lint:docs');
run('npm run todo:check');
run('node ./scripts/check-changelog.mjs');
run('npm run typecheck:client');
if (!STATIC) {
  try { run('npm run test --workspace=client -- --reporter=json'); } catch { failures.push('client'); }
  try { execSync('npm run build:prod --workspace=client -- --verbose'); readFileSync('client/angular.json', 'utf8'); } catch { failures.push('build'); }
}
if (failures.length === 0) {
  console.log(STATIC ? 'Preflight STATIC passed - not a push pass.' : 'Preflight PASSED. Docker-dependent suites still run in CI.');
  process.exit(0);
}
process.exit(1);
`;

/** A second right shape, spelled differently: an inline flag test, an unfiltered list with a `continue` for a db run in the loop body, if/else around the verdict and the client block. */
const SAMPLE_CONTINUE = `
import { execSync, execFileSync } from 'node:child_process';
if (process.argv.slice(2).some(a => a !== '--static')) { console.log('usage: preflight [--static]'); process.exit(2); }
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
function gate(name) { run('node --test ' + name); }
for (const g of ['a', 'b']) gate(g);
run('npm run build:server');
for (const [i, r] of offlineRuns(split).entries()) {
  if (r.kind === 'db') continue;
  execFileSync('node', ['--test', ...r.files], { env: timingReporterFlags({ scope: process.argv.includes('--static') ? 'static' : 'subset' }).env });
}
execSync('git ls-files "testing/**/*.js"');
run('node scripts/unrun-tests.mjs');
run('node scripts/surface-matrix-audit.mjs');
run('npm run lint:docs');
run('npm run todo:check');
run('node ./scripts/check-changelog.mjs');
run('npm run typecheck:client');
if (process.argv.includes('--static') === false) {
  run('npm run test --workspace=client');
  run('npm run build:prod --workspace=client');
  readFileSync('client/angular.json');
}
if (process.argv.includes('--static')) { console.log('Preflight STATIC passed - not a push pass'); }
else { console.log('Preflight PASSED.'); }
`;

describe('the preflight rules, over literal samples', () => {
  for (const [name, sample] of [['a filtered batch list and a flag variable', SAMPLE_FILTER], ['a continue for a db run in the loop and an inline flag test', SAMPLE_CONTINUE]]) {
    describe(name, () => {
      it('holds the rule', () => {
        const v = analyse(sample);
        assert.deepEqual(v, [], v.map(x => `[${x.region}] ${x.message}`).join('\n'));
      });

      it('goes red with the flag neutralised, naming every skipped region', () => {
        const v = analyse(neutraliseFlag(sample));
        for (const region of [...SKIPPED_UNDER_STATIC, 'verdict', 'scope', 'flag']) {
          assert.ok(v.some(x => x.region === region), `'${region}' stayed green with the flag neutralised`);
        }
      });

      for (const region of [...SKIPPED_UNDER_STATIC, 'database-batch']) {
        it(`goes red when an unguarded ${region} call is moved into the static path`, () => {
          assert.ok(analyse(insertUnguardedCopy(sample, region)).some(x => x.region === region));
        });
      }

      it('goes red when a db run is put back into the plan', () => {
        assert.ok(analyse(putDbRunBack(sample)).some(x => x.region === 'database-batch'));
      });

      it('goes red when the old static-only guard is put back in front of the kind selection', () => {
        assert.ok(analyse(putStaticOnlyGuardBack(sample)).some(x => x.region === 'database-batch'));
      });

      it('goes red when the probe is put back', () => {
        assert.ok(analyse(putProbeBack(sample)).some(x => x.region === 'database-probe'));
      });
    });
  }

  it('a comment that names a region, the full verdict, the probe or the flag is not a call and counts for nothing', () => {
    const noisy = `// run('npm run test --workspace=client'); console.log('Preflight PASSED'); new Socket(); const STATIC = argv.includes('--static');\n${SAMPLE_FILTER}`;
    assert.deepEqual(analyse(noisy), []);
    assert.equal(stripComments(noisy).includes('const STATIC = argv.includes'), false, 'the comment is gone once stripped');
  });

  it('a plan that selects by kind only when the flag is set is the old plan, and is named', () => {
    const old = SAMPLE_FILTER.replace("r => r.kind === 'pure'", "r => !STATIC || r.kind === 'pure'");
    assert.notEqual(old, SAMPLE_FILTER);
    assert.ok(analyse(old).some(x => x.region === 'database-batch'));
  });

  it('is red when the script reads no flag (what a file with no --static is)', () => {
    const v = analyse(SAMPLE_FILTER.replaceAll("'--static'", "'--other'"));
    for (const region of ['flag', 'steps']) assert.ok(v.some(x => x.region === region), `'${region}' not named`);
  });

  it('is red when an unknown argument is not refused, or the refusal is not conditioned on the command line', () => {
    const noRefusal = SAMPLE_FILTER.replace('process.exit(2);', 'console.error(unknown);');
    assert.notEqual(noRefusal, SAMPLE_FILTER);
    assert.ok(analyse(noRefusal).some(x => x.region === 'refusal'));
    const unconditioned = SAMPLE_FILTER.replace('unknown.length > 0', 'failures.length > 0');
    assert.notEqual(unconditioned, SAMPLE_FILTER);
    assert.ok(analyse(unconditioned).some(x => x.region === 'refusal'));
  });

  it('is red when the static verdict is the full verdict, when the full verdict says "not a push pass", and when the static scope is the subset scope', () => {
    const sameVerdict = SAMPLE_FILTER.replace("'Preflight STATIC passed - not a push pass.'", "'Preflight PASSED. static'");
    assert.ok(analyse(sameVerdict).some(x => x.region === 'verdict'));
    const fullSaysStatic = SAMPLE_FILTER.replace("'Preflight PASSED. Docker", "'Preflight PASSED - not a push pass. Docker");
    assert.notEqual(fullSaysStatic, SAMPLE_FILTER);
    assert.ok(analyse(fullSaysStatic).some(x => x.region === 'verdict'));
    const sameScope = SAMPLE_FILTER.replace("STATIC ? 'static' : 'subset'", "'subset'");
    assert.ok(analyse(sameScope).some(x => x.region === 'scope'));
  });

  it('is red when a gate sits inside a guard that skips it under --static', () => {
    const skipsAGate = SAMPLE_FILTER.replace("run('npm run lint:docs');", "if (!STATIC) run('npm run lint:docs');");
    assert.ok(analyse(skipsAGate).some(x => x.region === 'steps' && /lint:docs/.test(x.message)));
  });

  it('is red when the step scan finds nothing (the floor), not green about an empty file', () => {
    assert.ok(analyse("const STATIC = process.argv.includes('--static');\n").some(x => x.region === 'steps'));
  });
});
