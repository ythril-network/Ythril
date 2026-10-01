/**
 * Whether a space may still take writes under its files directory — refused once it is being deleted or renamed
 * away, or is no longer configured.
 *
 * ## Why this exists
 *
 * The media worker converts a file long after it was uploaded, and writes its artifacts (the converted Markdown,
 * extracted images) to disk BEFORE its commit is fenced on the job's claim. A space deleted meanwhile had its
 * collections dropped — so the claim was gone and nothing reached the database — but the disk writes still landed,
 * inside the tree the delete was removing. That race is what failed a delete with `ENOTEMPTY` and left its marker
 * blocking every later space operation (Docker integration run of bundle-27, 13:30:47Z).
 *
 * The check lives at the file door (`writeFile`/`writeFileBytes` in `files/files.ts`), not in the worker, because
 * every writer into a space's tree goes through that door and a check placed in one writer is the one the next
 * writer is written without. The delete's own marker is what closes it: `removeSpace` records `pendingSpaceOp`
 * BEFORE it drops anything, so from that write on, nothing new starts under the space. A write that passed the
 * check just before the marker is outlasted by `removeTree`'s retries.
 *
 * The media worker treats the refusal as an abandonment (`isAbandonment` in `files/media/lease.ts`), exactly as it
 * treats a moved file's lost claim: nothing is failed, retried or recorded against a job whose space is going away.
 */
import { getConfig, isConfigLoaded } from '../config/loader.js';

/** A write refused because its space is being deleted or renamed away, or no longer exists. Not a failure of the work. */
export class SpaceNotWritableError extends Error {
  readonly spaceId: string;
  constructor(spaceId: string, why: string) {
    super(`Space '${spaceId}' takes no more file writes: ${why}`);
    this.name = 'SpaceNotWritableError';
    this.spaceId = spaceId;
  }
}

/** True when `err` is that refusal, across module instances too. */
export function isSpaceNotWritable(err: unknown): boolean {
  return err instanceof SpaceNotWritableError || (err instanceof Error && err.name === 'SpaceNotWritableError');
}

/** Why `spaceId` may not take a file write now, or null when it may. */
export function spaceWriteRefusal(spaceId: string): string | null {
  if (!isConfigLoaded()) return null;   // pre-setup: no space lifecycle exists to race
  const cfg = getConfig();
  const op = cfg.pendingSpaceOp;
  if (op?.spaceId === spaceId) {
    return op.type === 'delete' ? 'it is being deleted' : `it is being renamed to '${op.newId}'`;
  }
  if (!cfg.spaces.some(s => s.id === spaceId)) return 'it is not configured on this instance';
  return null;
}

/** Throw {@link SpaceNotWritableError} unless `spaceId` may take a file write now. */
export function assertSpaceTakesWrites(spaceId: string): void {
  const why = spaceWriteRefusal(spaceId);
  if (why) throw new SpaceNotWritableError(spaceId, why);
}
