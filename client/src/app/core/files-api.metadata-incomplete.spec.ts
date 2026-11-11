/**
 * `FilesApi.listFiles` hands on the listing's `metadataIncomplete` (Q-341, bundle-70 S3).
 *
 * The server answers a listing whose metadata read failed with `metadataIncomplete: string[]` (a closed vocabulary of reasons) and omits the
 * field when nothing failed. The service maps the wire body to the shape the Files page reads: the reasons come through as they are, and a
 * body without the field maps to no field at all (never an empty array, which would read as "something failed, nothing to say").
 *
 * Red against 8ee92312: the mapped answer carries only `entries`, so the page cannot know the details are missing.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FilesApi } from './files-api.service';

describe('FilesApi.listFiles and metadataIncomplete', () => {
  let api: FilesApi;
  let httpMock: HttpTestingController;
  const wire = (extra: object) => ({ path: '/', type: 'dir', entries: [{ name: 'a.txt', type: 'file', size: 3 }], ...extra });

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [FilesApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(FilesApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('maps the reasons the listing answered, beside its entries', () => {
    let got: any;
    api.listFiles('work', '/').subscribe(r => (got = r));
    httpMock.expectOne(r => r.url === '/api/files/work').flush(wire({ metadataIncomplete: ['store-unavailable'] }));
    expect(got.entries.map((e: any) => e.name)).toEqual(['a.txt']);
    expect(got.metadataIncomplete).toEqual(['store-unavailable']);
    httpMock.verify();
  });

  it('a listing that answered without the field maps to no field (the control)', () => {
    let got: any;
    api.listFiles('work', '/').subscribe(r => (got = r));
    httpMock.expectOne(r => r.url === '/api/files/work').flush(wire({}));
    expect(got.entries).toHaveLength(1);
    expect(got.metadataIncomplete).toBeUndefined();
    httpMock.verify();
  });

  it('an empty list is no report: it maps to no field, not to an empty array', () => {
    let got: any;
    api.listFiles('work', '/').subscribe(r => (got = r));
    httpMock.expectOne(r => r.url === '/api/files/work').flush(wire({ metadataIncomplete: [] }));
    expect(got.metadataIncomplete).toBeUndefined();
    httpMock.verify();
  });
});
