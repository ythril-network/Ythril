/**
 * All four validators enforce their declared type allowlist, or none of them does.
 *
 * ## Why the rule is ALL-OR-NONE rather than four separate checks
 *
 * `validateFact` was the one that did not. Entities, edges and chrono each refuse a type outside the set
 * their space declares; memories accepted any string — while `types-knowledge.ts` and two integration-guide
 * pages stated the opposite. Four implementations of one rule, and the odd one out was the ABSENCE of a
 * branch, which no comparison of two implementations can surface: there was nothing to disagree with.
 *
 * So the gate asks the question the four share. A fifth record kind gaining a type schema map is covered on
 * the commit that adds it, and a future removal has to remove all four together and say why.
 *
 * ## The bound, which is what made this shippable
 *
 * Each allowlist bites only when the space declares at least one schema for that kind. A space that declared
 * none never asked to restrict anything and must keep accepting any string — asserted below in both
 * directions, because a check that only ever proves refusal cannot tell a correct allowlist from one that
 * refuses everything.
 *
 * ## It was ruled, not overlooked
 *
 * `schema-validation.test.js` PINNED the memory asymmetry as deliberate, and the CHANGELOG carried a reason:
 * the memories tab's type control is free text *because* the server accepted any string, so a closed select
 * would have been stricter than the API. Owner ruled A on 2026-08-30 — the UI argument was a consequence of
 * the gap rather than a reason for it, and it inverts now the server constrains the type.
 *
 * Run: node --test testing/standalone/every-validator-applies-its-allowlist.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const V = await import('../../server/dist/spaces/schema-validation.js');

/**
 * The four kinds and how to build a minimal record of each.
 *
 * `type` for three of them and `label` for an edge — the asymmetry `TYPE_FIELD` exists to name, and getting it
 * wrong here would make the edge case pass by looking up a schema that is never there.
 */
const KINDS = [
  { kind: 'entity', fn: 'validateEntity', field: 'type', rec: t => ({ name: 'n', type: t }) },
  { kind: 'edge', fn: 'validateEdge', field: 'label', rec: t => ({ label: t }) },
  { kind: 'fact', fn: 'validateFact', field: 'type', rec: t => ({ type: t }) },
  { kind: 'chrono', fn: 'validateChrono', field: 'type', rec: t => ({ type: t }) },
];

const metaFor = (kind) => ({ validationMode: 'strict', typeSchemas: { [kind]: { declared: {} } } });

describe('every validator enforces its allowlist', () => {
  it('refuses a type the space does not declare', () => {
    const permissive = [];
    for (const k of KINDS) {
      const violations = V[k.fn](metaFor(k.kind), k.rec('not-declared'));
      if (!violations.some(v => v.field === k.field)) permissive.push(k.kind);
    }
    assert.deepEqual(
      permissive, [],
      'These validators accept a type their space never declared. One of the four being permissive is how '
      + '`typeSchemas.memory` came to be documented as an allowlist in three places while enforcing nothing.',
    );
  });

  it('accepts a type the space DOES declare', () => {
    // The other direction. Without it, an allowlist that refuses everything passes the assertion above.
    for (const k of KINDS) {
      const violations = V[k.fn](metaFor(k.kind), k.rec('declared'));
      assert.deepEqual(
        violations.filter(v => v.field === k.field), [],
        `${k.kind} refuses a type its own space declares`,
      );
    }
  });

  it('constrains nothing when the space declares no types of that kind', () => {
    // The bound. A space that declared no schemas never asked to restrict anything, and this is the half that
    // decides whether the change can newly refuse a write somebody is making today.
    for (const k of KINDS) {
      for (const meta of [{ validationMode: 'strict', typeSchemas: {} }, { validationMode: 'strict' }]) {
        assert.deepEqual(
          V[k.fn](meta, k.rec('anything-at-all')).filter(v => v.field === k.field), [],
          `${k.kind} refuses a type in a space that declares none — the allowlist must be opt-in`,
        );
      }
    }
  });

  it('an edge is keyed on LABEL, so a `type` never satisfies its allowlist', () => {
    // The trap `suppress-embeddings.ts` names one module over: edges key their schema on `label`. A validator
    // reading `type` for an edge finds a schema that is never there and looks like it worked.
    const violations = V.validateEdge(metaFor('edge'), { label: 'declared', type: 'not-declared' });
    assert.deepEqual(violations.filter(v => v.field === 'label'), [], 'the LABEL is declared, so this is fine');
  });

  it('each allowlist names what it would have accepted', () => {
    // A refusal that does not list the alternatives sends the caller to read the schema and guess — and for
    // memories the caller may not know a schema exists at all, since this constraint is new.
    for (const k of KINDS) {
      const v = V[k.fn](metaFor(k.kind), k.rec('not-declared')).find(x => x.field === k.field);
      assert.match(v.reason, /allowlist: declared/, `${k.kind}'s refusal must name the allowed values`);
    }
  });
});

describe('the memory allowlist is applied in one place', () => {
  it('the branch lives in validateFact, not at a door', () => {
    /*
     * `getAllowedChronoTypes` exists because chrono's allowlist is ALSO enforced at two doors, and that is a
     * shape worth not copying: a rule at the door is a rule every future door must remember. Memory's belongs
     * to the validator, which every write path already reaches.
     */
    const src = stripComments(readFileSync('server/src/spaces/schema-validation.ts', 'utf8'));
    assert.match(bodyOf(src, 'validateFact'), /memoryTypes allowlist/, 'the branch must be in the validator');
    for (const door of ['server/src/api/brain/facts.ts', 'server/src/mcp/tools/fact.ts']) {
      assert.doesNotMatch(
        stripComments(readFileSync(door, 'utf8')), /getAllowedFactTypes/,
        `${door} enforces the memory allowlist itself — that is a second copy, and a third door would need a third`,
      );
    }
  });
});
