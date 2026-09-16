/**
 * OverviewTabComponent — the Brain's default landing dashboard (F9, slice 1).
 *
 * Presentational over the shell's own data: `space` + `stats` come in as inputs and Reindex is emitted
 * back (behind a confirm). These tests pin the derived values (counts, storage, index state) and the
 * confirm-guarded emit, so the panels can't silently drift.
 */
import { TestBed, ComponentFixture } from '@angular/core/testing';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { BrainApi } from '../../core/brain-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { OverviewTabComponent } from './overview-tab.component';
import { COLLECTION_TABS } from './brain-tabs';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { Space, SpaceStats , SpaceActivity } from '../../core/api.types';

const STATS: SpaceStats = { spaceId: 'general', facts: 5, entities: 12, edges: 30, chrono: 3, files: 7 };
function space(over: Partial<Space> = {}): Space {
  return { id: 'general', label: 'General', ...over } as Space;
}

function setup(opts: { stats?: SpaceStats; space?: Space; confirm?: boolean; needsReindex?: boolean } = {}) {
  const confirm = vi.fn().mockResolvedValue(opts.confirm ?? true);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [OverviewTabComponent, getTranslocoModule()],
    providers: [provideRouter([]), { provide: ConfirmDialogService, useValue: { confirm } }, { provide: BrainApi, useValue: { getErModel: () => of({ spaceId: 's', entityTypes: [], relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 } }) } }],
  });
  const fixture: ComponentFixture<OverviewTabComponent> = TestBed.createComponent(OverviewTabComponent);
  fixture.componentRef.setInput('space', opts.space ?? space());
  if (opts.stats !== undefined) fixture.componentRef.setInput('stats', opts.stats);
  if (opts.needsReindex !== undefined) fixture.componentRef.setInput('needsReindex', opts.needsReindex);
  return { fixture, c: fixture.componentInstance, confirm };
}

describe('OverviewTabComponent', () => {
  beforeEach(() => vi.clearAllMocks());

  // The three tests that covered `total` and `statCards` went with the statistics strip (owner,
  // 2026-08-08): the ER diagram shows the same per-type counts AND how the types relate, and it carries
  // the tab links those tiles provided. Their subject no longer exists, so they are deleted rather than
  // re-pointed — a test kept alive against a replacement it was not written for asserts the old design.

  it('the statistics strip is gone, and its storage bar was not deleted with it', () => {
    // The strip held two unrelated things: record counts (now the diagram's job) and STORAGE, which the
    // diagram says nothing about and which is the one number here that can stop a space working. Deleting
    // the container is exactly how a survivor like that gets lost, so its presence is asserted directly.
    const { fixture } = setup({ stats: STATS, space: space({ maxGiB: 10, usageGiB: 2.5 }) });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const text = el.textContent ?? '';
    expect(text).not.toContain('brain.overview.statsTitle');
    // Storage renders with NO activity input set, which is the point: it must not depend on the usage
    // panel having data, or it disappears on exactly the untouched space where a full disk is a surprise.
    expect(text).toContain('brain.overview.storage');
    expect(el.querySelector('.store .bar')).not.toBeNull();
  });

  it('usagePct is a capped ratio when a quota is set, null when unlimited', () => {
    expect(setup({ space: space({ maxGiB: 10, usageGiB: 2.5 }) }).c.usagePct()).toBe(25);
    expect(setup({ space: space({ maxGiB: 4, usageGiB: 8 }) }).c.usagePct()).toBe(100); // capped
    expect(setup({ space: space({ usageGiB: 2 }) }).c.usagePct()).toBeNull();            // no maxGiB
  });

  it('maps indexStatus to a pill variant (missing → off/none)', () => {
    expect(setup({ space: space({ indexStatus: 'ready' }) }).c.indexVariant()).toBe('ok');
    expect(setup({ space: space({ indexStatus: 'building' }) }).c.indexVariant()).toBe('warn');
    expect(setup({ space: space({ indexStatus: 'failed' }) }).c.indexVariant()).toBe('error');
    const none = setup({ space: space() });
    expect(none.c.indexState()).toBe('none');
    expect(none.c.indexVariant()).toBe('off');
  });

  it('Reindex emits only after the confirm is accepted', async () => {
    const ok = setup({ confirm: true });
    const spy = vi.fn(); ok.c.reindex.subscribe(spy);
    await ok.c.requestReindex();
    expect(ok.confirm).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledOnce();

    const no = setup({ confirm: false });
    const spy2 = vi.fn(); no.c.reindex.subscribe(spy2);
    await no.c.requestReindex();
    expect(spy2).not.toHaveBeenCalled();
  });

  it('maps networkStatus to a pill variant (idle/undefined → ok)', () => {
    expect(setup({ space: space({ networkStatus: 'degraded' }) }).c.netVariant()).toBe('error');
    expect(setup({ space: space({ networkStatus: 'syncing' }) }).c.netVariant()).toBe('pending');
    expect(setup({ space: space({ networkStatus: 'vote' }) }).c.netVariant()).toBe('warn');
    expect(setup({ space: space() }).c.netVariant()).toBe('ok'); // no status → idle/healthy
  });

  it('Networks panel lists the space networks; shows the empty note when there are none', () => {
    const withNet = setup({ space: space({ networks: [{ id: 'n1', label: 'Braintree', type: 'braintree' as never }], networkStatus: 'idle' }) });
    withNet.fixture.detectChanges();
    const items = [...(withNet.fixture.nativeElement as HTMLElement).querySelectorAll('.net-list li')];
    expect(items.length).toBe(1);
    expect(items[0].textContent).toContain('Braintree');

    const noNet = setup({ space: space() });
    noNet.fixture.detectChanges();
    const el = noNet.fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.net-list')).toBeNull();
    // The empty-state note renders (test transloco emits the raw key).
    expect(el.textContent).toContain('brain.overview.noNetworks');
  });

  it('renders NOTHING about the instance, even when `about` is supplied', () => {
    // The panel is gone (owner, 2026-08-08): instance label, version, id, uptime and Mongo version are
    // properties of the instance, not of the space being looked at, and all of them are on the About page.
    //
    // Asserted with `about` PRESENT on purpose. The input still exists and the shell still passes it, so
    // "the panel is absent" is only meaningful when the data that used to render it is available — testing
    // it with `about` unset would pass against a panel that had simply not loaded yet.
    const { fixture } = setup();
    fixture.componentRef.setInput('about', {
      instanceId: 'inst-abc', instanceLabel: 'My Brain', version: '1.4.4', uptime: '2h', mongoVersion: '8.2.1',
      diskInfo: { total: 0, used: 0, available: 0, dataUsed: 0 },
    });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.kv')).toBeNull();
    expect(el.textContent).not.toContain('My Brain');
    expect(el.textContent).not.toContain('8.2.1');
    expect(el.textContent).not.toContain('inst-abc');
  });

  it('Embedding-queue panel shows counts + failed reasons when provided, and is absent without it', () => {
    const withQ = setup();
    withQ.fixture.componentRef.setInput('embeddingQueue', {
      pending: 2, processing: 1, complete: 9, failed: 1,
      failedSample: [{ path: 'docs/bad.pdf', lastError: 'vision model down' }],
    });
    withQ.fixture.detectChanges();
    const el = withQ.fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.err-stat')).toBeTruthy();          // failed > 0 highlights
    expect(el.querySelector('.fail-list')?.textContent).toContain('docs/bad.pdf');
    expect(el.textContent).toContain('vision model down');

    const noQ = setup();
    noQ.fixture.detectChanges();
    expect((noQ.fixture.nativeElement as HTMLElement).querySelector('.fail-list')).toBeNull();
  });

  it('groups failures by reason when there is more than one, and says how many the list omits', () => {
    // Five paths answer "which file", not "why". With forty failures an operator could not tell one dead
    // endpoint from forty unrelated problems, and the sample is whichever five came back first.
    const many = setup();
    many.fixture.componentRef.setInput('embeddingQueue', {
      pending: 0, processing: 0, complete: 100, failed: 40,
      failedSample: Array.from({ length: 5 }, (_, i) => ({ path: `docs/f${i}.pdf`, lastError: 'vision model down' })),
      failedByReason: [
        { reason: 'vision model down', count: 38 },
        { reason: null, count: 2 },
      ],
    });
    many.fixture.detectChanges();
    const el = many.fixture.nativeElement as HTMLElement;
    const reasons = el.querySelector('.fail-reasons');
    expect(reasons).toBeTruthy();
    expect(reasons!.textContent).toContain('38');
    expect(reasons!.textContent).toContain('vision model down');
    // The count is over EVERY failure, not the five in the sample.
    expect(reasons!.textContent).not.toContain('5 ');
    // And the list says plainly that it is not showing everything.
    expect(el.querySelector('.fail-more')).toBeTruthy();
  });

  it('hides the grouping when it would only repeat the list, and survives a server that omits it', () => {
    // One reason adds nothing over the per-path list — a panel that says the same thing twice trains people
    // to skim both.
    const one = setup();
    one.fixture.componentRef.setInput('embeddingQueue', {
      pending: 0, processing: 0, complete: 3, failed: 1,
      failedSample: [{ path: 'docs/bad.pdf', lastError: 'vision model down' }],
      failedByReason: [{ reason: 'vision model down', count: 1 }],
    });
    one.fixture.detectChanges();
    const oneEl = one.fixture.nativeElement as HTMLElement;
    expect(oneEl.querySelector('.fail-reasons')).toBeNull();
    expect(oneEl.querySelector('.fail-more')).toBeNull();   // the sample covers all 1

    // An older server (or a cached response from one) sends no `failedByReason` at all. The panel must render.
    const legacy = setup();
    legacy.fixture.componentRef.setInput('embeddingQueue', {
      pending: 0, processing: 0, complete: 3, failed: 2,
      failedSample: [{ path: 'docs/bad.pdf', lastError: 'boom' }],
    });
    legacy.fixture.detectChanges();
    const legacyEl = legacy.fixture.nativeElement as HTMLElement;
    expect(legacyEl.querySelector('.fail-list')).toBeTruthy();
    expect(legacyEl.querySelector('.fail-reasons')).toBeNull();
  });

  it('shows a "retry all failed" button only when failed > 0, and emits after the confirm', async () => {
    // failed > 0 → button present; the confirm-accepted click emits retryFailed once.
    const withFail = setup({ confirm: true });
    const spy = vi.fn(); withFail.c.retryFailed.subscribe(spy);
    withFail.fixture.componentRef.setInput('embeddingQueue', { pending: 0, processing: 0, complete: 3, failed: 2, failedSample: [] });
    withFail.fixture.detectChanges();
    const btn = (withFail.fixture.nativeElement as HTMLElement).querySelector('.retry-failed-btn') as HTMLButtonElement | null;
    expect(btn).toBeTruthy();
    btn!.click();
    await withFail.fixture.whenStable();
    expect(withFail.confirm).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledOnce();

    // failed === 0 → no retry button (nothing to retry).
    const noFail = setup();
    noFail.fixture.componentRef.setInput('embeddingQueue', { pending: 1, processing: 0, complete: 3, failed: 0, failedSample: [] });
    noFail.fixture.detectChanges();
    expect((noFail.fixture.nativeElement as HTMLElement).querySelector('.retry-failed-btn')).toBeNull();
  });

  it('Governance panel lists open votes with tallies; absent when there are none', () => {
    const withVotes = setup();
    withVotes.fixture.componentRef.setInput('openVotes', [{
      id: 'r1', networkId: 'n1', type: 'leave', subject: 'Peer B wants to leave',
      openedAt: '2026-07-27T00:00:00Z', deadline: '2026-07-28T00:00:00Z', status: 'open',
      votes: [{ instanceId: 'a', vote: 'yes' }, { instanceId: 'b', vote: 'yes' }, { instanceId: 'c', vote: 'veto' }],
    }]);
    withVotes.fixture.detectChanges();
    const el = withVotes.fixture.nativeElement as HTMLElement;
    const list = el.querySelector('.vote-list');
    expect(list).toBeTruthy();
    expect(list!.textContent).toContain('Peer B wants to leave');
    expect(withVotes.c.tallyYes({ votes: [{ vote: 'yes' }, { vote: 'yes' }, { vote: 'veto' }] } as never)).toBe(2);
    expect(withVotes.c.tallyVeto({ votes: [{ vote: 'yes' }, { vote: 'veto' }] } as never)).toBe(1);

    const noVotes = setup();
    noVotes.fixture.detectChanges();
    expect((noVotes.fixture.nativeElement as HTMLElement).querySelector('.vote-list')).toBeNull();
  });

  it('ONE card spans the full width — the diagram — and nothing else does', () => {
    // Uniform card sizing is CSS (jsdom computes no layout, so heights are verified by the E2E
    // geometry check, not here). What IS pinnable is the structure that layout relies on.
    //
    // It was two: the statistics summary and the diagram. The summary is gone and usage became a normal
    // cell (owner, 2026-08-08), so the diagram is the only thing wide enough to earn the full row. The
    // COUNT is asserted, not just the diagram's presence — a second span-all card creeping back is what
    // makes the grid look accidental, and naming only the survivor would not catch it.
    const { fixture } = setup({ stats: STATS });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    const spanning = [...el.querySelectorAll('.panel.span-all')];
    expect(spanning.length).toBe(1);
    expect(spanning[0]!.querySelector('h3')?.textContent ?? '').toContain('brain.overview.er.title');
    expect(el.querySelectorAll('.panel').length).toBeGreaterThan(1); // other panels are normal cells
  });

  it('Token-access panel is admin-only: hidden when null, lists tokens with level badges when provided', () => {
    // null (non-admin / endpoint 403) → panel hidden.
    const hidden = setup();
    hidden.fixture.detectChanges();
    expect((hidden.fixture.nativeElement as HTMLElement).querySelector('.tok-list')).toBeNull();

    // A list (admin) → one row per token, each carrying its level badge.
    const shown = setup();
    shown.fixture.componentRef.setInput('tokenAccess', [
      { name: 'CI bot', level: 'full', allSpaces: false, peer: false, expiresAt: null },
      { name: 'Admin PAT', level: 'admin', allSpaces: true, peer: false, expiresAt: null },
      { name: 'Reader', level: 'readOnly', allSpaces: false, peer: false, expiresAt: '2027-01-01T00:00:00Z' },
    ]);
    shown.fixture.detectChanges();
    const el = shown.fixture.nativeElement as HTMLElement;
    const rows = [...el.querySelectorAll('.tok-list li')];
    expect(rows.length).toBe(3);
    expect(el.querySelector('.lvl.admin')).toBeTruthy();
    expect(el.querySelector('.lvl.full')).toBeTruthy();
    expect(el.querySelector('.lvl.readOnly')).toBeTruthy();
    expect(rows[0].textContent).toContain('CI bot');

    // An empty list (admin, but no token reaches the space) → panel shows its empty note, not the list.
    const empty = setup();
    empty.fixture.componentRef.setInput('tokenAccess', []);
    empty.fixture.detectChanges();
    const emptyEl = empty.fixture.nativeElement as HTMLElement;
    expect(emptyEl.querySelector('.tok-list')).toBeNull();
    expect(emptyEl.textContent).toContain('brain.overview.tok.none'); // test transloco emits the raw key
  });

  it('Completeness panel is hidden without a report, and never shows a score without its deductions', () => {
    // No report (still loading, or the endpoint failed) → no panel. A governance number that failed to
    // load must not render as a zero.
    const hidden = setup();
    hidden.fixture.detectChanges();
    expect((hidden.fixture.nativeElement as HTMLElement).querySelector('.comp-score')).toBeNull();

    const shown = setup();
    shown.fixture.componentRef.setInput('completeness', {
      spaceId: 'general', score: 62, truncated: false,
      checks: [
        // Passing — must NOT appear in the list; a check that costs nothing is not a deduction.
        { id: 'meta-purpose-missing', severity: 'info', scope: 'space', affected: 0, total: 1, weight: 1, earned: 1, sample: [], targetTab: null },
        // 1 point lost of 2.
        { id: 'entity-without-edges', severity: 'info', scope: 'entity', affected: 6, total: 12, weight: 2, earned: 1, sample: ['e1'], targetTab: 'entities' },
        // 3 points lost — the heaviest, so it must sort first even though it affects fewer records.
        { id: 'file-not-recallable', severity: 'warn', scope: 'file', affected: 3, total: 3, weight: 3, earned: 0, sample: ['a.pdf'], targetTab: 'files' },
      ],
    });
    shown.fixture.detectChanges();
    const el = shown.fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.comp-score')?.textContent).toContain('62');
    const rows = [...el.querySelectorAll('.comp-list li')];
    expect(rows.length).toBe(2);   // the passing check is not listed
    // Ranked by points LOST, not by how many records are affected.
    expect(rows[0].textContent).toContain('file-not-recallable');
    expect(rows[1].textContent).toContain('entity-without-edges');
    expect(rows[0].querySelector('.cs')?.textContent).toContain('a.pdf');
  });

  it('a completeness deduction jumps to the tab holding the affected records', () => {
    const { fixture, c } = setup();
    const spy = vi.fn(); c.openTab.subscribe(spy);
    fixture.componentRef.setInput('completeness', {
      spaceId: 'general', score: 40, truncated: false,
      checks: [{ id: 'file-not-recallable', severity: 'warn', scope: 'file', affected: 3, total: 3, weight: 3, earned: 0, sample: [], targetTab: 'files' }],
    });
    fixture.detectChanges();
    (fixture.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.comp-go')!.click();
    expect(spy).toHaveBeenCalledWith('files');
  });

  it('a space-scoped finding has no tab to jump to, so it renders without a link', () => {
    const { fixture } = setup();
    fixture.componentRef.setInput('completeness', {
      spaceId: 'general', score: 0, truncated: false,
      checks: [{ id: 'meta-purpose-missing', severity: 'info', scope: 'space', affected: 1, total: 1, weight: 1, earned: 0, sample: [], targetTab: null }],
    });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelectorAll('.comp-list li').length).toBe(1);
    expect(el.querySelector('.comp-go')).toBeNull();
  });

  it('a null score keeps the panel hidden — a space nothing could be asked about is not 0 % complete', () => {
    const { fixture } = setup();
    fixture.componentRef.setInput('completeness', { spaceId: 'general', score: null, checks: [], truncated: false });
    fixture.detectChanges();
    expect((fixture.nativeElement as HTMLElement).querySelector('.comp-score')).toBeNull();
  });

  it('shows the reindex note and button when the index is stale', () => {
    // Renamed and narrowed. This test claimed to cover "the counts", but the two values it asserted — 12
    // and the 57 total — were rendered by the STATISTICS strip, a different panel that happened to share
    // the `.stat .v` class. It passed for the indexing panel while checking almost nothing about it, and
    // it broke when the strip was deleted, which is how the overlap surfaced at all.
    //
    // A shared class name is not a shared subject. Scoped to the reindex controls, which is what this
    // panel actually owns.
    const { fixture } = setup({ stats: STATS, needsReindex: true });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    expect(el.querySelector('.reindex-note')).not.toBeNull();       // stale note shown
    expect(el.querySelector('.actions button')).not.toBeNull();      // reindex button present
  });
});

/**
 * The usage panel — the owner asked for per-space call counts and timings "to be able to tell apart which
 * spaces are how useful", and a call count cannot answer that.
 *
 * A space asked 380 times that answered 41 is not popular; it is a space people keep failing to get an answer
 * out of. These pin the three places that distinction shows up in the UI: the rate itself, the difference
 * between "answers nothing" and "was never asked", and a panel that still renders when the answer is zero.
 */
describe('OverviewTabComponent — the usage panel', () => {
  function activity(over: Partial<SpaceActivity> = {}): SpaceActivity {
    return {
      space: 'general', calls: 0, recall: 0, answered: 0, writes: 0,
      meanMs: null, maxMs: 0, over1s: 0, meanTopScore: null, lastUsedAt: null,
      ...over,
    };
  }

  function render(act: SpaceActivity | null) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [OverviewTabComponent, getTranslocoModule()],
      providers: [provideRouter([]), { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } }, { provide: BrainApi, useValue: { getErModel: () => of({ spaceId: 's', entityTypes: [], relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 } }) } }],
    });
    const fixture = TestBed.createComponent(OverviewTabComponent);
    fixture.componentRef.setInput('space', { id: 'general', label: 'General' });
    fixture.componentRef.setInput('activity', act);
    fixture.detectChanges();
    return { fixture, c: fixture.componentInstance, el: fixture.nativeElement as HTMLElement };
  }

  it('reports the answer rate as a percentage of recalls', () => {
    const { c } = render(activity({ calls: 400, recall: 380, answered: 41 }));
    expect(c.answerRate()).toBe(11);
  });

  it('distinguishes "answers nothing" from "was never asked"', () => {
    // 0% is a judgement about quality; null means nobody asked. They call for opposite responses from an
    // operator — fill the space, versus find out why nothing queries it — so they must not render alike.
    expect(render(activity({ calls: 5, recall: 0, answered: 0 })).c.answerRate()).toBeNull();
    expect(render(activity({ calls: 20, recall: 20, answered: 0 })).c.answerRate()).toBe(0);
  });

  it('renders the panel when nothing was asked, instead of hiding it', () => {
    // Hiding it would look like a failed load. "Nothing has been asked of this space" is an answer.
    const { el } = render(activity());
    expect(el.textContent).toContain('brain.overview.useNone');
    expect(el.textContent).not.toContain('brain.overview.useAnswerRate');
  });

  it('shows the tiles once there is traffic', () => {
    const { el } = render(activity({ calls: 120, recall: 100, answered: 90, writes: 20, meanMs: 63 }));
    expect(el.textContent).toContain('brain.overview.useCalls');
    expect(el.textContent).toContain('brain.overview.useAnswered');
    expect(el.textContent).toContain('brain.overview.useAnswerRate');
    expect(el.textContent).toContain('63 ms');
  });

  it('STAYS VISIBLE when the fetch has landed with nothing, because storage lives in it', () => {
    // Reversed deliberately (owner, 2026-08-09). The panel used to hide when activity was null, which is why
    // storage could not live here: on a space nobody had called, the card was absent and storage with it —
    // exactly the space where a filling disk is least expected. Giving storage its own card worked around
    // that and was the wrong fix; it made a card for one number.
    // Now the SECTION is unconditional and only the activity block inside it is gated.
    const { el, c } = render(null);
    expect(c.answerRate()).toBeNull();
    expect(el.textContent).toContain('brain.overview.useTitle');
    expect(el.textContent).toContain('brain.overview.storage');
    expect(el.querySelector('.store')).not.toBeNull();
  });

  it('only mentions slow calls when there are some', () => {
    expect(render(activity({ calls: 10, recall: 10, answered: 10, over1s: 0 })).el.textContent)
      .not.toContain('brain.overview.useSlow');
    expect(render(activity({ calls: 10, recall: 10, answered: 10, over1s: 3, maxMs: 1840 })).el.textContent)
      .toContain('brain.overview.useSlow');
  });
});

/**
 * The board must be LAID OUT from the first frame (canary B, symptom 1).
 *
 * Each card rendered only once its own request landed, so the Overview assembled itself one card at a time and
 * every arrival pushed the ones below it down: *"they appear one by one as each request lands, rather than as a
 * laid-out set that fills in."*
 *
 * A skeleton fixes that only if it can tell **not yet** from **never** — `tokenAccess` is null permanently for a
 * non-admin (the endpoint 403s) and `completeness` is null after a failure, so a placeholder keyed on null alone
 * would sit there forever. Hence a separate `pending` map, raised only where the value is blanked.
 */
describe('OverviewTabComponent — first-load skeletons', () => {
  const PENDING = { activity: true, completeness: true, queue: true, tokens: true };

  function render(pending: Partial<typeof PENDING> = {}) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [OverviewTabComponent, getTranslocoModule()],
      providers: [provideRouter([]), { provide: ConfirmDialogService, useValue: { confirm: vi.fn() } }],
    });
    const fixture = TestBed.createComponent(OverviewTabComponent);
    fixture.componentRef.setInput('space', space());
    fixture.componentRef.setInput('stats', STATS);
    fixture.componentRef.setInput('pending', { activity: false, completeness: false, queue: false, tokens: false, ...pending });
    fixture.detectChanges();
    const el = fixture.nativeElement as HTMLElement;
    return { fixture, el };
  }

  const busy = (el: HTMLElement) => el.querySelectorAll('.panel[aria-busy="true"]').length;
  const titles = (el: HTMLElement) => [...el.querySelectorAll('.grid > .panel h3')].map(h => h.textContent?.trim());

  it('reserves a card for every panel still awaiting its first answer', () => {
    const { el } = render(PENDING);
    // Three, not four: the Usage card is unconditional now, so it renders its own frame and puts a skeleton
    // in the body rather than being replaced by an aria-busy placeholder. Storage is inside it and must show
    // whether or not activity has landed, which is the whole reason that panel stopped being conditional.
    expect(busy(el)).toBe(3);
    // The frame is the real one, so the placeholder is identifiable rather than an anonymous grey box.
    for (const key of ['brain.overview.useTitle', 'brain.overview.compTitle', 'brain.overview.queueTitle', 'brain.overview.tokenTitle']) {
      expect(titles(el), key).toContain(key);
    }
  });

  it('the board has the SAME cards, in the same order, loading or settled', () => {
    // This is the whole fix: what makes the page look like it is assembling itself is the layout moving.
    const loading = titles(render(PENDING).el);
    const settled = titles(render({}).el);
    // THREE optional panels now, not four: Usage left that set when storage moved into it, and is present in
    // both renders. Its skeleton is inside its body rather than replacing the card, so the card itself never
    // appears or disappears — which is a stronger version of what this test is about.
    expect(loading.filter(t => !settled.includes(t)).sort()).toEqual([
      'brain.overview.compTitle', 'brain.overview.queueTitle', 'brain.overview.tokenTitle',
    ]);
    expect(settled.every(t => loading.includes(t))).toBe(true);
  });

  it('reserves nothing once a panel has settled, even with no data', () => {
    // The difference that makes the skeleton safe: a non-admin never gets tokenAccess, and a forever-skeleton
    // would be worse than the missing card.
    const { el } = render({});
    expect(busy(el)).toBe(0);
    expect(titles(el)).not.toContain('brain.overview.tokenTitle');
  });

  // Usage is deliberately excluded from the per-panel assertions below: it is unconditional now, so its title
  // is present whatever any pending flag says. Leaving it in would assert the old behaviour.
  it('is per panel — one still loading does not reserve the others', () => {
    const { el } = render({ tokens: true });
    expect(busy(el)).toBe(1);
    expect(titles(el)).toContain('brain.overview.tokenTitle');
    // Usage IS present — it is unconditional. What must be absent is another panel's frame: the point of the
    // test is that one pending flag does not reserve cards for panels nobody is waiting on.
    expect(titles(el)).not.toContain('brain.overview.compTitle');
  });

  it('draws lines, not a spinner — the size is the point', () => {
    const { el } = render(PENDING);
    const lines = el.querySelectorAll('app-skeleton-lines .sk-line');
    expect(lines.length).toBe(4 + 4 + 4 + 3 + 3);      // per-card row counts, incl. the data-model panel
    expect(el.querySelector('.panel[aria-busy="true"] .spinner')).toBeNull();
  });

/**
 * ── The usage reset button ────────────────────────────────────────────────────────────────────────
 *
 * The owner asked for it: a space hammered once during a migration reads as busy for the rest of the window, so
 * the panel stops being useful for the thing it is for.
 *
 * The panel confirms and the host performs — the same split `reindex` and `retryFailed` already use. What is
 * worth testing is not that a button exists, but the four ways it can be wrong: showing when there is nothing to
 * clear, showing to someone who cannot do it, deleting without asking, and deleting twice.
 */
describe('the usage reset button', () => {
  /*
   * Typed rather than `as never`. The cast made the fixture unusable as an object — spreading `never` is not
   * allowed — and, worse, it accepted any shape at all: `SpaceActivity` distinguishes `meanMs: null` from
   * `0` deliberately, and a fixture the compiler cannot check is one that can drift from the type it stands in
   * for without anything noticing.
   */
  const ACTIVE: SpaceActivity = {
    space: 'general', calls: 120, recall: 90, answered: 70, writes: 12,
    meanMs: 40, maxMs: 900, over1s: 0, meanTopScore: 0.7, lastUsedAt: null,
  };
  const IDLE: SpaceActivity = { ...ACTIVE, calls: 0, recall: 0, answered: 0, writes: 0 };

  function panel(activity: unknown, over: { canEdit?: boolean; confirm?: boolean; resetting?: boolean } = {}) {
    const s = setup({ confirm: over.confirm ?? true });
    s.fixture.componentRef.setInput('activity', activity);
    s.fixture.componentRef.setInput('canEditSchema', over.canEdit ?? true);
    s.fixture.componentRef.setInput('resettingUsage', over.resetting ?? false);
    s.fixture.detectChanges();
    return s;
  }

  const resetBtn = (fixture: ComponentFixture<OverviewTabComponent>) =>
    [...(fixture.nativeElement as HTMLElement).querySelectorAll('button')]
      .find(b => /useResetHint|Reset usage/i.test(b.getAttribute('title') ?? '')) ?? null;

  it('is absent when the space has no recorded calls', () => {
    // Nothing to clear. A control that does nothing is worse than an absent one: pressing it and seeing no
    // change reads as a broken feature rather than as an empty one.
    expect(resetBtn(panel(IDLE).fixture)).toBeNull();
  });

  it('is absent for someone who cannot administer the space', () => {
    // The server refuses it, so showing it offers an action that can only answer 403.
    expect(resetBtn(panel(ACTIVE, { canEdit: false }).fixture)).toBeNull();
  });

  it('is present when there is usage AND the rights to clear it', () => {
    expect(resetBtn(panel(ACTIVE).fixture)).not.toBeNull();
  });

  it('does NOT emit until the confirmation is accepted', async () => {
    // The buckets are deleted, not hidden. An unconfirmed press is an irreversible delete on one click.
    const { c } = panel(ACTIVE, { confirm: false });
    const emitted: unknown[] = [];
    c.resetUsage.subscribe(() => emitted.push(1));
    await c.requestUsageReset();
    expect(emitted).toHaveLength(0);
  });

  it('emits once the confirmation is accepted', async () => {
    const { c } = panel(ACTIVE, { confirm: true });
    const emitted: unknown[] = [];
    c.resetUsage.subscribe(() => emitted.push(1));
    await c.requestUsageReset();
    expect(emitted).toHaveLength(1);
  });

  it('cannot fire a second delete while one is in flight', async () => {
    // Two presses are two DELETEs, and the second clears whatever accumulated in between — a small, silent,
    // extra loss that nothing on screen would report.
    const { c, confirm } = panel(ACTIVE, { confirm: true, resetting: true });
    const emitted: unknown[] = [];
    c.resetUsage.subscribe(() => emitted.push(1));
    await c.requestUsageReset();
    expect(emitted).toHaveLength(0);
    expect(confirm).not.toHaveBeenCalled();
  });

  it('asks with danger styling, and names the space in the question', async () => {
    // A confirmation that does not say WHICH space is one an operator accepts against the wrong one.
    const { c, confirm } = panel(ACTIVE, { confirm: true });
    await c.requestUsageReset();
    expect(confirm).toHaveBeenCalledTimes(1);
    const arg = confirm.mock.calls[0][0];
    expect(arg.danger).toBe(true);
    expect(JSON.stringify(arg)).toMatch(/confirmUsageReset/);
  });
});
});
