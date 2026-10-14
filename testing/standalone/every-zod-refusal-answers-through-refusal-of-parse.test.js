/**
 * Every failure of a zod parse that is ANSWERED or LOGGED goes through `refusalOfParse` — and the gate that says so
 * is derived from the parse calls, not from the text of one spelling (`Q-362`, R5-4, R6-11, R6-16 testing S10).
 *
 * ## What the first version of this question got wrong
 *
 * "Refuse any `.error.message` that is not passed to `refusalOfParse`" starts from a SPELLING, and a spelling has
 * false positives and false negatives. Measured on the tree: 126 `parse(` hits are `Date.parse` and `JSON.parse`;
 * `parsed.error.issues`, `.format()`, `.flatten()` and `const { error } = …` are the same leak in other words; and a
 * helper that takes `parsed.error` (`files/peer-tombstone-apply.ts`) reads it somewhere no regex over the call
 * site sees. A provider's error object (`embedding.ts`, `providers.ts`, `backup-config.ts`) has an `.error.message`
 * that is not zod's at all.
 *
 * ## What is derived, and how
 *
 *  - **The subjects** are the call expressions `X.safeParse(…)` / `X.parse(…)` (and their async forms) whose receiver's
 *    TYPE is a zod schema, from the compiler's checker over the server program — so `JSON.parse` and `Date.parse` are
 *    not subjects and a schema passed as a parameter (`arrival-shape.ts`) is.
 *  - **The failure's handle** is whatever the call's result is bound to: a variable, a destructured `error`, a chained
 *    `.error`, or — for a throwing `parse` inside a `try` — the catch clause's variable. Every READ of that handle is
 *    judged by structure: a read of the failure's `.error` (or of a destructured/caught error) is allowed only as the
 *    argument of `refusalOfParse(…)`. Reading it into a `const`, a template, `.message`, `.issues`, `.format()`, handing
 *    it to a helper, or passing the whole result on are each refused, because each puts zod's text or its issue array
 *    somewhere `refusalOfParse` does not bound.
 *  - **The failure branch** (`if (!r.success) {…}`, the else of `if (r.success)`, the false arm of `r.success ? … : …`)
 *    is found by structure and reported with each site, so a failure names the branch that leaks and not only the line.
 *  - **The named exemption class, `DISCARDED_BY_DESIGN`**: a site whose failure is never read at all — a boolean test
 *    (`schema.safeParse(x).success`), or a branch that returns a fixed sentence or drops the item (`effectiveMeta`
 *    skipping an invalid layer). Nothing of zod reaches an answer or a line from one, so the class needs no rewrite.
 *    It is DERIVED (no read of the failure) rather than listed; a site that moves out of it by starting to read
 *    the error is judged like any other.
 *
 * The gate has a floor on the subjects it found, and `the gate flags what it is meant to flag` below runs the same
 * analysis over a fixture program with one site per way of leaking and one clean site per class, so the rule is seen
 * to fail on each shape without anyone having to put a leak back into the product.
 *
 * ## Seen red
 *
 * On 85c4c564 `util/log.ts` has no `refusalOfParse` and every site that reads its failure (the large majority of the
 * seventy-odd) answers `error.message` or `error.issues`; the first case names them.
 *
 * Run: node --test testing/standalone/every-zod-refusal-answers-through-refusal-of-parse.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import ts from 'typescript';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const PARSE_METHODS = new Set(['parse', 'safeParse', 'parseAsync', 'safeParseAsync']);
const THROWING = new Set(['parse', 'parseAsync']);
const REFUSAL = 'refusalOfParse';
const posix = p => p.split(sep).join('/');

/** A zod schema, by what the checker says it can do — not by what the variable is called. */
function isZodSchema(checker, node) {
  // The APPARENT type: a schema passed as a type parameter (`arrival-shape.ts`) is judged by its constraint.
  const t = checker.getApparentType(checker.getTypeAtLocation(node));
  const has = name => t.getProperty(name) !== undefined || (t.isUnion() && t.types.every(u => u.getProperty(name) !== undefined));
  // `safeParse` is the zod idiom, and a schema handed on as a narrow interface (`SafeParser`, `arrival-shape.ts`) has
  // nothing else; a throwing `parse` is a subject only on a receiver that also has `safeParse`, which `JSON` and `Date` lack.
  return has('safeParse');
}

/** `node` is the first argument of a call to `refusalOfParse` (however it was imported). */
function isRefusalArgument(node) {
  const call = node.parent;
  if (!ts.isCallExpression(call) || call.arguments[0] !== node) return false;
  const callee = call.expression;
  return (ts.isIdentifier(callee) && callee.text === REFUSAL) || (ts.isPropertyAccessExpression(callee) && callee.name.text === REFUSAL);
}

const climb = (node) => {
  let n = node;
  while (n.parent && (ts.isAwaitExpression(n.parent) || ts.isParenthesizedExpression(n.parent) || ts.isNonNullExpression(n.parent) || ts.isAsExpression(n.parent))) n = n.parent;
  return n;
};

/** Every identifier under `root` that resolves to `symbol`, except its declaring name. */
function referencesTo(checker, root, symbol) {
  const out = [];
  (function walk(n) {
    if (ts.isIdentifier(n) && checker.getSymbolAtLocation(n) === symbol) out.push(n);
    ts.forEachChild(n, walk);
  })(root);
  return out;
}

/** The nearest function-like or source-file scope holding `node`. */
function scopeOf(node) {
  let n = node.parent;
  while (n && !ts.isFunctionLike(n) && !ts.isSourceFile(n)) n = n.parent;
  return n;
}

const where = (sf, node) => `${sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1}`;

/**
 * Judge one read of a result variable. A property read is `success` / `data` (fine) or `error` (judged); the
 * identifier handed on whole, spread or returned is a read nobody can follow.
 */
function judgeResultRead(id, sf) {
  const p = id.parent;
  if (ts.isPropertyAccessExpression(p) && p.expression === id) {
    const prop = p.name.text;
    if (prop === 'success' || prop === 'data') return null;
    if (prop === 'error') return isRefusalArgument(p) ? null : `line ${where(sf, p)}: \`${p.parent.getText(sf).slice(0, 70)}\` reads the failure outside ${REFUSAL}`;
    return `line ${where(sf, p)}: reads \`.${prop}\` of the parse result`;
  }
  return `line ${where(sf, id)}: the whole parse result is used as \`${p.getText(sf).slice(0, 60)}\`, so what is done with its error cannot be followed`;
}

/** The failure branch of `r.success` read at `access`, found by structure; `null` when the result is not branched on. */
function failureBranchOf(access) {
  const p = access.parent;
  if (ts.isPrefixUnaryExpression(p) && p.operator === ts.SyntaxKind.ExclamationToken && ts.isIfStatement(climb(p).parent)) return climb(p).parent.thenStatement;
  if (ts.isBinaryExpression(p) && p.right.kind === ts.SyntaxKind.FalseKeyword && ts.isIfStatement(p.parent)) return p.parent.thenStatement;
  if (ts.isIfStatement(p) && p.expression === access) return p.elseStatement ?? null;
  if (ts.isConditionalExpression(p) && p.condition === access) return p.whenFalse;
  if (ts.isPrefixUnaryExpression(p) && ts.isConditionalExpression(climb(p).parent)) return climb(p).parent.whenTrue;
  return null;
}

/**
 * Every zod parse in `program` that `include` accepts, with what its failure is used for.
 *
 * @returns {{ file: string, line: string, method: string, branch: string|null, leaks: string[], discarded: boolean }[]}
 */
export function zodParseSites(program, include) {
  const checker = program.getTypeChecker();
  const sites = [];
  for (const sf of program.getSourceFiles()) {
    const file = include(sf);
    if (!file) continue;
    (function visit(n) {
      if (ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && PARSE_METHODS.has(n.expression.name.text)
        && isZodSchema(checker, n.expression.expression)) {
        sites.push(judgeSite(checker, sf, file, n));
      }
      ts.forEachChild(n, visit);
    })(sf);
  }
  return sites;
}

function judgeSite(checker, sf, file, call) {
  const method = call.expression.name.text;
  const site = { file, line: where(sf, call), method, branch: null, leaks: [], discarded: false };
  const top = climb(call);
  const holder = top.parent;
  const reads = [];   // each read of the failure that is not allowed

  const scanResult = (symbol, scope, { destructuredError }) => {
    for (const id of referencesTo(checker, scope, symbol)) {
      if (ts.isBindingElement(id.parent) && id.parent.name === id) continue;
      if (ts.isVariableDeclaration(id.parent) && id.parent.name === id) continue;
      if (destructuredError) {
        const ok = isRefusalArgument(id);
        if (!ok) reads.push(`line ${where(sf, id)}: the destructured failure \`${id.parent.getText(sf).slice(0, 60)}\` is read outside ${REFUSAL}`);
      } else {
        const verdict = judgeResultRead(id, sf);
        if (verdict) reads.push(verdict);
        if (ts.isPropertyAccessExpression(id.parent) && id.parent.name.text === 'success' && site.branch === null) {
          const b = failureBranchOf(id.parent);
          if (b) site.branch = b.getText(sf);
        }
      }
    }
  };

  if (THROWING.has(method)) {
    // A throwing parse: the failure is whatever the enclosing `try`'s catch variable holds. No try, it propagates.
    let n = call.parent;
    let tryStmt = null;
    while (n && !ts.isFunctionLike(n)) {
      if (ts.isTryStatement(n) && n.tryBlock.pos <= call.pos && call.end <= n.tryBlock.end && n.catchClause) { tryStmt = n; break; }
      n = n.parent;
    }
    if (!tryStmt) { site.discarded = true; site.propagates = true; return site; }
    const v = tryStmt.catchClause.variableDeclaration;
    if (!v || !ts.isIdentifier(v.name)) { site.discarded = true; return site; }
    const symbol = checker.getSymbolAtLocation(v.name);
    site.branch = tryStmt.catchClause.block.getText(sf);
    for (const id of referencesTo(checker, tryStmt.catchClause.block, symbol)) {
      const p = id.parent;
      const allowed = isRefusalArgument(id) || ts.isThrowStatement(p) || (ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.InstanceOfKeyword && p.left === id);
      if (!allowed) reads.push(`line ${where(sf, id)}: the caught failure is read as \`${p.getText(sf).slice(0, 60)}\` outside ${REFUSAL}`);
    }
  } else if (ts.isVariableDeclaration(holder) && holder.initializer && climb(holder.initializer) === top && ts.isIdentifier(holder.name)) {
    scanResult(checker.getSymbolAtLocation(holder.name), scopeOf(holder), { destructuredError: false });
  } else if (ts.isVariableDeclaration(holder) && ts.isObjectBindingPattern(holder.name)) {
    for (const el of holder.name.elements) {
      const prop = (el.propertyName ?? el.name).getText(sf);
      if (prop === 'success' || prop === 'data') continue;
      if (prop !== 'error' || !ts.isIdentifier(el.name)) { reads.push(`line ${where(sf, el)}: destructures \`${prop}\` from the parse result`); continue; }
      scanResult(checker.getSymbolAtLocation(el.name), scopeOf(holder), { destructuredError: true });
    }
  } else if (ts.isPropertyAccessExpression(holder) && holder.expression === top) {
    const prop = holder.name.text;
    if (prop === 'error' && !isRefusalArgument(holder)) reads.push(`line ${where(sf, holder)}: \`${holder.parent.getText(sf).slice(0, 70)}\` reads the failure outside ${REFUSAL}`);
    else if (prop !== 'error' && prop !== 'success' && prop !== 'data') reads.push(`line ${where(sf, holder)}: reads \`.${prop}\` of the parse result`);
  } else if (ts.isExpressionStatement(holder)) {
    // The result is dropped: a parse run for its refusal side effect alone reads nothing.
  } else {
    reads.push(`line ${site.line}: the parse result is used as \`${holder.getText(sf).slice(0, 60)}\`, so what is done with its error cannot be followed`);
  }

  site.leaks = reads;
  // The class: a failure that is never read has nothing of zod's to put in an answer or a line.
  site.discarded = reads.length === 0 && !sourceMentionsRefusal(sf, site);
  return site;
}

/** A site that DOES call `refusalOfParse` is a refusal answered, not a failure discarded. */
function sourceMentionsRefusal(sf, site) {
  return site.branch !== null && site.branch.includes(REFUSAL);
}

// ---------------------------------------------------------------------------------------------------------------
// The server program, built once.

const PROGRAM = (() => {
  const cfg = ts.readConfigFile(join(REPO_ROOT, 'server', 'tsconfig.json'), ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(cfg.config, ts.sys, join(REPO_ROOT, 'server'));
  return ts.createProgram({ rootNames: parsed.fileNames, options: { ...parsed.options, noEmit: true } });
})();

const inServerSrc = (sf) => {
  const rel = posix(relative(REPO_ROOT, sf.fileName));
  return rel.startsWith('server/src/') && !rel.endsWith('.d.ts') ? rel : null;
};

describe('every zod parse failure that is answered or logged goes through refusalOfParse', () => {
  const sites = zodParseSites(PROGRAM, inServerSrc);

  it('the derivation found the parse calls (a floor, so a broken checker cannot pass by finding none)', () => {
    assert.ok(sites.length >= 50, `only ${sites.length} zod parse calls were derived from the server program — the receiver-type test has stopped matching`);
    assert.ok(sites.filter(s => s.method === 'safeParse').length >= 50, 'fewer than fifty safeParse sites');
    const files = new Set(sites.map(s => s.file));
    for (const known of ['server/src/spaces/meta-update.ts', 'server/src/api/spaces.ts', 'server/src/sync/arrival-shape.ts']) {
      assert.ok(files.has(known), `${known} holds a zod parse and the derivation did not find it`);
    }
  });

  it('util/log.ts exports refusalOfParse, so the rule below has something to be satisfied by', () => {
    const src = stripComments(readFileSync(join(REPO_ROOT, 'server/src/util/log.ts'), 'utf8'));
    assert.ok(/export\s+function\s+refusalOfParse\s*\(/.test(src), 'util/log.ts has no `export function refusalOfParse`');
  });

  it('no failure is read outside refusalOfParse (the discarded class aside)', () => {
    const leaking = sites.filter(s => s.leaks.length > 0);
    const named = leaking.map(s => `${s.file}:${s.line} (${s.method}) — ${s.leaks[0]}${s.leaks.length > 1 ? ` (+${s.leaks.length - 1} more reads)` : ''}`);
    assert.equal(leaking.length, 0,
      `${leaking.length} of ${sites.length} zod parse sites answer or log a failure in zod's own words (error.message is the issue array as JSON, ` +
      'an unknown key whole, however long). Answer `refusalOfParse(result.error)` and put `.error` and `.issues` in the body from its result. First ones:\n  '
      + named.slice(0, 12).join('\n  ') + (named.length > 12 ? `\n  … and ${named.length - 12} more` : ''));
  });

  it('the discarded class is the sites whose failure is never read, and it is not where a leak hides', () => {
    const discarded = sites.filter(s => s.discarded);
    for (const s of discarded) assert.deepEqual(s.leaks, [], `${s.file}:${s.line} is in the discarded class and reads its failure`);
    assert.ok(discarded.length < sites.length, 'every parse site is "discarded by design" — the class has swallowed the rule');
  });
});

// ---------------------------------------------------------------------------------------------------------------
// The same analysis over a fixture: one site per way of leaking, and one clean site per class.

describe('the gate flags what it is meant to flag', () => {
  const FIXTURE = join(REPO_ROOT, 'server', 'src', '__zod-refusal-fixture__.ts');
  const text = `
    import { z } from 'zod';
    declare function refusalOfParse(error: unknown): { error: string; issues: unknown[] };
    declare function helper(x: unknown): unknown;
    const S = z.object({ a: z.string() });
    export function leakMessage(x: unknown) { const r = S.safeParse(x); if (!r.success) return { error: r.error.message }; return r.data; }
    export function leakIssues(x: unknown) { const r = S.safeParse(x); if (!r.success) { return { details: r.error.issues }; } return r.data; }
    export function leakAlias(x: unknown) { const r = S.safeParse(x); if (!r.success) { const e = r.error; return e.issues; } return 1; }
    export function leakDestructured(x: unknown) { const { success, error } = S.safeParse(x); if (!success) return error.message; return 1; }
    export function leakChained(x: unknown) { return S.safeParse(x).error?.message; }
    export function leakHandedOn(x: unknown) { const r = S.safeParse(x); return helper(r); }
    export function leakFormat(x: unknown) { const r = S.safeParse(x); return r.success ? r.data : r.error.format(); }
    export function leakCaught(x: unknown) { try { S.parse(x); } catch (e) { return (e as Error).message; } return 1; }
    export function cleanRefusal(x: unknown) { const r = S.safeParse(x); if (!r.success) return refusalOfParse(r.error); return r.data; }
    export function cleanRefusalDestructured(x: unknown) { const { success, error } = S.safeParse(x); if (!success) return refusalOfParse(error); return 1; }
    export function cleanCaught(x: unknown) { try { S.parse(x); } catch (e) { return refusalOfParse(e); } return 1; }
    export function cleanRethrown(x: unknown) { try { S.parse(x); } catch (e) { throw e; } }
    export function discardedBranch(x: unknown) { const r = S.safeParse(x); if (!r.success) return null; return r.data; }
    export function discardedPredicate(x: unknown) { return S.safeParse(x).success; }
    export function notZod(s: string) { return [JSON.parse(s), Date.parse(s)]; }
  `;
  const fixture = (() => {
    const options = { ...PROGRAM.getCompilerOptions(), noEmit: true };
    const host = ts.createCompilerHost(options);
    const realGet = host.getSourceFile.bind(host);
    const realExists = host.fileExists.bind(host);
    const realRead = host.readFile.bind(host);
    host.getSourceFile = (name, lang, ...rest) => (posix(name) === posix(FIXTURE) ? ts.createSourceFile(name, text, lang, true) : realGet(name, lang, ...rest));
    host.fileExists = (name) => posix(name) === posix(FIXTURE) || realExists(name);
    host.readFile = (name) => (posix(name) === posix(FIXTURE) ? text : realRead(name));
    const program = ts.createProgram({ rootNames: [FIXTURE], options, host });
    const bySite = new Map();
    for (const s of zodParseSites(program, sf => (posix(sf.fileName) === posix(FIXTURE) ? 'fixture' : null))) {
      // Name a site by the function that holds it: the fixture's line numbers are not stable to read.
      const line = text.split('\n')[Number(s.line) - 1];
      bySite.set(/export function (\w+)/.exec(line)?.[1], s);
    }
    return bySite;
  })();

  for (const name of ['leakMessage', 'leakIssues', 'leakAlias', 'leakDestructured', 'leakChained', 'leakHandedOn', 'leakFormat', 'leakCaught']) {
    it(`${name} is refused`, () => {
      assert.ok(fixture.has(name), `${name} was not derived as a zod parse site — the receiver-type test is broken`);
      assert.ok(fixture.get(name).leaks.length > 0, `${name} reads zod's failure outside ${REFUSAL} and the gate let it through`);
    });
  }

  for (const name of ['cleanRefusal', 'cleanRefusalDestructured', 'cleanCaught', 'cleanRethrown']) {
    it(`${name} is accepted`, () => {
      assert.ok(fixture.has(name), `${name} was not derived as a zod parse site`);
      assert.deepEqual(fixture.get(name).leaks, [], `${name} answers through ${REFUSAL} and the gate refused it`);
    });
  }

  for (const name of ['discardedBranch', 'discardedPredicate']) {
    it(`${name} is in the discarded class`, () => {
      assert.ok(fixture.has(name), `${name} was not derived as a zod parse site`);
      assert.deepEqual(fixture.get(name).leaks, []);
      assert.equal(fixture.get(name).discarded, true, `${name} never reads its failure and is not in the discarded class`);
    });
  }

  it('JSON.parse and Date.parse are not zod parse sites', () => {
    assert.equal(fixture.has('notZod'), false, 'a JSON.parse / Date.parse call was derived as a zod parse');
  });

  it('a failure branch is found by structure and reported with its site', () => {
    assert.match(fixture.get('leakMessage').branch ?? '', /r\.error\.message/, 'the failure branch of `if (!r.success)` was not found');
    assert.match(fixture.get('leakFormat').branch ?? '', /r\.error\.format\(\)/, 'the false arm of `r.success ? … : …` was not found');
  });
});
