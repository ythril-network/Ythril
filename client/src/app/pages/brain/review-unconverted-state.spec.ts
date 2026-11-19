/**
 * The Review "Unconverted" section's state (bundle-285, Q-939, plan sections 3.1 item 9, 6, 7 and 9): which records a conversion left, the counts of
 * the class switch, the filters, the pages, and what a dismiss or a Convert again does and says.
 *
 * Driven through the real `ReviewUnconvertedState` with `ConversionApi` stubbed at its calls, so each spec names what the state ASKS (the query,
 * the reasons of a class, `expect`) and what it SAYS after the answer, never how it is wired. The rules that a state with a plausible shape drops:
 *
 *  - the class counts and the type choices are the server's `counts.openBy` over the whole space, never a count of the page shown;
 *  - a class pill asks for the class's reasons as a LIST (a class is several reasons), and "Dismiss all N shown" sends the same list and `expect` N;
 *  - a 409 (the set moved) reloads and asks again with the new number: nothing is dismissed that the reader was not shown;
 *  - a caller without the write right cannot dismiss and without the convert price cannot Convert again, and the server is never asked;
 *  - the newest answer wins, a failed load is not an empty list, and a refusal stays until it is dismissed.
 *
 * ## Seen red
 *
 * Red on the unchanged base (bundle-285 with S1 to S3): `review-unconverted-state.ts` does not exist, so the file fails to load:
 * "Failed to resolve import "./review-unconverted-state"".
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { Subject, of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import {
  convertingRights, listAnswer, okResult, openGroup, refused, rightsWith, runningStatus, unconvertedProviders, unconvertedRow, unconvertedWords,
  type ConversionApiStub, type UnconvertedHarnessOptions,
} from '../../testing/review-unconverted-fixtures';
import type { ConversionResult, UnconvertedListAnswer } from '../../core/conversion.types';
import { reasonsOfClass } from '../../core/unconverted-reasons';
import { ReviewUnconvertedState } from './review-unconverted-state';

/** The groups of a space with one type: 982 do not fit, 41 exist, 23 were refused (the drawing's overfull numbers). */
const OVERFULL = [openGroup('segment', 'not_conforming', 900), openGroup('segment', 'fork', 82), openGroup('segment', 'relationship_exists', 41, 'edge'), openGroup('segment', 'step_refused', 23)];

type Stub = ConversionApiStub;

function setup(over: Partial<Stub> = {}, opts: UnconvertedHarnessOptions = {}) {
  const h = unconvertedProviders(over, opts);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [getTranslocoModule({ translation: { en: unconvertedWords() } })],
    providers: [ReviewUnconvertedState, ...h.providers],
  });
  const state = TestBed.inject(ReviewUnconvertedState);
  return { state, api: h.api, confirm: h.confirm, getRecord: h.getRecord, drawerOpen: h.drawerOpen };
}

/** The answer a list call gives for a page of `n` rows of the overfull space. */
const page = (n: number, over: Partial<UnconvertedListAnswer> = {}) => okResult(listAnswer(Array.from({ length: n }, (_, i) => unconvertedRow(i + 1)), OVERFULL, { total: 982 + 41 + 23, ...over }));

describe('the Unconverted section: what it lists and counts', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('opens on the first page of the open items, 25 to a page, and says it is loaded', () => {
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(page(3))) });
    expect(state.loaded()).toBe(false);
    state.open('customers');
    expect(api.listUnconverted).toHaveBeenCalledWith('customers', { status: 'open', skip: 0, limit: 25 });
    expect(state.rows().length).toBe(3);
    expect(state.loaded()).toBe(true);
    expect(state.loading()).toBe(false);
  });

  it('the class counts and the badge are the server\'s counts.openBy over the whole space, never the page shown', () => {
    // Three rows are on screen; the space holds 1,046. A count of the page would say 3.
    const { state } = setup({ listUnconverted: vi.fn(() => of(page(3))) });
    state.open('customers');
    expect(state.classCounts()).toEqual({ fit: 982, exists: 41, refused: 23 });
    expect(state.openAll()).toBe(1046);
    expect(state.badge()).toBe(1046);
  });

  it('a class pill asks for the reasons of the class as a list, not for one reason', () => {
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(page(3))) });
    state.open('customers');
    state.chooseClass('fit');
    expect(api.listUnconverted).toHaveBeenLastCalledWith('customers', { reasons: [...reasonsOfClass('fit')], status: 'open', skip: 0, limit: 25 });
    expect(reasonsOfClass('fit').length).toBeGreaterThan(1);
    state.chooseClass('all');
    expect(api.listUnconverted).toHaveBeenLastCalledWith('customers', { status: 'open', skip: 0, limit: 25 });
  });

  it('a record type is asked for by kind and name, and the class counts follow it', () => {
    const groups = [openGroup('person', 'not_conforming', 3), openGroup('person', 'step_refused', 1), openGroup('company', 'not_conforming', 7)];
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(okResult(listAnswer([unconvertedRow(1)], groups, { total: 11 })))) });
    state.open('customers');
    expect(state.classCounts()).toEqual({ fit: 10, exists: 0, refused: 1 });
    state.chooseType({ kind: 'entity', type: 'person' });
    expect(api.listUnconverted).toHaveBeenLastCalledWith('customers', { kind: 'entity', type: 'person', status: 'open', skip: 0, limit: 25 });
    expect(state.classCounts()).toEqual({ fit: 3, exists: 0, refused: 1 });
  });

  it('the type is preselected when exactly one type has open items, without a second read, and left alone when two do', () => {
    const two = setup({ listUnconverted: vi.fn(() => of(page(3))) });
    two.state.open('customers');
    // the overfull fixture holds an entity type and an edge type under the same name: two types
    expect(two.state.typeChoice()).toBeNull();

    const sole = setup({ listUnconverted: vi.fn(() => of(okResult(listAnswer([unconvertedRow(1)], [openGroup('person', 'not_conforming', 4)])))) });
    sole.state.open('customers');
    expect(sole.state.typeChoice()).toEqual({ kind: 'entity', type: 'person' });
    expect(sole.api.listUnconverted).toHaveBeenCalledTimes(1);
  });

  it('a chosen type stays a choice after its last open item goes, so the filter is never hidden while it narrows the list', () => {
    const answers = [
      okResult(listAnswer([unconvertedRow(1)], [openGroup('person', 'not_conforming', 1), openGroup('company', 'not_conforming', 2)])),
      okResult(listAnswer([], [openGroup('company', 'not_conforming', 2)])),
    ];
    const { state } = setup({ listUnconverted: vi.fn(() => of(answers.shift() ?? answers[0]!)) });
    state.open('customers');
    state.chooseType({ kind: 'entity', type: 'person' });
    expect(state.typeOptions().map(t => t.type)).toEqual(['company', 'person']);
  });

  it('the pager asks the server for the next page by skip and shows the server\'s total, never a slice of a longer list', () => {
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(page(25))) });
    state.open('customers');
    expect(state.hasPrevious()).toBe(false);
    expect(state.hasNext()).toBe(true);
    state.goTo(25);
    expect(api.listUnconverted).toHaveBeenLastCalledWith('customers', { status: 'open', skip: 25, limit: 25 });
    expect(state.rows().length).toBe(25);
    expect(state.hasPrevious()).toBe(true);
    expect(state.pagerText()).toContain('1,046');
  });

  it('a page past the end (the last record of the last page was just dismissed) steps back instead of showing an empty list', () => {
    const answers: ConversionResult<UnconvertedListAnswer>[] = [page(25), page(0, { skip: 1000 }), page(25)];
    const list = vi.fn(() => of(answers.shift()!));
    const { state } = setup({ listUnconverted: list });
    state.open('customers');
    state.goTo(1000);
    expect(list).toHaveBeenLastCalledWith('customers', { status: 'open', skip: 975, limit: 25 });
    expect(state.skip()).toBe(975);
  });

  it('counts that are cut say so: openByCut is read from the answer', () => {
    const { state } = setup({ listUnconverted: vi.fn(() => of(okResult(listAnswer([unconvertedRow(1)], [openGroup('person', 'fork', 1)], { counts: { open: 9000, dismissed: 0, openBy: [openGroup('person', 'fork', 1)], openByCut: true } })))) });
    state.open('customers');
    expect(state.countsCut()).toBe(true);
    expect(state.badge()).toBe(9000);
  });

  it('only the newest answer is kept: a slow answer for a filter the reader has left never replaces the rows on screen', () => {
    const first = new Subject<ConversionResult<UnconvertedListAnswer>>();
    const second = new Subject<ConversionResult<UnconvertedListAnswer>>();
    const queue = [first, second];
    const { state } = setup({ listUnconverted: vi.fn(() => queue.shift()!) });
    state.open('customers');
    state.chooseClass('exists');
    second.next(okResult(listAnswer([unconvertedRow(2, { reason: 'relationship_exists' })], OVERFULL, { total: 1 })));
    first.next(okResult(listAnswer([unconvertedRow(1), unconvertedRow(3)], OVERFULL, { total: 2 })));
    expect(state.rows().map(r => r.itemId)).toEqual(['item-2']);
  });
});

describe('the Unconverted section: when it cannot answer', () => {
  it('a failed load is an error, never an empty list, and keeps the sentence the server gave', () => {
    const { state } = setup({ listUnconverted: vi.fn(() => of(refused({ kind: 'other', status: 500, error: 'the store is down' }))) });
    state.open('customers');
    expect(state.loadError()).toBe('the store is down');
    expect(state.denied()).toBe(false);
    expect(state.loading()).toBe(false);
  });

  it('a caller who may not read the records is told so, in the rung sentence, and not that the list failed', () => {
    const { state } = setup({ listUnconverted: vi.fn(() => of(refused({ kind: 'no_right', code: 'unconverted_rung', error: 'needs read' }))) });
    state.open('customers');
    expect(state.denied()).toBe(true);
    expect(state.loadError()).toBeNull();
  });

  it('a reload of a failed list asks again', () => {
    const answers = [refused({ kind: 'other', status: 500, error: 'x' }), page(1)];
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(answers.shift()!)) });
    state.open('customers');
    state.reload();
    expect(api.listUnconverted).toHaveBeenCalledTimes(2);
    expect(state.loadError()).toBeNull();
    expect(state.rows().length).toBe(1);
  });
});

describe('the Unconverted section: dismissing one record', () => {
  it('asks first, then dismisses that item and reads the page again, so what is shown is what is stored', async () => {
    const { state, api, confirm } = setup({ listUnconverted: vi.fn(() => of(page(2))) });
    state.open('customers');
    await state.dismissOne(state.rows()[0]!);
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.dismissOne).toHaveBeenCalledWith('customers', 'item-1');
    expect(api.listUnconverted).toHaveBeenCalledTimes(2);
  });

  it('dismisses nothing when the question is declined', async () => {
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(page(2))) }, { confirm: () => false });
    state.open('customers');
    await state.dismissOne(state.rows()[0]!);
    expect(api.dismissOne).not.toHaveBeenCalled();
  });

  it('a record that is no longer listed says so, reloads, and the sentence stays until it is dismissed', async () => {
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(page(2))), dismissOne: vi.fn(() => of(refused({ kind: 'item_gone' }))) });
    state.open('customers');
    await state.dismissOne(state.rows()[0]!);
    expect(state.refusal()).toBe('This record is no longer listed. The list was reloaded.');
    expect(api.listUnconverted).toHaveBeenCalledTimes(2);
    state.dismissRefusal();
    expect(state.refusal()).toBe('');
  });
});

describe('the Unconverted section: Dismiss all N shown', () => {
  /** Choose the class "does not fit" of the one type `person`, as a reader does, over a space holding 3 such records. */
  function chosen(extra: Partial<Stub> = {}, opts: Parameters<typeof setup>[1] = {}) {
    const groups = [openGroup('person', 'not_conforming', 3), openGroup('company', 'not_conforming', 7)];
    const list = vi.fn((_space: string, q: { type?: string }) => of(okResult(listAnswer([unconvertedRow(1), unconvertedRow(2), unconvertedRow(3)], groups, { total: q.type ? 3 : 10 }))));
    const s = setup({ listUnconverted: list, ...extra }, opts);
    s.state.open('customers');
    s.state.chooseType({ kind: 'entity', type: 'person' });
    s.state.chooseClass('fit');
    return s;
  }

  it('sends the shown filter, the reasons of the class as a list, and expect N: the number the reader was shown', async () => {
    const { state, api, confirm } = chosen();
    expect(state.dismissCount()).toBe(3);
    await state.dismissShown();
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(confirm.mock.calls[0]![0].message).toContain('person');
    expect(api.dismissShown).toHaveBeenCalledTimes(1);
    expect(api.dismissShown).toHaveBeenCalledWith('customers', { kind: 'entity', type: 'person', reasons: [...reasonsOfClass('fit')], expect: 3 });
    // the page is read again after it
    expect(api.listUnconverted.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it('sends nothing when the confirm is declined', async () => {
    const { state, api } = chosen({}, { confirm: () => false });
    await state.dismissShown();
    expect(api.dismissShown).not.toHaveBeenCalled();
  });

  it('a count that moved (409) reloads and asks again with the new number, and dismisses that number only once the reader says yes', async () => {
    const answers = [refused<{ dismissed: number }>({ kind: 'changed', current: 2 }), okResult({ dismissed: 2 })];
    const { state, api, confirm } = chosen({ dismissShown: vi.fn(() => of(answers.shift()!)) });
    const callsBefore = api.listUnconverted.mock.calls.length;
    await state.dismissShown();
    expect(api.listUnconverted.mock.calls.length).toBeGreaterThan(callsBefore);
    expect(confirm).toHaveBeenCalledTimes(2);
    expect(confirm.mock.calls[1]![0].message).toContain('2');
    expect(api.dismissShown.mock.calls.map(c => (c[1] as { expect: number }).expect)).toEqual([3, 2]);
  });

  it('a count that moved is never dismissed silently: declined the second time, only the first request was made', async () => {
    const confirms = [true, false];
    const { state, api } = chosen({ dismissShown: vi.fn(() => of(refused({ kind: 'changed', current: 2 }))) }, { confirm: () => confirms.shift() ?? false });
    await state.dismissShown();
    expect(api.dismissShown).toHaveBeenCalledTimes(1);
  });

  it('too many to dismiss at once says so with the bound, and asks nothing more', async () => {
    const { state, api, confirm } = chosen({ dismissShown: vi.fn(() => of(refused({ kind: 'too_many', max: 2000 }))) });
    await state.dismissShown();
    expect(state.refusal()).toContain('2,000');
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(api.dismissShown).toHaveBeenCalledTimes(1);
  });

  it('says N from the list\'s total for the filter on the Open list, and nothing on the Dismissed list (only open records are dismissed)', () => {
    const { state, api } = chosen();
    expect(state.dismissCount()).toBe(3);
    state.chooseStatus('dismissed');
    expect(api.listUnconverted).toHaveBeenLastCalledWith('customers', expect.objectContaining({ status: 'dismissed' }));
    expect(state.dismissCount()).toBeNull();
    state.chooseStatus('open');
    expect(state.dismissCount()).toBe(3);
  });

  it('the Dismissed list carries no class counts and offers every class: the counts are of open records', () => {
    const { state } = chosen();
    expect(state.classCounts()).toEqual({ fit: 3, exists: 0, refused: 0 });
    state.chooseStatus('dismissed');
    expect(state.classCounts()).toBeNull();
  });

  it('with no type and no class chosen, sends no filter at all, only expect', async () => {
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(page(3))) });
    state.open('customers');
    await state.dismissShown();
    expect(api.dismissShown).toHaveBeenCalledWith('customers', { expect: 1046 });
  });
});

describe('the Unconverted section: who may dismiss and who may convert', () => {
  it('a caller with the read rung only cannot dismiss: the controls are locked and the server is never asked', async () => {
    const { state, api, confirm } = setup({ listUnconverted: vi.fn(() => of(page(2))) }, { rights: rightsWith('read') });
    state.open('customers');
    expect(state.canDismiss()).toBe(false);
    await state.dismissOne(state.rows()[0]!);
    await state.dismissShown();
    expect(confirm).not.toHaveBeenCalled();
    expect(api.dismissOne).not.toHaveBeenCalled();
    expect(api.dismissShown).not.toHaveBeenCalled();
  });

  it('the write rung may dismiss; rights that are not known yet count as allowed (the server decides)', () => {
    const write = setup({}, { rights: rightsWith('write') });
    write.state.open('customers');
    expect(write.state.canDismiss()).toBe(true);
    const unknown = setup({}, { rights: null });
    unknown.state.open('customers');
    expect(unknown.state.canDismiss()).toBe(true);
    expect(unknown.state.canConvert()).toBe(true);
  });

  it('Convert again needs the conversion price: knowledge admin alone is not enough, space administration with it is', () => {
    const lowly = setup({}, { rights: rightsWith('admin') });
    lowly.state.open('customers');
    expect(lowly.state.canConvert()).toBe(false);
    const priced = setup({}, { rights: convertingRights() });
    priced.state.open('customers');
    expect(priced.state.canConvert()).toBe(true);
  });
});

describe('the Unconverted section: Convert again', () => {
  const sole = () => vi.fn(() => of(okResult(listAnswer([unconvertedRow(1)], [openGroup('person', 'not_conforming', 4)]))));

  it('converts the chosen type again with no steps, and reads the run and the list afterwards', () => {
    const { state, api } = setup({ listUnconverted: sole() });
    state.open('customers');
    const lists = api.listUnconverted.mock.calls.length;
    const statuses = api.status.mock.calls.length;
    state.convertAgain();
    expect(api.start).toHaveBeenCalledWith('customers', [{ kind: 'entity', type: 'person' }]);
    expect(api.status.mock.calls.length).toBeGreaterThan(statuses);
    expect(api.listUnconverted.mock.calls.length).toBeGreaterThan(lists);
  });

  it('asks nothing while no type is chosen: Convert again is of one type', () => {
    const { state, api } = setup({ listUnconverted: vi.fn(() => of(page(3))) });
    state.open('customers');
    state.convertAgain();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('asks nothing for a caller without the price', () => {
    const { state, api } = setup({ listUnconverted: sole() }, { rights: rightsWith('write') });
    state.open('customers');
    state.convertAgain();
    expect(api.start).not.toHaveBeenCalled();
  });

  it('the refusals are words: the rate limit with the seconds, a run already going', () => {
    const limited = setup({ listUnconverted: sole(), start: vi.fn(() => of(refused({ kind: 'rate_limited', retryAfterSeconds: 30 }))) });
    limited.state.open('customers');
    limited.state.convertAgain();
    expect(limited.state.refusal()).toContain('Too many conversions');
    expect(limited.state.refusal()).toContain('30');
    const running = setup({ listUnconverted: sole(), start: vi.fn(() => of(refused({ kind: 'running' }))) });
    running.state.open('customers');
    running.state.convertAgain();
    expect(running.state.refusal()).toContain('still running');
  });
});

describe('the Unconverted section: a run that is going', () => {
  beforeEach(() => { vi.useFakeTimers(); Object.defineProperty(document, 'hidden', { configurable: true, value: false }); });
  afterEach(() => vi.useRealTimers());

  it('says how far a running conversion has come, from the status door: records checked of the records it will check', () => {
    const { state } = setup({ status: vi.fn(() => of(okResult(runningStatus()))) });
    state.open('customers');
    // checked = stamped + rewritten + unconverted + moved; total = checked + left
    expect(state.running()).toEqual({ names: ['person'], done: 184, total: 1000 });
  });

  it('a run whose records left were not counted in time has a done count and no total', () => {
    const { state } = setup({ status: vi.fn(() => of(okResult(runningStatus({ left: null })))) });
    state.open('customers');
    expect(state.running()).toEqual({ names: ['person'], done: 184, total: null });
  });

  it('says nothing for a space that never ran, for a finished run, and for a caller who may not read it', () => {
    const none = setup();
    none.state.open('customers');
    expect(none.state.running()).toBeNull();
    const done = setup({ status: vi.fn(() => of(okResult(runningStatus({ state: 'complete' })))) });
    done.state.open('customers');
    expect(done.state.running()).toBeNull();
    const denied = setup({ status: vi.fn(() => of(refused({ kind: 'no_right', code: 'knowledge_rung', error: 'x' }))) });
    denied.state.open('customers');
    expect(denied.state.running()).toBeNull();
  });

  it('asks again every three seconds while it runs, reads the list again when a record was listed since, and stops when the run ends', () => {
    const statuses = [
      okResult(runningStatus()),
      okResult(runningStatus({ counts: { stamped: 120, rewritten: 90, unconverted: 5, moved: 0, edgesRestamped: 0 } })),
      okResult(runningStatus({ state: 'complete', left: 0 })),
    ];
    const { state, api } = setup({ status: vi.fn(() => of(statuses.shift() ?? statuses[0] ?? okResult({ state: 'none' }))), listUnconverted: vi.fn(() => of(page(1))) });
    state.open('customers');
    expect(api.status).toHaveBeenCalledTimes(1);
    const lists = api.listUnconverted.mock.calls.length;
    vi.advanceTimersByTime(3_000);
    expect(api.status).toHaveBeenCalledTimes(2);
    // a fifth record was listed since the last answer: the list is read again
    expect(api.listUnconverted.mock.calls.length).toBe(lists + 1);
    vi.advanceTimersByTime(3_000);
    expect(api.status).toHaveBeenCalledTimes(3);
    expect(state.running()).toBeNull();
    // the run ended: the list is read once more, and no further status is asked
    expect(api.listUnconverted.mock.calls.length).toBe(lists + 2);
    vi.advanceTimersByTime(30_000);
    expect(api.status).toHaveBeenCalledTimes(3);
  });

  it('opening another space stops the poll of the first, so an answer for a space the reader left is never shown', () => {
    const { state, api } = setup({ status: vi.fn(() => of(okResult(runningStatus()))) });
    state.open('customers');
    state.open('support');
    const asked = api.status.mock.calls.length;
    vi.advanceTimersByTime(3_000);
    // one poll only: the first space's chain was stopped when the second opened
    expect(api.status.mock.calls.length).toBe(asked + 1);
    expect(api.status.mock.calls.every(c => c[0] === 'customers' || c[0] === 'support')).toBe(true);
    expect(api.status.mock.calls.at(-1)![0]).toBe('support');
  });
});

describe('the Unconverted section: Open the record', () => {
  it('reads the record of its kind and id and opens the record drawer on it', () => {
    const { state, getRecord, drawerOpen } = setup({ listUnconverted: vi.fn(() => of(page(1))) });
    state.open('customers');
    const row = state.rows()[0]!;
    state.openRecord(row);
    expect(getRecord).toHaveBeenCalledWith('customers', 'entity', row.recordId);
    expect(drawerOpen).toHaveBeenCalledWith('entity', { _id: 'x', name: 'Person 1' });
  });

  it('a record that cannot be read says so and opens nothing', () => {
    const { state, getRecord, drawerOpen } = setup({ listUnconverted: vi.fn(() => of(page(1))) });
    getRecord.mockImplementation(() => throwError(() => ({ status: 404 })));
    state.open('customers');
    state.openRecord(state.rows()[0]!);
    expect(drawerOpen).not.toHaveBeenCalled();
    expect(state.refusal()).toBe('This record could not be opened.');
  });
});
