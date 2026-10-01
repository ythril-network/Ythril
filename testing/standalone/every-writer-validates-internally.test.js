/**
 * The schema is enforced inside the WRITER, so no caller can reach a collection around it.
 *
 * ## The owner's ruling, and why it needed a gate rather than a fix
 *
 * 2026-08-29: *"all upsert/update/insert things must validate btw — i thought that was already fact. check
 * others while at it."*
 *
 * One of the four was done — `upsertEdge`, in #1046, because a specific caller was found writing around it.
 * The other three were written up in `todo/_WRITE-PATH-VALIDATION-TODOS.md` as an untitled prose section with
 * no id and no checkbox, which meant `todo:check` could not see it, the ordered queue never mentioned it, and
 * it never entered the work order at all. It surfaced again only when the fleet integrator reported a
 * consequence from outside on 2026-08-30 — the pattern `CLAUDE.md` names as the most expensive lesson in this
 * codebase.
 *
 * So the rule gets a gate this time. A ruling that holds for all four record types is not four chances to
 * remember; it is one property, asserted once, for every writer that exists.
 *
 * ## What "validates internally" means, precisely
 *
 * The check runs inside the function that touches the collection — not in the route, not in the MCP tool, not
 * in `bulk.ts`. `upsertEdge`'s docblock states the reason from experience: the rule used to live in the two
 * routes, *"one rule, written twice, and both copies reachable only if you remembered them"*. Two callers did
 * not remember. `api/contradictions.ts` wrote a `supersedes` edge straight through the writer, so a space
 * whose allowlist forbade that label got one anyway; and `bulk.ts` carried a third copy that enforced a
 * DIFFERENT rule — blocking on any violation with no `preExisting`/`introduced` split, so the same upsert was
 * refused through `/bulk` and accepted through `/entities`.
 *
 * ## The other half: the doors must STOP re-deriving it
 *
 * Adding the check inside without removing the outside copies would make three copies out of two. It would
 * also cost a second lookup per write — `upsertEdge` takes an `onValidation` callback for exactly that reason,
 * *"so a door never has to run `classifyEdgeUpsert` a second time for presentation"*. Both directions are
 * asserted below.
 *
 * ## Sync is deliberately not in scope, and that is not an omission
 *
 * `api/sync/docs.ts` writes the collections directly with `replaceOne`/`updateOne` — it never calls these
 * writers. It validates on its own path and RECORDS violations rather than refusing them, through
 * `withSchemaViolations`, because refusing a peer's document would wedge replication rather than fix it. So
 * putting the check inside the writers cannot affect sync, and a gate that demanded one rule for both would be
 * demanding the wrong thing.
 *
 * Run: node --test testing/standalone/every-writer-validates-internally.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

/**
 * The eight functions that write a brain record, by the collection they own.
 *
 * Listed by NAME because they are a closed set that the type system already fixes — there are four record
 * kinds and each has a create/upsert and an update. A fifth kind would need a row here, and would also need a
 * classifier, a schema key and a collection, so this is not the list that goes stale silently.
 */
const WRITERS = [
  // The create/converge writers DECIDE in their planners since `Q-99` part 3 (the single door and the bulk
  // door both plan through them; the commit writes), so the planner is the function the rule must live in.
  { file: 'server/src/brain/write-plan/plan-entity.ts', fn: 'planEntity', classifier: /classifyEntityUpsertAgainst\(/ },
  { file: 'server/src/brain/entities.ts', fn: 'updateEntityById', classifier: /classifyEntityUpsertAgainst\(|classifyUpdateViolations\(/ },
  { file: 'server/src/brain/write-plan/plan-fact.ts', fn: 'planFact', classifier: /classifyFactUpsertAgainst\(/ },
  { file: 'server/src/brain/fact.ts', fn: 'updateFact', classifier: /classifyFactUpsertAgainst\(|classifyUpdateViolations\(/ },
  { file: 'server/src/brain/write-plan/plan-chrono.ts', fn: 'planChrono', classifier: /classifyChronoUpsertAgainst\(/ },
  { file: 'server/src/brain/chrono.ts', fn: 'updateChrono', classifier: /classifyChronoUpsertAgainst\(|classifyUpdateViolations\(/ },
  // The planner resolves the ends from the read set (`resolvedEnds`), the update path from the store.
  { file: 'server/src/brain/write-plan/plan-edge.ts', fn: 'planEdge', classifier: /classifyEdgeUpsertAgainst\(/, resolvesEnds: 'resolvedEnds' },
  { file: 'server/src/brain/edges.ts', fn: 'updateEdgeById', classifier: /classifyEdgeUpsertAgainst\(|classifyUpdateViolations\(/, resolvesEnds: 'await resolveEdgeEndsForWrite' },
];

/** Every surface that CALLS a writer — a door. None of them may hold its own copy of the rule. */
const DOORS = [
  'server/src/api/brain/entities.ts',
  'server/src/api/brain/facts.ts',
  'server/src/api/brain/chrono.ts',
  'server/src/api/brain/edges.ts',
  'server/src/mcp/tools/entity.ts',
  'server/src/mcp/tools/fact.ts',
  'server/src/mcp/tools/chrono.ts',
  'server/src/mcp/tools/edge.ts',
  'server/src/brain/bulk.ts',
];

const src = (p) => stripComments(readFileSync(p, 'utf8'));

describe('the sweep itself works', () => {
  it('every writer named here still exists', () => {
    // A renamed writer would silently reduce the subject to nothing — the vacuity every coverage gate in this
    // repo has had at least once.
    for (const w of WRITERS) {
      assert.match(src(w.file), new RegExp(`export async function ${w.fn}\\b`), `${w.fn} is gone from ${w.file}`);
    }
  });
});

describe('the schema is enforced inside the writer', () => {
  for (const w of WRITERS) {
    it(`${w.fn} validates before it touches the collection`, () => {
      const body = bodyOf(src(w.file), w.fn);
      assert.match(body, w.classifier,
        `${w.fn} writes without validating, so any caller that reaches it directly writes around the schema — `
        + 'which is how a supersedes edge landed in a space whose allowlist forbade the label');
    });

    it(`${w.fn} refuses what the write BREAKS and not what it inherits`, () => {
      /*
       * The `preExisting`/`introduced` split, and it is load-bearing rather than a nicety. A record written
       * before a schema was tightened, imported, or synced from a peer is already invalid; refusing an edit to
       * it would not fix the stored problem, it would only stop anybody maintaining the record. Before 3.1
       * that is exactly what happened, and it froze every record that no longer fitted.
       *
       * So a writer must consult `blocked` — the classification's own verdict — rather than "are there any
       * violations", which is the rule `bulk.ts` had and the routes did not.
       */
      const body = bodyOf(src(w.file), w.fn);
      assert.match(body, /\.blocked\b/,
        `${w.fn} must branch on the classification's blocked verdict, not on the presence of violations`);
    });

    it(`${w.fn} hands the classification back, so a door need not re-derive it`, () => {
      // Without this a door runs the classifier a second time purely for presentation — two lookups per write,
      // and the second copy of the rule that this whole change exists to remove.
      const body = bodyOf(src(w.file), w.fn);
      assert.match(body, /onValidation/,
        `${w.fn} gives a caller no way to see the warnings a warn-mode space must report`);
    });
  }
});

describe('an edge writer LOOKS UP what the endpoint rules need', () => {
  /*
   * The half of the edge rules that no source read of the validator can prove.
   *
   * `endpoints` and `functional` are decided from the entity TYPE at each end and a count of the other edges
   * sharing a subject. Neither is in the payload, and `validateEdge` is pure — so it reports on those only
   * when the caller hands over what it found, and reports NOTHING when the caller hands over an empty object.
   * That default is deliberate: the bulk importer legitimately cannot resolve a forward reference, and two
   * gates call the validator with plain objects.
   *
   * Which makes the silent failure available: a writer that validates, branches on `blocked`, satisfies every
   * case above, and never resolves. Every endpoint rule in every space then passes, the dry run still reports
   * the violations it finds in storage, and nothing is red. This is the shape of `documented but inert` — the
   * product promises a refusal and the code declines to look.
   */
  for (const w of WRITERS.filter(x => x.resolvesEnds)) {
    const resolver = w.resolvesEnds.replace(/^await /, '');
    it(`${w.fn} resolves the endpoints before it validates`, () => {
      const body = bodyOf(src(w.file), w.fn);
      const at = body.indexOf(`${resolver}(`);
      assert.ok(at > 0,
        `${w.fn} validates without resolving its endpoints, so \`endpoints\` and \`functional\` are accepted `
        + 'declarations that refuse nothing — the schema promises a rule the write path never checks');
      const validatedAt = body.search(/classify(?:Edge)?Upsert\w*\(|classifyUpdateViolations\(/);
      assert.ok(at < validatedAt,
        `${w.fn} resolves its endpoints AFTER classifying, so the classification cannot have used them`);
    });

    it(`${w.fn} passes what it resolved into the classification`, () => {
      /*
       * Resolving and then not passing it is the same inert state with a database round-trip attached — and it
       * is the likelier accident of the two, because a refactor that reorders arguments leaves the call
       * compiling. The variable has to reach the classifier's argument list.
       */
      const body = bodyOf(src(w.file), w.fn);
      const assigned = new RegExp(`(?:const|let)\\s+(\\w+)\\s*=\\s*${w.resolvesEnds.replace(/ /g, '\\s+')}\\(`).exec(body);
      assert.ok(assigned, `${w.fn} does not keep what ${resolver} returned`);
      const at = body.indexOf('classifyEdgeUpsertAgainst(');
      const call = body.slice(at, body.indexOf(');', at));
      assert.ok(call.includes(assigned[1]),
        `${w.fn} resolves its endpoints into \`${assigned[1]}\` and then classifies without it`);
    });
  }

  /*
   * The bulk importer's REPORTING copy of `validateEdge` is gone (`Q-99` part 3): a batch plans every edge through
   * `planEdge`, so it reports from the same classification it is enforced against, and an endpoint refusal
   * names what is allowed because the refusal carries the classification. `bulk-keeps-no-reporting-copy-of-
   * validation.test.js` holds that no copy comes back.
   */
});

describe('and no door keeps its own copy of the rule', () => {
  it('the classifiers are called by writers only', () => {
    /*
     * The half that makes this a MOVE rather than an addition. Leaving the outside copies would make three
     * where there were two, and the outside one is the copy that drifts: `bulk.ts` already enforced a
     * different rule than the routes did, so the same upsert was refused through `/bulk` and accepted through
     * `/entities`.
     */
    const offenders = [];
    for (const d of DOORS) {
      const s = src(d);
      /*
       * `classifyUpdateViolations` counts too, and leaving it out was how this finished half-done the first
       * time. It is the same rule one level down — the update paths called it directly, each rebuilding the
       * merged record itself with `mergePropertiesOrKeep` plus a throwaway `applyDeleteFieldsPaths`, twenty
       * lines from the writer that does the real merge. That simulation is the copy that drifts: it cannot see
       * a `deleteFields` the writer applies, and one of them validated the wrong `type` on a re-type for
       * months while the entity route next door did it correctly.
       */
      for (const m of s.matchAll(/classify(?:Entity|Memory|Chrono|Edge)Upsert\w*\(|classifyUpdateViolations\(/g)) {
        offenders.push(`${d}: ${m[0]}`);
      }
    }
    assert.deepEqual(offenders, [],
      'these re-derive a rule the writer now enforces — a second copy, reachable only if remembered, and the '
      + 'one that drifts:\n  ' + offenders.join('\n  '));
  });

  it('a door still reports warnings, rather than losing them with the copy it dropped', () => {
    // Removing the outside call must not silently drop what a `warn` space shows in its 201. The writers hand
    // it back through `onValidation`; at least one door per record kind has to be taking it.
    const taking = DOORS.filter(d => /onValidation/.test(src(d)));
    assert.ok(taking.length >= 4,
      `only ${taking.length} doors consume onValidation — a warn-mode space would stop seeing its warnings`);
  });
});

describe('applying defaults must not manufacture properties nobody sent', () => {
  /*
   * The regression this change actually shipped, caught by CI rather than by preflight.
   *
   * `applyPropertyDefaults` is careful about this and says so: *"Returning the original when nothing was
   * filled keeps `undefined` meaning 'no properties at all', which several write paths distinguish from an
   * empty object."* The writers then handed it `properties ?? {}` — coercing the absence away before the
   * helper could preserve it — so a memory created with no properties came back with `properties: {}` where
   * every caller had always seen the field absent.
   *
   * A response field appearing where it never used to is a contract change, and this one would have reached
   * every integrator over both doors. Asserted here rather than only in the integration suite because that
   * suite needs Docker and does not run in preflight: the defect was pushed, not caught.
   */
  // The planners, where the defaults are applied since `Q-99` part 3. Every one of them applies defaults, so a
  // missing call is a failure rather than a skip — the early return this used to have made a moved call vacuous.
  const CALLS = [
    { file: 'server/src/brain/write-plan/plan-fact.ts', fn: 'planFact' },
    { file: 'server/src/brain/write-plan/plan-chrono.ts', fn: 'planChrono' },
    { file: 'server/src/brain/write-plan/plan-entity.ts', fn: 'planEntity' },
    { file: 'server/src/brain/write-plan/plan-edge.ts', fn: 'planEdge' },
  ];

  for (const c of CALLS) {
    it(`${c.fn} passes the caller's properties through untouched`, () => {
      const body = bodyOf(src(c.file), c.fn);
      const at = body.indexOf('applyPropertyDefaults(');
      assert.notEqual(at, -1, `${c.fn} applies no property defaults — re-point this gate to where they are applied`);
      const call = body.slice(at, body.indexOf(')', at) + 1);
      assert.doesNotMatch(call, /\?\?\s*\{\s*\}/,
        `${c.fn} coerces an absent \`properties\` to {} before applyPropertyDefaults can preserve it, so the `
        + 'stored record gains a field the caller never sent');
    });
  }
});
