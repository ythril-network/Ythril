/**
 * A list tab that is refused says it in the reader's language (Q-762, bundle-273 drive finding).
 *
 * ## The rule
 *
 * Opening a personal view that is defined by a SPARQL CONSTRUCT on the Entities, Edges, Facts or Chrono tab is answered `409` with
 * `{ error: <English sentence>, code: 'view_is_construct' }`. The tabs worded that failure with `httpErrorReason`, the server's own
 * English, so a German reader saw an English sentence while `views.refusal.view_is_construct` had words in all three languages and no
 * caller that could reach them. A code the client has words for is shown in those words; a code it has none for still shows the
 * server's sentence, never the raw code and never a blank.
 *
 * ## What is driven
 *
 * The four real tabs, each over a `BrainApi` whose list call is refused, with the SHIPPED en and de dictionaries. The error box must hold
 * the dictionary's sentence for the code in the active language and not the server's English; an unknown code must keep the server's
 * sentence.
 *
 * ## Seen red
 *
 * Red on a075fa803: the error box held the server's English sentence in German instead of the dictionary's words for the code.
 */
import type { Type } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { describe, it, expect } from 'vitest';
import { of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { dictionary } from '../../testing/i18n-dictionary';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordListState } from './record-list-state.service';
import { EntitiesTabComponent } from './entities-tab.component';
import { EdgesTabComponent } from './edges-tab.component';
import { FactsTabComponent } from './facts-tab.component';
import { ChronoTabComponent } from './chrono-tab.component';

const SERVER_SENTENCE = "'@people' is defined by a SPARQL CONSTRUCT, so only the RDF doors read it. Read its member spaces here (view_is_construct)";
const KEY = 'views.refusal.view_is_construct';

const TABS = [
  { name: 'Entities', component: EntitiesTabComponent, list: 'listEntities' },
  { name: 'Edges', component: EdgesTabComponent, list: 'listEdges' },
  { name: 'Facts', component: FactsTabComponent, list: 'listFacts' },
  { name: 'Chrono', component: ChronoTabComponent, list: 'listChrono' },
] as const;

/** The tab over a space that answers its list refused with `body`, in `lang`; the text of its error box. */
function errorBoxText(tab: (typeof TABS)[number], lang: 'en' | 'de', body: Record<string, unknown>): string {
  const refusal = { status: 409, statusText: 'Conflict', error: body };
  const api = new Proxy({}, { get: (_t, name) => (name === tab.list ? () => throwError(() => refusal) : () => of({})) });
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [tab.component, getTranslocoModule({
      langs: { en: dictionary('en'), de: dictionary('de') },
      translocoConfig: { availableLangs: ['en', 'de'], defaultLang: lang },
    })],
    providers: [provideRouter([]), RecordListState, BrainStore, EntityRefPicker, RecordDrawerState, { provide: BrainApi, useValue: api }],
  });
  TestBed.inject(TranslocoService).setActiveLang(lang);
  const fixture = TestBed.createComponent(tab.component as Type<object>);
  fixture.componentRef.setInput('spaceId', '@people');
  fixture.detectChanges();
  fixture.detectChanges();
  return (fixture.nativeElement as HTMLElement).querySelector('app-error-state')?.textContent ?? '';
}

describe('a refused list load on a Brain tab is worded in the active language', () => {
  for (const tab of TABS) {
    for (const lang of ['en', 'de'] as const) {
      it(`${tab.name} tab, ${lang}: view_is_construct reads the dictionary's sentence, not the server's English`, () => {
        const shown = errorBoxText(tab, lang, { error: SERVER_SENTENCE, code: 'view_is_construct' });
        expect(shown).toContain(dictionary(lang)[KEY]);
        expect(shown).not.toContain(SERVER_SENTENCE);
      });
    }

    it(`${tab.name} tab: a code the client has no words for keeps the server's sentence`, () => {
      const shown = errorBoxText(tab, 'de', { error: 'The thing broke in a new way', code: 'a_code_from_a_newer_server' });
      expect(shown).toContain('The thing broke in a new way');
      expect(shown).not.toContain('a_code_from_a_newer_server');
    });
  }

  it('the German sentence differs from the English one, so the checks above tell the languages apart', () => {
    expect(dictionary('de')[KEY]).not.toBe(dictionary('en')[KEY]);
  });
});
