/**
 * The Overview card's retention line follows the language (Q-185).
 *
 * `retentionSummary` and `retentionTypes` are `computed()`s that call `transloco.translate`, a plain method no signal tracks. The card
 * renders once before the language file has resolved, so the sentence was the raw key (`brain.overview.retentionNone`) and stayed so; a
 * switch to German after the page was up left the English sentence in place. Both read `ActiveLanguage.revision()` once the fix is in.
 *
 * Rendered with `LanguageLoads` (the one harness that says when a language file arrives), over the shipped dictionaries. Every case here is
 * a fact about the page, so it reads the text out of the DOM, not out of the component.
 *
 * The space-wide sentence is a counted one: "1 day", "1 dzień" - it goes through the plural mechanism like every other counted sentence.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { provideRouter } from '@angular/router';
import { of } from 'rxjs';
import { TranslocoService } from '@jsverse/transloco';
import { BrainApi } from '../../core/brain-api.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { OverviewTabComponent } from './overview-tab.component';
import { dictionary } from '../../testing/i18n-dictionary';
import { LanguageLoads, settle, switchTo } from '../../testing/language-loads';
import type { Space } from '../../core/api.types';

const space = (over: Partial<Space> = {}): Space => ({ id: 'general', label: 'General', ...over }) as Space;

const EN = dictionary('en');
const DE = dictionary('de');
const PL = dictionary('pl');

function mount(loads: LanguageLoads, s: Space) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [OverviewTabComponent],
    providers: [
      ...loads.providers(),
      provideRouter([]),
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
      { provide: BrainApi, useValue: { getErModel: () => of({ spaceId: 's', entityTypes: [], relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 } }) } },
    ],
  });
  const fixture = TestBed.createComponent(OverviewTabComponent);
  fixture.componentRef.setInput('space', s);
  return fixture;
}

const retentionLine = (f: { nativeElement: HTMLElement }): string => (f.nativeElement.querySelector('.ret-line')?.textContent ?? '').trim();

describe('the Overview retention line follows the language (Q-185)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('says the sentence, not its key, once the words arrive after the first render', async () => {
    const loads = new LanguageLoads().now('de', DE).now('pl', PL);
    const en = loads.late('en');
    const fixture = mount(loads, space());
    fixture.detectChanges();
    // The words are not here yet: whatever the card shows now, it must not keep it.
    switchTo(TestBed.inject(TranslocoService), 'en');
    en.resolve(EN);
    await settle();
    fixture.detectChanges();
    expect(retentionLine(fixture)).toBe(EN['brain.overview.retentionNone']);
    expect(retentionLine(fixture)).not.toContain('brain.overview');
  });

  it('says the types list in words too, once the words arrive', async () => {
    const loads = new LanguageLoads().now('de', DE).now('pl', PL);
    const en = loads.late('en');
    const fixture = mount(loads, space({ meta: { typeSchemas: { facts: { note: { retention: { days: 40 } } } } } } as Partial<Space>));
    fixture.detectChanges();
    switchTo(TestBed.inject(TranslocoService), 'en');
    en.resolve(EN);
    await settle();
    fixture.detectChanges();
    const items = [...(fixture.nativeElement as HTMLElement).querySelectorAll('.ret-types li')].map(li => (li.textContent ?? '').trim());
    expect(items).toEqual(['facts.note: deleted after 40 d']);
  });

  it('follows a switch to German: the sentence is German once German words load, and the English one is gone', async () => {
    const loads = new LanguageLoads().now('en', EN).now('pl', PL);
    const de = loads.late('de');
    const fixture = mount(loads, space());
    const transloco = TestBed.inject(TranslocoService);
    switchTo(transloco, 'en');
    await settle();
    fixture.detectChanges();
    expect(retentionLine(fixture)).toBe(EN['brain.overview.retentionNone']);

    switchTo(transloco, 'de');
    await settle();
    fixture.detectChanges();
    // Words still on their way: the page keeps the language it had and shows a sentence, not a key.
    expect(retentionLine(fixture)).toBe(EN['brain.overview.retentionNone']);

    de.resolve(DE);
    await settle();
    fixture.detectChanges();
    expect(retentionLine(fixture)).toBe(DE['brain.overview.retentionNone']);
  });

  it('counts the space-wide window by the language\'s own plural: 1 day, 1 Tag, 1 dzień, and never "1 days"', async () => {
    const lines: Record<string, string> = {};
    for (const lang of ['en', 'de', 'pl'] as const) {
      const loads = new LanguageLoads().now('en', EN).now('de', DE).now('pl', PL);
      const fixture = mount(loads, space({ recordTtlDays: 1 }));
      switchTo(TestBed.inject(TranslocoService), lang);
      await settle();
      fixture.detectChanges();
      lines[lang] = retentionLine(fixture);
    }
    expect(lines['en']).toMatch(/\b1 day\b/);
    expect(lines['en']).not.toMatch(/\b1 days\b/);
    expect(lines['de']).toMatch(/\b1 Tag\b/);
    expect(lines['de']).not.toMatch(/\b1 Tagen\b/);
    // Polish one: the singular, nominative or locative ("1 dzień", "po 1 dniu"), never the plural locative the shared sentence used.
    expect(lines['pl']).toMatch(/\b1 (?:dzień|dniu)\b/);
    expect(lines['pl']).not.toMatch(/\b1 dni(?:ach)?\b/);
  });

  it('and 5 and 22 days keep the plural form, in every language', async () => {
    for (const [lang, days, pattern] of [
      ['en', 5, /\b5 days\b/], ['de', 5, /\b5 Tage[n]?\b/], ['pl', 5, /\b5 dni(?:ach)?\b/], ['pl', 22, /\b22 dni(?:ach)?\b/],
    ] as const) {
      const loads = new LanguageLoads().now('en', EN).now('de', DE).now('pl', PL);
      const fixture = mount(loads, space({ recordTtlDays: days }));
      switchTo(TestBed.inject(TranslocoService), lang);
      await settle();
      fixture.detectChanges();
      expect(retentionLine(fixture), `${lang} ${days}`).toMatch(pattern);
    }
  });
});
