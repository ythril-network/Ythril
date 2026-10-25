/**
 * A resolve sends the kind and both versions it was listed at (Q-624, design rev 4 sections 9 and 10).
 *
 * The server now asks five parameters of every resolve, ALL REQUIRED, on both doors: `kind` (ids are unique per collection only, so an id alone
 * does not name a record), `forkId`, `keep`, `ifMatchSeq` (the fork's version as the list read it) and `ifMatchParentSeq` (the parent's). A resolve
 * that leaves one out is a `400`; one that sends the versions of a LATER read would defeat the guard they are. So the client sends the kind of the
 * row being resolved and the `seq` of its two versions as the list answered, never re-read at the click.
 *
 * Driven through the real `ReviewForksState` and `ForksApi` against a stubbed HTTP backend, so the spec names no method signature of either: it
 * reads what goes over the wire. Per kind, derived from the kinds the list answers with, so a fifth kind is covered the day it lists.
 *
 * Not covered, because the design leaves it open (see the report): what an ORPHANED fork sends as `ifMatchParentSeq`, having no parent.
 *
 * ## Seen red
 *
 * Red on b857da8f: the body is `{ keep }` alone, for every kind.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ToastService } from '../../core/toast.service';
import { ReviewForksState } from './review-forks-state';

const KINDS = ['fact', 'entity', 'chrono', 'edge'] as const;
const MAIN: Record<(typeof KINDS)[number], string> = { fact: 'fact', entity: 'name', chrono: 'title', edge: 'description' };

/** A row whose two versions carry DIFFERENT seqs, so a swap of the two is seen. */
const row = (kind: (typeof KINDS)[number], forkSeq: number, parentSeq: number) => ({
  kind, forkId: `fork-${kind}`, parentId: `parent-${kind}`,
  fork: { _id: `fork-${kind}`, seq: forkSeq, [MAIN[kind]]: 'theirs', tags: [] },
  parent: { _id: `parent-${kind}`, seq: parentSeq, [MAIN[kind]]: 'mine', tags: [] },
  orphaned: false, edgeCount: 0, linkCount: 0, siblings: 1, resolvedElsewhere: [],
});

describe('a resolve sends the kind and both versions', () => {
  let http: HttpTestingController;
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => { http?.match(() => true); });

  function setup() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [getTranslocoModule({ translation: { en: {} } })],
      providers: [ReviewForksState, provideHttpClient(), provideHttpClientTesting(),
        { provide: ToastService, useValue: { error: () => {}, success: () => {}, info: () => {}, show: () => {} } }],
    });
    http = TestBed.inject(HttpTestingController);
    return TestBed.inject(ReviewForksState);
  }

  /** Load a list that holds `r`, answering whatever list requests the state makes with the same answer. */
  function loaded(r: ReturnType<typeof row>) {
    const state = setup();
    state.load('work');
    const answer = {
      forks: [r], total: 1, skip: 0, limit: 25, maxForksPerRecord: 10,
      counts: Object.fromEntries(KINDS.map(k => [k, k === r.kind ? 1 : 0])),
      kinds: Object.fromEntries(KINDS.map(k => [k, { fields: [MAIN[k], 'tags'], mainField: MAIN[k] }])),
    };
    const lists = http.match(req => req.method === 'GET' && req.url.startsWith('/api/brain/spaces/work/forks'));
    expect(lists.length, 'loading asked for no list').toBeGreaterThan(0);
    lists.forEach(l => l.flush(answer));
    expect(state.rows().length, 'the row did not reach the state').toBe(1);
    return state;
  }

  for (const kind of KINDS) {
    for (const keep of ['fork', 'parent'] as const) {
      it(`${kind}, keep ${keep}: the body is the row's kind, the side, the fork's seq and the parent's seq`, () => {
        const state = loaded(row(kind, 7, 9));
        state.resolve('work', { forkId: `fork-${kind}`, kind, keep } as never);
        const post = http.expectOne(req => req.method === 'POST' && req.url === `/api/brain/spaces/work/forks/fork-${kind}/resolve`);
        expect(post.request.body).toEqual({ kind, keep, ifMatchSeq: 7, ifMatchParentSeq: 9 });
        post.flush({});
      });
    }
  }

  it('sends the kind of the ROW, whatever the request names: the row is what was listed', () => {
    const state = loaded(row('edge', 3, 4));
    state.resolve('work', { forkId: 'fork-edge', keep: 'parent' } as never);
    const post = http.expectOne(req => req.method === 'POST');
    expect(post.request.body.kind).toBe('edge');
    expect(post.request.body.ifMatchSeq).toBe(3);
    expect(post.request.body.ifMatchParentSeq).toBe(4);
    post.flush({});
  });

  it('sends the seqs of the row on screen, as its page was last read', () => {
    const state = loaded(row('fact', 7, 9));
    // The page is read again (a quiet reload) and the versions are newer: the row on screen is now that one, so those are the seqs a resolve
    // must name. Never the first read's, and never a re-read at the click.
    state.load('work', 0, true);
    http.match(req => req.method === 'GET').forEach(l => l.flush({ forks: [row('fact', 8, 10)], total: 1, skip: 0, limit: 25 }));
    state.resolve('work', { forkId: 'fork-fact', kind: 'fact', keep: 'fork' } as never);
    const post = http.expectOne(req => req.method === 'POST');
    expect(post.request.body).toEqual({ kind: 'fact', keep: 'fork', ifMatchSeq: 8, ifMatchParentSeq: 10 });
    post.flush({});
  });
});
