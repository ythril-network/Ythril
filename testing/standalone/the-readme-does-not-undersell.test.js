/**
 * A number in the README is checked against the code, and a capability claim has a mechanism behind it.
 *
 * ## What this is for, and it is not tidiness
 *
 * The README is the only file most evaluators read. Asked to compare Ythril with two other AI-memory
 * projects, a research tool produced a table that credited a competitor with *"explicit conflict detection so
 * contradictory facts are flagged instead of silently overwritten"* and gave Ythril *"None; relies on
 * semantic recall, not logical inference"* — while `brain/contradiction-judge.ts` had been separating a
 * deterministic contradiction from a model's opinion for months. It also quoted **"31 MCP tools"**, because
 * the README said 31. There were 44.
 *
 * Neither is a product gap. Both are what happens when a claim is written once and never checked again: the
 * number drifts DOWNWARD as the product grows, and a capability that arrives after the README was written is
 * invisible to everyone who reads only the README.
 *
 * ## The rule
 *
 * Two kinds of assertion, failing for different reasons:
 *
 *  - **Counts are derived, never transcribed.** The tool count comes from `ALL_TOOLS`. A README that
 *    disagrees fails in either direction — over-claiming is the worse failure and this is the same check.
 *  - **A capability claim names a mechanism that exists.** Not "the README mentions contradictions" but
 *    "the README mentions contradictions AND the two bases it describes are declared in the judge". A claim
 *    whose mechanism was deleted is worse than one that was never made.
 *
 * This repository already holds a README claim to that standard: `no-runtime-model-egress.test.js` exists
 * because *"works fully offline"* was in the README and was not true of the embedding model. Same principle,
 * applied to the claims an evaluator reads rather than the ones a user reads.
 *
 * Run: node --test testing/standalone/the-readme-does-not-undersell.test.js
 * (requires a prior `npm run build` in server/ for the tool count)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { dispatchSource } from './_tool-dispatch.mjs';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const README = readFileSync('README.md', 'utf8');
const src = (p) => stripComments(readFileSync(p, 'utf8'));

let ALL_TOOLS;
before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

describe('the gate reads the README', () => {
  it('finds it, and it is the real one', () => {
    assert.ok(README.length > 4_000, `README.md is ${README.length} chars — this gate is reading the wrong file`);
    assert.match(README, /^# Ythril/m, 'the README must still be the project README');
  });
});

describe('every count in the README is derived from the code', () => {
  it('the MCP tool count matches ALL_TOOLS', () => {
    /*
     * The one that was wrong, and the direction is the point: 31 against 44, because the number was written
     * when it was true and thirteen tools arrived afterwards. A research tool quoted the 31 verbatim.
     */
    const claimed = README.match(/\((\d+)\s+of them\)/)?.[1];
    assert.ok(claimed, 'the README no longer states a tool count as "(N of them)" — teach this gate the new '
      + 'spelling rather than deleting the check');
    assert.equal(Number(claimed), ALL_TOOLS.length,
      `README says ${claimed} MCP tools; ALL_TOOLS has ${ALL_TOOLS.length}. This is not a claim to keep up to `
      + 'date by hand: it drifts downward every time a tool is added, and downward is the direction nobody '
      + 'reports.');
  });

  it('the topology table still has the five the prose describes', () => {
    const rows = [...README.matchAll(/^\|\s+\*\*(Closed|Democratic|Club|Braintree|Pub \/ Sub)\*\*/gm)].length;
    assert.equal(rows, 5,
      `the topology table has ${rows} rows — if one was added or removed, the prose that counts them and this `
      + 'gate both need it');
  });
});

/**
 * Each pair: a phrase the README uses to make an evaluative claim, and the mechanism that must exist for the
 * claim to be true. Both directions matter — the phrase without the mechanism is a lie, and the mechanism
 * without the phrase is the undersell this file was written for.
 */
const CLAIMS = [
  {
    what: 'contradictions are flagged rather than silently resolved',
    phrase: /contradict/i,
    mechanism: () => {
      // The two bases are a declared TYPE in the judge; the route only renders them.
      const judge = src('server/src/brain/contradiction-judge.ts');
      assert.match(judge, /ContradictionBasis/, 'the basis must be a declared type, not an incidental string');
      assert.match(judge, /structured-field/, 'the deterministic basis must exist');
      assert.match(judge, /'nli'/, 'the model-opinion basis must exist beside it');
      assert.match(src('server/src/api/contradictions.ts'), /resolve/i, 'and a contradiction must be resolvable');
    },
  },
  {
    what: 'near-duplicates are found and reviewed',
    phrase: /duplicate/i,
    mechanism: () => {
      assert.match(src('server/src/api/duplicates.ts'), /dismiss/i, 'the review path must exist');
    },
  },
  {
    what: 'the audit log records WHAT changed, not only that something did',
    // Alternatives rather than a capped gap between two words: the cap would be a guess at how the sentence
    // is worded, and a guess can only make the check see less. Any of these three says the thing.
    phrase: /before\/after|what changed|field-level/i,
    mechanism: () => {
      assert.match(src('server/src/audit/audit-changes.ts'), /space\.update/,
        'the per-operation allowlist must exist — it is what lets a diff be recorded without risking a secret');
    },
  },
  {
    what: 'MCP and REST take the same parameters, gated rather than promised',
    phrase: /parity|same parameters|both doors/i,
    mechanism: () => {
      /*
       * THIS USED TO ASSERT THE EXEMPTION LIST WAS EMPTY, and that is how the README came to oversell.
       * The list was empty and WRONG — two capabilities were REST-only the whole time — so a gate reading
       * its length was measuring whether anybody had written a row, not whether the surfaces matched.
       *
       * The claim is now the one the build can actually keep: nothing is missing SILENTLY. What holds it
       * up is the derivation, which enumerates every mounted route and refuses to let one go unclassified.
       */
      assert.match(readFileSync('testing/standalone/mcp-rest-parity.test.js', 'utf8'), /REST_ONLY_CAPABILITIES/,
        'the parity gate must still read the exemption list');
      assert.match(
        readFileSync('testing/standalone/every-rest-route-is-answered-or-declared.test.js', 'utf8'),
        /mountedRoutes\(\)/,
        'the derivation is what makes the claim true — without it an empty list means nobody looked');
      const parity = src('server/src/mcp/parity.ts');
      assert.match(parity, /REST_ONLY_CAPABILITIES/, 'REST_ONLY_CAPABILITIES is gone from mcp/parity.ts');
      assert.ok(!/why:\s*'',/.test(parity),
        `a declared gap with no reason defeats the claim, because "declared" is what makes the gap honest `
        + 'qualification');
    },
  },
  {
    what: 'four lookup primitives, each stating its blind spots',
    phrase: /find_similar/,
    mechanism: () => {
      // All four registered, and the "what this is bad at" half is the part that would quietly rot: a tool
      // description is what a caller reads WHILE constructing arguments, so a missing warning is invisible.
      const names = ALL_TOOLS.map(t => t.name);
      for (const n of ['recall', 'filter', 'similar', 'graph_traverse']) {
        assert.ok(names.includes(n), `${n} must be a registered tool`);
      }
      const recall = ALL_TOOLS.find(t => t.name === 'recall').description;
      assert.match(recall, /DOES NOT SEND YOU/,
        'recall must still carry its blind-spots section — that is the claim the README makes, and '
        + '`read-tools-state-their-blind-spots.test.js` is what holds every read tool to it');
    },
  },
  {
    what: 'strict mode blocks what a write broke, not what was already broken',
    phrase: /introduced or pre-existing|already broken/i,
    mechanism: () => {
      const s = src('server/src/brain/write-validation.ts');
      assert.match(s, /introduced/, 'the distinction must be computed, not described');
      assert.match(s, /afterViolations\.filter/, 'introduced violations must be a DIFFERENCE, not a re-check');
    },
  },
  {
    what: 'a refused write comes back machine-readable, not as a sentence',
    phrase: /structuredContent|machine-readable/i,
    mechanism: () => {
      assert.match(dispatchSource(), /structuredContent/,
        'the MCP dispatcher must still attach structured content to a refusal');
    },
  },
  {
    what: 'no feature gates and no activation key',
    phrase: /no feature gate|no activation|no licence check|no license check/i,
    mechanism: () => {
      /*
       * A claim about an ABSENCE, checked as one. Nothing in the shipped source may read a licence key,
       * check an entitlement, or branch on an edition — that is what makes "the software is identical
       * whoever runs it" a fact rather than an intention.
       */
      // `git grep` exits 1 when nothing matches, which is the PASSING case, so the throw is the answer.
      // Reading it the other way round would make these assertions unfailable.
      const absent = (pattern) => {
        try {
          return execFileSync('git', ['grep', '-ln', '-iE', pattern, '--', 'server/src', 'client/src'],
            { encoding: 'utf8' }).trim().split('\n').filter(Boolean);
        } catch { return []; }
      };

      const gated = absent('licenseKey|licenceKey|activationKey|entitlement');
      assert.deepEqual(gated, [], `these read a licence key or entitlement: ${gated.join(', ')}`);

      /*
       * "No telemetry, no call home" is the other half of the sentence, so it is checked too — as an
       * absence of any hardcoded Ythril-owned host in the shipped source. A phone-home has to have somewhere
       * to phone, and every legitimate outbound destination in this product is an operator-configured model
       * endpoint enumerated by `EGRESS_SLOTS` (see `egress-matrix.test.js`, which holds the docs to that
       * list). A vendor host appearing here is the shape a telemetry call would take.
       */
      const homes = absent('ythril\\.(net|com|io|ai)');
      assert.deepEqual(homes, [],
        `these name a Ythril-owned host in the shipped source: ${homes.join(', ')}. Every outbound destination `
        + 'must be operator-configured, or the README must stop saying there is no call home.');
    },
  },
];

describe('every evaluative claim in the README has a mechanism behind it', () => {
  for (const { what, phrase, mechanism } of CLAIMS) {
    it(`the README says: ${what}`, () => {
      assert.match(README, phrase,
        'The README does not mention this, and the code does it. That is the undersell this file exists for: '
        + 'an evaluator reads the README and nothing else, so a capability missing from it does not exist as '
        + 'far as anyone comparing projects is concerned.');
    });

    it(`and the mechanism is there: ${what}`, mechanism);
  }
});

describe('the check can fail', () => {
  it('the count comparison is real', () => {
    // Mutation-check without touching the README: if ALL_TOOLS ever held the stale number, the assertion
    // above could no longer tell right from wrong.
    assert.notEqual(31, ALL_TOOLS.length,
      'ALL_TOOLS now holds exactly the stale number this gate was written about — pick a different mutation');
  });

  it('and the README does not oversell either', () => {
    // The other direction, and the reason this file is named for underselling rather than for accuracy: the
    // fix must not become a claim to capabilities Ythril does not have. These three are a competitor's.
    assert.doesNotMatch(README, /forward chaining|Rete network|SPARQL|PROV-O/i,
      'the README claims reasoning machinery Ythril does not have');
  });
});
