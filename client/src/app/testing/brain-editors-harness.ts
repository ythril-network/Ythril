/**
 * The brain record editors as DATA, so a spec about what every editor does with an answer is written once and run over all of them.
 *
 * ## Why this exists
 *
 * There are five places a record is written from the Brain page: the entities, facts, edges and chrono tabs (each with a create
 * form and an inline edit row) and the record drawer (one component, four kinds). A rule about what an editor does with the
 * server's answer (a warning on success, a refusal, a property marked invalid) has to hold in all five, and the existing specs
 * each carry their own copy of the mount code, so a rule asserted in one is silently absent from the next. The per-kind
 * differences (which API method, which form model, which minimal record) are exactly the table below; nothing else differs.
 *
 * The set of tab editors is DERIVED (`derivedEditorTabFiles`: a tracked `*-tab.component.ts` in pages/brain whose template
 * uses the properties editor), and a spec asserts every derived file has a row here, so a fifth editor written next year is
 * caught as an uncovered editor and not as a green run.
 *
 * Nothing here knows a selector the change under test introduces except through the named helpers at the bottom
 * (`writeWarningsNotice`, `propertyValueInput`), which are the contract's own names.
 */
import { TestBed, type ComponentFixture } from '@angular/core/testing';
import { provideRouter } from '@angular/router';
import type { Type } from '@angular/core';
import { vi } from 'vitest';
import { of, throwError, type Observable } from 'rxjs';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { getTranslocoModule } from './transloco-testing';
import { CLIENT_ROOT, trackedAppSources } from './tracked-sources';
import { aMemory, anEntity, anEdge, aChrono } from './records';
import { BrainApi } from '../core/brain-api.service';
import { ToastService } from '../core/toast.service';
import { BrainStore } from '../pages/brain/brain-store.service';
import { EntityRefPicker } from '../pages/brain/entity-ref-picker.service';
import { RecordDrawerState } from '../pages/brain/record-drawer-state.service';
import { RecordListState } from '../pages/brain/record-list-state.service';
import { RecordDrawerComponent } from '../pages/brain/record-drawer.component';
import { EntitiesTabComponent } from '../pages/brain/entities-tab.component';
import { FactsTabComponent } from '../pages/brain/facts-tab.component';
import { EdgesTabComponent } from '../pages/brain/edges-tab.component';
import { ChronoTabComponent } from '../pages/brain/chrono-tab.component';

/** A row of a refusal or a warning, as the server writes it (`SchemaViolationError.toStructured()`). */
export interface WireRow {
  field: string;
  value?: unknown;
  reason: string;
  declared?: string[];
  outcome?: 'violated' | 'could_not_evaluate' | 'too_large';
}

/** The refusal body: HTTP 422 on an update, 400 on a create. */
export function refusalBody(over: Partial<{ message: string; introduced: WireRow[]; preExisting: WireRow[]; truncated: number }> = {}) {
  const introduced = over.introduced ?? [];
  const preExisting = over.preExisting ?? [];
  return {
    error: 'schema_violation',
    message: over.message ?? 'The write was refused.',
    introduced,
    preExisting,
    violations: [...introduced, ...preExisting],
    ...(over.truncated !== undefined ? { truncated: over.truncated } : {}),
  };
}

/** What the HttpClient hands an `error` callback. */
export function httpFailure(status: number, body: unknown): { status: number; error: unknown } {
  return { status, error: body };
}

// `any`, not Record<string, any>: the tabs and the drawer are driven through members the harness cannot type (forms, handlers), and under
// noPropertyAccessFromIndexSignature a record type turns every dotted access into a compile error.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Anything = any;

/** One tab editor: how to mount it and how to drive its create form and its inline edit with the least valid input. */
export interface TabEditor {
  /** The tracked source file this row covers (relative to client/). */
  file: string;
  kind: 'entity' | 'fact' | 'edge' | 'chrono';
  component: Type<unknown>;
  listApi: string;
  listKey: string;
  createApi: string;
  updateApi: string;
  /** The BrainStore signal the rows live in, and the tab's two form models. */
  storeList: 'entities' | 'facts' | 'edges' | 'chrono';
  createForm: string;
  editForm: string;
  record(over?: Anything): Anything;
  /** Open the create form and fill the least valid input; `properties` (when given) is what the properties editor starts with. */
  openCreate(c: Anything, properties?: Record<string, string | number | boolean>): void;
  submitCreate(c: Anything): void;
  /** Open the inline edit row for `record` (already in the store) and submit it. */
  openEdit(c: Anything, record: Anything, properties?: Record<string, string | number | boolean>): void;
  submitEdit(c: Anything, id: string): void;
}

const withProps = (model: Anything, properties?: Record<string, string | number | boolean>): void => {
  if (properties) model['properties'] = { ...properties };
};

export const TAB_EDITORS: TabEditor[] = [
  {
    file: 'src/app/pages/brain/entities-tab.component.ts', kind: 'entity', component: EntitiesTabComponent,
    listApi: 'listEntities', listKey: 'entities', createApi: 'createEntity', updateApi: 'updateEntity',
    storeList: 'entities', createForm: 'entityForm', editForm: 'editEntity',
    record: over => anEntity({ _id: 'r1', name: 'Ann', type: 'Person', ...over }),
    openCreate(c, properties) {
      c.openEntityForm();
      c.entityForm = { name: 'Ann', type: 'Person', tags: [], description: '', properties: {} };
      withProps(c.entityForm, properties);
    },
    submitCreate: c => c.createEntity(),
    openEdit(c, record, properties) { c.startEditEntity(record); withProps(c.editEntity, properties); },
    submitEdit: (c, id) => c.saveEditEntity(id),
  },
  {
    file: 'src/app/pages/brain/facts-tab.component.ts', kind: 'fact', component: FactsTabComponent,
    listApi: 'listFacts', listKey: 'facts', createApi: 'createMemory', updateApi: 'updateFact',
    storeList: 'facts', createForm: 'memoryForm', editForm: 'editMemory',
    record: over => aMemory({ _id: 'r1', fact: 'a fact', ...over }),
    openCreate(c, properties) {
      c.openMemoryForm();
      c.memoryForm.fact = 'a fact';
      withProps(c.memoryForm, properties);
    },
    submitCreate: c => c.createMemory(),
    openEdit(c, record, properties) { c.startEditMemory(record); withProps(c.editMemory, properties); },
    submitEdit: (c, id) => c.saveEditMemory(id),
  },
  {
    file: 'src/app/pages/brain/edges-tab.component.ts', kind: 'edge', component: EdgesTabComponent,
    listApi: 'listEdges', listKey: 'edges', createApi: 'createEdge', updateApi: 'updateEdge',
    storeList: 'edges', createForm: 'edgeForm', editForm: 'editEdge',
    record: over => anEdge({ _id: 'r1', from: 'a', to: 'b', label: 'knows', ...over }),
    openCreate(c, properties) {
      c.openEdgeForm();
      Object.assign(c.edgeForm, { from: 'a', to: 'b', label: 'knows' });
      withProps(c.edgeForm, properties);
    },
    submitCreate: c => c.createEdge(),
    openEdit(c, record, properties) { c.startEditEdge(record); withProps(c.editEdge, properties); },
    submitEdit: (c, id) => c.saveEditEdge(id),
  },
  {
    file: 'src/app/pages/brain/chrono-tab.component.ts', kind: 'chrono', component: ChronoTabComponent,
    listApi: 'listChrono', listKey: 'chrono', createApi: 'createChrono', updateApi: 'updateChrono',
    storeList: 'chrono', createForm: 'chronoForm', editForm: 'editChrono',
    record: over => aChrono({ _id: 'r1', title: 'T', type: 'event', ...over }),
    openCreate(c, properties) {
      c.openChronoForm();
      Object.assign(c.chronoForm, { title: 'T', kind: 'event', startsAt: '2026-08-01T09:00' });
      withProps(c.chronoForm, properties);
    },
    submitCreate: c => c.createChrono(),
    openEdit(c, record, properties) { c.startEditChrono(record); withProps(c.editChrono, properties); },
    submitEdit: (c, id) => c.saveEditChrono(id),
  },
];

/** One kind of the record drawer. */
export interface DrawerEditor {
  kind: 'entity' | 'fact' | 'edge' | 'chrono';
  updateApi: string;
  editModel: string;
  record(over?: Anything): Anything;
}

export const DRAWER_EDITORS: DrawerEditor[] = [
  { kind: 'entity', updateApi: 'updateEntity', editModel: 'drawerEditEntity', record: over => anEntity({ _id: 'r1', name: 'Ann', type: 'Person', ...over }) },
  { kind: 'fact', updateApi: 'updateFact', editModel: 'drawerEditMemory', record: over => aMemory({ _id: 'r1', fact: 'a fact', ...over }) },
  { kind: 'edge', updateApi: 'updateEdge', editModel: 'drawerEditEdge', record: over => anEdge({ _id: 'r1', from: 'a', to: 'b', label: 'knows', ...over }) },
  { kind: 'chrono', updateApi: 'updateChrono', editModel: 'drawerEditChrono', record: over => aChrono({ _id: 'r1', title: 'T', type: 'event', ...over }) },
];

/** Tracked tab components of the Brain page that edit records through the properties editor: what must have a row above. */
export function derivedEditorTabFiles(): string[] {
  return trackedAppSources()
    .filter(f => f.startsWith('src/app/pages/brain/') && f.endsWith('-tab.component.ts'))
    .filter(f => readFileSync(resolve(CLIENT_ROOT, f), 'utf8').includes('app-properties-editor'));
}

/** The kinds the drawer edits, read out of `DrawerRecord` in its own source rather than listed again here. */
export function derivedDrawerKinds(): string[] {
  const src = readFileSync(resolve(CLIENT_ROOT, 'src/app/pages/brain/record-drawer-state.service.ts'), 'utf8');
  const union = src.slice(src.indexOf('export type DrawerRecord'), src.indexOf('@Injectable'));
  return [...union.matchAll(/kind:\s*'(\w+)'/g)].map(m => m[1]);
}

/**
 * Editors the source has and the tables above do not cover. A spec asserts this is empty (and that the derived sets are not),
 * so adding an editor to the Brain page without a row here fails the spec instead of leaving the new editor untested.
 */
export function uncoveredEditors(): string[] {
  const tabs = derivedEditorTabFiles();
  const kinds = derivedDrawerKinds();
  return [
    ...tabs.filter(f => !TAB_EDITORS.some(e => e.file === f)).map(f => `tab ${f}`),
    ...kinds.filter(k => !DRAWER_EDITORS.some(e => e.kind === k)).map(k => `drawer kind ${k}`),
    ...TAB_EDITORS.filter(e => !tabs.includes(e.file)).map(e => `row for ${e.file} is not a derived editor tab`),
  ];
}

/** The API the editors call: every method the editors, the pickers and the lists touch, answering sync and empty. */
export function makeBrainApi(editor: { listApi?: string; listKey?: string; createApi?: string; updateApi: string }): Record<string, ReturnType<typeof vi.fn>> {
  const api: Record<string, ReturnType<typeof vi.fn>> = {
    getEntitiesByIds: vi.fn(() => of({ entities: [] })),
    getRecordsByIds: vi.fn(() => of([])),
    recallBrain: vi.fn(() => of({ results: [], count: 0 })),
    deleteEntity: vi.fn(() => of({})), deleteFact: vi.fn(() => of({})), deleteEdge: vi.fn(() => of({})), deleteChrono: vi.fn(() => of({})),
    [editor.updateApi]: vi.fn((_s: string, id: string) => of({ _id: id })),
  };
  if (editor.listApi && editor.listKey) api[editor.listApi] = vi.fn(() => of({ [editor.listKey!]: [] }));
  if (editor.createApi) api[editor.createApi] = vi.fn(() => of({ _id: 'new' }));
  return api;
}

export interface MountedTab {
  fixture: ComponentFixture<unknown>;
  c: Anything;
  host: HTMLElement;
  api: Record<string, ReturnType<typeof vi.fn>>;
  toast: ToastService;
  /** Queue the next answer of the create / update call: a record carrying `extra`, or a failure. */
  answerCreate(extra: Anything): void;
  answerUpdate(record: Anything, extra: Anything): void;
  failCreate(status: number, body: unknown): void;
  failUpdate(status: number, body: unknown): void;
}

/** Mount one tab editor over a mocked API; `translation` loads real words when a spec reads English. */
export function mountTab(editor: TabEditor, translation?: Record<string, string>): MountedTab {
  const api = makeBrainApi(editor);
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [editor.component, getTranslocoModule(translation ? { translation: { en: translation } } : {})],
    providers: [provideRouter([]), RecordListState, BrainStore, EntityRefPicker, RecordDrawerState, { provide: BrainApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(editor.component);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.detectChanges();
  const next = (name: string, v: Observable<unknown>): void => { api[name].mockReturnValueOnce(v); };
  return {
    fixture, c: fixture.componentInstance as Anything, host: fixture.nativeElement as HTMLElement, api,
    toast: TestBed.inject(ToastService),
    answerCreate: extra => next(editor.createApi, of({ _id: 'new', ...extra })),
    answerUpdate: (record, extra) => next(editor.updateApi, of({ ...record, ...extra })),
    failCreate: (status, body) => next(editor.createApi, throwError(() => httpFailure(status, body))),
    failUpdate: (status, body) => next(editor.updateApi, throwError(() => httpFailure(status, body))),
  };
}

export interface MountedDrawer {
  fixture: ComponentFixture<RecordDrawerComponent>;
  state: RecordDrawerState;
  host: HTMLElement;
  api: Record<string, ReturnType<typeof vi.fn>>;
  toast: ToastService;
  answerUpdate(record: Anything, extra: Anything): void;
  failUpdate(status: number, body: unknown): void;
}

/** Mount the record drawer over a mocked API for one kind, already holding no record. */
export function mountDrawer(editor: DrawerEditor, translation?: Record<string, string>): MountedDrawer {
  const api = makeBrainApi(editor);
  api['listFacts'] = vi.fn(() => of({ facts: [] }));
  api['listChrono'] = vi.fn(() => of({ chrono: [] }));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [RecordDrawerComponent, getTranslocoModule(translation ? { translation: { en: translation } } : {})],
    providers: [RecordDrawerState, BrainStore, EntityRefPicker, { provide: BrainApi, useValue: api }],
  });
  const fixture = TestBed.createComponent(RecordDrawerComponent);
  fixture.detectChanges();
  const state = TestBed.inject(RecordDrawerState);
  state.spaceId.set('work');
  return {
    fixture, state, host: fixture.nativeElement as HTMLElement, api, toast: TestBed.inject(ToastService),
    answerUpdate: (record, extra) => api[editor.updateApi].mockReturnValueOnce(of({ ...record, ...extra })),
    failUpdate: (status, body) => api[editor.updateApi].mockReturnValueOnce(throwError(() => httpFailure(status, body))),
  };
}

/** Render, let ngModel write its values (it does so in a microtask), render again. */
export async function settle(fixture: ComponentFixture<unknown>): Promise<void> {
  fixture.detectChanges();
  await fixture.whenStable();
  fixture.detectChanges();
}

/** The persistent notice for the warnings of a successful write (contract name). */
export const WARNINGS_SELECTOR = '[data-testid="write-warnings"]';
export const WARNINGS_DISMISS_SELECTOR = '[data-testid="write-warnings-dismiss"]';

export function writeWarningsNotice(host: HTMLElement): HTMLElement | null {
  return host.querySelector<HTMLElement>(WARNINGS_SELECTOR);
}

/** The value input of the properties-editor row whose key input holds `key`; null when no such row. Call after `settle`. */
export function propertyValueInput(host: HTMLElement, key: string): HTMLElement | null {
  for (const row of Array.from(host.querySelectorAll('.prop-row'))) {
    const keyInput = row.querySelector<HTMLInputElement>('input.prop-key');
    if (keyInput?.value === key) return row.querySelector<HTMLElement>('.prop-val');
  }
  return null;
}

/** The text of the element `input` says describes it (`aria-describedby`), or null when it names none or the id is absent. */
export function describedByText(host: HTMLElement, input: HTMLElement): string | null {
  const ids = (input.getAttribute('aria-describedby') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.length) return null;
  const parts = ids.map(id => host.ownerDocument.getElementById(id)?.textContent?.trim() ?? '');
  return parts.every(p => p === '') ? null : parts.join(' ');
}
