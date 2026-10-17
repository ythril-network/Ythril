/**
 * An act entry is removed ONLY by the completion's one config write, which also forgets the receive marks it names and settles its rounds (bundle-106 PR A, X1, §2.6).
 *
 * ## What the rule prevents
 *
 * The hold between two members lifts when the act entry goes (hold (a) reads the entry). If the entry were removed in one write and the
 * marks forgotten in another, an exchange admitted between the two would write a pre-wipe mark back — and the member would refill
 * the space from its old position, or never re-read the files a wipe emptied (DI S7a). And if the rounds were settled in a third write, a crash
 * between them leaves a round `appliedHere` for an act whose entry is still standing, or an entry gone for a round still owed. So the removal, the
 * `postSteps` and the settling of every round in `rounds` are ONE `mutateConfig` callback — and no other code removes an entry.
 *
 * ## The two halves
 *
 * - **Source (here, pure):** every site that removes an entry from `pendingSpaceActs` (a `delete`, a `filter` that drops one, a `splice`, an empty
 *   assignment) is derived over `server/src` — the runner's source for the removals, the whole tree for a stray — and each is inside a `mutateConfig(`
 *   callback that calls `forgetReceiveMarks(` and `settleSpaceAct(`. The floor: at least one removal site exists (an empty set passes every loop).
 * - **Driven (`a-space-act-runner-runs-registers-and-retries-db.test.js`):** a completed wipe leaves no entry, forgotten marks and `appliedHere` rounds
 *   in ONE step of `configWriteGeneration()`.
 *
 * ## Seen red
 *
 * On the base there is no runner. After it: move the entry removal out of the completion callback (design §6.3 step 51).
 *
 * Run: `node --test testing/standalone/every-act-entry-is-cleared-with-its-post-steps.test.js`
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { RUNNER, requireSource, serverSources } from './_space-act-sources.mjs';

/** The shapes of "this removes an entry from the list", each with the offset of the removal itself. */
const REMOVAL = [
  /delete\s+[\w.]*pendingSpaceActs\b/g,
  /pendingSpaceActs\s*=\s*(?:undefined|\[\s*\])/g,
  /pendingSpaceActs\s*=\s*[\w.?]*pendingSpaceActs[\w.?]*\.filter\s*\(/g,
  /pendingSpaceActs[\w.?]*\.splice\s*\(/g,
];

/** The index of the `)` matching the `(` at `open`, skipping string and template literals; -1 when unbalanced. */
function closeOf(src, open) {
  let depth = 0;
  for (let i = open; i < src.length; i++) {
    const c = src[i];
    if (c === '\'' || c === '"' || c === '`') {
      for (i++; i < src.length && src[i] !== c; i++) if (src[i] === '\\') i++;
      continue;
    }
    if (c === '(') depth++;
    else if (c === ')' && --depth === 0) return i;
  }
  return -1;
}

/** Every removal site in `src`: `{ at, text }`. */
const removalsIn = (src) => REMOVAL.flatMap(re => [...src.matchAll(re)].map(m => ({ at: m.index, text: m[0] })));

/** The text of the innermost `mutateConfig(…)` call that contains `at`, or null when the site is not inside one. */
function enclosingMutateConfig(src, at) {
  for (let from = at; (from = src.lastIndexOf('mutateConfig(', from)) >= 0; from--) {
    const open = from + 'mutateConfig'.length;
    const close = closeOf(src, open);
    if (close > at) return src.slice(open, close + 1);
  }
  return null;
}

describe('an act entry is removed only inside the completion\'s one config write', () => {
  it('the runner removes entries, and every removal is inside a mutateConfig callback that forgets the receive marks and settles the rounds', () => {
    const src = requireSource(RUNNER);
    const sites = removalsIn(src);
    assert.ok(sites.length >= 1, 'the runner has no site that removes an entry: the completion does not exist, or the derivation is broken');
    for (const { at, text } of sites) {
      const callback = enclosingMutateConfig(src, at);
      assert.ok(callback, `a removal (\`${text}\`) is not inside a mutateConfig callback: the entry goes in a write of its own`);
      assert.match(callback, /\bforgetReceiveMarks\s*\(/, `the write that removes an entry (\`${text}\`) does not forget the receive marks its postSteps name`);
      assert.match(callback, /\bsettleSpaceAct\s*\(/, `the write that removes an entry (\`${text}\`) does not settle the rounds the entry covers`);
    }
  });

  it('no other module removes an entry: outside the runner the list is not touched to take an entry away', () => {
    const stray = [];
    for (const [file, src] of serverSources()) {
      if (file === RUNNER) continue;
      if (removalsIn(src).length > 0) stray.push(file);
    }
    assert.deepEqual(stray, [], `an entry is removed outside the completion: ${stray.join(', ')}`);
  });

  it('the postSteps are carried on the entry (X1), and forgetReceiveMarks lives beside setMemberSpaceMark in sync/member-space-mark.ts', () => {
    // `SpaceActEntry` is declared in its own module (`types.ts` is frozen by the size ratchet and re-exports it).
    assert.match(requireSource('server/src/config/types-space-acts.ts'), /postSteps\s*:\s*\{[^}]*forgetReceiveMarks/s, 'SpaceActEntry carries no postSteps.forgetReceiveMarks');
    assert.match(requireSource('server/src/sync/member-space-mark.ts'), /export\s+function\s+forgetReceiveMarks\s*\(/, 'forgetReceiveMarks is not exported from sync/member-space-mark.ts');
  });
});
