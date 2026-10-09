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
 * ## The refusal is its own function (`Q-170`)
 *
 * The refusal half of `planEdge` is `edgeRefusal` — the one place the triplet, the defaults, the resolved ends and
 * the classifier meet — so a door can ask it BEFORE the record an inline edge hangs off is written, and `planEdge`
 * asks it first. The rule is pinned where it now lives; and `planEdge` holds no second copy of it, because a refusal
 * written twice is the defect this file is about. Where it lives is DERIVED (`_write-plan-sources.mjs`), and a
 * missing function fails every case here rather than resolving to an empty body.
 *
 * Run: node --test testing/standalone/write-functions-validate-not-their-callers.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { writePlanFunction } from './_write-plan-sources.mjs';

// The edge write DECIDES in its planner since `Q-99` part 3 — `upsertEdge` and the bulk door both plan through
// `planEdge` and the commit writes — and the REFUSAL half of that decision is `edgeRefusal` (`Q-170`), which
// `planEdge` calls first and the inline-edge doors call before their record is written.
const refusal = () => writePlanFunction('edgeRefusal');
const planner = () => writePlanFunction('planEdge');

/** The one source file that declares `class EdgeSchemaViolation`, comment-stripped. */
function violationClassSource() {
  const homes = trackedSources('server/src', { floor: 100, untracked: true })
    .map(file => ({ file, src: stripComments(readFileSync(join(REPO_ROOT, file), 'utf8')) }))
    .filter(f => /\bclass EdgeSchemaViolation\b/.test(f.src));
  assert.equal(homes.length, 1, `EdgeSchemaViolation is declared in ${homes.length} files — re-point this gate`);
  return homes[0].src;
}

describe('the write function validates, not its callers', () => {
  it('edgeRefusal classifies the record the write will produce', () => {
    const { body } = refusal();
    assert.match(
      body, /classifyEdgeUpsertAgainst\(/,
      'the edge refusal does not validate, so every caller must remember to — and two did not. The rule belongs in '
      + 'the function that reaches the collection.',
    );
  });

  it('and REFUSES rather than merely reporting', () => {
    const { body } = refusal();
    assert.match(
      body, /blocked/,
      'the classification must be acted on: computing it and writing anyway is the defect with extra steps',
    );
    assert.match(
      body, /throw new EdgeSchemaViolation/,
      'a blocked write must throw, so a caller that ignores the result still cannot store the record',
    );
  });

  it('planEdge asks edgeRefusal, and holds no second copy of the rule', () => {
    /*
     * The inline-edge doors ask `edgeRefusal` before the record is written; the writer asks it again before it
     * decides. That is one rule asked twice, which is fine — a rule WRITTEN twice is not. The planner keeps no
     * classifier call, no defaults call and no end-resolution of its own, so the two askers cannot disagree.
     */
    const { body } = planner();
    assert.match(body, /\bedgeRefusal\(/,
      'planEdge does not call edgeRefusal, so the refusal it enforces is not the one the doors ask');
    for (const copy of [
      /classifyEdgeUpsertAgainst\(/, /applyPropertyDefaults\(/, /\bresolvedEnds\(/, /throw new EdgeSchemaViolation/,
    ]) {
      assert.doesNotMatch(body, copy,
        `planEdge still holds its own ${copy.source} — a second copy of the refusal beside edgeRefusal, the one that drifts`);
    }
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
    const edges = violationClassSource();
    const at = edges.indexOf('class EdgeSchemaViolation');
    const classBody = balancedFrom(edges, edges.indexOf('{', at), 'the EdgeSchemaViolation body');
    assert.match(
      classBody, /UpdateValidation/,
      'EdgeSchemaViolation must carry the UpdateValidation so a door can shape its response without a second '
      + `classification pass. Class body: ${classBody}`,
    );
  });

  it('validation happens BEFORE anything is decided or embedded', () => {
    // A planner writes nothing (`a-write-planner-touches-no-collection`); what it must not do is DECIDE before
    // validating — record the plan in the read set, after which a later batch item treats the edge as written —
    // or start the embedding for a record that is about to be refused. `planEdge` asks the refusal first.
    const { body } = planner();
    const askAt = body.search(/\bedgeRefusal\(/);
    assert.notEqual(askAt, -1, 'planEdge does not call edgeRefusal');
    for (const later of ['noteWritten(', 'vectorBeforeWrite(']) {
      const laterAt = body.indexOf(later);
      assert.notEqual(laterAt, -1, `no ${later} found in planEdge — re-point this gate`);
      assert.ok(askAt < laterAt,
        `planEdge asks edgeRefusal AFTER ${later} — validating after the decision refuses a record the plan already holds`);
    }
  });
});
