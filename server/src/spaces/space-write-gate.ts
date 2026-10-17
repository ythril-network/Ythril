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
import { enterSpaceWrite } from '../sync/space-transfer-fence.js';

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

/** What a write touches: one family, several (a tombstone write names the families of the records it buries), or none for every family. */
export type WriteFamilies = BrainCollection | readonly BrainCollection[] | undefined;

/**
 * Throw {@link SpaceNotWritableError} unless `spaceId` may take a write of `family` now. `except`: the asking act's own entry. A CHECK that
 * writes nothing: a writer asks through {@link admitSpaceWrite} or {@link admitSpaceWriteUnit}, which count what they admit; this stands alone
 * only where a function refuses before a write another function admits and counts (a door's early refusal ahead of the commit's own stages)
 * or passes a refused space over (housekeeping).
 */
export function assertSpaceTakesWrites(spaceId: string, family?: WriteFamilies, opts: { except?: string } = {}): void {
  if (!isConfigLoaded()) return;
  const cfg = getConfig();
  const types = family === undefined ? undefined : typeof family === 'string' ? [family] : [...family];
  const r = refusalFor(cfg, spaceId, spaceActStands(cfg, spaceId, { types, except: opts.except }));
  if (r) throw new SpaceNotWritableError(spaceId, r.why, r.code);
}

/**
 * ADMIT one write unit of `spaceId` and count it: ask the gate and enter the fence in ONE synchronous step, and return the release. The
 * pair nothing may split — a unit admitted by its check and counted only after an await is admitted and yet invisible to the drain of an
 * act that registers in the gap (the act drains at once, deletes, and the write lands in what it emptied). Throws
 * {@link SpaceNotWritableError} before anything is counted, so a refusal leaves no count. For a writer whose unit is not one closure (the
 * commit's stage loop, the arrival writer's chunk loop); everything else calls {@link admitSpaceWrite}, which cannot forget the release.
 *
 * `family` names what the write touches (none: every family); `except` is the asking act's own entry (an act's body writes its own space).
 */
export function admitSpaceWriteUnit(spaceId: string, family?: WriteFamilies, opts: { except?: string } = {}): () => void {
  assertSpaceTakesWrites(spaceId, family, opts);
  return enterSpaceWrite(spaceId);
}

/**
 * Run `body` as ONE admitted and counted write of `spaceId`: the gate is asked and the fence entered with nothing awaited between
 * ({@link admitSpaceWriteUnit}), and the count is released in a `finally` around the whole body, however it ends — the guard and the release
 * are inside, so no writer can drop either. The one function a writer of a space goes through; `every-transfer-enters-the-fence` holds
 * every asker to it (or to the unit form) and lists the few that need no count with the design's reason.
 *
 * ## What it prevents
 *
 * A deletion or wipe registers, waits for the units ADMITTED before it, then deletes. A writer that asked, awaited (its path, its read set, its
 * embedding) and only then wrote was admitted and not counted: its write landed after the act's first delete, resurrecting what the act removed.
 * Here a write the gate lets through is counted from that moment, and one it refuses is never counted (the refusal throws first, so nothing leaks).
 *
 * The body is every step that reads for or touches the space's data, so the unit is the writer's whole length; the drain waits for it and
 * `withinWriteBound` bounds each store operation inside. The refusal is thrown as the writer's own rejection, as `assertSpaceTakesWrites` was.
 */
export async function admitSpaceWrite<T>(spaceId: string, family: WriteFamilies, body: () => Promise<T>, opts: { except?: string } = {}): Promise<T> {
  const leaveWriteUnit = admitSpaceWriteUnit(spaceId, family, opts);
  try { return await body(); } finally { leaveWriteUnit(); }
}

/**
 * Is `err` the refusal of a write because an ACT stands for its space (not because the space is unconfigured)? Housekeeping asks it to
 * pass a space over quietly — a deletion or wipe owns that space's rows until it completes, and a sweep that met one is not a failure.
 */
export function isActRefusal(err: unknown): err is SpaceNotWritableError & { code: SpaceWriteClosedCode } {
  return isSpaceNotWritable(err) && err.code !== undefined;
}

/**
 * The answer both doors give a write the closure refused: `409` with our sentence and the code (REST through `sendCaughtFailure`,
 * MCP and `POST /api/<tool>` through `callTool`), or null for anything else. A refusal with no act behind it (the space is not
 * configured) is not this answer.
 */
export function spaceWriteClosedAnswer(err: unknown): { status: 409; body: { error: string; code: SpaceWriteClosedCode } } | null {
  if (!isActRefusal(err)) return null;
  return { status: 409, body: { error: err.message, code: err.code } };
}
