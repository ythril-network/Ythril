/**
 * What a recall hit holds (`Q-87`).
 *
 * A hit is `{type, score, spaceId, record: {...}}` — the ranking beside the record, not mixed into it — on both doors
 * since 5.0. Four consumers (the entity pickers, including the Graph picker, and the Facts, Edges and Chrono tab
 * searches) still read `_id`, `name`, `title` and `from` off the hit itself, so every semantic search rendered blank
 * rows with an undefined id, and the chrono tab read the envelope's `chrono` as each entry's type.
 *
 * `recordOf` was private to `recall-grouping.ts` with a second hand copy in the Query tab; it lives here so every
 * consumer reads a hit the same way. It THROWS on a hit without a record rather than returning `{}`: a tolerant reader
 * keeps rendering against either shape and hides the day the server stops sending one — which is exactly how this
 * defect shipped. `RecallHit` has no index signature, so a flat read does not compile.
 */
import type { Observable, Subscription } from 'rxjs';
import type { RecallHit } from '../../core/api.types';

/** The record a hit carries. Throws on a hit that carries none — a changed shape must fail loudly, not render blank. */
export function recordOf(hit: RecallHit): Record<string, unknown> {
  const record = (hit as { record?: unknown }).record;
  if (record === null || typeof record !== 'object' || Array.isArray(record)) {
    throw new Error(`A recall hit of type '${String(hit?.type)}' carries no record — the answer's shape has changed`);
  }
  return record as Record<string, unknown>;
}

/**
 * How an INTERACTIVE search asks — a picker, a tab's search bar, anything the owner types into and waits on (`Q-88`).
 *
 * Owner, 2026-09-27: *"performance is also unbearable"*. Each debounced keystroke ran the full recall, cross-encoder
 * included, 16-25 s on a shared GPU; the rule is that when the owner waits on it, speed wins. So an interactive search
 * skips the reranker, and ONE place says so — a hand-written request is the one that forgets `rerank: false`. The
 * Query tab is not interactive in this sense: it is where a caller tests the request an agent will send, so it keeps
 * the default and its own control.
 */
export function interactiveRecallBody(
  query: string,
  type: RecallHit['type'],
  topK: number,
): { query: string; types: RecallHit['type'][]; topK: number; rerank: false } {
  return { query, types: [type], topK, rerank: false };
}

/**
 * Latest wins for a search bar (`Q-88`): starting a search cancels the one before it, so a slow answer to an earlier
 * keystroke can never overwrite the answer to a later one — and the cancelled request stops, rather than finishing
 * for nobody. The picker has this through `switchMap`; the tab bars fired each search and applied whatever came back.
 */
export class LatestWins {
  private sub?: Subscription;
  private timer?: ReturnType<typeof setTimeout>;

  /** Run `search` once typing pauses for `ms` — a new keystroke restarts the wait, as each tab bar did by hand. */
  after(ms: number, search: () => void): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = undefined; search(); }, ms);
  }

  run<T>(source: Observable<T>, apply: (value: T) => void): void {
    this.sub?.unsubscribe();
    this.sub = source.subscribe(apply);
  }

  /** Drop the pending wait and the search in flight — the bar was cleared. */
  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.sub?.unsubscribe();
    this.sub = undefined;
  }
}

/** How long a tab search bar waits for typing to pause before it searches. */
export const INTERACTIVE_DEBOUNCE_MS = 300;

/** A string field of a hit's record, or `undefined`. */
export function recordString(hit: RecallHit, field: string): string | undefined {
  const v = recordOf(hit)[field];
  return typeof v === 'string' ? v : undefined;
}
