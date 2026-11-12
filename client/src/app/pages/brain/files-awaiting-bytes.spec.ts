/**
 * Where a space's file count is shown, the records left out of it while their bytes are gone are said beside it, and only then (bundle-70
 * lens fix, finding 5).
 *
 * The server leaves a file record whose bytes are gone from its disk out of `files` and counts it apart as `filesAwaitingBytes` (Q-337). The
 * Brain page's Files tab and a view's Overview showed `files` alone: a count that dropped with no word. Now each says "+N awaiting bytes",
 * with what that means on hover, and says nothing when N is 0 or the server sent none.
 *
 * Real dictionaries, not echoed keys: what is asserted is the sentence a reader sees.
 *
 * Red on 92e1ca8f: neither page renders anything for `filesAwaitingBytes`.
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
import { ViewOverviewComponent } from './view-overview.component';

const transloco = () => getTranslocoModule({
  langs: { en: dictionary('en'), pl: dictionary('pl') },
  translocoConfig: { availableLangs: ['en', 'pl'], defaultLang: 'en' },
});

function makeApi(awaiting: number | undefined) {
  return {
    listSpaces: () => of({ spaces: [{ id: 'one', label: 'one' }] }),
    getSpaceStats: () => of({ spaceId: 'one', facts: 0, entities: 0, edges: 0, chrono: 0, files: 3, ...(awaiting === undefined ? {} : { filesAwaitingBytes: awaiting }) }),
    getReindexStatus: () => of({ needsReindex: false }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    getEntitiesByIds: () => of({ entities: [] }),
    mintEventsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
    getErModel: () => of({ spaceId: 'one', entityTypes: [], relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 } }),
    getAbout: () => of(null),
    getEmbeddingQueue: () => of(null),
    getTokenAccess: () => of({ tokens: [] }),
    getCompleteness: () => of(null),
    getSpaceActivity: () => of({ spaceId: 'one', hours: 168, spaces: [] }),
    listVotes: () => of({ rounds: [] }),
  } as any;
}

/** The words beside the Files tab's count on the Brain page, as `[text, title]`, or null when there are none. */
async function brainTab(awaiting: number | undefined, language: 'en' | 'pl' = 'en'): Promise<[string, string | null] | null> {
  TestBed.resetTestingModule();
  const api = makeApi(awaiting);
  TestBed.configureTestingModule({
    imports: [BrainComponent, transloco()],
    providers: [
      { provide: SpacesApi, useValue: api }, { provide: BrainApi, useValue: api }, { provide: FilesApi, useValue: api },
      { provide: AdminApi, useValue: api }, { provide: NetworksApi, useValue: api },
      { provide: AuthService, useValue: { token: () => '' } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
    ],
  });
  TestBed.inject(TranslocoService).setActiveLang(language);
  const fixture = TestBed.createComponent(BrainComponent);
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="files-awaiting-bytes"]');
  return el ? [(el.textContent ?? '').replace(/\s+/g, ' ').trim(), el.getAttribute('title')] : null;
}

/** The same words in a view's Overview. */
async function viewOverview(awaiting: number | undefined): Promise<string | null> {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [ViewOverviewComponent, transloco()] });
  TestBed.inject(TranslocoService).setActiveLang('en');
  const fixture = TestBed.createComponent(ViewOverviewComponent);
  fixture.componentRef.setInput('stats', { spaceId: 'v', facts: 0, entities: 0, edges: 0, chrono: 0, files: 3, ...(awaiting === undefined ? {} : { filesAwaitingBytes: awaiting }) });
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
  const el = (fixture.nativeElement as HTMLElement).querySelector('[data-testid="files-awaiting-bytes"]');
  return el ? (el.textContent ?? '').replace(/\s+/g, ' ').trim() : null;
}

describe('the records awaiting their bytes are said beside the file count (bundle-70 lens fix)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('the Brain page\'s Files tab says +2 awaiting bytes, and on hover what that means', async () => {
    const said = await brainTab(2);
    expect(said?.[0]).toBe('+2 awaiting bytes');
    expect(said?.[1]).toContain('2 file records whose bytes are missing');
  });

  it('in Polish the hover takes the plural form of its count', async () => {
    expect((await brainTab(5, 'pl'))?.[1]).toContain('5 wpisów plików');
  });

  it('the Brain page says nothing when no record waits, or the server sent no count', async () => {
    expect(await brainTab(0)).toBeNull();
    expect(await brainTab(undefined)).toBeNull();
  });

  it('a view\'s Overview says it beside its Files count, and nothing at 0', async () => {
    expect(await viewOverview(1)).toBe('+1 awaiting bytes');
    expect(await viewOverview(0)).toBeNull();
  });
});
