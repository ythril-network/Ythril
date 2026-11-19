/**
 * The Brain page's two links into the conversion (bundle-285 slice S6, Q-747; plan sections 3.1, 14 "the dead Overview pencil", 5 row V1; handover item 6):
 * the pencil on a type of the Overview's data model opens the settings pop-up on that type's editor, and the page's Review tab carries the count of open
 * unconverted records.
 *
 * ## The pencil was dead twice over
 *
 * The Overview tab's `editSchemaType` output had no listener in the page, and its `canEditSchema` input was never bound either (since the panel was
 * drawn, bundle-81 era): the pencil was never even drawn, and the guide (02-brain.md) promises it "opens the schema editor without leaving the page".
 * Both are bound now: the pencil shows to a token that holds the schema right on the open space (`holdsSchemaAdmin`, the Schema tab's own rule) and
 * opens the pop-up on the Schema tab with the type selected. A type the schema does not declare yet (the pencil's "+") is declared and selected.
 *
 * ## The Review tab's count
 *
 * One read per space (`GET .../schema-convert/items?limit=1`, its `counts.open`), shown on the tab as the other tabs show their counts, absent while it
 * is unknown, when it failed, when nothing is open, and on a personal view (which has no Review tab). Leaving a tab does not read it again.
 *
 * ## Seen red
 *
 * Red at 0897912a9: the pencil is not drawn (the input is unbound) and nothing in the page reads the count.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { EMPTY, of } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { FilesApi } from '../../core/files-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthService } from '../../core/auth.service';
import { AuthApi } from '../../core/auth-api.service';
import { ConversionApi } from '../../core/conversion-api.service';
import { dictionary } from '../../testing/i18n-dictionary';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { instanceAdminRights, listAnswer, okResult, openGroup, refused, rightsWith } from '../../testing/review-unconverted-fixtures';
import type { TokenRights } from '../settings/rights-glyph.component';
import { BrainComponent } from './brain.component';

const EN = dictionary('en');

const WORK = {
  id: 'work', label: 'work',
  meta: { version: 1, typeSchemas: { entity: { person: { propertySchemas: { name: { type: 'string' } } } } } },
};

const MODEL = {
  spaceId: 'work',
  entityTypes: [
    { type: 'person', count: 3, declared: true, properties: [], linkedFrom: { facts: 0, chrono: 0, files: 0 } },
    { type: 'ghost', count: 2, declared: false, properties: [], linkedFrom: { facts: 0, chrono: 0, files: 0 } },
  ],
  relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 5, edges: 0 },
};

function api(spaces: readonly object[] = [WORK]) {
  return {
    listSpaces: () => of({ spaces }),
    getSpaceStats: () => of({ facts: 0, entities: 5, edges: 0, chrono: 0, files: 0 }),
    getReindexStatus: () => of({ needsReindex: false }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    getEntitiesByIds: () => of({ entities: [] }),
    mintEventsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
    getErModel: () => of(MODEL),
    getAbout: () => of(null), getEmbeddingQueue: () => of(null), getTokenAccess: () => of({ tokens: [] }), getCompleteness: () => of(null),
    getSpaceActivity: () => of({ spaceId: 'work', hours: 168, spaces: [] }),
    listVotes: () => of({ rounds: [] }),
  } as never;
}

interface Setup { rights?: TokenRights | null; open?: number | 'refused' | 'none'; spaces?: readonly object[] }

function mount(over: Setup = {}) {
  const listUnconverted = vi.fn((_space: string, _query?: object) => of(over.open === 'refused'
    ? refused({ kind: 'no_right', code: 'unconverted_rung', error: 'no' })
    : okResult(listAnswer([], over.open === undefined || over.open === 'none' || over.open === 0 ? [] : [openGroup('person', 'not_conforming', over.open)]))));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BrainComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      { provide: SpacesApi, useValue: api(over.spaces) },
      { provide: BrainApi, useValue: api(over.spaces) },
      { provide: FilesApi, useValue: api(over.spaces) },
      { provide: AdminApi, useValue: api(over.spaces) },
      { provide: NetworksApi, useValue: api(over.spaces) },
      { provide: AuthService, useValue: { token: () => '' } },
      { provide: AuthApi, useValue: { verifyToken: () => of({ id: 't', name: 't', rights: over.rights === undefined ? instanceAdminRights() : over.rights }) } },
      { provide: ConversionApi, useValue: { listUnconverted } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
    ],
  });
  const fixture = TestBed.createComponent(BrainComponent);
  fixture.detectChanges();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const pen = (type: string): SVGGElement | null =>
    Array.from(el.querySelectorAll<SVGGElement>('g.card')).find(g => g.querySelector('.box-name')?.textContent?.trim() === type)?.querySelector('g.pen') ?? null;
  const reviewCount = (): HTMLElement | null => el.querySelector<HTMLElement>('[data-testid="review-unconverted-open"]');
  return { fixture, c: fixture.componentInstance, el, listUnconverted, pen, reviewCount };
}

beforeEach(() => TestBed.resetTestingModule());

describe('the Overview pencil on a type of the data model', () => {
  it('is drawn for a token that holds the schema right on the space, and not for one that does not', () => {
    expect(mount().pen('person'), 'an instance administrator').not.toBeNull();
    expect(mount({ rights: rightsWith('read') }).pen('person'), 'a token that reads').toBeNull();
    expect(mount({ rights: null }).pen('person'), 'rights nobody could read').toBeNull();
  });

  it('clicking it opens the settings pop-up on the Schema tab with that type selected (it was dead)', () => {
    const m = mount();
    expect(m.c.spaceSettings.settingsSpace()).toBeNull();
    m.pen('person')!.dispatchEvent(new Event('click'));
    m.fixture.detectChanges();
    expect(m.c.spaceSettings.settingsSpace()?.id).toBe('work');
    expect(m.c.spaceSettings.settingsTab()).toBe('schema');
    expect(m.c.spaceSettings.schemaCollTab()).toBe('entity');
    expect(m.c.spaceSettings.isTypeSelected('entity', 'person')).toBe(true);
    expect(m.c.spaceSettings.isDirty(), 'opening it edits nothing').toBe(false);
  });

  it('Enter on the pencil does the same, for a keyboard', () => {
    const m = mount();
    m.pen('person')!.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    m.fixture.detectChanges();
    expect(m.c.spaceSettings.isTypeSelected('entity', 'person')).toBe(true);
  });

  it('on a type the schema does not declare yet (the "+"), declares it and selects it', () => {
    const m = mount();
    m.pen('ghost')!.dispatchEvent(new Event('click'));
    m.fixture.detectChanges();
    expect(m.c.spaceSettings.typeNames('entity')).toContain('ghost');
    expect(m.c.spaceSettings.isTypeSelected('entity', 'ghost')).toBe(true);
    expect(m.c.spaceSettings.settingsTab()).toBe('schema');
  });

  it('the cog still opens the settings on their first tab: only the pencil goes to a type', () => {
    const m = mount();
    m.c.openSpaceSettings();
    expect(m.c.spaceSettings.settingsTab()).toBe('settings');
  });
});

describe('the Review tab\'s count of open unconverted records', () => {
  it('shows the open count beside the tab, read once for the space, with a title that says what it counts', () => {
    const m = mount({ open: 7 });
    expect(m.reviewCount()!.textContent!.trim()).toBe('7');
    expect(m.reviewCount()!.getAttribute('title')).toBe(EN['brain.tab.reviewUnconverted.other']!.replace('{{count}}', '7'));
    expect(m.listUnconverted).toHaveBeenCalledTimes(1);
    expect(m.listUnconverted.mock.calls[0]![0]).toBe('work');
    expect(m.listUnconverted.mock.calls[0]![1]).toMatchObject({ limit: 1 });
  });

  it('says the singular for one', () => {
    expect(mount({ open: 1 }).reviewCount()!.getAttribute('title')).toBe(EN['brain.tab.reviewUnconverted.one']!.replace('{{count}}', '1'));
  });

  it.each([
    ['nothing is open', { open: 0 as const }],
    ['the read was refused', { open: 'refused' as const }],
  ])('is absent when %s', (_name, over) => {
    expect(mount(over).reviewCount()).toBeNull();
  });

  it('does not read it again when the tab changes, and reads the next space once', async () => {
    const m = mount({ open: 3, spaces: [WORK, { ...WORK, id: 'other', label: 'other' }] });
    await m.c.setTab('entities');
    await m.c.setTab('overview');
    expect(m.listUnconverted).toHaveBeenCalledTimes(1);
    await m.c.selectSpace('other');
    m.fixture.detectChanges();
    expect(m.listUnconverted).toHaveBeenCalledTimes(2);
    expect(m.listUnconverted.mock.calls[1]![0]).toBe('other');
  });
});
