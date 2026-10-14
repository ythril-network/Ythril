/**
 * Every answer that carries a space's config entry passes it through `spaceForWire` — and what that removes is the local bookkeeping and
 * nothing a caller sets (bundle-113 pre-ship sweep, privacy finding on `SpaceConfig.leakedRowScan`).
 *
 * ## The rule
 *
 * The space routes answered the live config entry whole (`{ space: result.space }`), and the leaked-rows repair writes the last file path
 * its link phase read onto that entry. **The set is derived, not listed:** every `space:` property in `server/src` whose value is a result
 * variable of an act that answers a space (`r.space`, `result.space`, `updated`) is such an answer, found by reading the source with its
 * comments stripped; each must be `spaceForWire(...)`. A fifth route that answers `{ space: updated }` is caught by the pattern, not by
 * an edit to this file. A floor holds the scan: it must find the wrapped answers that exist.
 *
 * ## What the function removes
 *
 * `LOCAL_BOOKKEEPING_KEYS` and nothing else: the entry's other fields (id, label, folders, meta, quotas) are the answer and come back
 * untouched, and the live entry is not modified (a copy is returned).
 *
 * Run: node --test testing/standalone/a-space-is-answered-through-the-one-wire-shape.test.js
 * (requires a prior `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The `space:` of an ANSWER (a `.json({` or a `body: {`, not an internal outcome type) that is the space an act returned, wrapped or not. */
const ANSWERED = /(?:\.json\(\s*\{|\bbody:\s*\{)\s*space:\s*((?:spaceForWire\()?(?:r\.space|result\.space|updated)\b)/g;

describe('a space is answered through the one wire shape', () => {
  it('every answer that carries the entry an act returned is shaped by spaceForWire', () => {
    const wrapped = [];
    const bare = [];
    for (const file of trackedSources(['server/src'], { floor: 100 })) {
      const text = stripComments(readFileSync(file, 'utf8'));
      for (const m of text.matchAll(ANSWERED)) (m[1].startsWith('spaceForWire(') ? wrapped : bare).push(`${file}: space: ${m[1]}`);
    }
    assert.ok(wrapped.length >= 5, `the scan found ${wrapped.length} wrapped answers: the pattern no longer finds the answers this rule is about`);
    assert.deepEqual(bare, [], 'an answer carries a space\'s config entry whole: its local bookkeeping (the scan cursor, with a file path in it) reaches the caller');
  });

  it('removes the bookkeeping keys, keeps every other field, and leaves the live entry alone', async () => {
    const { spaceForWire, LOCAL_BOOKKEEPING_KEYS } = await import('../../server/dist/spaces/space-for-wire.js');
    assert.ok(LOCAL_BOOKKEEPING_KEYS.includes('leakedRowScan'), 'the scan cursor is not among the keys the wire shape removes');
    const live = { id: 's', label: 'S', builtIn: false, folders: ['a'], maxGiB: 2, meta: { purpose: 'p' }, leakedRowScan: { phase: 'links', after: 'x/y.txt' } };
    const answer = spaceForWire(live);
    assert.deepEqual(answer, { id: 's', label: 'S', builtIn: false, folders: ['a'], maxGiB: 2, meta: { purpose: 'p' } });
    assert.deepEqual(live.leakedRowScan, { phase: 'links', after: 'x/y.txt' }, 'the live entry lost its cursor');
  });
});
