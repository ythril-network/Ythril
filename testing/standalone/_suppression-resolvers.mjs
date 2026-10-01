/**
 * The functions whose call counts as asking "is this record suppressed?", read out of the code.
 *
 * `embeddingSuppressedFor` is the resolver. A function counts as asking the question when it CALLS one that
 * does, and the search follows that one hop at a time: `suppressedAfterWrite` calls the resolver, and the
 * planners' shared `vectorBeforeWrite` calls `suppressedAfterWrite`. Two gates ask this, and each had its own
 * literal list of names, which goes stale the day the question moves one call further away. That is exactly
 * what happened when the planners' copies were merged into one step.
 *
 * DERIVED, never listed. A wrapper that stops routing to the resolver drops out of the set, so its callers
 * stop counting as checks. The floor is the resolver itself: without it, nothing that uses this checks
 * anything.
 */
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

/** The modules a resolver may be exported from, in the order the hops run. */
const MODULES = ['server/src/brain/suppress-embeddings.ts', 'server/src/brain/write-plan/plan-steps.ts'];

export function suppressionResolvers() {
  const names = ['embeddingSuppressedFor'];
  for (const file of MODULES) {
    const src = stripComments(readFileSync(file, 'utf8'));
    const exported = [...src.matchAll(/^export (?:async )?function (\w+)/gm)].map(m => m[1]);
    // Repeat until nothing new joins: a module may hold a wrapper of its own wrapper.
    for (let grew = true; grew;) {
      grew = false;
      for (const n of exported) {
        if (names.includes(n)) continue;
        const body = bodyOf(src, n).replace(/^[^\n]*\n/, '');
        if (new RegExp(`\\b(?:${names.join('|')})\\s*\\(`).test(body)) { names.push(n); grew = true; }
      }
    }
  }
  const resolver = stripComments(readFileSync(MODULES[0], 'utf8'));
  assert.match(resolver, /^export function embeddingSuppressedFor\b/m,
    'suppress-embeddings.ts no longer exports embeddingSuppressedFor — re-anchor the gates that use this');
  return names;
}

/** A fresh global pattern matching a call to any resolver — fresh per use, so no shared `lastIndex`. */
export function resolverCallPattern(names = suppressionResolvers()) {
  return new RegExp(`\\b(?:${names.join('|')})\\(`, 'g');
}
