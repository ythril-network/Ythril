/**
 * Plan a write against a fresh read, commit it, and re-plan it if its record moved in between.
 *
 * Its own module because the re-plan needs both halves — the planner to decide again and the commit to write —
 * and the commit must not import the planners, or every planner would import the commit back. A converge is
 * planned against the seq its record had when it was read and lands only if it still has it (`expectSeq`); a
 * write that lost that race is re-planned against what the record now says, with every rule run again — the
 * refusals, the merge, the link check — and allocated a fresh seq.
 *
 * ## Why there is one loop, for a single write and for a batch item alike
 *
 * The single-record doors and the batch each had their own re-plan, and they had already drifted: a single
 * write that lost twice answered `WriteConflict`, and a batch item that lost twice reported the commit's raw
 * reason and was never re-checked. The guarantee in the write-semantics guide — the same reason on both, the
 * rest of a batch written — is one rule, so `planAndCommit` is the one place that decides when a lost race
 * becomes a conflict.
 */
import { ReadSet, type ReadWant } from './read-set.js';
import { commitPlans } from './commit.js';
import { WriteConflict, type CommitOutcome, type WritePlan } from './types.js';

/** A commit outcome, or the conflict a write is answered with once its attempts are spent. */
export type PlannedOutcome = CommitOutcome | { readonly ok: false; readonly reason: string; readonly conflict: WriteConflict };

/**
 * Plan against a fresh read and commit, re-planning on a lost race until `attempts` plans have been tried. The
 * last loss is answered as a `conflict`, never as a stale outcome — a caller cannot mistake it for one it may
 * still re-plan. A refusal the planner throws is the caller's to handle.
 */
export async function planAndCommit<R extends { plan: WritePlan }>(
  spaceId: string,
  want: ReadWant,
  planOne: (view: ReadSet) => Promise<R>,
  attempts: number,
): Promise<{ planned: R; outcome: PlannedOutcome }> {
  for (let attempt = 1; ; attempt++) {
    const view = new ReadSet(spaceId);
    await view.load(want);
    const planned = await planOne(view);
    const [outcome] = await commitPlans(spaceId, [planned.plan]);
    if (outcome!.ok || !outcome!.stale) return { planned, outcome: outcome! };
    if (attempt >= attempts) {
      const conflict = new WriteConflict(planned.plan.kind, planned.plan.id);
      return { planned, outcome: { ok: false, reason: conflict.message, conflict } };
    }
  }
}

/** One single-record write: plan, commit, re-plan once on a lost race. Returns the planner's answer and the seq. */
export async function planAndCommitOne<R extends { plan: WritePlan }>(
  spaceId: string,
  want: ReadWant,
  planOne: (view: ReadSet) => Promise<R>,
): Promise<R & { seq: number }> {
  const { planned, outcome } = await planAndCommit(spaceId, want, planOne, 2);
  if (outcome.ok) return { ...planned, seq: outcome.seq };
  if ('conflict' in outcome) throw outcome.conflict;
  throw new Error(outcome.reason);
}
