/**
 * A worker's claim on a job, and what happens when it loses one.
 *
 * ## Why a token
 *
 * Stall recovery flips a `processing` job back to `pending` when nothing has reported progress for
 * `stalledJobTimeoutMs`. Recovery is what makes a crashed pod's work resumable, so it cannot be removed —
 * but until now it also had no way to tell the *previous* holder that its claim was gone. When a live job
 * was recovered (because the phase it was in reported no progress), the outcome was two runs on the same
 * file: the old one still embedding, the new one starting over, each writing the same chunk `_id`s, both
 * competing for the same CPU that the first one was already too slow on.
 *
 * The token is compared on every heartbeat. Recovery clears it, so the next heartbeat from the old holder
 * matches nothing, and that is the signal to stop — one extra field, no extra round trip, and it uses the
 * write the heartbeat was already making.
 *
 * ## Why the loser stops rather than finishes
 *
 * The recovered job is `pending` with `attempts` already incremented: the queue has decided a new run owns
 * this file. If the old run finished anyway it would write chunks the new run then overwrites, and could
 * report `complete` on a job the queue has re-queued — a completed job with a live claimant.
 *
 * ## Why the heartbeat is not enough, and what the fence adds
 *
 * The heartbeat tells a run it has lost its claim on the NEXT beat — throttled to one write per 2 s, and
 * checked between chunks. A run's results land in one burst at the end, so a claim taken away in the window
 * between the last beat and that burst was never noticed: the results landed anyway. For stall recovery that
 * is a duplicate; for a MOVE it is worse, because the move takes the claim precisely so the file's derived
 * records can follow it, and a run that commits afterwards writes them under the path the file just left —
 * chunk records under a directory that no longer exists, with nothing ever deleting them. That is what a CI
 * run of `files.test.js` caught ("Source metadata must be gone after directory move", 2 records left).
 *
 * `writeUnderClaim` makes the burst itself conditional on the claim, decided by the database in the same
 * transaction as the writes: whoever takes the claim away (recovery, a move, a re-upload) either lands
 * first and the run writes nothing, or lands after and finds the run's records already there to act on.
 */
import type { ClientSession } from 'mongodb';
import { col, asFilter, getMongo } from '../../db/mongo.js';
import type { MediaJobDoc } from '../../config/types.js';
import { spaceCollection } from '../../db/space-collection.js';
import { isSpaceNotWritable } from '../../spaces/space-write-gate.js';
import { peerText } from '../../util/log.js';

/** A fresh claim token. Random rather than time-based: two pods claiming in the same millisecond must differ. */
export function newClaimToken(): string {
  // `randomUUID` is available on Node 18+; this module is imported by the worker, never by the client.
  return crypto.randomUUID();
}

/**
 * Thrown when a job's claim was taken away while it was running.
 *
 * Not a failure of the work: the file is fine and another claimant is already on it. The worker treats it
 * as an abandonment — no `failJob` (which would burn an attempt and write a `lastError` describing nothing
 * wrong), no `completeJob` (which would mark a re-queued job done).
 */
export class JobLeaseLostError extends Error {
  readonly spaceId: string;
  readonly jobId: string;

  constructor(spaceId: string, jobId: string) {
    super(`Lease lost for ${spaceId}/${jobId} — the job was re-queued while it was still running`);
    this.name = 'JobLeaseLostError';
    this.spaceId = spaceId;
    this.jobId = jobId;
  }
}

/**
 * True when a run should STOP without failing its job: its claim was taken (moved, deleted, re-uploaded, stall
 * recovery), or its space stopped taking writes because it is being deleted or renamed away
 * (`spaces/space-write-gate.ts`). In both, nothing the run produced belongs anywhere, and failing the job would spend
 * an attempt and record a `lastError` for work that did nothing wrong.
 */
export function isAbandonment(err: unknown): boolean {
  return isLeaseLost(err) || isSpaceNotWritable(err);
}

/** True when `err` is a lost lease, including across module instances (name check, not `instanceof`). */
export function isLeaseLost(err: unknown): boolean {
  return err instanceof JobLeaseLostError
    || (err instanceof Error && err.name === 'JobLeaseLostError');
}

/** The run a write speaks for: the job it claimed and the token the claim carried. */
export interface JobClaim {
  jobId: string;
  /** Absent on a claim made by a build that predates tokens; the fence then checks the status alone. */
  claimToken?: string | null;
}

/** The filter that matches a job only while `claim` still holds it — the heartbeat's rule, in one place. */
function heldBy(claim: JobClaim): Record<string, unknown> {
  return { _id: claim.jobId, status: 'processing', ...(claim.claimToken ? { claimToken: claim.claimToken } : {}) };
}

/**
 * Run `writes` only if `claim` still holds its job, atomically with the check — or throw `JobLeaseLostError` and write
 * nothing.
 *
 * The check is a WRITE to the job document inside the transaction, and that is the part a hand-written copy drops. A
 * matching read inside a transaction orders against nothing: a revocation landing between the read and the commit
 * conflicts with no document the transaction wrote, so both succeed and the results land under a claim that was
 * already gone. Writing the job makes the database serialise the two — a revocation that lands first leaves this
 * filter matching nothing; one that lands second waits for the commit, and then finds the results in place.
 *
 * A write refused by a conflict is retried by `withTransaction` from the top, so `writes` must be safe to run twice:
 * delete what it is about to insert rather than rely on the insert being the first.
 */
export async function writeUnderClaim<T>(
  spaceId: string,
  claim: JobClaim,
  writes: (session: ClientSession) => Promise<T>,
): Promise<T> {
  const session = getMongo().startSession();
  try {
    return await session.withTransaction(async () => {
      const fenced = await col<MediaJobDoc>(spaceCollection(spaceId, 'mediaJobs')).updateOne(
        asFilter<MediaJobDoc>(heldBy(claim)), { $inc: { fencedWrites: 1 } }, { session },
      );
      if (fenced.matchedCount === 0) throw new JobLeaseLostError(spaceId, claim.jobId);
      return await writes(session);
    });
  } finally {
    await session.endSession();
  }
}

/**
 * Whether `claim` still holds its job — for a decision that follows from something the run OBSERVED, not a write.
 *
 * A read is enough here, where it is not for `writeUnderClaim`, because of what triggers the question: a run asks it
 * after finding its file gone from disk. Whoever took the file away took the claim FIRST (a move holds the file's jobs
 * before it touches the disk), so by the time the absence is visible the revocation already is. A run that finds its
 * claim gone must leave the file's records alone — the path it would clean up is the one a move is carrying away.
 */
export async function holdsClaim(spaceId: string, claim: JobClaim): Promise<boolean> {
  const held = await col<MediaJobDoc>(spaceCollection(spaceId, 'mediaJobs')).countDocuments(
    asFilter<MediaJobDoc>(heldBy(claim)), { limit: 1 },
  );
  return held > 0;
}

/**
 * How long a heartbeat may be withheld while a phase makes many small steps.
 *
 * Chunk embedding lands a step every ~200 ms and each heartbeat is a database write, so an unthrottled
 * heartbeat would triple the writes the phase performs to say nothing new. 2 s is far below any usable
 * `stalledJobTimeoutMs` (the minimum the API accepts is 30 s) and far above the cost of a write.
 */
export const HEARTBEAT_MIN_INTERVAL_MS = 2_000;

/**
 * Should this step's heartbeat be written, given when the last one was?
 *
 * `isLast` forces a write so the final state of a phase is always recorded — a progress bar that stops at
 * 47/50 because the last three steps fell inside the throttle window reads as a hang.
 */
export function shouldHeartbeat(lastWriteAt: number, now: number, isLast = false): boolean {
  return isLast || now - lastWriteAt >= HEARTBEAT_MIN_INTERVAL_MS;
}

/**
 * One line describing a job that stall recovery is about to re-queue.
 *
 * Exists because the log said `reset 1 stalled job(s) to pending` at `info`, which names neither the file
 * nor how long it was quiet — so a fleet whose large documents were being recovered mid-flight had a
 * `WARN`-free log and no way to connect the restarts to a document. Everything an operator needs to decide
 * "too slow" vs "wedged" goes on the line: which file, how long silent, how big, which step it was in, and
 * which attempt this is.
 */
export function stalledJobWarning(job: {
  spaceId?: string;
  _id?: string;
  filePath?: string;
  progressAt?: string | null;
  claimedAt?: string | null;
  attempts?: number;
  maxAttempts?: number;
  progress?: { step?: string; done?: number; total?: number } | null;
}, nowMs: number, sizeBytes?: number): string {
  const since = job.progressAt ?? job.claimedAt ?? null;
  const quietMs = since ? Math.max(0, nowMs - Date.parse(since)) : NaN;
  const quiet = Number.isFinite(quietMs) ? `${Math.round(quietMs / 1000)}s` : 'unknown time';
  const where = job.progress?.step
    ? `${peerText(job.progress.step)}${job.progress.done !== undefined ? ` ${job.progress.done}/${job.progress.total ?? '?'}` : ''}`
    : 'no step reported';
  const size = sizeBytes !== undefined && Number.isFinite(sizeBytes)
    ? `${peerText((sizeBytes / 1024).toFixed(0))} KiB` : 'unknown size';
  return `Media worker: re-queued ${peerText(job.spaceId ?? '?')}/${peerText(job.filePath ?? job._id ?? '?')} after ${quiet}`
    + ` with no progress (${size}, last step: ${where}, attempt ${job.attempts ?? '?'}/${job.maxAttempts ?? '?'}).`
    + ` If the file is large and the instance is CPU-bound this is a slow job being killed, not a stuck one:`
    + ` raise stalledJobTimeoutMs or lower embedding.embedConcurrency.`;
}
