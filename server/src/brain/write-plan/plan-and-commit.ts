/**
 * Plan a write against a fresh read, commit it, and re-plan it ONCE if its record moved in between.
 *
 * Its own module because the re-plan needs both halves — the planner to decide again and the commit to write —
 * and the commit must not import the planners, or every planner would import the commit back. A converge is
 * planned against the seq its record had when it was read and lands only if it still has it (`expectSeq`); a
 * write that lost that race is re-planned against what the record now says, with every rule run again — the
 * refusals, the merge, the link check — and allocated a fresh seq. Losing twice is a `WriteConflict` (409).
 */
import { ReadSet, type ReadWant } from './read-set.js';
import { commitPlans } from './commit.js';
import { WriteConflict, type WritePlan } from './types.js';

/** One single-record write: plan, commit, re-plan once on a lost race. Returns the planner's answer and the seq. */
export async function planAndCommitOne<R extends { plan: WritePlan }>(
  spaceId: string,
  want: ReadWant,
  planOne: (view: ReadSet) => Promise<R>,
): Promise<R & { seq: number }> {
  for (let attempt = 0; ; attempt++) {
    const view = new ReadSet(spaceId);
    await view.load(want);
    const planned = await planOne(view);
    const [outcome] = await commitPlans(spaceId, [planned.plan]);
    if (outcome!.ok) return { ...planned, seq: outcome!.seq };
    if (!outcome!.stale) throw new Error(outcome!.reason);
    if (attempt >= 1) throw new WriteConflict(planned.plan.kind, planned.plan.id);
  }
}
