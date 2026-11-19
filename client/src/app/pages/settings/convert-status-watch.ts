import type { Observable } from 'rxjs';
import { pollUntil, type PollHandle } from '../../core/poll-until';
import type { ConversionResult, ConvertStatusAnswer } from '../../core/conversion.types';

/**
 * Read a conversion's progress until it ends (bundle-285 slice S6, Q-747; plan section 3.1 item 7).
 *
 * Two places show a run as it goes: the dialog a converting Save leaves open, and the note on the type. Both ask the same question, "how far has the
 * run got, and is it still going?", so the loop is written once, with the guards a hand-written copy forgets. It is `pollUntil` (a failed request
 * schedules the next one, a hidden tab skips its read, `stop()` drops an answer still in flight) with the three things this question adds:
 *
 * - **A bounded interval.** One read at once, then one every {@link CONVERT_POLL_MS}.
 * - **It ends.** On an answer that is not a run in progress (finished, failed, no run), on `stop()`, and after {@link CONVERT_POLL_FAILURES_MAX}
 *   reads in a row that failed: a server that never answers is not asked for ever. The caller is told when it gave up.
 * - **A failed read is said, and tried again.** `ConversionApi.status` answers a refusal as a value, never as an error, so a refused read is a failure here
 *   too; the caller hears how many failed in a row, and one good answer starts the count again.
 */

/** Milliseconds between two reads of a run in progress. */
export const CONVERT_POLL_MS = 3_000;

/** Reads in a row that may fail before the watch stops asking. */
export const CONVERT_POLL_FAILURES_MAX = 20;

export interface ConvertWatchHooks {
  /** Every answer that carries a run, or none (the run in progress, and the answer that ends the watch). */
  onStatus(status: ConvertStatusAnswer): void;
  /** A read failed: how many in a row have, and whether the watch has given up (the last call it makes). */
  onFailure(inARow: number, gaveUp: boolean): void;
  /** The run is no longer in progress (finished, failed or never started), so the watch has ended by itself. */
  onFinished?(): void;
}

/** What the watch asks of the conversion API. */
export interface ConvertStatusSource { status(spaceId: string): Observable<ConversionResult<ConvertStatusAnswer>> }

/** Start watching the run of `spaceId`. Call `stop()` when the page or dialog that shows it goes. */
export function watchConvertRun(source: ConvertStatusSource, spaceId: string, hooks: ConvertWatchHooks): PollHandle {
  let failures = 0;
  let first = true;
  /** One more failed read: say so, and whether the bound is reached. */
  const failed = (): boolean => {
    failures++;
    const gaveUp = failures >= CONVERT_POLL_FAILURES_MAX;
    hooks.onFailure(failures, gaveUp);
    return gaveUp;
  };
  const handle: PollHandle = pollUntil<ConversionResult<ConvertStatusAnswer>>({
    delayMs: () => { const wait = first ? 0 : CONVERT_POLL_MS; first = false; return wait; },
    request: () => source.status(spaceId),
    onAnswer: result => {
      if (!result.ok) return !failed();
      failures = 0;
      hooks.onStatus(result.value);
      if (result.value.state === 'running') return true;
      hooks.onFinished?.();
      return false;
    },
    // `status` never throws; a request that did is a failure like a refused one.
    onError: () => { if (failed()) handle.stop(); },
  });
  return handle;
}
