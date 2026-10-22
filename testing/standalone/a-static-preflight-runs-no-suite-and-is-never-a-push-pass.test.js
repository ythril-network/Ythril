/**
 * `npm run preflight -- --static` runs every gate that needs no stack and no suite, and it is never mistaken for the push pass.
 *
 * ## The failure this prevents
 *
 * A "fast subset" of preflight is wanted: the gates that need no database and run no test suite, for the moment between
 * edits when the full run (about three minutes of suites) is the wrong price. Three ways it goes wrong, each silent:
 *
 * - **It runs a suite after all.** A new step lands inside the static path and the "minute" becomes five; or the skipped
 *   regions are the wrong ones and a database batch runs against a machine with no database.
 * - **It skips a gate.** The flag is written as an `if` around "the slow part", a step is added below it later, and the
 *   static run quietly leaves out one of the checks it exists to run.
 * - **It says PASSED.** `~/.claude/hooks/preflight-mark.js` copies the full run's verdict line; a static run that prints
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
 *   TCP probe of the test database, a `--test` batch), never by a line number or a variable name. Each region must be
 *   reachable in the full run and unreachable under `--static`; the one exception is the batch call, which is shared by the
 *   pure and the database half and must therefore select by kind under `--static`;
 * - every OTHER step call (`run`, `execSync`, `execFileSync`, `gate`) must be reachable under `--static`, so a step added
 *   later is static unless a guard says it is a suite.
 *
 * Seen red by the RULE, and by mutation: `analyse()` is run over the real file with the flag neutralised, with an unguarded
 * copy of a region's call inserted, and with the kind filter taken out of the batch loop; each must name the region.
 * The mutations are in memory and the file is never written.
 *
 * Not edited by this gate's author, and not read by it: the five other readers of preflight's text
 * (`preflight-coverage`, `ci-workflow-is-sound`, `a-client-report-is-masked-before-upload`,
 * `a-test-child-environment-is-one-module`, `ci-workflow-fixture`). A flag that leaves the text in place keeps them green.
 *
 * Run: node --test testing/standalone/a-static-preflight-runs-no-suite-and-is-never-a-push-pass.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
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
const SKIPPED_UNDER_STATIC = ['client-suite', 'client-build', 'bundle-budgets', 'database-probe'];

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

const KINDS = ['pure', 'db'];
const namesKind = (expr) => {
  let hit = false;
  visit(expr, (n) => {
    if (isString(n) && KINDS.includes(n.text)) hit = true;
    if (ts.isIdentifier(n) && ['offlinePure', 'offlineDb'].includes(n.text)) hit = true;
  });
  return hit;
};

/**
 * Does the loop around this `--test` batch leave the database batches out under `--static`? Two shapes, both stated by what they
 * contain: the list it iterates is built from the flag AND names the kind (`.filter(r => !STATIC || r.kind === 'pure')`), or the
 * loop's own body holds an `if` that reads the flag, names the kind and leaves the iteration (`continue`, `break`, `return`).
 */
function dbBatchesDropped(node, decls, S) {
  if (loopIterables(node, decls).some(x => readsFlag(x, S) && namesKind(x))) return true;
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (!isLoop(p)) continue;
    let found = false;
    visit(p.statement, (n) => {
      if (!ts.isIfStatement(n) || !readsFlag(n.expression, S) || !namesKind(n.expression)) return;
      visit(n.thenStatement, (m) => { if (ts.isContinueStatement(m) || ts.isBreakStatement(m) || ts.isReturnStatement(m)) found = true; });
    });
    return found;
  }
  return false;
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
  for (const region of Object.keys(REGIONS)) {
    if (regions[region].length === 0) say(region, `no call of the '${region}' region found in ${PREFLIGHT_FILE}: the rule would be asserted over nothing`);
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
    else if (!dbBatchesDropped(n, decls, S)) say('database-batch', `the batch call (${at}) runs the database half under ${STATIC_FLAG}: no loop around it selects by kind from the flag`);
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

/** The kind filter taken out of the batch loop: every use of the flag in what the loop iterates (and in its own `if`s) becomes `false`. */
function dropKindFilter(src) {
  const sf = parsed(src, 'kind');
  const decls = bindingsOf(sf);
  const S = flagNames(decls);
  const node = regionNodes(sf)['database-batch'][0];
  assert.ok(node, "the mutation found no 'database-batch' call");
  const edits = [];
  const strip = (root) => visit(root, (n) => {
    if (ts.isIdentifier(n) && S.has(n.text) && !ts.isVariableDeclaration(n.parent)) edits.push({ start: n.getStart(sf), end: n.getEnd(), text: 'false' });
    else if (ts.isExpression(n) && isFlagTest(n)) edits.push({ start: n.getStart(sf), end: n.getEnd(), text: 'false' });
  });
  for (const x of loopIterables(node, decls)) strip(x);
  for (let p = node.parent; p && !ts.isFunctionLike(p); p = p.parent) {
    if (isLoop(p)) { strip(p.statement); break; }
  }
  assert.ok(edits.length > 0, 'the mutation found no use of the flag in the batch loop');
  return edit(src, edits);
}

// ─────────────────────────────────────────── the rule over the real file (red at base) ───────────────────────────────────────────

describe('scripts/preflight.mjs under --static (the real file, read as text)', () => {
  it('reads the flag from the command line', () => regionHolds(REAL, 'flag'));

  it('refuses an argument it does not know, so a mistyped flag never runs the full preflight silently', () => regionHolds(REAL, 'refusal'));

  for (const region of SKIPPED_UNDER_STATIC) {
    it(`the ${region} region runs in the full preflight and not under --static`, () => regionHolds(REAL, region));
  }

  it('the offline batches keep the pure half under --static and select the database half out by kind', () => regionHolds(REAL, 'database-batch'));

  it('every other step runs under --static: a step added later is static unless a guard says it is a suite', () => regionHolds(REAL, 'steps'));

  it('the static verdict is not the full run\'s "Preflight PASSED", and that string is never printed under --static', () => regionHolds(REAL, 'verdict'));

  it("the static run labels its timing scope 'static', not 'subset'", () => regionHolds(REAL, 'scope'));

  it('the timing reporter accepts the scope the static run labels (its flags would otherwise throw)', () => {
    assert.ok(TIMING_SCOPES.includes('static'), `TIMING_SCOPES is ${JSON.stringify([...TIMING_SCOPES])}: a 'static' run's reporter flags would throw`);
    assert.doesNotThrow(() => timingReporterFlags({ suite: 'preflight', batch: 'pure-1', scope: 'static' }));
  });

  describe('mutated in memory, each must turn the rule red for the region it touched', () => {
    // A mutation says nothing about a file that was already red: the baseline is asserted first, so these fail with the rule at base
    // and mean something once it holds.
    const cleanBaseline = () => {
      const v = analyse(REAL);
      assert.equal(v.length, 0, `the real file does not hold the rule, so no mutation of it can be judged:\n${v.map(x => `  - [${x.region}] ${x.message}`).join('\n')}`);
    };

    it('the flag neutralised: every skipped region, the batch filter, the verdict and the scope go red', () => {
      cleanBaseline();
      const v = analyse(neutraliseFlag(REAL));
      for (const region of [...SKIPPED_UNDER_STATIC, 'database-batch', 'verdict', 'scope', 'flag']) {
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

    it('the kind filter taken out of the batch loop lets the database half through, and is named', () => {
      cleanBaseline();
      const v = analyse(dropKindFilter(REAL));
      assert.ok(v.some(x => x.region === 'database-batch'), 'a batch loop that ignores the flag left the rule green');
    });

    it('the full verdict printed under --static is named', () => {
      cleanBaseline();
      const mutated = REAL.replace(/(['"`])Preflight STATIC/i, (m, q) => `${q}Preflight PASSED. STATIC`);
      assert.notEqual(mutated, REAL, 'the static verdict literal was not found to mutate');
      const v = analyse(mutated);
      assert.ok(v.some(x => x.region === 'verdict'), 'a static verdict that begins "Preflight PASSED" left the rule green');
    });
  });
});

// ──────────────────────────────── the analyser itself, over literal samples (green at base: it guards the gate) ───────────────────

/** One right shape: a guard per region, a `.filter` on the batch list, a conditional verdict and scope. */
const SAMPLE_FILTER = `
import { execSync, execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
const STATIC = process.argv.slice(2).includes('--static');
const unknown = process.argv.slice(2).filter(a => a !== '--static');
if (unknown.length > 0) { console.error('preflight: unknown argument ' + unknown[0]); process.exit(2); }
// Preflight PASSED. npm run test --workspace=client -- --reporter=json   (prose, not a call)
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
function gate(name) { run('node --test ' + name); }
const failures = [];
for (const g of ['a', 'b']) gate(g);
run('npm run build:server');
const runs = offlineRuns(split).filter(r => !STATIC || r.kind === 'pure');
for (const [i, r] of runs.entries()) {
  const flags = timingReporterFlags({ suite: 'preflight', batch: \`\${r.kind}-\${i}\`, scope: STATIC ? 'static' : 'subset' });
  execFileSync('node', ['--test', ...r.args, ...flags.args, ...r.files]);
}
if (!STATIC) {
  const up = await new Promise(resolve => { const sock = new Socket(); sock.connect(27117, '127.0.0.1'); resolve(sock); });
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

/** A second right shape, spelled differently: an inline flag test, a `continue` in the loop, if/else around the verdict and the client block. */
const SAMPLE_CONTINUE = `
import { execSync, execFileSync } from 'node:child_process';
import { Socket } from 'node:net';
if (process.argv.slice(2).some(a => a !== '--static')) { console.log('usage: preflight [--static]'); process.exit(2); }
const run = (cmd) => execSync(cmd, { stdio: 'inherit' });
function gate(name) { run('node --test ' + name); }
for (const g of ['a', 'b']) gate(g);
run('npm run build:server');
for (const [i, r] of offlineRuns(split).entries()) {
  if (process.argv.includes('--static') && r.kind === 'db') continue;
  execFileSync('node', ['--test', ...r.files], { env: timingReporterFlags({ scope: process.argv.includes('--static') ? 'static' : 'subset' }).env });
}
process.argv.includes('--static') || new Socket().connect(27117);
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

describe('the static-preflight rule, over literal samples', () => {
  for (const [name, sample] of [['a flag variable and a filtered batch list', SAMPLE_FILTER], ['an inline flag test and a continue in the loop', SAMPLE_CONTINUE]]) {
    describe(name, () => {
      it('holds the rule', () => {
        const v = analyse(sample);
        assert.deepEqual(v, [], v.map(x => `[${x.region}] ${x.message}`).join('\n'));
      });

      it('goes red with the flag neutralised, naming every region', () => {
        const v = analyse(neutraliseFlag(sample));
        for (const region of [...SKIPPED_UNDER_STATIC, 'database-batch', 'verdict', 'scope', 'flag']) {
          assert.ok(v.some(x => x.region === region), `'${region}' stayed green with the flag neutralised`);
        }
      });

      for (const region of [...SKIPPED_UNDER_STATIC, 'database-batch']) {
        it(`goes red when an unguarded ${region} call is moved into the static path`, () => {
          assert.ok(analyse(insertUnguardedCopy(sample, region)).some(x => x.region === region));
        });
      }

      it('goes red when the batch loop stops selecting by kind', () => {
        assert.ok(analyse(dropKindFilter(sample)).some(x => x.region === 'database-batch'));
      });
    });
  }

  it('a comment that names a region, the full verdict or the flag is not a call and counts for nothing', () => {
    const noisy = `// run('npm run test --workspace=client'); console.log('Preflight PASSED'); const STATIC = argv.includes('--static');\n${SAMPLE_FILTER}`;
    assert.deepEqual(analyse(noisy), []);
    assert.equal(stripComments(noisy).includes('const STATIC = argv.includes'), false, 'the comment is gone once stripped');
  });

  it('is red when the script reads no flag (what the base file is)', () => {
    const v = analyse(SAMPLE_FILTER.replaceAll("'--static'", "'--other'"));
    for (const region of ['flag', 'steps', 'database-batch']) assert.ok(v.some(x => x.region === region), `'${region}' not named`);
  });

  it('is red when an unknown argument is not refused, or the refusal is not conditioned on the command line', () => {
    const noRefusal = SAMPLE_FILTER.replace('process.exit(2);', 'console.error(unknown);');
    assert.notEqual(noRefusal, SAMPLE_FILTER);
    assert.ok(analyse(noRefusal).some(x => x.region === 'refusal'));
    const unconditioned = SAMPLE_FILTER.replace('unknown.length > 0', 'failures.length > 0');
    assert.notEqual(unconditioned, SAMPLE_FILTER);
    assert.ok(analyse(unconditioned).some(x => x.region === 'refusal'));
  });

  it('is red when the static verdict is the full verdict, and when the static scope is the subset scope', () => {
    const sameVerdict = SAMPLE_FILTER.replace("'Preflight STATIC passed - not a push pass.'", "'Preflight PASSED. static'");
    assert.ok(analyse(sameVerdict).some(x => x.region === 'verdict'));
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
