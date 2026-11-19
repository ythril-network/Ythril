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
import type { ConversionResult, ConvertStatusAnswer } from '../../core/conversion.types';
import { NetworksApi } from '../../core/networks-api.service';
import type { VoteRound } from '../../core/api.types';
import type { TypedKind } from '../../core/type-field';
import { EN, customers, doneStatus, okStatus } from '../../testing/popup-convert-fixtures';
import { instanceAdminRights, rightsWith, runningStatus } from '../../testing/review-unconverted-fixtures';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { CONVERT_POLL_FAILURES_MAX, CONVERT_POLL_MS } from './convert-status-watch';
import type { TokenRights } from './rights-glyph.component';
import { SpaceSettingsState } from './space-settings-state.service';
import { TypeConvertBarComponent } from './type-convert-bar.component';

const english = (key: string): string => { expect(EN[key], `${key} exists in en.json`).toBeTypeOf('string'); return EN[key]!; };
const fill = (key: string, params: Record<string, string | number>): string =>
  Object.entries(params).reduce((text, [name, value]) => text.replaceAll(`{{${name}}}`, String(value)), english(key));

const ACME = { id: 'net-1', label: 'Acme team', type: 'democratic' };

/** The Schema tab's markup for the bar, as far as the bar is concerned: the button inside the head's actions, the bar under the head. */
@Component({
  standalone: true,
  imports: [TypeConvertBarComponent, NgTemplateOutlet],
  template: `
    <div class="sch-detail-head"><span class="acts" data-testid="acts"><ng-container *ngTemplateOutlet="bar.button()" /></span></div>
    <app-type-convert-bar #bar [kind]="kind" [type]="type" [was]="was" [saved]="saved" [older]="older" [rights]="rights" />
  `,
})
class HostComponent {
  kind: TypedKind = 'entity';
  type = 'person';
  was: string | null = null;
  saved = true;
  older = false;
  rights: TokenRights | null | undefined = instanceAdminRights();
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
  return { fixture, host: fixture.componentInstance, state, root, settle, q, text, countsFor, status, start, olderCount, listVotes, space };
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
    expect(m.text('convert-note')).toBe(fill('spaces.schema.convert.note.running.other', { done: '400', count: '640' }));
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

  it('is read again after a save', () => {
    const m = mount({ rounds: [] });
    m.settle();
    expect(m.listVotes).toHaveBeenCalledTimes(1);
    m.state.markPristine();
    m.settle();
    expect(m.listVotes).toHaveBeenCalledTimes(2);
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

  it('draws its note in the theme\'s tokens: no colour of its own', () => {
    mount({ older: 412 }, { type: 'invoice', older: true }).settle();
    const rules = Array.from(document.styleSheets).flatMap(s => Array.from(s.cssRules)).map(r => r.cssText).filter(t => /\.cv-(bar|note|reason)/.test(t));
    expect(rules.length, 'the bar\'s rules were read').toBeGreaterThan(2);
    expect(rules.filter(r => /#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i.test(r))).toEqual([]);
  });
});
