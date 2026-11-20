/**
 * Plan a whole set of writes without writing any of them, and answer every refusal with its reason (bundle-270, slice S4; plan section 3 (b)).
 *
 * ## Why it exists
 *
 * An import into a strict space is all or nothing: every record is planned once, nothing is written, and only when no record is refused is
 * anything committed. The commit then never refuses (amendment A1), so everything the store would refuse must be refused HERE, by the same
 * code that will decide the commit:
 *
 *  - the record's own checks (`plannedInputError`, `brain/record-checks.ts`: shape, link caps, size), which the bulk import asks too: without
 *    them an oversized record passes the dry plan and fails in the store after other records landed (A5);
 *  - what a door asks of a create (`plannedCreateError`: the required fields, the recurrence parse; and, in the chrono planner, the type the
 *    space allows): a record built from a document that no door would create is refused here, not stored (review F2);
 *  - the item's planner, with the read set the commit will plan against (seeded with what the import brings, `ReadSet.seed`) and the trusted
 *    arguments it will hand it (`trust.ts`): the schema, the functional labels, strict linkage and the links;
 *  - the version ceiling: a converge onto a record whose version is already the highest sync accepts is refused at the commit
 *    (`record_version_at_ceiling`, `util/version-stamp.ts`) whatever the planner decided, so it is refused here from the version the read set
 *    holds (the amendments' last section).
 *
 * An item carries its planner call (`plan`) and what that call asks the read set (`want`), as a batch item does (`bulk.ts`, `PreparedRecord`):
 * the caller that builds the input is the one that holds the trusted arguments, and the same closure is what its commit pass calls again.
 *
 * ## What it does not do
 *
 * Write. No plan is committed, no embed job queued, no link row reconciled; the read set records each plan as written so a later item sees it,
 * exactly as a batch does. A refusal is an answer; any other failure (a question the read set was never loaded for, trusted arguments of
 * another space) is the caller's defect and is thrown, never answered as a reason no record earned.
 *
 * Items are planned in the commit's order of kinds (`COMMIT_ORDER`: facts, entities, chrono, edges), so an edge sees the records the same set
 * plans, and in their own order within a kind; refusals are answered in item order.
 */
import { plannedInputError, plannedCreateError, type PlannedInput } from '../record-checks.js';
import { SchemaViolationError } from '../write-validation.js';
import { RecordVersionAtCeiling, RECORD_VERSION_AT_CEILING } from '../write-precondition.js';
import { MAX_INGEST_SEQ } from '../../util/seq.js';
import { ReferenceRefusal } from '../entity-refs.js';
import { RequestRefusal, ForkRowReadOnly } from '../../util/errors.js';
import { mergeWants, type ReadSet, type ReadWant } from './read-set.js';
import { COMMIT_ORDER, type PlanKind, type WritePlan } from './types.js';

/**
 * One write of the set: its kind and planner input (what the record checks read), what its planner asks the read set, and the planner call
 * itself, with the trusted arguments the caller holds (`planEntity(spaceId, input, view, trust)` and its siblings).
 */
export type DryItem = PlannedInput & {
  /**
   * The id the read set was seeded with for this record (`ReadSet.seed`), when the import brought it: if the item is refused it will not be
   * written, so its seed is taken back before the next item is planned and named in {@link DryPlanResult.unseeded}.
   */
  readonly seededId?: string | undefined;
  readonly want: ReadWant;
  readonly plan: (view: ReadSet) => Promise<{ readonly plan: WritePlan }>;
};

/** Why one item would not be written. `code`: a refusal's wire code, when it has one; `violation`: a schema refusal's body. */
export interface DryRefusal {
  readonly index: number;
  readonly kind: PlanKind;
  readonly reason: string;
  readonly code?: string;
  readonly violation?: Record<string, unknown>;
}

/** What a dry plan answers: per item, its plan (`null` when refused), and every refusal in item order. */
export interface DryPlanResult {
  readonly plans: ReadonlyArray<WritePlan | null>;
  readonly refusals: readonly DryRefusal[];
  /**
   * The seeds taken back because their record was refused (in the order it happened). Records are planned in the commit's order (facts first),
   * so a fact or a chrono planned BEFORE the refusal was judged with the record present: a caller that goes on without the refused records
   * plans again on a fresh read set seeded without these, until a plan names none.
   */
  readonly unseeded: ReadonlyArray<{ readonly kind: 'entity' | 'fact' | 'chrono'; readonly id: string }>;
}

/** Whether the commit would refuse this plan for its record's version: a converge onto a version that takes no successor sync accepts. */
const atVersionCeiling = (plan: WritePlan): boolean =>
  plan.op === 'converge' && plan.expectSeq !== undefined && plan.expectSeq !== null && plan.expectSeq + 1 > MAX_INGEST_SEQ;

/**
 * Plan every item of `items` against `view` without writing, and answer every refusal. `view` is loaded here with what the items' planners
 * ask (one merged read); a caller seeds it first with the records the set brings that are not stored.
 */
export async function dryPlan(items: readonly DryItem[], view: ReadSet): Promise<DryPlanResult> {
  const plans: Array<WritePlan | null> = items.map(() => null);
  const refusals: DryRefusal[] = [];
  const unseeded: Array<{ kind: 'entity' | 'fact' | 'chrono'; id: string }> = [];
  // A record refused is a record not written: the items planned after it must not find it present (review U5).
  const takeBack = (index: number): void => {
    const item = items[index]!;
    if (item.seededId !== undefined && item.kind !== 'edge' && view.unseed(item.kind, item.seededId)) unseeded.push({ kind: item.kind, id: item.seededId });
  };
  const refuse = (index: number, err: unknown): void => {
    const kind = items[index]!.kind;
    takeBack(index);
    if (err instanceof SchemaViolationError) {
      // The one refusal body every door answers (`toStructured`), beside the sentence.
      refusals.push({ index, kind, reason: err.message, violation: err.toStructured() });
      return;
    }
    if (!(err instanceof ReferenceRefusal || err instanceof RequestRefusal || err instanceof ForkRowReadOnly || err instanceof RecordVersionAtCeiling)) throw err;
    const code = err instanceof RecordVersionAtCeiling ? RECORD_VERSION_AT_CEILING : undefined;
    refusals.push({ index, kind, reason: err.message, ...(code ? { code } : {}) });
  };

  const checked: number[] = [];
  items.forEach((item, index) => {
    // What a door asks of a create too (`createError`): a record built from a document is no exception, and it is refused before anything loads.
    const why = plannedInputError(item) ?? plannedCreateError(item);
    if (why) refusals.push({ index, kind: item.kind, reason: why });
    else checked.push(index);
  });
  for (const r of refusals) takeBack(r.index);
  await view.load(mergeWants(checked.map(i => items[i]!.want)));

  for (const kind of COMMIT_ORDER) {
    for (const index of checked) {
      const item = items[index]!;
      if (item.kind !== kind) continue;
      try {
        const { plan } = await item.plan(view);
        if (atVersionCeiling(plan)) throw new RecordVersionAtCeiling(plan.id);
        plans[index] = plan;
      } catch (err) {
        refuse(index, err);
      }
    }
  }
  refusals.sort((a, b) => a.index - b.index);
  return { plans, refusals, unseeded };
}
