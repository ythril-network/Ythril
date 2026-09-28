/**
 * The session token reaches this origin and nothing else, through EVERY door that attaches it by hand.
 *
 * Two doors do: the HttpClient interceptor and the shared download's `fetch`. They are asserted together
 * over one truth table rather than one each, because two surfaces implementing one rule is where one of them
 * ends up weaker. It was the interceptor: `startsWith('/')` let a protocol-relative URL through, and
 * `startsWith(location.origin)` without the closing `/` let `https://<origin>.evil.net` through.
 *
 * Run: npm run test --workspace=client
 */
import { describe, it, expect, afterEach } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { HttpClient, provideHttpClient, withInterceptors } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { Router } from '@angular/router';
import { authInterceptor } from './auth.interceptor';
import { AuthService } from './auth.service';
import { AuthenticatedDownload } from './authenticated-download';
import { tokenMayReach } from './token-may-reach';

const ORIGIN = location.origin;

/** [url, may the token go there] */
const CASES: Array<[string, boolean]> = [
  ['/api/files/work?path=%2Fa.txt', true],
  ['api/relative', true],
  [`${ORIGIN}/api/brain/spills/x`, true],
  ['//evil.example/steal', false],
  // A browser reads `\` as `/` in a URL, so these are protocol-relative as well.
  ['/\\evil.example/steal', false],
  ['\\\\evil.example/steal', false],
  [' //evil.example/steal', false],
  ['https://evil.example/steal', false],
  [`${ORIGIN}.evil.net/steal`, false],
  [`${ORIGIN}@evil.example/steal`, false],
];

function setup() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      provideHttpClient(withInterceptors([authInterceptor])),
      provideHttpClientTesting(),
      { provide: AuthService, useValue: { token: () => 'T', isAuthenticated: () => true, logout: () => {} } },
      { provide: Router, useValue: { navigate: () => Promise.resolve(true) } },
    ],
  });
  return { http: TestBed.inject(HttpClient), ctl: TestBed.inject(HttpTestingController), dl: TestBed.inject(AuthenticatedDownload) };
}

describe('the session token reaches this origin only', () => {
  const realFetch = (globalThis as { fetch?: unknown }).fetch;
  afterEach(() => {
    (globalThis as { fetch?: unknown }).fetch = realFetch;
    TestBed.resetTestingModule();
  });

  it('the rule itself', () => {
    for (const [url, ok] of CASES) expect(tokenMayReach(url), url).toBe(ok);
  });

  it('the interceptor and the download door agree with it on every case', async () => {
    const { http, ctl, dl } = setup();
    const sent: Array<{ url: string; auth: boolean }> = [];
    (globalThis as { fetch?: unknown }).fetch = (url: string, init: { headers: Record<string, string> }) => {
      sent.push({ url, auth: 'Authorization' in init.headers });
      return Promise.resolve({ ok: true, status: 200, blob: () => Promise.resolve(new Blob([''])) });
    };
    // Every disagreement at once, so a red run names each case a door gets wrong rather than the first.
    const wrong: string[] = [];
    for (const [url, ok] of CASES) {
      http.get(url).subscribe({ error: () => undefined });
      const req = ctl.expectOne(r => r.url === url);
      if (req.request.headers.has('Authorization') !== ok) wrong.push(`interceptor ${ok ? 'withholds from' : 'sends to'} ${url}`);
      req.flush({});
      await dl.fetch(url, r => r.blob());
      if (sent.at(-1)?.url !== url) wrong.push(`download never fetched ${url}`);
      else if (sent.at(-1)!.auth !== ok) wrong.push(`download ${ok ? 'withholds from' : 'sends to'} ${url}`);
    }
    ctl.verify();
    expect(wrong).toEqual([]);
  });
});
