/**
 * A personal view is named in words, and the member picker's checkboxes have accessible names (Q-531, bundle-100, plan rev 3.2
 * "Client", a11y S1-S6: "The view marker has visible text (not aria-label on a span)"; "an accessible member picker offering only
 * spaces the caller reads (labels bound, names on checkboxes)").
 *
 * ## The rules
 *
 * 1. **The feature's word in each language**: en "personal view", de "persönliche Sicht" (formal register), pl "widok osobisty" -
 *    the word the marker shows as text. It is a different thing from the UI's existing "views" (the Brain tab strip), so it may not
 *    be one of those keys reused.
 * 2. **The member picker** (`ViewCreateDialogComponent`, given the spaces the caller reads) offers one checkbox per space and no other
 *    id, and every checkbox has an accessible name that names its space: a bound `<label>`, `aria-labelledby` or `aria-label`. A
 *    row of unnamed checkboxes reads to a screen reader as "checkbox, not checked" times N.
 *
 * The visible marker on the Brain page is held in `brain.personal-views.spec.ts`.
 *
 * ## Seen red at 18e8d598
 *
 * No translation says any of the three words; `view-create-dialog.component.ts` does not exist.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { provideHttpClient } from '@angular/common/http';
import { provideHttpClientTesting } from '@angular/common/http/testing';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { PERSONAL_VIEW_WORD, importNew } from '../../testing/personal-views';

const SPACES = [{ id: 'qa', label: 'Quality' }, { id: 'ops', label: 'Operations' }];

/** The accessible name of a form control, the way a screen reader would find it (enough of the algorithm for a checkbox). */
function accessibleName(input: HTMLInputElement, root: HTMLElement): string {
  const label = input.getAttribute('aria-label')?.trim();
  if (label) return label;
  const by = input.getAttribute('aria-labelledby');
  if (by) return by.split(/\s+/).map(id => root.querySelector(`#${CSS.escape(id)}`)?.textContent?.trim() ?? '').join(' ').trim();
  if (input.id) {
    const forLabel = root.querySelector(`label[for="${CSS.escape(input.id)}"]`);
    if (forLabel?.textContent?.trim()) return forLabel.textContent.trim();
  }
  return input.closest('label')?.textContent?.trim() ?? '';
}

describe('personal views are named, and the member picker is accessible (Q-531)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  for (const lang of ['en', 'de', 'pl'] as const) {
    it(`${lang}.json says "${PERSONAL_VIEW_WORD[lang]}"`, () => {
      const dict = JSON.parse(readFileSync(resolve(CLIENT_ROOT, `public/assets/i18n/${lang}.json`), 'utf8')) as Record<string, string>;
      const holders = Object.entries(dict).filter(([, v]) => v.toLowerCase().includes(PERSONAL_VIEW_WORD[lang].toLowerCase())).map(([k]) => k);
      expect(holders.length, `no ${lang} sentence uses the feature's word`).toBeGreaterThan(0);
      expect(holders.filter(k => k.startsWith('brain.tabs')), 'the word sits on the tab-strip keys, which are a different "view"').toEqual([]);
    });
  }

  it('the member picker offers the caller\'s spaces only, each checkbox named for its space', async () => {
    const { ViewCreateDialogComponent } = await importNew<{ ViewCreateDialogComponent: unknown }>('../pages/brain/view-create-dialog.component');
    TestBed.configureTestingModule({
      imports: [ViewCreateDialogComponent as never, getTranslocoModule()],
      providers: [provideHttpClient(), provideHttpClientTesting()],
    });
    const fixture = TestBed.createComponent(ViewCreateDialogComponent as never);
    fixture.componentRef.setInput('spaces', SPACES);
    fixture.detectChanges();
    const root = fixture.nativeElement as HTMLElement;
    const boxes = [...root.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')];
    expect(boxes.length, 'the picker does not offer one checkbox per space').toBe(SPACES.length);
    const names = boxes.map(b => accessibleName(b, root));
    for (const [i, s] of SPACES.entries()) {
      expect(names[i], `checkbox ${i} has no accessible name`).toBeTruthy();
      expect(names[i]!.includes(s.label) || names[i]!.includes(s.id), `checkbox ${i} is named "${names[i]}", not for its space`).toBe(true);
    }
  });
});
