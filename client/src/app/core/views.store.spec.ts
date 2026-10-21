/**
 * The ViewsStore holds the caller's own personal views as a signal, and `isView` is answered from it (Q-531, bundle-100, plan rev 3.2
 * "Client": "ViewsStore (signals) on the client feeds My views and the Brain page; isView derives from it").
 *
 * ## The rules
 *
 * - `load()` reads `GET /api/views` and `views()` then holds exactly the views answered (ids and members as sent).
 * - `isView(id)` is true for the id of a loaded view, false for a space id, and false for an `@` id the store does not hold: a
 *   view is a thing the caller owns, never a spelling. Answering by the `@` prefix would treat another token's view id, or a stale
 *   one, as a view the page can open.
 * - A second `load()` replaces the list (a deleted view leaves it).
 *
 * ## Seen red at 18e8d598
 *
 * `core/views.store.ts` does not exist: every case fails at its import.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { VIEW_LENS, VIEW_EMPTY, flushViews, importNew } from '../testing/personal-views';

type Store = { views: () => { id: string; members: string[] }[]; load: () => unknown; isView: (id: string) => boolean };

async function makeStore(): Promise<{ store: Store; http: HttpTestingController }> {
  const { ViewsStore } = await importNew<{ ViewsStore: new (...a: unknown[]) => Store }>('../core/views.store');
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { store: TestBed.inject(ViewsStore as never) as Store, http: TestBed.inject(HttpTestingController) };
}

describe('ViewsStore (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => { try { TestBed.inject(HttpTestingController).verify(); } catch { /* the store was never made */ } });

  it('load() holds exactly the views GET /api/views answered', async () => {
    const { store, http } = await makeStore();
    store.load();
    expect(flushViews(http, [VIEW_LENS, VIEW_EMPTY]), 'load() did not ask GET /api/views').toBe(1);
    expect(store.views().map(v => v.id)).toEqual(['@lens', '@empty']);
    expect(store.views()[0]!.members).toEqual(['qa', 'ops', 'gone']);
  });

  it('isView: a loaded view yes; a space id no; an @ id the store does not hold no', async () => {
    const { store, http } = await makeStore();
    store.load();
    flushViews(http, [VIEW_LENS]);
    expect(store.isView('@lens')).toBe(true);
    expect(store.isView('qa')).toBe(false);
    expect(store.isView('@theirs'), 'isView answered by the @ prefix, not by the views the caller owns').toBe(false);
  });

  it('a second load() replaces the list', async () => {
    const { store, http } = await makeStore();
    store.load();
    flushViews(http, [VIEW_LENS, VIEW_EMPTY]);
    store.load();
    flushViews(http, [VIEW_EMPTY]);
    expect(store.views().map(v => v.id)).toEqual(['@empty']);
    expect(store.isView('@lens')).toBe(false);
  });
});
