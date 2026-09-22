/**
 * Every list method sends its sort, its filters and its freetext — and omits each when unset.
 *
 * ## What changed under these cases, and what did not
 *
 * They used to assert query params on five per-collection `GET` routes. `B-9` step 2b moved every tab
 * onto the `filter` tool, so the assertions are against a BODY now. The rules are the same ones:
 * the sort reaches the request, an absent sort sends nothing rather than a default, filters compose with
 * it instead of replacing it, and the freetext goes as `search`.
 *
 * **Restated rather than deleted.** A caret that spins with no effect is what these exist for, and that
 * failure is identical on either shape — so the cases had to survive the move, which is also the check
 * that the move preserved them.
 *
 * ## Why the envelope is re-keyed in the service
 *
 * `filter` answers `{ results }` and the tabs destructure `{ entities }`, `{ edges }`, `{ facts }`,
 * `{ chrono }`. The service re-keys, so not one caller changed — which is what makes deleting the nine
 * routes a server-only change afterwards. The `flush` calls below therefore send `results`.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { BrainApi } from './brain-api.service';

describe('BrainApi — list sort, filters and freetext reach `filter` (2b)', () => {
  let api: BrainApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BrainApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(BrainApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  /** The one request every list method now makes, with the collection it asked for. */
  const expectFilter = (collection: string) => {
    const r = http.expectOne(req => req.url === '/api/filter');
    const body = r.request.body as Record<string, unknown>;
    expect(body['collection']).toBe(collection);
    return { r, body };
  };
  const flush = (r: TestRequest) =>
    r.flush({ ok: true, data: { results: [], total: 0, limit: 50, skip: 0, truncated: false } });

  it('listEntities sends sort + dir when a sort is given', () => {
    api.listEntities('work', 50, 0, undefined, { field: 'name', dir: 'asc' }).subscribe();
    const { r, body } = expectFilter('entities');
    expect(body['space']).toBe('work');
    expect(body['sort']).toBe('name');
    expect(body['dir']).toBe('asc');
    flush(r);
  });

  it('and NOTHING when none is given — the endpoint keeps its default order', () => {
    // Sending a sort nobody chose would silently reorder every tab that does not set one.
    api.listEntities('work', 50, 0).subscribe();
    const { r, body } = expectFilter('entities');
    expect('sort' in body).toBe(false);
    expect('dir' in body).toBe(false);
    flush(r);
  });

  it('listEdges / listFacts / listChrono all carry the sort', () => {
    api.listEdges('work', 50, 0, undefined, { field: 'label', dir: 'desc' }).subscribe();
    const e = expectFilter('edges');
    expect(e.body['sort']).toBe('label');
    expect(e.body['dir']).toBe('desc');
    flush(e.r);

    api.listFacts('work', 20, 0, undefined, { field: 'createdAt', dir: 'desc' }).subscribe();
    const m = expectFilter('facts');
    expect(m.body['sort']).toBe('createdAt');
    flush(m.r);

    api.listChrono('work', 50, 0, undefined, { field: 'startsAt', dir: 'asc' }).subscribe();
    const c = expectFilter('chrono');
    expect(c.body['sort']).toBe('startsAt');
    expect(c.body['dir']).toBe('asc');
    flush(c.r);
  });

  it('sort composes with existing filters rather than replacing them', () => {
    api.listEntities('work', 50, 0, { type: 'person', tag: 'vip' }, { field: 'createdAt', dir: 'desc' }).subscribe();
    const { r, body } = expectFilter('entities');
    expect(body['type']).toBe('person');
    expect(body['tag']).toBe('vip');
    expect(body['sort']).toBe('createdAt');
    flush(r);
  });

  it('the docked freetext goes as `search` on entities/edges/facts, omitted when empty', () => {
    for (const [call, collection, term] of [
      [() => api.listEntities('work', 50, 0, undefined, undefined, 'kuber').subscribe(), 'entities', 'kuber'],
      [() => api.listEdges('work', 50, 0, undefined, undefined, 'mentor').subscribe(), 'edges', 'mentor'],
      [() => api.listFacts('work', 20, 0, undefined, undefined, 'deadline').subscribe(), 'facts', 'deadline'],
    ] as [() => void, string, string][]) {
      call();
      const { r, body } = expectFilter(collection);
      expect(body['search']).toBe(term);
      flush(r);
    }

    api.listEntities('work', 50, 0).subscribe();
    const { r, body } = expectFilter('entities');
    expect('search' in body).toBe(false);
    flush(r);
  });

  it('the entity search bar is an EXACT name, not the substring freetext', () => {
    // Two different questions that have always shared a spelling in this signature: `filters.search` is
    // the picker's exact lookup and goes as a predicate, `search` is the column box and goes as the
    // convenience. Folding them would make the picker match everything containing the name.
    api.listEntities('work', 50, 0, { search: 'Ada Lovelace' }).subscribe();
    const { r, body } = expectFilter('entities');
    expect(body['filter']).toEqual({ name: 'Ada Lovelace' });
    expect('search' in body).toBe(false);
    flush(r);
  });

  it('a fact filtered by entity id goes as a predicate on its link field', () => {
    api.listFacts('work', 20, 0, { entity: 'e-1' }).subscribe();
    const { r, body } = expectFilter('facts');
    expect(body['filter']).toEqual({ linkEntities: 'e-1' });
    flush(r);
  });

  it('chrono always asks for the DERIVED status', () => {
    /*
     * The reason this tab could not move until `B-8` and `B-19`. A chrono status is derived on read, and
     * `filter` returns the stored one unless asked — so without this the tab would quietly stop showing
     * `overdue`, and its status filter would start returning entries the old route excluded.
     */
    api.listChrono('work', 50, 0, { status: 'active' }).subscribe();
    const { r, body } = expectFilter('chrono');
    expect(body['deriveStatus']).toBe(true);
    expect(body['filter']).toEqual({ status: 'active' });
    flush(r);
  });

  it('chrono tag sets stay EXACT, and both together intersect', () => {
    // `tags` is ALL and `tagsAny` is at-least-one. Widening either to the substring convenience would
    // over-match silently, which is the distinction the server has always drawn.
    api.listChrono('work', 50, 0, { tags: 'a, b', tagsAny: 'c' }).subscribe();
    const { r, body } = expectFilter('chrono');
    expect(body['filter']).toEqual({ $and: [{ tags: { $all: ['a', 'b'] } }, { tags: { $in: ['c'] } }] });
    flush(r);
  });

  it('and a chrono date range becomes one predicate, not two', () => {
    api.listChrono('work', 50, 0, { after: '2026-01-01', before: '2026-12-31' }).subscribe();
    const { r, body } = expectFilter('chrono');
    expect(body['filter']).toEqual({ createdAt: { $gt: '2026-01-01', $lt: '2026-12-31' } });
    flush(r);
  });

  it('a by-id read goes through `filter` too, and a chrono one DERIVES its status', () => {
    /*
     * `B-9` step 3a deleted `GET .../<collection>/:id`. Two things had to survive the move and both are
     * silent when dropped: a chrono status is derived on read, and a record that is not there has to reach
     * the caller's error path rather than its success path with `undefined` in it.
     */
    api.getEntity('work', 'e-1').subscribe();
    const e = expectFilter('entities');
    expect(e.body['filter']).toEqual({ _id: 'e-1' });
    expect('deriveStatus' in e.body).toBe(false);
    e.r.flush({ ok: true, data: { results: [{ _id: 'e-1' }], total: 1, limit: 1, skip: 0, truncated: false } });

    api.getChrono('work', 'c-1').subscribe();
    const c = expectFilter('chrono');
    expect(c.body['deriveStatus']).toBe(true);
    c.r.flush({ ok: true, data: { results: [{ _id: 'c-1' }], total: 1, limit: 1, skip: 0, truncated: false } });
  });

  it('and a record that is not there reaches the ERROR path, not the success path', () => {
    // The routes answered 404. `filter` answers an empty page, and a caller reading `results[0]` would draw
    // its panel from `undefined` — which is why the absent case throws inside the service.
    let err: unknown = null;
    let value: unknown = 'untouched';
    api.getEntity('work', 'gone').subscribe({ next: v => { value = v; }, error: e => { err = e; } });
    const { r } = expectFilter('entities');
    r.flush({ ok: true, data: { results: [], total: 0, limit: 1, skip: 0, truncated: false } });
    expect(err).toBeTruthy();
    expect(value).toBe('untouched');
  });
  it('the answer is re-keyed for the caller, and the paging fields survive', () => {
    // A pager that lost `total` would page for ever; a tab that got `results` would render nothing.
    let seen: { entities?: unknown[]; total?: number } = {};
    api.listEntities('work', 50, 0).subscribe(v => { seen = v as typeof seen; });
    const { r } = expectFilter('entities');
    r.flush({ ok: true, data: { results: [{ _id: 'e1' }], total: 7, limit: 50, skip: 0, truncated: true } });
    expect(seen.entities).toEqual([{ _id: 'e1' }]);
    expect(seen.total).toBe(7);
  });
});
