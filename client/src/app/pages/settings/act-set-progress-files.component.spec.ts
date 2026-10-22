/**
 * bundle-111 (Q-557; design rev 3 step 11, V-S10): what the restore progress card SAYS about the files a restored space no longer matches.
 *
 * `GET /api/admin/data/restore` gives a space's row `files: { checked, classes: { <class>: { count, paths } } }` (or
 * `{ checked: false, reason }`), and the card is the only place an operator reads it. The card is SHARED with the migrate, whose rows carry no
 * such field. These specs use the real en, de and pl files: the thing pinned is the sentence read, in the three languages the page ships.
 *
 * What the design holds, and each case below pins one:
 * - `files` is shown only on a RESTORE set's space rows that carry it; a migrate's card, and a row without the field, say nothing of files;
 * - a space with mismatches is a warn variant AND says so in words (colour is never the only signal), and a clean space stays Done;
 * - the paths sit in a keyboard-reachable disclosure that wraps, not in a line that overflows the card;
 * - a count is a plural in each language (one/few/many/other in pl), with no raw key and no unfilled `{{...}}` showing;
 * - an unknown class (a newer server) renders its raw name rather than nothing; a space that was not checked shows the server's reason.
 *
 * The shape of `files` is this bundle's reading of rev 3 step 8; the server tests (`a-restore-reports-which-files-no-longer-match-their-
 * records-db.test.js`) hold the other end of it. On 3a117862 the card renders nothing of `files`, so every case that reads it is red there;
 * the three "says nothing" cases (a clean space, a row without the field, a migrate's card) are green there and guard what must stay.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { ActSetProgressComponent } from './act-set-progress.component';
import { migrateReport, restoreReport, restoreSpace } from '../../testing/data-act-bodies';

const dictionary = (lang: string): Record<string, string> => JSON.parse(readFileSync(resolve(__dirname, `../../../../public/assets/i18n/${lang}.json`), 'utf8'));
const LANGS = { en: dictionary('en'), de: dictionary('de'), pl: dictionary('pl') };

function card(kind: 'restore' | 'migrate', report: Record<string, unknown>, lang: 'en' | 'de' | 'pl' = 'en'): ComponentFixture<ActSetProgressComponent> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ActSetProgressComponent, getTranslocoModule({ langs: LANGS, translocoConfig: { availableLangs: ['en', 'de', 'pl'], defaultLang: lang } })],
  });
  const fixture = TestBed.createComponent(ActSetProgressComponent);
  fixture.componentRef.setInput('kind', kind);
  fixture.componentRef.setInput('report', report);
  fixture.detectChanges();
  return fixture;
}

const rowEl = (f: ComponentFixture<ActSetProgressComponent>, id: string): HTMLElement | undefined =>
  Array.from((f.nativeElement as HTMLElement).querySelectorAll('li')).find(li => li.querySelector('span')?.textContent?.trim() === id);
const rowText = (f: ComponentFixture<ActSetProgressComponent>, id: string): string => (rowEl(f, id)?.textContent ?? '').replace(/\s+/g, ' ').trim();

/** A done restore of one space whose files report is `files`. */
const restoreOf = (files: unknown, id = 'notes') =>
  restoreReport({ state: 'completed', endedAt: '2026-10-18T12:01:00.000Z', spaces: [restoreSpace(id, 'done', { files })] });

const STALE = (count: number, paths: string[] = ['report.json']) => ({ checked: true, classes: { stale_row: { count, paths } } });

describe('a restored space\'s mismatching files on the restore card (Q-557)', () => {
  it('names the count and the paths of a class, in words, and the row is a warning - not a Done pill alone', () => {
    const f = card('restore', restoreOf({ checked: true, classes: {
      stale_row: { count: 2, paths: ['a/report.json', 'b/plan.json'] }, missing_row: { count: 1, paths: ['new.json'] },
    } }));
    const text = rowText(f, 'notes');
    for (const p of ['a/report.json', 'b/plan.json', 'new.json']) expect(text, `path ${p}`).toContain(p);
    expect(text, 'the counts are said').toMatch(/\b2\b/);
    expect(rowEl(f, 'notes')?.querySelector('.pill.warn'), 'a space with mismatches is a warn variant').not.toBeNull();
    expect(rowEl(f, 'notes')?.querySelector('.pill.ok'), 'a space with mismatches still reads as plainly OK').toBeNull();
    // Words, not colour alone: the row says more than its state word and the paths themselves.
    const sentence = text.replace(/a\/report\.json|b\/plan\.json|new\.json/g, '').replace(/\d+/g, '').replace(/\s+/g, ' ');
    expect(sentence.length, `the row says nothing in words about the mismatch: '${text}'`).toBeGreaterThan(40);
  });

  it('puts the paths in a keyboard-reachable disclosure (a details/summary or a button with aria-expanded), not in the row\'s own line', () => {
    const f = card('restore', restoreOf(STALE(1, ['a/very/long/path/that/must/wrap/report.json'])));
    const row = rowEl(f, 'notes')!;
    const control = row.querySelector('details > summary, button[aria-expanded]');
    expect(control, 'no disclosure holds the paths').not.toBeNull();
    expect(control?.getAttribute('tabindex'), 'the disclosure is taken out of the tab order').not.toBe('-1');
    const holder = Array.from(row.querySelectorAll('details, [role="region"], [id]')).find(e => e.textContent?.includes('a/very/long/path'));
    expect(holder, 'the path is not inside the disclosure').toBeDefined();
    expect(`${holder?.getAttribute('style') ?? ''} ${holder?.className ?? ''}`, 'the paths are held on one line').not.toMatch(/nowrap/);
  });

  it('a clean space (checked, nothing out of step) stays Done and says nothing of mismatches', () => {
    const f = card('restore', restoreOf({ checked: true, classes: {} }));
    const row = rowEl(f, 'notes')!;
    expect(row.querySelector('.pill.ok')).not.toBeNull();
    expect(row.querySelector('.pill.warn')).toBeNull();
    expect(row.querySelector('details, button[aria-expanded]'), 'a disclosure with nothing in it').toBeNull();
  });

  it('a space that was not checked shows the server\'s reason, and is not Done-and-clean', () => {
    const f = card('restore', restoreOf({ checked: false, reason: 'the file system did not answer within 120 s' }));
    expect(rowText(f, 'notes')).toContain('the file system did not answer within 120 s');
    expect(rowEl(f, 'notes')?.querySelector('.pill.ok'), 'an unchecked space reads as checked and clean').toBeNull();
  });

  it('an unknown class (a newer server) renders its raw name and its count rather than nothing', () => {
    const f = card('restore', restoreOf({ checked: true, classes: { future_class: { count: 3, paths: ['z.json'] } } }));
    expect(rowText(f, 'notes')).toContain('future_class');
    expect(rowText(f, 'notes')).toContain('z.json');
  });

  it('control (green at base): a row without the field says nothing of files, on a restore and on a migrate', () => {
    for (const kind of ['restore', 'migrate'] as const) {
      const spaces = [restoreSpace('notes', 'done')];
      const f = card(kind, kind === 'restore' ? restoreReport({ state: 'completed', spaces }) : migrateReport({ state: 'completed', done: 1, total: 1, spaces }));
      expect(rowEl(f, 'notes')?.querySelector('details, button[aria-expanded]'), `${kind}: a disclosure with nothing to disclose`).toBeNull();
      expect(rowEl(f, 'notes')?.querySelector('.pill.warn'), `${kind}: a warn pill with nothing to warn of`).toBeNull();
    }
  });

  it('a migrate\'s card never shows files, even when a row carries the field', () => {
    const f = card('migrate', migrateReport({ state: 'completed', done: 1, total: 1, spaces: [restoreSpace('notes', 'done', { files: STALE(2, ['leak.json']) })] }));
    expect(rowText(f, 'notes')).not.toContain('leak.json');
    expect(rowEl(f, 'notes')?.querySelector('.pill.warn')).toBeNull();
  });
});

describe('the count is a plural in each language the page ships, and no key or placeholder shows', () => {
  /** The row's words for `count` files of one class, with the digits and the path taken out, so only the plural form is compared. */
  const words = (lang: 'en' | 'de' | 'pl', count: number): string =>
    rowText(card('restore', restoreOf(STALE(count, ['p.json'])), lang), 'notes').replace(/p\.json/g, '').replace(/\d[\d\s.,  ]*/g, '#').replace(/\s+/g, ' ').trim();

  it('en and de tell one file from several; pl tells one, few (2) and many (5) apart', () => {
    expect(words('en', 1), 'en: one and several read alike').not.toBe(words('en', 2));
    expect(words('de', 1), 'de: one and several read alike').not.toBe(words('de', 2));
    expect(new Set([words('pl', 1), words('pl', 2), words('pl', 5)]).size, 'pl: one, few and many do not each have their own form').toBe(3);
  });

  it('no language shows a raw key or an unfilled {{placeholder}} for a class, a count or an unknown class', () => {
    for (const lang of ['en', 'de', 'pl'] as const) {
      const f = card('restore', restoreOf({ checked: true, classes: { stale_row: { count: 1, paths: ['a.json'] }, soft_deleted_with_bytes: { count: 5, paths: ['b.json'] }, future_class: { count: 2, paths: [] } } }), lang);
      const text = rowText(f, 'notes');
      expect(text, `${lang}: a translation key shows`).not.toMatch(/\bdata\.[a-z]+\.[A-Za-z.]+/);
      expect(text, `${lang}: a placeholder shows unfilled`).not.toMatch(/\{\{/);
      expect(text, `${lang}: nothing is said of the mismatch`).toContain('a.json');
    }
  });
});
