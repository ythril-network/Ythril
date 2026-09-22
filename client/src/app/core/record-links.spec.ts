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
});
