/**
 * The graph never draws a depth the slider no longer shows (`Q-112`).
 *
 * The depth slider started a traversal on every step it passed through, with no debounce and without cancelling
 * the one in flight, so the answers arrived in whatever order the server finished them — and the LAST to arrive
 * was drawn. Drag from 2 to 4, and a slow depth-3 answer landing after the depth-4 one left three hops on the
 * canvas under a slider reading 4. The cache made a second path to the same wrong picture: a shallower depth is
 * drawn from the cache at once, and the deeper request still in flight then redrew its own depth over it.
 *
 * Every case resolves the answers OUT of order — the only order that shows the defect.
 */
import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of, Subject } from 'rxjs';
import { ActivatedRoute } from '@angular/router';

vi.mock('cytoscape', () => {
  const chain: any = new Proxy(() => chain, { get: () => () => chain });
  return { default: () => chain };
});

import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { GraphComponent } from './graph.component';

/** A traversal answer that reaches `depth` hops: one node per hop, chained from the root. */
function reach(depth: number) {
  const nodes = Array.from({ length: depth }, (_, i) => ({ _id: `n${i + 1}`, name: `N${i + 1}`, type: 't', depth: i + 1 }));
  const edges = nodes.map((n, i) => ({ _id: `e${i + 1}`, from: i === 0 ? 'root' : `n${i}`, to: n._id, label: 'next' }));
  return { nodes, edges, truncated: false };
}

describe('GraphComponent — the latest depth wins (Q-112)', () => {
  let pending: Subject<unknown>[];
  let traverseGraph: ReturnType<typeof vi.fn>;

  function create() {
    pending = [];
    traverseGraph = vi.fn(() => { const s = new Subject<unknown>(); pending.push(s); return s; });
    const api = {
      getMe: () => of({ readOnly: false }), listSpaces: () => of({ spaces: [] }), getSpaceMeta: () => of({ typeSchemas: {} }),
      getEntity: () => of(null), getRecord: () => of(null), traverseGraph,
    } as any;
    TestBed.configureTestingModule({
      imports: [GraphComponent, getTranslocoModule()],
      providers: [
        { provide: SpacesApi, useValue: api }, { provide: BrainApi, useValue: api }, { provide: AuthApi, useValue: api },
        { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
      ],
    });
    const fixture = TestBed.createComponent(GraphComponent);
    fixture.componentRef.setInput('embeddedSpaceId', 'work');
    fixture.detectChanges();
    const c = fixture.componentInstance;
    // Root at depth 2 and answer it, so the cache holds two hops.
    c.selectRoot({ _id: 'root', name: 'Root', type: 't' } as any);
    pending[0]!.next(reach(2)); pending[0]!.complete();
    return { fixture, c };
  }

  const answer = (i: number, depth: number) => { pending[i]!.next(reach(depth)); pending[i]!.complete(); };
  /** Nodes on the canvas: the root plus every reached node within the depth drawn. */
  const drawnDepth = (c: GraphComponent) => c.nodeCount() - 1;

  beforeEach(() => { TestBed.resetTestingModule(); vi.useFakeTimers(); });
  afterEach(() => { vi.useRealTimers(); });

  it('a slower, older depth does not redraw over the newer one', () => {
    const { c } = create();
    c.onDepthChange(3); vi.advanceTimersByTime(1000);
    c.onDepthChange(4); vi.advanceTimersByTime(1000);
    expect(pending.length, 'each settled depth asks once').toBe(3);
    answer(2, 4);   // the newer answer lands first…
    answer(1, 3);   // …and the older one after it
    expect(c.depth()).toBe(4);
    expect(drawnDepth(c), 'the canvas shows a depth the slider does not').toBe(4);
  });

  it('a depth drawn from the cache is not redrawn by the deeper request still in flight', () => {
    const { c } = create();
    c.onDepthChange(5); vi.advanceTimersByTime(1000);   // needs the network
    c.onDepthChange(1); vi.advanceTimersByTime(1000);   // drawn from the cache at once
    expect(drawnDepth(c)).toBe(1);
    if (pending[1]) answer(1, 5);                        // the depth-5 answer arrives late
    expect(c.depth()).toBe(1);
    expect(drawnDepth(c), 'the late depth-5 answer redrew over the slider at 1').toBe(1);
  });

  it('dragging across several steps asks once, for where the slider stopped', () => {
    const { c } = create();
    for (const d of [3, 4, 5, 6, 7]) { c.onDepthChange(d); vi.advanceTimersByTime(40); }
    vi.advanceTimersByTime(1000);
    expect(traverseGraph).toHaveBeenCalledTimes(2);   // the root, then depth 7 — not five
    expect(traverseGraph.mock.calls[1]![1]).toEqual(expect.objectContaining({ maxDepth: 7 }));
  });
});
