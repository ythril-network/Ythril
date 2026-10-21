/**
 * The notice an admin gets on the Brain page while pre-6.0 proxy ids are still reserved (Q-531, plan rev 3.2 "Client").
 *
 * ## The rules
 *
 * 1. Shown only while ids are reserved, and only to an admin (`retired` is `null` for anyone else: nothing is drawn).
 * 2. Dismissing it is remembered per SET of ids: the same set stays quiet, a different one (an id released, another left) brings it back.
 * 3. A browser whose storage throws still shows the notice and still dismisses it for the page's lifetime: a notice that cannot be remembered
 *    is shown, never lost, and never an error.
 */
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { provideRouter } from '@angular/router';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CLIENT_ROOT } from '../../testing/tracked-sources';
import { ViewsApi, type ViewsMigrationReport } from '../../core/views-api.service';
import { ViewsMigrationBannerComponent } from './views-migration-banner.component';

const LANGS = ['en', 'de', 'pl'] as const;
const dict = Object.fromEntries(LANGS.map(l => [l, JSON.parse(readFileSync(resolve(CLIENT_ROOT, `public/assets/i18n/${l}.json`), 'utf8')) as Record<string, string>])) as Record<(typeof LANGS)[number], Record<string, string>>;

const NO_REPORT: ViewsMigrationReport = { migrated: [], unclaimed: [] };

function mount(retired: string[] | null, report: ViewsMigrationReport = NO_REPORT, lang: (typeof LANGS)[number] | null = null) {
  TestBed.resetTestingModule();
  const transloco = lang
    ? getTranslocoModule({ langs: { [lang]: dict[lang] }, translocoConfig: { availableLangs: [lang], defaultLang: lang } })
    : getTranslocoModule();
  TestBed.configureTestingModule({
    imports: [ViewsMigrationBannerComponent, transloco],
    providers: [provideRouter([]), { provide: ViewsApi, useValue: { migration: () => of(report) } }],
  });
  const fixture = TestBed.createComponent(ViewsMigrationBannerComponent);
  fixture.componentRef.setInput('retired', retired);
  fixture.detectChanges();
  return { fixture, el: fixture.nativeElement as HTMLElement };
}

describe('the views migration banner (Q-531)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });
  afterEach(() => vi.restoreAllMocks());

  it('is absent for a caller who is not an admin and for an admin with no reserved id', () => {
    expect(mount(null).el.querySelector('[role="status"]')).toBeNull();
    expect(mount([]).el.querySelector('[role="status"]')).toBeNull();
  });

  it('names the reserved ids and points to Settings, Spaces', () => {
    const { el } = mount(['b', 'a']);
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    expect(el.querySelector('a')?.getAttribute('href')).toBe('/settings/spaces');
  });

  it('stays dismissed for the same set, and comes back for a different one', () => {
    const first = mount(['a', 'b']);
    first.el.querySelector<HTMLButtonElement>('button')!.click();
    first.fixture.detectChanges();
    expect(first.el.querySelector('[role="status"]')).toBeNull();

    expect(mount(['b', 'a']).el.querySelector('[role="status"]'), 'the same set, in another order, came back').toBeNull();
    expect(mount(['a']).el.querySelector('[role="status"]'), 'a different set stayed quiet').not.toBeNull();
  });

  it('shows and dismisses even when the browser storage throws', () => {
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('blocked'); });
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('blocked'); });
    const { fixture, el } = mount(['a']);
    expect(el.querySelector('[role="status"]')).not.toBeNull();
    el.querySelector<HTMLButtonElement>('button')!.click();
    fixture.detectChanges();
    expect(el.querySelector('[role="status"]')).toBeNull();
  });
});

/** The banner's words, in the shipped translations of `lang`. */
function said(lang: (typeof LANGS)[number], retired: string[], report: ViewsMigrationReport = NO_REPORT): string {
  return (mount(retired, report, lang).el.querySelector('[role="status"]')?.textContent ?? '').replace(/\s+/g, ' ').trim();
}
const ids = (n: number, stem = 'p') => Array.from({ length: n }, (_, i) => `${stem}${i + 1}`);
/** A sentence without its numbers and names, so two counts in one plural form compare equal. */
const shape = (text: string) => text.replace(/\b(?:p|u|m)\d+\b/g, 'X').replace(/\d+/g, 'N');

describe('the views migration banner says what the upgrade did (Q-531)', () => {
  beforeEach(() => { try { localStorage.clear(); } catch { /* none */ } });

  it('lists the proxies that became personal views and the views still waiting for an owner, beside the reserved ids', () => {
    const text = said('en', ['old-a', 'old-b'], {
      migrated: ['old-a', 'old-b', 'old-c'],
      unclaimed: [{ name: 'old-c', members: ['x'] }],
    });
    for (const name of ['old-a', 'old-b', 'old-c']) expect(text, name).toContain(name);
    expect(text).toMatch(/3 proxy spaces/);
    expect(text).toMatch(/1 personal view\b.*waiting for an owner/);
  });

  it('is shown for a view still waiting for an owner even when no id is reserved any more', () => {
    const { el } = mount([], { migrated: ['old-c'], unclaimed: [{ name: 'old-c', members: [] }] });
    expect(el.querySelector('[role="status"]')).not.toBeNull();
  });

  it('is not shown when everything is claimed and released, whatever the report once said', () => {
    expect(mount([], { migrated: ['old-c'], unclaimed: [] }).el.querySelector('[role="status"]')).toBeNull();
  });

  for (const lang of LANGS) {
    it(`${lang}: names the sidebar's own words for where to go, taken from the same keys`, () => {
      const where = `${dict[lang]['nav.section.admin']} > ${dict[lang]['nav.spaces']}`;
      expect(said(lang, ['a'], { migrated: ['a'], unclaimed: [{ name: 'a', members: [] }] })).toContain(where);
    });

    it(`${lang}: one and two of each counted thing are said in different plural forms, not as "1 ... ids"`, () => {
      const rules = new Intl.PluralRules(lang);
      for (const [label, build] of [
        ['migrated', (n: number) => ({ retired: [] as string[], report: { migrated: ids(n), unclaimed: [{ name: 'q', members: [] as string[] }] } })],
        ['unclaimed', (n: number) => ({ retired: [] as string[], report: { migrated: ['p1'], unclaimed: ids(n, 'u').map(name => ({ name, members: [] as string[] })) } })],
        ['reserved', (n: number) => ({ retired: ids(n, 'm'), report: NO_REPORT })],
      ] as const) {
        const one = build(1), two = build(2);
        const a = said(lang, one.retired, one.report), b = said(lang, two.retired, two.report);
        expect(a, `${lang} ${label} n=1 said nothing`).not.toBe('');
        expect(rules.select(1) === rules.select(2), 'the language must have a distinct form for 1 and 2 for this check').toBe(false);
        expect(shape(a), `${lang} ${label}: 1 and 2 share one sentence`).not.toBe(shape(b));
      }
    });

    it(`${lang}: every plural form the language uses has its sentence for each counted thing`, () => {
      for (const base of ['views.migration.migrated', 'views.migration.unclaimed', 'views.migration.retired']) {
        const missing = new Intl.PluralRules(lang).resolvedOptions().pluralCategories.filter(c => !dict[lang][`${base}.${c}`]);
        expect(missing, `${lang} ${base}`).toEqual([]);
      }
    });
  }

  it('en and de say no "1 ... ids" or "Prüfen und geben Sie sie ... frei" and name no place the sidebar lacks', () => {
    expect(said('en', ['a'])).not.toMatch(/\b1 proxy ids\b/);
    expect(said('en', ['a'])).not.toMatch(/Settings, Spaces/);
    expect(said('de', ['a'])).not.toMatch(/Prüfen und geben Sie sie/);
    expect(said('de', ['a'])).not.toMatch(/Einstellungen, Spaces/);
  });
});
