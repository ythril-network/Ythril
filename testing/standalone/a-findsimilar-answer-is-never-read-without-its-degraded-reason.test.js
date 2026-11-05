/**
 * Every place that consumes a `findSimilar` answer reads its `degraded`: a background scan DECIDES on it, and a door that answers a
 * caller passes it on (Q-697, b235 design v3 item 14, the "E4 gate"; testing S7, reliability S7, integration S9).
 *
 * ## The defect
 *
 * `findSimilar` answers `{ source, results, degraded? }`, and `degraded` is the only place the answer says "the index was not asked": a
 * collection whose index was absent or being built answers EMPTY, and an empty `results` read without it is "no neighbours". Nothing
 * required a caller to read it. The duplicate scanner did (inline, since Q-326), the contradiction scanner destructured only
 * `source` and `results` and so settled every seed it met an unready index on (Q-697), and the next caller written would have done
 * whichever the author remembered. A rule a reviewer has to remember is a rule that holds until the first caller written in a hurry.
 *
 * ## The rule
 *
 * Every function that calls `findSimilar` - or a parameter typed `typeof findSimilar`, the seam `evalRecord` takes - does one of two things
 * with the answer's `degraded`:
 *
 *  - a BACKGROUND SCAN passes it to `seedSearchOutcome` (`brain/scan-seed-runner.ts`, the one decision per reason) and USES what comes
 *    back in a condition: a call whose result nothing tests, or a mention in a comment, decides nothing;
 *  - a DOOR that answers a caller passes it into its own answer (the MCP `similar` tool, `ANSWER_SITES`).
 *
 * ## What is derived and what is named
 *
 * The sites are DERIVED from the server's source (`git ls-files` plus uncommitted files), never listed: every function that holds a call of
 * a name imported from the recall module (`import { findSimilar }`, an alias, a namespace import, a dynamic `import()` destructured or
 * called through `.findSimilar`), or of a parameter typed `typeof findSimilar`. The syntax tree is read, so a comment or a string is never
 * a call or a use, and there is a floor: a scan that found fewer than three sites found none of them.
 *
 * Two things are NAMED, each with its reason, and each is checked to still be what it says:
 *
 *  - `ANSWER_SITES`: the files whose consumer answers a caller (so the rule is "into its own answer", not a scan decision);
 *  - `EXEMPT`: `checkDuplicates` (`recall.ts`), the insert-time near-duplicate hint. It asks the index through `recallByType`, not
 *    `findSimilar`, and DELIBERATELY reads an index that cannot answer as an empty half: the hint stores nothing, so the reason has
 *    nobody to reach (`Q-326`, vet A-S1). It is listed so that the one place the repository swallows the signal on purpose is a place
 *    a reader finds, and the entry is held live (the function must still exist and still swallow `RecallSearchIncomplete`).
 *
 * ## Mutation rows
 *
 * Per site, derived: the site as written must satisfy the rule, and then each way of dropping the rule - the call renamed away, the
 * wrong argument, only a comment, the answer discarded; for an answering door, the reason not carried or only a comment - must make
 * the SAME site fail. A mutation that did not change the source fails the row (it proved nothing). A set of synthetic sources proves
 * the reader on its own: every import form is a site, a comment and a string are not, and a fourth consumer with no handling is caught.
 *
 * "Seen red" on the base: the duplicate scanner reads `degraded?.includes('index_not_ready')` by hand and the contradiction scanner
 * does not read `degraded` at all, so neither passes its own site row.
 *
 * Run: node --test testing/standalone/a-findsimilar-answer-is-never-read-without-its-degraded-reason.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { parseSource, ts, lineOf, walkEveryNode } from '../_shared/syntax-tree.mjs';
import { trackedSources } from './_sources.mjs';

/** The module `findSimilar` is imported from, as an import specifier ends. */
const RECALL_MODULE = /(^|\/)recall(\.js|\.ts)?$/;
const DECIDER = 'seedSearchOutcome';

/** Files whose consumer answers a caller, so the reason is carried into the answer and no scan decides on it. */
const ANSWER_SITES = {
  'server/src/mcp/tools/search.ts': 'the MCP `similar` tool answers its caller, and says `degraded` in its own answer (Q-326)',
};
/** The one place `findSimilar`'s reason is swallowed on purpose, and why. */
const EXEMPT = {
  'server/src/brain/recall.ts': {
    fn: 'checkDuplicates',
    reason: 'the insert-time near-duplicate hint reads an index that cannot answer as an empty half: it stores nothing, so the reason has nobody to reach (Q-326, vet A-S1)',
    swallows: 'RecallSearchIncomplete',
  },
};

// ── Reading the syntax tree ───────────────────────────────────────────────────

const innermostFunction = (node) => { for (let n = node.parent; n; n = n.parent) if (ts.isFunctionLike(n)) return n; return null; };
const isRecallSpecifier = (n) => !!n && ts.isStringLiteralLike(n) && RECALL_MODULE.test(n.text);
const transparent = (p) => ts.isParenthesizedExpression(p) || ts.isAsExpression(p) || ts.isNonNullExpression(p) || ts.isAwaitExpression(p);
const calleeName = (call) => (ts.isIdentifier(call.expression) ? call.expression.text
  : ts.isPropertyAccessExpression(call.expression) ? call.expression.name.text : undefined);

function nameOfFunction(fn) {
  if (fn.name && ts.isIdentifier(fn.name)) return fn.name.text;
  const p = fn.parent;
  if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) return p.name.text;
  if (p && ts.isPropertyAssignment(p) && ts.isIdentifier(p.name)) return p.name.text;
  return '<anonymous>';
}

/**
 * Every function of `src` that consumes a `findSimilar` answer: `{ fn, calls, line, name }`, one per function (a function with two calls is one site).
 * Reads imports from the recall module (named, aliased, namespace, dynamic) and parameters typed `typeof findSimilar`.
 */
export function sitesOf(file, src) {
  const sf = parseSource(file, src);
  const names = new Set();
  let recallImported = false;
  walkEveryNode(sf, (n) => {
    if (ts.isImportDeclaration(n) && isRecallSpecifier(n.moduleSpecifier)) {
      recallImported = true;
      const bound = n.importClause?.namedBindings;
      if (bound && ts.isNamedImports(bound)) for (const el of bound.elements) if ((el.propertyName ?? el.name).text === 'findSimilar') names.add(el.name.text);
    }
    if (ts.isCallExpression(n) && n.expression.kind === ts.SyntaxKind.ImportKeyword && isRecallSpecifier(n.arguments[0])) {
      recallImported = true;
      let p = n.parent;
      while (p && transparent(p)) p = p.parent;
      if (p && ts.isVariableDeclaration(p) && ts.isObjectBindingPattern(p.name)) {
        for (const el of p.name.elements) if ((el.propertyName ?? el.name).text === 'findSimilar') names.add(el.name.text);
      }
    }
  });
  const seamNames = [];   // `similar: typeof findSimilar` - the parameter and the function that owns it
  walkEveryNode(sf, (n) => {
    if (!ts.isParameter(n) || !n.type || !ts.isTypeQueryNode(n.type) || !ts.isIdentifier(n.name)) return;
    const q = n.type.exprName;
    if (ts.isIdentifier(q) && (q.text === 'findSimilar' || names.has(q.text))) seamNames.push({ name: n.name.text, owner: n.parent });
  });
  const byFn = new Map();
  walkEveryNode(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    const hit = (ts.isIdentifier(callee) && names.has(callee.text))
      || (ts.isPropertyAccessExpression(callee) && callee.name.text === 'findSimilar' && recallImported)
      || (ts.isIdentifier(callee) && seamNames.some(s => s.name === callee.text && isWithin(n, s.owner)));
    if (!hit) return;
    const fn = innermostFunction(n);
    if (!fn) return;
    if (!byFn.has(fn)) byFn.set(fn, { fn, calls: [], sf, line: lineOf(sf, n), name: nameOfFunction(fn), file });
    byFn.get(fn).calls.push(n);
  });
  return [...byFn.values()];
}

function isWithin(node, ancestor) { for (let n = node; n; n = n.parent) if (n === ancestor) return true; return false; }

/** Is `expr` USED in a condition: tested, compared, negated, or the condition of a conditional - directly, or through a variable it is stored in. */
function usedInCondition(expr, fn) {
  const COMPARES = new Set([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.ExclamationEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken,
    ts.SyntaxKind.ExclamationEqualsToken, ts.SyntaxKind.AmpersandAmpersandToken, ts.SyntaxKind.BarBarToken, ts.SyntaxKind.QuestionQuestionToken]);
  let child = expr;
  for (let p = expr.parent; p; child = p, p = p.parent) {
    if (transparent(p)) continue;
    if (ts.isPrefixUnaryExpression(p)) return p.operator === ts.SyntaxKind.ExclamationToken;
    if (ts.isConditionalExpression(p)) return p.condition === child;
    if (ts.isIfStatement(p) || ts.isWhileStatement(p)) return p.expression === child;
    if (ts.isBinaryExpression(p)) {
      if (COMPARES.has(p.operatorToken.kind)) return true;
      if (p.operatorToken.kind === ts.SyntaxKind.EqualsToken && p.right === child && ts.isIdentifier(p.left)) return identifierUsedInCondition(p.left.text, p.left, fn);
      return false;
    }
    if (ts.isVariableDeclaration(p) && p.initializer === child && ts.isIdentifier(p.name)) return identifierUsedInCondition(p.name.text, p.name, fn);
    return false;
  }
  return false;
}
function identifierUsedInCondition(name, declaration, fn) {
  let used = false;
  walkEveryNode(fn, (n) => { if (ts.isIdentifier(n) && n.text === name && n !== declaration && usedInCondition(n, fn)) used = true; });
  return used;
}

const mentionsDegraded = (arg) => {
  let found = false;
  walkEveryNode(arg, (n) => { if ((ts.isIdentifier(n) && n.text === 'degraded') || (ts.isPropertyAccessExpression(n) && n.name.text === 'degraded')) found = true; });
  return found;
};
/** Is the identifier `degraded` in `arg` bound by destructuring the answer of one of the site's own calls (a local `degraded = []` is not the answer's)? */
function degradedIsTheAnswers(arg, site) {
  let ok = false;
  walkEveryNode(arg, (n) => {
    if (ts.isPropertyAccessExpression(n) && n.name.text === 'degraded') ok = true;
    if (!ts.isIdentifier(n) || n.text !== 'degraded') return;
    if (n.parent && ts.isPropertyAccessExpression(n.parent) && n.parent.name === n) return;
    walkEveryNode(site.fn, (b) => {
      if (!ts.isBindingElement(b) || !ts.isIdentifier(b.name) || b.name.text !== 'degraded') return;
      const decl = b.parent?.parent;
      let init = decl && ts.isVariableDeclaration(decl) ? decl.initializer : undefined;
      while (init && transparent(init)) init = init.expression;
      if (init && site.calls.includes(init)) ok = true;
    });
  });
  return ok;
}

/** A scan site: `seedSearchOutcome(<the answer's degraded>)`, its result used in a condition. */
function scanVerdict(site) {
  const calls = [];
  walkEveryNode(site.fn, (n) => { if (ts.isCallExpression(n) && calleeName(n) === DECIDER) calls.push(n); });
  const where = `${site.file}:${site.line} (${site.name})`;
  if (calls.length === 0) return { ok: false, why: `${where} never calls ${DECIDER}: the answer's degraded is read by hand, or not at all, and an index that was not asked reads as "no neighbours"` };
  const fed = calls.filter(c => c.arguments.length > 0 && mentionsDegraded(c.arguments[0]) && degradedIsTheAnswers(c.arguments[0], site));
  if (fed.length === 0) return { ok: false, why: `${where} calls ${DECIDER} with something that is not the answer's degraded` };
  if (!fed.some(c => usedInCondition(c, site.fn))) return { ok: false, why: `${where} calls ${DECIDER}(degraded) and tests the answer in no condition: a call whose result nothing reads decides nothing` };
  return { ok: true };
}

/** An answering site: the answer's `degraded` reaches an object literal, the caller's answer. */
function answerVerdict(site) {
  const where = `${site.file}:${site.line} (${site.name})`;
  const vars = new Set();
  for (const c of site.calls) {
    let p = c.parent;
    while (p && transparent(p)) p = p.parent;
    if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) vars.add(p.name.text);
    if (p && ts.isBinaryExpression(p) && p.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isIdentifier(p.left)) vars.add(p.left.text);
  }
  let carried = false;
  walkEveryNode(site.fn, (n) => {
    if (!ts.isPropertyAccessExpression(n) || n.name.text !== 'degraded' || !ts.isIdentifier(n.expression) || !vars.has(n.expression.text)) return;
    for (let p = n.parent; p && p !== site.fn; p = p.parent) if (ts.isObjectLiteralExpression(p)) { carried = true; return; }
  });
  return carried ? { ok: true }
    : { ok: false, why: `${where} does not put the answer's degraded (${[...vars].join(', ') || 'no variable holds the answer'}.degraded) into its own answer` };
}

const verdictOf = (site) => (ANSWER_SITES[site.file] ? answerVerdict(site) : scanVerdict(site));

// ── The real sources ──────────────────────────────────────────────────────────

const files = trackedSources('server/src', { untracked: true, floor: 100 }).filter(f => f.endsWith('.ts'));
const sources = new Map(files.map(f => [f, fs.readFileSync(f, 'utf8')]));
const realSites = files.flatMap(f => sitesOf(f, sources.get(f)));

// ── Mutations of a site's own source ─────────────────────────────────────────

/** The text of the balanced call that starts at `text[at]` (a name), through its closing parenthesis. */
function callTextAt(text, at) {
  const open = text.indexOf('(', at);
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === '(') depth++;
    else if (text[i] === ')' && --depth === 0) return text.slice(at, i + 1);
  }
  return text.slice(at);
}
const replaceEveryCall = (text, name, make) => {
  let out = '';
  let from = 0;
  for (let at = text.indexOf(`${name}(`, from); at !== -1; at = text.indexOf(`${name}(`, from)) {
    const call = callTextAt(text, at);
    out += text.slice(from, at) + make(call);
    from = at + call.length;
  }
  return out + text.slice(from);
};

const scanMutations = {
  'the decision call is renamed away': (t) => t.replace(new RegExp(`\\b${DECIDER}\\b`, 'g'), `${DECIDER}Gone`),
  'the decision is asked about something else': (t) => replaceEveryCall(t, DECIDER, () => `${DECIDER}([])`),
  'the decision is only a comment': (t) => replaceEveryCall(t, DECIDER, (call) => `/* ${call} */ false`),
  'the decision is asked and its answer discarded': (t) => replaceEveryCall(t, DECIDER, (call) => `(${call}, 'advance')`),
};
const answerMutations = (vars) => ({
  'the reason is not carried into the answer': (t) => vars.reduce((s, v) => s.replace(new RegExp(`\\b${v}\\??\\.degraded\\b`, 'g'), '[]'), t),
  'the reason is only a comment': (t) => vars.reduce((s, v) => s.replace(new RegExp(`\\b${v}\\??\\.degraded\\b`, 'g'), `/* ${v}.degraded */ []`), t),
});

/** The site at `ordinal` of `file` after `mutate` is applied to the text of the function it is. */
function mutatedSite(site, mutate) {
  const text = sources.get(site.file);
  const start = site.fn.getStart(site.sf);
  const body = text.slice(start, site.fn.end);
  const mutated = mutate(body);
  if (mutated === body) return { unchanged: true };
  const ordinal = sitesOf(site.file, text).findIndex(s => s.fn.getStart(s.sf) === start);
  const after = sitesOf(site.file, text.slice(0, start) + mutated + text.slice(site.fn.end));
  return { site: after[ordinal] };
}

describe('every consumer of a findSimilar answer reads its degraded reason', () => {
  it('derives its sites from the source, and the scan itself still works', () => {
    // A floor: a derivation that found fewer than the three known consumers found none of them, and every row below would pass over nothing.
    assert.ok(realSites.length >= 3, `only ${realSites.length} site(s) found (${realSites.map(s => `${s.file}:${s.line}`).join(', ')}): the derivation no longer reads imports of findSimilar`);
  });

  it('every named answering site, and the named exemption, is still what it says', () => {
    for (const file of Object.keys(ANSWER_SITES)) {
      assert.ok(realSites.some(s => s.file === file), `${file} is named an answering site (${ANSWER_SITES[file]}) and no longer consumes a findSimilar answer: remove the entry`);
    }
    for (const [file, ex] of Object.entries(EXEMPT)) {
      const src = sources.get(file);
      assert.ok(src, `${file} is named in EXEMPT and is not a source file`);
      let swallows = false;
      let found = false;
      walkEveryNode(parseSource(file, src), (n) => {
        if (!ts.isFunctionDeclaration(n) || n.name?.text !== ex.fn) return;
        found = true;
        walkEveryNode(n, (m) => { if (ts.isIdentifier(m) && m.text === ex.swallows) swallows = true; });
      });
      assert.ok(found, `${file} has no function ${ex.fn}: the exemption (${ex.reason}) names nothing`);
      assert.ok(swallows, `${ex.fn} no longer mentions ${ex.swallows}: it is exempt for swallowing it on purpose (${ex.reason}), and it does not any more - remove the exemption`);
    }
  });

  for (const site of realSites) {
    const where = `${site.file}:${site.line} (${site.name})`;
    describe(where, () => {
      it(ANSWER_SITES[site.file] ? 'carries the answer\'s degraded into its own answer' : 'passes the answer\'s degraded to seedSearchOutcome and tests what it answers', () => {
        const v = verdictOf(site);
        assert.ok(v.ok, v.why);
      });

      const answering = !!ANSWER_SITES[site.file];
      const varsOf = () => {
        const vars = [];
        for (const c of site.calls) {
          let p = c.parent;
          while (p && transparent(p)) p = p.parent;
          if (p && ts.isVariableDeclaration(p) && ts.isIdentifier(p.name)) vars.push(p.name.text);
          if (p && ts.isBinaryExpression(p) && ts.isIdentifier(p.left)) vars.push(p.left.text);
        }
        return vars;
      };
      const mutations = answering ? answerMutations(varsOf()) : scanMutations;
      for (const [what, mutate] of Object.entries(mutations)) {
        it(`mutation: ${what} - the site fails`, () => {
          const base = verdictOf(site);
          assert.ok(base.ok, `the site does not satisfy the rule as written, so a mutation of it proves nothing: ${base.why}`);
          const m = mutatedSite(site, mutate);
          assert.ok(!m.unchanged, `the mutation "${what}" did not change the source of ${where}: the row proved nothing`);
          assert.ok(m.site, `the mutated source no longer has the site ${where}`);
          assert.equal(verdictOf(m.site).ok, false, `${where} still passes with "${what}": the gate cannot see the rule being dropped there`);
        });
      }
    });
  }
});

// ── The reader on synthetic sources ───────────────────────────────────────────

const GOOD = `
import { findSimilar } from './recall.js';
import { seedSearchOutcome } from './scan-seed-runner.js';
export async function evalOne(id) {
  const { source, results, degraded } = await findSimilar('s', id, 'fact', 5);
  if (seedSearchOutcome(degraded) === 'hold') return 'held';
  return results.length + (source ? 1 : 0);
}`;

describe('the gate\'s reader, on sources of its own', () => {
  const check = (src, file = 'fixture.ts') => sitesOf(file, src).map(s => ({ name: s.name, ...scanVerdict(s) }));

  it('a consumer that decides on degraded and tests the decision passes', () => {
    assert.deepEqual(check(GOOD).map(r => [r.name, r.ok]), [['evalOne', true]]);
  });

  it('the decision stored in a variable that is then tested passes', () => {
    const src = GOOD.replace("if (seedSearchOutcome(degraded) === 'hold') return 'held';", "const out = seedSearchOutcome(degraded);\n  if (out === 'hold') return 'held';");
    assert.deepEqual(check(src).map(r => r.ok), [true]);
  });

  for (const [name, mutate] of Object.entries({
    'no decision at all': (s) => s.replace("if (seedSearchOutcome(degraded) === 'hold') return 'held';", ''),
    'the reason read by hand': (s) => s.replace("seedSearchOutcome(degraded) === 'hold'", "degraded?.includes('index_not_ready')"),
    'the decision named only in a comment': (s) => s.replace("if (seedSearchOutcome(degraded) === 'hold') return 'held';", "// if (seedSearchOutcome(degraded) === 'hold') return 'held';"),
    'the decision named only in a string': (s) => s.replace("if (seedSearchOutcome(degraded) === 'hold') return 'held';", "const note = 'seedSearchOutcome(degraded) === hold';"),
    'the decision asked and nothing tested': (s) => s.replace("if (seedSearchOutcome(degraded) === 'hold') return 'held';", 'seedSearchOutcome(degraded);'),
    'the decision asked about a local list': (s) => s.replace("if (seedSearchOutcome(degraded) === 'hold')", "const degraded2 = [];\n  if (seedSearchOutcome(degraded2) === 'hold')"),
    'a local degraded that is not the answer\'s': (s) => s.replace('const { source, results, degraded } = await', 'const degraded = [];\n  const { source, results } = await'),
  })) {
    it(`a consumer with ${name} fails`, () => {
      const out = check(mutate(GOOD));
      assert.equal(out.length, 1, `the site was not found in: ${mutate(GOOD)}`);
      assert.equal(out[0].ok, false, `passed: ${mutate(GOOD)}`);
    });
  }

  for (const [form, src] of Object.entries({
    'a named import': GOOD,
    'an aliased import': GOOD.replace('{ findSimilar }', '{ findSimilar as similarTo }').replace('await findSimilar(', 'await similarTo('),
    'a namespace import': GOOD.replace("import { findSimilar } from './recall.js';", "import * as recall from './recall.js';").replace('await findSimilar(', 'await recall.findSimilar('),
    'a dynamic import, destructured': GOOD.replace("import { findSimilar } from './recall.js';", '').replace('const { source', "const { findSimilar } = await import('./recall.js');\n  const { source"),
    'a dynamic import, called through its namespace': GOOD.replace("import { findSimilar } from './recall.js';", '').replace('await findSimilar(', "await (await import('./recall.js')).findSimilar("),
    'a parameter typed typeof findSimilar': `import { findSimilar } from './recall.js';
import { seedSearchOutcome } from './scan-seed-runner.js';
export async function evalOne(id, similar: typeof findSimilar = findSimilar) {
  const { results, degraded } = await similar('s', id, 'fact', 5);
  if (seedSearchOutcome(degraded) === 'hold') return 'held';
  return results;
}`,
  })) {
    it(`${form} is a site`, () => {
      const out = check(src);
      assert.equal(out.length, 1, `${form} was not read as a consumer: ${src}`);
      assert.equal(out[0].ok, true, out[0].why);
    });
  }

  it('an unrelated import from recall, a findSimilar of another module, a comment and a string are not sites', () => {
    assert.deepEqual(sitesOf('f.ts', "import { recall } from './recall.js';\nexport const x = () => recall();").length, 0);
    assert.deepEqual(sitesOf('f.ts', "import { findSimilar } from './other.js';\nexport const x = () => findSimilar();").length, 0);
    assert.deepEqual(sitesOf('f.ts', "import { findSimilar } from './recall.js';\n// findSimilar('a');\nexport const x = \"findSimilar('a')\";").length, 0);
  });

  // The mutations the per-site rows apply, shown to bite on a site that satisfies the rule: a mutation that left a good site passing would make
  // every per-site row above a row that cannot fail, and on a tree whose scanners do not pass yet those rows cannot show it themselves.
  for (const [what, mutate] of Object.entries(scanMutations)) {
    it(`the mutation "${what}" turns a passing scan site into a failing one`, () => {
      const mutated = mutate(GOOD);
      assert.notEqual(mutated, GOOD, 'the mutation did not change the source');
      const out = check(mutated);
      assert.equal(out.length, 1);
      assert.equal(out[0].ok, false, `still passes: ${mutated}`);
    });
  }
  for (const [what, mutate] of Object.entries(answerMutations(['result']))) {
    it(`the mutation "${what}" turns a passing answering site into a failing one`, () => {
      const door = "import { findSimilar } from '../brain/recall.js';\nexport async function handler() { const result = await findSimilar('s', 'i', 'fact'); return { results: result.results, ...(result.degraded?.length ? { degraded: result.degraded } : {}) }; }";
      const mutated = mutate(door);
      assert.notEqual(mutated, door, 'the mutation did not change the source');
      assert.deepEqual(sitesOf('server/src/mcp/tools/search.ts', mutated).map(answerVerdict).map(v => v.ok), [false]);
    });
  }

  it('a fourth consumer that reads nothing of the answer is caught without anyone editing this gate', () => {
    const fourth = "import { findSimilar } from '../brain/recall.js';\nexport async function sweep(id) { const { results } = await findSimilar('s', id, 'fact'); return results; }";
    assert.deepEqual(check(fourth).map(r => r.ok), [false]);
  });

  it('an answering site passes when the reason reaches its answer, and fails when it does not', () => {
    const door = "import { findSimilar } from '../brain/recall.js';\nexport async function handler() { const result = await findSimilar('s', 'i', 'fact'); return { results: result.results, ...(result.degraded?.length ? { degraded: result.degraded } : {}) }; }";
    const silent = door.replace('...(result.degraded?.length ? { degraded: result.degraded } : {})', '');
    const verdicts = (src) => sitesOf('server/src/mcp/tools/search.ts', src).map(answerVerdict).map(v => v.ok);
    assert.deepEqual(verdicts(door), [true]);
    assert.deepEqual(verdicts(silent), [false]);
  });
});
