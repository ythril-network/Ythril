/**
 * SpaceDangerTabComponent characterization tests.
 *
 * Written BEFORE the PR-U9 rework (escalate Wipe to a red tier, add type-to-confirm to Rename, responsive
 * tiles) and proven green against the ORIGINAL component. The danger tab performs the IRREVERSIBLE space
 * operations — rename, wipe, delete, leave-network — each behind a confirm. These tests pin that gating so
 * the redesign can't weaken it: a cancelled confirm must never call the API, and a confirmed one calls the
 * right endpoint and updates state. (Wipe/Delete already use type-to-confirm; the rework adds it to Rename.)
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { of } from 'rxjs';
import { signal } from '@angular/core';
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting, type TestRequest } from '@angular/common/http/testing';
import { LiveAnnouncement } from '../../core/live-announcement';
import {
  ACT_TEXT_KEYS, DELETE_ANSWERS as D, WIPE_ANSWERS as W, NOW, RETRY_AHEAD, SERVER_SENTENCES, actPending, type WireAnswer,
} from '../../testing/space-act-bodies';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceDangerTabComponent } from './space-danger-tab.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SpacesStore } from './spaces-store.service';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

/*
 * Generic in the OVERRIDES, so a mock a caller adds is visible on the returned `spacesApi`.
 *
 * It was `Partial<Record<string, unknown>>`, which accepts anything and contributes nothing: the return type
 * was inferred from the base stub alone, so `h.spacesApi.updateSpace` — passed in by `withMeta` and present at
 * runtime — did not exist as far as the compiler was concerned. Four assertions were reading a property the
 * type said was absent.
 */
function setup<E extends Record<string, unknown>>(confirmResult: boolean, api: E = {} as E) {
  const spacesApi = {
    renameSpace: vi.fn().mockReturnValue(of({ space: { id: 'renamed', label: 'S' } })),
    wipeSpace: vi.fn().mockReturnValue(of({})),
    deleteSpace: vi.fn().mockReturnValue(of({})),
    getSpaceStats: vi.fn().mockReturnValue(of({})),
    ...api,
  };
  const networksApi = {
    listNetworks: vi.fn().mockReturnValue(of({ networks: [] })),
    leaveNetwork: vi.fn().mockReturnValue(of({})),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceDangerTabComponent, getTranslocoModule()],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: spacesApi },
      { provide: NetworksApi, useValue: networksApi },
      // `networksForSpace` and `load` are needed because these tests run a real change-detection pass
      // (`TestBed.tick()`) to fire the seeding effect, which renders the template. The earlier tests called
      // methods directly and never rendered, so the mock could get away with less.
      { provide: SpacesStore, useValue: { spaces: signal([]), networks: signal([]), refreshNetworks: () => {}, networksForSpace: () => [], load: () => {} } },
      { provide: ToastService, useValue: { error: () => {}, success: () => {}, show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(confirmResult) } },
    ],
  });
  const c = TestBed.createComponent(SpaceDangerTabComponent).componentInstance;
  const state = TestBed.inject(SpaceSettingsState);
  state.settingsSpace.set({ id: 'proj', label: 'Project' } as never);
  return { c, state, spacesApi, networksApi };
}

describe('SpaceDangerTabComponent — irreversible ops are confirm-gated', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('rename: no-op when the new id is blank or unchanged', async () => {
    const { c, state, spacesApi } = setup(true);
    state.dangerRenameId = '';
    await c.submitDangerRename();
    state.dangerRenameId = 'proj'; // same as current
    await c.submitDangerRename();
    expect(spacesApi.renameSpace).not.toHaveBeenCalled();
  });

  it('rename: a cancelled confirm does not call the API', async () => {
    const { c, state, spacesApi } = setup(false);
    state.dangerRenameId = 'proj-2';
    await c.submitDangerRename();
    expect(spacesApi.renameSpace).not.toHaveBeenCalled();
  });

  it('rename: confirmed calls renameSpace(old,new) and reflects the new space', async () => {
    const { c, state, spacesApi } = setup(true, {
      renameSpace: vi.fn().mockReturnValue(of({ space: { id: 'proj-2', label: 'Project' } })),
    });
    state.dangerRenameId = 'proj-2';
    await c.submitDangerRename();
    expect(spacesApi.renameSpace).toHaveBeenCalledWith('proj', 'proj-2');
    expect(state.settingsSpace()?.id).toBe('proj-2');
  });

  it('wipe: cancelled does not call the API; confirmed does', async () => {
    const cancelled = setup(false);
    await cancelled.c.confirmDangerWipe();
    expect(cancelled.spacesApi.wipeSpace).not.toHaveBeenCalled();

    const ok = setup(true);
    await ok.c.confirmDangerWipe();
    expect(ok.spacesApi.wipeSpace).toHaveBeenCalledWith('proj');
  });

  it('delete: cancelled does not call the API; confirmed deletes and closes the dialog', async () => {
    const cancelled = setup(false);
    await cancelled.c.confirmDangerDelete();
    expect(cancelled.spacesApi.deleteSpace).not.toHaveBeenCalled();

    const ok = setup(true);
    await ok.c.confirmDangerDelete();
    expect(ok.spacesApi.deleteSpace).toHaveBeenCalledWith('proj');
    expect(ok.state.settingsSpace()).toBeNull(); // closeSettings()
  });

  /*
   * The two 202 cases that stood here flushed `{ pending: true }`, a shape the server never sends, and pinned the sticky
   * `notDoneYet` toast that Q-535 removes. They moved, as real server bodies, to "the act's outcome is shown in the tab" below.
   */

  it('leave network: cancelled does not call the API; confirmed leaves', async () => {
    const cancelled = setup(false);
    await cancelled.c.leaveNetworkDanger('net1');
    expect(cancelled.networksApi.leaveNetwork).not.toHaveBeenCalled();

    const ok = setup(true);
    await ok.c.leaveNetworkDanger('net1');
    expect(ok.networksApi.leaveNetwork).toHaveBeenCalledWith('net1');
  });
});

describe('the embedding suppression section', () => {
  // The seeding lives in an `effect()`, so it does not run on `set()` alone — it needs a change-detection pass.
  // Flushed explicitly rather than worked around, because the effect IS the behaviour being tested: seeding from
  // the space is what makes the toggle show the stored value instead of always starting off.
  const withMeta = (meta: Record<string, unknown>) => {
    const h = setup(true, {
      updateSpace: vi.fn().mockReturnValue(of({ space: { id: 'proj', label: 'Project' } })),
      reembedSpace: vi.fn().mockReturnValue(of({ spaceId: 'proj', enqueued: 12, skippedSuppressed: 0, byKind: { fact: 12 }, remaining: 0, truncated: false })),
    });
    h.state.settingsSpace.set({ id: 'other', label: 'Other', meta } as never);
    TestBed.tick();
    return h;
  };

  it('seeds the toggle from the space, treating absent as OFF', () => {
    // Suppression is opt-in. Reading absent as ON would silently stop a space embedding.
    expect(withMeta({}).c.suppress()).toBe(false);
    expect(withMeta({ suppressEmbeddings: true }).c.suppress()).toBe(true);
  });

  it('sends the flag inside meta, so the server MERGES rather than replacing', () => {
    // Sending a whole meta back would race any other edit made since the dialog opened.
    const h = withMeta({});
    h.c.suppress.set(true);
    return h.c.saveSuppress().then(() => {
      expect(h.spacesApi.updateSpace).toHaveBeenCalledWith('other', { meta: { suppressEmbeddings: true } });
    });
  });

  it('sends false when turned OFF, rather than omitting it', () => {
    // Omitting the field under a merge would leave suppression on while the save reported success.
    const h = withMeta({ suppressEmbeddings: true });
    h.c.suppress.set(false);
    return h.c.saveSuppress().then(() => {
      expect(h.spacesApi.updateSpace).toHaveBeenCalledWith('other', { meta: { suppressEmbeddings: false } });
    });
  });

  it('lists only the types that STATE a value', () => {
    // A type that says nothing inherits; listing it would suggest an override that is not there.
    const h = withMeta({ typeSchemas: { fact: { note: { suppressEmbeddings: true }, plain: {} }, entity: { row: { suppressEmbeddings: false } } } });
    expect(h.c.declaredSuppression().map(r => r.key).sort()).toEqual(['entity.row', 'fact.note']);
  });

  it('keeps the backfill result, because the counts ARE the answer', () => {
    const h = withMeta({});
    return h.c.backfill().then(() => {
      expect(h.spacesApi.reembedSpace).toHaveBeenCalledWith('other');
      expect(h.c.backfillResult()?.enqueued).toBe(12);
    });
  });

  it('clears a previous backfill result when the space changes', () => {
    // Otherwise one space's counts would be shown under another space's name.
    const h = withMeta({});
    return h.c.backfill().then(() => {
      h.state.settingsSpace.set({ id: 'third', label: 'Third' } as never);
      TestBed.tick();
      expect(h.c.backfillResult()).toBe(null);
    });
  });
});

/*
 * Q-535 (plan rev 2, design 2-7): what a delete or wipe came to is shown IN the tab, in one `role="status"` region, from the REAL
 * server answer — not a sticky toast built from `pending`. These run the real SpacesApi against HttpTestingController and flush the
 * bodies the server sends (`testing/space-act-bodies.ts`), so they hold whatever shape the service and parser take.
 */
const K = ACT_TEXT_KEYS;

interface Wired {
  fixture: ComponentFixture<SpaceDangerTabComponent>;
  c: SpaceDangerTabComponent;
  state: SpaceSettingsState;
  http: HttpTestingController;
  confirm: ReturnType<typeof vi.fn>;
}

/** The tab with the real SpacesApi; `space` is merged into the open space (e.g. `{ actPending }`), `nets` is what networksForSpace gives. */
function wired(opts: { space?: Record<string, unknown>; nets?: Record<string, unknown>[] } = {}): Wired {
  const confirm = vi.fn((_data: unknown) => Promise.resolve(true));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceDangerTabComponent, getTranslocoModule({ translation: { en: {
      // A parametrised key echoes its own name AND its parameter, so a spec can see both the line and what filled it.
      [K.queued]: `${K.queued} {{when}}`,
    } } })],
    providers: [
      SpaceSettingsState,
      SpacesApi,
      provideHttpClient(),
      provideHttpClientTesting(),
      { provide: NetworksApi, useValue: { listNetworks: vi.fn().mockReturnValue(of({ networks: [] })), leaveNetwork: vi.fn().mockReturnValue(of({})) } },
      { provide: SpacesStore, useValue: {
        spaces: signal([{ id: 'proj', label: 'Project', ...opts.space }]), networks: signal([]), refreshNetworks: vi.fn(),
        networksForSpace: () => opts.nets ?? [], load: vi.fn(),
      } },
      { provide: ToastService, useValue: { error: vi.fn(), success: vi.fn(), show: vi.fn(), info: vi.fn() } },
      { provide: ConfirmDialogService, useValue: { confirm } },
    ],
  });
  const state = TestBed.inject(SpaceSettingsState);
  state.settingsSpace.set({ id: 'proj', label: 'Project', ...opts.space } as never);
  const fixture = TestBed.createComponent(SpaceDangerTabComponent);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance, state, http: TestBed.inject(HttpTestingController), confirm };
}

const flushWire = (req: TestRequest, a: WireAnswer) => req.flush(a.body, { status: a.status, statusText: String(a.status) });
const textOf = (h: Wired, selector: string) =>
  Array.from((h.fixture.nativeElement as HTMLElement).querySelectorAll(selector)).map(e => e.textContent ?? '').join(' | ');
const statusText = (h: Wired) => textOf(h, '[role="status"]');
const alertText = (h: Wired) => textOf(h, '[role="alert"]');
const pageText = (h: Wired) => (h.fixture.nativeElement as HTMLElement).textContent ?? '';
const spacesPolls = (h: Wired) => h.http.match(r => r.method === 'GET' && r.url === '/api/spaces');

async function deleteAnswered(h: Wired, a: WireAnswer): Promise<void> {
  await h.c.confirmDangerDelete();
  flushWire(h.http.expectOne(r => r.method === 'DELETE' && r.url === '/api/spaces/proj'), a);
  if (h.state.settingsSpace()) h.fixture.detectChanges();
}

async function wipeAnswered(h: Wired, a: WireAnswer): Promise<void> {
  await h.c.confirmDangerWipe();
  flushWire(h.http.expectOne(r => r.method === 'POST' && r.url === '/api/admin/spaces/proj/wipe'), a);
  h.fixture.detectChanges();
}

describe('the act\'s outcome is shown in the tab (Q-535)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  it('delete 202 vote_pending: the space stays and the status region says a vote is open', async () => {
    const h = wired();
    await deleteAnswered(h, D.votePending);
    expect(h.state.settingsSpace()?.id).toBe('proj');
    expect(statusText(h)).toContain(K.votePending);
  });

  it('delete 202 queued with a retry ahead: the space stays and the line says when, never "ago"', async () => {
    const h = wired();
    await deleteAnswered(h, D.localQueued);
    expect(h.state.settingsSpace()?.id).toBe('proj');
    expect(statusText(h)).toContain(K.queued);
    expect(statusText(h)).not.toMatch(/\bago\b/);
  });

  it('delete 202 queued with a retry time already past: "retrying now", not a time in the past', async () => {
    const h = wired();
    await deleteAnswered(h, D.localQueuedOverdue);
    expect(statusText(h)).toContain(K.retryingNow);
    expect(statusText(h)).not.toMatch(/\bago\b/);
  });

  it('delete 202 queued with no retry time (still running): "will run shortly"', async () => {
    const h = wired();
    await deleteAnswered(h, D.votedQueuedRunning);
    expect(statusText(h)).toContain(K.runsShortly);
  });

  it('delete 200 removedHere:false: the space is KEPT here and the line says another network holds it', async () => {
    const h = wired();
    await deleteAnswered(h, D.votedDoneKeptHere);
    expect(h.state.settingsSpace()?.id, 'the settings stay open on a space that still exists here').toBe('proj');
    expect(statusText(h)).toContain(K.keptHere);
  });

  it('delete 200 removedHere:true: the space is removed and the settings close', async () => {
    const h = wired();
    await deleteAnswered(h, D.votedDone);
    expect(h.state.settingsSpace()).toBeNull();
  });

  it('delete 200 repeated: "already in progress" is said, and the space is gone', async () => {
    const h = wired();
    const say = vi.spyOn(LiveAnnouncement.prototype, 'say');
    const toast = TestBed.inject(ToastService) as unknown as Record<string, ReturnType<typeof vi.fn>>;
    await deleteAnswered(h, D.repeatedDone);
    const said = [...say.mock.calls, ...toast['info']!.mock.calls, ...toast['success']!.mock.calls, ...toast['show']!.mock.calls]
      .map(c => String(c[0])).join(' | ');
    expect(h.state.settingsSpace()).toBeNull();
    expect(said).toContain(K.repeated);
  });

  it('delete 404: the space is already gone — done, no error line', async () => {
    const h = wired();
    await deleteAnswered(h, D.alreadyGone);
    expect(h.state.settingsSpace()).toBeNull();
    expect(h.state.dangerDeleteError()).toBe('');
  });

  it('delete 500 space_act_failed after a vote: role=alert with the voted key, never the server\'s English', async () => {
    const h = wired();
    await deleteAnswered(h, D.votedFailed);
    expect(h.state.settingsSpace()?.id).toBe('proj');
    expect(alertText(h)).toContain(K.failedVoted);
    for (const s of SERVER_SENTENCES) expect(pageText(h)).not.toContain(s);
  });

  it('delete 500 space_act_failed on a local act: role=alert with the local key', async () => {
    const h = wired();
    await deleteAnswered(h, D.localFailed);
    expect(alertText(h)).toContain(K.failedLocal);
    for (const s of SERVER_SENTENCES) expect(pageText(h)).not.toContain(s);
  });

  it('delete 503 from the store after a vote, and 503 shutting down: role=alert, voted and local keys', async () => {
    const voted = wired();
    await deleteAnswered(voted, D.votedStoreDown);
    expect(alertText(voted)).toContain(K.failedVoted);
    const closing = wired();
    await deleteAnswered(closing, D.shuttingDown);
    expect(alertText(closing)).toContain(K.failedLocal);
  });

  it('wipe 200: stats reload and the status region says it is wiped', async () => {
    const h = wired();
    await wipeAnswered(h, W.localDone);
    h.http.expectOne('/api/brain/spaces/proj/stats');
    expect(statusText(h)).toContain(K.wiped);
  });

  it('wipe 200 refills: the line says the copy refills from the publisher at the next sync', async () => {
    const h = wired();
    await wipeAnswered(h, W.subscriberRefills);
    expect(statusText(h)).toContain(K.refills);
  });

  it('wipe 202 vote_pending and 202 queued: said in the status region, no stats reload as if wiped', async () => {
    const pending = wired();
    await wipeAnswered(pending, W.votePending);
    expect(statusText(pending)).toContain(K.votePending);
    expect(pending.http.match('/api/brain/spaces/proj/stats')).toHaveLength(0);
    const queued = wired();
    await wipeAnswered(queued, W.votedQueued);
    expect(statusText(queued)).toContain(K.queued);
  });

  it('wipe 500 space_act_failed on a local act: role=alert with the local key', async () => {
    const h = wired();
    await wipeAnswered(h, W.localFailed);
    expect(alertText(h)).toContain(K.failedLocal);
    for (const s of SERVER_SENTENCES) expect(pageText(h)).not.toContain(s);
  });
});

describe('the standing act (actPending, admins) and its poll (Q-535)', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'] });
    vi.setSystemTime(NOW);
  });
  afterEach(() => { vi.useRealTimers(); vi.restoreAllMocks(); });

  const TEN_MINUTES = 600_000;

  it('when an act stands on the space, an admin sees its notice, state, attempts and the repeat hint in the status region', () => {
    const h = wired({ space: { actPending: actPending({ kind: 'delete', state: 'owed', attempts: 2, nextRetryAt: RETRY_AHEAD }) } });
    const status = statusText(h);
    expect(status).toContain(K.standing);
    expect(status).toContain(K.attempts);
    expect(pageText(h)).toContain(K.repeatHint);
  });

  it('a non-admin (no actPending: unknown, never "none") sees nothing about acts, and nothing is polled', () => {
    const h = wired();
    expect(pageText(h)).not.toContain('spaces.dangerZone.act.');
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(spacesPolls(h)).toHaveLength(0);
  });

  it('the delete and wipe buttons stay enabled while an act stands (a repeat joins or retries it)', () => {
    const h = wired({ space: { actPending: actPending({ kind: 'wipe', state: 'running' }) } });
    const buttons = Array.from((h.fixture.nativeElement as HTMLElement).querySelectorAll('button'));
    const wipe = buttons.find(b => b.textContent?.includes('spaces.dangerZone.wipeButton'));
    const del = buttons.find(b => b.textContent?.includes('spaces.dangerZone.deleteButton'));
    expect(wipe?.disabled).toBe(false);
    expect(del?.disabled).toBe(false);
    expect(pageText(h)).toContain(K.repeatHint);
  });

  it('a rename while a delete stands keeps its 409, in role=alert, with a hint line', async () => {
    const h = wired({ space: { actPending: actPending({ kind: 'delete' }) } });
    h.state.dangerRenameId = 'proj-2';
    await h.c.submitDangerRename();
    h.http.expectOne(r => r.method === 'PATCH' && r.url === '/api/spaces/proj/rename').flush(
      { error: '\'proj\' cannot be renamed while a deletion or wipe of it is owed or running; see GET /api/networks/:id (owedSpaceActs).' },
      { status: 409, statusText: 'Conflict' });
    h.fixture.detectChanges();
    expect(alertText(h)).toContain('cannot be renamed');
    expect(pageText(h)).toContain(K.renameHint);
  });

  it('opening the tab on a standing act starts the poll; it goes on while the act stands', () => {
    const h = wired({ space: { actPending: actPending() } });
    vi.advanceTimersByTime(TEN_MINUTES);
    const first = spacesPolls(h);
    expect(first.length, 'a GET /api/spaces while an act stands').toBeGreaterThan(0);
    first[0]!.flush({ spaces: [{ id: 'proj', label: 'Project', actPending: actPending({ attempts: 3 }) }] });
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(spacesPolls(h).length, 'asked again: the act still stands').toBeGreaterThan(0);
  });

  it('a delete that ends while polled: the space is gone from the list, the tab closes and the end is announced', () => {
    const say = vi.spyOn(LiveAnnouncement.prototype, 'say');
    const h = wired({ space: { actPending: actPending({ kind: 'delete' }) } });
    vi.advanceTimersByTime(TEN_MINUTES);
    const polls = spacesPolls(h);
    expect(polls.length, 'the standing delete is polled').toBeGreaterThan(0);
    polls[0]!.flush({ spaces: [] });
    expect(h.state.settingsSpace()).toBeNull();
    expect(say.mock.calls.map(c => String(c[0])).join(' | ')).toContain(K.ended);
  });

  it('a wipe that ends while polled: stats reload and the end is announced', () => {
    const say = vi.spyOn(LiveAnnouncement.prototype, 'say');
    const h = wired({ space: { actPending: actPending({ kind: 'wipe' }) } });
    vi.advanceTimersByTime(TEN_MINUTES);
    const polls = spacesPolls(h);
    expect(polls.length, 'the standing wipe is polled').toBeGreaterThan(0);
    polls[0]!.flush({ spaces: [{ id: 'proj', label: 'Project' }] });
    h.http.expectOne('/api/brain/spaces/proj/stats');
    expect(say.mock.calls.map(c => String(c[0])).join(' | ')).toContain(K.ended);
  });

  it('a queued delete answer starts the poll', async () => {
    const h = wired();
    await deleteAnswered(h, D.votedQueued);
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(spacesPolls(h).length).toBeGreaterThan(0);
  });

  it('the poll stops when the tab is destroyed', () => {
    const h = wired({ space: { actPending: actPending() } });
    vi.advanceTimersByTime(TEN_MINUTES);
    const first = spacesPolls(h);
    expect(first.length, 'the poll ran before the destroy').toBeGreaterThan(0);
    first[0]!.flush({ spaces: [{ id: 'proj', label: 'Project', actPending: actPending() }] });
    h.fixture.destroy();
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(spacesPolls(h)).toHaveLength(0);
  });

  it('the poll stops when the dialog switches to another space', () => {
    const h = wired({ space: { actPending: actPending() } });
    vi.advanceTimersByTime(TEN_MINUTES);
    const first = spacesPolls(h);
    expect(first.length, 'the poll ran before the switch').toBeGreaterThan(0);
    first[0]!.flush({ spaces: [{ id: 'proj', label: 'Project', actPending: actPending() }] });
    h.state.settingsSpace.set({ id: 'other', label: 'Other' } as never);
    h.fixture.detectChanges();
    vi.advanceTimersByTime(TEN_MINUTES);
    expect(spacesPolls(h)).toHaveLength(0);
  });
});

describe('the confirm text forecasts what the act will do (Q-535 design 7)', () => {
  afterEach(() => vi.restoreAllMocks());
  const asked = (h: Wired) => JSON.stringify(h.confirm.mock.calls[0]?.[0] ?? null);

  it('no network holds the space: "local only", for a delete and for a wipe', async () => {
    const del = wired({ nets: [] });
    await del.c.confirmDangerDelete();
    expect(asked(del)).toContain(K.forecastLocalOnly);
    const wipe = wired({ nets: [] });
    await wipe.c.confirmDangerWipe();
    expect(asked(wipe)).toContain(K.forecastLocalOnly);
  });

  it('every network\'s ownYesCarries is true: "acts at once here and on the network"', async () => {
    const h = wired({ nets: [{ id: 'n1', label: 'Team', ownYesCarries: true }] });
    await h.c.confirmDangerDelete();
    expect(asked(h)).toContain(K.forecastActsNow);
  });

  it('any network\'s ownYesCarries is false: "this opens a vote"', async () => {
    const h = wired({ nets: [{ id: 'n1', label: 'Team', ownYesCarries: true }, { id: 'n2', label: 'Wide', ownYesCarries: false }] });
    await h.c.confirmDangerWipe();
    expect(asked(h)).toContain(K.forecastOpensVote);
  });
});
