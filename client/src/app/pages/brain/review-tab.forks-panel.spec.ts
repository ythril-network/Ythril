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
    if (!key.startsWith('brain.review.forks.') && !key.startsWith('brain.tab.')) continue;
    let node = tree;
    const parts = key.split('.');
    parts.slice(0, -1).forEach(p => { node = node[p] ??= {}; });
    node[parts.at(-1)!] = value;
  }
  return tree;
}

const row = (id: string, kind: ForkRow['kind'] = 'fact'): ForkRow => ({
  kind, forkId: `fork-${id}`, parentId: `parent-${id}`,
  fork: { _id: `fork-${id}`, seq: 7, fact: 'theirs', type: 'note' }, parent: { _id: `parent-${id}`, seq: 9, fact: 'mine', type: 'note' },
  orphaned: false, edgeCount: 0, linkCount: 0, siblings: 1, resolvedElsewhere: [],
});

/** The answer's `kinds` (Q-624): what each kind compares and its main field. Only a fact is drawn from a `fact` here; the rest are named to be read. */
const KINDS = {
  fact: { fields: ['fact', 'type', 'tags'], mainField: 'fact' },
  entity: { fields: ['name', 'type', 'tags'], mainField: 'name' },
  chrono: { fields: ['title', 'type', 'tags'], mainField: 'title' },
  edge: { fields: ['description', 'weight'], mainField: 'description' },
};

/** A list answer for `rows`, with the per-kind counts and `kinds` the server adds to every answer. */
const answer = (rows: ForkRow[], counts?: Record<string, number>) => ({
  forks: rows, total: rows.length, skip: 0, limit: 25, kinds: KINDS,
  counts: counts ?? Object.fromEntries(['fact', 'entity', 'chrono', 'edge'].map(k => [k, rows.filter(r => r.kind === k).length])),
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
    const listForks = vi.fn(() => of(answer([row('1'), row('2')])));
    const { el, openForks } = setup({ listForks });
    // The first read names no kind: the answer's counts decide which kind the section opens on.
    expect(listForks).toHaveBeenCalledWith('work', 0, 25, undefined);
    expect(el.querySelector('#review-tab-forks')!.textContent).toContain('2');
    openForks();
    expect(el.querySelectorAll('app-review-forks li').length).toBe(2);
  });

  it('shows the empty state only for a list that answered empty, and an error state for one that failed', () => {
    const empty = setup({ listForks: () => of(answer([])) });
    empty.openForks();
    expect(empty.el.textContent).toContain('No forks to review');
    const failed = setup({ listForks: () => throwError(() => ({ status: 500, statusText: 'Server Error' })) });
    failed.openForks();
    expect(failed.el.textContent).toContain('The forks could not be loaded');
    expect(failed.el.textContent).not.toContain('No forks to review');
  });

  it('a confirmed keep resolves that fork with that side and reads the list again', () => {
    const listForks = vi.fn(() => of(answer([row('1')])));
    const resolveFork = vi.fn(() => of({}));
    const { openForks, click } = setup({ listForks, resolveFork });
    openForks();
    click(/keep the other version/i);
    expect(resolveFork).not.toHaveBeenCalled();
    const dialog = document.querySelector('[role="dialog"]')!;
    [...dialog.querySelectorAll('button')].find(b => /keep the other/i.test(b.textContent ?? ''))!.click();
    // The kind and both versions are the row's, as the list read them: all five parameters of the resolve.
    expect(resolveFork).toHaveBeenCalledWith('work', 'fork-1', { kind: 'fact', keep: 'parent', ifMatchSeq: 7, ifMatchParentSeq: 9 });
    expect(listForks).toHaveBeenCalledTimes(2);
  });

  it('a resolve for a fork that is already gone says so and stays until dismissed', () => {
    const resolveFork = () => throwError(() => ({ status: 404, statusText: 'Not Found' }));
    const { el, openForks, click, f } = setup({ listForks: () => of(answer([row('1')])), resolveFork });
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

  it('a resolve refused for a version that moved says nothing was changed and offers the reload', () => {
    const resolveFork = () => throwError(() => ({ status: 409, statusText: 'Conflict' }));
    const { el, openForks, click, f } = setup({ listForks: () => of(answer([row('1')])), resolveFork });
    openForks();
    click(/keep this version/i);
    [...document.querySelectorAll('[role="dialog"] button')].find(b => /keep this/i.test(b.textContent ?? ''))!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    f.detectChanges();
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Nothing was changed');
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('Reload the list');
  });

  describe('the kinds', () => {
    const all = [row('f1'), row('e1', 'entity'), row('e2', 'entity'), row('g1', 'edge')];
    const counts = { fact: 1, entity: 2, chrono: 0, edge: 1 };
    const serves = () => vi.fn((_space: string, _skip: number, _limit: number, kind?: string) => of(answer(all.filter(r => !kind || r.kind === kind), counts)));
    const radio = (el: HTMLElement, re: RegExp) => [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find(r => re.test(r.textContent ?? ''))!;

    it('opens on the first kind that has forks, and reads that kind when the first answer held rows of others', () => {
      const listForks = serves();
      const { el, openForks } = setup({ listForks });
      openForks();
      expect(listForks.mock.calls.map(c => c[3])).toEqual([undefined, 'entity']);
      expect(radio(el, /Entities/).getAttribute('aria-checked')).toBe('true');
      expect(el.querySelectorAll('app-review-forks article').length).toBe(2);
      expect(el.querySelector('#review-tab-forks')!.textContent).toContain('4');
    });

    it('choosing a kind reads that kind\'s forks, and pages by that kind\'s count', () => {
      const listForks = serves();
      const { el, f, openForks } = setup({ listForks });
      openForks();
      radio(el, /Facts/).click();
      f.detectChanges();
      expect(listForks.mock.calls.at(-1)![3]).toBe('fact');
      expect(radio(el, /Facts/).getAttribute('aria-checked')).toBe('true');
      expect(el.querySelectorAll('app-review-forks article').length).toBe(1);
    });

    it('a kind with no forks is not an empty space: the switch stays and offers the next kind', () => {
      const { el, f, openForks } = setup({ listForks: serves() });
      openForks();
      radio(el, /Chrono/).click();
      f.detectChanges();
      expect(el.textContent).toContain('Nothing to review in Chrono');
      expect(el.textContent).not.toContain('No forks to review');
      expect([...el.querySelectorAll('button')].some(b => /Show Entities \(2\)/.test(b.textContent ?? ''))).toBe(true);
    });
  });

  it('a personal view never asks for forks (it resolves none)', () => {
    const listForks = vi.fn(() => of({ forks: [], skip: 0, limit: 25 }));
    setup({ listForks }, true);
    expect(listForks).not.toHaveBeenCalled();
  });
});
