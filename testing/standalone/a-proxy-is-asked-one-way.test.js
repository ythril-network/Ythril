/**
 * "Is this space a proxy?" has one answer, `isProxy` in `spaces/proxy.ts`, and nothing tests `proxyFor` by hand.
 *
 * ## How this was found (`Q-80`)
 *
 * The question was answered about forty times in two spellings. A truthy `proxyFor` (`if (s.proxyFor)`,
 * `!s.proxyFor`) and a non-empty one (`s.proxyFor?.length`, `isProxy`) agree on every value but one: an
 * empty member list, which the API refuses (`ProxyForZ` is `min(1)`) and only a hand-edited config reaches.
 * There the split was real damage, not a style question — the space was served as a real space (reads
 * resolved it to itself) while the embed worker, the dupe and contradiction scanners, the tombstone and
 * candidate prunes and the metrics all treated it as a proxy and skipped it, and deleting it took the proxy
 * branch and left its collections behind.
 *
 * Two halves fix it: the loader normalises `proxyFor: []` away (`a-hand-edited-empty-proxy-list-is-a-real-space`),
 * and every test goes through `isProxy`, which this file holds.
 *
 * ## What is derived, and why the instrument is tested first
 *
 * Every `proxyFor` in the server's tracked sources — property, element access or a bare destructured name —
 * classified by the SYNTAX TREE as a test (truthiness, `!`, `&&`/`||`, a condition, `.length`, a comparison)
 * or as data (`.join(`, `[0]`, `{ proxyFor: … }`, an assignment). A classifier that called everything data would
 * pass this gate for ever, so its own cases run before its verdict is trusted.
 *
 * Run: node --test testing/standalone/a-proxy-is-asked-one-way.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { serverSources, proxyTests, parseSnippet } from '../_shared/proxy-questions.mjs';

describe('the classifier tells a test from a read', () => {
  const tests = [
    'if (s.proxyFor) continue;',
    'const ok = !s.proxyFor;',
    'if (s.proxyFor?.length) continue;',
    'const p = space.proxyFor && space.proxyFor.length > 0;',
    'const x = s.proxyFor ? 1 : 2;',
    'if (proxyFor && other) run();',
    "const w = space['proxyFor'] ? 1 : 0;",
    'const u = s.proxyFor !== undefined;',
  ];
  const reads = [
    'const list = space.proxyFor.join(", ");',
    'const idx = s.proxyFor.indexOf(oldId);',
    'const body = { proxyFor: space.proxyFor };',
    's.proxyFor = next;',
    'const first = s.proxyFor[0];',
    'const members = s.proxyFor ?? [];',
    'interface A { proxyFor?: string[] }',
    'const { proxyFor } = parsed;',
  ];
  for (const t of tests) {
    it(`a test: ${t}`, () => assert.ok(proxyTests([parseSnippet(t)]).length >= 1, `not seen as a test: ${t}`));
  }
  for (const r of reads) {
    it(`a read: ${r}`, () => assert.equal(proxyTests([parseSnippet(r)]).length, 0, `read mistaken for a test: ${r}`));
  }
});

describe('every server-side proxy test goes through isProxy', () => {
  const found = proxyTests(serverSources());
  it('no `proxyFor` is tested by hand outside the answer', () => {
    assert.deepEqual(found.map(f => `${f.file}:${f.line}  ${f.text}`), [],
      `${found.length} hand-written proxy test(s). Ask isProxy(space) — or isWildcardProxy / concreteSpaces — `
      + 'so an empty member list gets the same answer everywhere.');
  });
});
