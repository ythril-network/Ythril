/**
 * SpacesStore — the index-status poll chain (`Q-113`).
 *
 * A space that is `building` has no semantic search yet, and the operator's page has to notice when it
 * finishes without a reload. Before `Q-113` the poll was started only by the create dialog, capped at 40
 * attempts (~2 min), and a SECOND call stacked a second chain. A search service that is late by more than two
 * minutes (a space marked `indexWaiting`) therefore left the badge saying "building" for ever.
 *
 * What these pin, all through the store's public surface and the API's call count (never a sleep):
 *  - `load()` itself starts the chain whenever any space is building, and never a second one
 *  - the chain dies with the store, pauses while the tab is hidden, and has no attempt cap
 *  - the cadence is 3 s while a true build is in flight and 30 s when every building space is only waiting
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { of } from 'rxjs';
import { NetworksApi } from '../../core/networks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import type { Space } from '../../core/api.types';
import { SpacesStore } from './spaces-store.service';

const space = (id: string, over: Partial<Space> = {}): Space => ({ id, label: id, ...over } as Space);
const BUILDING = (id = 'b') => space(id, { indexStatus: 'building' });
const WAITING = (id = 'w') => space(id, { indexStatus: 'building', indexWaiting: true, indexWaitingSince: '2026-09-30T10:00:00.000Z' });
const READY = (id = 'r') => space(id, { indexStatus: 'ready' });

const FAST_MS = 3_000;
const SLOW_MS = 30_000;

function make(initial: Space[]) {
  let current = initial;
  const listSpaces = vi.fn(() => of({ spaces: current }));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      SpacesStore,
      { provide: SpacesApi, useValue: { listSpaces, reorderSpaces: () => of({ spaces: [] }) } },
      { provide: NetworksApi, useValue: { listNetworks: () => of({ networks: [] }) } },
    ],
  });
  return {
    store: TestBed.inject(SpacesStore),
    listSpaces,
    /** What the server answers from now on. */
    serve: (next: Space[]) => { current = next; },
  };
}

function setHidden(hidden: boolean) {
  Object.defineProperty(document, 'hidden', { configurable: true, get: () => hidden });
}

describe('SpacesStore — index poll chain', () => {
  beforeEach(() => { vi.useFakeTimers(); setHidden(false); });
  afterEach(() => { vi.useRealTimers(); setHidden(false); });

  it('load() starts the chain by itself when a space is building, with no caller asking', () => {
    const { store, listSpaces } = make([BUILDING()]);
    store.load();
    const afterLoad = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoad + 1);
  });

  it('starts no chain when nothing is building, and a chain stops once nothing is', () => {
    const quiet = make([READY()]);
    quiet.store.load();
    const afterLoad = quiet.listSpaces.mock.calls.length;
    vi.advanceTimersByTime(10 * SLOW_MS);
    expect(quiet.listSpaces).toHaveBeenCalledTimes(afterLoad);

    const { store, listSpaces, serve } = make([BUILDING()]);
    store.load();
    serve([READY('b')]);
    vi.advanceTimersByTime(FAST_MS);                  // the tick that learns it is done
    const afterDone = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(10 * SLOW_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterDone);
    expect(store.spaces()[0].indexStatus).toBe('ready');
  });

  it('repeated load() calls never stack a second chain', () => {
    const { store, listSpaces } = make([BUILDING()]);
    store.load(); store.load(); store.load();
    const afterLoads = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoads + 1);   // one chain = one tick per interval
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoads + 2);
  });

  it('pollIndexStatus() on top of a running chain does not stack one either (the create dialog calls it)', () => {
    const { store, listSpaces } = make([BUILDING()]);
    store.load();
    store.pollIndexStatus();
    store.pollIndexStatus();
    const before = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(before + 1);
  });

  it('has no attempt cap: a build still running after a hundred ticks is still being watched', () => {
    const { store, listSpaces } = make([BUILDING()]);
    store.load();
    const afterLoad = listSpaces.mock.calls.length;
    for (let i = 0; i < 100; i++) vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoad + 100);
  });

  it('is cancelled when the store is destroyed', () => {
    const { store, listSpaces } = make([BUILDING()]);
    store.load();
    const afterLoad = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoad + 1);   // the chain was alive, so stopping it is a fact
    const before = listSpaces.mock.calls.length;
    TestBed.resetTestingModule();                      // destroys the injector, and with it the store
    vi.advanceTimersByTime(20 * FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(before);
  });

  it('skips its tick while the tab is hidden, and carries on when it is visible again', () => {
    const { store, listSpaces } = make([BUILDING()]);
    store.load();
    setHidden(true);
    const before = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(5 * FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(before);
    setHidden(false);
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(before + 1);
  });

  it('polls every 3 s while any space is truly building, even beside a waiting one', () => {
    const { store, listSpaces } = make([WAITING(), BUILDING()]);
    store.load();
    const afterLoad = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoad + 1);
  });

  it('polls every 30 s when every building space is only waiting for the search service', () => {
    const { store, listSpaces } = make([WAITING('w1'), WAITING('w2'), READY()]);
    store.load();
    const afterLoad = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(SLOW_MS - 1);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoad);
    vi.advanceTimersByTime(1);
    expect(listSpaces).toHaveBeenCalledTimes(afterLoad + 1);
  });

  it('re-reads the cadence from each answer: a waiting space slows the chain, a true build speeds it up', () => {
    const { store, listSpaces, serve } = make([BUILDING()]);
    store.load();
    serve([WAITING('b')]);
    vi.advanceTimersByTime(FAST_MS);                   // learns the space is now only waiting
    const afterSlowdown = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(SLOW_MS - 1);
    expect(listSpaces).toHaveBeenCalledTimes(afterSlowdown);
    serve([BUILDING('b')]);
    vi.advanceTimersByTime(1);                         // the 30 s tick lands and sees a true build
    const afterSpeedup = listSpaces.mock.calls.length;
    vi.advanceTimersByTime(FAST_MS);
    expect(listSpaces).toHaveBeenCalledTimes(afterSpeedup + 1);
  });
});
