/**
 * The graph view reads a traversal to its end, not only the page the byte budget let through (`Q-109`).
 *
 * `graph_traverse` pages its nodes under the byte budget since `Q-132`, and says so with `nextSkip`. The client sent
 * no `skip`, so a large neighbourhood came back as its first page and the graph drew a part of it under a canvas that
 * promises the whole. Owner rule, 2026-09-28: *"if i get a result i want to be sure i get what i asked for"*.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BrainApi } from './brain-api.service';
import type { TraverseResult } from './api.types';

const node = (id: string) => ({ _id: id, name: id, type: 't', depth: 1 });
const edge = (id: string) => ({ _id: id, from: 'a', to: id, label: 'l' });

describe('BrainApi.traverseGraph reads every page (Q-109)', () => {
  let api: BrainApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BrainApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(BrainApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('follows nextSkip and joins the pages, in order', () => {
    let got: TraverseResult | undefined;
    api.traverseGraph('work', { startId: 'a', maxDepth: 2 }).subscribe(r => { got = r; });

    const first = http.expectOne('/api/brain/spaces/work/traverse');
    expect(first.request.body.skip ?? 0).toBe(0);
    first.flush({ nodes: [node('a'), node('b')], edges: [edge('b')], truncated: true, nextSkip: 2, limitReached: false });
    const second = http.expectOne('/api/brain/spaces/work/traverse');
    expect(second.request.body.skip).toBe(2);
    second.flush({ nodes: [node('c')], edges: [edge('c')], truncated: false, limitReached: false });

    expect(got?.nodes.map(n => n._id)).toEqual(['a', 'b', 'c']);
    expect(got?.edges.map(e => e._id)).toEqual(['b', 'c']);
    expect(got?.truncated, 'every page was read, so nothing the walk found is missing').toBe(false);
  });

  it('still says truncated when the WALK was cut, which reading on cannot reach', () => {
    let got: TraverseResult | undefined;
    api.traverseGraph('work', { startId: 'a' }).subscribe(r => { got = r; });
    http.expectOne('/api/brain/spaces/work/traverse')
      .flush({ nodes: [node('a')], edges: [], truncated: true, limitReached: true });
    expect(got?.truncated, 'a walk that hit its limit is a partial graph').toBe(true);
  });
});
