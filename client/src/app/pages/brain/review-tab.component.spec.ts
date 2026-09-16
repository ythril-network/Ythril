/**
 * ReviewTabComponent characterization tests.
 *
 * Written BEFORE the PR-U8 UX rework (comparison cards, confidence meter, guarded Dismiss, SummaryStrip)
 * and proven green against the ORIGINAL component. Pins the load/scan/dismiss/merge behaviour that must
 * survive — including the CURRENT unguarded Dismiss (U8 adds a confirm; this test documents today's
 * behaviour so that change is explicit) and the confirm-guarded Merge.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ReviewTabComponent } from './review-tab.component';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { DuplicateRecord } from '../../core/api.types';

const rec = (over: Partial<DuplicateRecord> = {}): DuplicateRecord => ({
  id: 'd1', spaceId: 's', type: 'entity', aId: 'a', aSummary: 'A', bId: 'b', bSummary: 'B',
  score: 0.9, status: 'open', detectedAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
});

function setup(
  api: Partial<Record<string, unknown>> = {},
  confirmResult = true,
  conApi: Partial<Record<string, unknown>> = {},
  compApi: Partial<Record<string, unknown>> = {},
) {
  const toastErrors: string[] = [];
  const toastInfos: string[] = [];
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ReviewTabComponent, getTranslocoModule()],
    providers: [
      { provide: SpacesApi, useValue: {
        getCompleteness: () => of({ spaceId: 'work', score: null, checks: [], truncated: false }),
        ...compApi,
      } },
      { provide: BrainApi, useValue: { getEntitiesByIds: () => of({ entities: [] }), getRecord: () => of({ _id: 'x', name: 'full record' }), ...compApi } },
      { provide: DuplicatesApi, useValue: {
        listDuplicates: () => of({ duplicates: [] }),
        scanDuplicates: () => of({}),
        dismissDuplicate: () => of({ status: 'ok' }),
        mergeDuplicate: () => of({ status: 'ok' }),
        ...api,
      } },
      { provide: ContradictionsApi, useValue: {
        listContradictions: () => of({ contradictions: [] }),
        dismissContradiction: () => of({ status: 'ok' }),
        reopenContradiction: () => of({ status: 'ok' }),
        resolveContradiction: () => of({ status: 'resolved', resolution: 'edited' }),
        keepSide: () => of({ status: 'resolved', resolution: 'superseded', supersededId: 'b', resolvedBy: 'Admin' }),
        ...conApi,
      } },
      { provide: ToastService, useValue: { error: (m: string) => toastErrors.push(m), success: () => {}, info: (m: string) => toastInfos.push(m), show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(confirmResult) } },
    ],
  });
  const f = TestBed.createComponent(ReviewTabComponent);
  f.componentInstance.spaceId = 'work';   // per-space now: the tab always reviews one space
  f.detectChanges(); // ngOnInit → load()
  return { f, c: f.componentInstance, toastErrors, toastInfos };
}

describe('ReviewTabComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('load populates rows and clears loading', () => {
    const { c } = setup({ listDuplicates: () => of({ duplicates: [rec(), rec({ id: 'd2' })] }) });
    expect(c.rows().length).toBe(2);
    expect(c.loading()).toBe(false);
    expect(c.error()).toBe(false);
  });

  it('a load failure sets the error state', () => {
    const { c } = setup({ listDuplicates: () => throwError(() => ({})) });
    expect(c.error()).toBe(true);
    expect(c.loading()).toBe(false);
  });

  it('dismiss (confirmed) on the "open" filter removes the row optimistically', async () => {
    const { c } = setup({}, true);
    c.statusFilter = 'open';
    c.rows.set([rec({ id: 'd1' }), rec({ id: 'd2' })]);
    await c.dismiss(rec({ id: 'd1' }));
    expect(c.rows().map(r => r.id)).toEqual(['d2']);
  });

  it('dismiss (confirmed) on the "all" filter keeps the row but marks it dismissed', async () => {
    const { c } = setup({}, true);
    c.statusFilter = 'all';
    c.rows.set([rec({ id: 'd1', status: 'open' })]);
    await c.dismiss(rec({ id: 'd1' }));
    expect(c.rows()[0]).toMatchObject({ id: 'd1', status: 'dismissed' });
  });

  it('dismiss is now guarded: cancelling the confirm leaves the row untouched', async () => {
    const dismissSpy = vi.fn().mockReturnValue(of({ status: 'ok' }));
    const { c } = setup({ dismissDuplicate: dismissSpy }, false);
    c.statusFilter = 'open';
    c.rows.set([rec({ id: 'd1' })]);
    await c.dismiss(rec({ id: 'd1' }));
    expect(dismissSpy).not.toHaveBeenCalled();
    expect(c.rows().map(r => r.id)).toEqual(['d1']);
  });

  it('merge asks for confirmation and, when confirmed, calls the API and removes the row', async () => {
    const mergeSpy = vi.fn().mockReturnValue(of({ status: 'ok' }));
    const { c } = setup({ mergeDuplicate: mergeSpy }, true);
    c.rows.set([rec({ id: 'd1' }), rec({ id: 'd2' })]);
    await c.merge(rec({ id: 'd1' }));
    expect(mergeSpy).toHaveBeenCalledWith('d1');
    expect(c.rows().map(r => r.id)).toEqual(['d2']);
  });

  it('merge does nothing when the confirmation is cancelled', async () => {
    const mergeSpy = vi.fn().mockReturnValue(of({ status: 'ok' }));
    const { c } = setup({ mergeDuplicate: mergeSpy }, false);
    c.rows.set([rec({ id: 'd1' })]);
    await c.merge(rec({ id: 'd1' }));
    expect(mergeSpy).not.toHaveBeenCalled();
    expect(c.rows().map(r => r.id)).toEqual(['d1']);
  });

  it('scan surfaces a distinct message for 403 vs other errors', () => {
    const forbidden = setup({ scanDuplicates: () => throwError(() => ({ status: 403 })) });
    forbidden.c.scan();
    expect(forbidden.toastErrors).toContain('duplicates.scanForbidden');

    const other = setup({ scanDuplicates: () => throwError(() => ({ status: 500 })) });
    other.c.scan();
    expect(other.toastErrors).toContain('duplicates.scanError');
  });

  it('re-rate on the "dismissed" filter removes the row (it is no longer dismissed)', () => {
    const reopen = vi.fn(() => of({ status: 'open' }));
    const { c } = setup({
      listDuplicates: () => of({ duplicates: [rec({ id: 'd1', status: 'dismissed' }), rec({ id: 'd2', status: 'dismissed' })] }),
      reopenDuplicate: reopen,
    });
    c.statusFilter = 'dismissed';
    c.reopen(rec({ id: 'd1', status: 'dismissed' }));
    expect(reopen).toHaveBeenCalledWith('d1');
    expect(c.rows().map(r => r.id)).toEqual(['d2']);
  });

  it('re-rate on the "all" filter flips the row back to open in place', () => {
    const { c } = setup({
      listDuplicates: () => of({ duplicates: [rec({ id: 'd1', status: 'dismissed' })] }),
      reopenDuplicate: () => of({ status: 'open' }),
    });
    c.statusFilter = 'all';
    c.reopen(rec({ id: 'd1', status: 'dismissed' }));
    expect(c.rows()[0]).toMatchObject({ id: 'd1', status: 'open' });
  });

  it('a re-rate failure surfaces an error toast and leaves the row', () => {
    const { c, toastErrors } = setup({
      listDuplicates: () => of({ duplicates: [rec({ id: 'd1', status: 'dismissed' })] }),
      reopenDuplicate: () => throwError(() => ({ error: { error: 'nope' } })),
    });
    c.statusFilter = 'dismissed';
    c.reopen(rec({ id: 'd1', status: 'dismissed' }));
    expect(toastErrors).toContain('nope');
    expect(c.rows().map(r => r.id)).toEqual(['d1']);
  });

  it('the search box narrows filteredRows over summaries/type/space, leaving rows() intact', () => {
    const { c } = setup({
      listDuplicates: () => of({ duplicates: [
        rec({ id: 'd1', aSummary: 'Vault secrets', bSummary: 'secret store' }),
        rec({ id: 'd2', aSummary: 'Telemetry', bSummary: 'metrics' }),
      ] }),
    });
    c.query.set('vault');
    expect(c.filteredRows().map(r => r.id)).toEqual(['d1']);
    expect(c.rows().length).toBe(2); // the underlying list is untouched
    c.query.set('');
    expect(c.filteredRows().length).toBe(2);
  });

  it('renders a Re-rate button on a dismissed row and a search box, and the button reopens', () => {
    const reopen = vi.fn(() => of({ status: 'open' }));
    const { f } = setup({
      listDuplicates: () => of({ duplicates: [rec({ id: 'd1', status: 'dismissed', type: 'entity' })] }),
      reopenDuplicate: reopen,
    });
    // The Re-rate button keys off the row's own status ('dismissed'), not the filter dropdown, so the
    // single detectChanges in setup() has already rendered it.
    const el = f.nativeElement as HTMLElement;
    expect(el.querySelector('.dup-search input[type="search"]')).not.toBeNull();
    // The dismissed row must offer Re-rate, not Dismiss/Merge.
    const btn = el.querySelector('.dup-actions button') as HTMLButtonElement | null;
    expect(btn).not.toBeNull();
    btn!.click();
    expect(reopen).toHaveBeenCalledWith('d1');
  });

  it('scopes every query to its space, and reloads when the space changes', async () => {
    // The move out of global Settings is only real if the space reaches the API — otherwise the tab would
    // quietly show every space's pairs inside one space's Brain.
    const listDuplicates = vi.fn(() => of({ duplicates: [] }));
    const scanDuplicates = vi.fn(() => of({ scannedSpaces: 1, scanned: 0, pairs: 0 }));
    const { f, c } = setup({ listDuplicates, scanDuplicates });
    expect(listDuplicates).toHaveBeenCalledWith('open', 'work');

    c.scan();
    expect(scanDuplicates).toHaveBeenCalledWith('work');

    // Switching space in the Brain must re-point the tab, not leave the previous space's pairs on screen.
    listDuplicates.mockClear();
    c.spaceId = 'other';
    f.componentRef.setInput?.('spaceId', 'other');
    c.ngOnChanges({ spaceId: { currentValue: 'other', previousValue: 'work', firstChange: false, isFirstChange: () => false } });
    expect(listDuplicates).toHaveBeenCalledWith('open', 'other');
  });

  // Sub-tabs, not a compact toggle: the owner's call was explicitly "not a small toggle that noone finds".
  // The Review tab is the space's record-QA queue and will grow past two views, so it uses the same tab
  // affordance as the rest of the app.
  // Owner's call: the sub-tabs stay KINDS OF FINDING; record type is a filter INSIDE them. Splitting by
  // type as well would produce a duplicates×type / contradictions×type matrix that grows badly.
  describe('record-type filter', () => {
    const mixed = [rec({ id: 'd1', type: 'entity' }), rec({ id: 'd2', type: 'fact' }), rec({ id: 'd3', type: 'chrono' })];

    it('offers only the types actually present, so no choice can yield nothing', () => {
      const { c } = setup({ listDuplicates: () => of({ duplicates: mixed }) });
      expect(c.availableTypes()).toEqual(['chrono', 'entity', 'fact']);
    });

    it('hides the control entirely when everything is one type', () => {
      // A filter with a single real option is noise on a queue that is already one kind of thing.
      const { f, c } = setup({ listDuplicates: () => of({ duplicates: [rec({ type: 'entity' }), rec({ id: 'd2', type: 'entity' })] }) });
      expect(c.availableTypes().length).toBe(1);
      expect((f.nativeElement as HTMLElement).querySelector('#review-type-filter')).toBeNull();
    });

    it('keeps the control visible whenever a filter is applied, even where the type is absent', () => {
      // The signal is shared across sub-tabs. Filtering Duplicates to `memory` and switching to a
      // Contradictions queue with no memory findings must not hide the control while it is still
      // constraining the list — that leaves an empty view with no way to clear it.
      const { f, c } = setup({ listDuplicates: () => of({ duplicates: [rec({ type: 'entity' })] }) });
      expect((f.nativeElement as HTMLElement).querySelector('#review-type-filter')).toBeNull();
      c.typeFilter.set('fact');
      f.detectChanges();
      expect(c.showTypeFilter()).toBe(true);
      expect((f.nativeElement as HTMLElement).querySelector('#review-type-filter')).not.toBeNull();
    });

    it('offers the active filter as an option even when this tab has none of that type', () => {
      // Otherwise the <select> holds a value with no matching <option> and renders blank — looking unset
      // while still filtering.
      const { c } = setup({ listDuplicates: () => of({ duplicates: [rec({ type: 'entity' })] }) });
      c.typeFilter.set('fact');
      expect(c.typeOptions()).toContain('fact');
    });

    it('narrows the duplicate list to the chosen type', () => {
      const { c } = setup({ listDuplicates: () => of({ duplicates: mixed }) });
      expect(c.filteredRows().length).toBe(3);
      c.typeFilter.set('fact');
      expect(c.filteredRows().map(r => r.id)).toEqual(['d2']);
    });

    it('applies to contradictions too, from the same control', () => {
      // One shared signal: "I am looking at chrono findings" should survive a tab switch rather than
      // meaning something different on each side.
      const { c } = setup({}, true, { listContradictions: () => of({ contradictions: [
        { id: 'c1', type: 'fact' }, { id: 'c2', type: 'chrono' },
      ] }) });
      c.typeFilter.set('chrono');
      expect(c.conFilteredRows().map((r: { id: string }) => r.id)).toEqual(['c2']);
    });

    it('combines with the search box rather than replacing it', () => {
      const { c } = setup({ listDuplicates: () => of({ duplicates: [
        rec({ id: 'd1', type: 'fact', aSummary: 'kafka broker' }),
        rec({ id: 'd2', type: 'fact', aSummary: 'postgres tuning' }),
        rec({ id: 'd3', type: 'entity', aSummary: 'kafka broker' }),
      ] }) });
      c.typeFilter.set('fact');
      c.query.set('kafka');
      expect(c.filteredRows().map(r => r.id)).toEqual(['d1']);
    });

    it('says the queue is not empty when only the FILTER is', () => {
      // "Nothing to review" would be a lie — there are findings, just not of this type.
      const { f, c } = setup({ listDuplicates: () => of({ duplicates: mixed }) });
      c.typeFilter.set('fact');
      c.query.set('nothing-matches-this');
      f.detectChanges();
      expect(c.filteredRows().length).toBe(0);
      expect(c.rows().length).toBeGreaterThan(0);
    });

    it('warns that filters only cover the first 500 when the server cap was hit', () => {
      // Both list endpoints cap at 500 per space with no pagination. A filter over a truncated set would
      // imply completeness it cannot have.
      const many = Array.from({ length: 500 }, (_, i) => rec({ id: `d${i}`, type: i % 2 ? 'fact' : 'entity' }));
      const { c } = setup({ listDuplicates: () => of({ duplicates: many }) });
      expect(c.listCapped()).toBe(true);
    });

    it('does not warn when the list is comfortably under the cap', () => {
      const { c } = setup({ listDuplicates: () => of({ duplicates: mixed }) });
      expect(c.listCapped()).toBe(false);
    });
  });

  describe('sub-tabs', () => {
    it('offers Duplicates, Contradictions and Suggestions as real tabs, Duplicates first', () => {
      const { f } = setup();
      const tabs = [...(f.nativeElement as HTMLElement).querySelectorAll('nav.tabs button[role="tab"]')];
      expect(tabs.length).toBe(3);
      expect(tabs[0].getAttribute('aria-selected')).toBe('true');   // lands on Duplicates
      expect(tabs[1].getAttribute('aria-selected')).toBe('false');
      expect(tabs[2].getAttribute('aria-selected')).toBe('false');
    });

    it('switches panels, and the duplicates list is not rendered while Contradictions is shown', () => {
      const { f, c } = setup({ listDuplicates: () => of({ duplicates: [rec()] }) });
      const el = f.nativeElement as HTMLElement;
      expect(el.querySelector('#review-panel-duplicates')).toBeTruthy();

      c.sub.set('contradictions');
      f.detectChanges();
      expect(el.querySelector('#review-panel-contradictions')).toBeTruthy();
      expect(el.querySelector('#review-panel-duplicates')).toBeNull();

      // …and back, so the move can't strand a reviewer on the empty half.
      c.sub.set('duplicates');
      f.detectChanges();
      expect(el.querySelector('#review-panel-duplicates')).toBeTruthy();
    });

    it('each tab is wired to its panel for screen readers', () => {
      const { f } = setup();
      const tabs = [...(f.nativeElement as HTMLElement).querySelectorAll('nav.tabs button[role="tab"]')];
      expect(tabs[0].getAttribute('aria-controls')).toBe('review-panel-duplicates');
      expect(tabs[1].getAttribute('aria-controls')).toBe('review-panel-contradictions');
      expect(tabs[2].getAttribute('aria-controls')).toBe('review-panel-suggestions');
    });
  });

  describe('suggestions (space completeness)', () => {
    const check = (over: Record<string, unknown> = {}) => ({
      id: 'entity-without-edges', severity: 'info', scope: 'entity',
      affected: 6, total: 12, weight: 2, earned: 1, sample: ['e1'], targetTab: 'entities', ...over,
    });
    const report = (checks: unknown[], over: Record<string, unknown> = {}) =>
      ({ spaceId: 'work', score: 62, checks, truncated: false, ...over });

    function suggestions(checks: unknown[], over: Record<string, unknown> = {}, brain: Record<string, unknown> = {}) {
      const s = setup({}, true, {}, { getCompleteness: () => of(report(checks, over)), getEntitiesByIds: () => of({ entities: [] }), ...brain });
      s.c.sub.set('suggestions');
      s.f.detectChanges();
      return s;
    }

    it('lists failing checks heaviest-loss first, with the sample and a why', () => {
      const { f } = suggestions([
        check(),                                                                       // 1 point lost
        check({ id: 'file-not-recallable', scope: 'file', severity: 'warn', affected: 3, total: 3, weight: 3, earned: 0, sample: ['a.pdf'], targetTab: 'files' }),
      ]);
      const cards = [...(f.nativeElement as HTMLElement).querySelectorAll('#review-panel-suggestions .dup-card')];
      expect(cards.length).toBe(2);
      // Ranked by points LOST, not by records affected: 3 unreachable files outrank 6 unlinked entities.
      expect(cards[0].textContent).toContain('file-not-recallable');
      expect(cards[1].textContent).toContain('entity-without-edges');
      expect(cards[0].textContent).toContain('a.pdf');
      expect(cards[0].textContent).toContain('review.suggestions.why.file-not-recallable');
    });

    it('a passing check is not a suggestion — it moves to the collapsed list', () => {
      const { f } = suggestions([check({ affected: 0, earned: 2 })]);
      const el = f.nativeElement as HTMLElement;
      expect(el.querySelectorAll('#review-panel-suggestions .dup-card').length).toBe(0);
      expect(el.querySelector('.sug-passing')).toBeTruthy();
      // …and the empty state says "nothing to suggest", not "nothing was checked".
      expect(el.textContent).toContain('review.suggestions.clean.title');
    });

    it('no applicable check at all reads as unmeasurable, not as a perfect space', () => {
      const { f } = suggestions([], { score: null });
      const el = f.nativeElement as HTMLElement;
      expect(el.textContent).toContain('review.suggestions.none.title');
      expect(el.textContent).not.toContain('review.suggestions.clean.title');
    });

    it('a failed load is not rendered as a clean space', () => {
      const s = setup({}, true, {}, { getCompleteness: () => throwError(() => new Error('boom')) });
      s.c.sub.set('suggestions');
      s.f.detectChanges();
      const el = s.f.nativeElement as HTMLElement;
      expect(s.c.compError()).toBe(true);
      expect(el.textContent).toContain('review.suggestions.loadError');
      expect(el.textContent).not.toContain('review.suggestions.clean.title');
    });

    it('resolves entity-id samples to names, and falls back to the id when the lookup fails', () => {
      const withNames = suggestions([check({ sample: ['e1'] })], {}, {
        getEntitiesByIds: () => of({ entities: [{ _id: 'e1', name: 'Vault Service' }] }),
      });
      expect((withNames.f.nativeElement as HTMLElement).querySelector('.sug-samples')?.textContent).toContain('Vault Service');

      // A raw UUID is still an identifier — degraded, not broken.
      const noNames = suggestions([check({ sample: ['e1'] })], {}, { getEntitiesByIds: () => throwError(() => new Error('nope')) });
      expect((noNames.f.nativeElement as HTMLElement).querySelector('.sug-samples')?.textContent).toContain('e1');
    });

    it('says the sample left some out rather than letting five entries read as the whole finding', () => {
      // (The test transloco emits raw keys, so the presence of the note is what is assertable here —
      // the count itself is an interpolation param.)
      const capped = suggestions([check({ affected: 40, total: 60, sample: ['a', 'b', 'c', 'd', 'e'] })]);
      expect((capped.f.nativeElement as HTMLElement).querySelector('.sug-more')).toBeTruthy();

      // A sample that IS the whole finding must not claim there is more.
      const complete = suggestions([check({ affected: 2, total: 60, sample: ['a', 'b'] })]);
      expect((complete.f.nativeElement as HTMLElement).querySelector('.sug-more')).toBeNull();
    });

    it('a check pointing at a collection offers the jump; a space-scoped one has nowhere to go', () => {
      const withTab = suggestions([check()]);
      const spy = vi.fn(); withTab.c.openTab.subscribe(spy);
      (withTab.f.nativeElement as HTMLElement).querySelector<HTMLButtonElement>('.sug-go')!.click();
      expect(spy).toHaveBeenCalledWith('entities');

      const spaceScoped = suggestions([check({ id: 'meta-purpose-missing', scope: 'space', affected: 1, total: 1, weight: 1, earned: 0, sample: [], targetTab: null })]);
      expect((spaceScoped.f.nativeElement as HTMLElement).querySelector('.sug-go')).toBeNull();
    });

    it('hides the record-type filter: suggestions are findings about the schema, not about records', () => {
      const { f, c } = setup({ listDuplicates: () => of({ duplicates: [rec(), rec({ id: 'd2', type: 'fact' })] }) });
      f.detectChanges();
      expect(c.showTypeFilter()).toBe(true);       // two types on the duplicates side
      c.sub.set('suggestions');
      f.detectChanges();
      expect(c.showTypeFilter()).toBe(false);
      expect((f.nativeElement as HTMLElement).querySelector('.type-filter')).toBeNull();
    });
  });

  // The card must keep the two bases distinct. A deterministic field conflict and a model's opinion are
  // different kinds of claim — flattening both into one percentage would tell a reviewer that "these
  // disagree on `port`" and "a model thinks these disagree" are the same statement. They are not.
  describe('contradictions sub-view', () => {
    const con = (over: Record<string, unknown> = {}) => ({
      id: 'a:b', spaceId: 'work', type: 'fact',
      aId: 'a', aSummary: 'runs on 8080', bId: 'b', bSummary: 'does not run on 8080',
      basis: 'structured-field', confidence: 1,
      fields: [{ key: 'port', aValue: 8080, bValue: 9090 }],
      status: 'open', detectedAt: '2026-07-27T00:00:00Z', updatedAt: '2026-07-27T00:00:00Z',
      ...over,
    });

    it('names the disagreeing field for a structured verdict, with BOTH values', () => {
      const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [con()] }) });
      c.sub.set('contradictions');
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      const field = el.querySelector('.con-fields li');
      expect(field).toBeTruthy();
      expect(field!.textContent).toContain('port');
      expect(field!.textContent).toContain('8080');
      expect(field!.textContent).toContain('9090');
      // A deterministic conflict must NOT be dressed up as a confidence percentage.
      expect(el.querySelector('#review-panel-contradictions .conf-pct')).toBeNull();
    });

    it('shows the model confidence for an NLI verdict, and no field list', () => {
      const nli = con({ basis: 'nli', confidence: 0.91, fields: undefined });
      const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [nli] }) });
      c.sub.set('contradictions');
      f.detectChanges();
      const el = f.nativeElement as HTMLElement;
      // The message goes on `expect`, not on `toBeNull` — which takes no arguments, so as written it was
      // discarded and a failure here would have reported nothing but "expected null".
      expect(el.querySelector('.con-fields'), 'a model verdict has no field to name').toBeNull();
      expect(el.querySelector('#review-panel-contradictions .conf-pct')?.textContent).toContain('91');
    });

    it('a load failure surfaces an error instead of rendering "nothing to review"', () => {
      const { f, c, toastErrors } = setup({}, true, { listContradictions: () => throwError(() => ({})) });
      c.sub.set('contradictions');
      f.detectChanges();
      expect(toastErrors.length).toBeGreaterThan(0);
    });

    /**
     * C-L5-4. The sub-tab shipped without the toolbar its sibling has, and with the list status wired
     * shut. Each case below is one of the six ways that was visible to a reviewer.
     */
    describe('the review controls Duplicates always had', () => {
      it('asks the server for the status the operator picked, not always "open"', () => {
        // THE severe one. It was hardcoded, so Dismiss and both Resolve buttons wrote records into a pile
        // with no way back — and the API had supported all four values the whole time.
        const asked: string[] = [];
        const { f, c } = setup({}, true, {
          listContradictions: (status: string) => { asked.push(status); return of({ contradictions: [], nliConfigured: true }); },
        });
        c.sub.set('contradictions');
        c.conStatusFilter = 'dismissed';
        c.loadContradictions();
        f.detectChanges();
        expect(asked[0]).toBe('open');          // the default is unchanged
        expect(asked).toContain('dismissed');   // and it is no longer the only thing askable
      });

      it('offers every pile the API serves, so nothing written is unreachable', () => {
        const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [], nliConfigured: true }) });
        c.sub.set('contradictions');
        f.detectChanges();
        const el = f.nativeElement as HTMLElement;
        const opts = [...el.querySelectorAll('#review-panel-contradictions select option')]
          .map(o => (o as HTMLOptionElement).value);
        for (const v of ['open', 'dismissed', 'resolved', 'all']) {
          expect(opts).toContain(v);
        }
      });

      it('runs the scan, which had an API method and no caller at all', () => {
        let scanned = 0;
        const { f, c } = setup({}, true, {
          listContradictions: () => of({ contradictions: [], nliConfigured: true }),
          scanContradictions: () => { scanned++; return of({ scannedSpaces: 1, scanned: 3, found: 0, nliStalled: false }); },
        });
        c.sub.set('contradictions');
        f.detectChanges();
        c.scanContradictions();
        expect(scanned).toBe(1);
      });

      it('says so when the scan finished but the judge was unreachable', () => {
        // "0 found" and "nothing was judged" are opposite answers; silence would render them the same.
        const { f, c, toastErrors } = setup({}, true, {
          listContradictions: () => of({ contradictions: [], nliConfigured: true }),
          scanContradictions: () => of({ scannedSpaces: 1, scanned: 3, found: 0, nliStalled: true }),
        });
        c.sub.set('contradictions');
        f.detectChanges();
        c.scanContradictions();
        expect(toastErrors.length).toBeGreaterThan(0);
      });

      it('searches the disagreeing field values, not only the two summaries', () => {
        // What a reviewer actually remembers about a structured finding is "the one about port", and that
        // word appears in neither summary.
        const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [con()], nliConfigured: true }) });
        c.sub.set('contradictions');
        f.detectChanges();
        c.query.set('port');
        expect(c.conFilteredRows().length).toBe(1);
        c.query.set('nothing-matches-this');
        expect(c.conFilteredRows().length).toBe(0);
      });
    });

    describe('the empty state says which empty it is', () => {
      const emptyText = (f: { nativeElement: unknown }) =>
        ((f.nativeElement as HTMLElement).querySelector('#review-panel-contradictions .empty-state')?.textContent ?? '');

      it('a configured judge and nothing found reads as clean, not as broken', () => {
        // The defect: this said "Contradiction detection is not running yet — it needs an NLI model" for
        // ANY empty list, so a working, clean space was told it was broken.
        const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [], nliConfigured: true }) });
        c.sub.set('contradictions');
        f.detectChanges();
        // The harness renders KEYS rather than copy, which makes this sharper than a wording check: it
        // pins exactly which branch rendered. `pendingTitle` is the old unconditional claim.
        expect(emptyText(f)).toContain('review.contradictions.cleanTitle');
        expect(emptyText(f)).not.toContain('pendingTitle');
      });

      it('no judge configured says what still ran, rather than that nothing did', () => {
        // The structured pass runs with no model at all — scanSpace uses ['structured'] when none is set.
        const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [], nliConfigured: false }) });
        c.sub.set('contradictions');
        f.detectChanges();
        expect(emptyText(f)).toContain('review.contradictions.structuredOnlyTitle');
      });

      it('claims BOTH passes ran only when the server actually said so', () => {
        // A server that does not report the field leaves this unknown, and unknown must not become the
        // strongest claim available — that substitution is the whole bug, one level down.
        const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [] }) });
        c.sub.set('contradictions');
        f.detectChanges();
        expect(c.conNliConfigured()).toBeNull();
        expect(emptyText(f)).toContain('review.contradictions.cleanTitle');
        expect(emptyText(f)).not.toContain('review.contradictions.judgeRan');
      });

      it('an empty dismissed pile is not a statement about the space', () => {
        const { f, c } = setup({}, true, { listContradictions: () => of({ contradictions: [], nliConfigured: true }) });
        c.sub.set('contradictions');
        c.conStatusFilter = 'dismissed';
        c.loadContradictions();
        f.detectChanges();
        expect(emptyText(f)).toContain('review.contradictions.noneWithStatus');
      });
    });
  });

  // ── Keep A / Keep B ──────────────────────────────────────────────────────────────────────────────────
  //
  // The reviewer's actual decision about two disagreeing records is "this one is right, that one is stale".
  // Neither existing resolution said it, so those decisions were being recorded as something they were not.
  describe('picking a winner', () => {
    const con = (over: Record<string, unknown> = {}) => ({
      id: 'c1', spaceId: 'work', type: 'entity', aId: 'a', aSummary: 'A says 8080',
      bId: 'b', bSummary: 'B says 9090', basis: 'structured-field', confidence: 1,
      status: 'open', detectedAt: '2026-01-01', updatedAt: '2026-01-01', ...over,
    });

    it('sends the winner the reviewer clicked, never a default', async () => {
      const calls: Array<[string, string]> = [];
      const { c } = setup({}, true, {
        listContradictions: () => of({ contradictions: [con()], nliConfigured: true }),
        keepSide: (id: string, winner: string) => { calls.push([id, winner]); return of({ status: 'resolved', resolution: 'superseded' }); },
      });
      c.sub.set('contradictions');
      c.loadContradictions();
      c.keepSide(c.conRows()[0], 'b');
      expect(calls).toEqual([['c1', 'b']]);
    });

    it('says so when the decision was recorded but NO edge was drawn', () => {
      // Edges connect entities, so a memory pair gets the judgement and no link. A reviewer who believes
      // the graph changed when it did not will never go and fix it.
      const { c, toastInfos } = setup({}, true, {
        listContradictions: () => of({ contradictions: [con({ type: 'fact' })], nliConfigured: true }),
        keepSide: () => of({ status: 'resolved', resolution: 'superseded', note: 'no edge drawn: ...' }),
      });
      c.sub.set('contradictions');
      c.loadContradictions();
      c.keepSide(c.conRows()[0], 'a');
      expect(toastInfos.join(' ')).toContain('review.contradictions.noEdge');
    });

    it('stays quiet when an edge WAS drawn', () => {
      const { c, toastInfos } = setup({}, true, {
        listContradictions: () => of({ contradictions: [con()], nliConfigured: true }),
        keepSide: () => of({ status: 'resolved', resolution: 'superseded', edge: { id: 'e', from: 'a', to: 'b', label: 'supersedes' } }),
      });
      c.sub.set('contradictions');
      c.loadContradictions();
      c.keepSide(c.conRows()[0], 'a');
      expect(toastInfos).toEqual([]);
    });

    it('a failure surfaces an error and does not clear the busy row silently', () => {
      const { c, toastErrors } = setup({}, true, {
        listContradictions: () => of({ contradictions: [con()], nliConfigured: true }),
        keepSide: () => throwError(() => new Error('nope')),
      });
      c.sub.set('contradictions');
      c.loadContradictions();
      c.keepSide(c.conRows()[0], 'a');
      expect(toastErrors.length).toBe(1);
      expect(c.conBusy()).toBeNull();
    });

    it('expands both records IN FULL on demand, and collapses again', () => {
      const { c } = setup({}, true, {
        listContradictions: () => of({ contradictions: [con()], nliConfigured: true }),
      });
      c.sub.set('contradictions');
      c.loadContradictions();
      expect(c.expanded()).toBeNull();
      c.toggleFull(c.conRows()[0]);
      expect(c.expanded()).toBe('c1');
      expect(c.fullA()).toContain('full record');
      expect(c.fullB()).toContain('full record');
      c.toggleFull(c.conRows()[0]);
      expect(c.expanded()).toBeNull();
    });

    it('names a record it could not load rather than showing an empty panel', () => {
      // The one case where deciding from the summary alone is exactly wrong.
      const { c } = setup({}, true, {
        listContradictions: () => of({ contradictions: [con()], nliConfigured: true }),
      }, { getRecord: () => throwError(() => new Error('gone')) });
      c.sub.set('contradictions');
      c.loadContradictions();
      c.toggleFull(c.conRows()[0]);
      expect(c.fullA()).toBeNull();
      expect(c.fullError()).toContain('review.contradictions.fullError');
    });
  });

});