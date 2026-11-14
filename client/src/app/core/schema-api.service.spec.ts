/**
 * The four type-history reads of `SchemaApi` (design r4 §5, test C5): what they ask on the wire, how they read the answer the server
 * really gives, and how cautiously they read one they do not know.
 *
 * ## The contract this spec fixes for the build (r4 names the wire; the method names are chosen here and listed in the hand-off)
 *
 * - `typeList(spaceId, kind, skip?)`               GET /api/spaces/:id/schema-versions?kind=K[&skip=n]
 * - `typeHistory(spaceId, kind, type, skip?)`      ...?kind=K&type=T[&skip=n]
 * - `typeStandings(spaceId, kind, type, fps)`      ...?fps=a,b&kind=K&type=T   (REST takes `fps` comma-separated, r4 §5)
 * - `typeComparison(spaceId, kind, type, fp, against)`  ...?fp=F&against=A&kind=K&type=T
 *
 * Each answers `{ supported: true, answer }`, or `{ supported: false }` when the answer carries no `kind`/`type` echo: an older server
 * that ignored the new parameters and answered the version list (r4 §5, r3 §9.8). `typeHistoryFailure(err)` names why a read failed:
 * `noAnswer` (5xx or network), `busy` (503 `schema_versions_busy`), `indexBuilding` (503 `schema_index_building`) or `refused`
 * with the server's own `error` sentence for any other code, the cautious reading of a code this client does not know (r3 §10).
 * A busy read is retried three times, at 1 s, 2 s and 4 s, before it fails (r4 §7.2); nothing else is retried.
 *
 * An unknown `standing` reads as `unclassified`, an unknown `declared` as `none` (r3 §10's unknown-value sentence).
 *
 * ## The shared fixture
 *
 * `client/src/app/testing/fixtures/schema-type-answers.json` is written by the server side's T6 in check mode from the live answers
 * (r4 §10 T6); this spec only reads it, finds each answer by its shape (a `types` list, a `definitions` list, a `standings` list),
 * and feeds it through the methods, so the two halves of the echo cannot be mocked apart (r3 T-S5).
 *
 * ## Seen red
 *
 * Red on 327b105e: `SchemaApi` has none of the four methods, `typeHistoryFailure` is not exported, and the fixture does not exist.
 */
import { TestBed } from '@angular/core/testing';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { firstValueFrom, type Observable } from 'rxjs';
import * as schemaApiModule from './schema-api.service';
import { SchemaApi } from './schema-api.service';

const FIXTURE = resolve(__dirname, '../testing/fixtures/schema-type-answers.json');

type Read = { supported: false } | { supported: true; answer: Record<string, any> };

/** The methods by name, so a missing one fails as "is not a function" naming it rather than as a compile error hiding the rest. */
function call(api: SchemaApi, name: string, ...args: unknown[]): Observable<Read> {
  const fn = (api as unknown as Record<string, unknown>)[name];
  if (typeof fn !== 'function') throw new Error(`SchemaApi has no ${name}()`);
  return (fn as (...a: unknown[]) => Observable<Read>).apply(api, args);
}

const failureOf = (err: unknown): { reason: string; error?: string } => {
  const fn = (schemaApiModule as Record<string, unknown>)['typeHistoryFailure'];
  if (typeof fn !== 'function') throw new Error('schema-api.service exports no typeHistoryFailure()');
  return (fn as (e: unknown) => { reason: string; error?: string })(err);
};

let api: SchemaApi;
let http: HttpTestingController;

beforeEach(() => {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting(), SchemaApi] });
  api = TestBed.inject(SchemaApi);
  http = TestBed.inject(HttpTestingController);
});
afterEach(() => { vi.useRealTimers(); });

const versionsReq = (): TestRequest => {
  const reqs = http.match(r => r.method === 'GET' && r.url.split('?')[0] === '/api/spaces/work/schema-versions');
  expect(reqs.length, 'one GET of the versions door').toBe(1);
  return reqs[0]!;
};
const paramsOf = (req: TestRequest): Record<string, string> => {
  const out: Record<string, string> = {};
  for (const k of req.request.params.keys()) out[k] = req.request.params.get(k)!;
  const q = req.request.urlWithParams.split('?')[1];
  if (q) for (const [k, v] of new URLSearchParams(q)) out[k] = v;
  return out;
};

describe('the four reads ask the versions door with the parameters r4 §5 names (C5)', () => {
  it('typeList asks kind only', () => {
    void firstValueFrom(call(api, 'typeList', 'work', 'entity'));
    expect(paramsOf(versionsReq())).toEqual({ kind: 'entity' });
  });

  it('typeHistory asks kind and type', () => {
    void firstValueFrom(call(api, 'typeHistory', 'work', 'edge', 'follows'));
    expect(paramsOf(versionsReq())).toEqual({ kind: 'edge', type: 'follows' });
  });

  it('typeStandings sends the stamps as one comma-separated fps, in the order given, with kind and type', () => {
    void firstValueFrom(call(api, 'typeStandings', 'work', 'entity', 'person', ['aa11', 'bb22', 'cc33']));
    expect(paramsOf(versionsReq())).toEqual({ fps: 'aa11,bb22,cc33', kind: 'entity', type: 'person' });
  });

  it('typeComparison asks fp, against, kind and type', () => {
    void firstValueFrom(call(api, 'typeComparison', 'work', 'entity', 'person', 'aa11', 'ff99'));
    expect(paramsOf(versionsReq())).toEqual({ fp: 'aa11', against: 'ff99', kind: 'entity', type: 'person' });
  });

  it('a type name that needs escaping reaches the server as the name, not as more parameters', async () => {
    const got = firstValueFrom(call(api, 'typeHistory', 'work', 'entity', 'a&b=c'));
    expect(paramsOf(versionsReq())['type']).toBe('a&b=c');
    void got;
  });
});

/** Every object in the fixture, however it is nested or keyed. */
function objectsIn(v: unknown, out: Record<string, any>[] = []): Record<string, any>[] {
  if (Array.isArray(v)) for (const x of v) objectsIn(x, out);
  else if (v && typeof v === 'object') { out.push(v as Record<string, any>); for (const x of Object.values(v)) objectsIn(x, out); }
  return out;
}

describe('the shared fixture of the live answers reads through the methods (C5, T6)', () => {
  it('the fixture exists where design r4 §10 T6 names it', () => {
    expect(existsSync(FIXTURE), `no fixture at ${FIXTURE}`).toBe(true);
  });

  it('every list, history and standings answer in it is read as supported, row for row', async () => {
    expect(existsSync(FIXTURE), `no fixture at ${FIXTURE}`).toBe(true);
    const all = objectsIn(JSON.parse(readFileSync(FIXTURE, 'utf8')));
    const lists = all.filter(o => typeof o['kind'] === 'string' && Array.isArray(o['types']));
    const histories = all.filter(o => typeof o['kind'] === 'string' && typeof o['type'] === 'string' && Array.isArray(o['definitions']));
    const standings = all.filter(o => typeof o['kind'] === 'string' && typeof o['type'] === 'string' && Array.isArray(o['standings']));
    expect(lists.length, 'the fixture holds no kind answer').toBeGreaterThan(0);
    expect(histories.length, 'the fixture holds no kind+type answer').toBeGreaterThan(0);
    expect(standings.length, 'the fixture holds no fps answer').toBeGreaterThan(0);

    for (const body of lists) {
      const got = firstValueFrom(call(api, 'typeList', 'work', body['kind']));
      versionsReq().flush(body);
      const read = await got;
      expect(read.supported).toBe(true);
      if (read.supported) expect(read.answer['types'].map((t: any) => t.type)).toEqual(body['types'].map((t: any) => t.type));
    }
    for (const body of histories) {
      const got = firstValueFrom(call(api, 'typeHistory', 'work', body['kind'], body['type']));
      versionsReq().flush(body);
      const read = await got;
      expect(read.supported).toBe(true);
      if (read.supported) expect(read.answer['definitions'].map((d: any) => d.rep)).toEqual(body['definitions'].map((d: any) => d.rep));
    }
    for (const body of standings) {
      const fps = body['standings'].map((s: any) => s.fp);
      const got = firstValueFrom(call(api, 'typeStandings', 'work', body['kind'], body['type'], fps));
      versionsReq().flush(body);
      const read = await got;
      expect(read.supported).toBe(true);
      if (read.supported) expect(read.answer['standings'].map((s: any) => [s.fp, s.standing])).toEqual(body['standings'].map((s: any) => [s.fp, s.standing]));
    }
  });
});

describe('an answer this client does not fully know is read cautiously (C5, r3 §10)', () => {
  it('an answer without the kind/type echo is "not supported": an older server answered the version list', async () => {
    const got = firstValueFrom(call(api, 'typeHistory', 'work', 'entity', 'person'));
    versionsReq().flush({ current: 'ff99', versions: [{ fp: 'ff99', at: '2026-11-01T00:00:00.000Z' }] });
    expect(await got).toEqual({ supported: false });
  });

  it('a list answer without the echo is "not supported" too', async () => {
    const got = firstValueFrom(call(api, 'typeList', 'work', 'entity'));
    versionsReq().flush({ current: 'ff99', versions: [] });
    expect(await got).toEqual({ supported: false });
  });

  it('an unknown standing reads as unclassified; the known ones are kept', async () => {
    const got = firstValueFrom(call(api, 'typeStandings', 'work', 'entity', 'person', ['aa11', 'bb22', 'cc33']));
    versionsReq().flush({ kind: 'entity', type: 'person', current: 'ff99', standings: [
      { fp: 'aa11', standing: 'current' }, { fp: 'bb22', standing: 'somethingNew' }, { fp: 'cc33', standing: 'older', definition: { rep: 'cc33' } },
    ] });
    const read = await got;
    expect(read.supported).toBe(true);
    if (read.supported) expect(read.answer['standings'].map((s: any) => [s.fp, s.standing])).toEqual([['aa11', 'current'], ['bb22', 'unclassified'], ['cc33', 'older']]);
  });

  it('an unknown declared reads as none, and a row named __proto__ is a row, not a prototype', async () => {
    const got = firstValueFrom(call(api, 'typeList', 'work', 'entity'));
    versionsReq().flush({ kind: 'entity', current: 'ff99', types: [
      { type: 'person', declared: 'own', older: true }, { type: 'odd', declared: 'borrowed' }, { type: '__proto__', declared: 'none' },
    ], count: 3, total: 3, limit: 100, skip: 0, truncated: false });
    const read = await got;
    expect(read.supported).toBe(true);
    if (!read.supported) return;
    expect(read.answer['types'].map((t: any) => [t.type, t.declared])).toEqual([['person', 'own'], ['odd', 'none'], ['__proto__', 'none']]);
    expect(({} as Record<string, unknown>)['declared']).toBeUndefined();
  });
});

describe('why a read failed is named, and only busy is retried (C5, r4 §7.2, §7.6)', () => {
  const failed = async (status: number, body: unknown): Promise<unknown> => {
    const got = firstValueFrom(call(api, 'typeHistory', 'work', 'entity', 'person')).then(() => null, e => e);
    versionsReq().flush(body as never, { status, statusText: 'x' });
    return got;
  };

  it('a 500 is noAnswer, and it is not retried', async () => {
    const err = await failed(500, { error: 'boom' });
    expect(failureOf(err).reason).toBe('noAnswer');
    expect(http.match(() => true)).toEqual([]);
  });

  it('a network failure is noAnswer', async () => {
    const got = firstValueFrom(call(api, 'typeHistory', 'work', 'entity', 'person')).then(() => null, e => e);
    versionsReq().error(new ProgressEvent('error'), { status: 0 });
    expect(failureOf(await got).reason).toBe('noAnswer');
  });

  it('schema_index_building is indexBuilding, and it is not retried', async () => {
    const err = await failed(503, { error: 'The version index is being built.', code: 'schema_index_building' });
    expect(failureOf(err).reason).toBe('indexBuilding');
    expect(http.match(() => true)).toEqual([]);
  });

  it('a code this client does not know is refused, carrying the server\'s own sentence', async () => {
    const err = await failed(400, { error: 'A sentence the server wrote.', code: 'a_code_from_the_future' });
    expect(failureOf(err)).toEqual({ reason: 'refused', error: 'A sentence the server wrote.' });
  });

  it('schema_versions_busy is asked three more times, at 1 s, 2 s and 4 s, and then fails as busy', async () => {
    vi.useFakeTimers();
    const busy = { error: 'It took longer than a request may.', code: 'schema_versions_busy' };
    const got = firstValueFrom(call(api, 'typeHistory', 'work', 'entity', 'person')).then(() => null, e => e);
    versionsReq().flush(busy, { status: 503, statusText: 'busy' });
    for (const wait of [1000, 2000, 4000]) {
      await vi.advanceTimersByTimeAsync(wait - 1);
      expect(http.match(() => true), `asked again before ${wait} ms`).toEqual([]);
      await vi.advanceTimersByTimeAsync(1);
      versionsReq().flush(busy, { status: 503, statusText: 'busy' });
    }
    await vi.advanceTimersByTimeAsync(10_000);
    expect(http.match(() => true), 'a fifth ask').toEqual([]);
    expect(failureOf(await got).reason).toBe('busy');
  });

  it('a busy read that then answers is answered', async () => {
    vi.useFakeTimers();
    const got = firstValueFrom(call(api, 'typeHistory', 'work', 'entity', 'person'));
    versionsReq().flush({ error: 'x', code: 'schema_versions_busy' }, { status: 503, statusText: 'busy' });
    await vi.advanceTimersByTimeAsync(1000);
    versionsReq().flush({ kind: 'entity', type: 'person', current: 'ff99', declared: 'own', definitions: [{ rep: 'ff99', current: true, origin: { edited: true, networks: [], fetched: false } }], count: 1, total: 1, limit: 20, skip: 0, truncated: false });
    const read = await got;
    expect(read.supported).toBe(true);
  });
});
