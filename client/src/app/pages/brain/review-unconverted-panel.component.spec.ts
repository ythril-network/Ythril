/**
 * The Review "Unconverted" panel as the green-lit drawing draws it (bundle-285, Q-939, plan section 5 rows V2 to V17; moments 5 and 5b): the intro,
 * the filters, the class switch with its counts, the cards, the dismiss controls, the pager, and the states around them.
 *
 * Mounted over the real `ReviewUnconvertedState` with `ConversionApi` stubbed, so what is read is what a person reads and what is clicked is a
 * button. The rules a panel with a plausible shape drops:
 *
 *  - a record's name leads the card and its id is the LAST line of the record box: an id first turns a list of people into a list of hashes;
 *  - a record's name, a violation and a field are bound as TEXT: they are written by whoever wrote the record;
 *  - "nothing is unconverted", "nothing matches these filters", "we could not look" and "your token may not look" are four different screens;
 *  - the dismiss controls and Convert again are LOCKED with their reason, never silently gone, for a caller without the right.
 *
 * ## Seen red
 *
 * Red on the unchanged base (bundle-285 with S1 to S3): `review-unconverted-panel.component.ts` does not exist, so the file fails to load:
 * "Failed to resolve import "./review-unconverted-panel.component"".
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { NEVER, of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import {
  convertingRights, listAnswer, okResult, openGroup, refused, rightsWith, runningStatus, unconvertedProviders, unconvertedRow, unconvertedWords,
  type ConversionApiStub, type UnconvertedHarnessOptions,
} from '../../testing/review-unconverted-fixtures';
import type { UnconvertedRow } from '../../core/conversion.types';
import { ReviewUnconvertedPanelComponent } from './review-unconverted-panel.component';
import { ReviewUnconvertedState } from './review-unconverted-state';

/** The drawing's typical space: one type, three records that do not fit and one whose steps were refused. */
const TYPICAL = [openGroup('person', 'not_conforming', 3), openGroup('person', 'step_refused', 1)];
const typicalRows = (): UnconvertedRow[] => [
  unconvertedRow(1, { record: { summary: 'Dana Whitfield' } }),
  unconvertedRow(2, { record: { summary: 'Tomas Herrera' }, violations: [{ field: 'properties.status', reason: 'not an allowed value' }, { field: 'properties.email', reason: 'does not match the pattern' }] }),
  unconvertedRow(3, { record: { summary: 'Priya Natarajan' } }),
  unconvertedRow(4, { reason: 'step_refused', violations: [], record: { summary: 'Segment of ticket TCK-21077' } }),
];
/** The list as the server answers it: the rows of the reasons asked for (all when none), and the groups of the whole space whatever is asked. */
const typical = () => vi.fn((_space: string, query: { reasons?: string[] } = {}) => {
  const rows = typicalRows().filter(r => !query.reasons || query.reasons.includes(r.reason));
  return of(okResult(listAnswer(rows, TYPICAL, { total: rows.length })));
});

/** Let the promises a click starts (the confirm, the request after it) run: the stubs answer at once, but through promises. */
const settle = (): Promise<void> => new Promise(resolve => setTimeout(resolve, 0));

function mount(over: Partial<ConversionApiStub> = {}, opts: UnconvertedHarnessOptions = {}, setupState?: (s: ReviewUnconvertedState) => void) {
  const h = unconvertedProviders(over, opts);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ReviewUnconvertedPanelComponent, getTranslocoModule({ translation: { en: unconvertedWords() } })],
    providers: [ReviewUnconvertedState, ...h.providers],
  });
  const state = TestBed.inject(ReviewUnconvertedState);
  state.open('customers');
  setupState?.(state);
  const f = TestBed.createComponent(ReviewUnconvertedPanelComponent);
  f.componentRef.setInput('spaceId', 'customers');
  f.componentRef.setInput('state', state);
  f.detectChanges();
  const el = f.nativeElement as HTMLElement;
  const button = (re: RegExp): HTMLButtonElement | undefined => [...el.querySelectorAll('button')].find(b => re.test(b.textContent ?? '') || re.test(b.getAttribute('aria-label') ?? ''));
  const click = (re: RegExp) => { button(re)!.click(); f.detectChanges(); };
  const radio = (re: RegExp) => [...el.querySelectorAll<HTMLElement>('[role="radio"]')].find(r => re.test(r.textContent ?? ''));
  const cards = () => [...el.querySelectorAll<HTMLElement>('[data-testid="unconverted-card"]')];
  return { f, el, state, h, button, click, radio, cards };
}

describe('the Unconverted panel: the screens that are not a list', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('says it is loading while the first answer is on its way, and draws no list', () => {
    const { el } = mount({ listUnconverted: vi.fn(() => NEVER) });
    expect(el.querySelector('.loading-overlay')).not.toBeNull();
    expect(el.querySelector('[data-testid="unconverted-card"]')).toBeNull();
  });

  it('a failed load is an error with a retry, never "no unconverted records"', () => {
    const list = vi.fn(() => of(refused({ kind: 'other', status: 500, error: 'the store is down' })));
    const { el, f } = mount({ listUnconverted: list });
    expect(el.querySelector('[role="alert"]')?.textContent).toContain('the store is down');
    expect(el.textContent).not.toContain('No unconverted records');
    (el.querySelector('app-error-state button') as HTMLButtonElement).click();
    f.detectChanges();
    expect(list).toHaveBeenCalledTimes(2);
  });

  it('a caller who may not read the records is told so, and is not shown an error or an empty list', () => {
    const { el } = mount({ listUnconverted: vi.fn(() => of(refused({ kind: 'no_right', code: 'unconverted_rung', error: 'x' }))) });
    expect(el.textContent).toContain("Your token cannot read this space's records.");
    expect(el.textContent).not.toContain('No unconverted records');
    expect(el.querySelector('app-error-state')).toBeNull();
  });

  it('a space with nothing unconverted says so, and what makes a record appear (the empty screen of the drawing)', () => {
    const { el } = mount();
    expect(el.textContent).toContain('No unconverted records');
    expect(el.textContent).toContain('When a schema change cannot convert a record by itself');
    expect(el.querySelector('[data-empty="overall"]')).not.toBeNull();
  });

  it('a filter that matches nothing in a space that has records is a different sentence from "no unconverted records"', () => {
    const rows = typicalRows();
    const list = vi.fn((_s: string, q: { reasons?: string[] }) => of(okResult(listAnswer(q.reasons ? [] : rows, TYPICAL, { total: q.reasons ? 0 : rows.length }))));
    const { el, radio, f } = mount({ listUnconverted: list });
    radio(/Steps refused/)!.click();
    f.detectChanges();
    expect(el.querySelector('[data-empty="filter"]')).not.toBeNull();
    expect(el.querySelector('[data-empty="overall"]')).toBeNull();
    expect(el.textContent).not.toContain('No unconverted records');
  });

  it('the intro is there, once, whatever the list holds', () => {
    const { el } = mount({ listUnconverted: typical() });
    expect(el.textContent).toContain('Converting updates records to follow a changed schema.');
  });
});

describe('the Unconverted panel: a card', () => {
  it('names the record first and its short id last, with the reason, the why, the properties that do not fit and what to do', () => {
    const { cards } = mount({ listUnconverted: typical() });
    expect(cards().length).toBe(4);
    const first = cards()[0]!;
    expect(first.querySelector('.dup-type')?.textContent).toBe('person');
    expect(first.querySelector('.badge')?.textContent).toContain('Does not fit the new schema');
    expect(first.textContent).toMatch(/found /);
    expect(first.querySelector('.dup-rec-l')?.textContent?.trim().toLowerCase()).toBe('entity');
    const box = first.querySelector('.dup-rec')!;
    expect(box.querySelector('strong')?.textContent).toBe('Dana Whitfield');
    // the id is the last thing in the record box, and it is the first eight characters of the record's id
    expect(box.lastElementChild?.textContent?.trim()).toBe('7f3a91c2');
    expect(box.textContent!.indexOf('Dana Whitfield')).toBeLessThan(box.textContent!.indexOf('7f3a91c2'));
    expect(first.textContent).toContain('After the change this record would break the schema, so it was left as it is.');
    expect(first.querySelector('ul[aria-label="Properties that do not fit"]')?.textContent).toContain('age: must be a number');
    expect(first.textContent).toContain('To fix it: give the record the properties named below, then use Convert again.');
  });

  it('shows the field of a violation without the `properties.` prefix the server gives it', () => {
    const { cards } = mount({ listUnconverted: typical() });
    const items = [...cards()[1]!.querySelectorAll('ul[aria-label="Properties that do not fit"] li')].map(li => li.textContent?.trim());
    expect(items).toEqual(['status: not an allowed value', 'email: does not match the pattern']);
  });

  it('words each class by its own badge, why and what to do: exists for an edge, refused for the steps', () => {
    const rows = [
      unconvertedRow(5, { kind: 'edge', type: 'employed-by', reason: 'relationship_exists', violations: [], record: { summary: 'Dana employed-by Meridian' } }),
      unconvertedRow(4, { reason: 'step_refused', violations: [], record: { summary: 'Segment' } }),
    ];
    const { cards } = mount({ listUnconverted: vi.fn(() => of(okResult(listAnswer(rows, [openGroup('employed-by', 'relationship_exists', 1, 'edge'), openGroup('person', 'step_refused', 1)])))) });
    const [exists, refusedCard] = cards();
    expect(exists!.querySelector('.badge')?.textContent).toContain('The relationship already exists');
    expect(exists!.textContent).toContain('Renaming the label would give this edge the same start, end and label');
    expect(exists!.textContent).toContain('To fix it: delete one of the two edges');
    expect(exists!.querySelector('.dup-rec-l')?.textContent?.trim().toLowerCase()).toBe('edge');
    expect(refusedCard!.querySelector('.badge')?.textContent).toContain('The steps were refused here');
    expect(refusedCard!.textContent).toContain('This instance refused the steps this record needed');
    expect(refusedCard!.querySelector('ul[aria-label="Properties that do not fit"]')).toBeNull();
  });

  it('a record that is gone says so, in place of a name, and cannot be opened', () => {
    const rows = [unconvertedRow(7, { record: undefined })];
    const { cards } = mount({ listUnconverted: vi.fn(() => of(okResult(listAnswer(rows, [openGroup('person', 'not_conforming', 1)])))) });
    const card = cards()[0]!;
    expect(card.textContent).toContain('The record is gone');
    expect(card.querySelector('strong')).toBeNull();
    const open = [...card.querySelectorAll('button')].find(b => /Open the record/.test(b.textContent ?? ''))!;
    expect(open.disabled).toBe(true);
  });

  it('binds a record\'s name, a field and a reason as text: markup written into a record is shown, never run', () => {
    const rows = [unconvertedRow(1, { record: { summary: '<img src=x onerror="window.__pwned=1">Dana' }, violations: [{ field: 'properties.<b>age</b>', reason: '<script>alert(1)</script>' }] })];
    const { el } = mount({ listUnconverted: vi.fn(() => of(okResult(listAnswer(rows, [openGroup('person', 'not_conforming', 1)])))) });
    expect(el.querySelector('img')).toBeNull();
    expect(el.querySelector('script')).toBeNull();
    expect(el.querySelector('b')).toBeNull();
    expect(el.textContent).toContain('<img src=x onerror="window.__pwned=1">Dana');
    expect(el.textContent).toContain('<b>age</b>: <script>alert(1)</script>');
  });

  it('Open the record opens the record drawer on that record', () => {
    const { click, h, f } = mount({ listUnconverted: typical() });
    click(/Open the record/);
    f.detectChanges();
    expect(h.getRecord).toHaveBeenCalledWith('customers', 'entity', unconvertedRow(1).recordId);
    expect(h.drawerOpen).toHaveBeenCalled();
  });

  it('a dismissed record is marked Dismissed and offers no Dismiss; an open one offers it', () => {
    const answers = (q: { status?: string }) => {
      const rows = q.status === 'dismissed' ? [unconvertedRow(1, { status: 'dismissed' })] : [unconvertedRow(2)];
      return of(okResult(listAnswer(rows, [openGroup('person', 'not_conforming', 1)])));
    };
    const { cards, state, f } = mount({ listUnconverted: vi.fn((_s: string, q: { status?: string }) => answers(q)) });
    const dismissButtons = (card: HTMLElement) => [...card.querySelectorAll('button')].filter(b => b.textContent?.trim() === 'Dismiss');
    expect(dismissButtons(cards()[0]!).length).toBe(1);
    expect(cards()[0]!.textContent).not.toContain('Dismissed');
    state.chooseStatus('dismissed');
    f.detectChanges();
    expect(cards()[0]!.textContent).toContain('Dismissed');
    expect(dismissButtons(cards()[0]!).length).toBe(0);
  });
});

describe('the Unconverted panel: the filters and the class switch', () => {
  it('offers All types and the types that have open items, and Open, Dismissed and All in the words the Duplicates list uses', () => {
    const groups = [openGroup('person', 'not_conforming', 3), openGroup('company', 'not_conforming', 7)];
    const { el } = mount({ listUnconverted: vi.fn(() => of(okResult(listAnswer(typicalRows(), groups)))) });
    const type = el.querySelector<HTMLSelectElement>('select[aria-label="Record type"]')!;
    expect([...type.options].map(o => o.textContent?.trim())).toEqual(['All types', 'company', 'person']);
    const status = el.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
    expect([...status.options].map(o => o.textContent?.trim())).toEqual(['Open', 'Dismissed', 'All']);
  });

  describe('the All list', () => {
    /** The server's All page: open and dismissed records of one type in one newest-first list, total 5 (3 open of the class "does not fit", 1 open refused, 1 dismissed). */
    const everything = () => vi.fn(() => {
      const rows = [unconvertedRow(1), unconvertedRow(2, { status: 'dismissed', record: { summary: 'Tomas Herrera' } }), unconvertedRow(3), unconvertedRow(4), unconvertedRow(5, { reason: 'step_refused', violations: [] })];
      return of(okResult(listAnswer(rows, TYPICAL, { total: 5 })));
    });
    const choose = (el: HTMLElement, f: { detectChanges(): void }) => {
      const status = el.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
      status.value = 'all';
      status.dispatchEvent(new Event('change'));
      f.detectChanges();
    };

    it('asks for status all and lists both kinds in one page, each card saying its own status, Dismiss on the open ones only', () => {
      const { el, f, cards, h } = mount({ listUnconverted: everything() });
      choose(el, f);
      expect(h.api.listUnconverted).toHaveBeenLastCalledWith('customers', expect.objectContaining({ status: 'all' }));
      expect(cards().length).toBe(5);
      const dismissButtons = (c: HTMLElement) => [...c.querySelectorAll('button')].filter(b => b.textContent?.trim() === 'Dismiss').length;
      expect(cards().map(c => c.textContent!.includes('Dismissed'))).toEqual([false, true, false, false, false]);
      expect(cards().map(dismissButtons)).toEqual([1, 0, 1, 1, 1]);
    });

    it('the class switch keeps the counts of open records, as on Open', () => {
      const { el, f } = mount({ listUnconverted: everything() });
      choose(el, f);
      const labels = [...el.querySelectorAll('[role="radiogroup"] [role="radio"]')].map(r => `${r.querySelector('.sg-l')?.textContent} ${r.querySelector('.sg-n')?.textContent}`);
      expect(labels).toEqual(['All 4', 'Does not fit 3', 'Steps refused 1']);
    });

    it('"Dismiss all N shown" says the open records, not the five the list holds, and sends only open', async () => {
      const { el, f, h } = mount({ listUnconverted: everything() });
      choose(el, f);
      expect(el.querySelector('[data-testid="dismiss-all"]')?.textContent).toContain('Dismiss all 4 shown');
      (el.querySelector('[data-testid="dismiss-all"]') as HTMLButtonElement).click();
      await settle();
      expect(h.api.dismissShown).toHaveBeenCalledWith('customers', { kind: 'entity', type: 'person', expect: 4 });
    });

    it('with nothing at all in the space, All shows the overall empty screen, not "no records match"', () => {
      const { el, f } = mount();
      choose(el, f);
      expect(el.querySelector('[data-empty="overall"]')).not.toBeNull();
      expect(el.querySelector('[data-empty="filter"]')).toBeNull();
    });
  });

  it('choosing a type or a status asks the server for it', () => {
    const groups = [openGroup('person', 'not_conforming', 3), openGroup('company', 'not_conforming', 7)];
    const list = vi.fn(() => of(okResult(listAnswer(typicalRows(), groups))));
    const { el, f } = mount({ listUnconverted: list });
    const type = el.querySelector<HTMLSelectElement>('select[aria-label="Record type"]')!;
    type.value = [...type.options].find(o => o.textContent?.trim() === 'person')!.value;
    type.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(list).toHaveBeenLastCalledWith('customers', { kind: 'entity', type: 'person', status: 'open', skip: 0, limit: 25 });
    const status = el.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
    status.value = 'dismissed';
    status.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(list).toHaveBeenLastCalledWith('customers', { kind: 'entity', type: 'person', status: 'dismissed', skip: 0, limit: 25 });
  });

  it('the switch is All and each class that has open items, with its count from the whole space, as one radio group', () => {
    const { el, radio } = mount({ listUnconverted: typical() });
    const group = el.querySelector('[role="radiogroup"]')!;
    expect(group.getAttribute('aria-label')).toBe('Why the records could not be converted');
    const labels = [...group.querySelectorAll('[role="radio"]')].map(r => `${r.querySelector('.sg-l')?.textContent} ${r.querySelector('.sg-n')?.textContent}`);
    // "Already exists" holds nothing open, so it has no pill: a choice that can only ever be empty is noise
    expect(labels).toEqual(['All 4', 'Does not fit 3', 'Steps refused 1']);
    expect(radio(/All/)!.getAttribute('aria-checked')).toBe('true');
  });

  it('on the Dismissed list the switch offers every class and shows no counts, because the counts are of open records', () => {
    const { el, state, f } = mount({ listUnconverted: typical() });
    state.chooseStatus('dismissed');
    f.detectChanges();
    const radios = [...el.querySelectorAll('[role="radiogroup"] [role="radio"]')];
    expect(radios.map(r => r.querySelector('.sg-l')?.textContent)).toEqual(['All', 'Does not fit', 'Already exists', 'Steps refused']);
    expect(el.querySelector('[role="radiogroup"] .sg-n')).toBeNull();
  });

  it('the chosen class stays on the switch when its count falls to nothing, so the filter that narrows the list is never hidden', () => {
    const answers = [okResult(listAnswer(typicalRows(), TYPICAL)), okResult(listAnswer([], [openGroup('person', 'not_conforming', 3)], { total: 0 }))];
    const { radio, f } = mount({ listUnconverted: vi.fn(() => of(answers.shift() ?? answers[0]!)) });
    radio(/Steps refused/)!.click();
    f.detectChanges();
    expect(radio(/Steps refused/)).toBeDefined();
    expect(radio(/Steps refused/)!.getAttribute('aria-checked')).toBe('true');
  });

  it('the arrow keys move along the switch and choose, with one tab stop (a roving radio group)', () => {
    const { radio, f, h } = mount({ listUnconverted: typical() });
    expect(radio(/All/)!.getAttribute('tabindex')).toBe('0');
    expect(radio(/Does not fit/)!.getAttribute('tabindex')).toBe('-1');
    radio(/All/)!.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
    f.detectChanges();
    expect(radio(/Does not fit/)!.getAttribute('aria-checked')).toBe('true');
    expect(h.api.listUnconverted).toHaveBeenLastCalledWith('customers', expect.objectContaining({ reasons: expect.any(Array) }));
  });

  it('says when the counts are incomplete (openByCut), in words', () => {
    const answer = listAnswer(typicalRows(), TYPICAL, { counts: { open: 9000, dismissed: 0, openBy: TYPICAL, openByCut: true } });
    const { el } = mount({ listUnconverted: vi.fn(() => of(okResult(answer))) });
    expect(el.querySelector('[data-testid="counts-cut"]')?.textContent).toContain('The counts are incomplete');
  });

  it('on a phone the filters fold behind one line that says what they are set to, and the actions stay outside it', () => {
    const matches = (q: string) => ({ matches: true, media: q, addEventListener: () => {}, removeEventListener: () => {} });
    vi.stubGlobal('matchMedia', matches);
    try {
      const { el } = mount({ listUnconverted: typical() });
      const details = el.querySelector('details.filters-d')!;
      expect(details).not.toBeNull();
      expect(details.querySelector('summary')?.textContent).toContain('Filters: All, person, Open');
      expect(details.querySelector('select[aria-label="Record type"]')).not.toBeNull();
      expect(details.querySelector('[data-testid="dismiss-all"]')).toBeNull();
      expect(el.querySelector('[data-testid="dismiss-all"]')).not.toBeNull();
    } finally { vi.unstubAllGlobals(); }
  });

  it('on a wide screen the filters are not folded', () => {
    const { el } = mount({ listUnconverted: typical() });
    expect(el.querySelector('details.filters-d')).toBeNull();
    expect(el.querySelector('select[aria-label="Record type"]')).not.toBeNull();
  });
});

describe('the Unconverted panel: Dismiss all N shown, Dismiss and Convert again', () => {
  it('says how many it would dismiss, and sends it through the confirm of the drawing (5b)', async () => {
    const { button, h } = mount({ listUnconverted: typical() });
    expect(button(/Dismiss all 4 shown/)).toBeDefined();
    button(/Dismiss all 4 shown/)!.click();
    await settle();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    const asked = h.confirm.mock.calls[0]![0];
    expect(asked.title).toBe('Dismiss 4 records?');
    expect(asked.message).toContain('This takes the 4 open records of person off the list.');
    expect(h.api.dismissShown).toHaveBeenCalledWith('customers', { kind: 'entity', type: 'person', expect: 4 });
  });

  it('is not offered on the Dismissed list, and says N from the class chosen', () => {
    const { button, radio, el, f } = mount({ listUnconverted: typical() });
    radio(/Does not fit/)!.click();
    f.detectChanges();
    expect(el.querySelector('[data-testid="dismiss-all"]')?.textContent).toContain('Dismiss all 3 shown');
    const status = el.querySelector<HTMLSelectElement>('select[aria-label="Filter by status"]')!;
    status.value = 'dismissed';
    status.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(button(/Dismiss all/)).toBeUndefined();
  });

  it('Convert again is disabled with its reason while no type is chosen, and of the chosen type once one is', () => {
    const groups = [openGroup('person', 'not_conforming', 3), openGroup('company', 'not_conforming', 7)];
    const { el, f, h } = mount({ listUnconverted: vi.fn(() => of(okResult(listAnswer(typicalRows(), groups)))) });
    const again = () => el.querySelector<HTMLButtonElement>('[data-testid="convert-again"]')!;
    expect(again().disabled).toBe(true);
    expect(again().getAttribute('title')).toBe('Choose a record type to convert again');
    const type = el.querySelector<HTMLSelectElement>('select[aria-label="Record type"]')!;
    type.value = [...type.options].find(o => o.textContent?.trim() === 'person')!.value;
    type.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(again().disabled).toBe(false);
    expect(again().getAttribute('title')).toContain('Tries every open record of the chosen type again');
    again().click();
    expect(h.api.start).toHaveBeenCalledWith('customers', [{ kind: 'entity', type: 'person' }]);
  });

  it('with All types chosen, says on the page why Convert again waits, names the button by it, and drops it once a type is chosen (drive 5)', () => {
    const groups = [openGroup('person', 'not_conforming', 3), openGroup('company', 'not_conforming', 7)];
    const { el, f } = mount({ listUnconverted: vi.fn(() => of(okResult(listAnswer(typicalRows(), groups)))) }, { rights: convertingRights() });
    const again = () => el.querySelector<HTMLButtonElement>('[data-testid="convert-again"]')!;
    const pick = () => el.querySelector<HTMLElement>('[data-testid="convert-pick"]');
    expect(again().disabled).toBe(true);
    expect(pick()?.textContent?.trim(), 'a disabled button\'s tooltip is not shown on a touch screen, and not to every pointer').toBe('Choose a record type to convert again');
    expect(again().getAttribute('aria-describedby')).toBe(pick()!.id);
    const type = el.querySelector<HTMLSelectElement>('select[aria-label="Record type"]')!;
    type.value = [...type.options].find(o => o.textContent?.trim() === 'person')!.value;
    type.dispatchEvent(new Event('change'));
    f.detectChanges();
    expect(pick()).toBeNull();
    expect(again().getAttribute('aria-describedby')).toBeNull();
  });

  it('without the right to convert, Convert again is locked and the reason is on the page, not only in a tooltip', () => {
    const { el } = mount({ listUnconverted: typical() }, { rights: rightsWith('write') });
    const again = el.querySelector<HTMLButtonElement>('[data-testid="convert-again"]')!;
    expect(again.disabled).toBe(true);
    const reason = el.querySelector('[data-testid="convert-locked"]')!;
    expect(reason.textContent).toContain('needs the admin right of this space');
    expect(again.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('with the right to convert there is no lock line', () => {
    const { el } = mount({ listUnconverted: typical() }, { rights: convertingRights() });
    expect(el.querySelector('[data-testid="convert-locked"]')).toBeNull();
  });

  it('without the write right, Dismiss and Dismiss all are locked with the reason, and nothing is asked of the server', async () => {
    const { el, h, cards } = mount({ listUnconverted: typical() }, { rights: rightsWith('read') });
    const dismiss = [...cards()[0]!.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Dismiss')!;
    expect(dismiss.disabled).toBe(true);
    expect(el.querySelector<HTMLButtonElement>('[data-testid="dismiss-all"]')!.disabled).toBe(true);
    const reason = el.querySelector('[data-testid="dismiss-locked"]')!;
    expect(reason.textContent).toContain("Dismissing needs the write right on this space's records.");
    expect(dismiss.getAttribute('aria-describedby')).toBe(reason.id);
    dismiss.click();
    await settle();
    expect(h.confirm).not.toHaveBeenCalled();
  });

  it('Dismiss on a card asks first and then dismisses that item', async () => {
    const { cards, h } = mount({ listUnconverted: typical() });
    [...cards()[2]!.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Dismiss')!.click();
    await settle();
    expect(h.confirm).toHaveBeenCalledTimes(1);
    expect(h.api.dismissOne).toHaveBeenCalledWith('customers', 'item-3');
  });

  it('a refusal stays on screen until it is dismissed, and offers the reload', async () => {
    const { el, f, cards, h } = mount({ listUnconverted: typical(), dismissOne: vi.fn(() => of(refused({ kind: 'item_gone' }))) });
    [...cards()[0]!.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Dismiss')!.click();
    await settle();
    f.detectChanges();
    const alert = el.querySelector('.refusal[role="alert"]')!;
    expect(alert.textContent).toContain('This record is no longer listed. The list was reloaded.');
    const lists = h.api.listUnconverted.mock.calls.length;
    (alert.querySelector('.refusal-close') as HTMLButtonElement).click();
    f.detectChanges();
    expect(el.querySelector('.refusal')).toBeNull();
    expect(h.api.listUnconverted.mock.calls.length).toBe(lists);
  });
});

describe('the Unconverted panel: a run that is going, and the pager', () => {
  beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  afterEach(() => vi.useRealTimers());

  it('says that a conversion is still running and how far it is, in the drawing\'s sentence', () => {
    const { el } = mount({ listUnconverted: typical(), status: vi.fn(() => of(okResult(runningStatus()))) });
    expect(el.querySelector('[role="status"]')?.textContent).toContain('The conversion of person is still running: 184 of 1,000 records checked. This list grows as it goes.');
  });

  it('says nothing about a run when none is going', () => {
    const { el } = mount({ listUnconverted: typical() });
    expect(el.textContent).not.toContain('is still running');
  });

  it('pages by the server: Prev is off on the first page, Next reads the next, and the range says of how many', () => {
    const rows = Array.from({ length: 25 }, (_, i) => unconvertedRow(i + 1));
    const list = vi.fn(() => of(okResult(listAnswer(rows, [openGroup('person', 'not_conforming', 1046)], { total: 1046 }))));
    const { el, button, click, f } = mount({ listUnconverted: list });
    expect(el.querySelector('.pagination')).not.toBeNull();
    expect(button(/Prev/)!.disabled).toBe(true);
    expect(el.querySelector('.pager-info')?.textContent).toContain('1–25 of 1,046');
    click(/Next/);
    f.detectChanges();
    expect(list).toHaveBeenLastCalledWith('customers', { kind: 'entity', type: 'person', status: 'open', skip: 25, limit: 25 });
  });

  it('shows no pager for a list that fits one page', () => {
    const { el } = mount({ listUnconverted: typical() });
    expect(el.querySelector('.pagination')).toBeNull();
  });
});
