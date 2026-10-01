/**
 * The Brain page's reindex: whether the space needs one, whether one is running and how far it has got, and starting
 * one — the state both Reindex buttons (the stale-index banner's and the Overview Indexing panel's) are driven by.
 *
 * ## Why it is its own class
 *
 * `brain.component.ts` is a frozen file, and this is a concern with its own lifecycle: a run lasts minutes, outlives
 * the request that started it, and has to be polled until it ends because nothing else tells the page — the rebuild
 * is not a write, so no live event fires for it (Q-99 part 2). Held in the page, every one of those rules sat between
 * the record tabs and the live stream; here they are one place that is read together.
 *
 * ## The rules it holds
 *
 * - **ONE answer for both buttons.** `reindexing` is a request in flight OR the server's run. It used to be the
 *   request alone, which lasts milliseconds, so a second click during a run that takes minutes sent a second reindex.
 * - **Poll while a run is going, stop when it ends**, through `pollUntil`, which keeps asking after a failed request and
 *   skips a hidden tab. When the run ends the page's stats are read again, once.
 * - **A space switch forgets the old space's run** — it is not this one's — and polls nothing until this space answers.
 */
import { computed, signal } from '@angular/core';
import type { TranslocoService } from '@jsverse/transloco';
import type { SpacesApi } from '../../core/spaces-api.service';
import type { ToastService } from '../../core/toast.service';
import type { ReindexRunState, ReindexStatus } from '../../core/embed-ops.types';
import { pollUntil, type PollHandle } from '../../core/poll-until';

/** While a run is going the page asks again on this interval. */
export const REINDEX_POLL_MS = 5_000;

export interface BrainReindexHost {
  spacesApi: SpacesApi;
  toast: ToastService;
  transloco: TranslocoService;
  /** The space the page shows now; an answer for any other is dropped. */
  activeSpaceId: () => string;
  /** Read the space's stats and reindex state again. */
  reload: (spaceId: string) => void;
}

export class BrainReindex {
  readonly needsReindex = signal(false);
  /** The active space's reindex run as the server last reported it. */
  readonly reindexRun = signal<ReindexRunState | null>(null);
  private readonly inFlight = signal(false);
  readonly reindexing = computed(() => this.inFlight() || this.reindexRun()?.running === true);
  private poll?: PollHandle;

  constructor(private readonly host: BrainReindexHost) {}

  /** Take a reindex-status answer; returns whether to keep polling. */
  apply(spaceId: string, st: ReindexStatus): boolean {
    if (this.host.activeSpaceId() !== spaceId) return false;
    const wasRunning = this.reindexRun()?.running === true;
    this.needsReindex.set(st.needsReindex);
    this.reindexRun.set(st.reindexRun ?? null);
    if (st.reindexRun?.running) {
      if (!this.poll?.active) {
        this.poll = pollUntil({
          delayMs: () => REINDEX_POLL_MS,
          request: () => this.host.spacesApi.getReindexStatus(spaceId),
          onAnswer: (next) => this.apply(spaceId, next),
        });
      }
      return true;
    }
    this.stop();
    if (wasRunning) this.host.reload(spaceId);
    return false;
  }

  /** The page moved to another space: its run is not this one's. */
  forget(): void {
    this.stop();
    this.reindexRun.set(null);
  }

  stop(): void {
    this.poll?.stop();
    this.poll = undefined;
  }

  /**
   * Start a reindex and say that it STARTED.
   *
   * ## The report this rewrites
   *
   * Owner, 2026-08-15: *"on clicking reindex on overview it sais reindexed 0 documents in green as if it
   * worked on an unclosable inline message."*
   *
   * The route never awaits the job — `startReindex` records the run and both surfaces answer immediately with ZEROED
   * counters, deliberately, so the HTTP call does not hang for the length of a re-embed. This used to sum those zeros
   * and print "Reindexed 0 documents." — the acknowledgement of a job just scheduled, rendered as its result. There is
   * no count to print here: progress is `reindexRun` on `reindex-status`, which the Indexing panel shows.
   *
   * A toast rather than an inline banner, for the reason the report gives: the inline one had no dismiss and was
   * cleared only by switching space, so a note about a finished job outlived everything after it.
   */
  run(): void {
    if (this.reindexing()) return;
    const spaceId = this.host.activeSpaceId();
    this.inFlight.set(true);
    this.host.spacesApi.reindex(spaceId).subscribe({
      next: () => {
        this.inFlight.set(false);
        this.host.toast.info(this.host.transloco.translate('brain.reindex.started'));
        // The stale-index banner is NOT cleared here: the index really is still stale, the run has only just been
        // recorded. Reading the true state is what holds the buttons and starts the progress.
        this.host.reload(spaceId);
      },
      error: (err) => {
        this.inFlight.set(false);
        // A 409 is this space's run still going, which is not a failure: say so in the reader's language and pick
        // the run up, so the buttons are held and the progress shows.
        if (err?.status === 409) {
          this.host.toast.info(this.host.transloco.translate('brain.reindex.alreadyRunning'));
          this.host.reload(spaceId);
          return;
        }
        // The server's own words when it has them: a proxy refusal names the member spaces to reindex instead,
        // and "check server logs" would send the reader to the one place that does not say it.
        this.host.toast.error(err?.error?.error ?? this.host.transloco.translate('brain.reindex.failed'));
      },
    });
  }
}
