/**
 * A record tab never shows rows older than the last thing the user asked for (`Q-112`).
 *
 * Each tab's `load()` subscribed to its list request and wrote whatever came back, and nothing cancelled the one
 * before it — so a slow answer to an old filter, arriving after the answer to the new one, replaced the rows under
 * a filter bar that no longer matched them. The semantic search on the same tab wrote the SAME rows through a
 * latest-wins of its own, so the list and the search could still overwrite each other.
 *
 * The rule is per piece of state, not per kind of request: one slot per tab's rows, and every answer that writes
 * them goes through it. Asserted over all four tabs at once — a rule held by three of four is the defect this
 * repository produces most.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, Subject, type Observable } from 'rxjs';
import { provideRouter } from '@angular/router';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordListState } from './record-list-state.service';
import { EntitiesTabComponent } from './entities-tab.component';
import { EdgesTabComponent } from './edges-tab.component';
import { FactsTabComponent } from './facts-tab.component';
import { ChronoTabComponent } from './chrono-tab.component';

interface TabCase {
  name: string;
  component: unknown;
  list: 'listEntities' | 'listEdges' | 'listFacts' | 'listChrono';
  /** The list answer's rows under their envelope key. */
  wrap: (rows: unknown[]) => unknown;
  /** The store signal the tab writes its rows to. */
  rows: (store: BrainStore) => { _id: string }[];
  row: (id: string) => Record<string, unknown>;
}

const CASES: TabCase[] = [
  { name: 'entities', component: EntitiesTabComponent, list: 'listEntities', wrap: r => ({ entities: r }),
    rows: s => s.entities() as never, row: id => ({ _id: id, name: id, type: 't', tags: [] }) },
  { name: 'edges', component: EdgesTabComponent, list: 'listEdges', wrap: r => ({ edges: r }),
    rows: s => s.edges() as never, row: id => ({ _id: id, from: 'a', to: 'b', label: 'l', tags: [] }) },
  { name: 'facts', component: FactsTabComponent, list: 'listFacts', wrap: r => ({ facts: r }),
    rows: s => s.facts() as never, row: id => ({ _id: id, fact: id, tags: [], linkEntities: [] }) },
  { name: 'chrono', component: ChronoTabComponent, list: 'listChrono', wrap: r => ({ chrono: r }),
    rows: s => s.chrono() as never, row: id => ({ _id: id, title: id, type: 'event', startsAt: '2026-01-01T00:00:00Z', tags: [], linkEntities: [], linkFacts: [] }) },
];

function mount(tc: TabCase) {
  const pending: Subject<unknown>[] = [];
  const listed = () => { const s = new Subject<unknown>(); pending.push(s); return s as Observable<unknown>; };
  const recalled: Subject<unknown>[] = [];
  const api: Record<string, unknown> = {
    listEntities: listed, listEdges: listed, listFacts: listed, listChrono: listed,
    recallBrain: () => { const s = new Subject<unknown>(); recalled.push(s); return s; },
    withLinks: (_s: string, _k: string, rows: unknown[]) => of(rows),
    getEntitiesByIds: () => of({ entities: [] }),
    getRecordsByIds: () => of({ records: [] }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [tc.component as never, getTranslocoModule()],
    providers: [provideRouter([]), RecordListState, BrainStore, EntityRefPicker, RecordDrawerState, { provide: BrainApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(tc.component as never);
  (fixture.componentRef as any).setInput('spaceId', 'work');
  fixture.detectChanges();   // the self-load on the spaceId: pending[0]
  return { c: fixture.componentInstance as any, store: TestBed.inject(BrainStore), pending, recalled };
}

const answer = (s: Subject<unknown>, v: unknown) => { s.next(v); s.complete(); };

describe('record tabs: the latest request wins (Q-112)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const tc of CASES) {
    it(`${tc.name}: an older filter's slow answer does not replace the newer filter's rows`, () => {
      const m = mount(tc);
      answer(m.pending[0]!, tc.wrap([]));
      m.c.setTypeFilter('old');
      m.c.setTypeFilter('new');
      expect(m.pending.length, 'each filter change asks once').toBe(3);
      answer(m.pending[2]!, tc.wrap([tc.row('NEW')]));   // the newer answer lands first…
      answer(m.pending[1]!, tc.wrap([tc.row('OLD')]));   // …and the older one after it
      expect(tc.rows(m.store).map(r => r._id)).toEqual(['NEW']);
    });
  }

  for (const tc of CASES.filter(t => t.name !== 'entities')) {
    it(`${tc.name}: a list answer arriving after a semantic search does not replace the search's rows`, () => {
      const m = mount(tc);
      // The list load is still in flight when the user searches.
      const search = tc.name === 'facts' ? 'runSemanticMemorySearch' : tc.name === 'edges' ? 'runSemanticEdgeSearch' : 'runSemanticChronoSearch';
      const query = tc.name === 'facts' ? m.store.memorySearch : tc.name === 'edges' ? m.store.edgeSearch : m.store.chronoSearch;
      query.set('something');
      m.c[search]();
      const type = tc.name === 'facts' ? 'fact' : tc.name === 'edges' ? 'edge' : 'chrono';
      answer(m.recalled[0]!, { results: [{ type, score: 1, spaceId: 'work', record: tc.row('SEARCH') }], count: 1 });
      answer(m.pending[0]!, tc.wrap([tc.row('LIST')]));   // the stale list answer
      expect(tc.rows(m.store).map(r => r._id)).toEqual(['SEARCH']);
    });
  }
});
