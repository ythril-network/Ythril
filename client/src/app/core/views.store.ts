import { DestroyRef, Injectable, Injector, computed, inject, signal, type Signal } from '@angular/core';
import { Observable, map, tap } from 'rxjs';
import { LatestWins } from './latest-wins';
import { ViewsApi, type PersonalView, type ViewCreateBody } from './views-api.service';

/**
 * The caller's own personal views, held once for every page that shows one (Q-531, plan rev 3.2 "Client").
 *
 * ## What it answers, and the one rule inside it
 *
 * `isView(id)` is true for the id of a view this store HOLDS and for nothing else. It never answers by the `@` prefix: another token's view
 * id, or the id of a view deleted a minute ago, begins with `@` too, and a page that treated it as openable would draw controls for
 * something the server answers as a space that does not exist. A page asks the store, so there is one place that decides, and the Brain
 * page's single `isView` flag (which every write control asks) derives from it.
 *
 * `loaded` is what lets a page tell "this id is not a view of mine" from "the list has not arrived": an `@` id in a link waits for it, and
 * a plain space id never does.
 */
@Injectable({ providedIn: 'root' })
export class ViewsStore {
  /**
   * The doors are reached when a request is made, not when the store is created. Every write control on the Brain and Files pages asks
   * `isView`, so this store is constructed wherever one of them is; none of them should need an HTTP client to answer "no view held".
   * The shell loads the list once and every page reads it.
   */
  private readonly injector = inject(Injector);
  private get api(): ViewsApi { return this.injector.get(ViewsApi); }
  private readonly slot = new LatestWins(inject(DestroyRef));

  /** The views in the order the server listed them. */
  readonly views = signal<readonly PersonalView[]>([]);
  /** True once a list has been answered (or has failed): until then an empty `views()` means nothing. */
  readonly loaded = signal(false);
  /** True when the last list request failed; the views shown are then the ones held before it. */
  readonly loadFailed = signal(false);
  /** The ids, for a page that asks "is this one of mine" many times. */
  private readonly ids = computed(() => new Set(this.views().map(v => v.id)));

  /** Read `GET /api/views`; the answer replaces the list. A newer call supersedes an older one still in flight. */
  load(): void {
    this.slot.run(this.api.list(), {
      next: ({ views }) => { this.views.set(views); this.loadFailed.set(false); this.loaded.set(true); },
      error: () => { this.loadFailed.set(true); this.loaded.set(true); },
    });
  }

  isView(id: string): boolean { return this.ids().has(id); }

  byId(id: string): PersonalView | undefined { return this.views().find(v => v.id === id); }

  create(body: ViewCreateBody): Observable<PersonalView> {
    return this.api.create(body).pipe(
      map(({ view }) => view),
      tap(view => this.views.update(list => [...list.filter(v => v.id !== view.id), view])),
    );
  }

  rename(id: string, name: string): Observable<PersonalView> {
    return this.api.rename(id, name).pipe(
      map(({ view }) => view),
      tap(view => this.views.update(list => list.map(v => v.id === id ? view : v))),
    );
  }

  remove(id: string): Observable<unknown> {
    return this.api.remove(id).pipe(tap(() => this.views.update(list => list.filter(v => v.id !== id))));
  }
}

/**
 * The ONE flag every write control asks: is the space this component works in a personal view of the caller's?
 *
 * A view never writes (the server answers a write to one as a space that does not exist, with a hint), so a control that offers the write
 * anyway invites a form that can only be refused. What a hand-written `isView` in each tab would drop is the reactivity: a flag read once at
 * creation goes stale when the space switches under the component, and the write controls would reappear. This reads `spaceId()` inside a
 * `computed`, so it follows the switch. `every-write-control-asks-is-view.spec.ts` holds every component that renders a write to it.
 *
 * Call it in an injection context (a field initialiser); `spaceId` is the component's own space id, read lazily.
 */
export function injectIsView(spaceId: () => string): Signal<boolean> {
  const views = inject(ViewsStore);
  return computed(() => views.isView(spaceId()));
}
