/**
 * `direction` narrows stored edges and never links — and every surface that offers it says so.
 *
 * ## The behaviour, and why it is right
 *
 * **A link's direction is fixed by the KINDS at its ends, not by how it is stored.** A memory names
 * entities; an entity names nothing. So from any starting point there is only one way a link can run and
 * there is nothing for a direction to select between. Neither link scan even ACCEPTS one —
 * `linkedRecordsAtFrontier` and `entitiesLinkedFromRecords` take an inclusion and edge labels — so the
 * standalone `traverse` tool and recall's expansion agree, and always have.
 *
 * Honouring direction on links would be worse than useless: `inbound` would then hide a memory's own
 * links, which is not what anyone asks for by narrowing.
 *
 * ## THIS FILE USED TO SAY M-2 WOULD BREAK IT. That was wrong, corrected 2026-09-05
 *
 * The claim was that a link *"is an `entityIds` ARRAY today … carrying ONE orientation"* and that the
 * link-records migration would give it two ends, so a scan gaining a `direction` parameter would be
 * "M-2 arriving, not a regression — and the signal to rewrite these sentences rather than make the gate
 * agree."
 *
 * **That instruction would have changed a documented parameter on a false basis**, which is worse than a
 * stale sentence: it pre-authorised the change and told the next reader not to trust the gate.
 *
 *  - Links are ALREADY records on a converted space — `usesLinkRecords` decides per space, and
 *    `links-conversion.ts` sets it. M-2's machinery shipped; this gate stayed green throughout.
 *  - **The ARRAY expresses both readings too, and `link-frontier.ts` implements both.** `linksToAny`
 *    finds records whose array names an id (inbound); reading a record's own `cls.field` gives what it
 *    names (outbound). The record shape has the same pair in `linksPointingAt` / `linksStartingFrom`. So
 *    the representation was never what made `direction` meaningless, and the migration decides nothing
 *    here.
 *
 * The rule was right; the REASON was a mechanism, and a mechanism has to be revisited every time it gains
 * a case. The integrator's graph-augmented-recall page already gave the durable version — the ends are of
 * different kinds — and the source did not. That is the `CLAUDE.md` lesson about schema descriptions,
 * arriving in a test docblock instead: write the guarantee, not the mechanism.
 *
 * So a link scan gaining a `direction` parameter is a REGRESSION again, and this gate should be believed
 * rather than argued with. Making it meaningful is a product decision, unrelated to how links are stored.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { guidePartOwning } from '../_shared/integration-guide-parts.mjs';

const read = (p) => readFileSync(p, 'utf8').replace(/\s+/g, ' ');

describe('the behaviour: neither link scan takes a direction', () => {
  it('the two link scans accept an inclusion and labels, and no direction', () => {
    // set-claim: the two link scans by name, as SIGNATURE anchors -- the case reads each one's parameter
    // list, which is a per-function assertion rather than a claim about a set.
    /*
     * Asserted on the SIGNATURES rather than on prose, because this is what makes the documentation true. If a
     * scan ever gains a direction parameter, every statement below becomes a lie and this fires first.
     */
    const src = read('server/src/brain/link-frontier.ts');
    for (const fn of ['linkedRecordsAtFrontier', 'entitiesLinkedFromRecords']) {
      const at = src.indexOf(`export async function ${fn}(`);
      assert.ok(at > 0, `${fn} is gone — re-anchor this gate`);
      const params = src.slice(at, src.indexOf('): Promise<', at));
      assert.doesNotMatch(params, /\bdirection\b/,
        `${fn} now takes a direction, so the documented rule that links ignore it is no longer true`);
    }
  });
});

describe('and every surface that offers `direction` says so', () => {
  /** The claim, in whatever words each surface uses. All four must carry it. */
  const SURFACES = [
    // The schema a caller reads while CONSTRUCTING arguments — shared by both doors, which is the point.
    ['server/src/brain/traverse-option.ts', /narrow[s]? links|STORED EDGES/i],
    // recall + find_similar, whose descriptions are the reference for an agent.
    ['server/src/mcp/tools/search.ts', /narrows STORED EDGES ONLY/],
    // The standalone traverse tool.
    ['server/src/mcp/tools/edge.ts', /narrows STORED EDGES ONLY/],
    // The integrator's two pages. The recall half is looked up by its HEADING rather than named: it lived
    // on `04a-recall-api.md` until that page hit the 900-line cap and graph-augmented recall moved to its
    // own part, and a gate that names the page it used to be on asserts about whatever is left there.
    [guidePartOwning('Graph-Augmented Recall'), /narrows stored edges only/i],
    ['docs/integration-guide/04b-graph-api.md', /narrows stored edges and never links/i],
    // The operator's own words — no jargon, and the one surface a UI user ever sees.
    ['docs/userguide/02-brain.md', /not to the facts, timeline entries and files that merely MENTION/],
  ];

  for (const [file, pattern] of SURFACES) {
    it(`${file} states it`, () => {
      assert.match(read(file), pattern,
        `${file} offers \`direction\` and does not say it narrows stored edges only — a caller who reads only `
        + 'this surface will design around a rule that does not hold');
    });
  }

  it('the consequence is spelled out, not just the rule', () => {
    /*
     * "Stored edges only" is the rule; "so an inbound walk on a matched memory still returns what it names" is
     * what a caller needs to predict the response. The rule alone reads as a technicality.
     */
    for (const f of ['server/src/mcp/tools/search.ts', guidePartOwning('Graph-Augmented Recall')]) {
      assert.match(read(f), /still return[s]? the entities that fact (NAMES|\*\*names\*\*)/i,
        `${f} states the rule without its consequence, which is the half a caller can act on`);
    }
  });
});
