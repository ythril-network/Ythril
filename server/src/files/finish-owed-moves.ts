/**
 * Housekeeping's completion of a file move a failure stopped after its bytes — the instance finishes the moves it began.
 *
 * ## The question it answers
 *
 * "Which of this space's moves have their bytes at the destination and their records still at the source, and has somebody
 * finished them?" A move carries the bytes first and the records after, and a failure between the two (the store paused, a restart)
 * left the file at one path and its records at the other. The request that began it answered `503`; whether anything then
 * finished it depended on the caller retrying. A caller that does not retry — a sync peer's rename, a client that gave up, a script
 * that read the failure and went on — left the file listed where it no longer is and, once the media worker found no bytes at the old
 * path, deleted by the "deleted source" reconcile — which asks {@link moveIsOwed} first (`files/media/worker.ts`). The marker the
 * move wrote with its tombstones (`files/tombstones.ts`) is the record that it is owed, and this reads it.
 *
 * ## What it does
 *
 * Per space, from the markers past the settle threshold (`fileTombstoneStaleBefore`: the request that wrote one has had its time):
 * each move is asked {@link moveIsOwed}; an owed one is finished by `finishOwedMove(from, to, <the marker's actor>)` — the finishing
 * half of the cascade a retry of the request runs, which tells subscribers of the move once, from whichever runner finishes it. It
 * takes the move's turn first and asks again inside it: a move a request finished while this pass waited is done, not a failed
 * attempt. A move is not trusted to have finished because the finish returned: it is asked again.
 *
 * ## What bounds it, and what it says
 *
 * - **A budget per space per pass** ({@link MOVES_FINISHED_PER_TICK} moves finished, {@link MOVES_EXAMINED_PER_TICK} markers looked
 *   at); the markers are walked move by move in a stable order and a pass resumes where the last stopped, so a space with a lot to
 *   do is neither stalled behind its first move nor held for one tick.
 * - **A budget of time for the step** ({@link MOVES_STEP_BUDGET_MS}): a count says nothing of what a move costs. Once it is spent no
 *   new move is started and no attempt is counted for the ones left, which wait for the next pass; a move already running is not
 *   interrupted. The TTL sweep passes one deadline for every space of the step, so the spaces share the time.
 * - **Attempts counted on the marker, with doubling backoff.** Counted BEFORE the try (a try a restart ended is spent), and a move
 *   is not tried again before its `nextAttemptAt`: {@link MOVE_FINISH_BACKOFF_BASE_MS} doubling per failed attempt up to the
 *   window a marker is kept ({@link MOVE_MARKER_KEEP_MS}).
 * - **Stranded after {@link MOVE_FINISH_ATTEMPTS}.** The marker is KEPT (it is all that lets a retry of the move finish it), the
 *   move is not tried again, and every pass says so through the shared reporter, which says it once per window; the stranded
 *   gauge counts it. Nothing is deleted and nothing loops.
 * - **Every failure goes through the walk**: each move is a unit of the space (`eachUnit`), so a failing move is reported with its
 *   paths and the moves after it still run, and a store that is not answering ends the walk, once.
 *
 * A success is logged, audited (`file.move.finish`, an entry with no token), counted
 * (`ythril_file_moves_finished_by_housekeeping_total`), and what each pass found is published for the owed and stranded gauges
 * (`owed-moves-seen.ts`).
 *
 * ## What it does not do
 *
 * It does not repair a move the pre-completion sweep already forgot (its marker is gone, so nothing says it is owed), and it does
 * not take the move's single-flight lock itself: `finishOwedMove` does, so a request's retry and this pass cannot interleave.
 */
import { eachUnit } from '../util/housekeeping-walk.js';
import { backoffDelayMs } from '../util/backoff.js';
import { log, peerText } from '../util/log.js';
import { logInternalAudit } from '../audit/audit.js';
import { FILE_MOVE_FINISH_OPERATION } from '../audit/middleware.js';
import { fileMovesFinishedByHousekeepingTotal } from '../metrics/registry.js';
import { finishOwedMove } from './move-cascade.js';
import {
  MOVE_MARKER_KEEP_MS, createMoveMarkerPager, fileTombstoneStaleBefore, moveIsOwed, recordMoveAttempt, type MoveMarker,
} from './tombstones.js';
import { publishOwedMoves } from './owed-moves-seen.js';

/** How many attempts to finish a move housekeeping makes before it stops and keeps the marker (STRANDED). */
export const MOVE_FINISH_ATTEMPTS = 8;
/** The wait after the first failed attempt; each further one doubles it, up to {@link MOVE_MARKER_KEEP_MS}. */
export const MOVE_FINISH_BACKOFF_BASE_MS = 5 * 60_000;
/** The most moves one space has finished in one pass; the rest wait for the next. */
export const MOVES_FINISHED_PER_TICK = 5;
/** The most markers (distinct moves) one space looks at in one pass; the next pass resumes after the last. */
export const MOVES_EXAMINED_PER_TICK = 100;

/**
 * How long the step may go on STARTING moves, ms. A move's cost is the size of the file or tree it carries, which the count above says
 * nothing about, and the TTL tick has the rest of the housekeeping to do: past this the step starts no more moves and leaves them for the
 * next pass. A move already running is never interrupted.
 */
const MOVES_STEP_BUDGET_MS = 60_000;

/** The instant after which the step starts no new move, for a step beginning at `from` (default now). */
export const moveFinishDeadline = (from: number = Date.now()): number => from + MOVES_STEP_BUDGET_MS;

/** The limits of a pass. The defaults are the real ones; a test narrows them. */
export interface FinishLimits {
  attempts: number;
  backoffBaseMs: number;
  finishedPerTick: number;
  examinedPerTick: number;
  /** Epoch ms after which no new move is started. Absent, the pass's own start plus {@link MOVES_STEP_BUDGET_MS}. */
  deadlineAt?: number;
}
const DEFAULT_LIMITS: FinishLimits = {
  attempts: MOVE_FINISH_ATTEMPTS, backoffBaseMs: MOVE_FINISH_BACKOFF_BASE_MS,
  finishedPerTick: MOVES_FINISHED_PER_TICK, examinedPerTick: MOVES_EXAMINED_PER_TICK,
};

/** What one space's pass did. */
export interface FinishOutcome {
  /** Markers looked at, and how many of those moves are owed. */
  examined: number;
  owed: number;
  /** Moves finished by this pass. */
  finished: number;
  /** Owed moves left for a later pass: backing off, or past this pass's budget. */
  waiting: number;
  /** Owed moves whose attempts are spent. */
  stranded: number;
}

/** Where each space's pass resumes (`createMoveMarkerPager`): strictly after the last move it looked at. */
const pageOfMoves = createMoveMarkerPager();
/** What the pass in progress has found so far, per space: published when the pass reaches the end of the markers. */
const inProgress = new Map<string, { owed: number; stranded: number; oldestMarkedAt?: string }>();

/** The wait before the move's next attempt, after `attempts` of them have failed: jittered, so moves that failed together do not retry together. */
const backoffMs = (attempts: number, limits: FinishLimits): number =>
  backoffDelayMs(attempts - 1, limits.backoffBaseMs, MOVE_MARKER_KEEP_MS);

const label = (m: Pick<MoveMarker, 'from' | 'to'>): string => `${m.from} → ${m.to}`;

/**
 * Finish the owed moves of `spaceId` past the settle threshold, within the pass's budget. Must run inside a walk of the spaces
 * (`eachSpace`): each move is a unit of it, and a unit's failure is reported by the walk.
 */
export async function finishOwedMoves(
  spaceId: string, now: Date = new Date(), limits: Partial<FinishLimits> = {},
): Promise<FinishOutcome> {
  const lim: FinishLimits = { ...DEFAULT_LIMITS, ...limits };
  // Inside the function, so a caller that passes nothing is still bounded; the TTL sweep passes one deadline for the whole step.
  const deadlineAt = lim.deadlineAt ?? moveFinishDeadline();
  const outcome: FinishOutcome = { examined: 0, owed: 0, finished: 0, waiting: 0, stranded: 0 };
  const { markers, reachedTheEnd } = await pageOfMoves(spaceId, fileTombstoneStaleBefore(now), lim.examinedPerTick);
  outcome.examined = markers.length;

  // Which of them are owed: a marker whose move finished, or was never begun past its bytes, is the settle's to clear.
  const owed: Array<MoveMarker & { markedAt: string }> = [];
  await eachUnit(markers, async (m) => { if (await moveIsOwed(spaceId, m.from, m.to)) owed.push(m); }, label);
  outcome.owed = owed.length;

  // Who to try now. Stranded ones are walked too, to be SAID: they throw, and the walk reports them once per window.
  const stranded = owed.filter(m => (m.attempts ?? 0) >= lim.attempts);
  const trying = owed.filter(m => (m.attempts ?? 0) < lim.attempts && (m.nextAttemptAt ?? '') <= now.toISOString()).slice(0, lim.finishedPerTick);
  outcome.stranded = stranded.length;
  outcome.waiting = owed.length - stranded.length - trying.length;

  await eachUnit(stranded, async (m) => {
    throw new Error(`the move is stranded: ${m.attempts} attempts to finish it failed. Its records stay at ${peerText(m.from)} and its marker is kept; `
      + 'a retry of the move may still finish it');
  }, label);

  const finished = new Set<MoveMarker>();
  await eachUnit(trying, async (m) => {
    // The pass's time is spent: no new move is started (one already running is never interrupted), no attempt is counted for it, and
    // it is waiting for the next pass.
    if (Date.now() >= deadlineAt) { outcome.waiting++; return; }
    const attempts = (m.attempts ?? 0) + 1;
    // Counted before the try: a try a restart ended is a try spent.
    await recordMoveAttempt(spaceId, m.from, m.to, attempts, new Date(now.getTime() + backoffMs(attempts, lim)).toISOString());
    const startedAt = Date.now();
    // The turn is taken and the move asked about AGAIN inside it: a request that retried the move first has finished it, and a move that
    // is done is not a failed attempt.
    if (!(await finishOwedMove(spaceId, m.from, m.to, m.actor))) { finished.add(m); return; }
    // The finish returning is not the move being finished: it survives some failures of its own steps.
    if (await moveIsOwed(spaceId, m.from, m.to)) throw new Error(`the move ran (attempt ${attempts} of ${lim.attempts}) and is still owed`);
    finished.add(m);
    outcome.finished++;
    fileMovesFinishedByHousekeepingTotal.labels({ space: spaceId }).inc();
    log.info(`Housekeeping finished the file move ${peerText(label(m))} in space '${peerText(spaceId)}' (attempt ${attempts})`);
    logInternalAudit({ method: 'SWEEP', path: 'internal:file-move-finish', spaceId, operation: FILE_MOVE_FINISH_OPERATION, startedAt });
  }, label);

  // What this pass saw, added to the pass in progress; published once the markers have been walked to the end. A move finished
  // just now is no longer owed.
  const seen = inProgress.get(spaceId) ?? { owed: 0, stranded: 0 };
  const stillOwed = owed.filter(m => !finished.has(m));
  seen.owed += stillOwed.length;
  seen.stranded += stranded.length;
  for (const m of stillOwed) if (seen.oldestMarkedAt === undefined || m.markedAt < seen.oldestMarkedAt) seen.oldestMarkedAt = m.markedAt;
  if (reachedTheEnd) { inProgress.delete(spaceId); publishOwedMoves(spaceId, seen); } else inProgress.set(spaceId, seen);
  return outcome;
}
