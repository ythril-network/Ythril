/**
 * SummaryStrip — an item's optional `hint` (`Q-113`).
 *
 * The Spaces summary gains a "Waiting for search" count, and a bare number under that label does not say what
 * the operator can expect. The hint is that sentence. A `title` alone reaches a mouse and nobody else, so the
 * contract is that the hint is exposed to assistive technology: as visible text or as an aria-label.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { SummaryStripComponent, type SummaryItem } from './summary-strip.component';

function render(items: SummaryItem[]): HTMLElement {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [SummaryStripComponent] });
  const fixture = TestBed.createComponent(SummaryStripComponent);
  fixture.componentRef.setInput('items', items);
  fixture.detectChanges();
  return fixture.nativeElement as HTMLElement;
}

/** Everything a screen reader could be handed for an element: its text, every aria-label beneath it, its own. */
function announcedBy(el: Element): string {
  const labels = Array.from(el.querySelectorAll('[aria-label]')).map(e => e.getAttribute('aria-label'));
  return [el.textContent ?? '', el.getAttribute('aria-label') ?? '', ...labels].join(' | ');
}

describe('SummaryStripComponent — hint', () => {
  it('exposes a hinted item\'s hint to assistive technology, as text or as an aria-label', () => {
    const el = render([{ label: 'Waiting for search', value: 2, hint: 'Semantic search returns once the search service is back.' }]);
    expect(announcedBy(el)).toContain('Semantic search returns once the search service is back.');
  });

  it('adds nothing for an item without a hint', () => {
    const el = render([{ label: 'Spaces', value: 3 }]);
    expect(el.querySelectorAll('[aria-label]').length).toBe(0);
    expect(announcedBy(el)).not.toContain('undefined');
  });

  it('a hint belongs to its own item: the un-hinted one beside it does not carry it', () => {
    const el = render([
      { label: 'Waiting for search', value: 1, hint: 'HINT-TEXT' },
      { label: 'Spaces', value: 3 },
    ]);
    const items = Array.from(el.querySelectorAll('.item'));
    expect(items.length).toBe(2);
    expect(announcedBy(items[0])).toContain('HINT-TEXT');
    expect(announcedBy(items[1])).not.toContain('HINT-TEXT');
  });
});
