/**
 * While a reindex RUNS, the page says so: both Reindex buttons are held, the page polls until the run ends, and
 * the Indexing panel shows what is left (Q-99 part 2).
 *
 * ## What was wrong
 *
 * The page read `reindex-status` once, inside `loadStats`, and only for `needsReindex`. The Reindex buttons were
 * disabled only while the POST was in flight — a few milliseconds — so a second click during a run that takes
 * minutes sent a second reindex. And the toast said "the Indexing panel shows when it finishes", which nothing on
 * the panel did.
 *
 * ## The rules
 *
 * - ONE source drives both buttons (the stale-index banner's and the Overview Indexing panel's): the server's
 *   `reindex.running`, OR a request in flight. Disabled with `aria-busy`.
 * - While running, the page polls `reindex-status` every 5 s, and stops when the run ends.
 * - The Indexing panel shows `brain.overview.reindexProgress` (params `remaining`, `failed`) in a `role=status`
 *   line, so a screen reader hears the progress without the focus moving.
 * - A 409 says `brain.reindex.alreadyRunning` — the server's per-space refusal means "a run exists", not "failed".
 * - en, de and pl all carry the three new keys, and the progress line takes both parameters in each.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { EMPTY, NEVER, of, throwError } from 'rxjs';
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

const SPACES = [{ id: 'work', label: 'Work' }];

type Run = { running: boolean; remaining: number; failed: number };
const status = (reindex: Run, needsReindex = true) => ({ spaceId: 'work', needsReindex, reindex });
const RUNNING: Run = { running: true, remaining: 3, failed: 1 };
const IDLE: Run = { running: false, remaining: 0, failed: 0 };

function makeApi(over: Record<string, unknown> = {}) {
  return {
    listSpaces: () => of({ spaces: SPACES }),
    getSpaceStats: vi.fn(() => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 })),
    getReindexStatus: vi.fn(() => of(status(IDLE))),
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
    reindex: () => of({ spaceId: 'work', reindexed: 0, errors: 0, status: 'started' }),
    ...over,
  } as any;
}

function create(over: Record<string, unknown> = {}, translation: Record<string, string> = {}) {
  const toast = { info: vi.fn(), error: vi.fn(), success: vi.fn(), show: vi.fn() };
  const api = makeApi(over);
  TestBed.configureTestingModule({
    imports: [BrainComponent, getTranslocoModule({ translation: { en: translation } })],
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
  const el = fixture.nativeElement as HTMLElement;
  const buttons = () => {
    fixture.detectChanges();
    const banner = el.querySelector<HTMLButtonElement>('.reindex-banner button');
    const overview = [...el.querySelectorAll<HTMLButtonElement>('app-overview-tab button')]
      .find(b => b.textContent?.includes('brain.overview.reindexButton')) ?? null;
    return { banner, overview };
  };
  return { fixture, c: fixture.componentInstance, toast, api, el, buttons };
}

/** Responses in order; the last one repeats. */
const sequence = (...answers: ReturnType<typeof status>[]) => {
  let i = 0;
  return vi.fn(() => of(answers[Math.min(i++, answers.length - 1)]));
};

describe('both Reindex buttons are held while a run is going', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('disabled, and aria-busy, while the server says reindex.running', () => {
    const { buttons } = create({ getReindexStatus: vi.fn(() => of(status(RUNNING))) });
    const { banner, overview } = buttons();
    expect(banner, 'the stale-index banner button').toBeTruthy();
    expect(overview, 'the Overview Indexing panel button').toBeTruthy();
    for (const [name, b] of [['banner', banner], ['overview', overview]] as const) {
      expect(b!.disabled, `${name} button must be disabled while a run is going`).toBe(true);
      expect(b!.getAttribute('aria-busy'), `${name} button must say it is busy`).toBe('true');
    }
  });

  it('disabled while the request is in flight, before the server has said anything', () => {
    const { c, buttons } = create({ reindex: () => NEVER });
    c.runReindex();
    const { banner, overview } = buttons();
    expect(banner!.disabled).toBe(true);
    expect(overview!.disabled).toBe(true);
  });

  it('enabled again when nothing is running and nothing is in flight', () => {
    const { buttons } = create();
    const { banner, overview } = buttons();
    expect(banner!.disabled).toBe(false);
    expect(overview!.disabled).toBe(false);
  });
});

describe('while running, the page polls reindex-status every 5 s, and stops when the run ends', () => {
  beforeEach(() => { TestBed.resetTestingModule(); vi.useFakeTimers(); });
  afterEach(() => vi.useRealTimers());

  it('polls at 5 s, not sooner', () => {
    const getReindexStatus = vi.fn(() => of(status(RUNNING)));
    create({ getReindexStatus });
    const atLoad = getReindexStatus.mock.calls.length;
    vi.advanceTimersByTime(4_900);
    expect(getReindexStatus.mock.calls.length, 'polled before 5 s').toBe(atLoad);
    vi.advanceTimersByTime(100);
    expect(getReindexStatus.mock.calls.length, 'no poll at 5 s while the run is going').toBe(atLoad + 1);
    vi.advanceTimersByTime(5_000);
    expect(getReindexStatus.mock.calls.length).toBe(atLoad + 2);
  });

  it('stops once a poll says the run has ended, and reloads the stats', () => {
    const getReindexStatus = sequence(status(RUNNING), status(RUNNING), status(IDLE, false));
    const { api, buttons } = create({ getReindexStatus });
    const statsBefore = api.getSpaceStats.mock.calls.length;
    vi.advanceTimersByTime(10_000); // two polls: still running, then ended
    const settled = getReindexStatus.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(getReindexStatus.mock.calls.length, 'kept polling after the run ended').toBe(settled);
    expect(api.getSpaceStats.mock.calls.length, 'the stats must be reloaded when the run ends').toBeGreaterThan(statsBefore);
    expect(buttons().overview!.disabled, 'and the button is offered again').toBe(false);
  });

  it('does not poll at all when nothing is running', () => {
    const getReindexStatus = vi.fn(() => of(status(IDLE)));
    create({ getReindexStatus });
    const atLoad = getReindexStatus.mock.calls.length;
    vi.advanceTimersByTime(30_000);
    expect(getReindexStatus.mock.calls.length).toBe(atLoad);
  });
});

describe('the Indexing panel says what is left', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('a role=status line carries brain.overview.reindexProgress with remaining and failed', () => {
    const { el, fixture } = create(
      { getReindexStatus: vi.fn(() => of(status(RUNNING))) },
      { 'brain.overview.reindexProgress': 'Reindexing: {{remaining}} left, {{failed}} failed' },
    );
    fixture.detectChanges();
    const lines = [...el.querySelectorAll('app-overview-tab [role="status"]')].map(n => n.textContent?.trim() ?? '');
    expect(lines.some(t => t.includes('Reindexing: 3 left, 1 failed')),
      `no role=status line with the progress: ${JSON.stringify(lines)}`).toBe(true);
  });

  it('and no progress line when nothing is running', () => {
    const { el, fixture } = create({}, { 'brain.overview.reindexProgress': 'Reindexing: {{remaining}} left, {{failed}} failed' });
    fixture.detectChanges();
    expect(el.textContent).not.toContain('Reindexing:');
  });
});

describe('a 409 says a run already exists', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('toasts brain.reindex.alreadyRunning, not a failure', () => {
    const { c, toast } = create({
      reindex: () => throwError(() => ({ status: 409, error: { error: "A reindex of 'work' is already running." } })),
    });
    c.runReindex();
    const said = [...toast.info.mock.calls, ...toast.error.mock.calls, ...toast.show.mock.calls].map(a => String(a[0]));
    expect(said.some(s => s.includes('brain.reindex.alreadyRunning')), JSON.stringify(said)).toBe(true);
  });
});

describe('the new keys exist in every language', () => {
  const KEYS = ['brain.overview.reindexing', 'brain.overview.reindexProgress', 'brain.reindex.alreadyRunning'];
  for (const lang of ['en', 'de', 'pl']) {
    it(`${lang} has all three, and the progress line takes remaining and failed`, () => {
      const dict = JSON.parse(readFileSync(`public/assets/i18n/${lang}.json`, 'utf8')) as Record<string, string>;
      for (const k of KEYS) expect(typeof dict[k] === 'string' && dict[k].trim().length > 0, `${lang}: ${k}`).toBe(true);
      expect(dict['brain.overview.reindexProgress']).toMatch(/\{\{\s*remaining\s*\}\}/);
      expect(dict['brain.overview.reindexProgress']).toMatch(/\{\{\s*failed\s*\}\}/);
    });
  }
});
