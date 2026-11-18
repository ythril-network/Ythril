/**
 * The deleter gate builds its three edge helpers once and computes `unauditedPairs` once (Q-871, bundle-316).
 *
 * ## The defect this refuses
 *
 * `every-server-deleter-writes-an-internal-audit.test.js` wrote its walk's edges as an arrow that built `walkCallbackEdges(index, names)`,
 * `intervalJobEdges(intervalJobRuns(index))` and `dispatchEdges(index)` anew for every function the walk visited: 10 530 builds per
 * `unauditedPairs` call, each a regex scan of every server source, 58 s a call, and two tests each made the call. The gate took 91 s of the 60 s it may
 * take, for an answer identical to building the helpers once (measured: 0.7 s a call, the same (root, sink, path) findings).
 *
 * ## What is asserted, read from the gate's own syntax tree
 *
 * In the describe that walks the real tree (the one that builds `moduleIndex`):
 *
 * - every call of `intervalJobRuns`, `intervalJobEdges`, `walkCallbackEdges` and `dispatchEdges` is made at the describe's own level, once while the
 *   describe is set up, never inside a function nested in it (an arrow handed to the walk, an `it` body), so no caller of the walk repeats the scan;
 * - `unauditedPairs` has exactly one call site, and it is inside a function (computed lazily, so a run of one test with `--test-name-pattern` does not
 *   pay for it, and a throw fails the test that reads it and not the whole describe), which the two tests that read the pairs share.
 *
 * The planted fixture cases below the real-tree describe call `unauditedPairs` and the edge helpers on purpose, each on its own tiny index, and are
 * not part of the rule.
 *
 * Run: node --test testing/standalone/the-deleter-gate-builds-its-edge-helpers-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { parseSource, ts } from '../_shared/syntax-tree.mjs';

const GATE = 'testing/standalone/every-server-deleter-writes-an-internal-audit.test.js';
const EDGE_BUILDERS = ['intervalJobRuns', 'intervalJobEdges', 'walkCallbackEdges', 'dispatchEdges'];

const sf = parseSource(GATE, readFileSync(join(REPO_ROOT, GATE), 'utf8'));
const visit = (node, fn) => { fn(node); ts.forEachChild(node, (c) => visit(c, fn)); };
const calleeName = (c) => (ts.isIdentifier(c.expression) ? c.expression.text : ts.isPropertyAccessExpression(c.expression) ? c.expression.name.text : '');
const callsIn = (node, name) => { const out = []; visit(node, (n) => { if (ts.isCallExpression(n) && calleeName(n) === name) out.push(n); }); return out; };
/** The nearest function the node sits in. */
const functionOf = (node) => { for (let p = node.parent; p; p = p.parent) if (ts.isFunctionLike(p)) return p; return null; };

/** The describe callback that walks the real tree: the one that builds `moduleIndex`. */
const realTreeDescribe = () => {
  const found = [];
  visit(sf, (n) => {
    if (ts.isCallExpression(n) && calleeName(n) === 'describe' && ts.isFunctionLike(n.arguments[1] ?? n) && callsIn(n.arguments[1], 'moduleIndex').length > 0) found.push(n.arguments[1]);
  });
  assert.equal(found.length, 1, `${found.length} describe callbacks build moduleIndex in ${GATE}: the rule is about the one that walks the real tree`);
  return found[0];
};

describe('the deleter gate\'s real-tree describe', () => {
  it('builds each edge helper at its own level, once, and never inside a function nested in the describe', () => {
    const body = realTreeDescribe();
    for (const name of EDGE_BUILDERS) {
      assert.ok(callsIn(body, name).length >= 1,`the real-tree describe never calls ${name}: the scan this rule is about is not there to be read`);
    }
    const nested = EDGE_BUILDERS.flatMap(name => callsIn(body, name).filter(c => functionOf(c) !== body).map(c => `${name} (line ${sf.getLineAndCharacterOfPosition(c.getStart(sf)).line + 1})`));
    assert.deepEqual(nested, [], 'these are called inside a function nested in the describe, so each call of that function repeats the scan (10 530 times per walk, 58 s)');
  });

  it('computes unauditedPairs from exactly one call site, inside a function, so the tests that read the pairs share one lazy computation', () => {
    const body = realTreeDescribe();
    const sites = callsIn(body, 'unauditedPairs');
    assert.equal(sites.length, 1, `${sites.length} call sites of unauditedPairs in the real-tree describe: each test that makes its own call pays the walk again`);
    assert.notEqual(functionOf(sites[0]), body, 'unauditedPairs is computed while the describe is set up: it runs under --test-name-pattern for tests that do not read it, and a throw fails the whole describe');
  });
});
