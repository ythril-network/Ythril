/**
 * A test that cannot run because an input is absent SKIPS, or FAILS — it never returns and passes.
 *
 * ## The failure this prevents
 *
 * `if (!existsSync(dist)) return;` at the top of a test body ends the test green having asserted nothing, and
 * no reporter can tell it from a test that checked something: the runner counts it as passed, not skipped.
 * `no-external-assets` did exactly that for the built `index.html`, so on a CI job that never built the
 * client the gate for "a production build ships no remote asset" passed forever; the same shape ended
 * `a-space-list-searches-exactly-those-spaces` when no fact had a UUID id, `mcp-security` when one token file
 * was missing, and `democratic` when a round auto-added a member. Adding a log line (`SKIPPED: the corpus is
 * not fetched`) changes nothing: the line is read by whoever happens to read the log, and the count stays
 * green. A skip counter (the measurement this bundle adds) sees `t.skip` and nothing else, so every test
 * written this way is invisible to it by construction.
 *
 * ## The rule, and what it deliberately is not
 *
 * In a test body, a branch that ENDS THE TEST without asserting, because something it needed is absent, is
 * refused. "Ends the test" is a bare `return` (or one that returns only a log call), or — for the last
 * statement of the body — a branch that does nothing but log opposite a branch that asserts. "Because
 * something is absent" is read from the condition (a negation, `=== null`, `== undefined`, a `.length`
 * compared with a number, `existsSync`) or from the branch itself saying it is skipping (a comment or a log
 * line that contains the word). A real skip (`t.skip(reason)`, `ctx.skip()`) is the way out, and so is
 * asserting, throwing, or asking a guard that does either (`requireEmbedding`, or a helper in the same file
 * that skips or throws).
 *
 * It is NOT "any early return": `if (body.refused) return;` and `if (WAIVED[name]) return;` end a test on a
 * documented outcome, not on an absent input, and forcing them into `t.skip` would turn a designed pass into
 * an unexpected skip in CI. The truth table below holds both halves.
 *
 * ## What the table was built from
 *
 * Verbatim shapes of the sites this was found at: `no-external-assets.test.js:98-99`,
 * `a-space-list-searches-exactly-those-spaces.test.js:168`, `democratic.test.js:96-99` (an `else` that only
 * logs), and the print-and-return `SKIPPED` tests of the NLP corpus. They are LITERAL here on purpose — the
 * sites themselves are rewritten by the change that satisfies this test, and a fixture derived from the code
 * under test asserts that the code equals itself.
 *
 * Run: node --test testing/standalone/a-test-that-finds-its-input-absent-says-so.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { testFiles, testBodies, calleeText, calleeName } from './_test-bodies.mjs';
import { parseSource, lineOf, walkOwnCode } from '../_shared/syntax-tree.mjs';

/** Does this code assert, throw, or skip — i.e. does it do anything but pass? */
const ASSERTING = /^(assert|expect|verify|check|must|require|refuse|ensure|ok|equal|notEqual|deepEqual|strictEqual|deepStrictEqual|notStrictEqual|match|doesNotMatch|throws|rejects|doesNotReject|doesNotThrow|fail|isTrue|isFalse)/i;

function assertsOrSkips(node) {
  return walkOwnCode(node, (x) => {
    if (ts.isThrowStatement(x)) return true;
    if (!ts.isCallExpression(x)) return false;
    const name = calleeName(x);
    const full = calleeText(x);
    return ASSERTING.test(name) || /^assert\b|\.assert\b/.test(full) || name === 'skip' || name === 'todo';
  });
}

const statementsOf = (s) => (ts.isBlock(s) ? [...s.statements] : [s]);

const isLogStatement = (s) => ts.isExpressionStatement(s) && ts.isCallExpression(s.expression)
  && /^(console\.\w+|log)$/.test(calleeText(s.expression));

/** `return;`, `return undefined;`, or `return console.log(...)` — a way out that hands nothing back. */
function endsQuietly(s) {
  if (!ts.isReturnStatement(s)) return false;
  const e = s.expression;
  if (!e) return true;
  if (ts.isIdentifier(e) && e.text === 'undefined') return true;
  return ts.isCallExpression(e) && /^console\./.test(calleeText(e));
}

/**
 * Names of functions in this file that are themselves a guard: one that skips, throws, or asks another guard.
 * `ready(t)` in the spill tests is one — `if (!ready(t)) return;` is the sanctioned shape, not a silent exit.
 */
function guardNames(sf) {
  const names = new Set();
  const consider = (name, body) => {
    if (!name || !body) return;
    const guards = walkOwnCode(body, (x) => ts.isThrowStatement(x)
      || (ts.isCallExpression(x) && (calleeName(x) === 'skip' || /^require[A-Z]/.test(calleeName(x)))));
    if (guards) names.add(name);
  };
  const visit = (n) => {
    if (ts.isFunctionDeclaration(n)) consider(n.name?.text, n.body);
    if (ts.isVariableDeclaration(n) && ts.isIdentifier(n.name) && n.initializer
      && (ts.isArrowFunction(n.initializer) || ts.isFunctionExpression(n.initializer))) {
      consider(n.name.text, n.initializer.body);
    }
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return names;
}

/** The condition delegates to something that skips or throws on the caller's behalf. */
function conditionIsGuarded(cond, guards) {
  return walkOwnCode(cond, (x) => ts.isCallExpression(x)
    && (/^require[A-Z]/.test(calleeName(x)) || guards.has(calleeName(x))));
}

/** The condition tests that something is not there: a negation, null/undefined, an empty count, a missing file. */
function conditionTestsAbsence(cond) {
  return walkOwnCode(cond, (x) => {
    if (ts.isPrefixUnaryExpression(x) && x.operator === ts.SyntaxKind.ExclamationToken) return true;
    if (ts.isBinaryExpression(x)) {
      const op = x.operatorToken.kind;
      const isNil = (e) => e.kind === ts.SyntaxKind.NullKeyword || (ts.isIdentifier(e) && e.text === 'undefined');
      if ((op === ts.SyntaxKind.EqualsEqualsEqualsToken || op === ts.SyntaxKind.EqualsEqualsToken)
        && (isNil(x.left) || isNil(x.right))) return true;
      const countOf = (e) => /\.length\b/.test(e.getText());
      const isNumber = (e) => ts.isNumericLiteral(e);
      if ((countOf(x.left) && isNumber(x.right)) || (countOf(x.right) && isNumber(x.left))) {
        if ([ts.SyntaxKind.EqualsEqualsEqualsToken, ts.SyntaxKind.EqualsEqualsToken, ts.SyntaxKind.LessThanToken,
          ts.SyntaxKind.LessThanEqualsToken].includes(op)) return true;
      }
    }
    return false;
  });
}

/**
 * The branch says it is skipping — in a comment or a log line, which is where an author writes it. A quoted
 * `'skipped'` is a status value some API returned, not the author's own word, so it does not count.
 */
const SAYS_SKIP = /(^|[^'"\w])skip(ped|ping)?\b(?!['"])/i;

/**
 * Every branch of an `if` in a test body that ends the test asserting nothing because an input is absent.
 *
 * @returns {Array<{ line: number, from: number, to: number, shape: 'return' | 'falls off', test: string }>}
 */
export function silentExits(file, text) {
  const sf = parseSource(file, text);
  const guards = guardNames(sf);
  const hits = [];
  const endOfLine = (pos) => { const i = text.indexOf('\n', pos); return i < 0 ? text.length : i; };

  for (const { name, fn } of testBodies(sf)) {
    if (!ts.isBlock(fn.body)) continue;

    const scan = (statements, isFinalList) => {
      statements.forEach((s, i) => {
        if (ts.isIfStatement(s)) {
          const guarded = conditionIsGuarded(s.expression, guards);
          const absence = conditionTestsAbsence(s.expression);
          const isLast = isFinalList && i === statements.length - 1;
          for (const branch of [s.thenStatement, s.elseStatement]) {
            if (!branch || guarded) continue;
            const inner = statementsOf(branch);
            const exit = inner.findIndex(endsQuietly);
            const sourceText = text.slice(branch.getStart(), endOfLine(branch.getEnd()));
            const looksAbsent = absence || SAYS_SKIP.test(sourceText);
            if (exit >= 0) {
              if (looksAbsent && !inner.slice(0, exit).some(assertsOrSkips)) {
                hits.push({ line: lineOf(sf, s), from: lineOf(sf, branch), to: sf.getLineAndCharacterOfPosition(branch.getEnd()).line + 1, shape: 'return', test: name });
              }
            } else if (isLast) {
              const other = branch === s.thenStatement ? s.elseStatement : s.thenStatement;
              if (other && inner.every(isLogStatement) && !assertsOrSkips(branch) && assertsOrSkips(other)
                && SAYS_SKIP.test(sourceText)) {
                hits.push({ line: lineOf(sf, s), from: lineOf(sf, branch), to: sf.getLineAndCharacterOfPosition(branch.getEnd()).line + 1, shape: 'falls off', test: name });
              }
            }
          }
          scan(statementsOf(s.thenStatement), false);
          if (s.elseStatement) scan(statementsOf(s.elseStatement), false);
        } else if (ts.isBlock(s)) {
          scan([...s.statements], false);
        } else if (ts.isTryStatement(s)) {
          scan([...s.tryBlock.statements], false);
        } else if (ts.isForStatement(s) || ts.isForOfStatement(s) || ts.isWhileStatement(s)) {
          scan(statementsOf(s.statement), false);
        }
      });
    };
    scan([...fn.body.statements], true);
  }
  return hits;
}

/**
 * THE TRUTH TABLE. `flagged` rows are the shapes this refuses; `allowed` rows are what it must leave alone.
 * Every row is a whole test, as it would sit in a file.
 */
const FLAGGED = [
  ['no-external-assets.test.js:98-99 — a build that is absent ends the test', 'x.test.js', `
    it('a production build ships no remote asset reference either', () => {
      const dist = 'client/dist/browser/index.html';
      if (!existsSync(join(ROOT, dist))) return;         // no build present; the source checks above still ran
      const html = read(dist);
      for (const re of REMOTE_FETCH) {
        assert.ok(!re.test(html), 'the built index.html still matches');
      }
    });`],
  ['a-space-list-searches-exactly-those-spaces.test.js:168 — a seed with no id ends the test', 'x.test.js', `
    it('similar accepts a list on both doors', async () => {
      const seed = await readCollection(INSTANCES.a, token, 'general', 'facts', { limit: 50 });
      const id = (seed.results ?? []).map(r => r._id).find(v => /^[0-9a-f]{8}$/i.test(v));
      if (!id) return;   // no UUID-keyed fact in this run; the parse is what matters and recall covered it
      const rest = await post(INSTANCES.a, token, '/api/brain/similar', { entryId: id });
      assert.notEqual(rest.status, 400, 'similar refused a list outright');
    });`],
  ['democratic.test.js:96-99 — an else that only logs, opposite a branch that asserts', 'x.test.js', `
    it('Veto blocks a join round immediately', async () => {
      const addC = await post(INSTANCES.a, tokenA, '/members', { instanceId: 'instance-c-dem' });
      assert(addC.status === 201 || addC.status === 202, 'Expected 201 or 202');
      if (addC.status === 202) {
        const vetoed = await post(INSTANCES.a, tokenA, '/votes/1', { vote: 'veto' });
        assert.equal(vetoed.status, 200);
        console.log('  Veto correctly blocked C');
      } else {
        // Auto-added (0 voters) — this is also valid; skip veto test
        console.log('  C was auto-added (0 voters) — veto test not applicable');
      }
    });`],
  ['the-extractor-finds-its-mentions — SKIPPED printed, then return (a file and a server, or-ed)', 'x.test.js', `
    it('proposes at least 92% of the entities', async () => {
      const files = existsSync(EX) ? readdirSync(EX).filter(f => f.endsWith('.json')) : [];
      assert.ok(files.length >= 2, 'the sweep would be vacuous');
      const path = JSON.parse(readFileSync('benchmarks/locomo/pin.json', 'utf8')).datasets.locomo.cachePath;
      if (!existsSync(path) || !(await isNlpAvailable())) {
        console.log('SKIPPED: the corpus is not fetched. Mention recall was NOT measured. Local only.');
        return;
      }
      assert.ok(true);
    });`],
  ['an-extraction-describes-the-conversation-it-names — a bare existsSync with a log and a bare return', 'x.test.js', `
    it('every extraction describes its conversation', () => {
      const path = pin.datasets.locomo.cachePath;
      if (!existsSync(path)) {
        console.log('SKIPPED against the corpus: not fetched.');
        return;
      }
      assert.deepEqual(problems, []);
    });`],
  ['mcp-security — a missing token file, a return and a comment saying skip', 'x.test.js', `
    it('recall_global must not return memories outside the allowed spaces', async () => {
      const tokenBPath = path.join(CONFIGS, 'b', 'token.txt');
      if (!fs.existsSync(tokenBPath)) {
        return; // skip: single-space setup — B not configured
      }
      assert.ok(true);
    });`],
  ['files.test.js — a positive condition whose branch says "Skip"', 'x.test.js', `
    it('PATCH media-config with valid body returns updated config', async () => {
      const original = await getR.json();
      if (original.lockedByInfra?.includes('workerConcurrency')) {
        // Skip if locked by env var
        return;
      }
      assert.equal(patchR.status, 200);
    });`],
  ['file-sync.test.js — [SKIP] printed for a precondition that never came about', 'x.test.js', `
    it('a conflict is listed', async () => {
      let conflictFound = false;
      if (!conflictFound) {
        console.log('  [SKIP] Conflict not generated — file sync peers may not be fully wired in test stack');
        return;
      }
      assert.equal(check.status, 200);
    });`],
  ['an empty derived set ends the test (a count of zero is an absent input)', 'x.test.js', `
    it('every breaking entry survives being abridged', () => {
      const breaking = entriesWithSection(full).filter(isBreaking);
      if (breaking.length === 0) return; // A release with nothing breaking has nothing to protect here.
      assert.deepEqual(missing, []);
    });`],
  ['a null reading with only a diagnostic before the return', 'x.test.js', `
    it('pages hold their order', async (t) => {
      const after = await orderOf();
      if (before === null || after === null) {
        t.diagnostic('the ranking moved while paging');
        return;
      }
      assert.equal(after.length, before.length);
    });`],
  ['a vitest spec in TypeScript, the same shape', 'x.spec.ts', `
    it('renders the heading', () => {
      const el: HTMLElement | null = fixture.nativeElement.querySelector('h1');
      if (!el) return;
      expect(el.textContent).toContain('x');
    });`],
  ['a subtest through t.test is a test body too', 'x.test.js', `
    it('outer', async (t) => {
      await t.test('inner', () => {
        const f = lookup('x');
        if (f === undefined) return;
        assert.ok(f);
      });
    });`],
];

const ALLOWED = [
  ['a real skip returned', 'x.test.js', `
    it('x', async (t) => {
      if (!existsSync(p)) return t.skip('not fetched');
      assert.ok(true);
    });`],
  ['a real skip, then a bare return', 'x.test.js', `
    it('x', async (t) => {
      if (!lanIp) { t.skip('no non-loopback IPv4 to bind a reachable private target'); return; }
      assert.ok(lanIp);
    });`],
  ['a real skip through a context named otherwise', 'x.test.js', `
    it('x', async (ctx) => {
      if ((members.body.members?.length ?? 0) < 2) { return ctx.skip('Not enough members for this test'); }
      assert.ok(true);
    });`],
  ['the guard that throws on CI', 'x.test.js', `
    it('x', async (t) => {
      if (!requireEmbedding(t, seeded, 'writes unavailable')) return;
      assert.ok(seeded);
    });`],
  ['a guard function in the same file that skips', 'x.test.js', `
    function ready(t) { if (!seeded) { t.skip('seed write unavailable'); return false; } return true; }
    it('x', async (t) => {
      if (!ready(t)) return;
      assert.ok(seeded);
    });`],
  ['an assertion in the branch before the return', 'x.test.js', `
    it('x', () => {
      if (!id) { assert.fail('the fixture produced no id'); return; }
      assert.ok(id);
    });`],
  ['a throw in the branch', 'x.test.js', `
    it('x', () => {
      if (!existsSync(dist)) { throw new Error('the client was not built'); }
      assert.ok(true);
    });`],
  ['a documented outcome, not an absent input: the call was refused', 'x.test.js', `
    it('x', async () => {
      const body = await call({ facts: [{ fact: 'a', superseded: 'yes' }] });
      if (body.refused) return;
      assert.equal(body.errors?.length, 1);
    });`],
  ['a feature that was removed: nothing to be wrong about', 'x.test.js', `
    it('x', () => {
      const at = PIPELINE.indexOf('setImmediate(resolve)');
      if (at < 0) return;   // removed
      assert.ok(at > 0);
    });`],
  ['a waiver the suite declares', 'x.test.js', `
    it('runs with a read-only root filesystem', () => {
      if (WAIVED[name]?.read_only) return;
      assert.equal(services[name]?.read_only, 'true');
    });`],
  ['an alternative outcome that the status word names (a quoted status is not the author skipping)', 'x.test.js', `
    it('x', async () => {
      assert.equal(syncPush.status, 200);
      if (syncPush.body.status === 'forked') {
        assert.equal(forkResp.status, 200);
      } else {
        // If same fact content, 'skipped' is also acceptable
        console.log('  Result: ' + syncPush.body.status);
      }
    });`],
  ['an early return inside a callback ends the callback, not the test', 'x.test.js', `
    it('x', () => {
      items.forEach((i) => { if (!i) return; seen.push(i); });
      assert.equal(seen.length, 2);
    });`],
  ['an early return in a helper that is not a test', 'x.test.js', `
    function first(xs) { if (!xs) return; return xs[0]; }
    it('x', () => { assert.equal(first([1]), 1); });`],
  ['an absence that is handled and the test goes on to assert', 'x.test.js', `
    it('x', () => {
      let cfg = read();
      if (!cfg) { cfg = {}; }
      assert.deepEqual(cfg, {});
    });`],
  ['a skip given as an option, and a test body that always asserts', 'x.test.js', `
    it('x', { skip: !existsSync(p) && 'not fetched' }, () => { assert.ok(read(p)); });`],
];

describe('the table: what ends a test silently, and what does not', () => {
  for (const [name, file, body] of FLAGGED) {
    it(`refuses — ${name}`, () => {
      const hits = silentExits(file, body);
      assert.ok(hits.length >= 1, `not refused; a test that ends here passes green having asserted nothing:\n${body}`);
    });
  }
  for (const [name, file, body] of ALLOWED) {
    it(`allows — ${name}`, () => {
      const hits = silentExits(file, body);
      assert.deepEqual(hits, [], `refused, but this ends the test on something other than an absent input, or skips for real`);
    });
  }

  it('the table has both halves', () => {
    assert.ok(FLAGGED.length >= 8 && ALLOWED.length >= 10,
      'a table with one side empty proves nothing about the other');
  });
});

describe('no test in the repository ends itself quietly on an absent input', () => {
  const files = testFiles();

  it('the scan sees the tests (a floor, because an empty scan passes every loop written over it)', () => {
    const bodies = files.reduce((n, f) => n + testBodies(parseSource(f.file, f.text)).length, 0);
    assert.ok(bodies >= 5000, `only ${bodies} test bodies parsed from ${files.length} files — the parse is broken, not the tests`);
    assert.ok(files.some(f => f.file.startsWith('client/src/')) && files.some(f => f.file.startsWith('testing/sync/')),
      'the scan reaches no client spec or no stack-suite file');
  });

  it('every such branch is a real t.skip, an assertion, or a throw', () => {
    const found = [];
    for (const { file, text } of files) {
      for (const h of silentExits(file, text)) {
        found.push(`${file}:${h.from}${h.to > h.from ? `-${h.to}` : ''}  (${h.shape}) in "${h.test}"`);
      }
    }
    assert.deepEqual(found, [],
      'these end a test green having asserted nothing because something they needed was absent. A log line does not '
      + 'change that. Skip for real (t.skip(reason)), or — where the input must exist in CI — throw:\n  '
      + found.join('\n  '));
  });
});
