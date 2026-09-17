/**
 * Filtering by entity NAME must read both shapes a link can take — the array and the link record.
 *
 * ## The defect, measured 2026-09-17
 *
 * A record names an entity two ways and both are documented:
 *
 * | written with | `entityIds` array | link record | found by `entityName` before the fix |
 * |---|---|---|---|
 * | `entityIds: [id]` | populated | written | yes |
 * | `linkEntities: [id]` | **empty** | written | **no** |
 *
 * `linkEntities` is the form the integration guide leads with, so the RECOMMENDED way to attach an entity
 * produced a record the documented filter could not find — answering `{facts: [], total: 0}`, which reads
 * as *there are none* rather than *this cannot see them*.
 *
 * **What let it ship is the part to gate.** `link-adjacency.ts` justifies reading the arrays as the safe
 * side of its branch with *"the arrays are complete on every space, always"* — true when it was written,
 * and false once `linkEntities` existed, because that path writes the link and leaves the array alone.
 *
 * ## Why a source gate as well as the behavioural one
 *
 * `filter-answers-by-entity-name.test.js` drives a real instance and would catch a regression. It needs a
 * fixture written BOTH ways to do it, and the tempting simplification — one fixture, one shape — is exactly
 * what makes it stop covering this. So the structural claim is asserted here too: every caller resolving a
 * name to records goes through the one predicate, and that predicate names both sides.
 *
 * Run: node --test testing/standalone/a-name-filter-reads-both-link-shapes.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));
const SCOPE = 'server/src/brain/entity-name-scope.ts';

describe('a name filter reads both link shapes', () => {
  it('the shared predicate covers the array AND the link records', () => {
    const text = src(SCOPE);
    assert.match(text, /entityIds: \{ \$in: entityIds \}/,
      'the legacy array side is gone — every record written before the link records would drop out');
    assert.match(text, /linkedFromIds\(/,
      'the link-record side is gone — every record written with `linkEntities` would drop out');
    assert.match(text, /\$or:/,
      'the two sides must be alternatives on one record set; a merge would require BOTH to match');
  });

  it('an unmatched name yields a predicate that matches nothing', () => {
    /*
     * The direction that fails dangerously. Returning `{}` — no constraint — turns a typo into a
     * full-collection read that is indistinguishable from a successful search, and a caller reading a page
     * of unrelated records has no reason to suspect the filter.
     */
    const text = src(SCOPE);
    assert.match(text, /_id: \{ \$in: \[\] \}/,
      'an empty resolution must produce a predicate that matches nothing, never an absent one');
  });

  it('every caller that filters by entity name goes through it', () => {
    /*
     * DERIVED: any source resolving a name to ids and using it as a record filter must reach the shared
     * predicate. The sweep looks for the raw resolver being used to build an `entityIds` constraint by
     * hand, which is the shape all three call sites had before — two routes and the tool, one of them
     * added on the same day as the fix.
     */
    const offenders = [];
    for (const f of trackedSources(['server/src/api', 'server/src/mcp'], { floor: 30, untracked: true })) {
      const text = src(f);
      if (/entityIds'?\]?\s*=\s*\{\s*\$in:\s*await resolveEntityIdsByName/.test(text)
        || /entityIds:\s*\{\s*\$in:\s*await resolveEntityIdsByName/.test(text)) {
        offenders.push(f);
      }
    }
    assert.deepEqual(offenders, [],
      'these build the entity-name filter from the raw resolver, so they read the ARRAY only and miss every '
      + 'record written with `linkEntities`. Use `attachedToEntityNamed` from brain/entity-name-scope.ts:\n  '
      + offenders.join('\n  '));
  });

  it('and the stale claim that justified the old branch is corrected where it lives', () => {
    /*
     * The sentence is load-bearing: `link-adjacency.ts` reads the arrays as the safe side BECAUSE of it. A
     * reader who believes it will write the next name filter the same way, so the correction belongs next
     * to the claim rather than only in a commit message.
     */
    // Read RAW, not through `stripComments`: the subject IS a comment. Stripping first made this assertion
    // pass against a file that still carried the sentence.
    const adjacency = readFileSync('server/src/brain/link-adjacency.ts', 'utf8');

    /*
     * ASSERTED AS A PRESENCE, and the first two attempts are why.
     *
     * The obvious gate is "the file no longer says the arrays are always complete". It failed twice: the
     * sentence lived in a docblock, so `stripComments` removed it and the assertion passed against a file
     * that still carried it; then it WRAPPED across two comment lines, so a literal regex matched nothing.
     * Fixed both, and it failed a third time — correctly — because the correction QUOTES the old sentence
     * in order to record what stopped being true. An absence assertion cannot tell a claim from its own
     * obituary.
     *
     * So the claim is that the correction is THERE: the file must name `linkEntities` as the reason
     * neither side is complete. That cannot be satisfied by deleting the sentence and leaving the next
     * reader to make the same assumption, which is the outcome the absence version would have accepted.
     */
    assert.match(adjacency, /linkEntities/,
      'link-adjacency.ts does not mention `linkEntities`, so nothing there warns the next reader that the '
      + 'arrays are incomplete — which is the assumption that made the name filter blind');
    assert.match(adjacency, /entity-name-scope/,
      'and it must point at the predicate that reads both sides, or a reader who needs completeness has '
      + 'no way to find it from here');
  });
});
