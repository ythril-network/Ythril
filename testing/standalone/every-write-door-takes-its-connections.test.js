/**
 * A door that creates a record accepts the relationships that record needs, and does it the one way.
 *
 * ## What this is for (`F-27`)
 *
 * A fleet operator is blocked on converting to link records because attaching a record to three things
 * becomes four calls. `linkEntities` and its siblings, plus `edges`, make it one — and a door that offers
 * them while another does not is worse than neither offering them, because the caller cannot tell which is
 * which without trying.
 *
 * ## Derived, because "every door" is the claim
 *
 * The set is whoever calls a record CREATOR — `saveFact`, `createChrono`, `upsertEntity`. That is what makes
 * something a create door, and it is not a list anybody maintains. Their MCP twins are found the same way.
 *
 * The operator's own objection to this feature was *"writing edge support into six endpoints"*. This gate is
 * the answer to it: there is one implementation, and what each door does is call it twice — once to refuse,
 * once to apply. A door that grew its own copy of either half fails here.
 *
 * Run: node --test testing/standalone/every-write-door-takes-its-connections.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const code = (f) => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));

/**
 * What makes a file a CREATE door: it calls a writer that mints a record.
 *
 * Named as the three writers rather than as a list of doors — a door is whoever calls one, which is the
 * property, and a seventh door is caught by having called one rather than by being remembered.
 */
const CREATORS = /\b(?:await saveFact\(|await createChrono\(|await upsertEntity\()/;

const doors = trackedSources(['server/src/api/brain', 'server/src/mcp/tools'], { floor: 10 })
  .filter(f => CREATORS.test(code(f)));

describe('the create doors are found at all', () => {
  it('there are at least the six known ones', () => {
    // A FLOOR: an empty scan passes every loop below and reports a green tick about nothing.
    assert.ok(doors.length >= 6, `found ${doors.length} create door(s): ${doors.join(', ')}`);
    for (const known of ['server/src/api/brain/facts.ts', 'server/src/mcp/tools/fact.ts']) {
      assert.ok(doors.includes(known), `${known} is not being seen as a create door — the scan is wrong`);
    }
  });
});

describe('every create door offers the connections, through the one module', () => {
  for (const door of doors) {
    it(`${door} applies them`, () => {
      assert.match(code(door), /applyConnections\(/,
        `${door} creates a record and never applies the relationships the caller asked for, so a `
        + 'caller writing `linkEntities` or `edges` there is silently ignored — which is worse than a '
        + 'refusal, because nothing says it happened');
    });

    it(`${door} declares or refuses them`, () => {
      /*
       * REST refuses (there is no published schema to check against); MCP declares (the dispatcher enforces
       * `additionalProperties: false` before the handler runs, so an undeclared field is refused outright).
       * Either is correct for its surface — what is not correct is neither.
       */
      const src = code(door);
      const refuses = /connectionInputError\(/.test(src);
      const declares = /connectionSchemas\(/.test(src);
      assert.ok(refuses || declares,
        `${door} applies connections but neither validates them (REST) nor declares them (MCP). On MCP an `
        + 'undeclared field is refused by the dispatcher before the handler runs — which is exactly how '
        + "traverse's link flags shipped answered on REST and refused on MCP.");
    });
  }
});

describe('and no door grew its own copy of either half', () => {
  it('nothing outside the module reconciles links or upserts an edge for a create', () => {
    /*
     * The failure this whole module exists to prevent, stated as a rule rather than trusted. A door that
     * called `reconcileLinks` itself would be the second implementation of the REPLACE semantics, and a
     * door that called `upsertEdge` in a loop would be the second implementation of the UPSERT ones — and
     * the two would drift apart exactly where a caller cannot see it.
     *
     * `edges.ts` and the edge doors are excluded: writing an edge directly is what those are FOR.
     */
    const EDGE_DOORS = ['server/src/api/brain/edges.ts', 'server/src/mcp/tools/edge.ts'];
    const offenders = doors
      .filter(f => !EDGE_DOORS.includes(f))
      .filter(f => /reconcileLinks\(|upsertEdge\(/.test(code(f)));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} writes links or edges itself instead of calling applyConnections. Both `
      + 'semantics live in one place on purpose: links REPLACE per class, edges UPSERT, and a door that '
      + 'restates either will eventually restate it differently.');
  });
});
