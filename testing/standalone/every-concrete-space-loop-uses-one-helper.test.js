/**
 * A walk over the spaces that own collections iterates `concreteSpaces()`, and never skips proxies by hand.
 *
 * ## How this was found (`Q-98`)
 *
 * *"For each configured space, skip the proxies"* was written at every loop that wanted it — the sweeps, the
 * scanners, the prunes, the metrics collectors eight times over — each with its own copy of the proxy test and,
 * in about half of them, its own `try { getConfig() } catch` for the pre-setup case. The copies that FORGOT
 * were the expensive ones, and the ticket's own list did not name them: `initAllSpaces` created every proxy's
 * collections at every boot (the reload path skipped proxies, so the two disagreed), the restore rebuild
 * reconciled proxies' search indexes, and the media worker filtered ids through a lookup per id.
 *
 * All three iterated a VARIABLE holding the list — which is why a regex sweep missed them and this reads the
 * syntax tree instead, following the list by data flow from `getConfig()`.
 *
 * ## The two rules
 *
 *   1. A walk over the configured spaces does not EXCLUDE proxies by hand (`!isProxy(s)`, `if (s.proxyFor)
 *      continue`). Selecting them is a different question — a rename rewriting every proxy's member list — and
 *      is not refused.
 *   2. A walk whose body reaches a space collection directly (`col(`, `spaceCollection(`, `initSpace(`,
 *      `reconcileSpaceSearchIndexes(`) iterates `concreteSpaces()`, because a proxy owns no collections.
 *
 * Run: node --test testing/standalone/every-concrete-space-loop-uses-one-helper.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serverSources, configSpaceIterations, parseSnippet } from '../_shared/proxy-questions.mjs';

describe('the derivation follows the list, not the spelling', () => {
  const cases = [
    ['a direct for-of', 'for (const s of getConfig().spaces) { if (s.proxyFor) continue; col(x); }', { proxySkip: true, reaches: true }],
    ['through a variable', 'const spaces = getConfig().spaces ?? [];\nawait mapLimit(spaces, 4, async (space) => initSpace(space.id));', { proxySkip: false, reaches: true }],
    ['through an id list', 'const ids = getConfig().spaces.map(s => s.id);\nfor (const id of ids) await initSpace(id);', { proxySkip: false, reaches: true }],
    ['through a try-assigned config', 'let cfg;\ntry { cfg = getConfig(); } catch { return; }\nfor (const s of cfg.spaces) { if (isProxy(s)) continue; }', { proxySkip: true, reaches: false }],
    ['a filter negation', 'const ids = getConfig().spaces.filter(s => !isProxy(s));', { proxySkip: true, reaches: false }],
  ];
  for (const [label, code, expected] of cases) {
    it(label, () => {
      const found = configSpaceIterations([parseSnippet(code)]);
      assert.ok(found.length >= 1, `no iteration found in: ${code}`);
      assert.ok(found.some(f => f.proxySkip === expected.proxySkip && f.reaches === expected.reaches),
        `expected ${JSON.stringify(expected)} in ${JSON.stringify(found)}`);
    });
  }
  it('selecting proxies is not skipping them', () => {
    const found = configSpaceIterations([parseSnippet('for (const s of cfg0.spaces) {}\nconst cfg = getConfig();\nfor (const s of cfg.spaces) { if (isProxy(s)) { rewrite(s); } }')]);
    assert.ok(found.every(f => !f.proxySkip), JSON.stringify(found));
  });
  it('concreteSpaces() is not a config list, so walking it is never reported', () => {
    assert.deepEqual(configSpaceIterations([parseSnippet('for (const s of concreteSpaces()) col(s.id);')]), []);
  });
});

describe('every walk over the concrete spaces asks concreteSpaces()', () => {
  const found = configSpaceIterations(serverSources());
  it('the derivation found the walks (a floor, so an empty scan fails)', () => {
    assert.ok(found.length >= 50, `only ${found.length} walk(s) over the configured spaces found`);
  });
  it('no walk over the configured spaces skips proxies by hand', () => {
    const bad = found.filter(f => f.proxySkip).map(f => `${f.file}:${f.line}  ${f.text}`);
    assert.deepEqual(bad, [], `${bad.length} hand-written proxy skip(s) — iterate concreteSpaces() instead`);
  });
  it('no walk that reaches a space collection iterates every configured space', () => {
    const bad = found.filter(f => f.reaches).map(f => `${f.file}:${f.line}  ${f.text}`);
    assert.deepEqual(bad, [], `${bad.length} walk(s) open a collection for every space, proxies included — `
      + 'iterate concreteSpaces()');
  });
});
