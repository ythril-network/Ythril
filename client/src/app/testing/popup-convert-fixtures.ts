import { ChangeDetectorRef } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { HttpErrorResponse, HttpHeaders } from '@angular/common/http';
import { Router } from '@angular/router';
import { expect, vi } from 'vitest';
import { of, throwError, type Observable } from 'rxjs';
import { AuthApi } from '../core/auth-api.service';
import { ConfirmDialogService } from '../core/confirm-dialog.service';
import { blockCounts, type ConvertBlock } from '../core/conversion-counts';
import { ConversionApi } from '../core/conversion-api.service';
import type { ConversionResult, ConvertStatusAnswer } from '../core/conversion.types';
import type { Space } from '../core/api.types';
import { NetworksApi } from '../core/networks-api.service';
import { SchemaApi } from '../core/schema-api.service';
import { SpacesApi } from '../core/spaces-api.service';
import { ToastService } from '../core/toast.service';
import { SpaceSettingsPopupComponent } from '../pages/settings/space-settings-popup.component';
import { SpaceSettingsState } from '../pages/settings/space-settings-state.service';
import { SpacesStore } from '../pages/settings/spaces-store.service';
import type { TokenRights } from '../pages/settings/rights-glyph.component';
import { dictionary } from './i18n-dictionary';
import { NO_TYPE_READS } from './schema-type-reads';
import { getTranslocoModule } from './transloco-testing';
import { instanceAdminRights, runningStatus } from './review-unconverted-fixtures';

/**
 * What the specs of the Save wiring share (bundle-285 slice S6, Q-747): a settings popup with the shipped English loaded, a space that holds
 * two entity types, and every collaborator the Save reaches (the save, the counts, the run's status, the token, the router) as a spy.
 *
 * Two spec files read it (the popup's convert wiring and its networked variant), so the space, the counts and the mount are written once.
 */

/** The English as the shipped file has it, flat: a key a component asks for and the file lacks renders as the key itself. */
export const EN: Record<string, string> = dictionary('en');

/** `customers` with two entity types; `person` has the property the specs rename. Its meta version is what the save's If-Match carries. */
export const customers = (over: Partial<Space> = {}): Space => ({
  id: 'customers', label: 'Customers', maxGiB: 10, networks: [],
  meta: {
    version: 3,
    typeSchemas: {
      entity: {
        person: { propertySchemas: { company: { type: 'string' }, email: { type: 'string' }, status: { type: 'string', enum: ['active', 'lead'] } } },
        contact: { propertySchemas: { name: { type: 'string' } } },
      },
    },
  },
  ...over,
}) as unknown as Space;

/** What the counting reads answer per type, by the type's stored name. */
export type RecordsByType = Record<string, { total: number; rewritten: number }>;
export const PERSON_RECORDS: RecordsByType = { person: { total: 640, rewritten: 599 }, contact: { total: 318, rewritten: 318 } };

/** One refused save, as the HTTP client throws it: `body` is what the server answered. */
export const refusedSave = (status: number, body: Record<string, unknown>, headers: Record<string, string> = {}): Observable<never> =>
  throwError(() => new HttpErrorResponse({ status, error: body, headers: new HttpHeaders(headers) }));

export interface HarnessOptions {
  space?: Space;
  /** The save: given the body and options it was sent with, the answer. Absent: applied, with the space as it was. */
  update?: (body: Record<string, unknown>, options: { ifMatch?: number }) => Observable<unknown>;
  /** The counts the dialog and the footer read; `'fail'` makes every count fail. Absent: `PERSON_RECORDS`. */
  records?: RecordsByType | 'fail';
  /** What each read of the run's status answers, in order; the last repeats. Absent: a run in progress that never ends. */
  statuses?: ConversionResult<ConvertStatusAnswer>[];
  /** The token's rights; absent is an instance administrator. */
  rights?: TokenRights;
}

export const okStatus = (value: ConvertStatusAnswer): ConversionResult<ConvertStatusAnswer> => ({ ok: true, value });
export const doneStatus = (over: Record<string, unknown> = {}): ConvertStatusAnswer => ({
  ...runningStatus({ left: 0, counts: { stamped: 41, rewritten: 599, unconverted: 4, moved: 0, edgesRestamped: 0 } }),
  state: 'complete', types: [{ kind: 'entity', type: 'person', done: true }], finishedAt: '2026-11-19T10:05:00.000Z', ...over,
}) as ConvertStatusAnswer;

/** Mount the popup with the space open and the Schema tab's state in place; nothing is edited yet. */
export function mountPopup(options: HarnessOptions = {}) {
  const space = options.space ?? customers();
  const updates: { body: Record<string, unknown>; options: { ifMatch?: number } }[] = [];
  const updateSpace = vi.fn((_id: string, body: Record<string, unknown>, opts: { ifMatch?: number } = {}) => {
    updates.push({ body, options: opts });
    return (options.update ?? (() => of({ space })))(body, opts);
  });
  const records = options.records ?? PERSON_RECORDS;
  const countsFor = vi.fn((_space: string, block: ConvertBlock) => {
    if (records === 'fail') return of({ ok: false as const });
    const r = records[block.was ?? block.type] ?? { total: 0, rewritten: 0 };
    return of({ ok: true as const, counts: blockCounts(block, { total: r.total, rewritten: r.rewritten }) });
  });
  const sequence = options.statuses ?? [okStatus(runningStatus())];
  let read = 0;
  const status = vi.fn(() => of(sequence[Math.min(read++, sequence.length - 1)]!));
  const start = vi.fn(() => of({ ok: true as const, value: { state: 'started', toFp: 'fp', types: [], steps: 0 } }));
  const navigate = vi.fn(() => Promise.resolve(true));

  const api = {
    listSpaces: () => of({ spaces: [space] }), list: () => of({ spaces: [space] }), getActivity: () => of({ spaces: [] }),
    updateSpace, getSchema: () => of({ meta: {} }), listEntries: () => of({ entries: [] }), listSchemaLibrary: () => of({ entries: [] }),
    getSchemaLayers: () => of({ spaceId: space.id, own: {}, layers: [], precedence: [], clashes: [] }),
    getSpaceStats: () => of({ spaceId: space.id, facts: 1, entities: 2, edges: 3, chrono: 4, files: 5 }),
    listVotes: () => of({ rounds: [] }),
  };
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceSettingsPopupComponent, getTranslocoModule({ translation: { en: EN } })],
    providers: [
      SpaceSettingsState, SpacesStore,
      { provide: SpacesApi, useValue: api },
      { provide: NetworksApi, useValue: api },
      { provide: SchemaApi, useValue: { ...api, ...NO_TYPE_READS } },
      { provide: ConversionApi, useValue: { countsFor, status, start, refusedCount: () => of(0), olderCount: () => of(0) } },
      { provide: AuthApi, useValue: { verifyToken: () => of({ id: 't', name: 't', rights: options.rights ?? instanceAdminRights() }) } },
      { provide: Router, useValue: { navigate } },
      { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: () => Promise.resolve(true) } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceSettingsPopupComponent);
  fixture.detectChanges();
  const popup = fixture.componentInstance;
  const state = popup.state;
  const root = fixture.nativeElement as HTMLElement;

  // The settings state is plain fields, not signals: a render follows an edit only because the EDIT was an event, which marks its view dirty. A spec
  // that edits the state in code has to say so, or no render (and no hook that runs after one) follows.
  const settle = (): void => { fixture.componentRef.injector.get(ChangeDetectorRef).markForCheck(); fixture.detectChanges(); fixture.detectChanges(); };
  const q = <T extends HTMLElement>(id: string): T | null => root.querySelector<T>(`[data-testid="${id}"]`);
  const text = (id: string): string => q(id)?.textContent?.replace(/\s+/g, ' ').trim() ?? '';
  const click = (id: string): void => { const el = q(id); if (!el) throw new Error(`nothing to click: [data-testid="${id}"]`); el.click(); settle(); };
  return {
    fixture, popup, state, root, updates, updateSpace, countsFor, status, start, navigate, settle, q, text, click,
    /** Open the space, as a host does. */
    open(): void { state.openSettings(space); settle(); },
    /** Rename `person`'s `company` to `employer`: one changed type, one proposed step. */
    renameCompany(): void { expect(state.renameProp('entity', 'person', 'company', 'employer')).toBeNull(); settle(); },
    /** What a Save with nothing else going on would send now. */
    todaysBody: () => state.changedSettings(),
  };
}
