/**
 * The conversion calls (bundle-285, plan section 6): what each asks on the wire, how it reads what the server answers, and how each
 * refusal the plan names comes back — as a typed outcome a page can word, never a thrown string.
 *
 * ## The contract this spec fixes for the pages (the plan names the routes; the method names are chosen here and listed in the hand-off)
 *
 * - `start(spaceId, types, steps?)`           POST   /api/spaces/:id/schema-convert            { types, steps? }       -> 202 ConvertStartAnswer
 * - `status(spaceId)`                         GET    /api/spaces/:id/schema-convert                                    -> ConvertStatusAnswer
 * - `refusedCount(spaceId)`                   GET    /api/spaces/:id/schema-convert/items?reason=step_refused&limit=1  -> total, or null
 * - `listUnconverted(spaceId, query)`         GET    /api/spaces/:id/schema-convert/items?kind&type&reason=a,b&status&skip&limit
 * - `dismissOne(spaceId, itemId)`             POST   /api/spaces/:id/schema-convert/items/:itemId/dismiss
 * - `dismissShown(spaceId, request)`          POST   /api/spaces/:id/schema-convert/items/dismiss { kind?, type?, reason?: [...], expect }
 * - `countsFor(spaceId, block)`               POST   /api/filter (the `filter` tool) once for the total and once for the rewritten
 * - `olderCount(spaceId, kind, type)`         POST   /api/filter with schemaVersion: 'older'
 *
 * Every call but `refusedCount` and `countsFor` answers `{ ok: true, value }` or `{ ok: false, refusal }`; `conversionRefusalOf(err)` is the one
 * reading of a refused request (the Save's PATCH too), and `convertNoticeOf(answer)` reads the `convert` a save answers.
 *
 * ## Seen red
 *
 * Red on main 2ac9a2b1: `core/conversion-api.service.ts` does not exist.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { firstValueFrom } from 'rxjs';
import { ConversionApi, conversionRefusalOf, convertNoticeOf } from './conversion-api.service';
import type { ConversionStep } from './conversion.types';

let api: ConversionApi;
let http: HttpTestingController;

beforeEach(() => {
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
  api = TestBed.inject(ConversionApi);
  http = TestBed.inject(HttpTestingController);
});
afterEach(() => http.verify());

const urlOf = (url: string) => (r: { urlWithParams: string }) => r.urlWithParams === url;
const person = { kind: 'entity', type: 'person' } as const;
const rename: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' };

/** Resolve a call with the answer a test hands it; the request is returned for what it asked. */
async function answered<T>(call: Promise<T>, url: string | ((r: { urlWithParams: string }) => boolean), reply: (req: TestRequest) => void): Promise<{ result: T; req: TestRequest }> {
  const req = http.expectOne(typeof url === 'string' ? urlOf(url) : url);
  reply(req);
  return { result: await call, req };
}

describe('start (the Convert act)', () => {
  it('POSTs the types and the steps to the space\'s schema-convert door, and reads the 202 answer', async () => {
    const answer = { state: 'started', toFp: 'fp1', types: [person], steps: 1 };
    const { result, req } = await answered(firstValueFrom(api.start('customers', [person], [rename])), '/api/spaces/customers/schema-convert',
      r => r.flush(answer, { status: 202, statusText: 'Accepted' }));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ types: [person], steps: [rename] });
    expect(result).toEqual({ ok: true, value: answer });
  });

  it('sends no `steps` key when there are none (Convert again: the current schema and no extra steps)', async () => {
    const { req } = await answered(firstValueFrom(api.start('customers', [person])), '/api/spaces/customers/schema-convert',
      r => r.flush({ state: 'started', toFp: 'f', types: [person], steps: 0 }, { status: 202, statusText: 'Accepted' }));
    expect(Object.keys(req.request.body as object)).toEqual(['types']);
    const { req: again } = await answered(firstValueFrom(api.start('customers', [person], [])), '/api/spaces/customers/schema-convert',
      r => r.flush({ state: 'started', toFp: 'f', types: [person], steps: 0 }, { status: 202, statusText: 'Accepted' }));
    expect(Object.keys(again.request.body as object)).toEqual(['types']);
  });

  it('encodes the space id in the path', async () => {
    await answered(firstValueFrom(api.start('a b/c', [person])), '/api/spaces/a%20b%2Fc/schema-convert',
      r => r.flush({ state: 'started', toFp: 'f', types: [person], steps: 0 }, { status: 202, statusText: 'Accepted' }));
  });

  it('a bad step comes back as its index and the server\'s sentence', async () => {
    const { result } = await answered(firstValueFrom(api.start('customers', [person], [rename])), '/api/spaces/customers/schema-convert',
      r => r.flush({ error: 'steps[0]: the property is still declared', code: 'bad_conversion_step', step: 0 }, { status: 400, statusText: 'Bad Request' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'bad_step', step: 0, error: 'steps[0]: the property is still declared' } });
  });

  it('a conversion already running comes back as `running`', async () => {
    const { result } = await answered(firstValueFrom(api.start('customers', [person])), '/api/spaces/customers/schema-convert',
      r => r.flush({ error: 'a conversion is running', code: 'schema_convert_running' }, { status: 409, statusText: 'Conflict' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'running' } });
  });

  it('the rate limit comes back with the seconds the server asked for, or null when it named none', async () => {
    const limited = { error: 'rate limited', code: 'schema_convert_rate_limited' };
    const { result } = await answered(firstValueFrom(api.start('customers', [person])), '/api/spaces/customers/schema-convert',
      r => r.flush(limited, { status: 429, statusText: 'Too Many Requests', headers: { 'Retry-After': '30' } }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'rate_limited', retryAfterSeconds: 30 } });
    const { result: bare } = await answered(firstValueFrom(api.start('customers', [person])), '/api/spaces/customers/schema-convert',
      r => r.flush(limited, { status: 429, statusText: 'Too Many Requests' }));
    expect(bare).toEqual({ ok: false, refusal: { kind: 'rate_limited', retryAfterSeconds: null } });
  });

  it('a missing right comes back as `no_right`, with the code that says which one', async () => {
    const { result } = await answered(firstValueFrom(api.start('customers', [person])), '/api/spaces/customers/schema-convert',
      r => r.flush({ error: 'needs the admin right of space', code: 'space_admin_required' }, { status: 403, statusText: 'Forbidden' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'no_right', code: 'space_admin_required', error: 'needs the admin right of space' } });
  });

  it('a failure nothing names comes back as `other` with the status and what the server said, never thrown', async () => {
    const { result } = await answered(firstValueFrom(api.start('customers', [person])), '/api/spaces/customers/schema-convert',
      r => r.flush({ error: 'boom' }, { status: 500, statusText: 'Server Error' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'other', status: 500, error: 'boom' } });
    const { result: lost } = await answered(firstValueFrom(api.start('customers', [person])), '/api/spaces/customers/schema-convert',
      r => r.error(new ProgressEvent('error'), { status: 0, statusText: 'Unknown Error' }));
    expect(lost).toMatchObject({ ok: false, refusal: { kind: 'other', status: 0 } });
  });
});

describe('conversionRefusalOf: the one reading of a refused request (the Save\'s PATCH too)', () => {
  const err = (status: number, body: unknown, headers: Record<string, string> = {}) =>
    ({ status, error: body, headers: { get: (n: string) => headers[n] ?? null } });

  it('reads every kind the plan names', () => {
    expect(conversionRefusalOf(err(400, { error: 'steps[2]: x', code: 'bad_conversion_step', step: 2 }))).toEqual({ kind: 'bad_step', step: 2, error: 'steps[2]: x' });
    expect(conversionRefusalOf(err(403, { error: 'e', code: 'knowledge_rung' }))).toEqual({ kind: 'no_right', code: 'knowledge_rung', error: 'e' });
    expect(conversionRefusalOf(err(429, { error: 'e', code: 'schema_convert_rate_limited' }, { 'Retry-After': '12' })))
      .toEqual({ kind: 'rate_limited', retryAfterSeconds: 12 });
    expect(conversionRefusalOf(err(409, { error: 'e', code: 'schema_convert_running' }))).toEqual({ kind: 'running' });
    expect(conversionRefusalOf(err(412, { error: 'changed' }))).toEqual({ kind: 'stale' });
    expect(conversionRefusalOf(err(400, { error: 'e', code: 'convert_needs_meta' }))).toEqual({ kind: 'needs_meta' });
  });

  it('a bad_conversion_step without a usable index is not a step refusal a page can point at', () => {
    expect(conversionRefusalOf(err(400, { error: 'x', code: 'bad_conversion_step' }))).toEqual({ kind: 'other', status: 400, code: 'bad_conversion_step', error: 'x' });
    expect(conversionRefusalOf(err(400, { error: 'x', code: 'bad_conversion_step', step: -1 }))).toMatchObject({ kind: 'other' });
    expect(conversionRefusalOf(err(400, { error: 'x', code: 'bad_conversion_step', step: '2' }))).toMatchObject({ kind: 'other' });
  });

  it('an unknown code, no body and a request that never answered are `other`, with the code kept for the page', () => {
    expect(conversionRefusalOf(err(400, { error: 'e', code: 'something_new' }))).toEqual({ kind: 'other', status: 400, code: 'something_new', error: 'e' });
    expect(conversionRefusalOf(err(502, null))).toMatchObject({ kind: 'other', status: 502 });
    expect(conversionRefusalOf(undefined)).toMatchObject({ kind: 'other', status: 0 });
  });
});

describe('convertNoticeOf: what a save answered about the run', () => {
  it('reads the `convert` of an applied answer and of a vote-pending one', () => {
    const convert = { state: 'started', types: [person], toFp: 'fp' };
    expect(convertNoticeOf({ space: {}, convert })).toEqual(convert);
    expect(convertNoticeOf({ status: 'vote_pending', rounds: [], convert: { state: 'after_vote', types: [person] } })).toEqual({ state: 'after_vote', types: [person] });
    expect(convertNoticeOf({ state: 'not_started', types: [], error: 'e' })).toBeNull();
  });

  it('is null for an answer with no notice, and for a state it does not know, never a guess', () => {
    expect(convertNoticeOf({ space: {} })).toBeNull();
    expect(convertNoticeOf(null)).toBeNull();
    expect(convertNoticeOf({ convert: { state: 'sideways', types: [] } })).toBeNull();
    expect(convertNoticeOf({ convert: 'started' })).toBeNull();
  });
});

describe('status (the run as it stands)', () => {
  const run = {
    state: 'running', toFp: 'fp', types: [{ kind: 'entity', type: 'person', done: false }], steps: [], stepsRefused: [], sources: [{ kind: 'write', at: 't' }],
    owed: false, startedAt: 't', counts: { stamped: 1, rewritten: 2, unconverted: 3, moved: 0, edgesRestamped: 0 }, left: 10, failures: 0,
  };

  it('GETs the space\'s schema-convert door and reads a run', async () => {
    const { result, req } = await answered(firstValueFrom(api.status('customers')), '/api/spaces/customers/schema-convert', r => r.flush(run));
    expect(req.request.method).toBe('GET');
    expect(result).toEqual({ ok: true, value: run });
  });

  it('reads the answers a read can give instead of a run: none, and one run per member of a personal view', async () => {
    const { result } = await answered(firstValueFrom(api.status('customers')), '/api/spaces/customers/schema-convert', r => r.flush({ state: 'none' }));
    expect(result).toEqual({ ok: true, value: { state: 'none' } });
    const members = { state: 'per_member', runs: [{ space: 'a', ...run }, { space: 'b', state: 'none' }] };
    const { result: view } = await answered(firstValueFrom(api.status('v')), '/api/spaces/v/schema-convert', r => r.flush(members));
    expect(view).toEqual({ ok: true, value: members });
  });

  it('a read without the knowledge rung is a `no_right` outcome: the bar shows nothing', async () => {
    const { result } = await answered(firstValueFrom(api.status('customers')), '/api/spaces/customers/schema-convert',
      r => r.flush({ error: 'needs read', code: 'knowledge_rung' }, { status: 403, statusText: 'Forbidden' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'no_right', code: 'knowledge_rung', error: 'needs read' } });
  });
});

describe('refusedCount (the records the run left for refused steps)', () => {
  it('asks for one row of the step_refused reason and reads the total', async () => {
    const { result } = await answered(firstValueFrom(api.refusedCount('customers')), '/api/spaces/customers/schema-convert/items?reason=step_refused&limit=1',
      r => r.flush({ items: [], total: 14, counts: { open: 14, dismissed: 0 } }));
    expect(result).toBe(14);
  });

  it('is null when the count could not be read: nothing is shown, never a zero', async () => {
    const { result } = await answered(firstValueFrom(api.refusedCount('customers')), '/api/spaces/customers/schema-convert/items?reason=step_refused&limit=1',
      r => r.flush({ error: 'no' }, { status: 403, statusText: 'Forbidden' }));
    expect(result).toBeNull();
  });
});

describe('listUnconverted (Review\'s list)', () => {
  const page = { items: [], count: 0, total: 0, limit: 25, skip: 0, truncated: false, counts: { open: 0, dismissed: 0 } };
  const listUrl = (r: { url: string }) => r.url === '/api/spaces/customers/schema-convert/items';

  it('asks with only the filters it was given, a class as the comma list of its reasons', async () => {
    const call = firstValueFrom(api.listUnconverted('customers', {
      kind: 'entity', type: 'person', reasons: ['not_conforming', 'fork'], status: 'open', skip: 25, limit: 25,
    }));
    const req = http.expectOne(listUrl);
    expect(req.request.method).toBe('GET');
    expect(Object.fromEntries(req.request.params.keys().map(k => [k, req.request.params.get(k)]))).toEqual({
      kind: 'entity', type: 'person', reason: 'not_conforming,fork', status: 'open', skip: '25', limit: '25',
    });
    req.flush(page);
    expect(await call).toEqual({ ok: true, value: page });
  });

  it('sends nothing for a filter left out, an empty list of reasons, or a first page', async () => {
    const call = firstValueFrom(api.listUnconverted('customers', { reasons: [], skip: 0, limit: 25 }));
    const req = http.expectOne(listUrl);
    expect(req.request.params.keys()).toEqual(['limit']);
    req.flush(page);
    await call;
  });

  it('status all goes over as `status=all`: the server lists open and dismissed in one paged list', async () => {
    const call = firstValueFrom(api.listUnconverted('customers', { status: 'all', limit: 25 }));
    const req = http.expectOne(listUrl);
    expect(req.request.params.get('status')).toBe('all');
    req.flush(page);
    await call;
  });

  it('a single reason is the plain form the server has always taken', async () => {
    const call = firstValueFrom(api.listUnconverted('customers', { reasons: ['step_refused'] }));
    const req = http.expectOne(listUrl);
    expect(req.request.params.get('reason')).toBe('step_refused');
    req.flush(page);
    await call;
  });

  it('the rung refusal comes back as `no_right` with the sentence the page words itself', async () => {
    const call = firstValueFrom(api.listUnconverted('customers', {}));
    http.expectOne(listUrl).flush({ error: 'needs read', code: 'unconverted_rung' }, { status: 403, statusText: 'Forbidden' });
    expect(await call).toEqual({ ok: false, refusal: { kind: 'no_right', code: 'unconverted_rung', error: 'needs read' } });
  });
});

describe('dismissOne', () => {
  it('POSTs to the item\'s dismiss door and reads the row it answers', async () => {
    const item = { itemId: 'abc', space: 'customers', status: 'dismissed' };
    const { result, req } = await answered(firstValueFrom(api.dismissOne('customers', 'a/b c')), '/api/spaces/customers/schema-convert/items/a%2Fb%20c/dismiss',
      r => r.flush({ item }));
    expect(req.request.method).toBe('POST');
    expect(result).toEqual({ ok: true, value: { item } });
  });

  it('an item that is no longer listed is `item_gone`, so the page reloads instead of failing', async () => {
    const { result } = await answered(firstValueFrom(api.dismissOne('customers', 'abc')), '/api/spaces/customers/schema-convert/items/abc/dismiss',
      r => r.flush({ error: 'none', code: 'unconverted_item_not_found' }, { status: 404, statusText: 'Not Found' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'item_gone' } });
  });
});

describe('dismissShown ("Dismiss all N shown")', () => {
  const door = '/api/spaces/customers/schema-convert/items/dismiss';

  it('sends the shown filter, the reasons as a list, and the number the user was shown', async () => {
    const { result, req } = await answered(
      firstValueFrom(api.dismissShown('customers', { kind: 'entity', type: 'person', reasons: ['not_conforming', 'fork'], expect: 982 })), door,
      r => r.flush({ dismissed: 982 }));
    expect(req.request.method).toBe('POST');
    expect(req.request.body).toEqual({ kind: 'entity', type: 'person', reason: ['not_conforming', 'fork'], expect: 982 });
    expect(result).toEqual({ ok: true, value: { dismissed: 982 } });
  });

  it('sends only the keys it was given', async () => {
    const { req } = await answered(firstValueFrom(api.dismissShown('customers', { expect: 4 })), door, r => r.flush({ dismissed: 4 }));
    expect(req.request.body).toEqual({ expect: 4 });
    const { req: empty } = await answered(firstValueFrom(api.dismissShown('customers', { reasons: [], expect: 0 })), door, r => r.flush({ dismissed: 0 }));
    expect(empty.request.body).toEqual({ expect: 0 });
  });

  it('a moved count is `changed` with the number now, and nothing was dismissed', async () => {
    const { result } = await answered(firstValueFrom(api.dismissShown('customers', { expect: 982 })), door,
      r => r.flush({ error: 'moved', code: 'unconverted_changed', current: 940 }, { status: 409, statusText: 'Conflict' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'changed', current: 940 } });
  });

  it('more than the server dismisses in one call is `too_many` with the bound', async () => {
    const { result } = await answered(firstValueFrom(api.dismissShown('customers', { expect: 5000 })), door,
      r => r.flush({ error: 'too many', code: 'unconverted_too_many', max: 2000 }, { status: 400, statusText: 'Bad Request' }));
    expect(result).toEqual({ ok: false, refusal: { kind: 'too_many', max: 2000 } });
  });

  it('a refusal that carries no number it should have is `other`, not a made-up one', async () => {
    const { result } = await answered(firstValueFrom(api.dismissShown('customers', { expect: 1 })), door,
      r => r.flush({ error: 'moved', code: 'unconverted_changed' }, { status: 409, statusText: 'Conflict' }));
    expect(result).toMatchObject({ ok: false, refusal: { kind: 'other', status: 409, code: 'unconverted_changed' } });
  });
});

describe('countsFor (the records a block counts, through the filter tool)', () => {
  const filterBody = (r: TestRequest) => r.request.body as Record<string, unknown>;
  const total = (n: number) => ({ ok: true, data: { results: [], total: n, limit: 1, skip: 0, truncated: n > 1 } });
  const rename: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' };

  it('asks the type\'s records and the rewritten ones, one row each, and answers stamped from the two', async () => {
    const call = firstValueFrom(api.countsFor('customers', { kind: 'entity', type: 'person', steps: [rename] }));
    const requests = http.match('/api/filter');
    expect(requests.length).toBe(2);
    const bodies = requests.map(filterBody);
    const all = bodies.find(b => !('$or' in (b['filter'] as object)));
    const some = bodies.find(b => '$or' in (b['filter'] as object));
    expect(all).toEqual({
      space: 'customers', collection: 'entities', filter: { type: { $eq: 'person', $not: { $type: 'array' } }, forkOf: null }, limit: 1, projection: { _id: 1 },
    });
    expect(some).toEqual({
      space: 'customers', collection: 'entities', limit: 1, projection: { _id: 1 },
      filter: { type: { $eq: 'person', $not: { $type: 'array' } }, forkOf: null, $or: [{ 'properties.company': { $exists: true } }] },
    });
    for (const r of requests) r.flush(total(bodies[requests.indexOf(r)] === some ? 599 : 640));
    expect(await call).toEqual({ ok: true, counts: { total: 640, rewritten: 599, stamped: 41, casesCountedAsItRuns: false, wholeType: false } });
  });

  it('asks only for the total when the steps need no second count (none, or a type step), and reads an edge\'s collection', async () => {
    const call = firstValueFrom(api.countsFor('customers', { kind: 'edge', type: 'works_at', steps: [] }));
    const requests = http.match('/api/filter');
    expect(requests.length).toBe(1);
    expect(filterBody(requests[0]!)['collection']).toBe('edges');
    requests[0]!.flush(total(7));
    expect(await call).toMatchObject({ ok: true, counts: { total: 7, rewritten: 0, stamped: 7 } });
  });

  it.each([['entity', 'entities'], ['fact', 'facts'], ['edge', 'edges'], ['chrono', 'chrono']] as const)('a %s block is counted in the %s collection', async (kind, collection) => {
    const call = firstValueFrom(api.countsFor('customers', { kind, type: 'sample', steps: [] }));
    const requests = http.match('/api/filter');
    expect(requests.map(r => filterBody(r)['collection'])).toEqual([collection]);
    requests[0]!.flush(total(3));
    expect(await call).toMatchObject({ ok: true, counts: { total: 3 } });
  });

  it('a count that failed is `{ ok: false }`, never zero: the dialog says it could not count and still offers both outcomes', async () => {
    const call = firstValueFrom(api.countsFor('customers', { kind: 'entity', type: 'person', steps: [rename] }));
    const requests = http.match('/api/filter');
    expect(requests.length).toBe(2);
    // The answered one first: a request the failure of the other cancels cannot be flushed afterwards.
    requests[1]!.flush(total(3));
    requests[0]!.flush({ error: 'x' }, { status: 500, statusText: 'Server Error' });
    expect(await call).toEqual({ ok: false });
  });

  it('a filter answer that carries no total is a failed count too', async () => {
    const call = firstValueFrom(api.countsFor('customers', { kind: 'entity', type: 'person', steps: [] }));
    http.expectOne('/api/filter').flush({ ok: true, data: { results: [] } });
    expect(await call).toEqual({ ok: false });
  });
});

describe('olderCount (records on an older version of the schema)', () => {
  it('asks the type\'s records, forks left out, that are on an older schema version, and reads the total', async () => {
    const call = firstValueFrom(api.olderCount('customers', 'entity', 'invoice'));
    const req = http.expectOne('/api/filter');
    expect(req.request.body).toEqual({
      space: 'customers', collection: 'entities', filter: { type: { $eq: 'invoice', $not: { $type: 'array' } }, forkOf: null },
      schemaVersion: 'older', limit: 1, projection: { _id: 1 },
    });
    req.flush({ ok: true, data: { results: [], total: 412 } });
    expect(await call).toBe(412);
  });

  it('is null when it could not be read', async () => {
    const call = firstValueFrom(api.olderCount('customers', 'entity', 'invoice'));
    http.expectOne('/api/filter').flush({ error: 'x' }, { status: 403, statusText: 'Forbidden' });
    expect(await call).toBeNull();
  });
});
