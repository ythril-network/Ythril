/**
 * The space chip's count is a counted sentence, so it takes the plural form its language uses (Q-572).
 *
 * The chip rendered `{{ total }} {{ 'brain.spaceChip.records' | transloco }}` - a number and a fixed noun. English said "1 records",
 * and Polish, which has `one`, `few` and `many` forms, said "1 dokumentacja" / "5 dokumentacja" with one word for every count (and a
 * word that does not even mean a record). The chip now counts through the plural mechanism; Polish reads "1 rekord", "2 rekordy",
 * "5 rekordów".
 *
 * Real dictionaries, not echoed keys: the defect is in what the VALUES say for a given count, which a key-echoing harness cannot show.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { EMPTY, of } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { TranslocoService } from '@jsverse/transloco';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { FilesApi } from '../../core/files-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthService } from '../../core/auth.service';
import { dictionary } from '../../testing/i18n-dictionary';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainComponent } from './brain.component';

/** One space per total: each chip shows the sum of its stats, so the totals are the counts the chip has to inflect. */
const TOTALS: Readonly<Record<string, number>> = { one: 1, two: 2, five: 5 };

function makeApi() {
  return {
    listSpaces: () => of({ spaces: Object.keys(TOTALS).map(id => ({ id, label: id })) }),
    getSpaceStats: (id: string) => of({ facts: TOTALS[id] ?? 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getReindexStatus: () => of({ needsReindex: false }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    getEntitiesByIds: () => of({ entities: [] }),
    mintEventsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
    getErModel: () => of({
      spaceId: 'one', entityTypes: [], relationships: [],
      danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 },
    }),
    getAbout: () => of(null),
    getEmbeddingQueue: () => of(null),
    getTokenAccess: () => of({ tokens: [] }),
    getCompleteness: () => of(null),
    getSpaceActivity: () => of({ spaceId: 'one', hours: 168, spaces: [] }),
    listVotes: () => of({ rounds: [] }),
  } as any;
}

async function chipCounts(language: 'en' | 'pl'): Promise<string[]> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [
      BrainComponent,
      getTranslocoModule({
        langs: { en: dictionary('en'), pl: dictionary('pl') },
        translocoConfig: { availableLangs: ['en', 'pl'], defaultLang: 'en' },
      }),
    ],
    providers: [
      { provide: SpacesApi, useValue: makeApi() },
      { provide: BrainApi, useValue: makeApi() },
      { provide: FilesApi, useValue: makeApi() },
      { provide: AdminApi, useValue: makeApi() },
      { provide: NetworksApi, useValue: makeApi() },
      { provide: AuthService, useValue: { token: () => '' } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
    ],
  });
  TestBed.inject(TranslocoService).setActiveLang(language);
  const fixture = TestBed.createComponent(BrainComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  return [...(fixture.nativeElement as HTMLElement).querySelectorAll('.space-chip-count')]
    .map(el => (el.textContent ?? '').replace(/\s+/g, ' ').trim());
}

describe('the space chip counts records in the reader\'s plural form (Q-572)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('pl: 1 rekord, 2 rekordy, 5 rekordów', async () => {
    expect(await chipCounts('pl')).toEqual(['1 rekord', '2 rekordy', '5 rekordów']);
  });

  it('en: 1 record, 2 records, 5 records', async () => {
    expect(await chipCounts('en')).toEqual(['1 record', '2 records', '5 records']);
  });
});
