/**
 * FactsTabComponent — the facts create/edit/delete/load behaviour, relocated here from
 * brain.component.records.spec.ts (A17.9b-6b) when the tab became its own component (A17.9b-6d), plus
 * the new self-loading + `mutated` output wiring the split introduced.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import type { Fact } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordListState } from './record-list-state.service';
import { FactsTabComponent } from './facts-tab.component';
import { isOnPush } from '../../testing/onpush';
import { noRecordFilter } from './record-tab-base';

const api = {
  listFacts: vi.fn(() => of({ facts: [] as Fact[] })),
  getEntitiesByIds: vi.fn(() => of({ entities: [] })),
  createMemory: vi.fn(() => of({ _id: 'new' } as Fact)),
  updateFact: vi.fn((_s: string, id: string) => of({ _id: id, fact: 'UPDATED' } as Fact)),
  deleteFact: vi.fn(() => of({})),
  recallBrain: vi.fn(() => of({ results: [], count: 0 })),
};

function make() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [FactsTabComponent, getTranslocoModule()],
    providers: [
      RecordListState, BrainStore, EntityRefPicker, RecordDrawerState,
      { provide: BrainApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(FactsTabComponent);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.detectChanges(); // effect → load()
  return fixture;
}

const memory = (fact: string, id = fact): Fact =>
  ({ _id: id, fact, tags: [], entityIds: [], properties: {}, createdAt: '2026-07-14T10:00:00.000Z', seq: 1 } as unknown as Fact);

beforeEach(() => { for (const fn of Object.values(api)) (fn as any).mockClear(); });

describe('FactsTabComponent', () => {
  it('is compiled as OnPush', () => {
    expect(isOnPush(FactsTabComponent)).toBe(true);
  });

  it('self-loads on the spaceId input (sends page size + skip 0 + no filter)', () => {
    make();
    expect(api.listFacts).toHaveBeenCalledWith('work', 20, 0, {}, undefined, undefined);
  });

  // CHARACTERIZATION (pins semantic recall through the 2b-iii-c demotion — the top bar is now
  // semantic-only): typing in the bar must issue recallBrain({types:['fact']}) after the debounce,
  // never the plain list. If a later change routes the top bar through the list endpoint, this fails.
  it('the semantic top bar issues a recall (not a plain list) for memories', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    api.listFacts.mockClear();
    api.recallBrain.mockClear();
    vi.useFakeTimers();
    c.onMemorySearch('deadline');
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    expect(api.recallBrain).toHaveBeenCalledWith('work', { query: 'deadline', types: ['fact'], topK: 20 });
    expect(api.listFacts).not.toHaveBeenCalled();
  });

  // Clearing the semantic bar restores the normal paginated list (a plain list call, no recall).
  it('clearing the semantic bar reloads the plain list', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    api.listFacts.mockClear();
    api.recallBrain.mockClear();
    c.onMemorySearch('');
    expect(api.listFacts).toHaveBeenCalledWith('work', 20, 0, {}, undefined, undefined);
    expect(api.recallBrain).not.toHaveBeenCalled();
  });

  it('renders the create form when opened (plain ngModel model under OnPush)', () => {
    const fixture = make();
    fixture.componentInstance.openMemoryForm();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('form.create-form')).toBeTruthy();
  });

  // Slice 3a: the entity picker is INLINE — an app-entity-search in the form, no click-to-open flyout.
  it('the entity picker is inline in the create form (no chip-add button / flyout panel)', () => {
    const fixture = make();
    fixture.componentInstance.openMemoryForm();
    fixture.detectChanges();
    const form = fixture.nativeElement.querySelector('form.create-form') as HTMLElement;
    expect(form.querySelector('app-entity-search')).toBeTruthy();
    expect(form.querySelector('.chip-add')).toBeNull();
    expect(form.querySelector('.flyout-panel')).toBeNull();
  });

  it('renders a row per memory (signal-driven view updates under OnPush)', () => {
    const fixture = make();
    // set AFTER the initial self-load settles (the effect reruns only on spaceId change)
    fixture.componentInstance.store.facts.set([memory('the sky is blue'), memory('water is wet')]);
    fixture.detectChanges();
    const body = (fixture.nativeElement.querySelector('table tbody') as HTMLElement).textContent ?? '';
    expect(body).toContain('the sky is blue');
    expect(body).toContain('water is wet');
  });

  it('re-renders the list when the facts signal is replaced', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    const body = () => (fixture.nativeElement.querySelector('table tbody') as HTMLElement).textContent ?? '';

    c.store.facts.set([memory('first fact')]);
    fixture.detectChanges();
    expect(body()).toContain('first fact');

    c.store.facts.set([memory('second fact')]);
    fixture.detectChanges();
    expect(body()).toContain('second fact');
    expect(body()).not.toContain('first fact');
  });

  it('createMemory sends fact + only the non-empty optionals (properties raw) and emits mutated', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    const mutated = vi.fn();
    c.mutated.subscribe(mutated);
    c.memoryForm = { fact: '  a fact  ', type: '', tags: ['t'], entityIds: 'e1, , e2', description: ' d ', properties: { k: 'v' } };
    c.createMemory();
    expect(api.createMemory).toHaveBeenCalledWith('work', {
      fact: 'a fact', tags: ['t'], entityIds: ['e1', 'e2'], description: 'd', properties: { k: 'v' },
    });
    expect(mutated).toHaveBeenCalled();
  });

  it('createMemory is a no-op when fact is blank', () => {
    const c = make().componentInstance;
    c.memoryForm = { fact: '   ', type: '', tags: [], entityIds: '', description: '', properties: {} };
    c.createMemory();
    expect(api.createMemory).not.toHaveBeenCalled();
  });

  it('createMemory sends `type` when set, and OMITS it when blank', () => {
    // Both directions matter. Blank must stay ABSENT rather than become "": the server uses `type` to look up
    // `typeSchemas.fact[type]`, so an empty string selects nothing and stores a value no filter offers.
    const f = make();
    const c = f.componentInstance;
    c.memoryForm = { fact: 'f', type: '  decision  ', tags: [], entityIds: '', description: '', properties: {} };
    c.createMemory();
    expect(api.createMemory).toHaveBeenCalledWith('work', { fact: 'f', type: 'decision' });

    api.createMemory.mockClear();
    c.memoryForm = { fact: 'f', type: '   ', tags: [], entityIds: '', description: '', properties: {} };
    c.createMemory();
    expect(api.createMemory).toHaveBeenCalledWith('work', { fact: 'f' });
  });

  it('saveEditMemory sends the full shape, clears editingId, and patches the store list', () => {
    const c = make().componentInstance;
    c.store.facts.set([{ _id: 'm1', fact: 'old' } as Fact]);
    c.recordList.editingId.set('m1');
    c.editMemory = { fact: ' new ', tags: ['t'], entityIds: 'e1', description: ' d ', properties: {} };
    c.saveEditMemory('m1');
    expect(api.updateFact).toHaveBeenCalledWith('work', 'm1', {
      fact: 'new', tags: ['t'], entityIds: ['e1'], description: 'd',
    });
    expect(c.recordList.editingId()).toBe('');
    expect(c.store.facts()[0].fact).toBe('UPDATED');
  });

  it('deleteFact removes from the store, clears confirmDeleteId, and emits mutated', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    const mutated = vi.fn();
    c.mutated.subscribe(mutated);
    c.store.facts.set([{ _id: 'm1' } as Fact, { _id: 'm2' } as Fact]);
    c.recordList.confirmDeleteId.set('m1');
    c.deleteFact('m1');
    expect(api.deleteFact).toHaveBeenCalledWith('work', 'm1');
    expect(c.store.facts().map(m => m._id)).toEqual(['m2']);
    expect(c.recordList.confirmDeleteId()).toBe('');
    expect(mutated).toHaveBeenCalled();
  });

  it('nextPage advances skip by pageSize and reloads; the load sends the active tag/type/entity filter', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    c.recordFilter.set({ ...noRecordFilter(), type: 'note', tag: 'urgent' });
    c.filterEntity.set('e9');
    api.listFacts.mockClear();
    c.nextPage();
    expect(c.skip()).toBe(20);
    expect(api.listFacts).toHaveBeenCalledWith('work', 20, 20, { tag: 'urgent', entity: 'e9', type: 'note' }, undefined, undefined);
    c.prevPage(); c.prevPage(); // clamp at 0
    expect(c.skip()).toBe(0);
  });
});
