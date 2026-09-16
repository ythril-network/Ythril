/**
 * GraphComponent — verifies the OnPush conversion (P5, final slice).
 *
 * Graph is the highest-value and highest-risk P5 target: a cytoscape canvas whose event handlers
 * fire OUTSIDE Angular. The conversion is safe because the handlers that touch Angular state write
 * signals (`selectedNode`/`selectedEdge`/…), and signal writes notify OnPush regardless of zone. The
 * tests below drive those signals directly — simulating what a node/edge tap does — and assert the
 * side panels render, which is the property that would break if a handler wrote a plain field
 * instead. The drawer test additionally pins the plain-field/signal coupling (same shape as brain).
 *
 * cytoscape is mocked: it renders to a real canvas, which jsdom does not provide. The mock is a
 * chainable no-op so `ngAfterViewInit → initCytoscape()` runs without a DOM canvas; the OnPush
 * behaviour under test lives entirely in Angular's signal → change-detection path, not in cytoscape.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { ActivatedRoute } from '@angular/router';

vi.mock('cytoscape', () => {
  const chain: any = new Proxy(() => chain, { get: () => () => chain });
  return { default: () => chain };
});

import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { RecordDrawerState } from '../brain/record-drawer-state.service';
import { GraphComponent } from './graph.component';
import { isOnPush } from '../../testing/onpush';
import { aMemory } from '../../testing/records';

function makeApi() {
  return {
    getMe: () => of({ readOnly: false }),
    listSpaces: () => of({ spaces: [] }),
    // The page feeds `BrainStore.spaceMeta` so the shared drawer's property editors get their schema.
    getSpaceMeta: () => of({ typeSchemas: {} }),
  } as any;
}

describe('GraphComponent (OnPush)', () => {
  function create() {
    TestBed.configureTestingModule({
      imports: [GraphComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: makeApi() },
        { provide: BrainApi, useValue: makeApi() },
        { provide: AuthApi, useValue: makeApi() },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
      ],
    });
    const fixture = TestBed.createComponent(GraphComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work'); // embedded path: skip listSpaces
    fixture.detectChanges(); // ngOnInit + ngAfterViewInit (cytoscape mocked)
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(GraphComponent)).toBe(true);
  });

  it('renders the node side panel when selectedNode is set (the signal a cytoscape tap writes)', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    expect(fixture.nativeElement.querySelector('.side-panel')).toBeNull();

    // This is exactly what the `cy.on('tap','node')` handler does — write the signal.
    c.selectedNode.set({ _id: 'n1', name: 'Ada Lovelace', type: 'person', depth: 1 } as any);
    fixture.detectChanges();

    const panel = fixture.nativeElement.querySelector('.side-panel');
    expect(panel, 'the side panel should open on selectedNode').toBeTruthy();
    expect(panel.querySelector('h3').textContent).toContain('Ada Lovelace');
  });

  it('closes the side panel when selectedNode is cleared (background-tap path)', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    c.selectedNode.set({ _id: 'n1', name: 'Node', type: 'x', depth: 1 } as any);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.side-panel')).toBeTruthy();

    c.selectedNode.set(null); // what the background-tap handler does
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.side-panel')).toBeNull();
  });

  it('renders the linked-records lists in BOTH the node panel and the edge panel', () => {
    // The two panels used to carry byte-identical copies of this block. Now they share one component,
    // so a mis-wire affects one call site and not the other — and nothing else in the suite would
    // notice: the 45 characterization tests set `nodeMemories`/`nodeChrono` and assert on the signals,
    // never on a rendered row. Asserting BOTH panels is the whole point of this test.
    const fixture = create();
    const c = fixture.componentInstance;
    c.nodeMemories.set([{ _id: 'm1', fact: 'linked fact', createdAt: '2026-01-01' } as any]);

    c.selectedNode.set({ _id: 'n1', name: 'Node', type: 'x', depth: 1 } as any);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-graph-linked-records'), 'node panel').toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('linked fact');

    c.selectedNode.set(null);
    c.selectedEdge.set({ _id: 'e1', label: 'knows', from: 'a', to: 'b' } as any);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('app-graph-linked-records'), 'edge panel').toBeTruthy();
    expect(fixture.nativeElement.textContent).toContain('linked fact');
  });

  it('narrows the panel lists by type and by description text', () => {
    // The userguide has promised these filters all along; until now nothing was wired to them.
    const fixture = create();
    const c = fixture.componentInstance;
    c.nodeMemories.set([
      { _id: 'm1', fact: 'alpha memory', createdAt: '2026-01-01' } as any,
      { _id: 'm2', fact: 'beta memory', createdAt: '2026-01-02' } as any,
    ]);
    c.nodeChrono.set([{ _id: 'c1', title: 'alpha event', createdAt: '2026-01-03' } as any]);
    c.selectedNode.set({ _id: 'n1', name: 'Node', type: 'x', depth: 1 } as any);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.list-row').length).toBe(3);

    c.detailTypeFilter.set('fact');
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelectorAll('.list-row').length, 'type filter').toBe(2);

    c.detailTypeFilter.set('all');
    c.detailDescFilter.set('alpha');
    fixture.detectChanges();
    // One memory and one chrono match — proving the text filter reaches BOTH lists, not just the first.
    const texts = [...fixture.nativeElement.querySelectorAll('.list-row-text')].map((e: any) => e.textContent.trim());
    expect(texts).toEqual(['alpha memory', 'alpha event']);
  });

  it('says "no matches" rather than "no memories" when a filter hides everything', () => {
    // Otherwise a filtered-empty panel is indistinguishable from a node that genuinely has nothing.
    const fixture = create();
    const c = fixture.componentInstance;
    c.nodeMemories.set([{ _id: 'm1', fact: 'alpha', createdAt: '2026-01-01' } as any]);
    c.selectedNode.set({ _id: 'n1', name: 'Node', type: 'x', depth: 1 } as any);
    fixture.detectChanges();          // selection settles first — this is the pass that clears filters
    c.detailDescFilter.set('nothing-matches-this');
    fixture.detectChanges();

    expect(fixture.nativeElement.textContent).toContain('graph.panel.noMatches');
    expect(fixture.nativeElement.textContent).not.toContain('graph.panel.noMemories');
  });

  it('clears the filters when the selection changes', () => {
    // Filter one node, click the next, and a stale filter would present the new node as empty while
    // the control that hid its rows sits several rows up, saying nothing.
    const fixture = create();
    const c = fixture.componentInstance;
    c.selectedNode.set({ _id: 'n1', name: 'A', type: 'x', depth: 1 } as any);
    fixture.detectChanges();
    c.detailTypeFilter.set('chrono');
    c.detailDescFilter.set('alpha');
    fixture.detectChanges();

    c.selectedNode.set({ _id: 'n2', name: 'B', type: 'x', depth: 1 } as any);
    fixture.detectChanges();

    expect([c.detailTypeFilter(), c.detailDescFilter()]).toEqual(['all', '']);
  });

  it('opens the SHARED record drawer, whose plain form model renders under this page\'s OnPush', () => {
    // The page no longer forks the drawer — `openBrainDrawer` delegates to `RecordDrawerState.open()`.
    // The coupling under test is unchanged and still load-bearing: `open()` writes the `drawerRecord`
    // SIGNAL (which guards the drawer's @if) and the plain `drawerEditMemory` field in the same turn,
    // and the title binds the PLAIN field. Drop the sibling signal write and this renders empty.
    //
    // Asserting through the shared drawer's own markup (`.drawer`/`.drawer-title`) is the point: it is
    // what proves the reuse is real rather than a renamed copy.
    const fixture = create();
    const c = fixture.componentInstance;
    expect(fixture.nativeElement.querySelector('.drawer')).toBeNull();

    c.openBrainDrawer('fact', aMemory({ fact: 'a graph-drawer fact' }));
    fixture.detectChanges();

    const drawer = fixture.nativeElement.querySelector('.drawer');
    expect(drawer, 'the drawer should be open').toBeTruthy();
    expect((fixture.nativeElement.querySelector('.drawer-title') as HTMLElement).textContent)
      .toContain('a graph-drawer fact');
  });

  it('patches the node panel list when the shared drawer saves (the store it patches is not this page\'s)', () => {
    // The drawer updates `BrainStore.facts`, which this page never renders — it keeps its own
    // per-node arrays. Without the `lastSaved` bridge a save would succeed and leave the pre-save row
    // on screen: a silent staleness that no error and no drawer-side test can see.
    const fixture = create();
    const c = fixture.componentInstance;
    c.nodeMemories.set([{ _id: 'm1', fact: 'before' } as any]);

    // From the COMPONENT's injector, not TestBed's — the page provides its own drawer collaborators.
    const drawerState = fixture.debugElement.injector.get(RecordDrawerState);
    drawerState.lastSaved.set({ kind: 'fact', record: aMemory({ fact: 'after' }) });
    fixture.detectChanges();

    expect(c.nodeMemories()[0].fact).toBe('after');
  });

  describe('focusEntityId — arriving from a record table', () => {
    /** Same embedded setup, plus the focus input and a traversal-capable api. */
    function createWithFocus(focusId: string | undefined, entity: any = { _id: 'ent-1', name: 'Ada', type: 'person' }) {
      const traverseGraph = vi.fn(() => of({ nodes: [], edges: [], truncated: false } as any));
      const getEntity = vi.fn(() => of(entity));
      TestBed.configureTestingModule({
        imports: [GraphComponent, getTranslocoModule()],
        providers: [
          { provide: SpacesApi, useValue: makeApi() },
          { provide: BrainApi, useValue: { ...makeApi(), getEntity, traverseGraph } },
          { provide: AuthApi, useValue: makeApi() },
          { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
        ],
      });
      const fixture = TestBed.createComponent(GraphComponent);
      fixture.componentRef.setInput('embeddedSpaceId', 'work');
      if (focusId !== undefined) fixture.componentRef.setInput('focusEntityId', focusId);
      fixture.detectChanges();
      return { fixture, c: fixture.componentInstance, traverseGraph, getEntity };
    }

    it('roots the graph at the given entity with BOTH directions at depth 2', () => {
      const { c, traverseGraph } = createWithFocus('ent-1');
      expect(c.rootEntity()?._id).toBe('ent-1');
      expect(c.direction()).toBe('both');
      expect(c.depth()).toBe(2);
      // The request is the assertion that matters — the toolbar could read "both / 2" while the
      // traversal that actually populated the canvas asked for something else.
      expect(traverseGraph).toHaveBeenCalledWith('work', expect.objectContaining({
        startId: 'ent-1', direction: 'both', maxDepth: 2,
      }));
    });

    it('applies the focus only AFTER cytoscape exists, so the result is drawn rather than cached', () => {
      // The trap this pins: `renderGraph` opens with `if (!this.cy) return`, and the input setter runs
      // during construction — before ngAfterViewInit. Rooting from the setter fetches, traverses, fills
      // the cache and draws NOTHING, with no error, and an empty canvas reads as "no connections".
      // Asserting the traversal has not fired before detectChanges() is what keeps that ordering.
      const traverseGraph = vi.fn(() => of({ nodes: [], edges: [], truncated: false } as any));
      TestBed.configureTestingModule({
        imports: [GraphComponent, getTranslocoModule()],
        providers: [
          { provide: SpacesApi, useValue: makeApi() },
          { provide: BrainApi, useValue: { ...makeApi(), getEntity: () => of({ _id: 'ent-1', name: 'Ada', type: 'person' }),
            getRecord: () => of({ _id: 'ent-1', name: 'Ada', type: 'person' }), traverseGraph } },
          { provide: AuthApi, useValue: makeApi() },
          { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
        ],
      });
      const fixture = TestBed.createComponent(GraphComponent);
      fixture.componentRef.setInput('embeddedSpaceId', 'work');
      fixture.componentRef.setInput('focusEntityId', 'ent-1');
      expect(traverseGraph, 'nothing may traverse before the view exists').not.toHaveBeenCalled();
      fixture.detectChanges();
      expect(traverseGraph).toHaveBeenCalled();
    });

    it('reports a lookup failure instead of leaving an empty canvas', () => {
      // A deleted or cross-space id must not render as a node with no connections.
      const { c, traverseGraph } = createWithFocus('gone', null);
      expect(c.rootEntity()).toBeNull();
      expect(c.loadError()).toContain('gone');
      expect(traverseGraph).not.toHaveBeenCalled();
    });

    it('opens unrooted when no focus is passed — the tab-bar path is unchanged', () => {
      const { c, traverseGraph, getEntity } = createWithFocus(undefined);
      expect(c.rootEntity()).toBeNull();
      expect(getEntity).not.toHaveBeenCalled();
      expect(traverseGraph).not.toHaveBeenCalled();
      expect(c.loadError()).toBeNull();
    });
  });
});
