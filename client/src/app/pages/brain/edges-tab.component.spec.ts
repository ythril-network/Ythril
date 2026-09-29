/**
 * EdgesTabComponent — edge create/edit/delete/load behaviour, relocated from
 * brain.component.records.spec.ts (A17.9b-6b) when the tab became its own component (A17.9b-6f), plus
 * the self-loading wiring. Edge deltas: create/edit strip empty optional props; delete does NOT refresh
 * stats, so it does NOT emit `mutated` (asymmetry with memory/entity).
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import type { Edge } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordListState } from './record-list-state.service';
import { EdgesTabComponent } from './edges-tab.component';
import { isOnPush } from '../../testing/onpush';

const api = {
  listEdges: vi.fn(() => of({ edges: [] as Edge[] })),
  getEntitiesByIds: vi.fn(() => of({ entities: [] })),
  createEdge: vi.fn(() => of({ _id: 'new' } as Edge)),
  updateEdge: vi.fn((_s: string, id: string) => of({ _id: id, label: 'UPDATED' } as Edge)),
  deleteEdge: vi.fn(() => of({})),
  recallBrain: vi.fn(() => of({ results: [], count: 0 })),
};

function make() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [EdgesTabComponent, getTranslocoModule()],
    providers: [
      RecordListState, BrainStore, EntityRefPicker, RecordDrawerState,
      { provide: BrainApi, useValue: api },
    ],
  });
  const fixture = TestBed.createComponent(EdgesTabComponent);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.detectChanges();
  return fixture;
}

beforeEach(() => { for (const fn of Object.values(api)) (fn as any).mockClear(); });

describe('EdgesTabComponent', () => {
  it('is compiled as OnPush', () => {
    expect(isOnPush(EdgesTabComponent)).toBe(true);
  });

  it('self-loads on the spaceId input', () => {
    make();
    expect(api.listEdges).toHaveBeenCalledWith('work', 20, 0, {}, undefined, undefined);
  });

  // CHARACTERIZATION (pins semantic recall through the 2b-iii-c demotion — the top bar is now
  // semantic-only): typing in the bar must hit recallBrain({types:['edge']}) after the debounce, NOT
  // the plain list. If a later change routes the top bar through the list endpoint, this fails loudly.
  it('the semantic top bar issues a recall (not a plain list) for edges', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    api.listEdges.mockClear();
    api.recallBrain.mockClear();
    vi.useFakeTimers();
    c.onEdgeSearch('mentor');
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    // rerank: false — a search bar the owner types into skips the cross-encoder (Q-88).
    expect(api.recallBrain).toHaveBeenCalledWith('work', { query: 'mentor', types: ['edge'], topK: 20, rerank: false });
    expect(api.listEdges).not.toHaveBeenCalled();
  });

  // Q-87: the hit carries the edge as `record`; reading its fields off the envelope rendered blank rows.
  it('a semantic hit renders the edge it carries, not the envelope around it', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    api.recallBrain.mockReturnValueOnce(of({ count: 1, results: [{
      type: 'edge', score: 0.8, spaceId: 'work',
      record: { _id: 'e1', from: 'a', fromName: 'Ada', to: 'b', toName: 'Babbage', label: 'mentored_by', tags: [], properties: {}, createdAt: '2026-09-01T00:00:00Z' },
    }] } as never));
    vi.useFakeTimers();
    c.onEdgeSearch('mentor');
    vi.advanceTimersByTime(300);
    vi.useRealTimers();
    const rows = TestBed.inject(BrainStore).edges();
    expect(rows.map(r => [r._id, r.from, r.label, r.toName])).toEqual([['e1', 'a', 'mentored_by', 'Babbage']]);
  });

  // Clearing the semantic bar restores the normal paginated list (a plain list call, no recall).
  it('clearing the semantic bar reloads the plain list', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    api.listEdges.mockClear();
    api.recallBrain.mockClear();
    c.onEdgeSearch('');
    expect(api.listEdges).toHaveBeenCalledWith('work', 20, 0, {}, undefined, undefined);
    expect(api.recallBrain).not.toHaveBeenCalled();
  });

  it('createEdge requires from+to+label, spreads weight only when set, and emits mutated', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    const mutated = vi.fn();
    c.mutated.subscribe(mutated);
    c.edgeForm = { from: 'a', fromDisplay: '', to: 'b', toDisplay: '', label: 'knows', weight: null, tags: [], description: '', properties: {} };
    c.createEdge();
    expect(api.createEdge).toHaveBeenCalledWith('work', { from: 'a', to: 'b', label: 'knows' });
    expect(mutated).toHaveBeenCalled();
  });

  it('createEdge is a no-op when from/to/label are incomplete', () => {
    const c = make().componentInstance;
    c.edgeForm = { from: 'a', fromDisplay: '', to: '', toDisplay: '', label: 'knows', weight: null, tags: [], description: '', properties: {} };
    c.createEdge();
    expect(api.createEdge).not.toHaveBeenCalled();
  });

  it('saveEditEdge sends label/tags/description (+weight when set), clears editingId, patches store', () => {
    const c = make().componentInstance;
    c.store.edges.set([{ _id: 'x1', label: 'old' } as Edge]);
    c.recordList.editingId.set('x1');
    c.editEdge = { from: 'a', to: 'b', fromName: undefined, toName: undefined, label: ' knows ', weight: 0.5, tags: ['t'], description: ' d ', properties: {} };
    c.saveEditEdge('x1');
    expect(api.updateEdge).toHaveBeenCalledWith('work', 'x1', { label: 'knows', tags: ['t'], description: 'd', weight: 0.5 });
    expect(c.recordList.editingId()).toBe('');
    expect(c.store.edges()[0].label).toBe('UPDATED');
  });

  it('deleteEdge removes from the store and clears confirmDeleteId but does NOT emit mutated (no stats refresh)', () => {
    const fixture = make();
    const c = fixture.componentInstance;
    const mutated = vi.fn();
    c.mutated.subscribe(mutated);
    c.store.edges.set([{ _id: 'x1' } as Edge, { _id: 'x2' } as Edge]);
    c.recordList.confirmDeleteId.set('x1');
    c.deleteEdge('x1');
    expect(c.store.edges().map(e => e._id)).toEqual(['x2']);
    expect(c.recordList.confirmDeleteId()).toBe('');
    expect(mutated).not.toHaveBeenCalled(); // the asymmetry
  });

  it('pickEdgeFrom / pickEdgeTo set the endpoint id + display without touching the name cache', () => {
    const c = make().componentInstance;
    c.pickEdgeFrom({ _id: 'e1', name: 'Alice' } as any);
    c.pickEdgeTo({ _id: 'e2', name: 'Bob' } as any);
    expect(c.edgeForm.from).toBe('e1');
    expect(c.edgeForm.fromDisplay).toBe('Alice');
    expect(c.edgeForm.to).toBe('e2');
    expect(c.edgeForm.toDisplay).toBe('Bob');
    expect(c.picker.entityNameCache()['e1']).toBeUndefined();
  });

  it('view-in-graph emits the edge\'s FROM endpoint, not the edge id', () => {
    // A graph is rooted at a node and an edge is not one, so `from` is the deliberate choice: passing
    // `edge._id` would send the graph an id no entity has, and it would resolve to nothing.
    const fixture = make();
    const c = fixture.componentInstance;
    TestBed.inject(BrainStore).edges.set([
      { _id: 'edge-1', from: 'ent-from', to: 'ent-to', label: 'knows' } as Edge,
    ]);
    fixture.detectChanges();

    const seen: string[] = [];
    c.viewInGraph.subscribe(id => seen.push(id));
    // Test transloco echoes the key back.
    const btn = fixture.nativeElement.querySelector('button[aria-label="common.viewInGraph"]');
    expect(btn, 'the button must render in the row').toBeTruthy();
    btn.click();
    expect(seen).toEqual(['ent-from']);
  });
});
