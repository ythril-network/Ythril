/**
 * Every call that asks the schema validator about an EDGE hands it the resolved ends, or says in code why it has none (Q-443).
 *
 * ## The rule
 *
 * `validateEdge` checks `endpoints` only for an end whose type the caller resolved and `functional` only when the caller counted the
 * subject's other edges; an absent field is "not looked", never a violation. So a call that hands it nothing is silent about two rules
 * of the schema, and nothing in the output says so: the arrival recorder was exactly that for as long as it was written
 * (`violationsOfRecord` built the view and called `validateEdge(meta, view)`), and its statistic under-reported without a line.
 *
 * Every call site of the validator (and of `violationsOfRecord`, the one switch by kind, when its kind can be an edge) is therefore held to
 * ONE of three things in its ends argument:
 *
 *  - an expression the caller RESOLVED (a call to the resolver, an object built from what it read, a variable holding one);
 *  - a parameter of the function it sits in, forwarded: that function is then a subject itself, and ITS callers are held to the same rule
 *    (`classifyEdgeUpsertAgainst` defaults the parameter to `{}`, so a caller that left it out would be a call with no ends the default hid);
 *  - `endsNotResolved('<reason>')`, whose reason is a string literal that is not blank: the site says why it has no ends where a reviewer reads it.
 *
 * Not accepted: no argument, `{}`, a variable initialised to `{}`, `undefined` / `null`.
 *
 * ## Where the subjects come from
 *
 * Derived through the server's type-checked program (`_shared/server-program.mjs`, floor inside): every call whose callee RESOLVES, through
 * an import, a re-export or a `const` alias, to a subject; and, to a fixed point, every function that forwards one of its own parameters
 * into a subject's ends slot. A call of `violationsOfRecord` whose kind argument is a literal other than `'edge'` is not about an edge and
 * needs no ends. The floors below are floors, not counts: the gate holds the rule over whatever sites exist.
 *
 * ## What it does not claim
 *
 * That the ends a site resolves are the RIGHT ones. It holds that a site cannot hand none by accident; the arrival's own cases are
 * `an-arriving-edge-is-recorded-against-its-endpoint-and-functional-rules-db`.
 *
 * ## Seen red
 *
 * Before Q-443 it names the arrival recorder's two `violationsOfRecord` calls, the validate door's two, the extraction validator's `{}` and
 * `violationsOfRecord`'s own `validateEdge` call. After the fix it is seen red again by dropping the ends from the recorder's call, by an
 * empty reason, and by a caller of the forwarding wrapper that leaves its ends out.
 *
 * Run: node --test testing/standalone/every-edge-validation-is-handed-its-ends-or-says-why.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ts, parseSource, lineOf } from '../_shared/syntax-tree.mjs';
import { serverProgram } from '../_shared/server-program.mjs';

/** The validator entry points, each with the position of its ends argument. */
const ENDS_SLOT = Object.freeze({ validateEdge: 2, violationsOfRecord: 3 });
/** The function a caller says "no ends, and why" with. */
const NO_ENDS = 'endsNotResolved';

/** Fewer sites than this, or in fewer files, and the derivation is broken, not the tree: a loop over nothing passes. */
const SITES_FLOOR = 5;
const FILES_FLOOR = 3;

/**
 * @param {import('typescript').TypeChecker} checker
 * @param {import('typescript').SourceFile[]} sources  every source to look in
 * @param {import('typescript').SourceFile[]} homes    the sources the validator and `endsNotResolved` are declared in
 * @param {(sf: import('typescript').SourceFile) => string} nameOf  the name findings are reported under
 * @returns {{ sites: Array<{ file: string, line: number, callee: string, via: string | null, verdict: string | null }>, subjects: string[] }}
 */
function edgeValidationSites(checker, sources, homes, nameOf) {
  const subjects = new Map();   // symbol -> { name, index, via }
  let noEnds;
  for (const home of homes) {
    for (const st of home.statements) {
      if (!ts.isFunctionDeclaration(st) || !st.name) continue;
      const sym = checker.getSymbolAtLocation(st.name);
      if (!sym) continue;
      if (st.name.text in ENDS_SLOT) subjects.set(sym, { name: st.name.text, index: ENDS_SLOT[st.name.text], via: null });
      if (st.name.text === NO_ENDS) noEnds = sym;
    }
  }
  assert.ok(subjects.size === Object.keys(ENDS_SLOT).length, `the validator's declarations were not found: ${[...subjects.values()].map(s => s.name)}`);

  /** The symbol a callee names, followed through imports, re-exports and `const alias = other` — or undefined. */
  const resolve = (expr, depth = 0) => {
    let sym;
    if (ts.isIdentifier(expr)) sym = checker.getSymbolAtLocation(expr);
    else if (ts.isPropertyAccessExpression(expr)) sym = checker.getSymbolAtLocation(expr.name);
    else if (ts.isParenthesizedExpression(expr) || ts.isNonNullExpression(expr)) return resolve(expr.expression, depth);
    if (!sym) return undefined;
    while (sym.flags & ts.SymbolFlags.Alias) sym = checker.getAliasedSymbol(sym);
    const decl = sym.valueDeclaration;
    if (decl && ts.isVariableDeclaration(decl) && decl.initializer && depth < 6
      && (ts.isIdentifier(decl.initializer) || ts.isPropertyAccessExpression(decl.initializer))) {
      return resolve(decl.initializer, depth + 1) ?? sym;
    }
    return sym;
  };

  const calls = [];
  for (const sf of sources) {
    const walk = (n) => { if (ts.isCallExpression(n)) calls.push({ sf, call: n }); ts.forEachChild(n, walk); };
    walk(sf);
  }

  /** The literal values a kind argument can take, or null when it is not a closed set of string literals. */
  const kindsOf = (arg) => {
    const t = checker.getTypeAtLocation(arg);
    const parts = t.isUnion() ? t.types : [t];
    return parts.every(p => p.isStringLiteral()) ? parts.map(p => p.value) : null;
  };

  const isEmptyLiteral = (e) => ts.isObjectLiteralExpression(e) && e.properties.length === 0;

  /** What is wrong with the ends argument of this call, or null. A forwarded parameter reports `{ forwarded }` to make its function a subject. */
  const verdictOf = (call, index) => {
    const arg = call.arguments[index];
    if (!arg) return { problem: `no ends argument (position ${index + 1})` };
    const e = ts.isAsExpression(arg) || ts.isParenthesizedExpression(arg) ? arg.expression : arg;
    if (isEmptyLiteral(e)) return { problem: 'the ends are an empty `{}`' };
    if (e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined')) return { problem: 'the ends are `undefined` / `null`' };
    if (ts.isIdentifier(e)) {
      const decl = checker.getSymbolAtLocation(e)?.valueDeclaration;
      if (decl && ts.isVariableDeclaration(decl) && decl.initializer && isEmptyLiteral(decl.initializer)) {
        return { problem: `the ends are \`${e.text}\`, a variable initialised to \`{}\`` };
      }
      if (decl && ts.isParameter(decl)) return { forwarded: decl };
    }
    if (ts.isCallExpression(e) && noEnds && resolve(e.expression) === noEnds) {
      const why = e.arguments[0];
      const text = why && (ts.isStringLiteral(why) || ts.isNoSubstitutionTemplateLiteral(why)) ? why.text : null;
      if (text === null || text.trim() === '') return { problem: `\`${NO_ENDS}\` is not given a non-blank string literal reason` };
    }
    return {};
  };

  const sites = [];
  const seen = new Set();
  for (let changed = true; changed;) {
    changed = false;
    for (const { sf, call } of calls) {
      const callee = resolve(call.expression);
      const subject = callee && subjects.get(callee);
      if (!subject || seen.has(call)) continue;
      // A call of the switch by kind whose kind is a literal other than 'edge' is not about an edge.
      if (subject.name === 'violationsOfRecord' && call.arguments[1]) {
        const kinds = kindsOf(call.arguments[1]);
        if (kinds && !kinds.includes('edge')) continue;
      }
      seen.add(call);
      const v = verdictOf(call, subject.index);
      if ('forwarded' in v) {
        // The ends are a parameter of the function this call sits in: that function is a subject, its callers are held to the rule.
        const fn = v.forwarded.parent;
        const sym = fn.name ? checker.getSymbolAtLocation(fn.name)
          : (ts.isVariableDeclaration(fn.parent) ? checker.getSymbolAtLocation(fn.parent.name) : undefined);
        if (!sym) {
          sites.push({ file: nameOf(sf), line: lineOf(sf, call), callee: subject.name, via: subject.via, verdict: 'the ends are a parameter of a function with no name to follow its callers by' });
        } else {
          sites.push({ file: nameOf(sf), line: lineOf(sf, call), callee: subject.name, via: subject.via, verdict: null });
          if (!subjects.has(sym)) {
            subjects.set(sym, { name: sym.name, index: fn.parameters.indexOf(v.forwarded), via: subject.name });
            changed = true;
          }
        }
        continue;
      }
      sites.push({ file: nameOf(sf), line: lineOf(sf, call), callee: subject.name, via: subject.via, verdict: v.problem ?? null });
    }
  }
  return { sites, subjects: [...subjects.values()].map(s => s.name) };
}

/** A snippet type-checked on its own: the validator and `endsNotResolved` are declared in it, so its callers are the tree's. */
function snippet(code) {
  const name = 'snippet.ts';
  const options = { noLib: true, noResolve: true, target: ts.ScriptTarget.ES2022, strict: true };
  const host = ts.createCompilerHost(options);
  const sf = parseSource(name, code);
  host.getSourceFile = (f) => (f === name ? sf : undefined);
  host.fileExists = (f) => f === name;
  host.readFile = (f) => (f === name ? code : undefined);
  const program = ts.createProgram({ rootNames: [name], options, host });
  const file = program.getSourceFile(name);
  return edgeValidationSites(program.getTypeChecker(), [file], [file], () => name);
}

const PRELUDE = `
type Kind = 'entity' | 'edge' | 'fact';
interface Ends { fromType?: string | null }
declare function validateEdge(meta: object, record: object, resolved?: Ends): string[];
declare function violationsOfRecord(meta: object, kind: Kind, record: object, ends?: Ends): string[];
declare function endsNotResolved(reason: string): Ends;
declare function resolveEnds(): Ends;
`;
const problemsOf = (code) => snippet(PRELUDE + code).sites.filter(s => s.verdict !== null).map(s => s.verdict);

describe('the rule, on literal snippets', () => {
  it('accepts a resolved expression, a stated reason, and a forwarded parameter whose callers pass ends', () => {
    assert.deepEqual(problemsOf(`
      function a(m: object, r: object) { return validateEdge(m, r, resolveEnds()); }
      function b(m: object, r: object) { return violationsOfRecord(m, 'edge', r, endsNotResolved('a sample is the caller\\'s own record')); }
      function c(m: object, r: object, ends: Ends) { return validateEdge(m, r, ends); }
      function d(m: object, r: object) { return c(m, r, resolveEnds()); }
    `), []);
  });

  it('refuses no argument, an empty literal, a variable initialised to {}, undefined, and an unexplained endsNotResolved', () => {
    const cases = {
      'no argument': 'function f(m: object, r: object) { return validateEdge(m, r); }',
      'empty literal': 'function f(m: object, r: object) { return validateEdge(m, r, {}); }',
      'variable initialised to {}': 'function f(m: object, r: object) { const e = {}; return validateEdge(m, r, e); }',
      'undefined': 'function f(m: object, r: object) { return validateEdge(m, r, undefined); }',
      'a blank reason': 'function f(m: object, r: object) { return violationsOfRecord(m, \'edge\', r, endsNotResolved(\'  \')); }',
      'a reason that is not a literal': 'function f(m: object, r: object, why: string) { return violationsOfRecord(m, \'edge\', r, endsNotResolved(why)); }',
      'violationsOfRecord with no ends, for a kind that can be an edge': 'function f(m: object, r: object, k: Kind) { return violationsOfRecord(m, k, r); }',
    };
    for (const [what, code] of Object.entries(cases)) assert.equal(problemsOf(code).length, 1, `${what} was not refused: ${code}`);
  });

  it('does not ask a literal non-edge kind for ends', () => {
    assert.deepEqual(problemsOf('function f(m: object, r: object) { return violationsOfRecord(m, \'entity\', r); }'), []);
    assert.equal(problemsOf('function f(m: object, r: object, k: \'entity\' | \'edge\') { return violationsOfRecord(m, k, r); }').length, 1);
  });

  it('follows an alias, and a forwarding wrapper to its callers', () => {
    assert.equal(problemsOf('const v = validateEdge; function f(m: object, r: object) { return v(m, r); }').length, 1, 'an alias hid the call');
    const wrapped = `
      function wrap(m: object, r: object, resolved: Ends = {}) { return validateEdge(m, r, resolved); }
      function leaves(m: object, r: object) { return wrap(m, r); }
      function gives(m: object, r: object) { return wrap(m, r, resolveEnds()); }
    `;
    const found = snippet(PRELUDE + wrapped).sites;
    assert.deepEqual(found.filter(s => s.verdict !== null).map(s => s.via), ['validateEdge'], 'the caller of the wrapper that leaves its ends out was not found');
    assert.equal(found.filter(s => s.callee === 'wrap').length, 2, 'the wrapper was not made a subject');
  });

  it('a parameter of an unnamed function cannot be followed, and is refused', () => {
    assert.equal(problemsOf('function f(m: object, r: object) { return [1].map((ends: Ends) => validateEdge(m, r, ends)); }').length, 1);
  });
});

describe('every edge validation is handed its ends or says why', () => {
  const { checker, serverSources, sourceOf, repoPath } = serverProgram();
  const HOME = 'server/src/spaces/schema-validation.ts';
  const found = edgeValidationSites(checker, serverSources(), [sourceOf.get(HOME)], (sf) => repoPath(sf.fileName));
  const bySite = (s) => `${s.file}:${s.line} (${s.via ? `${s.callee}, forwarded by ${s.via}` : s.callee})`;

  it('finds the sites: at least the floors, in at least the floor of files', () => {
    const files = new Set(found.sites.map(s => s.file));
    assert.ok(found.sites.length >= SITES_FLOOR, `only ${found.sites.length} call site(s) were derived: the derivation is broken`);
    assert.ok(files.size >= FILES_FLOOR, `the sites sit in only ${files.size} file(s): the derivation is broken`);
    assert.ok(found.subjects.length > Object.keys(ENDS_SLOT).length, 'no forwarding wrapper was derived: the wrapper half of the derivation is broken');
  });

  it('every site hands its ends, or says why it has none', () => {
    const bad = found.sites.filter(s => s.verdict !== null);
    assert.deepEqual(bad.map(s => `${bySite(s)}: ${s.verdict}`), [], 'a call asks the validator about an edge and hands it no ends: '
      + 'the rules `endpoints` and `functional` are then never checked there, and nothing says so. Resolve them, or `endsNotResolved(\'<why>\')`');
  });
});
