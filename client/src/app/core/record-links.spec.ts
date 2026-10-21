/**
 * A page of records gets its links in ONE call, and every row can tell "none" from "not asked".
 *
 * ## What this is for
 *
 * A record carried its connections until 5.0 — a fact had `entityIds`, a chrono entry two fields, a file
 * three. They are link RECORDS now, so every list that draws chips has to fetch them, and the two ways
 * that goes wrong are both silent:
 *
 *  - **a request per row.** A page shows up to two hundred, and the answer looks identical.
 *  - **a row with no links left without the fields at all**, which a component cannot tell apart from a
 *    page that was never hydrated — so it either draws nothing or waits for something that has arrived.
 *
 * Run: npx vitest run src/app/core/record-links.spec.ts
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { HttpClient, provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { hydrateLinks, recordsLinkingTo } from './record-links';

describe('record links — one call per page', () => {
  let http: HttpClient;
  let ctrl: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpClient);
    ctrl = TestBed.inject(HttpTestingController);
  });
  afterEach(() => ctrl.verify());

  const rows = [{ _id: 'm-1' }, { _id: 'm-2' }, { _id: 'm-3' }];

  it('asks ONCE for the whole page, by the ids it holds', () => {
    hydrateLinks(http, 'work', 'fact', rows).subscribe();
    const r = ctrl.expectOne('/api/filter');
    expect(r.request.body.collection).toBe('links');
    expect(r.request.body.filter).toEqual({ from: { $in: ['m-1', 'm-2', 'm-3'] }, fromKind: 'fact' });
    r.flush({ ok: true, data: { results: [] } });
  });

  it('separates the classes, so a chrono entry does not report its facts as entities', async () => {
    const got = new Promise(resolve => hydrateLinks(http, 'work', 'chrono', [{ _id: 'c-1' }]).subscribe(resolve));
    ctrl.expectOne('/api/filter').flush({
      ok: true,
      data: {
        results: [
          { from: 'c-1', to: 'e-1', toKind: 'entity' },
          { from: 'c-1', to: 'e-2', toKind: 'entity' },
          { from: 'c-1', to: 'f-9', toKind: 'fact' },
        ],
      },
    });
    expect(await got).toEqual([{ _id: 'c-1', linkEntities: ['e-1', 'e-2'], linkFacts: ['f-9'], linkChronos: [] }]);
  });

  it('gives EVERY row the fields, so "no links" is not the same value as "not hydrated"', async () => {
    const got = new Promise<Record<string, unknown>[]>(resolve =>
      hydrateLinks(http, 'work', 'fact', rows).subscribe(r => resolve(r as unknown as Record<string, unknown>[])));
    ctrl.expectOne('/api/filter').flush({
      ok: true, data: { results: [{ from: 'm-2', to: 'e-1', toKind: 'entity' }] },
    });
    const out = await got;
    expect(out.map(r => r['linkEntities'])).toEqual([[], ['e-1'], []]);
    // The distinction itself: the key is PRESENT on a row with nothing linked.
    expect('linkEntities' in out[0]!).toBe(true);
  });

  it('asks nothing at all for an empty page', async () => {
    const got = new Promise(resolve => hydrateLinks(http, 'work', 'file', []).subscribe(resolve));
    // `verify()` in afterEach is the assertion: an `$in: []` request can only answer nothing, and issuing
    // it would spend a round trip per empty tab.
    expect(await got).toEqual([]);
  });

  it('a link row for a kind this page cannot hold is ignored rather than crashing', async () => {
    const got = new Promise(resolve => hydrateLinks(http, 'work', 'fact', [{ _id: 'm-1' }]).subscribe(resolve));
    ctrl.expectOne('/api/filter').flush({
      ok: true, data: { results: [{ from: 'm-1', to: 'x', toKind: 'somethingNew' }] },
    });
    expect(await got).toEqual([{ _id: 'm-1', linkEntities: [], linkFacts: [], linkChronos: [] }]);
  });

  it('the other direction dedupes, because two links can name the same record', async () => {
    const got = new Promise(resolve => recordsLinkingTo(http, 'work', 'fact', ['e-1']).subscribe(resolve));
    const r = ctrl.expectOne('/api/filter');
    expect(r.request.body.filter).toEqual({ to: { $in: ['e-1'] }, fromKind: 'fact' });
    r.flush({
      ok: true,
      data: { results: [{ from: 'm-1', to: 'e-1', toKind: 'entity' }, { from: 'm-1', to: 'e-1', toKind: 'entity' }] },
    });
    expect(await got).toEqual(['m-1']);
  });
  /**
   * A personal view reads a window from every member and refuses `skip + limit` past 1000 (`PROXY_PAGE_CEILING`),
   * in a sentence. The Facts tab asked for 2000 links on every page, so every view's Facts tab failed - found by
   * the Q-531 verify drive. The door below is the real rule: it answers the page it is asked for, with the total,
   * and refuses what the view door refuses.
   */
  describe('through a view door that refuses a window past 1000', () => {
    interface Link { from: string; to: string; toKind: string }

    function answerAsAView(dataset: Link[], key: 'from' | 'to'): { requests: number } {
      const seen = { requests: 0 };
      for (let pass = 0; pass < 200; pass++) {
        const open = ctrl.match('/api/filter');
        if (open.length === 0) break;
        for (const r of open) {
          seen.requests++;
          const b = r.request.body as { limit: number; skip?: number; filter: Record<string, { $in: string[] }> };
          const skip = b.skip ?? 0;
          if (skip + b.limit > 1000) {
            r.flush({ ok: false, error: `skip + limit must not exceed 1000 through a personal view (got ${skip + b.limit}).` },
              { status: 400, statusText: 'Bad Request' });
            continue;
          }
          const ids = new Set(b.filter[key]!.$in);
          const matching = dataset.filter(l => ids.has(l[key]));
          r.flush({ ok: true, data: { results: matching.slice(skip, skip + b.limit), total: matching.length } });
        }
      }
      return seen;
    }

    const page = Array.from({ length: 200 }, (_, i) => ({ _id: `f-${i}` }));
    // Seven links per fact: 1400 links for the page, more than one window of the view door.
    const dataset: Link[] = page.flatMap(f => Array.from({ length: 7 }, (_, k) => ({ from: f._id, to: `e-${k}`, toKind: 'entity' })));

    it('hydrates a page whose links outnumber one window, every fact with all of its links', async () => {
      let out: Array<{ _id: string; linkEntities: string[] }> | undefined;
      let failure: unknown;
      hydrateLinks(http, '@mine', 'fact', page).subscribe({
        next: r => { out = r as typeof out; },
        error: e => { failure = e; },
      });
      answerAsAView(dataset, 'from');
      expect(failure).toBeUndefined();
      expect(out).toHaveLength(200);
      expect(out!.every(r => r.linkEntities.length === 7)).toBe(true);
    });

    it('says the door sentence itself when one entity has more facts than a view can page, rather than a short list', () => {
      const many: Link[] = Array.from({ length: 1500 }, (_, i) => ({ from: `f-${i}`, to: 'e-1', toKind: 'entity' }));
      let out: string[] | undefined;
      let failure: { error?: { error?: string } } | undefined;
      recordsLinkingTo(http, '@mine', 'fact', ['e-1']).subscribe({ next: r => { out = r; }, error: e => { failure = e; } });
      answerAsAView(many, 'to');
      expect(out).toBeUndefined();
      expect(failure?.error?.error).toContain('must not exceed 1000');
    });

    it('reads the facts that link to an entity whole while they fit one window', () => {
      const some: Link[] = Array.from({ length: 900 }, (_, i) => ({ from: `f-${i}`, to: 'e-1', toKind: 'entity' }));
      let out: string[] | undefined;
      recordsLinkingTo(http, '@mine', 'fact', ['e-1']).subscribe(r => { out = r; });
      answerAsAView(some, 'to');
      expect(out).toHaveLength(900);
    });

    it('a small page costs one request', () => {
      hydrateLinks(http, '@mine', 'fact', page.slice(0, 3)).subscribe();
      expect(answerAsAView(dataset, 'from').requests).toBe(1);
    });
  });
});
