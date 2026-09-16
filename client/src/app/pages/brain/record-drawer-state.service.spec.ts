/**
 * RecordDrawerState — the `lastSaved` announcement.
 *
 * `save()` patches the `BrainStore` lists, which is everything the Brain page needs. The Graph page
 * embeds the same drawer but renders its OWN per-node arrays, which the store never sees, so it
 * reads `lastSaved` to patch them. That makes the announcement load-bearing for a consumer in a
 * different folder — exactly the kind of cross-page contract that rots silently: delete the
 * `lastSaved.set` line and the Brain page is entirely unaffected, while the Graph page starts
 * leaving the pre-save row on screen after a successful save, with no error anywhere.
 *
 * Mutation-checked: removing either `lastSaved.set` call below fails this spec.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { aMemory, aChrono } from '../../testing/records';

function makeApi() {
  return {
    getEntitiesByIds: () => of({ entities: [] }),
    getMemory: () => of({}),
    updateFact: (_s: string, id: string, body: any) => of({ _id: id, ...body, updatedAt: 'saved' }),
    updateChrono: (_s: string, id: string, body: any) => of({ _id: id, ...body, updatedAt: 'saved' }),
  } as any;
}

describe('RecordDrawerState — lastSaved', () => {
  function create(): RecordDrawerState {
    TestBed.configureTestingModule({
      providers: [RecordDrawerState, BrainStore, EntityRefPicker, { provide: BrainApi, useValue: makeApi() }],
    });
    const state = TestBed.inject(RecordDrawerState);
    state.spaceId.set('work');
    return state;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('starts with nothing announced', () => {
    expect(create().lastSaved()).toBeNull();
  });

  it('announces the SERVER copy of a saved memory, not the local edit model', () => {
    const state = create();
    state.open('fact', aMemory({ _id: 'm1', fact: 'before' }));
    state.drawerEditMemory.fact = 'after';

    state.save();

    const saved = state.lastSaved();
    expect(saved?.kind).toBe('fact');
    // `DrawerRecord` is discriminated on `kind`, but `expect(...)` is a runtime assertion TypeScript cannot
    // follow — so the narrowing is explicit. A cast would compile and would also accept the wrong member.
    if (saved?.kind !== 'fact') throw new Error('lastSaved did not announce a memory');
    expect(saved.record._id).toBe('m1');
    expect(saved.record.fact).toBe('after');
    // The announced record is what the API returned — a consumer patching its own list with the edit
    // model instead would drop every server-assigned field.
    expect(saved?.record.updatedAt, 'the announced record must be the response, not the edit model').toBe('saved');
  });

  it('announces a saved chrono under its own kind', () => {
    const state = create();
    state.open('chrono', aChrono({ _id: 'c1', title: 'before' }));
    state.drawerEditChrono.title = 'after';

    state.save();

    const saved = state.lastSaved();
    expect(saved?.kind).toBe('chrono');
    // Explicit, for the reason above: `expect` is a runtime assertion the compiler cannot follow.
    if (saved?.kind !== 'chrono') throw new Error('lastSaved did not announce a chrono');
    expect(saved.record.title).toBe('after');
  });

  it('announces nothing when the save fails', () => {
    const state = create();
    state.open('fact', aMemory({ _id: 'm1', fact: 'before' }));
    // A failing save must not announce: a consumer would otherwise patch its list with a record the
    // server rejected, showing the edit as persisted.
    (TestBed.inject(BrainApi) as any).updateFact = () => ({
      subscribe: (h: any) => h.error({ error: { error: 'nope' } }),
    });

    state.save();

    expect(state.lastSaved()).toBeNull();
    expect(state.drawerError()).toBeTruthy();
  });
});
