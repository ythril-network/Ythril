/**
 * Pure gate (Q-578): a test that sets an operation bound on a REAL store sets it no tighter than a real operation needs,
 * or says, in a reasoned row, which one operation it holds and why only that one.
 *
 * ## What it prevents
 *
 * R-X6a set `SPACE_ACT_OP_MS` to 40 ms to end ONE batch its hook held. The figure is not the hook's: it bounds every store
 * operation of the act, so on a loaded CI host a REAL batch ran past 40 ms too, the attempt failed for a reason that was
 * not the rule under test, and the row read as a defect in the runner. The boot-suppression sweep did the same with a
 * 400 ms housekeeping bound over every healthy space. A bound a test sets is a statement about the host unless it is
 * above what a real operation takes; a test that needs one operation to end holds THAT operation (a hook that never
 * resolves, a stalled view) and keeps the bound where no real operation reaches it.
 *
 * ## How the set is found — derived, never listed
 *
 * - **Setters, by shape**, from `server/src`: an exported `...ForTest` function whose parameter is a `number`, or an
 *   object type declared in the same file (or imported by name from a relative module) with keys ending `Ms` / `_MS` typed `number`. Those keys are the figures.
 * - **Env figures**: an assignment to `process.env.<NAME_MS>` in testing/ (a computed name resolved like a figure), or a
 *   `<NAME_MS>` key beside a spread of `process.env`.
 * - **Figures are resolved** through literals, arithmetic, `String`/`Number`, a variable declared once in the file (a
 *   `let` by every value assigned to it), a key read off an object, a `for…of` over a literal list — and a function's
 *   PARAMETER, followed to every call of that function (a wrapper such as `_write-faults.mjs`'s `setWriteBoundForTest`,
 *   or `landingExperiment`'s `boundMs`), where the figure is reported at the line that wrote it. A figure in a
 *   store-backed file that does not resolve FAILS: a gate that skips what it cannot read concludes about what it did not
 *   check.
 * - Read as a syntax tree, so a figure in a comment or a docblock is never a site.
 *
 * ## Axes, by rule rather than by row
 *
 * - **An operation bound** (the floor applies): a figure that ends a store operation or a step of one.
 * - **An answer or wait figure** (`ANSWER_OR_WAIT`): how long a caller waits before ANSWERING or REPORTING (a door's
 *   `queued`, a drain's re-wait, a slow-act report that never cuts). It ends no operation, so a small one cannot end a
 *   real batch.
 * - **A file that reaches no real store**: a test file outside the database-backed and instance thirds of the standalone
 *   split (`splitStandalone`, the runner's own plan), or a helper no such file imports. A fake driver has no batch a
 *   bound could end by accident.
 *
 * Seen red at base (bundle-167): R-X6a's and R-W6b's `SPACE_ACT_OP_MS: 40` and the boot sweep's
 * `housekeepingOpMs: BOUND_MS` (400) were named; a reasoned row removed by hand was named again; restored by hand.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ts, parseSource, lineOf, walkEveryNode, unwrapExpression } from '../_shared/syntax-tree.mjs';
import { trackedSources } from './_sources.mjs';
import { splitStandalone } from '../_shared/standalone-split.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * The lowest operation bound a test may set on a real store without a reasoned row: 1000 ms. P1 (bundle-167's probe of
 * the space-act runner) saw a real wipe batch of the test seed take up to a few hundred ms on a throttled store; the floor
 * is that worst real batch times a margin of about three, and it is the figure the migrate tests already used to end a
 * real hung operation (`a-migrate-is-reported-audited-and-bounded-db`) without ending a real batch.
 */
const OPERATION_BOUND_FLOOR_MS = 1000;

/** The answer/wait axis: a figure whose name says it is how long a caller WAITS, ANSWERS or REPORTS — it ends no operation. */
const ANSWER_OR_WAIT = /ANSWER|WAIT|DRAIN|SLOW/i;

/**
 * Sub-floor operation bounds on a real store, each holding ONE operation and saying why nothing else meets it.
 * Matched by file, figure and value; a row that matches nothing is itself a failure (it outlived its site).
 */
const REASONED = [
  {
    file: 'testing/standalone/a-space-act-runner-runs-registers-and-retries-db.test.js', figure: 'SPACE_ACT_FS_MS', value: 40,
    holds: 'the FIRST act\'s file-tree step, held by an atFileTree hook that never resolves',
    why: 'SPACE_ACT_FS_MS bounds only the file-tree step (fileTree), and R-X6b resets it before the second act\'s real removal, so no real step runs under 40 ms',
  },
  {
    file: 'testing/standalone/a-filtered-recall-never-misses-a-match-db.test.js', figure: 'overrideStageTwoDeadlineForTest', value: 1,
    holds: 'stage two of a filtered recall, expired on purpose',
    why: 'the override reaches stage two alone (Q-142): stage one keeps its normal budget, so a slow host cannot end the stage whose hits the row asserts',
  },
  {
    file: 'testing/standalone/an-inbound-transfer-admitted-before-an-act-ends-before-the-act-deletes-db.test.js', figure: 'INBOUND_TRANSFER_MS', value: 100,
    holds: 'R-X5b\'s one upload, held open by the test (stalledUpload) so that the server must end it',
    why: 'INBOUND_TRANSFER_MS bounds inbound transfers alone, no store operation; the held upload is the only transfer the row opens, and the runner\'s knobs are reset after each row',
  },
];

const callName = (call) => {
  const e = unwrapExpression(call.expression);
  if (ts.isIdentifier(e)) return e.text;
  if (ts.isPropertyAccessExpression(e)) return e.name.text;
  return null;
};
const isFigureName = (name) => /(Ms|_MS)$/.test(name);
const propName = (p) => (p?.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)) ? p.name.text : null);
const fnName = (fn) => (fn.name && ts.isIdentifier(fn.name) ? fn.name.text
  : (fn.parent && ts.isVariableDeclaration(fn.parent) && ts.isIdentifier(fn.parent.name) ? fn.parent.name.text : null));

/** The object types (interfaces, and aliases of a type literal) declared in source file `file`, by name. */
function objectTypesOf(file, sf) {
  const types = new Map();
  walkEveryNode(sf, (n) => {
    if (ts.isInterfaceDeclaration(n)) types.set(n.name.text, n.members);
    else if (ts.isTypeAliasDeclaration(n) && ts.isTypeLiteralNode(n.type)) types.set(n.name.text, n.type.members);
  });
  return types;
}

/**
 * The members of the object type `name` as `file` sees it: declared there, or imported by name from a relative module (a setter's
 * figures may live beside the type its module exports, as the space act runner's knobs live in `space-act-contract.ts`).
 */
function membersOfType(file, sf, local, name) {
  if (local.has(name)) return local.get(name);
  for (const st of sf.statements) {
    if (!ts.isImportDeclaration(st) || !ts.isStringLiteral(st.moduleSpecifier) || !st.moduleSpecifier.text.startsWith('.')) continue;
    const named = st.importClause?.namedBindings;
    if (!named || !ts.isNamedImports(named) || !named.elements.some(e => e.name.text === name && (e.propertyName ?? e.name).text === name)) continue;
    const target = join(dirname(file), st.moduleSpecifier.text.replace(/\.js$/, '.ts')).replace(/\\/g, '/');
    let text;
    try { text = readFileSync(join(ROOT, target), 'utf8'); } catch { return []; }
    return objectTypesOf(target, parseSource(target, text)).get(name) ?? [];
  }
  return [];
}

/** Every exported `...ForTest` setter in server/src that takes a figure, with the figures it takes. */
function deriveSetters() {
  const files = trackedSources('server/src', { ext: ['.ts'], specs: false, floor: 100, root: ROOT });
  const setters = new Map();
  for (const file of files) {
    const text = readFileSync(join(ROOT, file), 'utf8');
    if (!text.includes('ForTest')) continue;
    const sf = parseSource(file, text);
    const types = objectTypesOf(file, sf);
    for (const st of sf.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name?.text.endsWith('ForTest')) continue;
      if (!st.modifiers?.some(m => m.kind === ts.SyntaxKind.ExportKeyword) || st.parameters.length === 0) continue;
      const t = st.parameters[0].type;
      const parts = t && ts.isUnionTypeNode(t) ? t.types : t ? [t] : [];
      for (const part of parts) {
        if (part.kind === ts.SyntaxKind.NumberKeyword) setters.set(st.name.text, { file, scalar: true, figures: new Set([st.name.text]) });
        if (!ts.isTypeReferenceNode(part)) continue;
        const ref = part.typeName.getText(sf) === 'Partial' && part.typeArguments?.[0] && ts.isTypeReferenceNode(part.typeArguments[0])
          ? part.typeArguments[0].typeName.getText(sf) : part.typeName.getText(sf);
        const figures = new Set(membersOfType(file, sf, types, ref)
          .filter(m => ts.isPropertySignature(m) && m.type?.kind === ts.SyntaxKind.NumberKeyword && isFigureName(propName(m) ?? ''))
          .map(propName));
        if (figures.size > 0) setters.set(st.name.text, { file, scalar: false, figures });
      }
    }
  }
  return setters;
}

const UNRESOLVED = Symbol('unresolved');
const RESTORE = Symbol('the caller\'s own value, put back');
const isObj = (v) => v && typeof v === 'object' && v.props instanceof Map;

/**
 * Resolves expressions in the testing sources to CANDIDATES: `{ v, at }`, where `v` is a number, a string, `null`, an
 * object (`{ props: Map<key, candidates> }`), RESTORE or UNRESOLVED, and `at` is the line that wrote it. Many candidates
 * when a variable is assigned more than once or a parameter is called with different figures.
 */
function makeResolver(trees) {
  const declsOf = new Map();   // file -> name -> declarations
  const callsOf = new Map();   // function name -> [{ file, call }]
  const assignsOf = new Map(); // file -> name -> [expression]
  for (const [f, sf] of trees) {
    const decls = new Map(); const assigns = new Map();
    walkEveryNode(sf, (n) => {
      if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name)) decls.set(n.name.text, [...(decls.get(n.name.text) ?? []), n]);
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(n.left)) {
        assigns.set(n.left.text, [...(assigns.get(n.left.text) ?? []), n.right]);
      }
      if (ts.isCallExpression(n) && callName(n)) callsOf.set(callName(n), [...(callsOf.get(callName(n)) ?? []), { file: f, call: n }]);
    });
    declsOf.set(f, decls); assignsOf.set(f, assigns);
  }
  const importers = (f) => {
    const base = f.split('/').pop();
    return new Set([f, ...[...trees].filter(([, sf]) => sf.statements.some(s => ts.isImportDeclaration(s)
      && ts.isStringLiteral(s.moduleSpecifier) && s.moduleSpecifier.text.split('/').pop() === base)).map(([g]) => g)]);
  };
  let paramsFollowed = 0;
  const at = (f, node) => `${f}:${lineOf(trees.get(f), node)}`;
  const one = (v, f, node) => [{ v, at: at(f, node) }];

  /**
   * What `name` at `node` is bound to, by lexical scope, innermost first: `{ param: { fn, index, prop, init } }` for a
   * function's parameter (plain or destructured), `{ decl }` for a variable declared in an enclosing block or loop head,
   * `null` when nothing in scope declares it.
   */
  function bindingOf(node, name) {
    const declIn = (list) => list?.declarations?.find(d => ts.isIdentifier(d.name) && d.name.text === name);
    for (let n = node.parent; n; n = n.parent) {
      if ((ts.isForOfStatement(n) || ts.isForInStatement(n) || ts.isForStatement(n)) && n.initializer && ts.isVariableDeclarationList(n.initializer)) {
        const d = declIn(n.initializer); if (d) return { decl: d };
      }
      if (ts.isBlock(n) || ts.isSourceFile(n) || ts.isModuleBlock(n) || ts.isCaseClause(n) || ts.isDefaultClause(n)) {
        for (const st of n.statements) {
          const d = ts.isVariableStatement(st) ? declIn(st.declarationList) : undefined; if (d) return { decl: d };
        }
      }
      if (!ts.isFunctionLike(n) || ts.isSourceFile(n)) continue;
      for (const [index, p] of n.parameters.entries()) {
        if (ts.isIdentifier(p.name) && p.name.text === name) return { param: { fn: n, index, prop: null, init: p.initializer } };
        if (ts.isObjectBindingPattern(p.name)) {
          for (const el of p.name.elements) {
            if (ts.isIdentifier(el.name) && el.name.text === name) {
              return { param: { fn: n, index, prop: el.propertyName ? el.propertyName.getText() : name, init: el.initializer } };
            }
          }
        }
      }
    }
    return null;
  }

  function fromParam(f, node, param, seen) {
    const name = fnName(param.fn);
    const key = `${f}:${name}:${param.index}:${param.prop}`;
    if (!name || seen.has(key)) return [];
    seen = new Set([...seen, key]);
    paramsFollowed++;
    const out = [];
    const scope = importers(f);
    for (const { file, call } of callsOf.get(name) ?? []) {
      if (!scope.has(file)) continue;
      const arg = call.arguments[param.index];
      const given = arg ? value(file, arg, seen) : [];
      if (param.prop === null) {
        out.push(...(arg ? given : param.init ? value(f, param.init, seen) : one(UNRESOLVED, file, call)));
        continue;
      }
      for (const c of given.length ? given : [{ v: { props: new Map() }, at: at(file, call) }]) {
        if (!isObj(c.v)) { out.push({ v: UNRESOLVED, at: c.at }); continue; }
        if (c.v.props.has(param.prop)) out.push(...c.v.props.get(param.prop));
        else if (param.init) out.push(...value(f, param.init, seen));
      }
    }
    return out;
  }

  function identifier(f, e, seen) {
    const bound = bindingOf(e, e.text);
    if (bound?.param) return fromParam(f, e, bound.param, seen);
    // Declared in no enclosing scope (a module-level name read from a hoisted function): only a name declared ONCE is read.
    const decls = declsOf.get(f).get(e.text) ?? [];
    const d = bound?.decl ?? (decls.length === 1 ? decls[0] : null);
    if (!d) return one(UNRESOLVED, f, e);
    const forOf = d.parent?.parent;
    if (forOf && ts.isForOfStatement(forOf) && forOf.initializer === d.parent) {
      const list = unwrapExpression(forOf.expression);
      return ts.isArrayLiteralExpression(list) ? list.elements.flatMap(el => value(f, el, seen)) : one(UNRESOLVED, f, e);
    }
    const isConst = (d.parent.flags & ts.NodeFlags.Const) !== 0;
    const inits = [...(d.initializer ? [d.initializer] : []), ...(isConst ? [] : assignsOf.get(f).get(e.text) ?? [])];
    return inits.length ? inits.flatMap(i => value(f, i, seen)) : one(UNRESOLVED, f, e);
  }

  function value(f, node, seen = new Set()) {
    const e = unwrapExpression(node);
    const sf = trees.get(f);
    if (!e) return [];
    if (ts.isNumericLiteral(e)) return one(Number(e.text.replace(/_/g, '')), f, e);
    if (ts.isStringLiteral(e) || ts.isNoSubstitutionTemplateLiteral(e)) return one(e.text, f, e);
    if (e.kind === ts.SyntaxKind.NullKeyword) return one(null, f, e);
    if ((ts.isElementAccessExpression(e) || ts.isPropertyAccessExpression(e)) && e.expression.getText(sf) === 'process.env') return one(RESTORE, f, e);
    if (ts.isPrefixUnaryExpression(e) && e.operator === ts.SyntaxKind.MinusToken) {
      return value(f, e.operand, seen).map(c => ({ ...c, v: typeof c.v === 'number' ? -c.v : UNRESOLVED }));
    }
    if (ts.isBinaryExpression(e)) {
      const ops = {
        [ts.SyntaxKind.PlusToken]: (a, b) => a + b, [ts.SyntaxKind.MinusToken]: (a, b) => a - b,
        [ts.SyntaxKind.AsteriskToken]: (a, b) => a * b, [ts.SyntaxKind.SlashToken]: (a, b) => a / b,
      };
      const op = ops[e.operatorToken.kind];
      const out = [];
      for (const a of value(f, e.left, seen)) for (const b of value(f, e.right, seen)) {
        out.push({ v: op && typeof a.v === 'number' && typeof b.v === 'number' ? op(a.v, b.v) : UNRESOLVED, at: at(f, e) });
      }
      return out;
    }
    if (ts.isCallExpression(e) && ['String', 'Number'].includes(callName(e)) && e.arguments.length === 1) return value(f, e.arguments[0], seen);
    if (ts.isIdentifier(e)) return identifier(f, e, seen);
    if (ts.isPropertyAccessExpression(e)) {
      return value(f, e.expression, seen).flatMap(c => (isObj(c.v) && c.v.props.has(e.name.text) ? c.v.props.get(e.name.text) : [{ v: UNRESOLVED, at: c.at }]));
    }
    if (ts.isObjectLiteralExpression(e)) {
      const props = new Map();
      for (const p of e.properties) {
        if (ts.isSpreadAssignment(p)) {
          for (const c of value(f, p.expression, seen)) {
            if (isObj(c.v)) for (const [k, v] of c.v.props) props.set(k, [...(props.get(k) ?? []), ...v]);
            else props.set('…spread', one(UNRESOLVED, f, p));
          }
        } else if (ts.isShorthandPropertyAssignment(p)) props.set(p.name.text, value(f, p.name, seen));
        else if (ts.isPropertyAssignment(p)) {
          const key = propName(p);
          props.set(key ?? `[${p.name.getText(sf)}]`, key ? value(f, p.initializer, seen) : one(UNRESOLVED, f, p));
        } else props.set('…method', one(UNRESOLVED, f, p));
      }
      return one({ props }, f, e);
    }
    return one(UNRESOLVED, f, e);
  }
  return { value, paramsFollowed: () => paramsFollowed };
}

/** Every figure a test sets: file and line that wrote it, the setter, figure name, value, axis, and whether it reaches a real store. */
function deriveSites(setters) {
  const testFiles = trackedSources('testing', { ext: ['.js', '.mjs'], floor: 300, root: ROOT, untracked: true });
  const trees = new Map(testFiles.map(f => [f, parseSource(f, readFileSync(join(ROOT, f), 'utf8'))]));
  const split = splitStandalone({ root: ROOT });
  const storeTests = new Set([...split.offlineDb, ...split.needsInstance].map(f => `testing/standalone/${f}`));
  // A helper reaches a real store when a store-backed test imports it.
  const storeHelpers = new Set();
  for (const f of storeTests) {
    walkEveryNode(trees.get(f), (n) => {
      if (ts.isImportDeclaration(n) && ts.isStringLiteral(n.moduleSpecifier)) storeHelpers.add(n.moduleSpecifier.text.split('/').pop());
    });
  }
  const reachesStore = (f) => storeTests.has(f) || (!f.endsWith('.test.js') && storeHelpers.has(f.split('/').pop()));
  const { value, paramsFollowed } = makeResolver(trees);

  const found = new Map();
  let calls = 0;
  const add = (site, setter, figure, c) => {
    const [file, line] = [c.at.slice(0, c.at.lastIndexOf(':')), Number(c.at.slice(c.at.lastIndexOf(':') + 1))];
    let v = c.v;
    if (typeof v === 'string') v = /^\d+$/.test(v) ? Number(v) : UNRESOLVED;
    if (isObj(v)) v = UNRESOLVED;
    const key = `${c.at} ${figure} ${String(v)}`;
    if (!found.has(key)) {
      found.set(key, {
        file, line, setter, figure, value: v, via: site,
        store: reachesStore(file) || reachesStore(site.split(':')[0]),
        axis: ANSWER_OR_WAIT.test(figure) ? 'answer-or-wait' : 'operation',
      });
    }
  };
  for (const [f, sf] of trees) {
    walkEveryNode(sf, (n) => {
      if (ts.isCallExpression(n) && setters.has(callName(n))) {
        calls++;
        const setter = setters.get(callName(n));
        const site = `${f}:${lineOf(sf, n)}`;
        for (const c of n.arguments.length ? value(f, n.arguments[0]) : [{ v: UNRESOLVED, at: site }]) {
          if (c.v === null) continue;   // a reset puts the production figure back
          if (setter.scalar) { add(site, callName(n), callName(n), c); continue; }
          if (!isObj(c.v)) { add(site, callName(n), '(the whole argument)', { ...c, v: UNRESOLVED }); continue; }
          for (const [k, cs] of c.v.props) {
            if (setter.figures.has(k) || k.startsWith('[') || k.startsWith('…')) for (const kc of cs) add(site, callName(n), k, kc);
          }
        }
      }
      if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const l = n.left;
        if ((ts.isElementAccessExpression(l) || ts.isPropertyAccessExpression(l)) && l.expression.getText(sf) === 'process.env') {
          const site = `${f}:${lineOf(sf, n)}`;
          const names = ts.isPropertyAccessExpression(l) ? [{ v: l.name.text, at: site }] : value(f, l.argumentExpression);
          for (const k of names) {
            if (typeof k.v !== 'string') add(site, 'process.env', '(a computed name)', { v: UNRESOLVED, at: site });
            else if (isFigureName(k.v)) for (const c of value(f, n.right)) add(site, 'process.env', k.v, c);
          }
        }
      }
      if (ts.isObjectLiteralExpression(n) && n.properties.some(p => ts.isSpreadAssignment(p) && p.expression.getText(sf) === 'process.env')) {
        for (const p of n.properties) {
          const key = ts.isPropertyAssignment(p) ? propName(p) : null;
          if (key && isFigureName(key)) for (const c of value(f, p.initializer)) add(`${f}:${lineOf(sf, p)}`, 'env', key, c);
        }
      }
    });
  }
  return { sites: [...found.values()], calls, paramsFollowed: paramsFollowed() };
}

const setters = deriveSetters();
const { sites, calls, paramsFollowed } = deriveSites(setters);
const judged = sites.filter(s => s.store && s.axis === 'operation');
const show = (s) => `${s.file}:${s.line} ${s.setter} ${s.figure} = ${s.value === UNRESOLVED ? '(unresolved)' : s.value === RESTORE ? '(restore)' : s.value}`
  + (s.via.startsWith(`${s.file}:${s.line}`) ? '' : ` (set at ${s.via})`);
const subFloor = judged.filter(s => typeof s.value === 'number' && s.value < OPERATION_BOUND_FLOOR_MS);
const rowFor = (s) => REASONED.find(r => r.file === s.file && r.figure === s.figure && r.value === s.value);

describe('a test bounds only the operation it holds: no operation bound on a real store below the floor without a reasoned row (Q-578)', () => {
  it('the derivation found the setters, the figures handed through parameters, and the sites (floors)', (t) => {
    t.diagnostic(`${setters.size} setters (${[...setters.keys()].join(', ')}); ${calls} setter calls; ${paramsFollowed} parameters followed; `
      + `${sites.length} figures, ${judged.length} operation bounds on a real store, ${subFloor.length} below the floor, ${REASONED.length} reasoned rows`);
    assert.ok(setters.size >= 4, `only ${setters.size} figure setter(s) derived from server/src (${[...setters.keys()].join(', ')}): the shape scan is broken`);
    assert.ok(paramsFollowed >= 2, `only ${paramsFollowed} parameter(s) followed to their callers: a wrapper that hands a figure through is not being read`);
    assert.ok(calls >= 60, `only ${calls} setter call(s) found in testing/: the site scan is broken`);
    assert.ok(judged.length >= 20, `only ${judged.length} operation bound(s) on a real store found: the classification is broken`);
  });

  it('every operation bound set on a real store resolves to a figure', () => {
    const lost = judged.filter(s => s.value === UNRESOLVED);
    assert.deepEqual(lost.map(show), [], 'a figure the gate cannot read is a figure it did not check: make it a literal or a variable declared once in the file');
  });

  it(`every operation bound on a real store is at least ${OPERATION_BOUND_FLOOR_MS} ms, or holds one operation by a reasoned row`, () => {
    const bare = subFloor.filter(s => !rowFor(s));
    assert.deepEqual(bare.map(show), [],
      `these bound every real operation of the step, not only the one the test holds: raise the figure to ${OPERATION_BOUND_FLOOR_MS} ms `
      + 'and hold the operation the test needs ended (a hook that never resolves, a stalled view), or add a reasoned row');
  });

  it('every reasoned row still matches a site, and says what it holds and why only that', () => {
    for (const r of REASONED) {
      assert.ok(r.holds && r.why, `row ${r.file} ${r.figure} gives no reason`);
      assert.ok(subFloor.some(s => rowFor(s) === r), `row ${r.file} ${r.figure} = ${r.value} matches no sub-floor site: remove it`);
    }
  });
});
