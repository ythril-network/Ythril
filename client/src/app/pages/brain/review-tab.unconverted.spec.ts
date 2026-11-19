/**
 * The Unconverted section of Review, hosted (bundle-285, Q-939, plan rows V1 and section 13 S7): a fifth sub-tab after Forks with the count of
 * the open items, loaded with the tab for the space it reviews, opened by a link, and never asked for on a personal view.
 *
 * The cards and the controls are `review-unconverted-panel.component.spec.ts`, the state is `review-unconverted-state.spec.ts`; this is what the tab
 * does around them.
 *
 * ## Seen red
 *
 * Red on the unchanged base (bundle-285 with S1 to S3): the tab has four sub-tabs and asks for no unconverted list; the first failing line is the
 * order of the sub-tabs, which ends at Forks.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { ActivatedRoute, convertToParamMap } from '@angular/router';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { listAnswer, okResult, openGroup, unconvertedProviders, unconvertedRow, unconvertedWords, type ConversionApiStub } from '../../testing/review-unconverted-fixtures';
import { ReviewTabComponent } from './review-tab.component';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { ForksApi } from '../../core/forks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

/** Four records that do not fit, of one type; the space holds 1,046 in all. */
const BUSY = [openGroup('person', 'not_conforming', 1046)];
const busy = () => vi.fn(() => of(okResult(listAnswer([unconvertedRow(1), unconvertedRow(2)], BUSY, { total: 1046 }))));

function setup(over: Partial<ConversionApiStub> = {}, isView = false, query: Record<string, string> = {}) {
  const h = unconvertedProviders(over);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ReviewTabComponent, getTranslocoModule({ translation: { en: unconvertedWords() } })],
    providers: [
      ...h.providers,
      { provide: SpacesApi, useValue: { getCompleteness: () => of({ spaceId: 'work', score: null, checks: [], truncated: false }) } },
      { provide: BrainApi, useValue: { getEntitiesByIds: () => of({ entities: [] }), getRecord: h.getRecord } },
      { provide: DuplicatesApi, useValue: { listDuplicates: () => of({ duplicates: [] }) } },
      { provide: ContradictionsApi, useValue: { listContradictions: () => of({ contradictions: [] }) } },
      { provide: ForksApi, useValue: { listForks: () => of({ forks: [], skip: 0, limit: 25 }) } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: convertToParamMap(query) } } },
      { provide: ToastService, useValue: { error: () => {}, success: () => {}, info: () => {}, show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const f = TestBed.createComponent(ReviewTabComponent);
  f.componentRef.setInput('spaceId', 'work');
  f.componentRef.setInput('isView', isView);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  return { f, el, h, tab: () => el.querySelector<HTMLButtonElement>('#review-tab-unconverted') };
}

describe('the Unconverted sub-tab of Review', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is the fifth sub-tab, after Forks', () => {
    const { el } = setup();
    const ids = [...el.querySelectorAll('nav[role="tablist"] [role="tab"]')].map(t => t.id);
    expect(ids).toEqual(['review-tab-duplicates', 'review-tab-contradictions', 'review-tab-suggestions', 'review-tab-forks', 'review-tab-unconverted']);
  });

  it('is named by its own words and carries the count of every open item of the space, not of the page', () => {
    const { tab } = setup({ listUnconverted: busy() });
    expect(tab()!.textContent).toContain('Unconverted');
    // two rows are on the page; the space holds 1,046
    expect(tab()!.querySelector('.badge')?.textContent?.trim()).toBe('1,046');
  });

  it('has no count when nothing is open, so a clean space does not look busy', () => {
    const { tab } = setup();
    expect(tab()!.querySelector('.badge')).toBeNull();
  });

  it('loads with the tab, for the space it reviews, and opens the panel when chosen', () => {
    const { h, tab, f, el } = setup({ listUnconverted: busy() });
    // the first read names no type: with one type open, the section opens on it without reading again
    expect(h.api.listUnconverted).toHaveBeenCalledTimes(1);
    expect(h.api.listUnconverted).toHaveBeenCalledWith('work', { status: 'open', skip: 0, limit: 25 });
    expect(el.querySelector('app-review-unconverted-panel')).toBeNull();
    tab()!.click();
    f.detectChanges();
    expect(el.querySelector('#review-panel-unconverted')).not.toBeNull();
    expect(el.querySelectorAll('[data-testid="unconverted-card"]').length).toBe(2);
    expect(tab()!.getAttribute('aria-selected')).toBe('true');
  });

  it('switching space re-points it: the new space is read, and the old one\'s records are not left on screen', () => {
    const { h, f } = setup({ listUnconverted: busy() });
    f.componentRef.setInput('spaceId', 'support');
    f.detectChanges();
    expect(h.api.listUnconverted).toHaveBeenLastCalledWith('support', expect.anything());
  });

  it('a personal view never asks for unconverted records (it converts none) and offers no sub-tab', () => {
    const { h, el } = setup({}, true);
    expect(h.api.listUnconverted).not.toHaveBeenCalled();
    expect(el.querySelector('#review-tab-unconverted')).toBeNull();
  });

  it('opens on this section when a link asks for it (?section=unconverted)', () => {
    const { tab } = setup({}, false, { section: 'unconverted' });
    expect(tab()!.getAttribute('aria-selected')).toBe('true');
  });

  it('shows no shared record-type filter over it: the section has its own, with the types that have open items', () => {
    const { tab, f, el } = setup({ listUnconverted: busy() });
    tab()!.click();
    f.detectChanges();
    expect(el.querySelector('.type-filter #review-type-filter')).toBeNull();
    expect(el.querySelector('select[aria-label="Record type"]')).not.toBeNull();
  });
});
