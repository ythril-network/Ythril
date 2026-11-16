/**
 * The Files page's progress poll: ask for the listing again while a row on screen is still being processed.
 *
 * ## Why it exists
 *
 * A listing carries each file's conversion progress and embedding status, and nothing pushes a change of either. The stage bar was drawn once, from
 * the listing current when the folder was opened, and sat there ("page 12 of 40" for the whole conversion); nothing errored, so it read as a wedged
 * pipeline and not a stale view. A poll is the honest mechanism for a value with no event behind it, and this one is bounded on both sides: it
 * exists only while a row is actually in flight, and `pollUntil` skips a tick when the tab is hidden. An idle folder polls nothing.
 *
 * ## What it prevents
 *
 * A second timer: `sync()` while one runs does nothing. And a poll outliving its page: `stop()` ends it, and the page calls it on destroy, because a
 * poll left running reloads through the component's own signals on a destroyed component. Moved out of `file-manager.component.ts` (Q-861) with its
 * behaviour unchanged, so a spec can reach it without the page.
 */
import { of } from 'rxjs';
import type { FileEntry } from '../../core/api.types';
import { pollUntil, type PollHandle } from '../../core/poll-until';

/** 4 s: progress moves a page at a time, so faster only costs requests. `progressAt` shows staleness. */
export const PROGRESS_POLL_MS = 4_000;

/** True while any row is still being processed — the only condition that justifies polling. */
export function entriesInFlight(entries: readonly FileEntry[]): boolean {
  return entries.some(e => !!e.progress || e.embeddingStatus === 'pending' || e.embeddingStatus === 'processing');
}

export class FileProgressPoll {
  private poll: PollHandle | null = null;

  /**
   * @param entries what is on screen now, read at every sync and every answer
   * @param refresh one tick's work: reload the listing, and the open file's own record, which goes stale the same way (the description a document gets
   *   is written when its job finishes, so a detail pane opened during processing showed none until the file was closed and reopened)
   */
  constructor(private readonly entries: () => readonly FileEntry[], private readonly refresh: () => void) {}

  /** Start or stop the poll to match what is on screen. Called after every listing load. */
  sync(): void {
    if (!entriesInFlight(this.entries())) { this.stop(); return; }
    if (this.poll?.active) return;                                // already running — never stack timers
    /*
     * The request is not an Observable of its own: the listing store owns the request and publishes the answer through `listed`, which is what
     * retires this poll (`sync`, above). So the tick starts the reload and answers at once, and the poll goes on while something is in flight.
     * A failed reload never ends the chain: it is the store's, and the next tick asks again.
     */
    this.poll = pollUntil<void>({
      delayMs: () => PROGRESS_POLL_MS,
      request: () => { this.refresh(); return of(undefined); },
      onAnswer: () => entriesInFlight(this.entries()),
    });
  }

  stop(): void {
    this.poll?.stop();
    this.poll = null;
  }
}
