/**
 * The type head's conversion controls: the labelled "Convert records" button, its lock, and the one note under the head (bundle-285 slice S6,
 * Q-747; plan sections 3.1 item 7, 5 rows P4, P5, P7 to P11, A, 7, 9 "type-convert-bar.component.spec.ts"; handover item 5; drawing moments 3a, 3b,
 * 4b and 6).
 *
 * The bar is mounted the way the Schema tab mounts it: its button is a template the head renders (`bar.button()`), the note and the dialog are
 * the bar's own. The real dialog and the shipped English are loaded; the API, the token and the votes are spies. What these hold:
 *
 * - **The button says what it does, and is locked with its reason.** Labelled, not an icon; disabled with the reason visible and named by
 *   `aria-describedby` when the token may not convert (instance administrators and knowledge admins who also administer the space may; unknown
 *   rights may, the server decides) and when the type is not saved yet (the act works on the stored schema, and a renamed type has no stored name).
 * - **One note at a time**, in the order: waiting for a vote, running, finished, older records.
 * - **Waiting for the vote** reads the open rounds of the space's networks, matches a round to the type through `convertBlocksOfRound` (the vote
 *   row's own reading), and says what this instance would convert; a round that names another type, carries no conversion, or cannot be read
 *   says nothing.
 * - **Running** names the checked-of-total from the run; **finished** only for a run this bar saw or one that began after the settings opened,
 *   never for an old run it finds on opening; a stopped run says so.
 * - **The status is read on a bound** (at once, every three seconds while it runs) and the reading stops when the run ends and when the bar goes.
 * - **Older records** say how many, from the count; none is said only after Convert records was pressed; an unreadable count says nothing.
 * - **The act** counts, starts through `ConversionApi.start` with the steps the dialog chose, closes on success and keeps a refusal in the dialog.
 * - **A Save that found nothing to convert** is said under the head ("Schema saved." and that there were no records of the type to convert) from
 *   the notice the popup hands in through `saveNotice`; and the lead of the saved notes ("Schema saved.", or "Schema saved. Conversion finished.")
 *   is strong text, as drawn (bundle-285 slice S9, moments 3a and 3b).
 *
 * ## Seen red
 *
 * Red at 77b45cfe9: `pages/settings/type-convert-bar.component.ts` does not exist.
 */
import { NgTemplateOutlet } from '@angular/common';
import { ChangeDetectorRef, Component } from '@angular/core';
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import type { Space } from '../../core/api.types';
import { blockCounts, type ConvertBlock } from '../../core/conversion-counts';
import { ConversionApi } from '../../core/conversion-api.service';
import type { ConversionResult, ConvertRunNotice, ConvertStatusAnswer } from '../../core/conversion.types';
import { NetworksApi } from '../../core/networks-api.service';
import type { VoteRound } from '../../core/api.types';
import type { TypedKind } from '../../core/type-field';
import { EN, customers, doneStatus, okStatus } from '../../testing/popup-convert-fixtures';
import { instanceAdminRights, rightsWith, runningStatus } from '../../testing/review-unconverted-fixtures';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CONVERT_POLL_FAILURES_MAX, CONVERT_POLL_MS } from './convert-status-watch';
import type { TokenRights } from './rights-glyph.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { CONVERT_RUN_HOST, TypeConvertBarComponent, VOTE_WATCH_MS } from './type-convert-bar.component';

const english = (key: string): string => { expect(EN[key], `${key} exists in en.json`).toBeTypeOf('string'); return EN[key]!; };
const fill = (key: string, params: Record<string, string | number>): string =>
  Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)), english(key));

const ACME = { id: 'net-1', label: 'Acme team', type: 'democratic' };
/** The lead the pane's notes about a Save open with, drawn as strong text ("Schema saved."). */
const SAVED = english('spaces.schema.convert.note.saved');

/** The Schema tab's markup for the bar, as far as the bar is concerned: the button inside the head's actions, the bar under the head. */
@Component({
  standalone: true,
  imports: [TypeConvertBarComponent, NgTemplateOutlet],
  template: `
    <div class="sch-detail-head"><span class="acts" data-testid="acts"><ng-container *ngTemplateOutlet="bar.button()" /></span></div>
    <app-type-convert-bar #bar [kind]="kind" [type]="type" [was]="was" [saved]="saved" [older]="older" [rights]="rights" [saveNotice]="saveNotice" />
  `,
})
class HostComponent {
  kind: TypedKind = 'entity';
  type = 'person';
  was: string | null = null;
  saved = true;
  older = false;
  rights: TokenRights | null | undefined = instanceAdminRights();
  /** What the popup's converting Save answered; the pane's note learns it through this input, never through a second request. */
  saveNotice: ConvertRunNotice | null = null;
}

interface Setup {
  records?: Record<string, { total: number; rewritten: number }>;
  statuses?: ConversionResult<ConvertStatusAnswer>[];
  older?: number | null;
  rounds?: Partial<VoteRound>[] | 'fail';
  start?: () => unknown;
  space?: Space;
}

function mount(over: Setup = {}, host: Partial<HostComponent> = {}) {
  const space = over.space ?? customers({ networks: [ACME] } as never);
  const records = over.records ?? { person: { total: 640, rewritten: 599 }, client: { total: 212, rewritten: 212 }, invoice: { total: 412, rewritten: 0 } };
  const countsFor = vi.fn((_s: string, block: ConvertBlock) => {
    const r = records[block.was ?? block.type] ?? { total: 0, rewritten: 0 };
    return of({ ok: true as const, counts: blockCounts(block, { total: r.total, rewritten: r.rewritten }) });
  });
  const sequence = over.statuses ?? [okStatus({ state: 'none' })];
  let read = 0;
  const status = vi.fn(() => of(sequence[Math.min(read++, sequence.length - 1)]!));
  const start = vi.fn(over.start ?? (() => of({ ok: true as const, value: { state: 'started', toFp: 'fp', types: [], steps: 0 } })));
  const olderCount = vi.fn(() => of(over.older === undefined ? 412 : over.older));
  const showRun = vi.fn();
  const listVotes = vi.fn(() => (over.rounds === 'fail'
    ? throwError(() => new Error('403'))
    : of({ rounds: (over.rounds ?? []).map(r => ({ id: 'r1', networkId: ACME.id, type: 'meta_change', subject: 's', openedAt: '', deadline: '', status: 'open', votes: [], localSpaceId: 'customers', ...r })) })));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [HostComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      SpaceSettingsState,
      { provide: ConversionApi, useValue: { countsFor, status, start, olderCount, refusedCount: () => of(0) } },
      { provide: NetworksApi, useValue: { listVotes } },
      { provide: CONVERT_RUN_HOST, useValue: { showRun } },
    ],
  });
  const state = TestBed.inject(SpaceSettingsState);
  state.openSettings(space);
  const fixture: ComponentFixture<HostComponent> = TestBed.createComponent(HostComponent);
  Object.assign(fixture.componentInstance, host);
  const root = fixture.nativeElement as HTMLElement;
  // The host is edited in code here, where a page's edit is an event that marks its views dirty: say so, or no render follows.
  const settle = (): void => { fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges(); fixture.detectChanges(); };
  settle();
  const q = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>(`[data-testid="${id}"]`);
  const text = (id: string): string => q(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  return { fixture, host: fixture.componentInstance, state, root, settle, q, text, countsFor, status, start, olderCount, listVotes, showRun, space };
}

const RENAME_PROP = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' } as const;

describe('the Convert records button', () => {
  it('is a labelled button in the head\'s actions, with its icon, that opens the act for this type', () => {
    const m = mount();
    const button = m.q<HTMLButtonElement>('convert-records')!;
    expect(button.closest('[data-testid="acts"]')).not.toBeNull();
    expect(button.textContent!.replace(/\s+/g, ' ').trim()).toBe(english('spaces.schema.convert.button'));
    expect(button.querySelector('ph-icon')).not.toBeNull();
    expect(button.disabled).toBe(false);
    button.click();
    m.settle();
    expect(m.text('cv-title')).toBe(fill('spaces.schema.convert.act.title', { type: 'person' }));
    expect(m.countsFor).toHaveBeenCalled();
  });

  it('is locked for a token that may not convert, with the reason visible and naming the button', () => {
    const m = mount({}, { rights: rightsWith('write') });
    const button = m.q<HTMLButtonElement>('convert-records')!;
    expect(button.disabled).toBe(true);
    expect(button.getAttribute('title')).toBe(english('spaces.schema.convert.locked'));
    const reason = m.q('convert-locked')!;
    expect(reason.textContent!.trim()).toBe(english('spaces.schema.convert.locked'));
    expect(button.getAttribute('aria-describedby')).toBe(reason.id);
  });

  it('is open to a knowledge admin who also administers the space, and to rights nobody has read yet (the server decides)', () => {
    expect(mount({}, { rights: instanceAdminRights() }).q<HTMLButtonElement>('convert-records')!.disabled).toBe(false);
    expect(mount({}, { rights: undefined }).q<HTMLButtonElement>('convert-records')!.disabled).toBe(false);
    expect(mount({}, { rights: null }).q<HTMLButtonElement>('convert-records')!.disabled).toBe(false);
  });

  it.each([
    ['a type that is not saved yet', { saved: false }],
    ['a type renamed and not saved', { was: 'client' }],
  ])('waits for Save for %s, and says so', (_name, host) => {
    const m = mount({}, host as Partial<HostComponent>);
    expect(m.q<HTMLButtonElement>('convert-records')!.disabled).toBe(true);
    expect(m.text('convert-locked')).toBe(english('spaces.schema.convert.saveFirst'));
    expect(m.q<HTMLButtonElement>('convert-records')!.getAttribute('aria-describedby')).toBe(m.q('convert-locked')!.id);
  });

  it('puts the lock\'s words ahead of the Save-first words when both hold', () => {
    const m = mount({}, { rights: rightsWith('read'), saved: false });
    expect(m.text('convert-locked')).toBe(english('spaces.schema.convert.locked'));
  });
});

describe('the Convert act from the type', () => {
  it('starts the conversion of this type with the steps the dialog chose, closes, and then shows the run', () => {
    const m = mount({ statuses: [okStatus(runningStatus({ left: 100 }))] });
    m.q<HTMLButtonElement>('convert-records')!.click();
    m.settle();
    m.q<HTMLButtonElement>('cv-primary')!.click();
    expect(m.start).toHaveBeenCalledWith('customers', [{ kind: 'entity', type: 'person' }], []);
    m.settle();
    expect(m.q('cv-title')).toBeNull();
  });

  it('keeps a refusal in the dialog, which stays open, and Convert records can be pressed again', () => {
    const m = mount({ start: () => of({ ok: false as const, refusal: { kind: 'rate_limited', retryAfterSeconds: 5 } }) });
    m.q<HTMLButtonElement>('convert-records')!.click();
    m.settle();
    m.q<HTMLButtonElement>('cv-primary')!.click();
    m.settle();
    expect(m.text('cv-refusal')).toContain(english('spaces.schema.convert.rateLimited'));
    expect(m.q('cv-title')).not.toBeNull();
    m.q<HTMLButtonElement>('cv-primary')!.click();
    expect(m.start).toHaveBeenCalledTimes(2);
  });

  it('a conversion already running is said in words, in the dialog', () => {
    const m = mount({ start: () => of({ ok: false as const, refusal: { kind: 'running' } }) });
    m.q<HTMLButtonElement>('convert-records')!.click();
    m.settle();
    m.q<HTMLButtonElement>('cv-primary')!.click();
    m.settle();
    expect(m.text('cv-refusal')).toBe(english('spaces.schema.convert.running409'));
  });

  it('Cancel starts nothing', () => {
    const m = mount();
    m.q<HTMLButtonElement>('convert-records')!.click();
    m.settle();
    m.q<HTMLButtonElement>('cv-cancel')!.click();
    m.settle();
    expect(m.start).not.toHaveBeenCalled();
    expect(m.q('cv-title')).toBeNull();
  });
});

describe('the note while the run goes, and when it ends', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  /** Render (so a re-read an edit asked for starts), let `ms` pass, render again. */
  const tick = (m: ReturnType<typeof mount>, ms = 0): void => { m.settle(); vi.advanceTimersByTime(ms); m.settle(); };

  it('says how far the run is, in checked of total, for a run that includes this type', () => {
    const m = mount({ statuses: [okStatus(runningStatus({ left: 240, counts: { stamped: 31, rewritten: 366, unconverted: 3, moved: 0, edgesRestamped: 0 } }))] });
    tick(m);
    expect(m.text('convert-note')).toBe(`${SAVED} ${fill('spaces.schema.convert.note.running.other', { done: '400', count: '640' })}`);
  });

  it('says nothing for a run that does not include this type, and nothing for a space that never had a run', () => {
    const other = mount({ statuses: [okStatus(runningStatus({ types: [{ kind: 'entity', type: 'contact', done: false }] }))] });
    tick(other);
    expect(other.q('convert-note')).toBeNull();
    const none = mount();
    tick(none);
    expect(none.q('convert-note')).toBeNull();
  });

  it('says "counting" while the records left are not counted yet', () => {
    const m = mount({ statuses: [okStatus(runningStatus({ left: null }))] });
    tick(m);
    expect(m.text('convert-note')).toContain(english('spaces.schema.convert.run.counting'));
  });

  it('reads every three seconds while it runs, shows the finish a run it saw, and stops reading', () => {
    const m = mount({ statuses: [okStatus(runningStatus()), okStatus(runningStatus({ left: 10 })), okStatus(doneStatus())] });
    tick(m);
    expect(m.status).toHaveBeenCalledTimes(1);
    tick(m, CONVERT_POLL_MS);
    expect(m.status).toHaveBeenCalledTimes(2);
    tick(m, CONVERT_POLL_MS);
    expect(m.status).toHaveBeenCalledTimes(3);
    expect(m.text('convert-note')).toContain(english('spaces.schema.convert.note.finished'));
    expect(m.text('convert-note')).toContain('4 records could not be converted.');
    tick(m, CONVERT_POLL_MS * 20);
    expect(m.status).toHaveBeenCalledTimes(3);
  });

  it('a finished run with nothing left to review says only that it finished', () => {
    const m = mount({ statuses: [okStatus(runningStatus()), okStatus(doneStatus({ counts: { stamped: 41, rewritten: 599, unconverted: 0, moved: 0, edgesRestamped: 0 } }))] });
    tick(m);
    tick(m, CONVERT_POLL_MS);
    expect(m.text('convert-note')).toBe(english('spaces.schema.convert.note.finished'));
  });

  it('a run that stopped says why and what to press', () => {
    const m = mount({ statuses: [okStatus(runningStatus()), okStatus(doneStatus({ state: 'failed', error: 'the store went away' }))] });
    tick(m);
    tick(m, CONVERT_POLL_MS);
    expect(m.text('convert-note')).toBe(fill('spaces.schema.convert.run.failed', { error: 'the store went away' }));
  });

  it('does not announce an OLD finished run it finds when the settings open', () => {
    const m = mount({ statuses: [okStatus(doneStatus())] });
    tick(m);
    expect(m.q('convert-note')).toBeNull();
    expect(m.status).toHaveBeenCalledTimes(1);
  });

  it('announces a finished run that began after the settings opened (a save re-baselined them), though the first read already finds it done', () => {
    const m = mount({ statuses: [okStatus({ state: 'none' }), okStatus(doneStatus())] });
    tick(m);
    expect(m.q('convert-note')).toBeNull();
    m.state.markPristine();
    tick(m);
    expect(m.text('convert-note')).toContain(english('spaces.schema.convert.note.finished'));
  });

  it('reads again after a save, so a run a Save started is picked up', () => {
    const m = mount({ statuses: [okStatus({ state: 'none' }), okStatus(runningStatus())] });
    tick(m);
    expect(m.status).toHaveBeenCalledTimes(1);
    m.state.markPristine();
    tick(m);
    expect(m.status).toHaveBeenCalledTimes(2);
    expect(m.q('convert-note')).not.toBeNull();
  });

  it('stops reading when the bar goes', () => {
    const m = mount({ statuses: [okStatus(runningStatus())] });
    tick(m);
    const reads = m.status.mock.calls.length;
    m.fixture.destroy();
    vi.advanceTimersByTime(CONVERT_POLL_MS * 20);
    expect(m.status).toHaveBeenCalledTimes(reads);
  });

  it('a read that fails says nothing and is given up after a bound', () => {
    const failed = { ok: false as const, refusal: { kind: 'other' as const, status: 503, error: 'down' } };
    const m = mount({ statuses: [failed] });
    tick(m, CONVERT_POLL_MS * (CONVERT_POLL_FAILURES_MAX + 5));
    expect(m.q('convert-note')).toBeNull();
    expect(m.status).toHaveBeenCalledTimes(CONVERT_POLL_FAILURES_MAX);
  });

  it('after Convert records is pressed the finish is announced even when the run was done at the first read', () => {
    const m = mount({ statuses: [okStatus({ state: 'none' }), okStatus(doneStatus())] });
    tick(m);
    m.q<HTMLButtonElement>('convert-records')!.click();
    m.settle();
    m.q<HTMLButtonElement>('cv-primary')!.click();
    tick(m);
    expect(m.text('convert-note')).toContain(english('spaces.schema.convert.note.finished'));
  });
});

describe('the note while a vote waits', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const round = (steps: unknown[], over: Partial<VoteRound> = {}): Partial<VoteRound> => ({ convertRecords: { steps: steps as never }, changedTypes: ['entity:person'], ...over });

  it('says it waits, in which network, and what this instance converts if the vote passes', () => {
    const m = mount({ rounds: [round([RENAME_PROP])] });
    vi.advanceTimersByTime(0);
    m.settle();
    expect(m.text('convert-note')).toBe(`${fill('spaces.schema.convert.note.waiting', { network: 'Acme team' })} ${fill('spaces.schema.convert.note.waitingCounts.other', { count: '640', type: 'person', stamped: 41, rewritten: 599 })}`);
    expect(m.listVotes).toHaveBeenCalledWith('net-1');
  });

  it('matches a round that renames the type to the type by the name the records still have, and counts under it', () => {
    const rename = { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' };
    const m = mount({ rounds: [round([rename], { changedTypes: ['entity:customer'] })] }, { type: 'client' });
    m.settle();
    expect(m.text('convert-note')).toContain('212 records of client');
    expect(m.countsFor.mock.calls[0]![1]).toMatchObject({ type: 'customer', was: 'client' });
  });

  it('counts a conversion with no steps (stamp only) from the types the round changes', () => {
    const m = mount({ rounds: [round([])] });
    m.settle();
    expect(m.text('convert-note')).toContain('640 records of person');
    expect(m.countsFor.mock.calls[0]![1]).toMatchObject({ kind: 'entity', type: 'person', steps: [] });
  });

  it('says only that it waits when this type holds no records', () => {
    const m = mount({ rounds: [round([RENAME_PROP])], records: { person: { total: 0, rewritten: 0 } } });
    m.settle();
    expect(m.text('convert-note')).toBe(fill('spaces.schema.convert.note.waiting', { network: 'Acme team' }));
  });

  it.each([
    ['names another type', round([{ ...RENAME_PROP, type: 'contact' }], { changedTypes: ['entity:contact'] })],
    ['carries no conversion', { changedTypes: ['entity:person'] }],
    ['is about another space', round([RENAME_PROP], { localSpaceId: 'other' })],
    ['is not a schema change', round([RENAME_PROP], { type: 'space_addition' })],
  ])('says nothing for a round that %s', (_name, r) => {
    const m = mount({ rounds: [r] });
    m.settle();
    expect(m.q('convert-note')).toBeNull();
  });

  it('says nothing when the votes cannot be read (a token that is not an instance administrator)', () => {
    const m = mount({ rounds: 'fail' });
    m.settle();
    expect(m.q('convert-note')).toBeNull();
  });

  it('asks no network of a space that is in none', () => {
    const m = mount({ space: customers() });
    m.settle();
    expect(m.listVotes).not.toHaveBeenCalled();
  });

  it('comes before the run\'s note: the vote has not changed anything yet', () => {
    const m = mount({ rounds: [round([RENAME_PROP])], statuses: [okStatus(runningStatus())] });
    vi.advanceTimersByTime(0);
    m.settle();
    expect(m.text('convert-note')).toContain(fill('spaces.schema.convert.note.waiting', { network: 'Acme team' }));
  });

  it('goes when the round is no longer open, and the run the round started takes over, with the popup still open (drive round 2)', () => {
    const fromRound = runningStatus({ sources: [{ kind: 'round', roundId: 'r1', at: '2026-11-19T10:00:00.000Z' }], left: 240,
      counts: { stamped: 31, rewritten: 366, unconverted: 3, moved: 0, edgesRestamped: 0 } });
    const m = mount({ rounds: [round([RENAME_PROP])], statuses: [okStatus({ state: 'none' }), okStatus(fromRound)] });
    vi.advanceTimersByTime(0);
    m.settle();
    expect(m.text('convert-note')).toContain(fill('spaces.schema.convert.note.waiting', { network: 'Acme team' }));
    m.listVotes.mockReturnValue(of({ rounds: [] }));
    vi.advanceTimersByTime(VOTE_WATCH_MS);
    m.settle();
    vi.advanceTimersByTime(1);   // the run's first read, scheduled inside the round's tick, is due a moment later
    m.settle();
    expect(m.text('convert-note')).not.toContain(fill('spaces.schema.convert.note.waiting', { network: 'Acme team' }));
    expect(m.text('convert-note')).toContain(fill('spaces.schema.convert.note.running.other', { done: '400', count: '640' }));
  });

  it('announces the round\'s run as finished when it ended before the round was seen to close (the popup stayed open throughout)', () => {
    const done = doneStatus({ sources: [{ kind: 'round', roundId: 'r1', at: '2026-11-19T10:00:00.000Z' }] });
    const m = mount({ rounds: [round([RENAME_PROP])], statuses: [okStatus({ state: 'none' }), okStatus(done)] });
    vi.advanceTimersByTime(0);
    m.settle();
    m.listVotes.mockReturnValue(of({ rounds: [{ ...round([RENAME_PROP]), id: 'r1', status: 'concluded' } as never] }));
    vi.advanceTimersByTime(VOTE_WATCH_MS);
    m.settle();
    vi.advanceTimersByTime(1);
    m.settle();
    expect(m.text('convert-note')).toContain(english('spaces.schema.convert.note.finishedByVote'));
  });

  it('reads the votes again only while a vote is waited on, and stops when the bar goes', () => {
    const idle = mount({ rounds: [] });
    vi.advanceTimersByTime(VOTE_WATCH_MS * 5);
    expect(idle.listVotes).toHaveBeenCalledTimes(1);
    const m = mount({ rounds: [round([RENAME_PROP])] });
    vi.advanceTimersByTime(VOTE_WATCH_MS * 2);
    const reads = m.listVotes.mock.calls.length;
    expect(reads, 'the round is read again on the bound while it waits').toBeGreaterThan(1);
    m.fixture.destroy();
    vi.advanceTimersByTime(VOTE_WATCH_MS * 10);
    expect(m.listVotes).toHaveBeenCalledTimes(reads);
  });

  it('is read again after a save', () => {
    const m = mount({ rounds: [] });
    m.settle();
    expect(m.listVotes).toHaveBeenCalledTimes(1);
    m.state.markPristine();
    m.settle();
    expect(m.listVotes).toHaveBeenCalledTimes(2);
  });
});

/**
 * The pace of the vote watch (S13, lens finding 2). A vote lasts hours or days, so it is not watched at a run's pace: one scan of the networks per
 * popup opening (or save), shared by every type; while a type waits, a read of its network every `VOTE_WATCH_MS` the tab is visible, and one at once
 * when the tab becomes visible again or the reader returns to the type. Red at 877a5d3c5: the bar read the votes every `CONVERT_POLL_MS` (201 reads in
 * ten minutes) and scanned every network on every type selection.
 */
describe('the vote watch\'s pace', () => {
  beforeEach(() => { vi.useFakeTimers(); setHidden(false); });
  afterEach(() => { setHidden(false); vi.useRealTimers(); });

  const round = (): Partial<VoteRound> => ({ convertRecords: { steps: [RENAME_PROP] as never }, changedTypes: ['entity:person'] });
  const waiting = fill('spaces.schema.convert.note.waiting', { network: 'Acme team' });
  function setHidden(hidden: boolean): void {
    Object.defineProperty(document, 'hidden', { configurable: true, value: hidden });
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: hidden ? 'hidden' : 'visible' });
  }

  it('asks at most 21 times in ten minutes with an open round and the tab visible: one scan, then one read per VOTE_WATCH_MS', () => {
    const m = mount({ rounds: [round()] });
    vi.advanceTimersByTime(0);
    m.settle();
    expect(m.text('convert-note')).toContain(waiting);
    vi.advanceTimersByTime(10 * 60_000);
    // 1 + 600,000 / 30,000
    expect(m.listVotes.mock.calls.length).toBeLessThanOrEqual(21);
    expect(m.listVotes.mock.calls.length, 'it is still watched').toBeGreaterThan(1);
  });

  it('the waiting note gives way within one interval after the round closes', () => {
    const m = mount({ rounds: [round()] });
    vi.advanceTimersByTime(0);
    m.settle();
    m.listVotes.mockReturnValue(of({ rounds: [] }));
    vi.advanceTimersByTime(VOTE_WATCH_MS);
    m.settle();
    vi.advanceTimersByTime(1);
    m.settle();
    expect(m.text('convert-note')).not.toContain(waiting);
  });

  it('scans the networks once per popup opening and reuses the answer for every type selected', () => {
    const m = mount({ rounds: [] });
    m.host.type = 'client';
    m.settle();
    m.host.type = 'invoice';
    m.settle();
    vi.advanceTimersByTime(0);
    expect(m.listVotes).toHaveBeenCalledTimes(1);
  });

  it('reads the waited round\'s network at once when the reader returns to the type', () => {
    const m = mount({ rounds: [round()] });
    vi.advanceTimersByTime(0);
    m.settle();
    m.host.type = 'client';
    m.settle();
    vi.advanceTimersByTime(0);
    expect(m.listVotes).toHaveBeenCalledTimes(1);
    m.host.type = 'person';
    m.settle();
    vi.advanceTimersByTime(0);
    m.settle();
    expect(m.listVotes).toHaveBeenCalledTimes(2);
    expect(m.text('convert-note')).toContain(waiting);
  });

  it('reads at once when the tab becomes visible again, and nothing while it is hidden', () => {
    const m = mount({ rounds: [round()] });
    vi.advanceTimersByTime(0);
    m.settle();
    const before = m.listVotes.mock.calls.length;
    setHidden(true);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(5 * 60_000);
    expect(m.listVotes.mock.calls.length).toBe(before);
    setHidden(false);
    document.dispatchEvent(new Event('visibilitychange'));
    vi.advanceTimersByTime(0);
    expect(m.listVotes.mock.calls.length).toBe(before + 1);
    vi.advanceTimersByTime(VOTE_WATCH_MS - 1);
    expect(m.listVotes.mock.calls.length).toBe(before + 1);
  });
});

describe('the note about records on an older version', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('says how many records of the type are on an older version, and where to press', () => {
    const m = mount({ older: 412 }, { type: 'invoice', older: true });
    m.settle();
    expect(m.text('convert-note')).toBe(fill('spaces.schema.convert.note.older.other', { count: '412', type: 'invoice' }));
    expect(m.olderCount).toHaveBeenCalledWith('customers', 'entity', 'invoice');
    expect(m.q('convert-records')!.classList.contains('cv-btn-attn'), 'the button the note points at stands out, as drawn').toBe(true);
  });

  it('leaves the button plain when no record waits on an older version', () => {
    const m = mount({ older: 0 }, { type: 'invoice', older: true });
    m.settle();
    expect(m.q('convert-records')!.classList.contains('cv-btn-attn')).toBe(false);
  });

  it('loses the accent once a run it saw has finished and no record of the type is on an older version any more (drive D3)', () => {
    const invoice = [{ kind: 'entity' as const, type: 'invoice', done: false }];
    const m = mount({ older: 412, statuses: [okStatus(runningStatus({ types: invoice })), okStatus(doneStatus({ types: [{ ...invoice[0]!, done: true }] }))] }, { type: 'invoice', older: true });
    m.settle(); vi.advanceTimersByTime(0); m.settle();
    expect(m.q('convert-records')!.classList.contains('cv-btn-attn'), 'records wait while it runs').toBe(true);
    m.olderCount.mockReturnValue(of(0));
    vi.advanceTimersByTime(CONVERT_POLL_MS);
    m.settle();
    expect(m.q('convert-records')!.classList.contains('cv-btn-attn')).toBe(false);
  });

  it('asks nothing when the type list does not mark the type older', () => {
    const m = mount({}, { type: 'invoice', older: false });
    m.settle();
    expect(m.olderCount).not.toHaveBeenCalled();
    expect(m.q('convert-note')).toBeNull();
  });

  it('says there is nothing to convert only after Convert records was pressed, and nothing before', () => {
    const m = mount({ older: 0 }, { type: 'invoice', older: true });
    m.settle();
    expect(m.q('convert-note')).toBeNull();
    m.q<HTMLButtonElement>('convert-records')!.click();
    m.settle();
    expect(m.text('convert-note')).toBe(fill('spaces.schema.convert.note.olderNone', { type: 'invoice' }));
  });

  it('says nothing when the count could not be read', () => {
    const m = mount({ older: null }, { type: 'invoice', older: true });
    m.settle();
    expect(m.q('convert-note')).toBeNull();
  });

  it('is read again after a save, and goes when the type stops being marked older', () => {
    const m = mount({ older: 412 }, { type: 'invoice', older: true });
    m.settle();
    m.state.markPristine();
    m.settle();
    expect(m.olderCount).toHaveBeenCalledTimes(2);
    m.host.older = false;
    m.settle();
    expect(m.q('convert-note')).toBeNull();
  });

  it('draws the button\'s accent in the theme\'s "ready" green, outlined, as drawn: not the violet accent fill (bundle-285 S10)', () => {
    mount({ older: 412 }, { type: 'invoice', older: true }).settle();
    const rule = Array.from(document.styleSheets).flatMap(s => Array.from(s.cssRules)).map(r => r.cssText).find(t => /\.cv-btn-attn/.test(t)) ?? '';
    expect(rule).toMatch(/var\(--success-dim\)/);
    expect(rule).toMatch(/var\(--success-border\)/);
    expect(rule).not.toMatch(/--accent-dim/);
  });

  it('draws its note in the theme\'s tokens: no colour of its own', () => {
    mount({ older: 412 }, { type: 'invoice', older: true }).settle();
    const rules = Array.from(document.styleSheets).flatMap(s => Array.from(s.cssRules)).map(r => r.cssText).filter(t => /\.cv-(bar|note|reason)/.test(t));
    expect(rules.length, 'the bar\'s rules were read').toBeGreaterThan(2);
    expect(rules.filter(r => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(r))).toEqual([]);
  });
});

describe('the note after a Save that converted nothing, and the strong lead of the saved notes', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  const NOTHING: ConvertRunNotice = { state: 'nothing', types: [{ kind: 'entity', type: 'person' }] };
  const strong = (m: ReturnType<typeof mount>): string | undefined => m.q('convert-note')?.querySelector('strong')?.textContent?.trim();

  it('says "Schema saved." in strong text, then that there were no records to convert, from the notice the popup hands in (no read of its own)', () => {
    const m = mount({}, { saveNotice: NOTHING });
    m.settle();
    expect(strong(m)).toBe(SAVED);
    expect(m.text('convert-note')).toBe(`${SAVED} ${english('spaces.schema.convert.note.none')}`);
    expect(m.countsFor).not.toHaveBeenCalled();
    expect(m.start).not.toHaveBeenCalled();
  });

  it('shows it for the type the Save converted and for no other', () => {
    const other = mount({}, { type: 'contact', saveNotice: NOTHING });
    other.settle();
    expect(other.q('convert-note')).toBeNull();
    const kind = mount({}, { kind: 'fact', type: 'person', saveNotice: NOTHING });
    kind.settle();
    expect(kind.q('convert-note')).toBeNull();
  });

  it('is there as long as the popup hands it in and gone when it takes it back', () => {
    const m = mount({}, { saveNotice: NOTHING });
    m.settle();
    expect(m.q('convert-note')).not.toBeNull();
    m.host.saveNotice = null;
    m.settle();
    expect(m.q('convert-note')).toBeNull();
  });

  it('is not said for a Save that started a run, one that did not start, or one that went to a vote', () => {
    for (const state of ['started', 'not_started', 'after_vote'] as const) {
      const m = mount({}, { saveNotice: { state, types: NOTHING.types } });
      m.settle();
      expect(m.q('convert-note'), state).toBeNull();
    }
  });

  it('gives way to the run\'s own finished note, which says more, and to a vote the type waits on', () => {
    const run = mount({ statuses: [okStatus(runningStatus()), okStatus(doneStatus())] }, { saveNotice: NOTHING });
    run.settle(); vi.advanceTimersByTime(CONVERT_POLL_MS); run.settle();
    expect(run.text('convert-note')).toContain(english('spaces.schema.convert.note.finished'));
    expect(run.text('convert-note')).not.toContain(english('spaces.schema.convert.note.none'));
    const vote = mount({ rounds: [{ convertRecords: { steps: [RENAME_PROP] } } as Partial<VoteRound>] }, { saveNotice: NOTHING });
    vote.settle(); vi.advanceTimersByTime(0); vote.settle();
    expect(vote.text('convert-note')).toContain(fill('spaces.schema.convert.note.waiting', { network: 'Acme team' }));
    expect(vote.text('convert-note')).not.toContain(english('spaces.schema.convert.note.none'));
  });

  it('prefers it to the finished note of an OLD run of the type that the save re-baselined past: that Save started no run', () => {
    const m = mount({ statuses: [okStatus(doneStatus())] }, { saveNotice: NOTHING });
    m.settle();
    m.state.markPristine();
    m.settle(); vi.advanceTimersByTime(0); m.settle();
    expect(m.text('convert-note')).toBe(`${SAVED} ${english('spaces.schema.convert.note.none')}`);
    expect(m.text('convert-note')).not.toContain(english('spaces.schema.convert.note.finished'));
  });

  it('opens the running note with "Schema saved." in strong text, and the rest plain', () => {
    const m = mount({ statuses: [okStatus(runningStatus({ left: 240 }))] });
    m.settle(); vi.advanceTimersByTime(0); m.settle();
    expect(strong(m)).toBe(SAVED);
    expect(m.q('convert-note')!.textContent).not.toMatch(/^\s*Schema saved\.\s*Schema saved\./);
  });

  it('makes the whole "Schema saved. Conversion finished." strong, and leaves the count of what could not be converted plain', () => {
    const m = mount({ statuses: [okStatus(runningStatus()), okStatus(doneStatus())] });
    m.settle(); vi.advanceTimersByTime(CONVERT_POLL_MS); m.settle();
    expect(strong(m)).toBe(english('spaces.schema.convert.note.finished'));
    expect(m.text('convert-note')).toBe(`${english('spaces.schema.convert.note.finished')} 4 records could not be converted.`);
  });

  it('says nothing of a saved schema about a run the Convert act started (every source is the act): the act saves no schema', () => {
    const act = [{ kind: 'act' as const, at: '2026-11-19T10:00:00.000Z' }];
    const running = mount({ statuses: [okStatus(runningStatus({ sources: act, left: 240, counts: { stamped: 31, rewritten: 366, unconverted: 3, moved: 0, edgesRestamped: 0 } }))] });
    running.settle(); vi.advanceTimersByTime(0); running.settle();
    expect(running.text('convert-note')).toBe(fill('spaces.schema.convert.note.running.other', { done: '400', count: '640' }));
    expect(running.text('convert-note')).not.toContain(SAVED);
    expect(strong(running)).toBeUndefined();
    const finished = mount({ statuses: [okStatus(runningStatus({ sources: act })), okStatus(doneStatus({ sources: act }))] });
    finished.settle(); vi.advanceTimersByTime(CONVERT_POLL_MS); finished.settle();
    expect(strong(finished)).toBe(english('spaces.schema.convert.note.actFinished'));
    expect(finished.text('convert-note')).toBe(`${english('spaces.schema.convert.note.actFinished')} 4 records could not be converted.`);
    expect(finished.text('convert-note')).not.toContain(SAVED);
  });

  it('a finished vote run that refused a step says so in the note, counted, and offers to show the run, which the host opens on it (drive round 4)', () => {
    const round = [{ kind: 'round' as const, roundId: 'r1', at: '2026-11-19T10:00:00.000Z' }];
    const refused = { steps: [RENAME_PROP], stepsRefused: [{ step: RENAME_PROP, reason: 'property_still_declared_here' }], sources: round };
    const m = mount({ statuses: [okStatus(runningStatus(refused)), okStatus(doneStatus(refused))] });
    m.settle(); vi.advanceTimersByTime(CONVERT_POLL_MS); m.settle();
    expect(m.text('convert-note')).toContain(english('spaces.schema.convert.refused.head.one'));
    const show = m.q<HTMLButtonElement>('convert-show-run');
    expect(show?.textContent?.trim()).toBe(english('spaces.schema.convert.note.showRun'));
    show!.click();
    expect(m.showRun).toHaveBeenCalledTimes(1);
    const [notice, from, status] = m.showRun.mock.calls[0]!;
    expect(notice).toBeNull();
    expect(from).toBe('note');
    expect(status).toMatchObject({ state: 'complete', stepsRefused: refused.stepsRefused });
  });

  it('offers to show the run for a running run and a finished one with nothing refused, and says nothing of a refusal then', () => {
    const running = mount({ statuses: [okStatus(runningStatus({ left: 240 }))] });
    running.settle(); vi.advanceTimersByTime(0); running.settle();
    expect(running.q('convert-show-run')).not.toBeNull();
    const done = mount({ statuses: [okStatus(runningStatus()), okStatus(doneStatus())] });
    done.settle(); vi.advanceTimersByTime(CONVERT_POLL_MS); done.settle();
    expect(done.q('convert-show-run')).not.toBeNull();
    expect(done.text('convert-note')).not.toContain('refused');
    const older = mount({ older: 412 }, { type: 'invoice', older: true });
    older.settle();
    expect(older.q('convert-show-run'), 'no run, no control').toBeNull();
  });

  it('says "Schema changed by the vote." for a run a passed vote started: this member saved nothing (drive round 3)', () => {
    const round = [{ kind: 'round' as const, roundId: 'r1', at: '2026-11-19T10:00:00.000Z' }];
    const running = mount({ statuses: [okStatus(runningStatus({ sources: round, left: 240 }))] });
    running.settle(); vi.advanceTimersByTime(0); running.settle();
    expect(strong(running)).toBe(english('spaces.schema.convert.note.byVote'));
    expect(running.text('convert-note')).not.toContain(SAVED);
    const finished = mount({ statuses: [okStatus(runningStatus({ sources: round })), okStatus(doneStatus({ sources: round }))] });
    finished.settle(); vi.advanceTimersByTime(CONVERT_POLL_MS); finished.settle();
    expect(strong(finished)).toBe(english('spaces.schema.convert.note.finishedByVote'));
    expect(finished.text('convert-note')).not.toContain(SAVED);
  });

  it('words a run of mixed sources by its most recent one, as the server appends them: what changed the schema last is what the person meets', () => {
    const at = (kind: 'write' | 'round' | 'act', minute: number) => ({ kind, ...(kind === 'round' ? { roundId: 'r1' } : {}), at: `2026-11-19T10:0${minute}:00.000Z` });
    const lead = (sources: ReturnType<typeof at>[]): string | undefined => {
      const m = mount({ statuses: [okStatus(runningStatus({ sources, left: 240 }))] });
      m.settle(); vi.advanceTimersByTime(0); m.settle();
      return strong(m);
    };
    expect(lead([at('write', 0), at('round', 1)])).toBe(english('spaces.schema.convert.note.byVote'));
    expect(lead([at('round', 0), at('write', 1)])).toBe(SAVED);
    expect(lead([at('round', 0), at('act', 1)])).toBeUndefined();
  });

  it('keeps "Schema saved." for a run a Save joined, though the act started it', () => {
    const both = [{ kind: 'act' as const, at: '2026-11-19T10:00:00.000Z' }, { kind: 'write' as const, at: '2026-11-19T10:01:00.000Z' }];
    const m = mount({ statuses: [okStatus(runningStatus({ sources: both, left: 240 }))] });
    m.settle(); vi.advanceTimersByTime(0); m.settle();
    expect(strong(m)).toBe(SAVED);
  });

  it('keeps the waiting, older and failed notes plain, as drawn: no strong text', () => {
    const waiting = mount({ rounds: [{ convertRecords: { steps: [RENAME_PROP] } } as Partial<VoteRound>] });
    waiting.settle(); vi.advanceTimersByTime(0); waiting.settle();
    expect(waiting.q('convert-note')).not.toBeNull();
    expect(strong(waiting)).toBeUndefined();
    const older = mount({ older: 412 }, { type: 'invoice', older: true });
    older.settle();
    expect(strong(older)).toBeUndefined();
  });
});
