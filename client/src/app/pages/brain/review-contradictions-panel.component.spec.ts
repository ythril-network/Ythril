/**
 * The Contradictions panel of Review words its own search box (Q-391 follow-up, bundle-67 review): the box reads "Search contradictions…" and is labelled so
 * for assistive technology, not "Search duplicates…", the words of the Duplicates tab it was extracted from. The words are the real English ones.
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { ReviewContradictionsPanelComponent } from './review-contradictions-panel.component';
import type { ReviewContradictionsState } from './review-contradictions-state';

/** What the panel reads of its state on an empty, loaded list: no rows, no error, nothing scanning. */
function emptyState(): ReviewContradictionsState {
  return {
    rows: signal([]), loading: signal(false), error: signal(null), busy: signal(null), scanning: signal(false), nliConfigured: signal(true),
    expanded: signal(null), fullA: signal(null), fullB: signal(null), fullError: signal(null),
    statusFilter: 'open', load: vi.fn(), scan: vi.fn(),
  } as unknown as ReviewContradictionsState;
}

describe('ReviewContradictionsPanelComponent search box', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('words the box as a search of contradictions, in its placeholder and its aria-label', () => {
    TestBed.configureTestingModule({ imports: [ReviewContradictionsPanelComponent, getTranslocoModule({ translation: { en: dictionary('en') } })] });
    const fixture = TestBed.createComponent(ReviewContradictionsPanelComponent);
    fixture.componentRef.setInput('state', emptyState());
    fixture.componentRef.setInput('rows', []);
    fixture.componentRef.setInput('spaceId', 's');
    fixture.componentRef.setInput('query', '');
    fixture.componentRef.setInput('typeFilter', 'all');
    fixture.detectChanges();
    const box = (fixture.nativeElement as HTMLElement).querySelector('input[type="search"]') as HTMLInputElement;
    expect(box).not.toBeNull();
    expect(box.placeholder).toBe(dictionary('en')['contradictions.searchPlaceholder']);
    expect(box.placeholder).not.toBe(dictionary('en')['duplicates.searchPlaceholder']);
    expect(box.getAttribute('aria-label')).toBe(box.placeholder);
  });
});
