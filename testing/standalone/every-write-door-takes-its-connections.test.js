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
 * ## The SCAN is the whole of `server/src`, and that is the correction (`Q-44`)
 *
 * The creator regex was right and the two DIRECTORIES it was pointed at were not. `server/src/brain/bulk.ts`
 * calls all three creators and lives in neither, so the batch door — the highest-volume write path in the
 * product — was outside the set while the gate's title claimed every door. It passed throughout, because a
 * gate that never sees a subject cannot fail about it.
 *
 * That is this repository's own named shape: a gate whose title is a claim about a whole set and whose body
 * reads part of it. The fix is not to add the file — a seventh door written next year in a third directory
 * would be invisible the same way — but to derive the set from where the creators are ACTUALLY called.
 *
 * Run: node --test testing/standalone/every-write-door-takes-its-connections.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT, SERVER_CODE_ROOTS } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const code = (f) => stripComments(readFileSync(join(REPO_ROOT, f), 'utf8'));

/**
 * What makes a file a CREATE door: it calls a writer that mints a record.
 *
 * Named as the three writers rather than as a list of doors — a door is whoever calls one, which is the
 * property, and a seventh door is caught by having called one rather than by being remembered.
 */
// A creator's PLANNER counts too since `Q-99` part 3: the batch door plans its records through them and the
// commit writes, so it calls no creator at all — and is still the highest-volume create door there is.
const CREATORS = /\b(?:await saveFact\(|await createChrono\(|await upsertEntity\(|(?<!function )plan(?:Fact|Chrono|Entity)\()/;

// A file that DEFINES a creator is the writer, not a door — it calls its own planner, and that is not a door
// asking for a write on somebody's behalf.
const DEFINES_CREATOR = /export async function (?:saveFact|createChrono|upsertEntity)\(/;
// A file that calls a creator's planner and is NOT a door: it takes no caller's connections at all. Each entry says why and when it is
// looked at again; the case below holds every entry to still calling a creator, with its reason and a review date not past.
const NOT_A_DOOR = new Map([
  ['server/src/rdf/import-plan.ts', {
    reason: 'the RDF import plans the records a document states: a record\'s links come from the file\'s dcterms:references, translated and '
      + 'checked by rdf/quads-to-ops.ts, and no caller argument named linkEntities or edges reaches it',
    reviewBy: '2027-05-20',
  }],
  ['server/src/rdf/sparql-update-plan.ts', {
    reason: 'a SPARQL Update plans the records its statements state: a record\'s links come from its dcterms:references statements, translated '
      + 'and checked by rdf/quads-to-ops.ts as the import\'s are, and no caller argument named linkEntities or edges reaches it',
    reviewBy: '2027-05-26',
  }],
]);
const doors = trackedSources(SERVER_CODE_ROOTS, { floor: 100 })
  .filter(f => CREATORS.test(code(f)) && !DEFINES_CREATOR.test(code(f)) && !NOT_A_DOOR.has(f));

describe('the files that call a creator and are not doors', () => {
  it('each still calls a creator, says why it is not a door, and is not past its review date', () => {
    for (const [file, { reason, reviewBy }] of NOT_A_DOOR) {
      assert.ok(CREATORS.test(code(file)), `${file} no longer calls a creator: remove its entry`);
      assert.ok(reason.length > 40, `${file}: its entry says why it is not a door`);
      assert.ok(Date.parse(reviewBy) > Date.now(), `${file}: its entry is past its review date ${reviewBy}`);
    }
  });
});

describe('the create doors are found at all', () => {
  it('there are at least the seven known ones', () => {
    // A FLOOR: an empty scan passes every loop below and reports a green tick about nothing.
    assert.ok(doors.length >= 7, `found ${doors.length} create door(s): ${doors.join(', ')}`);
    /*
     * Three surfaces named, one per PLACE a door has turned up: the REST route, its MCP twin, and the
     * batch writer that is in neither directory. Naming the batch one is what stops the scan quietly
     * narrowing back to the two directories it used to read — `Q-44` is that narrowing, found from outside.
     */
    for (const known of [
      'server/src/api/brain/facts.ts', 'server/src/mcp/tools/fact.ts', 'server/src/brain/bulk.ts',
    ]) {
      assert.ok(doors.includes(known), `${known} is not being seen as a create door — the scan is wrong`);
    }
  });
});

describe('every create door offers the connections, through the one module', () => {
  for (const door of doors) {
    it(`${door} applies them`, () => {
      // `applyConnections` after a single write, or `connectionsOf` — the same mapping — planned into a batch.
      assert.match(code(door), /applyConnections\(|connectionsOf\(/,
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
      // `assertConnections` asks `connectionInputError` itself (the shape, then the rest), so a REST door that calls it
      // refuses a malformed connection field — and cannot drop that half by forgetting a second call.
      const refuses = /\b(?:assertConnections|connectionInputError)\(/.test(src);
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
     * `edges.ts` and the edge doors are excluded: writing an edge directly is what those are FOR. The batch
     * writer is one of them — its body carries an `edges` ARRAY alongside the record arrays, and that array's
     * `$ref` correlation is the reason it resolves and writes edges itself. Its ITEMS still go through the
     * module, which is what the two rules above check.
     */
    const EDGE_DOORS = [
      'server/src/api/brain/edges.ts', 'server/src/mcp/tools/edge.ts', 'server/src/brain/bulk.ts',
    ];
    const offenders = doors
      .filter(f => !EDGE_DOORS.includes(f))
      .filter(f => /reconcileLinks\(|upsertEdge\(/.test(code(f)));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} writes links or edges itself instead of calling applyConnections. Both `
      + 'semantics live in one place on purpose: links REPLACE per class, edges UPSERT, and a door that '
      + 'restates either will eventually restate it differently.');
  });
});
