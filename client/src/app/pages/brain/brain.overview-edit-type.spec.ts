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
 * ## The count follows every act, and the pencil lands on the type (bundle-285 slice S12, Q-939, Q-747; the fifth browser drive)
 *
 * The page's own read is the count only until the Review tab's Unconverted section has read one: from then on the tab shows the number the
 * section's state holds after its every list read (a load, a dismiss, a bulk dismiss, a Convert again's run). The settings pop-up closing reads it
 * again (a conversion may have run in it). A switch of space shows that space's number, and an answer about the last space is dropped. The pencil
 * opens the pop-up with the type's head scrolled into view and focus on the type's name control (its rename button), and closing the pop-up
 * gives focus back to the pencil.
 *
 * ## Seen red
 *
 * Red at 0897912a9: the pencil is not drawn (the input is unbound) and nothing in the page reads the count. The S12 rows, red at bf7cd078a: after a
 * dismiss the tab still says 7, and the pop-up opens on the Schema tab with nothing scrolled and focus on its close button.
 */
import { DeferBlockBehavior, TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { EMPTY, of } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ForksApi } from '../../core/forks-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { ToastService } from '../../core/toast.service';
import { NO_TYPE_READS } from '../../testing/schema-type-reads';
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
import { instanceAdminRights, listAnswer, okResult, openGroup, refused, rightsWith, unconvertedRow } from '../../testing/review-unconverted-fixtures';
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
    getAbout: () => of(null), getEmbeddingQueue: () => of(null), getTokenAccess: () => of({ tokens: [] }),
    getCompleteness: () => of({ spaceId: 'work', score: null, checks: [], truncated: false }),
    getSpaceActivity: () => of({ spaceId: 'work', hours: 168, spaces: [] }),
    listVotes: () => of({ rounds: [] }),
    // What the settings pop-up's Schema tab reads (S12: the pencil's rows render it).
    getSchemaLayers: () => of({ spaceId: 'work', own: {}, layers: [], precedence: [], clashes: [] }),
    getSchema: () => of({ meta: {} }), listEntries: () => of({ entries: [] }), listSchemaLibrary: () => of({ entries: [] }),
  } as never;
}

/** What the server holds open per space, changed by a spec between acts: every list read answers it, rows and `counts.open` alike. */
type Served = Record<string, number>;

interface Setup { rights?: TokenRights | null; open?: number | 'refused' | 'none'; spaces?: readonly object[]; served?: Served }

/** The page of a space that holds `n` open records of `person`, as the list door answers it. */
const servedPage = (space: string, n: number) =>
  okResult(listAnswer(Array.from({ length: Math.min(n, 25) }, (_, i) => unconvertedRow(i + 1, { space })), n > 0 ? [openGroup('person', 'not_conforming', n)] : []));

function mount(over: Setup = {}) {
  const served = over.served;
  const listUnconverted = vi.fn((space: string, _query?: object) => of(served ? servedPage(space, served[space] ?? 0) : over.open === 'refused'
    ? refused({ kind: 'no_right', code: 'unconverted_rung', error: 'no' })
    : okResult(listAnswer([], over.open === undefined || over.open === 'none' || over.open === 0 ? [] : [openGroup('person', 'not_conforming', over.open)]))));
  // A dismiss takes one record off the space's open list; "Dismiss all N shown" takes the N.
  const dismissOne = vi.fn((space: string) => { if (served) served[space] = Math.max(0, (served[space] ?? 0) - 1); return of(okResult({ item: unconvertedRow(1, { status: 'dismissed' }) })); });
  const dismissShown = vi.fn((space: string, body: { expect: number }) => {
    if (served) served[space] = Math.max(0, (served[space] ?? 0) - body.expect);
    return of(okResult({ dismissed: body.expect }));
  });
  const conversion = {
    listUnconverted, dismissOne, dismissShown,
    status: () => of(okResult({ state: 'none' })), start: () => EMPTY, countsFor: () => EMPTY, olderCount: () => of(0), refusedCount: () => of(0),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [BrainComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      { provide: SpacesApi, useValue: api(over.spaces) },
      { provide: BrainApi, useValue: api(over.spaces) },
      { provide: FilesApi, useValue: api(over.spaces) },
      { provide: AdminApi, useValue: api(over.spaces) },
      { provide: NetworksApi, useValue: api(over.spaces) },
      { provide: SchemaApi, useValue: { ...(api(over.spaces) as object), ...NO_TYPE_READS } },
      { provide: AuthService, useValue: { token: () => '' } },
      { provide: AuthApi, useValue: { verifyToken: () => of({ id: 't', name: 't', rights: over.rights === undefined ? instanceAdminRights() : over.rights }) } },
      { provide: ConversionApi, useValue: conversion },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
      // The Review tab's other sections, read when it opens (S12's rows open it).
      { provide: DuplicatesApi, useValue: { listDuplicates: () => of({ duplicates: [] }) } },
      { provide: ContradictionsApi, useValue: { listContradictions: () => of({ contradictions: [] }) } },
      { provide: ForksApi, useValue: { listForks: () => of({ forks: [], skip: 0, limit: 25 }) } },
      { provide: ToastService, useValue: { error: () => {}, success: () => {}, info: () => {}, show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
    deferBlockBehavior: DeferBlockBehavior.Playthrough,
  });
  const fixture = TestBed.createComponent(BrainComponent);
  fixture.detectChanges();
  fixture.detectChanges();
  const el = fixture.nativeElement as HTMLElement;
  const pen = (type: string): SVGGElement | null =>
    Array.from(el.querySelectorAll<SVGGElement>('g.card')).find(g => g.querySelector('.box-name')?.textContent?.trim() === type)?.querySelector('g.pen') ?? null;
  const reviewCount = (): HTMLElement | null => el.querySelector<HTMLElement>('[data-testid="review-unconverted-open"]');
  return { fixture, c: fixture.componentInstance, el, listUnconverted, dismissOne, dismissShown, pen, reviewCount };
}

beforeEach(() => TestBed.resetTestingModule());

describe('the Overview pencil on a type of the data model', () => {
  it('is drawn for a token that holds the schema right on the space, and not for one that does not', () => {
    expect(mount().pen('person'), 'an instance administrator').not.toBeNull();
    expect(mount({ rights: rightsWith('read') }).pen('person'), 'a token that reads').toBeNull();
    expect(mount({ rights: null }).pen('person'), 'rights nobody could read').toBeNull();
  });

  it('has its own accessible name on every type, naming the type, so a screen reader can tell a thousand pens apart', () => {
    const m = mount();
    const nameOf = (type: string): string => m.pen(type)!.getAttribute('aria-label') ?? '';
    expect(nameOf('person')).toContain('person');
    expect(nameOf('ghost')).toContain('ghost');
    expect(nameOf('person')).not.toBe(nameOf('ghost'));
    expect(nameOf('person'), 'a declared type is edited').toBe(`${EN['brain.overview.er.editSchema']} person`);
    expect(nameOf('ghost'), 'an undeclared type is declared').toBe(`${EN['brain.overview.er.declareSchema']} ghost`);
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

type Mounted = ReturnType<typeof mount>;

/** Render until `ready` holds: the Review tab and the pop-up's Schema tab sit in deferred blocks with a minimum loading time (real time). */
async function until(m: Mounted, ready: () => boolean, what: string): Promise<void> {
  await vi.waitFor(async () => {
    m.fixture.detectChanges();
    await m.fixture.whenStable();
    m.fixture.detectChanges();
    if (!ready()) throw new Error(`never rendered: ${what}`);
  }, { timeout: 5_000, interval: 50 });
}

const countText = (m: Mounted): string | null => m.reviewCount()?.textContent?.trim() ?? null;
const cards = (m: Mounted): HTMLElement[] => [...m.el.querySelectorAll<HTMLElement>('[data-testid="unconverted-card"]')];

/** Open Review on its Unconverted section, as a person does, and wait for its cards. */
async function openUnconverted(m: Mounted): Promise<void> {
  await m.c.setTab('review');
  await until(m, () => !!m.el.querySelector('#review-tab-unconverted'), 'the Review tab');
  m.el.querySelector<HTMLButtonElement>('#review-tab-unconverted')!.click();
  await until(m, () => cards(m).length > 0, 'the Unconverted cards');
}

/** Press Dismiss on the first card (the confirm says yes), and let the list be read again. */
async function dismissFirst(m: Mounted): Promise<void> {
  const before = cards(m).length;
  const button = [...cards(m)[0]!.querySelectorAll<HTMLButtonElement>('button')].find(b => b.textContent?.trim() === EN['brain.review.unconverted.dismiss'])!;
  button.click();
  await until(m, () => m.dismissOne.mock.calls.length > 0 && cards(m).length < before, 'the list after the dismiss');
}

describe('the Review tab\'s count follows every act that changes it (S12, Q-939: the fifth drive saw 7 beside six cards)', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('after a dismiss the server answers with 6 open, the tab reads 6; after "Dismiss all" took the rest, there is no count', async () => {
    const served: Served = { work: 7 };
    const m = mount({ served });
    expect(countText(m), 'the page\'s own read, before Review opened').toBe('7');
    await openUnconverted(m);
    await dismissFirst(m);
    expect(served['work']).toBe(6);
    expect(countText(m), 'the count the section read after the dismiss').toBe('6');
    const all = m.el.querySelector<HTMLButtonElement>('[data-testid="dismiss-all"]')!;
    all.click();
    await until(m, () => m.dismissShown.mock.calls.length > 0 && cards(m).length === 0, 'the empty list after "Dismiss all"');
    expect(served['work']).toBe(0);
    expect(m.reviewCount(), 'a count of 0 is no count').toBeNull();
  });

  it('a space switch shows that space\'s number; an answer about the last space is dropped', async () => {
    const served: Served = { work: 7, other: 2 };
    const m = mount({ served, spaces: [WORK, { ...WORK, id: 'other', label: 'other' }] });
    await openUnconverted(m);
    await dismissFirst(m);
    expect(countText(m)).toBe('6');
    await m.c.selectSpace('other');
    await until(m, () => countText(m) === '2', 'the other space\'s count');
    // The section of the space just left answers late: the tab stays on the space it shows.
    m.c.links.seen({ space: 'work', open: 6 });
    m.fixture.detectChanges();
    expect(countText(m)).toBe('2');
  });

  it('reads the count again when the settings pop-up closes: a conversion may have run in it', async () => {
    const served: Served = { work: 7 };
    const m = mount({ served });
    m.c.openSpaceSettings();
    m.fixture.detectChanges();
    served['work'] = 3;
    m.c.spaceSettings.closeSettings();
    await until(m, () => countText(m) === '3', 'the count read after the pop-up closed');
  });
});

describe('the Overview pencil lands on the type (S12, Q-747: the fifth drive saw the Schema tab at its top)', () => {
  afterEach(() => { document.body.innerHTML = ''; });

  it('opens the settings with the type\'s head scrolled into view and focus on its name control; closing gives focus back to the pencil', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      const m = mount();
      document.body.appendChild(m.el);
      const pen = m.pen('person')!;
      (pen as unknown as HTMLElement).focus();
      expect(document.activeElement, 'the pencil holds focus before the press').toBe(pen);
      pen.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      await until(m, () => !!m.el.querySelector('.sch-detail-head app-schema-type-name'), 'the type head in the pop-up');
      const head = m.el.querySelector<HTMLElement>('.sch-detail-head')!;
      expect(head.textContent).toContain('person');
      await vi.waitFor(() => {
        m.fixture.detectChanges();
        expect(scrolled, 'the type head is the element scrolled to').toContain(head);
        expect(document.activeElement, 'focus is on the type\'s name control').toBe(head.querySelector('app-schema-type-name button'));
      }, { timeout: 2_000, interval: 20 });
      m.c.spaceSettings.closeSettings();
      m.fixture.detectChanges();
      await vi.waitFor(() => expect(document.activeElement, 'focus is back on the pencil').toBe(pen), { timeout: 2_000, interval: 20 });
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });

  it('the cog, which opens the settings on their first tab, moves neither scroll nor focus to a type', async () => {
    const scrolled: Element[] = [];
    const original = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) { scrolled.push(this); };
    try {
      const m = mount();
      document.body.appendChild(m.el);
      m.c.openSpaceSettings();
      await until(m, () => !!m.el.querySelector('.sp-panel'), 'the pop-up');
      // The person then goes to the Schema tab and picks the type themselves: the pane stays where they put it.
      m.c.spaceSettings.settingsTab.set('schema');
      m.c.spaceSettings.selectType('entity', 'person');
      await until(m, () => !!m.el.querySelector('.sch-detail-head app-schema-type-name'), 'the type head in the pop-up');
      expect(scrolled).toEqual([]);
    } finally {
      Element.prototype.scrollIntoView = original;
    }
  });
});
