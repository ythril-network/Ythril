/**
 * Reindex says what actually happened, and is not offered where the server refuses it.
 *
 * ## The two reports, both from a live instance on 2026-08-15
 *
 * *"on clicking reindex on overview it sais reindexed 0 documents in green as if it worked on an unclosable
 * inline message (should be notification) and fails instantly."* — and *"the reindex button should not appear
 * on proxy spaces at all."*
 *
 * The first is not a rendering bug. `POST /reindex` **never awaits the job**: it schedules the work and both
 * surfaces answer immediately with ZEROED counters, deliberately, so the call does not hang for the length of
 * a whole-space re-embed. The client summed those zeros and printed "Reindexed 0 documents." in green — the
 * acknowledgement of a job that had just started, displayed as its result.
 *
 * So the assertions here are about the CLAIM, not about the wording: no count may be printed from that
 * response, because no count exists at that moment. A test that only checked "some message appears" would
 * pass on the defect.
 *
 * The second is a condition the client already had everything for: `Space.proxyFor` is on the record, and the
 * chip strip beside the panel already branches on it to draw the proxy badge.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EMPTY, of, throwError } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { FilesApi } from '../../core/files-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainComponent } from './brain.component';

/** The proxy space is second so the default selection is the ordinary one. */
const SPACES = [
  { id: 'work', label: 'Work' },
  { id: 'everything', label: 'Everything', proxyFor: ['work', 'research'] },
];

function makeApi(over: Record<string, unknown> = {}) {
  return {
    listSpaces: () => of({ spaces: SPACES }),
    getSpaceStats: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getReindexStatus: () => of({ needsReindex: true }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    getEntitiesByIds: () => of({ entities: [] }),
    mintEventsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
    getErModel: () => of({
      spaceId: 'work', entityTypes: [], relationships: [],
      danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 },
    }),
    getAbout: () => of(null),
    getEmbeddingQueue: () => of(null),
    getTokenAccess: () => of({ tokens: [] }),
    getCompleteness: () => of(null),
    getSpaceActivity: () => of({ spaceId: 'work', hours: 168, spaces: [] }),
    listVotes: () => of({ rounds: [] }),
    // What the route really answers: scheduled, with every counter at zero.
    reindex: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    ...over,
  } as any;
}

function create(over: Record<string, unknown> = {}) {
  const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn(), show: vi.fn() };
  const api = makeApi(over);
  TestBed.configureTestingModule({
    imports: [BrainComponent, getTranslocoModule()],
    providers: [
      { provide: SpacesApi, useValue: api },
      { provide: BrainApi, useValue: api },
      { provide: FilesApi, useValue: api },
      { provide: AdminApi, useValue: api },
      { provide: NetworksApi, useValue: api },
      { provide: AuthService, useValue: { token: () => '' } },
      { provide: ToastService, useValue: toast },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
    ],
  });
  const fixture = TestBed.createComponent(BrainComponent);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance, toast, el: fixture.nativeElement as HTMLElement };
}

describe('reindex reports a START, never a count', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('never prints a document count from the response', () => {
    // The whole defect in one assertion: the response carries zeros because the job has not run, so any
    // number taken from it is a claim about work that has not happened.
    const { c, toast } = create();
    c.runReindex();
    expect(toast.info).toHaveBeenCalledTimes(1);
    const said = String(toast.info.mock.calls[0][0]);
    expect(said).not.toMatch(/\d/);
    expect(said).toContain('brain.reindex.started');
  });

  it('reports it through the toast channel, not an inline banner that cannot be dismissed', () => {
    const { c, el, toast } = create();
    c.runReindex();
    expect(toast.info).toHaveBeenCalled();
    expect(el.querySelector('.alert-success')).toBeNull();
    expect(el.querySelector('.reindex-result')).toBeNull();
  });

  it('clears the spinner but LEAVES the stale-index banner, because the index is still stale', () => {
    // It used to clear the banner optimistically. The job has only been scheduled, so the index really is
    // still stale — and `loadStats` re-reads the true state a moment later and would put the banner back.
    // The optimism bought a flicker and a false claim; the toast is what says the work has begun.
    const { c } = create();
    c.runReindex();
    expect(c.reindexing()).toBe(false);
    expect(c.needsReindex()).toBe(true);
  });

  it('a failure is a toast too, and repeats the SERVER\'s reason when it has one', () => {
    // The proxy refusal names the member spaces to reindex instead. "Check server logs" would send the
    // reader to the one place that does not say it.
    const { c, toast } = create({
      reindex: () => throwError(() => ({ error: { error: "'everything' is a proxy space and has no index of its own." } })),
    });
    c.runReindex();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toContain('proxy space');
    expect(c.reindexing()).toBe(false);
  });

  it('falls back to a translated message when the server sends no reason', () => {
    const { c, toast } = create({ reindex: () => throwError(() => ({ status: 500 })) });
    c.runReindex();
    expect(String(toast.error.mock.calls[0][0])).toContain('brain.reindex.failed');
  });
});

describe('a proxy space is never offered a reindex', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('knows which spaces are proxies', () => {
    const { c } = create();
    expect(c.activeSpaceIsProxy()).toBe(false);
    c.selectSpace('everything');
    expect(c.activeSpaceIsProxy()).toBe(true);
  });

  it('hides the stale-index banner on a proxy, and keeps it on an ordinary space', () => {
    // `needsReindex` is true for both in this stub — the banner must go on the proxy anyway, because the
    // only button it carries is one the server answers with a 400.
    const { fixture, c, el } = create();
    expect(el.querySelector('.reindex-banner')).toBeTruthy();

    c.selectSpace('everything');
    fixture.detectChanges();
    expect(el.querySelector('.reindex-banner')).toBeNull();
  });
});
