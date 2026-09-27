/**
 * The suppression sweep is never handed a meta it might not have (`Q-74`).
 *
 * `spaces/meta-update.ts` swept after every space update and passed `mergedMeta as SpaceMeta` — but `mergedMeta`
 * is undefined whenever the patch carries no `meta` (a `textAnalysis`-only PATCH, say). The sweep then read
 * `typeSchemas` of undefined and logged "Suppression sweep failed" on every such write: a warning that means
 * nothing, which teaches an operator to ignore the one that does.
 *
 * The cast is what let it compile. The sweep's parameter type already refuses an undefined meta, so the rule is
 * that no caller casts its way past it — asserted over every call site in the server, not over the two there
 * are today.
 *
 * Run: node --test testing/standalone/the-suppression-sweep-is-never-handed-a-meta-it-might-not-have.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const calls = [];
for (const f of trackedSources('server/src', { specs: false })) {
  const src = stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
  for (const m of src.matchAll(/sweepSuppressedVectors\(([^)]*)\)/g)) {
    if (/^\s*spaceId: string/.test(m[1])) continue;   // the definition, not a call
    calls.push({ f, args: m[1] });
  }
}

describe('every caller of the suppression sweep passes a meta the compiler has checked', () => {
  it('finds the callers (the scan itself works)', () => {
    assert.ok(calls.length >= 1, 'no call to sweepSuppressedVectors found — the scan is looking in the wrong place');
  });
  it('no caller casts the meta argument', () => {
    const cast = calls.filter(c => /\bas\s+\w/.test(c.args)).map(c => `${c.f}: sweepSuppressedVectors(${c.args})`);
    assert.deepEqual(cast, [], 'a cast silences the check that the space has a meta at all');
  });
});
