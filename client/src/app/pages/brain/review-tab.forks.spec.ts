/**
 * The Forks section of the Review tab, layout 3 "Inline difference" (bundle-81, design rev 8 §5, decisions 19, 41 and 43; mockup
 * `b81-mock-forks/layout-3.html`, chosen by the owner 2026-10-24: "3 Inline difference").
 *
 * ## What the plan and the mockup bind
 *
 * - **Marked words:** the fact text of a fork is ONE paragraph with the differing words marked in place, `<ins>` for words only in
 *   this version and `<del>` for words only in the other. The marks are not colour alone: each carries a screen-reader prefix
 *   ("Only in this version" / "Only in the other version", the legend's words), and a legend explains them.
 * - **Show both versions in full:** a `<details>` disclosure holds both texts whole, labelled by `brain.review.forks.showBoth`.
 * - **Two keep actions** per fork, "Keep this version" and "Keep the other version", each opening a confirmation that names what is
 *   deleted, and nothing is resolved before the confirmation is confirmed.
 * - **Counted copy:** "1 edge points at this fork" (the mockup said "1 edge point"): the pointed-at sentence goes through the plural
 *   mechanism, `brain.review.forks.edges.one` / `.other`.
 * - **A visible focus ring** drawn by the component (decision 41).
 *
 * ## The API this spec assumes, because the component is not written yet
 *
 * `client/src/app/pages/brain/review-forks.component.ts` exports `ReviewForksComponent` (standalone), taking `rows`:
 * `{ kind, forkId, parentId, fork, parent, orphaned, edgeCount, linkCount, siblings, resolvedElsewhere }[]` and the list answer's
 * `kinds` (the fields a kind compares, and its main field), and emitting `resolve` with `{ forkId, kind, keep: 'fork' | 'parent' }` once a
 * confirmation is confirmed (Q-624: the kind rides along, and `review-forks-kinds.spec.ts` holds the kind switch). The Review tab hosts it
 * in a "Forks" section. If the build names these differently, the import and `make()` are the lines to change; the rules stay.
 *
 * ## Seen red
 *
 * Red on 9a7ab3f7: the component does not exist and the client has no fork code, so the spec fails to import it.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { ReviewForksComponent } from './review-forks.component';

const author = (label: string) => ({ instanceId: label.toLowerCase(), instanceLabel: label });
const row = (over: Record<string, unknown> = {}) => ({
  forkId: 'fork-1111-2222', parentId: 'parent-aaaa-bbbb',
  fork: { _id: 'fork-1111-2222', type: 'note', fact: 'Embeddings are rebuilt after a model change, which takes about 20 minutes per 10 000 records.', tags: ['ops'], author: author('Berlin'), updatedAt: '2026-10-20T10:00:00.000Z' },
  parent: { _id: 'parent-aaaa-bbbb', type: 'note', fact: 'Embeddings are rebuilt after a model change, which takes about 12 minutes per 10 000 records.', tags: ['ops'], author: author('Gdansk'), updatedAt: '2026-10-21T10:00:00.000Z' },
  kind: 'fact' as const, orphaned: false, edgeCount: 1, linkCount: 0, siblings: 1, resolvedElsewhere: [],
  ...over,
});

/** The list answer's `kinds` (Q-624): the fields a fact compares and its main field. The component holds no field list of its own. */
const KINDS = {
  fact: { fields: ['fact', 'type', 'description', 'tags', 'linkEntities'], mainField: 'fact' },
  entity: { fields: ['name', 'type', 'description', 'tags'], mainField: 'name' },
  chrono: { fields: ['title', 'type', 'start', 'end', 'description', 'tags'], mainField: 'title' },
  edge: { fields: ['description', 'weight'], mainField: 'description' },
};

function make(rows = [row()]) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ReviewForksComponent, getTranslocoModule({ translation: { en: dictionaryTree() } })] });
  const fixture = TestBed.createComponent(ReviewForksComponent);
  fixture.componentRef.setInput('rows', rows);
  fixture.componentRef.setInput('kinds', KINDS);
  fixture.detectChanges();
  return fixture;
}
/** The real English words under `brain.review.forks.*`, as a tree, so the spec reads the sentences a person would. */
function dictionaryTree() {
  const flat = dictionary('en');
  const tree: Record<string, any> = {};
  for (const [key, value] of Object.entries(flat)) {
    if (!key.startsWith('brain.review.forks.')) continue;
    let node = tree;
    const parts = key.split('.');
    parts.slice(0, -1).forEach(p => { node = node[p] ??= {}; });
    node[parts.at(-1)!] = value;
  }
  return tree;
}
const el = (f: ReturnType<typeof make>) => f.nativeElement as HTMLElement;

describe('ReviewForksComponent (layout 3, inline difference)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('writes the fact text once, with the differing words marked in place: <ins> for this version, <del> for the other', () => {
    const f = make();
    const text = el(f).querySelector('.l3-text, [data-forks-text]') as HTMLElement;
    expect(text).toBeTruthy();
    expect(text.querySelectorAll('ins').length).toBeGreaterThan(0);
    expect(text.querySelectorAll('del').length).toBeGreaterThan(0);
    expect(text.querySelector('ins')!.textContent).toContain('20');
    expect(text.querySelector('del')!.textContent).toContain('12');
    expect(text.textContent).toContain('Embeddings are rebuilt');
  });

  it('every mark carries a screen-reader prefix, so the difference is not colour alone', () => {
    const f = make();
    const marks = [...el(f).querySelectorAll('.l3-text ins, .l3-text del, [data-forks-text] ins, [data-forks-text] del')];
    expect(marks.length).toBeGreaterThan(0);
    for (const m of marks) {
      const prefix = m.querySelector('.sr-only, .visually-hidden');
      expect(prefix, `a ${m.tagName} mark has no screen-reader prefix`).toBeTruthy();
      expect(prefix!.textContent).toMatch(m.tagName === 'INS' ? /Only in this version/i : /Only in the other version/i);
    }
  });

  it('has a legend that explains both marks', () => {
    const legend = el(make()).querySelector('[role="note"]') as HTMLElement;
    expect(legend?.querySelector('ins')).toBeTruthy();
    expect(legend?.querySelector('del')).toBeTruthy();
  });

  it('holds both versions in full behind a "Show both versions in full" disclosure', () => {
    const f = make();
    const details = el(f).querySelector('details') as HTMLDetailsElement;
    expect(details).toBeTruthy();
    expect(details.querySelector('summary')!.textContent).toMatch(/show both versions in full/i);
    expect(details.textContent).toContain('about 20 minutes');
    expect(details.textContent).toContain('about 12 minutes');
  });

  it('offers exactly two keep actions per fork, and resolves nothing until a confirmation is confirmed', () => {
    const f = make();
    const resolved = vi.fn();
    f.componentInstance.resolve.subscribe(resolved);
    const keeps = [...el(f).querySelectorAll('button')].filter(b => /keep (this|the other) version/i.test(b.textContent ?? ''));
    expect(keeps.length).toBe(2);
    keeps.find(b => /keep this version/i.test(b.textContent!))!.click();
    f.detectChanges();
    expect(resolved).not.toHaveBeenCalled();
    const dialog = el(f).querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement;
    expect(dialog, 'no confirmation names what is deleted').toBeTruthy();
    const confirm = [...dialog.querySelectorAll('button')].find(b => /keep|confirm/i.test(b.textContent ?? ''))!;
    confirm.click();
    expect(resolved).toHaveBeenCalledWith({ forkId: 'fork-1111-2222', kind: 'fact', keep: 'fork' });
  });

  it('the other action keeps the parent', () => {
    const f = make();
    const resolved = vi.fn();
    f.componentInstance.resolve.subscribe(resolved);
    [...el(f).querySelectorAll('button')].find(b => /keep the other version/i.test(b.textContent ?? ''))!.click();
    f.detectChanges();
    const dialog = el(f).querySelector('[role="alertdialog"], [role="dialog"]') as HTMLElement;
    [...dialog.querySelectorAll('button')].find(b => /keep|confirm/i.test(b.textContent ?? ''))!.click();
    expect(resolved).toHaveBeenCalledWith({ forkId: 'fork-1111-2222', kind: 'fact', keep: 'parent' });
  });

  it('says "1 edge points at this fork", not "1 edge point" (the copy fix of decision 43)', () => {
    const words = dictionary('en');
    expect(words['brain.review.forks.edges.one']).toMatch(/\bpoints\b/);
    expect(words['brain.review.forks.edges.other']).toMatch(/\bpoint\b/);
    const text = el(make([row({ edgeCount: 1, linkCount: 0 })])).textContent ?? '';
    expect(text).toMatch(/1 edge points at this fork/);
    expect(text).not.toMatch(/1 edge point\b(?!s)/);
  });

  it('draws its own visible focus ring on the keep actions (decision 41)', () => {
    const source = readFileSync(resolve(__dirname, 'review-forks.component.ts'), 'utf8');
    expect(source).toMatch(/:focus-visible/);
  });
});
