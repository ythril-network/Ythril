/**
 * What SpacesApi sends for the two irreversible space acts, and how it reads their answers.
 *
 * Since bundle-106 the server refuses an admin wipe without `{ "confirm": true }` (400), on every space, and a networked delete or wipe
 * may answer 202 - a vote is open, or it passed and the change is still running. The service turns the status into `pending`, so a
 * caller can never read a 202 as "done" by forgetting to look at the status.
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

  it('a 202 from a delete or a wipe is pending; a 200 or 204 is not', () => {
    const seen: boolean[] = [];
    api.deleteSpace('s').subscribe(r => seen.push(r.pending));
    http.expectOne('/api/spaces/s').flush({ status: 'vote_pending' }, { status: 202, statusText: 'Accepted' });
    api.deleteSpace('s').subscribe(r => seen.push(r.pending));
    http.expectOne('/api/spaces/s').flush(null, { status: 204, statusText: 'No Content' });
    api.wipeSpace('s').subscribe(r => seen.push(r.pending));
    http.expectOne('/api/admin/spaces/s/wipe').flush({ status: 'passed', queued: true }, { status: 202, statusText: 'Accepted' });
    api.wipeSpace('s').subscribe(r => seen.push(r.pending));
    http.expectOne('/api/admin/spaces/s/wipe').flush({ status: 'wiped', deleted: {} }, { status: 200, statusText: 'OK' });
    expect(seen).toEqual([true, false, true, false]);
  });
});
