/**
 * What SpacesApi sends for the two irreversible space acts, and how it reads their answers.
 *
 * Since bundle-106 the server refuses an admin wipe without `{ "confirm": true }` (400), on every space, and a networked delete or wipe
 * may answer 202 - a vote is open, or it passed and the change is still running. The service answers a `SpaceActOutcome` (status and
 * body read together by `spaceActOutcome`), so a caller can never read a 202 as "done" by forgetting to look at the status.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { SpacesApi } from './spaces-api.service';

describe('SpacesApi - the irreversible acts', () => {
  let api: SpacesApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [SpacesApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(SpacesApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('a wipe sends confirm, with or without types', () => {
    api.wipeSpace('s').subscribe();
    expect(http.expectOne('/api/admin/spaces/s/wipe').request.body).toEqual({ confirm: true });
    api.wipeSpace('s', ['facts']).subscribe();
    expect(http.expectOne('/api/admin/spaces/s/wipe').request.body).toEqual({ confirm: true, types: ['facts'] });
  });

  it('a delete or a wipe is answered as its outcome: a 202 is a vote or a queued act, a 200 or 204 is done', () => {
    const seen: string[] = [];
    api.deleteSpace('s').subscribe(r => seen.push(r.kind));
    http.expectOne('/api/spaces/s').flush({ status: 'vote_pending' }, { status: 202, statusText: 'Accepted' });
    api.deleteSpace('s').subscribe(r => seen.push(r.kind));
    http.expectOne('/api/spaces/s').flush(null, { status: 204, statusText: 'No Content' });
    api.wipeSpace('s').subscribe(r => seen.push(r.kind));
    http.expectOne('/api/admin/spaces/s/wipe').flush({ status: 'passed', queued: true }, { status: 202, statusText: 'Accepted' });
    api.wipeSpace('s').subscribe(r => seen.push(r.kind));
    http.expectOne('/api/admin/spaces/s/wipe').flush({ status: 'wiped', deleted: {} }, { status: 200, statusText: 'OK' });
    expect(seen).toEqual(['vote-pending', 'done', 'queued', 'done']);
  });

  it('a 500 or 503 is a failed outcome (its body says whether the server retries); a 404 is done on a delete and an error on a wipe; a refusal is an error', () => {
    const seen: string[] = [];
    const errors: number[] = [];
    api.deleteSpace('s').subscribe(r => seen.push(`${r.kind}${r.kind === 'failed' ? `:${r.retried}` : ''}`));
    http.expectOne('/api/spaces/s').flush({ error: 'x', code: 'space_act_failed' }, { status: 500, statusText: 'Server Error' });
    api.deleteSpace('s').subscribe(r => seen.push(r.kind));
    http.expectOne('/api/spaces/s').flush({ error: 'gone' }, { status: 404, statusText: 'Not Found' });
    api.wipeSpace('s').subscribe({ next: () => seen.push('wrong'), error: e => errors.push(e.status) });
    http.expectOne('/api/admin/spaces/s/wipe').flush({ error: 'gone' }, { status: 404, statusText: 'Not Found' });
    api.deleteSpace('s').subscribe({ next: () => seen.push('wrong'), error: e => errors.push(e.status) });
    http.expectOne('/api/spaces/s').flush({ error: 'busy' }, { status: 409, statusText: 'Conflict' });
    expect(seen).toEqual(['failed:true', 'done']);
    expect(errors).toEqual([404, 409]);
  });
});
