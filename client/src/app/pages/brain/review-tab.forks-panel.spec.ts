/**
 * The Forks tab of Review, hosted (bundle-81, design rev 8 section 5): the list loads with the tab, a confirmed keep resolves through the API and
 * reads the page again, a refused resolve stays on screen until dismissed, a failed load is not "no forks", and a personal view never asks.
 *
 * The component that draws a fork is `review-tab.forks.spec.ts`; this is what the tab does around it.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { ReviewTabComponent } from './review-tab.component';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { ForksApi } from '../../core/forks-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { ForkRow } from '../../core/forks.types';

/** The real English words under brain.review.forks.*, as a tree, so the buttons read as a person reads them. */
function forksWords(): Record<string, any> {
  const tree: Record<string, any> = {};
  for (const [key, value] of Object.entries(dictionary('en'))) {
    if (!key.startsWith('brain.review.forks.')) continue;
    let node = tree;
    const parts = key.split('.');
    parts.slice(0, -1).forEach(p => { node = node[p] ??= {}; });
    node[parts.at(-1)!] = value;
  }
  return tree;
}

const row = (id: string): ForkRow => ({
  forkId: `fork-${id}`, parentId: `parent-${id}`,
  fork: { _id: `fork-${id}`, fact: 'theirs', type: 'note' }, parent: { _id: `parent-${id}`, fact: 'mine', type: 'note' },
  edgeCount: 0, linkCount: 0, siblings: 1,
});

function setup(forksApi: Record<string, unknown>, isView = false) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ReviewTabComponent, getTranslocoModule({ translation: { en: forksWords() } })],
    providers: [
      { provide: SpacesApi, useValue: { getCompleteness: () => of({ spaceId: 'work', score: null, checks: [], truncated: false }) } },
      { provide: BrainApi, useValue: { getEntitiesByIds: () => of({ entities: [] }), getRecord: () => of({}) } },
      { provide: DuplicatesApi, useValue: { listDuplicates: () => of({ duplicates: [] }) } },
      { provide: ContradictionsApi, useValue: { listContradictions: () => of({ contradictions: [] }) } },
      { provide: ForksApi, useValue: forksApi },
      { provide: ToastService, useValue: { error: () => {}, success: () => {}, info: () => {}, show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const f = TestBed.createComponent(ReviewTabComponent);
  f.componentRef.setInput('spaceId', 'work');
  f.componentRef.setInput('isView', isView);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  const openForks = () => { (el.querySelector('#review-tab-forks') as HTMLButtonElement).click(); f.detectChanges(); };
  const click = (re: RegExp) => { [...el.querySelectorAll('button')].find(b => re.test(b.textContent ?? ''))!.click(); f.detectChanges(); };
  return { f, el, openForks, click };
}

describe('the Forks tab of Review', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('lists the forks of the space it reviews, and says how many on the tab', () => {
    const listForks = vi.fn(() => of({ forks: [row('1'), row('2')], total: 2, skip: 0, limit: 25 }));
    const { el, openForks } = setup({ listForks });
    expect(listForks).toHaveBeenCalledWith('work', 0, 25);
    expect(el.querySelector('#review-tab-forks')!.textContent).toContain('2');
    openForks();
    expect(el.querySelectorAll('app-review-forks li').length).toBe(2);
  });

  it('shows the empty state only for a list that answered empty, and an error state for one that failed', () => {
    const empty = setup({ listForks: () => of({ forks: [], total: 0, skip: 0, limit: 25 }) });
    empty.openForks();
    expect(empty.el.textContent).toContain('No forks to review');
    const failed = setup({ listForks: () => throwError(() => ({ status: 500, statusText: 'Server Error' })) });
    failed.openForks();
    expect(failed.el.textContent).toContain('The forks could not be loaded');
    expect(failed.el.textContent).not.toContain('No forks to review');
  });

  it('a confirmed keep resolves that fork with that side and reads the list again', () => {
    const listForks = vi.fn(() => of({ forks: [row('1')], total: 1, skip: 0, limit: 25 }));
    const resolveFork = vi.fn(() => of({}));
    const { openForks, click } = setup({ listForks, resolveFork });
    openForks();
    click(/keep the other version/i);
    expect(resolveFork).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]')!;
    [...dialog.querySelectorAll('button')].find(b => /keep the other/i.test(b.textContent ?? ''))!.click();
    expect(resolveFork).toHaveBeenCalledWith('work', 'fork-1', 'parent');
    expect(listForks).toHaveBeenCalledTimes(2);
  });

  it('a resolve for a fork that is already gone says so and stays until dismissed', () => {
    const resolveFork = () => throwError(() => ({ status: 404, statusText: 'Not Found' }));
    const { el, openForks, click, f } = setup({ listForks: () => of({ forks: [row('1')], total: 1, skip: 0, limit: 25 }), resolveFork });
    openForks();
    click(/keep this version/i);
    [...document.querySelectorAll('[role="dialog"] button')].find(b => /keep this/i.test(b.textContent ?? ''))!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    f.detectChanges();
    const alert = el.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('already gone');
    (alert!.querySelector('.refusal-close') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('[role="alert"]')).toBeNull();
  });

  it('a personal view never asks for forks (it resolves none)', () => {
    const listForks = vi.fn(() => of({ forks: [], skip: 0, limit: 25 }));
    setup({ listForks }, true);
    expect(listForks).not.toHaveBeenCalled();
  });
});
