/**
 * BrainApi list methods thread the slice-2b sort into the request as `?sort=&dir=` — and omit both
 * when no sort is active. This is the client half of slice 2a's server sort: the tab passes a
 * `ListSort`, the server orders the full set. If these params silently went missing, the header caret
 * would spin with no effect.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BrainApi } from './brain-api.service';

describe('BrainApi — list sort params (2b)', () => {
  let api: BrainApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BrainApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(BrainApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('listEntities appends sort + dir when a sort is given', () => {
    api.listEntities('work', 50, 0, undefined, { field: 'name', dir: 'asc' }).subscribe();
    const r = http.expectOne(req => req.url === '/api/brain/spaces/work/entities');
    expect(r.request.params.get('sort')).toBe('name');
    expect(r.request.params.get('dir')).toBe('asc');
    r.flush({ entities: [] });
  });

  it('listEntities sends NO sort/dir when none is given — the endpoint keeps its default order', () => {
    api.listEntities('work', 50, 0).subscribe();
    const r = http.expectOne(req => req.url === '/api/brain/spaces/work/entities');
    expect(r.request.params.has('sort')).toBe(false);
    expect(r.request.params.has('dir')).toBe(false);
    r.flush({ entities: [] });
  });

  it('listEdges / listFacts / listChrono all carry the sort', () => {
    api.listEdges('work', 50, 0, undefined, { field: 'label', dir: 'desc' }).subscribe();
    const e = http.expectOne(req => req.url === '/api/brain/spaces/work/edges');
    expect(e.request.params.get('sort')).toBe('label');
    expect(e.request.params.get('dir')).toBe('desc');
    e.flush({ edges: [] });

    api.listFacts('work', 20, 0, undefined, { field: 'createdAt', dir: 'desc' }).subscribe();
    const m = http.expectOne(req => req.url === '/api/brain/spaces/work/facts');
    expect(m.request.params.get('sort')).toBe('createdAt');
    m.flush({ facts: [], limit: 20, skip: 0 });

    api.listChrono('work', 50, 0, undefined, { field: 'startsAt', dir: 'asc' }).subscribe();
    const c = http.expectOne(req => req.url === '/api/brain/spaces/work/chrono');
    expect(c.request.params.get('sort')).toBe('startsAt');
    expect(c.request.params.get('dir')).toBe('asc');
    c.flush({ chrono: [] });
  });

  it('sort composes with existing filters rather than replacing them', () => {
    api.listEntities('work', 50, 0, { type: 'person', tag: 'vip' }, { field: 'createdAt', dir: 'desc' }).subscribe();
    const r = http.expectOne(req => req.url === '/api/brain/spaces/work/entities');
    expect(r.request.params.get('type')).toBe('person');
    expect(r.request.params.get('tag')).toBe('vip');
    expect(r.request.params.get('sort')).toBe('createdAt');
    r.flush({ entities: [] });
  });

  it('the docked freetext filter sends ?search= on entities/edges/facts, omitted when empty', () => {
    api.listEntities('work', 50, 0, undefined, undefined, 'kuber').subscribe();
    const e = http.expectOne(req => req.url === '/api/brain/spaces/work/entities');
    expect(e.request.params.get('search')).toBe('kuber');
    e.flush({ entities: [] });

    api.listEdges('work', 50, 0, undefined, undefined, 'mentor').subscribe();
    const g = http.expectOne(req => req.url === '/api/brain/spaces/work/edges');
    expect(g.request.params.get('search')).toBe('mentor');
    g.flush({ edges: [] });

    api.listFacts('work', 20, 0, undefined, undefined, 'deadline').subscribe();
    const m = http.expectOne(req => req.url === '/api/brain/spaces/work/facts');
    expect(m.request.params.get('search')).toBe('deadline');
    m.flush({ facts: [], limit: 20, skip: 0 });

    api.listEntities('work', 50, 0).subscribe();
    const none = http.expectOne(req => req.url === '/api/brain/spaces/work/entities');
    expect(none.request.params.has('search')).toBe(false);
    none.flush({ entities: [] });
  });

  it('entities keeps the exact `name` lookup (entity-search) distinct from the freetext `search`', () => {
    api.listEntities('work', 50, 0, { search: 'Alice' }, undefined, 'ali').subscribe();
    const r = http.expectOne(req => req.url === '/api/brain/spaces/work/entities');
    expect(r.request.params.get('name')).toBe('Alice'); // exact, from the entity-search bar
    expect(r.request.params.get('search')).toBe('ali');  // substring, from the column freetext filter
    r.flush({ entities: [] });
  });
});

/**
 * Per-column `description` filter reaches the request.
 *
 * The tab specs mock BrainApi, so they prove the tab CALLS it — not that the param survives into the
 * HTTP request. Dropping the `params.set` here would leave every one of those green while the column
 * filter did nothing.
 */
describe('BrainApi — description column filter', () => {
  let api: BrainApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BrainApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(BrainApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  const CASES: Array<[string, () => void, string, string]> = [
    ['listEntities', () => api.listEntities('work', 50, 0, { description: 'quarterly' }).subscribe(), '/api/brain/spaces/work/entities', 'entities'],
    ['listFacts', () => api.listFacts('work', 20, 0, { description: 'quarterly' }).subscribe(), '/api/brain/spaces/work/facts', 'facts'],
    ['listEdges',    () => api.listEdges('work', 50, 0, { description: 'quarterly' }).subscribe(),    '/api/brain/spaces/work/edges',    'edges'],
    ['listChrono',   () => api.listChrono('work', 50, 0, { description: 'quarterly' }).subscribe(),   '/api/brain/spaces/work/chrono',   'chrono'],
  ];

  for (const [name, call, url, key] of CASES) {
    it(`${name} sends ?description=`, () => {
      call();
      const r = http.expectOne(req => req.url === url);
      expect(r.request.params.get('description')).toBe('quarterly');
      // Not folded into `search` — that spans the name/fact/title column too.
      expect(r.request.params.get('search')).toBeNull();
      r.flush({ [key]: [] });
    });
  }

  it('omits the param when no description filter is set', () => {
    api.listEntities('work', 50, 0, {}).subscribe();
    const r = http.expectOne(req => req.url === '/api/brain/spaces/work/entities');
    expect(r.request.params.get('description')).toBeNull();
    r.flush({ entities: [] });
  });
});
