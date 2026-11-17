/**
 * A sync suite never calls `POST /api/admin/reload-config` and drops the answer: its status is read, so a dead store fails the setup at once.
 *
 * ## The defect
 *
 * Full run 44163324512's sync job lost `ythril-mongo-b` to the kernel's memory limit during `vote-key-rotation`'s `before` hook. The hook had
 * called `reload-config` on B and thrown the answer away; B answered 503 with the cause in its body, and the hook went on. The first test then
 * waited 12 s for B to store A's key and the second 15 s, and two other suites' hooks failed later with `503 !== 201` and `Space ... not found`.
 * Fifteen tests were cancelled and every message said "timed out" or "not found", never "the database is down".
 *
 * ## The rule, over the whole set
 *
 * In every tracked file under `testing/sync/`, a call that posts to `/api/admin/reload-config` has its result READ: assigned, awaited into an
 * assertion or passed on (`reloadConfig` in `helpers.js` asserts 200 and puts the body in its message). A call whose result is dropped (a
 * statement of its own, with or without `.catch`) fails, wherever it stands, except inside an `after`/`afterEach` hook: a teardown restores
 * what it can and must not hide the failure that ended the test.
 *
 * The scope is the repository's tracked files, parsed: a new suite is covered without editing this file. A copy of the bad statement is
 * planted in a source below and must be refused, and the call forms that read their result must pass.
 *
 * Run: node --test testing/standalone/a-sync-reload-config-call-asserts-its-status.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { ts, parseSource, lineOf, walkEveryNode } from '../_shared/syntax-tree.mjs';

const ROUTE = '/api/admin/reload-config';
const TEARDOWN = new Set(['after', 'afterEach']);

/** The hook or test a node stands in, by the name of the nearest enclosing call that carries a function: `after`, `before`, `it`, … or null. */
function enclosingCallName(node) {
  for (let p = node.parent; p; p = p.parent) {
    if (ts.isFunctionLike(p) && p.parent && ts.isCallExpression(p.parent)) {
      const e = p.parent.expression;
      return ts.isIdentifier(e) ? e.text : ts.isPropertyAccessExpression(e) ? e.name.text : null;
    }
  }
  return null;
}

/** Is the value of this call thrown away: a statement of its own, through any `await`, parentheses or `.catch(...)`? */
function resultIsDropped(call) {
  let n = call;
  for (;;) {
    const p = n.parent;
    if (ts.isAwaitExpression(p) || ts.isParenthesizedExpression(p)) { n = p; continue; }
    if (ts.isPropertyAccessExpression(p) && p.expression === n && p.name.text === 'catch' && ts.isCallExpression(p.parent)) { n = p.parent; continue; }
    return ts.isExpressionStatement(p);
  }
}

/** The helper of `testing/sync/helpers.js` that posts to the route and throws on any answer but 200: awaited, it is the assertion. */
const HELPER = 'reloadConfig';

const postsToRoute = (n) => ts.isCallExpression(n) && n.arguments.some(a => ts.isStringLiteralLike(a) && a.text === ROUTE);
const callsHelper = (n) => ts.isCallExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === HELPER;

/**
 * `[{ line, text }]`: every call in `text` that reloads an instance's config and does not read the answer, outside a teardown hook: a post to
 * the route whose result is dropped, or the helper called without `await` (its throw would then be a rejection nobody holds).
 */
export function bareReloadCalls(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  walkEveryNode(sf, (n) => {
    const bare = postsToRoute(n) ? resultIsDropped(n) : callsHelper(n) && ts.isExpressionStatement(n.parent);
    if (!bare || TEARDOWN.has(enclosingCallName(n))) return;
    out.push({ line: lineOf(sf, n), text: n.getText(sf).replace(/\s+/g, ' ') });
  });
  return out;
}

/** Every call in `text` that reloads a config, by either spelling, read or not. */
function reloadCalls(file, text) {
  let count = 0;
  walkEveryNode(parseSource(file, text), (n) => { if (postsToRoute(n) || callsHelper(n)) count += 1; });
  return count;
}

const sources = readTrackedSources(['testing/sync'], { ext: ['.js'], floor: 15 });

describe('a sync suite reads the status of every reload-config call', () => {
  it('finds the reload calls at all, so the scan is not empty', () => {
    const total = sources.reduce((sum, s) => sum + reloadCalls(s.file ?? s.path, s.text), 0);
    assert.ok(total >= 15, `only ${total} reload-config calls found in testing/sync: the route or the helper is spelled another way, so this gate would pass over nothing`);
  });

  it('no call drops its answer outside a teardown hook', () => {
    const found = sources.flatMap(s => bareReloadCalls(s.file ?? s.path, s.text).map(c => `${s.file ?? s.path}:${c.line}  ${c.text}`));
    assert.deepEqual(found, [], 'these calls go on after a 503 from a dead store, and the suite then times out with no word of the cause: use reloadConfig(base, token) from helpers.js');
  });

  describe('the rule is applied: the bad shape is refused and the good shapes pass', () => {
    const call = `post(INSTANCES.b, tokenB, '${ROUTE}', {})`;
    const inHook = (hook, body) => `describe('x', () => { ${hook}(async () => { ${body} }); });`;

    it('a bare statement in a before hook is refused, with and without await and catch', () => {
      for (const body of [`await ${call};`, `${call};`, `await ${call}.catch(() => {});`, `await (${call});`]) {
        const found = bareReloadCalls('planted.test.js', inHook('before', body));
        assert.equal(found.length, 1, `not refused: ${body}`);
      }
    });

    it('a call in an it body is held to the same rule', () => {
      assert.equal(bareReloadCalls('planted.test.js', inHook('it', `await ${call};`)).length, 1);
    });

    it('a call whose result is read passes', () => {
      for (const body of [`const r = await ${call}; assert.equal(r.status, 200);`, `assert.equal((await ${call}).status, 200);`, `must(await ${call}, 'reload');`, `return ${call};`]) {
        assert.deepEqual(bareReloadCalls('planted.test.js', inHook('before', body)), [], `refused: ${body}`);
      }
    });

    it('the helper called without await is refused, and awaited or returned it passes', () => {
      const helper = 'reloadConfig(INSTANCES.b, tokenB)';
      assert.equal(bareReloadCalls('planted.test.js', inHook('before', `${helper};`)).length, 1);
      for (const body of [`await ${helper};`, `return ${helper};`]) assert.deepEqual(bareReloadCalls('planted.test.js', inHook('before', body)), [], `refused: ${body}`);
    });

    it('a bare call in an after hook passes: a teardown restores what it can', () => {
      assert.deepEqual(bareReloadCalls('planted.test.js', inHook('after', `await ${call}.catch(() => {});`)), []);
    });
  });
});
