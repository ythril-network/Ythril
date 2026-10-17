/**
 * Whether a space may take a write now — refused while a deletion, wipe or rename of it stands, or once it is no longer configured;
 * asked IN EVERY WRITER, per write unit (bundle-106, design v5 §2.6b, X2).
 *
 * ## Why in the writers and not at a door
 *
 * The first version of this lived at the file door alone, and the next design closed three RIGHTS doors in front of the writers. Both
 * were lists of guards, not the set of writers: the admin import, an instance-admin token's sync push and a `save_bulk` stage admitted a
 * moment before a wipe registered all reached the store through no guard, and the wipe then deleted — or failed to delete — what they
 * wrote. So the question is asked by every function that writes a space's records or its file tree (`every-space-writer-asks-the-write-
 * gate` derives them), after every rights check has passed: a token without the write rung gets its `403` and never learns a wipe runs.
 *
 * ## What it answers from
 *
 * ONE predicate, `spaceActStands` (`space-act-runner.ts`), which reads the act entries and the delete or rename body's own
 * `pendingSpaceOp`. A write names its family, so a `facts` wipe refuses fact writes only and leaves file writes and media jobs alone; a
 * deletion and a rename close every family.
 *
 * ## The act's own writes
 *
 * A body that writes its own space (a wipe forgetting its file tombstones, unlabelling faces) passes `except: <its entry id>` — the check
 * still runs, so any OTHER act standing for the space still refuses it. Never a writer that skips the check.
 *
 * The media worker treats the refusal as an abandonment (`isAbandonment` in `files/media/lease.ts`), exactly as it treats a moved file's
 * lost claim: nothing is failed, retried or recorded against a job whose space is going away.
 */
import { getConfig, isConfigLoaded } from '../config/loader.js';
import type { Config } from '../config/types.js';
import type { BrainCollection } from '../config/types-knowledge.js';
import { spaceActStands, type SpaceActStanding } from './space-act-runner.js';

/** Why a space takes no writes: the act standing for it. */
export type SpaceWriteClosedCode = 'space_being_wiped' | 'space_being_deleted' | 'space_being_renamed';

/** A write refused because its space is being deleted, wiped or renamed, or no longer exists. Not a failure of the work. */
export class SpaceNotWritableError extends Error {
  readonly spaceId: string;
  readonly code?: SpaceWriteClosedCode;
  constructor(spaceId: string, why: string, code?: SpaceWriteClosedCode) {
    super(code ? `Space '${spaceId}' takes no writes while ${why}` : `Space '${spaceId}' takes no more file writes: ${why}`);
    this.name = 'SpaceNotWritableError';
    this.spaceId = spaceId;
    if (code) this.code = code;
  }
}

/** True when `err` is that refusal, across module instances too. */
export function isSpaceNotWritable(err: unknown): err is SpaceNotWritableError {
  return err instanceof SpaceNotWritableError || (err instanceof Error && err.name === 'SpaceNotWritableError');
}

/** The refusal for a write of `family` to `spaceId`, with its code when an act is behind it, or null when the write may land. */
function refusalFor(cfg: Config, spaceId: string, stands: SpaceActStanding | null): { why: string; code?: SpaceWriteClosedCode } | null {
  if (stands?.kind === 'wipe') return { why: 'it is being wiped; retry once the wipe completes', code: 'space_being_wiped' };
  if (stands?.kind === 'delete') return { why: 'it is being deleted', code: 'space_being_deleted' };
  if (stands?.kind === 'rename') {
    return { why: `it is being renamed to '${stands.newId ?? ''}'; retry under the new id once the rename completes`, code: 'space_being_renamed' };
  }
  if (!cfg.spaces.some(s => s.id === spaceId)) return { why: 'it is not configured on this instance' };
  return null;
}

/** Why `spaceId` may not take a write of `family` now, or null when it may. No family = a write that touches every family. */
export function spaceWriteRefusal(spaceId: string, family?: BrainCollection, opts: { except?: string } = {}): string | null {
  if (!isConfigLoaded()) return null;   // pre-setup: no space lifecycle exists to race
  const cfg = getConfig();
  return refusalFor(cfg, spaceId, spaceActStands(cfg, spaceId, { types: family ? [family] : undefined, except: opts.except }))?.why ?? null;
}

/** Throw {@link SpaceNotWritableError} unless `spaceId` may take a write of `family` now. `except`: the asking act's own entry. */
export function assertSpaceTakesWrites(spaceId: string, family?: BrainCollection, opts: { except?: string } = {}): void {
  if (!isConfigLoaded()) return;
  const cfg = getConfig();
  const r = refusalFor(cfg, spaceId, spaceActStands(cfg, spaceId, { types: family ? [family] : undefined, except: opts.except }));
  if (r) throw new SpaceNotWritableError(spaceId, r.why, r.code);
}

/**
 * Is `err` the refusal of a write because an ACT stands for its space (not because the space is unconfigured)? Housekeeping asks it to
 * pass a space over quietly — a deletion or wipe owns that space's rows until it completes, and a sweep that met one is not a failure.
 */
export function isActRefusal(err: unknown): boolean {
  return isSpaceNotWritable(err) && err.code !== undefined;
}

/**
 * The answer both doors give a write the closure refused: `409` with our sentence and the code (REST through `sendCaughtFailure`,
 * MCP and `POST /api/<tool>` through `callTool`), or null for anything else. A refusal with no act behind it (the space is not
 * configured) is not this answer.
 */
export function spaceWriteClosedAnswer(err: unknown): { status: 409; body: { error: string; code: SpaceWriteClosedCode } } | null {
  if (!isSpaceNotWritable(err) || !err.code) return null;
  return { status: 409, body: { error: err.message, code: err.code } };
}
