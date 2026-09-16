/**
 * QueryTabComponent — pins the query tab's OnPush contract and the pure result formatting, as it
 * moved out of BrainComponent (A17.9b-6a).
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { QueryTabComponent } from './query-tab.component';
import { isOnPush } from '../../testing/onpush';

function makeApi() {
  return {
    queryBrain: () => of({ results: [], count: 0 }),
    recallBrain: () => of({ results: [] }),
  } as any;
}

describe('QueryTabComponent', () => {
  function create() {
    TestBed.configureTestingModule({
      imports: [QueryTabComponent, getTranslocoModule()],
      providers: [
        BrainStore,
        { provide: BrainApi, useValue: makeApi() },
      ],
    });
    const fixture = TestBed.createComponent(QueryTabComponent);
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(QueryTabComponent)).toBe(true);
  });

  it('renders the query/recall panel', () => {
    const fixture = create();
    const panel = fixture.nativeElement.querySelector('.query-panel');
    expect(panel, 'the query panel should render').toBeTruthy();
  });

  it('a traversed neighbour is NOT a result — the ranked list holds what the server ranked', () => {
    /*
     * Reported by the owner: *"the graph entries seem to be included in rank and handed as main result
     * instead of part of a graph"*. The panel used to append every `_graph` node to the result list, so a
     * neighbour arrived looking exactly like a match — in rank order, counted in the total, carrying a
     * `source: 'traverse'` marker that nothing rendered.
     *
     * It matters more here than it would elsewhere, and that is the owner's second point: **this panel is
     * the surface people test queries on.** A request tried here and then sent by an MCP client has to come
     * back the same shape, or the panel teaches a contract the product does not have.
     */
    TestBed.resetTestingModule();
    const match = {
      _id: 'e1', type: 'entity', name: 'Vault', score: 0.9,
      _graph: [
        { node: { _id: 'm1', kind: 'fact', fact: 'a note' }, edge: { label: 'fact.entityIds' }, paths: [['e1', 'm1']] },
        { node: { _id: 'c1', kind: 'chrono', title: 'an event' }, edge: { label: 'chrono.entityIds' }, paths: [['e1', 'c1']] },
      ],
    };
    TestBed.configureTestingModule({
      imports: [QueryTabComponent, getTranslocoModule()],
      providers: [
        BrainStore,
        { provide: BrainApi, useValue: {
          queryBrain: () => of({ results: [], count: 0 }),
          recallBrain: () => of({ results: [match] }),
        } as never },
      ],
    });
    const fixture = TestBed.createComponent(QueryTabComponent);
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.detectChanges();

    const c = fixture.componentInstance;
    c.recallForm.query = 'vault';
    c.runRecall();
    fixture.detectChanges();

    expect(c.recallResults().length, 'two neighbours were counted as matches').toBe(1);
    expect(c.recallResults()[0]!['_id']).toBe('e1');

    // …and the record keeps its own graph, so what the panel shows is what the API returned.
    const rel = c.relatedOf(c.recallResults()[0]!);
    expect(rel.total).toBe(2);
    expect(rel.facts.map(r => r.record['_id'])).toEqual(['m1']);
    expect(rel.chronos.map(r => r.record['_id'])).toEqual(['c1']);
  });

  it('a search that matched nothing SAYS so, and an unasked one stays quiet', () => {
    /*
     * The bug this pins, reported by the owner: semantic search rendered nothing at all when a search
     * matched nothing — identical to the panel before any search — so the natural reading was that the
     * button had not worked. The advanced-query side never had this, because it keeps the whole response
     * and can render `results.length === 0`; this side keeps only the array, and an empty array cannot say
     * which of the two states it is.
     *
     * Both directions are asserted. A message that is simply always present would pass a test for the bug
     * and be a different bug.
     */
    const fixture = create();
    const c = fixture.componentInstance;

    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.query-empty'), 'nothing has been searched yet').toBeFalsy();

    c.recallForm.query = 'something that matches nothing';
    c.runRecall();
    fixture.detectChanges();

    expect(c.recallRan()).toBe(true);
    expect(c.recallResults()).toEqual([]);
    expect(fixture.nativeElement.querySelector('.query-empty'),
      'a completed search with no matches must say so').toBeTruthy();

    // …and clearing puts it back to "not asked", rather than leaving a stale verdict on screen.
    c.clearRecall();
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('.query-empty')).toBeFalsy();
  });

  it('an ERROR is not reported as "no matches" — the search did not finish', () => {
    // Two different things about one click. A failed search found nothing because it never ran, and saying
    // "no records matched" beside an error message tells the reader the opposite of what happened.
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [QueryTabComponent, getTranslocoModule()],
      providers: [
        BrainStore,
        { provide: BrainApi, useValue: {
          queryBrain: () => of({ results: [], count: 0 }),
          recallBrain: () => throwError(() => ({ error: { error: 'boom' } })),
        } as never },
      ],
    });
    const fixture = TestBed.createComponent(QueryTabComponent);
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.detectChanges();

    const c = fixture.componentInstance;
    c.recallForm.query = 'anything';
    c.runRecall();
    fixture.detectChanges();

    expect(c.recallError()).toBe('boom');
    expect(c.recallRan()).toBe(false);
    expect(fixture.nativeElement.querySelector('.query-empty')).toBeFalsy();
  });

  it('runRecall is a no-op for a blank query (no API call)', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    c.recallForm.query = '   ';
    c.runRecall();
    expect(c.recallRunning()).toBe(false);
    expect(c.recallResults()).toEqual([]);
  });

  it('runQuery surfaces an invalid-JSON filter as a form error rather than calling the API', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    c.queryForm.filter = '{ not valid json ';
    c.runQuery();
    expect(c.queryFilterError()).toContain('Invalid JSON');
    expect(c.queryRunning()).toBe(false);
  });
});

/**
 * The recall panel is the only surface that exposes what MCP's `recall` accepts, and two of its parameters
 * were reachable through the REST route and declared nowhere on the client: `traverse` (graph expansion) and
 * `maxTimeMS` (the partial-answer deadline). A third gap was the jump the entities and edges tabs already
 * offer — a recall hit for an entity had no way into the graph.
 */
describe('QueryTabComponent — recall parameter coverage', () => {
  let sent: Record<string, unknown> | null;

  function create() {
    sent = null;
    TestBed.configureTestingModule({
      imports: [QueryTabComponent, getTranslocoModule()],
      providers: [
        BrainStore,
        { provide: BrainApi, useValue: {
          queryBrain: () => of({ results: [], count: 0 }),
          recallBrain: (_s: string, body: Record<string, unknown>) => { sent = body; return of({ results: [] }); },
        } as any },
      ],
    });
    const fixture = TestBed.createComponent(QueryTabComponent);
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('sends the traversal as an OBJECT, and maxTimeMS, when set', () => {
    /*
     * **A deliberate edit: this asserted `traverse: 2`, a bare number.**
     *
     * The route accepts either shape, and the number reached the depth and nothing else — so `direction`,
     * `edgeLabels` and the three `include*` flags were unreachable from this panel however the rest of the
     * request was written. `U-1` sends the object, so the same depth now reads as `{ depth: 2 }`.
     */
    const c = create().componentInstance;
    c.recallForm.query = 'auth token scoping';
    c.recallForm.depth = 2;
    c.recallForm.maxTimeMS = 1500;
    c.runRecall();
    expect(sent!['traverse']).toEqual({ depth: 2 });
    expect(sent!['maxTimeMS']).toBe(1500);
  });
  it('omits both at 0 — a zero deadline is not a legal value and traverse 0 is the server default', () => {
    const c = create().componentInstance;
    c.recallForm.query = 'q';
    c.runRecall();
    expect('traverse' in sent!).toBe(false);
    expect('maxTimeMS' in sent!).toBe(false);
  });

  it('graphTargetOf gives entities their own id and edges the entity they start from', () => {
    const c = create().componentInstance;
    expect(c.graphTargetOf({ type: 'entity', _id: 'e1' } as never)).toBe('e1');
    expect(c.graphTargetOf({ type: 'edge', from: 'e2', _id: 'edge1' } as never)).toBe('e2');
  });

  it('graphTargetOf refuses a hit with no node, so no button is offered', () => {
    const c = create().componentInstance;
    expect(c.graphTargetOf({ type: 'fact', _id: 'm1' } as never)).toBe(null);
    expect(c.graphTargetOf({ type: 'chrono', _id: 'c1' } as never)).toBe(null);
    expect(c.graphTargetOf({ type: 'file', _id: 'f1' } as never)).toBe(null);
    expect(c.graphTargetOf({ type: 'entity' } as never)).toBe(null);      // no id at all
    expect(c.graphTargetOf({ type: 'entity', _id: '' } as never)).toBe(null);
  });

  it('an entity hit renders the view-in-graph button and emits the id', () => {
    const fixture = create();
    const c = fixture.componentInstance;
    let emitted: string | null = null;
    c.viewInGraph.subscribe((id: string) => { emitted = id; });
    c.recallResults.set([{ type: 'entity', score: 0.9, _id: 'e1', name: 'Ada' } as never]);
    fixture.detectChanges();
    const btn = fixture.nativeElement.querySelector('button[aria-label="common.viewInGraph"]');
    expect(btn, 'an entity recall hit should offer the graph jump').toBeTruthy();
    btn.click();
    expect(emitted).toBe('e1');
  });

  it('a memory hit renders NO view-in-graph button', () => {
    const fixture = create();
    fixture.componentInstance.recallResults.set([{ type: 'fact', score: 0.9, _id: 'm1', fact: 'f' } as never]);
    fixture.detectChanges();
    expect(fixture.nativeElement.querySelector('button[aria-label="common.viewInGraph"]')).toBeNull();
  });
});
