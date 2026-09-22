/**
 * GraphComponent — characterization tests, written against the ORIGINAL 2065-line component.
 *
 * These exist to make a later split safe, and they were deliberately written BEFORE any refactor:
 * a characterization test written against already-restructured code pins the new behaviour, which is
 * worth nothing. Everything asserted here is what the component does TODAY — including the parts that
 * look like oversights (see `loadEdgeDetails`, below). Where behaviour is surprising, the comment says
 * so rather than "fixing" it silently; changing any of it is a separate, deliberate decision that
 * should make one of these tests fail loudly.
 *
 * Four concern clusters are covered, in the order a split would move them:
 *
 *   1. Derivation      — `allDetails` / `filteredDetails` / `toggleSort`: pure, and the easiest thing
 *                        to break silently when it moves to a service.
 *   2. Traversal cache — which interactions hit the network and which do not. Invisible when wrong:
 *                        a broken cache still shows a correct graph, just with N× the requests.
 *   3. Render boundary — cytoscape itself is NOT tested. What IS pinned is the MODEL handed to it, so
 *                        the renderer can be swapped or moved without changing what it is asked to draw.
 *   4. Selection       — what the (out-of-zone) cytoscape handlers write, and teardown.
 *
 * The cytoscape fake records rather than renders: jsdom has no canvas, and the behaviour under test is
 * entirely on the Angular side of that boundary. `layout().run()` does NOT fire `layoutstop` on its
 * own — tests trigger it explicitly, so the auto-select-root path is observed rather than raced.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, throwError, Subject } from 'rxjs';
import { ActivatedRoute } from '@angular/router';

/** Records what the component asks cytoscape to do. Hoisted so `vi.mock`'s factory can reach it. */
const cy = vi.hoisted(() => {
  const state: any = {
    instance: null as any,
    handlers: [] as Array<{ ev: string; sel?: string; cb: (e: any) => void }>,
    added: [] as any[][],      // one entry per cy.add() call
    layoutOpts: [] as any[],
    layoutStop: null as null | (() => void),
    edgeClasses: new Set<string>(),
    /** Which nodes cytoscape would report as selected. Drives `syncEdgeLabels`. */
    selectedNodes: [] as string[],
    removeCalls: 0,
    destroyed: 0,
    fits: 0,
  };

  state.reset = () => {
    state.handlers = []; state.added = []; state.layoutOpts = []; state.layoutStop = null;
    state.edgeClasses = new Set<string>();
    state.selectedNodes = [];
    state.removeCalls = 0; state.destroyed = 0; state.fits = 0;
  };

  /** The last element batch handed over, split by group. */
  state.lastModel = () => {
    const els = state.added[state.added.length - 1] ?? [];
    return {
      nodes: els.filter((e: any) => e.group === 'nodes'),
      edges: els.filter((e: any) => e.group === 'edges'),
    };
  };

  /**
   * Fire a registered handler, as a real user tap would.
   *
   * The registered name is split on whitespace because cytoscape's `on()` accepts a space-separated list —
   * `cy.on('select unselect', …)` is one registration for two events. Matching the whole string would make
   * such a handler unreachable from here, and the first test to rely on one would fail against production
   * code that is correct.
   */
  state.fire = (ev: string, sel: string | undefined, evt: any) => {
    for (const h of state.handlers) {
      if (h.sel === sel && String(h.ev).split(/\s+/).includes(ev)) h.cb(evt);
    }
  };

  state.make = () => {
    const inst: any = {
      on: (ev: string, a: any, b?: any) =>
        state.handlers.push(typeof a === 'function' ? { ev, cb: a } : { ev, sel: a, cb: b }),
      add: (els: any[]) => state.added.push(els),
      elements: () => ({ remove: () => { state.removeCalls++; } }),
      edges: () => ({
        addClass: (c: string) => state.edgeClasses.add(c),
        removeClass: (c: string) => state.edgeClasses.delete(c),
      }),
      // `nodes(selector)` exists so `syncEdgeLabels` can ask which node is selected. `selectedNodes`
      // defaults to none, which is the state a freshly rendered graph is in — nothing is selected, so no
      // edge carries a label. A test that wants the labelled case sets it and calls the handler.
      nodes: (_sel?: string) => ({
        length: state.selectedNodes.length,
        connectedEdges: () => ({
          addClass: (c: string) => state.edgeClasses.add(c),
          removeClass: (c: string) => state.edgeClasses.delete(c),
        }),
      }),
      resize: () => {},
      fit: () => { state.fits++; },
      destroy: () => { state.destroyed++; },
      layout: (opts: any) => {
        state.layoutOpts.push(opts);
        return { on: (_ev: string, cb: () => void) => { state.layoutStop = cb; }, run: () => {} };
      },
    };
    state.instance = inst;
    return inst;
  };

  return state;
});

vi.mock('cytoscape', () => ({ default: (opts: any) => { cy.initOpts = opts; return cy.make(); } }));

import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { GraphComponent } from './graph.component';

const ROOT = { _id: 'root', name: 'Ada', type: 'person', description: 'root desc', tags: ['t'] } as any;

/** A traversal result whose nodes sit at the given depths. */
function traverseResult(nodes: Array<[string, number]>, edges: Array<[string, string, string]>, truncated = false) {
  return {
    nodes: nodes.map(([id, depth]) => ({ _id: id, name: id.toUpperCase(), type: 'thing', depth })),
    edges: edges.map(([id, from, to]) => ({ _id: id, from, to, label: 'rel' })),
    truncated,
  };
}

/** BrainApi double: counts traversals so cache behaviour is observable, and never touches HTTP. */
function makeBrain(overrides: Record<string, any> = {}) {
  const calls: any[] = [];
  return {
    calls,
    traverseGraph: vi.fn((_s: string, body: any) => { calls.push(body); return of(traverseResult([], [])); }),
    getEntity: vi.fn(() => of(null as any)),
    // `loadNodeDetails` dispatches through `getRecord` so a chrono/memory node opens its own collection;
    // this mock forwards to the entity stub, which is what every node in these fixtures is.
    getRecord: vi.fn(() => of(null as any)),
    getEdge: vi.fn(() => of(null as any)),
    getMemory: vi.fn(() => of(null as any)),
    getChrono: vi.fn(() => of(null as any)),
    listFacts: vi.fn(() => of({ facts: [] })),
    queryBrain: vi.fn(() => of({ results: [], collection: 'chrono', count: 0 })),
    ...overrides,
  } as any;
}

function create(brain: any = makeBrain()) {
  TestBed.configureTestingModule({
    imports: [GraphComponent, getTranslocoModule()],
    providers: [
      // `getSpaceMeta` feeds the shared record drawer's property schema. Added to the stub, not to any
      // assertion: every behaviour characterized below is unchanged by the drawer swap.
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }), getSpaceMeta: () => of({ typeSchemas: {} }) } },
      { provide: BrainApi, useValue: brain },
      { provide: AuthApi, useValue: { getMe: () => of({ readOnly: false }) } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
    ],
  });
  const fixture = TestBed.createComponent(GraphComponent);
  fixture.componentRef.setInput('embeddedSpaceId', 'work');  // embedded: no listSpaces, no URL writes
  fixture.detectChanges();                                   // ngOnInit + ngAfterViewInit
  return { fixture, c: fixture.componentInstance as any, brain };
}

beforeEach(() => { TestBed.resetTestingModule(); cy.reset(); vi.clearAllMocks(); });

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 1. Derivation — the detail table under the side panel
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('GraphComponent — detail rows are derived, not stored', () => {
  const MEMS = [
    { _id: 'm1', fact: 'Ada wrote the first program', tags: ['history'], properties: { x: 1 }, createdAt: '2026-01-02', linkEntities: ['root'] },
    { _id: 'm2', fact: '', description: 'falls back to description', tags: [], createdAt: '2026-01-03' },
  ] as any[];
  const CHRONO = [
    { _id: 'c1', title: 'Analytical Engine note', tags: ['note'], createdAt: '2026-01-01', linkEntities: ['root'] },
    { _id: 'c2', title: '', description: 'chrono description fallback', tags: [], createdAt: '2026-01-04' },
  ] as any[];

  function withRows() {
    const { c } = create();
    c.nodeMemories.set(MEMS);
    c.nodeChrono.set(CHRONO);
    return c;
  }

  it('reads a memory as fact-then-description and a chrono as title-then-description', () => {
    // Two different field names collapsing into one `description` column. A split that mapped both
    // through the same helper would silently blank one of the four cases.
    const rows = withRows().allDetails();
    expect(rows.map((r: any) => r.description)).toEqual([
      'Ada wrote the first program',
      'falls back to description',
      'Analytical Engine note',
      'chrono description fallback',
    ]);
    expect(rows.map((r: any) => r.kind)).toEqual(['fact', 'fact', 'chrono', 'chrono']);
  });

  it('gives chrono rows an empty properties bag even when the record has properties', () => {
    // Chrono records CAN carry schema-defined properties, but this table does not read them — it hard-codes
    // `{}`. Pinned as-is: surfacing them is a feature decision, not a refactor.
    const c = create().c;
    c.nodeChrono.set([{ _id: 'c9', title: 't', tags: [], createdAt: '2026-01-01', properties: { real: 'value' } }]);
    expect(c.allDetails()[0].properties).toEqual({});
  });

  it('defaults to newest-first by createdAt', () => {
    expect(withRows().filteredDetails().map((r: any) => r.id)).toEqual(['c2', 'm2', 'm1', 'c1']);
  });

  it('filters by kind', () => {
    const c = withRows();
    c.detailTypeFilter.set('chrono');
    expect(c.filteredDetails().map((r: any) => r.id)).toEqual(['c2', 'c1']);
    c.detailTypeFilter.set('fact');
    expect(c.filteredDetails().map((r: any) => r.id)).toEqual(['m2', 'm1']);
  });

  it('matches the description filter case-insensitively, as a substring', () => {
    const c = withRows();
    c.detailDescFilter.set('ENGINE');
    expect(c.filteredDetails().map((r: any) => r.id)).toEqual(['c1']);
  });

  /*
   * Four cases moved out in G-7 — two down to `graph-modules.spec.ts` and two deleted with their subject.
   *
   * `toggleSort` and `sortArrow` were unreachable: the detail table became `graph-linked-records`, which
   * filters but does not sort, so nothing on the page could call either one. Their assertions kept passing,
   * which is the worst state for a test to be in — green is read as "the behaviour is still there".
   *
   * The two sort cases that were really about `filterAndSortDetails` now test it directly, where the sorting
   * lives and where a caller can still reach it.
   */
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 2. Traversal cache — which gestures reach the network
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('GraphComponent — the traversal cache decides what hits the network', () => {
  it('fetches once for a new root', () => {
    const { c, brain } = create();
    c.selectRoot(ROOT);
    expect(brain.traverseGraph).toHaveBeenCalledTimes(1);
    expect(brain.calls[0]).toEqual({ startId: 'root', direction: 'both', maxDepth: 2, limit: 200 });
  });

  it('serves a SHALLOWER depth from cache without a second request', () => {
    // The cache is the reason dragging the depth slider down is instant. Losing it is invisible in the
    // UI and only shows up as request volume.
    const brain = makeBrain({
      traverseGraph: vi.fn((_s: string, b: any) => { brain.calls.push(b); return of(traverseResult([['a', 1], ['b', 2]], [])); }),
    });
    const { c } = create(brain);
    c.selectRoot(ROOT);
    c.onDepthChange(1);
    expect(brain.traverseGraph).toHaveBeenCalledTimes(1);
    expect(cy.lastModel().nodes.map((n: any) => n.data.id).sort()).toEqual(['a', 'root']);
  });

  it('fetches once more for a DEEPER depth and merges without duplicating', () => {
    let call = 0;
    const brain: any = makeBrain();
    brain.traverseGraph = vi.fn((_s: string, b: any) => {
      brain.calls.push(b);
      return of(call++ === 0
        ? traverseResult([['a', 1]], [['e1', 'root', 'a']])
        : traverseResult([['a', 1], ['b', 3]], [['e1', 'root', 'a'], ['e2', 'a', 'b']]));  // repeats a/e1
    });
    const { c } = create(brain);
    c.selectRoot(ROOT);
    c.onDepthChange(3);
    expect(brain.traverseGraph).toHaveBeenCalledTimes(2);
    const model = cy.lastModel();
    expect(model.nodes.map((n: any) => n.data.id).sort()).toEqual(['a', 'b', 'root']);
    expect(model.edges.map((e: any) => e.data.id).sort()).toEqual(['e1', 'e2']);
  });

  it('REPLACES rather than merges when the cached result was truncated', () => {
    // A truncated result is not a prefix of the deeper one, so merging would keep nodes the server has
    // since dropped. The flag is what makes the deeper fetch authoritative.
    let call = 0;
    const brain: any = makeBrain();
    brain.traverseGraph = vi.fn((_s: string, b: any) => {
      brain.calls.push(b);
      return of(call++ === 0
        ? traverseResult([['stale', 1]], [], true)
        : traverseResult([['fresh', 1]], [], false));
    });
    const { c } = create(brain);
    c.selectRoot(ROOT);
    expect(c.truncated()).toBe(true);
    c.onDepthChange(3);
    expect(cy.lastModel().nodes.map((n: any) => n.data.id).sort()).toEqual(['fresh', 'root']);
    expect(c.truncated()).toBe(false);
  });

  it('refetches when only the DIRECTION changes, even at the same depth', () => {
    const { c, brain } = create();
    c.selectRoot(ROOT);
    c.setDirection('outbound');
    expect(brain.traverseGraph).toHaveBeenCalledTimes(2);
    expect(brain.calls[1].direction).toBe('outbound');
  });

  it('resetGraph drops the cache so the next selection refetches', () => {
    const { c, brain } = create();
    c.selectRoot(ROOT);
    c.resetGraph();
    expect([c.rootEntity(), c.searchQuery(), c.truncated()]).toEqual([null, '', false]);
    c.selectRoot(ROOT);
    expect(brain.traverseGraph).toHaveBeenCalledTimes(2);
  });

  it('does not traverse at all without an active space', () => {
    const { c, brain } = create();
    c.activeSpaceId.set('');
    c.selectRoot(ROOT);
    expect(brain.traverseGraph).not.toHaveBeenCalled();
  });

  it('records the failure reason instead of rendering an empty graph', () => {
    // U3: a failed traversal that cleared the canvas would read as "this entity has no connections".
    const brain: any = makeBrain({ traverseGraph: vi.fn(() => throwError(() => ({ status: 500 }))) });
    const { c } = create(brain);
    c.selectRoot(ROOT);
    expect(c.loading()).toBe(false);
    expect(c.loadError()).toBeTruthy();
    expect(cy.added.length).toBe(0);        // nothing was handed to the renderer
  });

  it('retryTraverse replays the exact parameters that failed', () => {
    const brain: any = makeBrain({ traverseGraph: vi.fn(() => throwError(() => ({ status: 500 }))) });
    const { c } = create(brain);
    c.depth.set(4);
    c.setDirection('inbound');
    c.selectRoot(ROOT);
    const failed = brain.traverseGraph.mock.calls.at(-1)[1];
    c.retryTraverse();
    expect(brain.traverseGraph.mock.calls.at(-1)[1]).toEqual(failed);
  });

  it('retryTraverse is a no-op before any traversal has been attempted', () => {
    const { c, brain } = create();
    c.retryTraverse();
    expect(brain.traverseGraph).not.toHaveBeenCalled();
  });

  it('clears the loading flag and stale selection when a traversal starts', () => {
    const gate = new Subject<any>();
    const brain: any = makeBrain({ traverseGraph: vi.fn(() => gate) });
    const { c } = create(brain);
    c.selectedNode.set({ _id: 'old', name: 'stale', type: 'x', depth: 1 });
    c.selectRoot(ROOT);
    expect(c.loading()).toBe(true);
    expect(c.selectedNode()).toBeNull();     // stale panel must not survive the new traversal
    gate.next(traverseResult([], []));
    expect(c.loading()).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 3. Render boundary — the model handed to cytoscape (cytoscape itself is NOT under test)
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('GraphComponent — what it asks the renderer to draw', () => {
  function render(nodes: Array<[string, number]>, edges: Array<[string, string, string]>, depth = 2) {
    const brain: any = makeBrain({ traverseGraph: vi.fn(() => of(traverseResult(nodes, edges))) });
    const { c } = create(brain);
    c.depth.set(depth);
    c.selectRoot(ROOT);
    return c;
  }

  it('adds the root itself — the traversal result never contains it', () => {
    render([['a', 1]], [['e1', 'root', 'a']]);
    const root = cy.lastModel().nodes.find((n: any) => n.data.id === 'root');
    expect(root).toMatchObject({ classes: 'root', data: { label: 'Ada', type: 'person', depth: 0 } });
  });

  it('does not duplicate the root when the traversal also returns it', () => {
    render([['root', 0], ['a', 1]], []);
    expect(cy.lastModel().nodes.filter((n: any) => n.data.id === 'root')).toHaveLength(1);
  });

  it('falls back to a "default" node type rather than emitting undefined', () => {
    const brain: any = makeBrain({ traverseGraph: vi.fn(() => of({ nodes: [{ _id: 'a', name: 'A', type: '', depth: 1 }], edges: [], truncated: false })) });
    const { c } = create(brain);
    c.selectRoot({ ...ROOT, type: '' });
    for (const n of cy.lastModel().nodes) expect(n.data.type).toBe('default');
  });

  it('renames from/to to source/target — the shape cytoscape requires', () => {
    render([['a', 1]], [['e1', 'root', 'a']]);
    expect(cy.lastModel().edges[0]).toMatchObject({ group: 'edges', data: { id: 'e1', source: 'root', target: 'a', label: 'rel' } });
  });

  it('drops nodes past the requested depth', () => {
    render([['a', 1], ['b', 2], ['deep', 3]], [], 2);
    expect(cy.lastModel().nodes.map((n: any) => n.data.id).sort()).toEqual(['a', 'b', 'root']);
  });

  it('keeps an edge only when BOTH endpoints survived the depth cut', () => {
    // The dangling-edge guard. Handing cytoscape an edge to a node that was not added throws there, so
    // this filter is load-bearing, not cosmetic.
    render([['a', 1], ['deep', 3]], [['keep', 'root', 'a'], ['dangling', 'a', 'deep']], 2);
    expect(cy.lastModel().edges.map((e: any) => e.data.id)).toEqual(['keep']);
  });

  it('treats the root as visible for edge survival even though it is not in the node list', () => {
    render([['a', 1]], [['e1', 'root', 'a']], 1);
    expect(cy.lastModel().edges.map((e: any) => e.data.id)).toEqual(['e1']);
  });

  it('counts what it handed over, not what the server returned', () => {
    // The badge must track the canvas. Counting the cache instead would keep showing depth-5 nodes
    // after the user dragged the slider back to 2 — the numbers and the picture disagreeing with no
    // error anywhere. Three cached nodes, two drawn: the counts must differ from the cache size.
    const c = render([['a', 1], ['deep', 5], ['deeper', 6]], [['e1', 'root', 'a'], ['far', 'deep', 'deeper']], 2);
    expect([c.nodeCount(), c.edgeCount()]).toEqual([2, 1]);   // root + a, and the one surviving edge
  });

  it('clears the previous drawing before each render', () => {
    render([['a', 1]], []);
    expect(cy.removeCalls).toBeGreaterThan(0);
  });

  it('roots the layout at the entity the user selected', () => {
    render([['a', 1]], []);
    // `roots` is an array of raw ids, not a `#id` selector. Cytoscape accepts both and resolves them to
    // the same element; the array is the form its typings describe, so the call needs no cast.
    expect(cy.layoutOpts.at(-1)).toMatchObject({ name: 'breadthfirst', roots: ['root'] });
  });

  it('applies the hide-labels state on every render, not only on toggle', () => {
    const brain: any = makeBrain({ traverseGraph: vi.fn(() => of(traverseResult([['a', 1]], []))) });
    const { c } = create(brain);
    c.onHideLabelsChange(true);
    c.selectRoot(ROOT);
    expect(cy.edgeClasses.has('hide-labels')).toBe(true);   // a re-render must not lose the setting
    c.onHideLabelsChange(false);
    expect(cy.edgeClasses.has('hide-labels')).toBe(false);
  });

  // ── Edge labels appear where they were asked for, and nowhere else ──────────────────────────────
  //
  // Every edge used to be labelled at all times. Cytoscape does not de-collide mid-edge labels, so a dense
  // traverse turned into overlapping text over the nodes — the picture got worse exactly as it got more
  // interesting. Labels now belong to the selected node's edges, and to a hovered edge.

  it('labels no edge when nothing is selected', () => {
    render([['a', 1]], [['e1', 'root', 'a']]);
    expect(cy.edgeClasses.has('show-label')).toBe(false);
  });

  it('labels the selected node\'s edges once something is selected', () => {
    render([['a', 1]], [['e1', 'root', 'a']]);
    cy.selectedNodes = ['root'];
    cy.fire('select', 'node', { target: { data: () => 'root' } });
    expect(cy.edgeClasses.has('show-label')).toBe(true);
  });

  it('takes the labels away again on deselect', () => {
    render([['a', 1]], [['e1', 'root', 'a']]);
    cy.selectedNodes = ['root'];
    cy.fire('select', 'node', { target: { data: () => 'root' } });
    cy.selectedNodes = [];
    cy.fire('unselect', 'node', { target: { data: () => 'root' } });
    expect(cy.edgeClasses.has('show-label')).toBe(false);
  });

  it('a hovered edge labels itself even with nothing selected', () => {
    // The narrowest way of asking what one line is. Without this, an unselected graph answers nothing.
    render([['a', 1]], [['e1', 'root', 'a']]);
    const added: string[] = [];
    cy.fire('mouseover', 'edge', {
      target: { addClass: (c: string) => { added.push(c); return { addClass: (d: string) => added.push(d) }; } },
    });
    expect(added).toContain('show-label');
  });

  it('re-applies the label set on every render, so a re-draw does not strand one', () => {
    // The same reasoning as `hide-labels` above: a render replaces every element, so a class that was on an
    // edge before is gone unless it is recomputed. A stale label would belong to nothing.
    const brain: any = makeBrain({ traverseGraph: vi.fn(() => of(traverseResult([['a', 1]], [['e1', 'root', 'a']]))) });
    const { c } = create(brain);
    cy.selectedNodes = ['root'];
    c.selectRoot(ROOT);
    expect(cy.edgeClasses.has('show-label')).toBe(true);
  });

  it('auto-selects the root once the layout settles, and not before', () => {
    const c = render([['a', 1]], []);
    expect(c.selectedNode()).toBeNull();      // layout still running
    cy.layoutStop();
    expect(c.selectedNode()).toMatchObject({ _id: 'root', name: 'Ada', depth: 0, description: 'root desc' });
  });

  it('does not steal a selection the user already made', () => {
    const c = render([['a', 1]], []);
    c.selectedNode.set({ _id: 'a', name: 'A', type: 'thing', depth: 1 });
    cy.layoutStop();
    expect(c.selectedNode()._id).toBe('a');
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────────
// 4. Selection — what the out-of-zone cytoscape handlers write, and teardown
// ─────────────────────────────────────────────────────────────────────────────────────────────────

describe('GraphComponent — selection written from cytoscape handlers', () => {
  function withGraph(brain?: any) {
    const b = brain ?? makeBrain({ traverseGraph: vi.fn(() => of(traverseResult([['a', 1]], [['e1', 'root', 'a']]))) });
    const { c } = create(b);
    c.selectRoot(ROOT);
    return { c, brain: b };
  }
  const tapTarget = (id: string) => ({ target: { data: () => id, addClass: () => {}, removeClass: () => {} } });

  it('selects a traversed node on tap and loads its details', () => {
    const { c, brain } = withGraph();
    cy.fire('tap', 'node', tapTarget('a'));
    expect(c.selectedNode()).toMatchObject({ _id: 'a', depth: 1 });
    expect(brain.listFacts).toHaveBeenCalled();
  });

  it('reconstructs the ROOT node on tap — it is absent from the traversal list', () => {
    // The root is added to the canvas separately, so a tap on it finds nothing in `graphNodes`. Without
    // this fallback the most-clicked node in the graph would be the one that does not respond.
    const { c } = withGraph();
    cy.fire('tap', 'node', tapTarget('root'));
    expect(c.selectedNode()).toMatchObject({ _id: 'root', name: 'Ada', depth: 0 });
  });

  it('ignores a tap on an id it does not know', () => {
    const { c } = withGraph();
    cy.fire('tap', 'node', tapTarget('ghost'));
    expect(c.selectedNode()).toBeNull();
  });

  it('an edge tap replaces a node selection rather than showing both panels', () => {
    const { c } = withGraph();
    cy.fire('tap', 'node', tapTarget('a'));
    cy.fire('tap', 'edge', tapTarget('e1'));
    expect(c.selectedNode()).toBeNull();
    expect(c.selectedEdge()).toMatchObject({ _id: 'e1', from: 'root', to: 'a' });
  });

  it('a node tap clears a previous edge selection, including its fetched record', () => {
    const { c } = withGraph();
    cy.fire('tap', 'edge', tapTarget('e1'));
    c.selectedEdgeRecord.set({ _id: 'e1' } as any);
    cy.fire('tap', 'node', tapTarget('a'));
    expect([c.selectedEdge(), c.selectedEdgeRecord()]).toEqual([null, null]);
  });

  it('a background tap clears everything the panels bind to', () => {
    const { c } = withGraph();
    cy.fire('tap', 'node', tapTarget('a'));
    cy.fire('tap', undefined, { target: cy.instance });   // background === the cy instance itself
    expect([c.selectedNode(), c.selectedEdge(), c.selectedEdgeRecord()]).toEqual([null, null, null]);
  });

  it('a tap on an element is not mistaken for a background tap', () => {
    const { c } = withGraph();
    cy.fire('tap', 'node', tapTarget('a'));
    cy.fire('tap', undefined, tapTarget('a'));
    expect(c.selectedNode()).not.toBeNull();
  });

  it('a double-tap re-roots the graph on the tapped entity', () => {
    const NEW = { _id: 'a', name: 'A', type: 'thing' } as any;
    const brain: any = makeBrain({
      traverseGraph: vi.fn(() => of(traverseResult([['a', 1]], [['e1', 'root', 'a']]))),
      getEntity: vi.fn(() => of(NEW)),
      getRecord: vi.fn(() => of(NEW)),
    });
    const { c } = withGraph(brain);
    cy.fire('dbltap', 'node', tapTarget('a'));
    expect(c.rootEntity()).toBe(NEW);
    expect(c.searchQuery()).toBe('A');       // the search box follows the root
  });

  it('selectRoot clears every panel signal from the previous root', () => {
    const { c } = withGraph();
    c.selectedNode.set({ _id: 'a' } as any);
    c.selectedEntityRecord.set({ _id: 'a' } as any);
    c.selectedEdge.set({ _id: 'e1' } as any);
    c.selectedEdgeRecord.set({ _id: 'e1' } as any);
    c.nodeMemories.set([{ _id: 'm1' } as any]);
    c.nodeChrono.set([{ _id: 'c1' } as any]);
    c.selectRoot(ROOT);
    expect([c.selectedNode(), c.selectedEntityRecord(), c.selectedEdge(), c.selectedEdgeRecord()])
      .toEqual([null, null, null, null]);
    expect([c.nodeMemories(), c.nodeChrono()]).toEqual([[], []]);
  });

  it('an edge panel lists only records referencing BOTH endpoints — asymmetrically', () => {
    // Characterizing an asymmetry rather than endorsing it: facts are fetched for `from` and then
    // filtered on `to` only, while chrono is filtered on `from` AND `to`. A chrono row that omits `from`
    // is therefore dropped where the equivalent memory row is kept. Pinned so a "tidy-up" of these two
    // filters into one helper is a visible decision, not an accident.
    const brain: any = makeBrain({
      traverseGraph: vi.fn(() => of(traverseResult([['a', 1]], [['e1', 'root', 'a']]))),
      listFacts: vi.fn(() => of({ facts: [
        { _id: 'both', linkEntities: ['root', 'a'] },
        { _id: 'to-only', linkEntities: ['a'] },        // kept: only `to` is checked
        { _id: 'from-only', linkEntities: ['root'] },   // dropped
      ] })),
      queryBrain: vi.fn(() => of({ results: [
        { _id: 'c-both', linkEntities: ['root', 'a'] },
        { _id: 'c-to-only', linkEntities: ['a'] },      // dropped: chrono requires both
      ], collection: 'chrono', count: 0 })),
    });
    const { c } = withGraph(brain);
    cy.fire('tap', 'edge', tapTarget('e1'));
    expect(c.nodeMemories().map((m: any) => m._id)).toEqual(['both', 'to-only']);
    expect(c.nodeChrono().map((x: any) => x._id)).toEqual(['c-both']);
  });
});

describe('GraphComponent — teardown', () => {
  it('destroys the cytoscape instance and drops the subscription bag', () => {
    // A leaked cy instance keeps its canvas, its listeners and the whole element graph alive; nothing
    // in the UI reports it.
    const { fixture, c } = create();
    const unsub = vi.spyOn((c as any).subs, 'unsubscribe');
    fixture.destroy();
    expect(cy.destroyed).toBe(1);
    expect(unsub).toHaveBeenCalled();
  });

  it('survives a second teardown without touching a destroyed instance', () => {
    const { fixture, c } = create();
    fixture.destroy();
    c.ngOnDestroy();
    expect(cy.destroyed).toBe(1);
  });
});
