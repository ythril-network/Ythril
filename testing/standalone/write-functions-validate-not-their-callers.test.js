/**
 * The write FUNCTION enforces the schema, not the routes that happen to call it.
 *
 * ## What this is guarding against, concretely
 *
 * `upsertEdge` did not validate. The check sat in `api/brain/edges.ts` and `mcp/tools/edge.ts`, each calling
 * `classifyEdgeUpsert` before the write — one rule written twice, enforced only for callers who remembered it.
 * Two did not: `api/contradictions.ts` writes a `supersedes` edge straight through `upsertEdge`, so a space
 * whose `typeSchemas.edge` allowlist did not name `supersedes` had that edge written into it anyway; and
 * `brain/bulk.ts` carried a third copy of the check.
 *
 * Owner's ruling, 2026-08-29: *"upsertEdge should validate of course — all upsert/update/insert things must
 * validate."*
 *
 * ## Why the assertion is "the function contains it", not "the callers do not"
 *
 * A caller may legitimately validate as well. `brain/bulk.ts` does, and should: its contract is per-item errors
 * carrying an index, which a thrown refusal reports with less structure. What must not happen again is the
 * function being reachable WITHOUT the rule — so the rule is pinned where it now lives, and callers are free.
 *
 * Run: node --test testing/standalone/write-functions-validate-not-their-callers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, balancedFrom } from './_structural-window.mjs';

// The edge write DECIDES in its planner since `Q-99` part 3 — `upsertEdge` and the bulk door both plan through
// `planEdge` and the commit writes — so the planner is "the function that reaches the collection" for this rule.
const EDGES = 'server/src/brain/write-plan/plan-edge.ts';
const FN = 'planEdge';
const edges = stripComments(readFileSync(EDGES, 'utf8'));

describe('the write function validates, not its callers', () => {
  it('upsertEdge classifies the record it will produce', () => {
    const body = bodyOf(edges, FN);
    assert.match(
      body, /classifyEdgeUpsertAgainst\(/,
      'upsertEdge does not validate, so every caller must remember to — and two did not. The rule belongs in '
      + 'the function that reaches the collection.',
    );
  });

  it('and REFUSES rather than merely reporting', () => {
    const body = bodyOf(edges, FN);
    assert.match(
      body, /blocked/,
      'the classification must be acted on: computing it and writing anyway is the defect with extra steps',
    );
    assert.match(
      body, /throw new EdgeSchemaViolation/,
      'a blocked write must throw, so a caller that ignores the result still cannot store the record',
    );
  });

  it('the refusal carries the whole classification, not a sentence', () => {
    // Both doors answer with {message, violations, introduced, preExisting}. If the error carried only a
    // string they would have to re-derive that — which means re-running the classifier, which is the
    // duplication this change removed.
    /*
     * Bounded to the class body. The first version matched `class EdgeSchemaViolation` followed by
     * `UpdateValidation` anywhere after it, and SURVIVED its own mutant — because `upsertEdge`'s own
     * `onValidation?: (check: UpdateValidation) => void` sits a few lines below and supplied the word.
     * An unbounded gap matches the rest of the file.
     */
    const at = edges.indexOf('class EdgeSchemaViolation');
    assert.notEqual(at, -1, 'EdgeSchemaViolation is gone — re-point this gate');
    const classBody = balancedFrom(edges, edges.indexOf('{', at), 'the EdgeSchemaViolation body');
    assert.match(
      classBody, /UpdateValidation/,
      'EdgeSchemaViolation must carry the UpdateValidation so a door can shape its response without a second '
      + `classification pass. Class body: ${classBody}`,
    );
  });

  it('validation happens BEFORE the collection is touched', () => {
    // A planner writes nothing (`a-write-planner-touches-no-collection`); what it must not do is DECIDE before
    // validating — record the plan in the read set, after which a later batch item treats the edge as written.
    const body = bodyOf(edges, FN);
    const checkAt = body.indexOf('classifyEdgeUpsertAgainst(');
    const writeAt = body.indexOf('noteWritten(');
    assert.notEqual(writeAt, -1, `no decision found in ${FN} — re-point this gate`);
    assert.ok(
      checkAt !== -1 && checkAt < writeAt,
      'validating after the write would refuse a record the store already holds',
    );
  });
});
