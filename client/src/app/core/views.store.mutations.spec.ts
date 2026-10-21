/**
 * The ViewsStore's writes keep its list true to what the server did, and a failed read never empties it (Q-531, plan rev 3.2 "Client").
 *
 * ## The rules
 *
 * - `create` posts `{ name, members }` and the store then holds the view the server ANSWERED (its id, its `readable`), not the one asked for.
 * - `rename` patches `/api/views/%40name` (an id begins with `@`, so it is URL-encoded in a path) and the renamed view replaces the old one in
 *   place, so the list keeps its order and `isView` follows the new id.
 * - `remove` deletes and the view leaves the list; a refused delete leaves it.
 * - A failed `load()` says so (`loadFailed`) and is still `loaded`: an `@` link must not wait for ever on a list that is not coming, and the
 *   views already held stay (an empty list would read as "you have none").
 * - Asking `isView` needs no HTTP client: every write control on the Brain and Files pages asks it, in hundreds of specs that provide none.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ViewsStore } from './views.store';
import { VIEW_LENS, VIEW_EMPTY, flushViews } from '../testing/personal-views';

function setup() {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  return { store: TestBed.inject(ViewsStore), http: TestBed.inject(HttpTestingController) };
}

describe('ViewsStore writes (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => { try { TestBed.inject(HttpTestingController).verify(); } catch { /* never made */ } });

  it('create posts the name and members and holds the view the server answered', () => {
    const { store, http } = setup();
    store.create({ name: 'lens', members: ['qa', 'ops', 'gone'] }).subscribe();
    const req = http.expectOne(r => r.method === 'POST' && r.url === '/api/views');
    expect(req.request.body).toEqual({ name: 'lens', members: ['qa', 'ops', 'gone'] });
    req.flush({ view: VIEW_LENS });
    expect(store.views().map(v => v.id)).toEqual(['@lens']);
    expect(store.views()[0]!.readable).toEqual(['qa', 'ops']);
    expect(store.isView('@lens')).toBe(true);
  });

  it('create with every space the caller reads sends the wildcard', () => {
    const { store, http } = setup();
    // The server's shape, a list (`view-members-contract.spec` parses it against the server's schema); a bare '*' is refused there.
    store.create({ name: 'all', members: ['*'] }).subscribe();
    expect(http.expectOne('/api/views').request.body).toEqual({ name: 'all', members: ['*'] });
  });

  it('rename patches the encoded id and replaces the view in place', () => {
    const { store, http } = setup();
    store.load();
    flushViews(http, [VIEW_LENS, VIEW_EMPTY]);
    store.rename('@lens', 'lens2').subscribe();
    const req = http.expectOne(r => r.method === 'PATCH' && r.url === '/api/views/%40lens');
    expect(req.request.body).toEqual({ name: 'lens2' });
    req.flush({ view: { ...VIEW_LENS, id: '@lens2', name: 'lens2' } });
    expect(store.views().map(v => v.id), 'order kept').toEqual(['@lens2', '@empty']);
    expect(store.isView('@lens')).toBe(false);
    expect(store.isView('@lens2')).toBe(true);
  });

  it('remove deletes the encoded id and drops the view; a refused delete keeps it', () => {
    const { store, http } = setup();
    store.load();
    flushViews(http, [VIEW_LENS, VIEW_EMPTY]);
    let failed = false;
    store.remove('@empty').subscribe({ error: () => { failed = true; } });
    http.expectOne(r => r.method === 'DELETE' && r.url === '/api/views/%40empty').flush({ code: 'view_not_found' }, { status: 404, statusText: 'Not Found' });
    expect(failed).toBe(true);
    expect(store.views().map(v => v.id)).toEqual(['@lens', '@empty']);

    store.remove('@empty').subscribe();
    http.expectOne(r => r.method === 'DELETE' && r.url === '/api/views/%40empty').flush(null, { status: 204, statusText: 'No Content' });
    expect(store.views().map(v => v.id)).toEqual(['@lens']);
  });

  it('a failed load says so, is still loaded, and keeps the views already held', () => {
    const { store, http } = setup();
    store.load();
    flushViews(http, [VIEW_LENS]);
    expect(store.loadFailed()).toBe(false);
    store.load();
    http.expectOne('/api/views').flush({ error: 'down' }, { status: 503, statusText: 'Unavailable' });
    expect(store.loadFailed()).toBe(true);
    expect(store.loaded()).toBe(true);
    expect(store.views().map(v => v.id)).toEqual(['@lens']);
  });

  it('is not loaded until a list has been answered, and a store never asked needs no HTTP client', () => {
    TestBed.configureTestingModule({});
    const store = TestBed.inject(ViewsStore);
    expect(store.loaded()).toBe(false);
    expect(store.isView('@lens')).toBe(false);
    expect(store.views()).toEqual([]);
  });
});
