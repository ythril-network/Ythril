/**
 * Reindex says what actually happened, and is not offered where the server refuses it.
 *
 * ## The two reports, both from a live instance on 2026-08-15
 *
 * *"on clicking reindex on overview it sais reindexed 0 documents in green as if it worked on an unclosable
 * inline message (should be notification) and fails instantly."* — and *"the reindex button should not appear
 * on proxy spaces at all."* (Since 6.0 a proxy is a personal view; the second report now holds for a view.)
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
 * The second is a condition the client already had everything for: the open id is one of the caller's personal
 * views (`ViewsStore.isView`), which has no index of its own and is no space the server can reindex. Q-531 moved the
 * rule from `Space.proxyFor` to the view store; the Indexing panel's proxy branch went with the proxy space.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EMPTY, of, throwError } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { ViewsStore } from '../../core/views.store';
import { VIEW_LENS, flushViews } from '../../testing/personal-views';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { FilesApi } from '../../core/files-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthService } from '../../core/auth.service';
import { ToastService } from '../../core/toast.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainComponent } from './brain.component';

/** Two ordinary spaces; the personal view of the second describe is `VIEW_LENS` (`@lens`), read from the ViewsStore. */
const SPACES = [
  { id: 'work', label: 'Work' },
  { id: 'research', label: 'Research' },
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
      provideHttpClient(), provideHttpClientTesting(),
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
    // A refusal can name what to do instead (an index still being built, say). "Check server logs" would
    // send the reader to the one place that does not say it.
    const { c, toast } = create({
      reindex: () => throwError(() => ({ error: { error: "'work' is still building its index; try again when it is ready." } })),
    });
    c.runReindex();
    expect(toast.error).toHaveBeenCalledTimes(1);
    expect(String(toast.error.mock.calls[0][0])).toContain('still building its index');
    expect(c.reindexing()).toBe(false);
  });

  it('falls back to a translated message when the server sends no reason', () => {
    const { c, toast } = create({ reindex: () => throwError(() => ({ status: 500 })) });
    c.runReindex();
    expect(String(toast.error.mock.calls[0][0])).toContain('brain.reindex.failed');
  });
});

describe('a personal view is never offered a reindex', () => {
  beforeEach(() => TestBed.resetTestingModule());

  /** The page with the caller's one view loaded into the store, as the shell does for every page under it. */
  function createWithView() {
    const made = create();
    TestBed.inject(ViewsStore).load();
    flushViews(TestBed.inject(HttpTestingController), [VIEW_LENS]);
    return made;
  }

  it('knows which open id is a personal view', () => {
    const { c } = createWithView();
    expect(c.isView()).toBe(false);
    c.selectSpace('@lens');
    expect(c.isView()).toBe(true);
  });

  it('hides the stale-index banner on a view, and keeps it on an ordinary space', () => {
    // `needsReindex` is true for a space in this stub — the banner must go on the view anyway, because its
    // only button asks the server to reindex something that is no space.
    const { fixture, c, el } = createWithView();
    expect(el.querySelector('.reindex-banner')).toBeTruthy();

    c.selectSpace('@lens');
    fixture.detectChanges();
    expect(el.querySelector('.reindex-banner')).toBeNull();
  });

  it('asks the server for no reindex status of a view', () => {
    // The status is a space's, and the server answers a view as a space that does not exist: asking would be a request
    // that can only fail, on every open of a view.
    const { c } = createWithView();
    const asked: string[] = [];
    (c as any).spacesApi.getReindexStatus = (id: string) => { asked.push(id); return of({ needsReindex: true }); };
    c.selectSpace('@lens');
    expect(asked).not.toContain('@lens');
  });
});
