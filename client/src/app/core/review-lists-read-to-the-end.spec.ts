/**
 * The review lists are read to the end (`Q-127`).
 *
 * The duplicate and contradiction lists stopped at 500 with nothing saying so; the server now pages them and says when
 * a page is cut. The review tab filters and sorts the whole list in the browser, so its services follow `nextSkip`
 * until the list ends rather than showing the first page as if it were all of it.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { DuplicatesApi } from './duplicates-api.service';
import { ContradictionsApi } from './contradictions-api.service';

describe('the review lists are read to the end (Q-127)', () => {
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [DuplicatesApi, ContradictionsApi, provideHttpClient(), provideHttpClientTesting()] });
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('duplicates: every page is fetched and joined', () => {
    let got: string[] = [];
    TestBed.inject(DuplicatesApi).listDuplicates('open', 'work').subscribe(r => { got = r.duplicates.map(d => d.id); });
    http.expectOne(r => r.url.startsWith('/api/duplicates') && !r.url.includes('skip=') )
      .flush({ duplicates: [{ id: 'a' }, { id: 'b' }], truncated: true, nextSkip: 2, total: 3 });
    http.expectOne(r => r.url.startsWith('/api/duplicates') && r.url.includes('skip=2'))
      .flush({ duplicates: [{ id: 'c' }], truncated: false, total: 3 });
    expect(got).toEqual(['a', 'b', 'c']);
  });

  it('contradictions: every page is fetched and joined, and nliConfigured is kept', () => {
    let got: { ids: string[]; nli: boolean | undefined } = { ids: [], nli: undefined };
    TestBed.inject(ContradictionsApi).listContradictions('open', 'work')
      .subscribe(r => { got = { ids: r.contradictions.map(c => c.id), nli: r.nliConfigured }; });
    http.expectOne(r => r.url.startsWith('/api/contradictions') && !r.url.includes('skip='))
      .flush({ contradictions: [{ id: 'x' }], nliConfigured: true, truncated: true, nextSkip: 1, total: 2 });
    http.expectOne(r => r.url.startsWith('/api/contradictions') && r.url.includes('skip=1'))
      .flush({ contradictions: [{ id: 'y' }], nliConfigured: true, truncated: false, total: 2 });
    expect(got).toEqual({ ids: ['x', 'y'], nli: true });
  });
});
