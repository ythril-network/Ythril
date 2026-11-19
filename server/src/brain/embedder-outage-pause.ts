/**
 * How long the embedding worker claims nothing after the embedder could not be reached.
 *
 * ## What it prevents
 *
 * An unreachable embedder costs a job waiting and not its attempts (`EmbedUnreachableError`, an `outage` of `classifyEmbedFailure`). Without a pause in the WORKER the
 * queue would still churn: every job with no back-off yet is claimed, fails at once, is written back with a back-off of its own, and the next is claimed, so a
 * thousand queued records are a thousand claims, a thousand failed calls and a thousand writes for one fact (the embedder is down). One failure stands for the
 * queue: after it the worker claims no further job for a pause that starts short (so a blip costs seconds), doubles to a cap (so a long outage is probed about once
 * a minute and not hammered) and ends with the first embed that worked.
 *
 * ## Where it is asked
 *
 * By the worker's LOOP before a claim, never by `runOneEmbedJob`: the tests drive that directly and a test must not wait for an outage. The same shape as the wait
 * for a restarting inference process (`waitOutLocalInferenceBackoff`), which is asked before the claim too.
 *
 * ## Shutdown
 *
 * `cancel` ends a wait at once, and stopping the worker calls it, so a pause is never what delays a shutdown. The timer does not hold the process open.
 */

/** The first pause after an unreachable embedder, ms: a blip costs this much. */
export const EMBEDDER_OUTAGE_PAUSE_FIRST_MS = 5_000;

/** The longest pause, ms: a long outage is probed about once in this long. */
export const EMBEDDER_OUTAGE_PAUSE_CAP_MS = 60_000;

/** What each further unreachable failure multiplies the pause by, up to the cap. */
const PAUSE_GROWTH = 2;

export interface EmbedderOutagePause {
  /** The embedder could not be reached: start the pause, or double it up to the cap. Returns the pause now owed, ms. */
  noteUnreachable(): number;
  /** An embed worked: the pause is over, and the next outage starts from the first step. */
  noteEmbedded(): void;
  /** How much of the pause is left, ms; 0 when there is none. */
  remainingMs(): number;
  /** Resolves when the pause is over, at once when there is none, and at once when `cancel` is called. */
  waitOut(): Promise<void>;
  /** End the pause now and release every wait: for shutdown. */
  cancel(): void;
}

/** One pause. The worker has one process-wide (`embedderOutagePause`); a test makes its own with a clock. */
export function createEmbedderOutagePause({ now = Date.now }: { now?: () => number } = {}): EmbedderOutagePause {
  let stepMs = 0;
  let until = 0;
  let waiters: Array<() => void> = [];
  let timer: ReturnType<typeof setTimeout> | null = null;

  const release = (): void => {
    if (timer) { clearTimeout(timer); timer = null; }
    const woken = waiters;
    waiters = [];
    for (const resolve of woken) resolve();
  };
  const remainingMs = (): number => Math.max(0, until - now());

  return {
    noteUnreachable() {
      stepMs = stepMs === 0 ? EMBEDDER_OUTAGE_PAUSE_FIRST_MS : Math.min(EMBEDDER_OUTAGE_PAUSE_CAP_MS, stepMs * PAUSE_GROWTH);
      until = now() + stepMs;
      return stepMs;
    },
    noteEmbedded() {
      stepMs = 0;
      until = 0;
    },
    remainingMs,
    waitOut() {
      const left = remainingMs();
      if (left === 0) return Promise.resolve();
      return new Promise<void>(resolve => {
        waiters.push(resolve);
        timer ??= setTimeout(release, left);
        timer.unref();
      });
    },
    cancel() {
      stepMs = 0;
      until = 0;
      release();
    },
  };
}

/** The worker's pause, shared by its loop and by the job it runs. */
export const embedderOutagePause = createEmbedderOutagePause();
