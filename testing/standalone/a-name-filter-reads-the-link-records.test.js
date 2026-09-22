/**
 * Filtering by entity NAME reads the link records — the one shape a connection has.
 *
 * ## The defect, measured 2026-09-17
 *
 * A record named an entity two ways and both were documented:
 *
 * | written with | `entityIds` array | link record | found by `entityName` before the fix |
 * |---|---|---|---|
 * | `entityIds: [id]` | populated | written | yes |
 * | `linkEntities: [id]` | **empty** | written | **no** |
 *
 * `linkEntities` was the form the integration guide led with, so the RECOMMENDED way to attach an entity
 * produced a record the documented filter could not find — answering `{facts: [], total: 0}`, which reads
 * as *there are none* rather than *this cannot see them*.
 *
 * **What let it ship is the part to gate.** `link-adjacency.ts` justified reading the arrays as the safe
 * side of its branch with *"the arrays are complete on every space, always"* — true when it was written,
 * and false once `linkEntities` existed, because that path writes the link and leaves the array alone.
 *
 * ## 5.0 removed the second shape, and the gate did not become pointless
 *
 * There is one shape now, so the `$or` is gone and the predicate is an id set. What survives is the rule
 * that produced the bug: **every caller resolving a name to records goes through the one predicate.** A
 * caller building its own filter from the raw resolver is how the first blind one came to exist, and the
 * next one would be blind in a new way rather than the same way.
 *
 * ## Why a source gate as well as the behavioural one
 *
 * `filter-answers-by-entity-name.test.js` drives a real instance and would catch a regression. The
 * structural claim is asserted here too, because the tempting simplification is a caller writing the
 * predicate inline.
 *
 * Run: node --test testing/standalone/a-name-filter-reads-the-link-records.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));
const SCOPE = 'server/src/brain/entity-name-scope.ts';

describe('a name filter reads the link records', () => {
  it('the shared predicate resolves the name through the links', () => {
    const text = src(SCOPE);
    assert.match(text, /linkedFromIds\(/,
      'the predicate no longer reads the link records, which are the only place a connection lives');
    assert.doesNotMatch(text, /entityIds: \{ \$in: entityIds \}/,
      'the 4.x array side is back — it is a predicate over a field no document has, so it can only ever '
      + 'match nothing while looking like a widening');
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

  /*
   * A FOURTH CASE LIVED HERE and its subject is gone. It required `link-adjacency.ts` to name
   * `linkEntities` as the reason neither shape was complete — the correction to *"the arrays are
   * complete on every space, always"*, which is the sentence that made the first name filter blind.
   *
   * It was asserted as a PRESENCE on purpose, because an absence assertion cannot tell a claim from its
   * own obituary. 5.0 removed the arrays, so there is no second shape for a reader to be wrong about,
   * and demanding the warning survive would pin a paragraph about a shape that does not exist. The rule
   * it protected is the one above: one predicate, and every caller goes through it.
   */
});
