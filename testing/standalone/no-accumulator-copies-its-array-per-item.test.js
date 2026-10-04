/**
 * No map of lists is grown by copying the list on every item — `m.set(k, [...(m.get(k) ?? []), x])` — anywhere in
 * the server (bundle-30 I13, pre-ship performance PERF-1).
 *
 * ## The defect
 *
 * The strict-linkage check grouped its targets by kind that way. Each item copies everything already grouped under
 * its key, so n items under one key cost n²/2 copies, synchronously, on the event loop: measured 796 ms at 20 000
 * targets and 4 074 ms at 40 000 — and a 50-page pull lands 20 000 edges per strict space per peer per cycle, every
 * request on the instance stalled meanwhile. It reads as idiomatic and passes every test at fixture sizes.
 *
 * ## What is asserted
 *
 * Every tracked server source, comments stripped: no `.set(K, [...(M.get(K) ?? []), …])` with the SAME key on both
 * sides. A copy under a DIFFERENT key (`pathTo.set(next, [...pathTo.get(prev), step])`) builds a new path from an
 * old one and is not an accumulation, so it is not matched.
 *
 * Run: node --test testing/standalone/no-accumulator-copies-its-array-per-item.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

describe('no accumulator copies its array per item', () => {
  it('no map of lists is grown by spreading its own list back under the same key', () => {
    const found = [];
    for (const { file, text } of readTrackedSources('server/src')) {
      const code = stripComments(text);
      // Built fresh per file: a shared global regex would carry `lastIndex` from one file into the next.
      const copy = /(\w+)\.set\(\s*([\w.!]+)\s*,\s*\[\s*\.\.\.\(?\s*\1\.get\(\s*\2\s*\)/g;
      for (const m of code.matchAll(copy)) found.push(`${file}: ${m[0]}`);
    }
    assert.deepEqual(found, [], `a list grown by copying itself per item (quadratic) — push onto the existing array:\n  ${found.join('\n  ')}`);
  });
});
