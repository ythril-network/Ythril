/**
 * Every id a view asks to resolve is resolved (`Q-131`).
 *
 * Owner rule, 2026-09-28: *"if i get a result i want to be sure i get what i asked for"*. `getEntitiesByIds` sliced its
 * ids at 100, so a view resolving 101 or more showed the rest as unresolved — a partial map with nothing saying so.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { BrainApi } from './brain-api.service';

describe('BrainApi.getEntitiesByIds resolves every id (Q-131)', () => {
  let api: BrainApi;
  let http: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({ providers: [BrainApi, provideHttpClient(), provideHttpClientTesting()] });
    api = TestBed.inject(BrainApi);
    http = TestBed.inject(HttpTestingController);
  });
  afterEach(() => http.verify());

  it('250 ids come back as 250 entities, asked for in batches no larger than a page', () => {
    const ids = Array.from({ length: 250 }, (_, i) => `e${i}`);
    let got: string[] = [];
    api.getEntitiesByIds('work', [...ids, 'e0']).subscribe(r => { got = r.entities.map(e => e._id); });

    const requests = http.match(req => req.url === '/api/filter');
    expect(requests.length, 'one request for 250 ids cannot be right, and neither can dropping 150').toBeGreaterThan(1);
    for (const r of requests) {
      const asked = r.request.body.filter._id.$in as string[];
      expect(asked.length).toBeLessThanOrEqual(100);
      r.flush({ ok: true, data: { results: asked.map(id => ({ _id: id, name: id, type: 't' })) } });
    }
    expect(new Set(got)).toEqual(new Set(ids));
    expect(got.length, 'a repeated id is asked for once').toBe(250);
  });
});
