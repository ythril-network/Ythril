import { TestBed } from '@angular/core/testing';
import { Component } from '@angular/core';
import { Router, provideRouter } from '@angular/router';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from '../testing/transloco-testing';
import { ForkMarkerComponent } from './fork-marker.component';
import { FORK_KINDS, type ForkKind } from '../core/forks.types';

/**
 * The "fork in Review" marker on a Brain list row (Q-624 design §11).
 *
 * A fork row (a record carrying `forkOf`) is listed beside its subject in Facts, Entities, Edges and Chrono. Without a mark it reads as a duplicate record
 * the reader should delete; with one it says what it is and goes to where it is decided: Review, Forks, with the row's own kind chosen. Held here:
 *
 *  - the mark appears for a row that carries `forkOf` and for nothing else (absent, empty and non-string all mean "not a fork": the condition is inside);
 *  - it links to Review's Forks section with the row's kind selected, for every kind, derived from `FORK_KINDS`;
 *  - the four record tabs use it (read from their source, so a fifth tab or a template that drops it fails here, not in a reader's eyes);
 *  - it adds no word: its words are the keys the Review tab already speaks, plus the one marker key, which every language carries.
 */
@Component({
  standalone: true,
  imports: [ForkMarkerComponent],
  template: `<app-fork-marker [forkOf]="forkOf" [kind]="kind" />`,
})
class Host { forkOf: unknown = undefined; kind: ForkKind = 'entity'; }

describe('ForkMarkerComponent', () => {
  const render = (forkOf: unknown, kind: ForkKind = 'entity') => {
    TestBed.configureTestingModule({ imports: [Host, getTranslocoModule()], providers: [provideRouter([])] });
    const f = TestBed.createComponent(Host);
    f.componentInstance.forkOf = forkOf;
    f.componentInstance.kind = kind;
    f.detectChanges();
    return f;
  };

  it('shows the marker for a row that carries forkOf', () => {
    expect(render('parent-id').nativeElement.textContent).toContain('brain.review.forks.marker');
  });

  it.each([undefined, null, '', 0, true, {}])('shows nothing when forkOf is %j', (value) => {
    expect((render(value).nativeElement.textContent ?? '').trim()).toBe('');
  });

  it.each(FORK_KINDS as readonly ForkKind[])('links to Review, Forks, with the %s kind chosen', (kind) => {
    const f = render('parent-id', kind);
    const a: HTMLAnchorElement = f.nativeElement.querySelector('a');
    expect(a).toBeTruthy();
    const url = TestBed.inject(Router).parseUrl(a.getAttribute('href') ?? '');
    expect(url.queryParams).toEqual(expect.objectContaining({ tab: 'review', section: 'forks', forkKind: kind }));
    expect(a.getAttribute('aria-label')).toContain('brain.review.forks.markerOpen');
  });

  it("stays on one line in a narrow column, in the app's own badge style, and sets no width of its own", () => {
    const f = render('parent-id', 'edge');
    const a: HTMLAnchorElement = f.nativeElement.querySelector('a');
    expect(a.classList.contains('badge'), "the app's badge class").toBe(true);
    expect(getComputedStyle(a).whiteSpace, "the marker wrapped to two lines in the Edges list's narrow column (b81 drive)").toBe('nowrap');
    expect(getComputedStyle(a).width, 'a width of its own would widen the column for rows that carry no marker').not.toMatch(/\d/);
    expect(getComputedStyle(a).minWidth).not.toMatch(/[1-9]/);
  });

  it('every one of the four record tabs puts the marker on its rows, with its own kind', () => {
    const tabs: Array<[string, ForkKind, string]> = [
      ['entities-tab', 'entity', 'ent'], ['edges-tab', 'edge', 'edge'], ['facts-tab', 'fact', 'mem'], ['chrono-tab', 'chrono', 'entry'],
    ];
    expect(tabs.length).toBe(FORK_KINDS.length);
    for (const [file, kind, row] of tabs) {
      const src = readFileSync(resolve(__dirname, `../pages/brain/${file}.component.ts`), 'utf8');
      expect(src).toContain(`<app-fork-marker [forkOf]="${row}.forkOf" kind="${kind}" />`);
    }
  });

  it('adds the one key to every language and reuses the words the Review tab already has', () => {
    const dir = resolve(__dirname, '../../../public/assets/i18n');
    for (const lang of ['en', 'de', 'pl']) {
      const words = JSON.parse(readFileSync(resolve(dir, `${lang}.json`), 'utf8')) as Record<string, string>;
      const fork = words['brain.review.forks.forkOf']!.replace('{{id}}', '').trim();
      const review = words['brain.tab.review']!;
      expect(words['brain.review.forks.marker'], `${lang}: marker`).toBeTruthy();
      expect(words['brain.review.forks.markerOpen'], `${lang}: markerOpen`).toBeTruthy();
      // The thing is a "fork" in the app's own word, in this language: the marker says that word, not a synonym.
      expect(words['brain.review.forks.marker']!.toLowerCase(), `${lang}: marker names the fork`).toContain(fork.toLowerCase());
      expect(words['brain.review.forks.markerOpen']!.toLowerCase(), `${lang}: markerOpen names Review's Forks section`).toContain(words['brain.review.forks.tab']!.toLowerCase());
      expect(review.length).toBeGreaterThan(0);
    }
  });
});
