/**
 * `recall`'s expansion reaches the same records the standalone traversal does, behind the same flags.
 *
 * ## The defect this replaces a warning with
 *
 * Two records can be related two ways: a stored EDGE, or a `entityIds` field on a memory, chrono entry or
 * file saying which entities it is about. `traverseGraph` — the standalone `traverse` tool — follows both.
 * `traverseFromSeeds`, which is what `recall` expands with, followed edges alone.
 *
 * So in a space whose relationships are mentions rather than edge records — which is most spaces, because
 * mentions happen automatically and edges are written on purpose — a `recall` with `traverse` returned
 * `graphNodes: 0`. Not an error, not a warning: the graph simply looked empty, which reads as a statement
 * about the data.
 *
 * `both-doors-say-a-memory-seed-reaches-nothing.test.js` used to pin the warning both doors carried about
 * that limit, and it was written to FAIL the day the limit was lifted — *"a docs gate that never looked at
 * the code would keep enforcing a stale warning, which is the same defect one direction over."* It fired, and
 * it is deleted rather than kept. This file is what stands in its place.
 *
 * ## The flags default OFF, and that is the decision rather than an oversight
 *
 * `traverseGraph` defaults chrono ON, because its caller is explicitly exploring a graph and a flag defaulting
 * off leaves the graph looking the same to everyone who does not already know the answer.
 *
 * `recall`'s caller asked for semantic matches. Expansion is decoration, and a budgeted answer counts a match
 * together with its whole subtree — so spending the byte budget on records nobody asked for is paid in
 * matches that no longer fit. Off by default changes no existing response, which is the only reason a change
 * this wide is reviewable at all. Raising chrono to ON in recall is a one-line follow-up somebody can argue
 * for on its own merits.
 *
 * Run: node --test testing/standalone/recall-expands-the-same-links-query-does.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/** The three link classes, by the flag that admits each. */
const FLAGS = [
  { flag: 'includeChrono', cls: 'chrono' },
  { flag: 'includeMemories', cls: 'fact' },
  { flag: 'includeFiles', cls: 'file' },
];

describe('the seed traversal reads links, not only edges', () => {
  it('it goes through the shared adjacency definition', () => {
    /*
     * `linksToAny` and `LINK_CLASSES` exist because "what is adjacent to this record" was implemented five
     * times and the five disagreed. A second hand-rolled `entityIds` query here would make it six — and this
     * traversal is the one that was already wrong.
     */
    const body = bodyOf(src('server/src/brain/recall-seed-traversal.ts'), 'traverseFromSeeds');
    assert.match(body, /linkedRecordsAtFrontier\(/,
      'the seed traversal must reach links through the shared scan, not its own query');
    assert.match(body, /entitiesLinkedFromRecords\(/,
      'a non-entity seed is a dead end again unless its own links are read');
    assert.doesNotMatch(body, /entityIds:\s*\{\s*\$in/,
      'a hand-rolled entityIds query here is a sixth implementation of adjacency');
    // The other direction of the same rule: `traverseGraph` had three copies of this scan and must not keep
    // one, or the pair drifts exactly as the edge query did before `frontierEdgeQuery` existed.
    assert.doesNotMatch(bodyOf(src('server/src/brain/edges.ts'), 'traverseGraph'), /entityIds:\s*\{\s*\$in/,
      'the standalone traversal kept its own link query, so there are two implementations again');
  });

  it('a link hop carries a synthetic edge, because there is no stored one', () => {
    // The standalone traversal already solved this: a link is not an edge record, so the hop that reached the
    // node gets `<label>:<from>:<to>`. Returning a null edge instead would make every consumer branch.
    const body = bodyOf(src('server/src/brain/recall-seed-traversal.ts'), 'traverseFromSeeds');
    assert.match(body, /syntheticEdgeId\(/,
      'a link hop needs an edge to report; the standalone traverse mints a synthetic one for exactly this');
  });

  it('a reached node says what KIND it is, and the shaper reads it', () => {
    /*
     * Stamped on the RECORD, which is where `TraverseNode.kind` already puts it and the only place the
     * shaper can see — `mapGraphNodes` hands `shapeNode` the document alone. A second copy on the neighbour
     * would be one fact in two places, which is this repo's signature defect.
     */
    assert.match(bodyOf(src('server/src/brain/recall-seed-traversal.ts'), 'traverseFromSeeds'), /kind:/,
      'the seed traversal must stamp the reached record\'s kind on it');
    const shaper = bodyOf(src('server/src/brain/recall-graph.ts'), 'graphNodeRecord');
    assert.match(shaper, /\bkind\b/,
      'graphNodeRecord shapes an entity allowlist regardless of kind, so a memory arrives with no fact');
  });
});

describe('both doors take the same three flags', () => {
  for (const { flag } of FLAGS) {
    it(`${flag} reaches recall on REST and MCP`, () => {
      /*
       * One API, two doors. A flag on one surface and not the other is the parity defect `CLAUDE.md` calls
       * the most expensive lesson in this codebase — and it is what made this row's own subject invisible:
       * the standalone tool had these flags all along.
       */
      const parser = src('server/src/brain/traverse-option.ts');
      assert.match(parser, new RegExp(`\\b${flag}\\b`),
        `${flag} is not parsed, so neither door can accept it`);
      assert.match(parser.slice(parser.indexOf('TRAVERSE_OPTION_FIELDS')), new RegExp(`'${flag}'`),
        `${flag} is missing from TRAVERSE_OPTION_FIELDS, so both doors refuse it as an unknown key`);
      /*
       * DISCOVERABILITY ONLY, and saying so is the correction this comment exists to carry.
       *
       * The schema description is what a caller reads while constructing arguments, so a capability absent
       * from it is one nobody reports. But a description is prose ABOUT a schema and decides nothing: this
       * assertion passed on the day the flags shipped, while the `inputSchema` that guards them still
       * declared three keys with `additionalProperties: false` and the dispatcher refused every call the
       * description told a caller to make. A gate that greps the prose passes on the wrong rule.
       *
       * What a caller can actually SEND is pinned by
       * `the-traverse-option-schema-is-one-schema.test.js`, which exercises the compiled schema against
       * `TRAVERSE_OPTION_FIELDS`. Keep both: one is about being able to find the flag, the other about the
       * flag working.
       *
       * Scoped to `recall`'s OWN traverse description rather than the file, because all three flag names were
       * already present in a sentence naming them as something the standalone tool had and `recall` did not.
       */
      const tool = src('server/src/mcp/tools/search.ts');
      const at = tool.indexOf('Optional graph expansion depth');
      assert.ok(at > 0, "recall's traverse description moved — re-anchor this check");
      const desc = tool.slice(at, tool.indexOf('\n', at));
      assert.match(desc, new RegExp(`\\b${flag}\\b`),
        `${flag} is absent from the recall tool schema — a caller constructing arguments cannot discover it`);
      assert.doesNotMatch(desc, /has no equivalent flag/,
        'the description still says recall has no link flag, which is what this change made false');
      assert.match(readFileSync('docs/integration-guide/04a-recall-api.md', 'utf8'), new RegExp(`\\b${flag}\\b`),
        `${flag} is undocumented for the integrator`);
    });
  }

  it('all three default OFF, and a non-boolean is refused rather than coerced', async () => {
    /*
     * EXERCISED, not read. A source check here asserted that no line said `includeChrono ?? true` — and the
     * flags are parsed in a loop, so the spelling it looked for is one the code never uses in any state,
     * passing and failing alike. A gate that cannot distinguish the two answers is not measuring the rule.
     */
    const { parseTraverseOption } = await import('../../server/dist/brain/traverse-option.js');

    for (const raw of [2, { depth: 2 }]) {
      const parsed = parseTraverseOption(raw, 5);
      assert.equal(parsed.ok, true);
      for (const { flag } of FLAGS) {
        assert.notEqual(parsed.value[flag], true,
          `${flag} is on for a caller who did not ask, which changes every existing recall response`);
      }
    }

    // Asked for explicitly, it arrives — the other half, without which "defaults off" is satisfied by a
    // parameter that does nothing at all.
    const on = parseTraverseOption({ depth: 1, includeMemories: true }, 5);
    assert.equal(on.ok, true);
    assert.equal(on.value.includeMemories, true, 'the flag was accepted and then dropped');

    // Refused rather than coerced, like every other key here: a truthy string would return a bigger graph
    // with a 200 and nothing to say it was not what was asked for.
    assert.equal(parseTraverseOption({ depth: 1, includeChrono: 'yes' }, 5).ok, false);
  });
});

describe('the warning both doors carried is gone', () => {
  it('neither door still says a non-entity seed reaches nothing', () => {
    /*
     * The sentences were correct when written and are now false. A stale warning is worse than none: it tells
     * a caller not to try the thing that works, and nobody reports a capability they were told they did not
     * have.
     */
    /*
     * **DERIVED, and over BOTH the guides and the server** (`Q-6`, 2026-09-07). It named one doc page and
     * one tool, which were where the sentence had been found; the same sentence in the REST reference, the
     * operator's page or a second tool was outside everything this read while the title said "neither door".
     *
     * A stale warning is the one kind of documentation defect nobody reports, so the sweep has to be the
     * whole surface rather than the two places somebody remembered.
     */
    const listed = trackedSources(['server/src', 'client/src'])
      .filter(f => f.endsWith('.ts') || f.endsWith('.md'));
    assert.ok(listed.length > 100, `only ${listed.length} files found; the listing is broken`);

    const stale = listed.filter(f => /only entities are returned by traversal/i.test(readFileSync(f, 'utf8')));
    assert.deepEqual(stale, [],
      `${stale.join(', ')} still carries the warning, which is false: a traversal reaches memories, chrono `
      + 'entries and files. A stale warning tells a caller not to try the thing that works, and nobody '
      + 'reports a capability they were told they did not have.');
  });
});
