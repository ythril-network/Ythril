/**
 * What a `?space=` asks a page to open, and when it must be said that it cannot (Q-531, plan rev 3.2 "Client": "an id not in the list shows a
 * notice instead of silently falling back").
 *
 * ## The rules
 *
 * 1. No `?space=` is no preference; a space of the list opens; an `@` id the views store holds opens.
 * 2. Anything else is `unknown`, and the answer carries the id, so a page cannot ignore the notice without writing the line that ignores it.
 * 3. An `@` id waits for the views list: until it has arrived "not one of mine" cannot be told from "not loaded yet", and answering `unknown`
 *    early would show a notice for a link that is about to work. A plain space id never waits.
 * 4. A page that opens once from its link (`openSpaceFromLink`) is told the same answer exactly once, after the wait.
 */
import { TestBed } from '@angular/core/testing';
import { Injector, signal } from '@angular/core';
import { describe, it, expect, beforeEach } from 'vitest';
import { openSpaceFromLink, readSpaceParam } from './space-param';

/** A views store reduced to what the question asks: the signal a page's effect can follow, and the ids held. */
function views(held: string[], loaded: boolean) {
  const isLoaded = signal(loaded);
  return { isLoaded, store: { loaded: () => isLoaded(), isView: (id: string) => held.includes(id) } };
}

describe('readSpaceParam', () => {
  const spaces = ['qa', 'ops'];

  it('no parameter is no preference', () => {
    expect(readSpaceParam(null, spaces, views([], true).store)).toEqual({ kind: 'none' });
    expect(readSpaceParam('', spaces, views([], true).store)).toEqual({ kind: 'none' });
  });

  it('a space of the list, or an own view, opens', () => {
    const { store } = views(['@lens'], true);
    expect(readSpaceParam('ops', spaces, store)).toEqual({ kind: 'open', id: 'ops' });
    expect(readSpaceParam('@lens', spaces, store)).toEqual({ kind: 'open', id: '@lens' });
  });

  it('an id that is neither is unknown and says which', () => {
    const { store } = views(['@lens'], true);
    expect(readSpaceParam('ghost', spaces, store)).toEqual({ kind: 'unknown', id: 'ghost' });
    expect(readSpaceParam('@theirs', spaces, store)).toEqual({ kind: 'unknown', id: '@theirs' });
  });

  it('a former proxy id is unknown, not silently the first space', () => {
    // The old proxy `team` is no space and no view of the caller's: the page used to land on `qa` and say nothing.
    expect(readSpaceParam('team', spaces, views(['@team'], true).store)).toEqual({ kind: 'unknown', id: 'team' });
  });

  it('an @ id waits for the views list, and a plain space id never does', () => {
    const { store } = views(['@lens'], false);
    expect(readSpaceParam('@lens', spaces, store)).toEqual({ kind: 'wait' });
    expect(readSpaceParam('ghost', spaces, store)).toEqual({ kind: 'unknown', id: 'ghost' });
    expect(readSpaceParam('qa', spaces, store)).toEqual({ kind: 'open', id: 'qa' });
  });
});

describe('openSpaceFromLink', () => {
  beforeEach(() => TestBed.resetTestingModule());

  const ask = (wanted: string, v: ReturnType<typeof views>) => {
    const told: [string, string | null][] = [];
    TestBed.runInInjectionContext(() => openSpaceFromLink(wanted, ['qa', 'ops'], v.store, TestBed.inject(Injector), (id, unknown) => told.push([id, unknown])));
    return told;
  };

  it('a plain link is answered at once', () => {
    expect(ask('ops', views([], false))).toEqual([['ops', null]]);
    expect(ask('ghost', views([], false))).toEqual([['', 'ghost']]);
    expect(ask('', views([], false))).toEqual([['', null]]);
  });

  it('a link to a view is answered once, after the views list arrives', () => {
    const v = views(['@lens'], false);
    const told = ask('@lens', v);
    expect(told).toEqual([]);
    v.isLoaded.set(true);
    TestBed.tick();
    expect(told).toEqual([['@lens', null]]);
    TestBed.tick();
    expect(told, 'the page was told twice').toHaveLength(1);
  });

  it('a link to a view the caller does not hold is unknown once the list has arrived', () => {
    const v = views([], false);
    const told = ask('@theirs', v);
    v.isLoaded.set(true);
    TestBed.tick();
    expect(told).toEqual([['', '@theirs']]);
  });

  it('a link to a view is answered at once when the list is already there', () => {
    expect(ask('@lens', views(['@lens'], true))).toEqual([['@lens', null]]);
  });
});
