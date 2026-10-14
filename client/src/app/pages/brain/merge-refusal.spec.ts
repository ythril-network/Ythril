/**
 * A refused duplicate merge stays on screen, says which pair and which keys, and is not a toast (bundle-23, R6-14, R6-10).
 *
 * The review tab's merge turned every failure into `toast.error(e?.error?.error || ...)`. Two things are wrong with that
 * once a strict space can refuse a merge (R6-10: keys brought in from the absorbed record are "introduced"):
 *   - the toast reads `error`, which for a schema refusal is now a CODE (`schema_violation`); the sentence is `message`;
 *   - a toast is gone in eight seconds and names nothing, while the refusal is about one pair among many in a list the
 *     reviewer is working down, and the answer ("these keys would be brought in") is what they have to act on.
 * So the refusal is a PERSISTENT row in the review list, `[data-testid="merge-refusal"]`, `role="alert"`, naming the pair
 * and the introduced keys, that stays until it is dismissed. It reads `message` and the rows through the one formatter
 * (`describeRefusal`), never `error`.
 *
 * The call sites of the merge API are derived from the sources (`mergeDuplicate(`, outside the API service), and each one
 * must have a driver below, so a second merge door added later is a red test and not an uncovered one. Real English words
 * are loaded from the shipped file, because the rows are text a person reads.
 *
 * Red on the unchanged base: the failure is a toast carrying the raw code and no row is rendered.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { of, throwError } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { locale } from '../../testing/files-page-harness';
import { CLIENT_ROOT, trackedAppSources } from '../../testing/tracked-sources';
import { stripComments } from '../../testing/strip-comments';
import { ReviewTabComponent } from './review-tab.component';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import type { DuplicateRecord } from '../../core/api.types';

const EN = locale('en');
const ROW = '[data-testid="merge-refusal"]';
const DISMISS = '[data-testid="merge-refusal-dismiss"]';

const ADA = { id: 'd1', aSummary: 'Ada Lovelace (mathematician)', bSummary: 'A. Lovelace' };
const GRACE = { id: 'd2', aSummary: 'Grace Hopper (admiral)', bSummary: 'G. Hopper' };

const pair = (p: typeof ADA): DuplicateRecord => ({
  id: p.id, spaceId: 'work', type: 'entity', aId: `${p.id}a`, aSummary: p.aSummary, bId: `${p.id}b`, bSummary: p.bSummary,
  score: 0.93, status: 'open', detectedAt: '2026-01-01', updatedAt: '2026-01-01',
});

/** The 400 answer of a refused merge: `SchemaViolationError.toStructured()`, rows for the keys the merge would bring in. */
const bringsIn = (keys: string[], message = 'Merging would bring in keys the type does not declare.') => ({
  status: 400,
  error: {
    error: 'schema_violation',
    message,
    introduced: keys.map(k => ({ field: `properties.${k}`, value: 'v', reason: 'brought in from the absorbed record', declared: ['name'], outcome: 'violated' })),
    preExisting: [],
    violations: keys.map(k => ({ field: `properties.${k}`, value: 'v', reason: 'brought in from the absorbed record', declared: ['name'], outcome: 'violated' })),
  },
});

function setup(merge: (id: string) => unknown) {
  const toastErrors: string[] = [];
  const toastOther: string[] = [];
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ReviewTabComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      { provide: SpacesApi, useValue: { getCompleteness: () => of({ spaceId: 'work', score: null, checks: [], truncated: false }) } },
      { provide: BrainApi, useValue: { getEntitiesByIds: () => of({ entities: [] }), getRecord: () => of({}) } },
      { provide: DuplicatesApi, useValue: {
        listDuplicates: () => of({ duplicates: [pair(ADA), pair(GRACE)] }),
        scanDuplicates: () => of({}), dismissDuplicate: () => of({ status: 'ok' }),
        mergeDuplicate: merge,
      } },
      { provide: ContradictionsApi, useValue: { listContradictions: () => of({ contradictions: [] }) } },
      { provide: ToastService, useValue: {
        error: (m: string) => toastErrors.push(m), success: (m: string) => toastOther.push(m), info: (m: string) => toastOther.push(m), show: (m: string) => toastOther.push(m),
      } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const f = TestBed.createComponent(ReviewTabComponent);
  f.componentInstance.spaceId = 'work';
  f.detectChanges();
  return { f, c: f.componentInstance, host: f.nativeElement as HTMLElement, toastErrors, toastOther };
}

const refusals = (host: HTMLElement): HTMLElement[] => Array.from(host.querySelectorAll<HTMLElement>(ROW));
const isAlert = (el: HTMLElement): boolean => el.getAttribute('role') === 'alert' || el.querySelector('[role="alert"]') !== null;
const textOf = (el: HTMLElement | undefined): string => (el?.textContent ?? '').replace(/\s+/g, ' ');

/** Every place the client calls the merge API from, derived from the sources and not listed. */
function mergeCallSites(): string[] {
  return trackedAppSources()
    .filter(f => f !== 'src/app/core/duplicates-api.service.ts')
    .filter(f => /\.mergeDuplicate\s*\(/.test(stripComments(readFileSync(resolve(CLIENT_ROOT, f), 'utf8'))));
}

/** How each call site is driven to a refused merge of `d`: the review tab is the only one today. */
const DRIVERS: Record<string, (c: ReviewTabComponent, d: DuplicateRecord) => Promise<void>> = {
  'src/app/pages/brain/review-tab.component.ts': (c, d) => c.merge(d),
};

describe('every call site of the merge API is covered by a driver here', () => {
  it('derives a non-empty set and every site in it has a driver', () => {
    const sites = mergeCallSites();
    expect(sites.length, 'no merge call site found: the derivation is broken').toBeGreaterThanOrEqual(1);
    expect(sites.filter(s => !(s in DRIVERS)), 'a merge door has no refusal coverage: add a driver for it').toEqual([]);
  });
});

describe.each(Object.entries(DRIVERS))('a refused merge in %s', (_site, drive) => {
  beforeEach(() => TestBed.resetTestingModule());
  afterEach(() => { vi.useRealTimers(); });

  it('renders a persistent role=alert row in the list naming the pair and the introduced keys, and raises no toast', async () => {
    const { f, c, host, toastErrors, toastOther } = setup(() => throwError(() => bringsIn(['born', 'nickname'])));
    await drive(c, pair(ADA));
    f.detectChanges();
    const rows = refusals(host);
    expect(rows.length, 'no [data-testid="merge-refusal"] row after a refused merge').toBe(1);
    expect(isAlert(rows[0]), 'the refusal row is not announced (role=alert)').toBe(true);
    const t = textOf(rows[0]);
    expect(t, 'the row does not name the pair that was refused').toContain('Ada Lovelace');
    expect(t).toContain('A. Lovelace');
    expect(t, 'the other pair is named in this pair\'s refusal').not.toContain('Grace Hopper');
    expect(t, 'the introduced key born is not named').toMatch(/born/);
    expect(t, 'the introduced key nickname is not named').toMatch(/nickname/);
    expect(t, 'the machine code is shown to the reviewer').not.toMatch(/schema_violation/);
    expect(toastErrors, 'a refusal about one pair in a list must not be a toast').toEqual([]);
    expect(toastOther).toEqual([]);
    expect(c.rows().map(r => r.id), 'a refused merge must leave the pair in the list').toEqual(['d1', 'd2']);
    expect(host.textContent).toContain('Ada Lovelace');
  });

  it('is not a toast, and in particular never a toast that reads the error code', async () => {
    const { f, c, toastErrors, toastOther } = setup(() => throwError(() => bringsIn(['born'])));
    await drive(c, pair(ADA));
    f.detectChanges();
    expect(toastErrors, 'the refusal was raised as an error toast').toEqual([]);
    expect(toastOther).toEqual([]);
  });

  it('is still there a minute later and after further change detection', async () => {
    vi.useFakeTimers();
    const { f, c, host } = setup(() => throwError(() => bringsIn(['born'])));
    await drive(c, pair(ADA));
    f.detectChanges();
    expect(refusals(host).length, 'precondition: the refusal row is shown').toBe(1);
    vi.advanceTimersByTime(60_000);
    f.detectChanges();
    f.detectChanges();
    expect(refusals(host).length, 'the refusal went away on its own').toBe(1);
    expect(textOf(refusals(host)[0])).toMatch(/born/);
  });

  it('can be dismissed, and dismissing one pair\'s refusal leaves another pair\'s', async () => {
    const { f, c, host } = setup((id: string) => throwError(() => bringsIn(id === 'd1' ? ['born'] : ['shoeSize'])));
    await drive(c, pair(ADA));
    await drive(c, pair(GRACE));
    f.detectChanges();
    const rows = refusals(host);
    expect(rows.length, 'one row per refused pair').toBe(2);
    const ada = rows.find(r => textOf(r).includes('Ada Lovelace'));
    const grace = rows.find(r => textOf(r).includes('Grace Hopper'));
    expect(ada && textOf(ada)).toMatch(/born/);
    expect(grace && textOf(grace)).toMatch(/shoeSize/);
    const close = ada!.querySelector<HTMLElement>(DISMISS);
    expect(close, 'no [data-testid="merge-refusal-dismiss"] inside the refusal row').not.toBeNull();
    close!.click();
    f.detectChanges();
    const left = refusals(host);
    expect(left.length).toBe(1);
    expect(textOf(left[0])).toContain('Grace Hopper');
    expect(c.rows().map(r => r.id), 'dismissing a refusal must not touch the pairs').toEqual(['d1', 'd2']);
  });

  it('reads the message sentence and never the error code, when the rows say nothing more', async () => {
    const sentence = 'Merging these two would leave the survivor with a key its type does not declare.';
    const { f, c, host, toastErrors } = setup(() => throwError(() => ({
      status: 400, error: { error: 'schema_violation', message: sentence, introduced: [], preExisting: [], violations: [] },
    })));
    await drive(c, pair(ADA));
    f.detectChanges();
    const rows = refusals(host);
    expect(rows.length, 'a refusal with a sentence and no rows is still a refusal the reviewer must see').toBe(1);
    expect(textOf(rows[0])).toContain(sentence);
    expect(textOf(rows[0]), 'the code is read instead of the sentence').not.toMatch(/schema_violation/);
    expect(toastErrors).toEqual([]);
  });

  it('does not render a refusal row for a merge that succeeded', async () => {
    const { f, c, host } = setup(() => of({ status: 'merged', survivorId: 'd1a' }));
    await drive(c, pair(ADA));
    f.detectChanges();
    expect(refusals(host)).toEqual([]);
    expect(c.rows().map(r => r.id)).toEqual(['d2']);
  });
});
