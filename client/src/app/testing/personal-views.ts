/**
 * What the client specs of Q-531 (bundle-100, plan rev 3.2 "Client") fix about personal views, in one place.
 *
 * ## The contract, written before the implementation
 *
 * - **`ViewsStore`** (`core/views.store.ts`, `providedIn: 'root'`): the caller's own views as a signal `views()`, loaded from
 *   `GET /api/views` (answered `{ views: [...] }`) by `load()`, and `isView(id)`: true for an id of a loaded view, false for a space id
 *   and for an `@` id it does not hold. The Brain page's My views and its space resolution read it; the page's one `isView` flag
 *   derives from it.
 * - **A view as the list answers it**: `{ id: '@name', name, members, readable }` - `readable` is the members the caller can read NOW
 *   (view_get's "which of them the caller reads now"), so the page can say what a view reads and name what it dropped.
 * - **`ViewCreateDialogComponent`** (`pages/brain/view-create-dialog.component.ts`): the create dialog, given `spaces` (the spaces the
 *   caller reads) as an input; its member picker is one checkbox per space.
 * - **`TokenViewCopyComponent`** (`pages/settings/token-view-copy.component.ts`, selector `app-token-view-copy`): the Settings > Tokens
 *   control "Copy views to this token", inputs `targetTokenId` and `mayManage` (the same guard as managing that token); it renders
 *   nothing without `mayManage`, copies with `POST /api/views/:id/copy {toTokenId}`, and shows the name a collision gave the copy
 *   (the answer's `view.id` differs from the source's).
 * - **Retired ids** reach the client on the space list: `GET /api/spaces` answers `retiredSpaceIds` (to an admin), and the join and
 *   create dialogs check a chosen id against them before submit.
 * - **Words**: "personal view" (en), "persönliche Sicht" (de), "widok osobisty" (pl); a config panel on a view says
 *   "Not available for a personal view".
 *
 * A module the change creates is imported through {@link importNew}, so a spec whose subject does not exist yet fails in the test that
 * needs it - with the missing path in its message - instead of failing the whole file at collection.
 */
import { resolve } from 'node:path';
import type { HttpTestingController } from '@angular/common/http/testing';

/** A view of three members, one of which the caller can no longer read. */
export const VIEW_LENS = Object.freeze({ id: '@lens', name: 'lens', members: ['qa', 'ops', 'gone'], readable: ['qa', 'ops'] });
/** A view none of whose members the caller can read now. */
export const VIEW_EMPTY = Object.freeze({ id: '@empty', name: 'empty', members: ['gone'], readable: [] as string[] });

export const PERSONAL_VIEW_WORD = Object.freeze({ en: 'personal view', de: 'persönliche Sicht', pl: 'widok osobisty' });
export const NOT_FOR_A_VIEW = 'Not available for a personal view';

/** Answer every pending `GET /api/views` with `views`; answers how many it flushed. */
export function flushViews(http: HttpTestingController, views: readonly object[]): number {
  const pending = http.match(r => r.method === 'GET' && /\/api\/views\/?(?:\?.*)?$/.test(r.urlWithParams));
  for (const r of pending) r.flush({ views });
  return pending.length;
}

/**
 * Import a module the change is to create, by a path relative to THIS directory (`src/app/testing`). Resolved at run time, so its
 * absence is one test's failure: "Failed to load ... views.store".
 */
export function importNew<T = Record<string, unknown>>(pathFromTesting: string): Promise<T> {
  // Absolute: a run-time specifier is not resolved against the importing file, so a relative one would name nothing.
  const absolute = resolve(__dirname, pathFromTesting).replace(/\\/g, '/');
  return import(/* @vite-ignore */ absolute) as Promise<T>;
}
