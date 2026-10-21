import { effect, untracked, type Injector } from '@angular/core';

/**
 * What a `?space=` in a link asks a page to open, and what the page must say when it cannot (Q-531, plan rev 3.2 "Client": "an id not in
 * the list shows a notice instead of silently falling back (fixes the existing silent fallback too)").
 *
 * ## Why it is one function
 *
 * The Brain, Graph and Files pages each read `?space=` and each fell back to the first space when the id was not in their list: a bookmark to
 * a deleted space, a typo, or since 6.0 a former proxy id or another token's view opened SOMETHING ELSE and said nothing, so a reader took
 * the first space's records for the ones they had asked for. Three hand-written fallbacks are three places to forget the notice, so the
 * answer is given here with the notice built in: `unknown` is a value the page cannot ignore without writing the line that ignores it.
 *
 * An id is OPENABLE when it is a space of the list, or an own view the store holds. A view id waits for the views list (`wait`): until it
 * has arrived, "not one of my views" cannot be told from "not loaded yet", and answering `unknown` early would show a notice for a link that
 * is about to work. A plain space id never waits.
 */
export type SpaceParam =
  /** No `?space=`: no preference, whatever is open stays open. */
  | { kind: 'none' }
  /** An id of the list, or an own view: open it. */
  | { kind: 'open'; id: string }
  /** An `@` id while the views list has not arrived: decide when it has. */
  | { kind: 'wait' }
  /** An id that is neither: say so, naming it, and open the page's default. */
  | { kind: 'unknown'; id: string };

/** The part of the views store this question needs. */
export interface OwnViews {
  loaded(): boolean;
  isView(id: string): boolean;
}

export function readSpaceParam(wanted: string | null | undefined, spaceIds: readonly string[], views: OwnViews): SpaceParam {
  if (!wanted) return { kind: 'none' };
  if (spaceIds.includes(wanted)) return { kind: 'open', id: wanted };
  if (!wanted.startsWith('@')) return { kind: 'unknown', id: wanted };
  if (!views.loaded()) return { kind: 'wait' };
  return views.isView(wanted) ? { kind: 'open', id: wanted } : { kind: 'unknown', id: wanted };
}

/**
 * The same question for a page that opens ONCE from its link (the standalone Graph and Files pages): wait for the views list when the link
 * names a view, then say what to open. `open` is told the id the link asked for when it is openable (otherwise `''`, and the page opens its
 * default) and the id it asked for when it was neither a space nor an own view (`unknown`, or null), which the page shows with
 * `app-unknown-space-notice`. The Brain page, which keeps re-reading its link, asks {@link readSpaceParam} itself.
 */
export function openSpaceFromLink(
  wanted: string | null | undefined,
  spaceIds: readonly string[],
  views: OwnViews,
  injector: Injector,
  open: (id: string, unknown: string | null) => void,
): void {
  const decide = (): void => {
    const asked = readSpaceParam(wanted, spaceIds, views);
    open(asked.kind === 'open' ? asked.id : '', asked.kind === 'unknown' ? asked.id : null);
  };
  if (!(wanted ?? '').startsWith('@') || views.loaded()) { decide(); return; }
  const ref = effect(() => { if (views.loaded()) { ref.destroy(); untracked(decide); } }, { injector });
}
