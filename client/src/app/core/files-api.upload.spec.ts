/**
 * uploadFileChunked — the U12 guarantees that the UI relies on:
 *   1. The returned observable is COLD: no work and no progress event happens
 *      until subscribe(), so a late subscriber can never miss the initial 0%.
 *   2. Unsubscribing CANCELS: it aborts the in-flight request (HttpClient marks
 *      the underlying request cancelled) — this is how the UI cancels an upload.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { FilesApi } from './files-api.service';
import type { UploadProgress } from './api.types';

/** A small (<10 MB) file whose bytes resolve synchronously-ish via a stubbed arrayBuffer. */
function smallFile(name = 'note.txt'): File {
  const f = new File(['hello'], name, { type: 'text/plain' });
  // jsdom's File.arrayBuffer is unreliable across versions — stub it deterministically.
  Object.defineProperty(f, 'arrayBuffer', { value: () => Promise.resolve(new ArrayBuffer(5)) });
  return f;
}

describe('FilesApi.uploadFileChunked (U12: cold + cancelable)', () => {
  let api: FilesApi;
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [FilesApi, provideHttpClient(), provideHttpClientTesting()],
    });
    api = TestBed.inject(FilesApi);
    httpMock = TestBed.inject(HttpTestingController);
  });

  it('is cold — creating the observable fires nothing until subscribe', async () => {
    const seen: UploadProgress[] = [];
    const obs = api.uploadFileChunked('work', '/', smallFile());

    // No subscriber yet → the body has not run, so no request and no emission.
    httpMock.expectNone(() => true);
    expect(seen).toEqual([]);

    // Subscribing runs the body: the initial 0% is emitted synchronously, so a
    // subscriber that attaches after creation cannot lose it.
    obs.subscribe(p => seen.push(p));
    expect(seen).toEqual([{ percent: 0, done: false }]);

    // The POST only fires after the (async) arrayBuffer resolves.
    await Promise.resolve();
    const req = httpMock.expectOne(r => r.url === '/api/files/work');
    req.flush(null);
    expect(seen.at(-1)).toEqual({ percent: 100, done: true });
    httpMock.verify();
  });

  it('unsubscribing aborts the in-flight request (cancel)', async () => {
    const obs = api.uploadFileChunked('work', '/', smallFile());
    const sub = obs.subscribe();
    await Promise.resolve();

    const req = httpMock.expectOne(r => r.url === '/api/files/work');
    expect(req.cancelled).toBe(false);

    sub.unsubscribe();
    expect(req.cancelled).toBe(true);
    httpMock.verify(); // no leaked open requests
  });

  it('does not emit after unsubscribe even if bytes were still resolving', async () => {
    const seen: UploadProgress[] = [];
    const sub = api.uploadFileChunked('work', '/', smallFile()).subscribe(p => seen.push(p));
    // Cancel before the arrayBuffer microtask settles.
    sub.unsubscribe();
    await Promise.resolve();
    // Only the synchronous 0% was seen; the POST never fired.
    expect(seen).toEqual([{ percent: 0, done: false }]);
    httpMock.expectNone(() => true);
    httpMock.verify();
  });
});
