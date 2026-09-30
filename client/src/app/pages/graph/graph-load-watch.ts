/**
 * Is a graph load in flight, and has it run long enough to explain why? (`Q-155`)
 *
 * A wait past `WAIT_EXPLAIN_MS` says so, and says why from what the server reports for the space — its search
 * indexes being built, records waiting to be embedded. An upgraded instance rebuilding its indexes left the Graph
 * tab spinning with nothing on it. `WAIT_GIVE_UP_MS` ends a request that never answers in the error state, and
 * `gaveUpMessage()` is the one sentence that error state says, so the two loads that can give up cannot word it
 * differently.
 *
 * Split out of `graph.component.ts` when it exceeded its size limit (`Q-162`). The in-flight flag, the timer, the
 * readiness lookup and the signals move together because they are one question: nothing else on the page reads
 * the timer, and a reason list refreshed without the clock that asked for it would describe a wait nobody is in.
 *
 * The forgettable part is inside: `begin()` stops any clock already running before it starts one, so a second load
 * started over the first cannot leave an orphan timer that flips `waiting` on after the page has moved on.
 */
import { signal } from '@angular/core';
import { Observable, forkJoin, of } from 'rxjs';
import { catchError } from 'rxjs/operators';
import type { SpacesResponse, SpaceStats } from '../../core/api.types';
import { readinessReasons, type ReadinessReason } from './graph-readiness';

/** How long a load may run before the tab says it is still waiting, and why. */
export const WAIT_EXPLAIN_MS = 3_000;
/** How long a load may run before it ends in the error state rather than spinning for ever. */
export const WAIT_GIVE_UP_MS = 30_000;

/** What the watch reads a space's readiness from — the two `SpacesApi` calls, and nothing else. */
export interface ReadinessSource {
  listSpaces(): Observable<SpacesResponse>;
  getSpaceStats(spaceId: string): Observable<SpaceStats>;
}

/** Translates the give-up sentence — `TranslocoService` satisfies it. */
export interface Translator {
  translate(key: string, params?: Record<string, unknown>): string;
}

export class GraphLoadWatch {
  /** True from `begin()` to `end()` — what puts the spinner on the canvas. */
  readonly loading = signal(false);
  /** True once a load has run past `WAIT_EXPLAIN_MS`, until it ends. */
  readonly waiting = signal(false);
  /** What the server reported when the wait got long. Kept after `end()`, so an error state can show them. */
  readonly reasons = signal<ReadinessReason[]>([]);
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly source: ReadinessSource, private readonly translator: Translator) {}

  /** Start the clock that turns a long wait into words; the reasons are read only if the wait gets that long. */
  begin(spaceId: string): void {
    this.end();
    this.loading.set(true);
    this.reasons.set([]);
    this.timer = setTimeout(() => {
      this.timer = null;
      this.waiting.set(true);
      forkJoin({
        spaces: this.source.listSpaces().pipe(catchError(() => of(null))),
        stats: this.source.getSpaceStats(spaceId).pipe(catchError(() => of(null))),
      }).subscribe(({ spaces, stats }) => {
        const space = spaces?.spaces.find(s => s.id === spaceId);
        this.reasons.set(readinessReasons(space?.indexStatus, stats?.embedQueue, space?.indexWaiting));
      });
    }, WAIT_EXPLAIN_MS);
  }

  /** The load is over, whichever way it ended. The reasons stay, so an error state that follows can still show them. */
  end(): void {
    this.loading.set(false);
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    this.waiting.set(false);
  }

  /** The error text for a load that ran past `WAIT_GIVE_UP_MS`. */
  gaveUpMessage(): string {
    return this.translator.translate('graph.waiting.gaveUp', { seconds: WAIT_GIVE_UP_MS / 1000 });
  }
}
