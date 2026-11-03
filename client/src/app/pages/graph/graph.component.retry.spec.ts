/**
 * The graph's Retry works after a graph was drawn, and the failure shows no stale graph (Q-209).
 *
 * A traversal that fails AFTER a graph was drawn (a deeper depth that times out) leaves cytoscape's drawn nodes on the canvas. The error block
 * is `.canvas-empty`, which declares `pointer-events: none` so the empty state never eats a click meant for the canvas, and Retry inherited it:
 * the click went through to the stale canvas. The cy container was also still `visible`, so the page showed a graph the error said it could not load.
 *
 * What the page owes (design v5, slice U):
 *
 *  - the cy container is hidden while there is an error OR a load in flight, by the INLINE `[style.visibility]` binding (a stylesheet rule cannot beat
 *    an inline style), so a retry does not flash the old graph either;
 *  - the error block takes clicks again (`.canvas-empty app-error-state` is `pointer-events: auto`), and nothing between the Retry button and the
 *    canvas zone declares `pointer-events: none` on it;
 *  - the toolbar's node/edge count, the side panel and Fit / Reset do not describe a graph that is not shown;
 *  - the Retry button is where the keyboard is when it is pressed, and the page must not drop the focus to <body> when the button goes: focus moves
 *    to the loading overlay, then to the canvas on success or to the error's Retry on a second failure.
 *
 * The cytoscape double is the chainable no-op of `graph.component.spec.ts`: the behaviour is on the Angular side of that boundary. The assertions read
 * the DOM (inline style through `getComputedStyle`, declared rules through `declaredNearest`, `document.activeElement`), never a component signal.
 */
import { vi, describe, it, expect, beforeEach } from 'vitest';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { Subject, of, throwError } from 'rxjs';
import { ActivatedRoute } from '@angular/router';

vi.mock('cytoscape', () => {
  const chain: any = new Proxy(() => chain, { get: () => () => chain });
  return { default: () => chain };
});

import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { declaredNearest } from '../../testing/declared-style';
import { GraphComponent } from './graph.component';

const ROOT = { _id: 'root', name: 'Ada', type: 'person' } as any;

const result = (ids: string[]) => ({
  nodes: ids.map((id, i) => ({ _id: id, name: id, type: 'thing', depth: i })),
  edges: ids.slice(1).map((id, i) => ({ _id: `e${i}`, from: ids[0], to: id, label: 'rel' })),
  truncated: false,
});

/** A page showing a drawn graph; each later traversal answers as `later` says. */
function mount(later: (call: number) => any) {
  let call = 0;
  const brain: any = {
    traverseGraph: vi.fn(() => (call++ === 0 ? of(result(['root', 'a'])) : later(call))),
    getEntity: vi.fn(() => of(null)), getRecord: vi.fn(() => of(null)), getEdge: vi.fn(() => of(null)), getMemory: vi.fn(() => of(null)),
    getChrono: vi.fn(() => of(null)), listFacts: vi.fn(() => of({ facts: [] })), queryBrain: vi.fn(() => of({ results: [], collection: 'chrono', count: 0 })),
    chronoLinkedTo: vi.fn(() => of([])),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [GraphComponent, getTranslocoModule()],
    providers: [
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }), getSpaceMeta: () => of({ typeSchemas: {} }) } },
      { provide: BrainApi, useValue: brain },
      { provide: AuthApi, useValue: { getMe: () => of({ readOnly: false }) } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParams: {} } } },
    ],
  });
  const fixture = TestBed.createComponent(GraphComponent);
  fixture.componentRef.setInput('embeddedSpaceId', 'work');
  fixture.detectChanges();
  const c: any = fixture.componentInstance;
  c.selectRoot(ROOT);
  fixture.detectChanges();
  return { fixture, c, brain };
}

/** The depth slider moves deeper and rests: the deeper request is the one that fails. */
function deeper(c: any, depth = 4): void {
  vi.useFakeTimers();
  try { c.onDepthChange(depth); vi.advanceTimersByTime(1000); } finally { vi.useRealTimers(); }
}

const el = (f: ComponentFixture<unknown>): HTMLElement => f.nativeElement as HTMLElement;
const q = <T extends Element = HTMLElement>(f: ComponentFixture<unknown>, sel: string): T | null => el(f).querySelector<T>(sel);

/** A drawn graph whose deeper depth failed: the state Q-209 is about. */
function failedAfterDrawn() {
  const page = mount(() => throwError(() => ({ status: 500, message: 'boom' })));
  deeper(page.c);
  page.fixture.detectChanges();
  return page;
}

beforeEach(() => TestBed.resetTestingModule());

describe('a failed deeper traversal after a drawn graph (Q-209)', () => {
  it('the drawn graph is on the page before the failure, so the cases below are about hiding it', () => {
    const { fixture } = mount(() => of(result(['root', 'a'])));
    expect(getComputedStyle(q(fixture, '.cy-container')!).visibility).toBe('visible');
    expect(q(fixture, '.graph-stats'), 'the toolbar counts the drawn graph').toBeTruthy();
  });

  it('shows the error with a Retry button', () => {
    const { fixture } = failedAfterDrawn();
    expect(q(fixture, '.canvas-empty .retry-btn')).toBeTruthy();
  });

  it('hides the cy container, by the inline visibility the page binds (computed visibility is hidden)', () => {
    const { fixture } = failedAfterDrawn();
    const canvas = q(fixture, '.cy-container')!;
    expect(getComputedStyle(canvas).visibility, 'the stale graph is not shown beside an error that says it could not load').toBe('hidden');
  });

  it('the Retry button is not under a pointer-events: none box: nothing from the button up to the canvas zone declares it', () => {
    const { fixture } = failedAfterDrawn();
    const retry = q(fixture, '.canvas-empty .retry-btn')!;
    const zone = q(fixture, '.canvas-zone')!;
    // Control: the empty-state block still ignores the pointer on its own (the rule that exists so the empty state never eats a canvas click).
    expect(declaredNearest(q(fixture, '.canvas-empty')!, 'pointer-events', zone), 'the .canvas-empty rule is read').toBe('none');
    expect(declaredNearest(retry, 'pointer-events', zone), 'a click on Retry reaches Retry').not.toBe('none');
  });

  it('the toolbar does not count nodes that are not shown', () => {
    const { fixture } = failedAfterDrawn();
    expect(q(fixture, '.graph-stats'), 'no "2 nodes" for a graph the page hides').toBeNull();
  });

  it('a node selected on the hidden canvas opens no side panel', () => {
    const { fixture, c } = failedAfterDrawn();
    // A tap that cytoscape delivered while the error shows (the canvas is still live under it): the page must not describe a node it hides.
    c.selectedNode.set({ _id: 'a', name: 'a', type: 'thing', depth: 1 });
    fixture.detectChanges();
    expect(q(fixture, '.side-panel'), 'no panel about a node on a hidden canvas').toBeNull();
  });

  it('Fit and Reset are disabled while the graph is not shown', () => {
    const { fixture } = failedAfterDrawn();
    const buttons = [...el(fixture).querySelectorAll<HTMLButtonElement>('app-graph-toolbar .toolbar-btn')];
    expect(buttons.length, 'Fit and Reset').toBe(2);
    for (const b of buttons) expect(b.disabled, b.getAttribute('title') ?? '').toBe(true);
  });
});

describe('Retry (Q-209)', () => {
  it('hides the graph while the retry is in flight, so the old graph does not flash', () => {
    const gate = new Subject<any>();
    let n = 0;
    const { fixture, c } = mount(() => (n++ === 0 ? throwError(() => ({ status: 500 })) : gate));
    deeper(c);
    fixture.detectChanges();
    q(fixture, '.retry-btn')!.click();
    fixture.detectChanges();
    expect(q(fixture, '.loading-overlay'), 'the retry is loading').toBeTruthy();
    expect(getComputedStyle(q(fixture, '.cy-container')!).visibility).toBe('hidden');
  });

  it('keeps the focus on the page: it moves to the loading overlay, not to <body>', async () => {
    const gate = new Subject<any>();
    let n = 0;
    const { fixture, c } = mount(() => (n++ === 0 ? throwError(() => ({ status: 500 })) : gate));
    deeper(c);
    fixture.detectChanges();
    const retry = q<HTMLButtonElement>(fixture, '.retry-btn')!;
    retry.focus();
    expect(document.activeElement).toBe(retry);
    retry.click();
    fixture.detectChanges();
    await vi.waitFor(() => {
      fixture.detectChanges();
      const active = document.activeElement as HTMLElement | null;
      expect(active, 'something has the focus').toBeTruthy();
      expect(active, 'not the page body').not.toBe(document.body);
      expect(active!.closest('.loading-overlay'), 'the loading overlay holds the focus while it loads').toBeTruthy();
    }, { timeout: 1500 });
  });

  it('after a second failure the focus is on the error\'s Retry again', async () => {
    const gate = new Subject<any>();
    let n = 0;
    const { fixture, c } = mount(() => (n++ === 0 ? throwError(() => ({ status: 500 })) : gate));
    deeper(c);
    fixture.detectChanges();
    const first = q<HTMLButtonElement>(fixture, '.retry-btn')!;
    first.focus();
    first.click();
    fixture.detectChanges();
    gate.error({ status: 500, message: 'still down' });
    await vi.waitFor(() => {
      fixture.detectChanges();
      const active = document.activeElement as HTMLElement | null;
      expect(active?.classList.contains('retry-btn'), 'the Retry button of the new error').toBe(true);
    }, { timeout: 1500 });
  });

  it('after a success the focus is inside the canvas zone, not on <body>', async () => {
    const gate = new Subject<any>();
    let n = 0;
    const { fixture, c } = mount(() => (n++ === 0 ? throwError(() => ({ status: 500 })) : gate));
    deeper(c);
    fixture.detectChanges();
    const retry = q<HTMLButtonElement>(fixture, '.retry-btn')!;
    retry.focus();
    retry.click();
    fixture.detectChanges();
    gate.next(result(['root', 'a', 'b']));
    gate.complete();
    await vi.waitFor(() => {
      fixture.detectChanges();
      const active = document.activeElement as HTMLElement | null;
      expect(active, 'not the page body').not.toBe(document.body);
      expect(q(fixture, '.canvas-zone')!.contains(active), 'on the canvas zone').toBe(true);
    }, { timeout: 1500 });
    expect(getComputedStyle(q(fixture, '.cy-container')!).visibility, 'the graph is back').toBe('visible');
  });

  it('control: activating Retry (a button, so Enter and Space too) runs the last traversal again', () => {
    let n = 0;
    const { fixture, c, brain } = mount(() => (n++ === 0 ? throwError(() => ({ status: 500 })) : of(result(['root', 'a', 'b']))));
    deeper(c);
    fixture.detectChanges();
    const calls = brain.traverseGraph.mock.calls.length;
    const retry = q<HTMLButtonElement>(fixture, '.retry-btn')!;
    retry.focus();
    retry.click();
    expect(brain.traverseGraph.mock.calls.length).toBe(calls + 1);
  });
});
