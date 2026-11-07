/**
 * The Settings dialogs that hold a draft ask before Escape, X, Cancel or a backdrop click discards it (Q-713, bundle-247).
 *
 * `holdUnsavedEdits` (Q-701) made leaving a PAGE ask while one of these is open and dirty; the dialogs' own dismiss still closed at once, so a
 * typed token name, invite, hostname or webhook url went with one Escape. Each dialog below is mounted open, dirtied through its own fields and
 * dismissed every way it offers (`testing/dialog-dismiss-harness.ts`): a clean dialog closes without a question, a dirty one asks, a refusal
 * keeps it open, and a yes closes it.
 *
 * ## Seen red at 45f888b0
 *
 * `ConfirmDialogService.confirm` was never called for a dirty dismiss: every dirty case closed the dialog without asking.
 */
import type { Type } from '@angular/core';
import { signal } from '@angular/core';
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { dialogDismissSpecs } from '../../testing/dialog-dismiss-harness';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { AdminApi } from '../../core/admin-api.service';
import { AuthApi } from '../../core/auth-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { SpacesStore } from './spaces-store.service';
import { SpaceSettingsState, emptyTypeSchemaState } from './space-settings-state.service';
import { NetworkCreateDialogComponent } from './network-create-dialog.component';
import { NetworkEnableWizardComponent } from './network-enable-wizard.component';
import { NetworkJoinDialogComponent } from './network-join-dialog.component';
import { NetworkRereadDialogComponent } from './network-reread-dialog.component';
import { SpaceCreateDialogComponent } from './space-create-dialog.component';
import { SpaceSchemaTabComponent } from './space-schema-tab.component';
import { TokenCreateDialogComponent } from './token-create-dialog.component';
import { TokenRightsDialogComponent } from './token-rights-dialog.component';
import { WebhooksComponent } from './webhooks.component';

const toast = { show: vi.fn(), success: vi.fn(), error: vi.fn(), info: vi.fn() };

/** Mount `component` open with `inputs`, and count the emissions of its close output. */
function mountWithClose<T>(component: Type<T>, inputs: Record<string, unknown>, closeOutput: string, providers: unknown[]) {
  TestBed.configureTestingModule({ imports: [component, getTranslocoModule()], providers: providers as never[] });
  const fixture = TestBed.createComponent(component);
  for (const [k, v] of Object.entries(inputs)) fixture.componentRef.setInput(k, v);
  let closed = 0;
  (fixture.componentInstance as Record<string, { subscribe(f: () => void): unknown }>)[closeOutput]!.subscribe(() => { closed++; });
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance as any, closes: () => closed };
}

const networkProviders = [
  {
    provide: NetworksApi,
    useValue: {
      getLocalAgentStatus: vi.fn(() => of({ canExecute: false })),
      bootstrapLocalAgent: vi.fn(() => of({})),
    },
  },
  { provide: ToastService, useValue: toast },
];

dialogDismissSpecs('the network create dialog', {}, () => {
  const d = mountWithClose(NetworkCreateDialogComponent, {}, 'close', networkProviders);
  return { fixture: d.fixture, closes: d.closes, edit: () => { d.c.form.label = 'Field offices'; } };
});

dialogDismissSpecs('the network join dialog', {}, () => {
  const d = mountWithClose(NetworkJoinDialogComponent, { myUrl: 'https://me.example' }, 'close', networkProviders);
  return { fixture: d.fixture, closes: d.closes, edit: () => { d.c.joinBundle = '{"handshakeId":"h"}'; } };
});

dialogDismissSpecs('the network enable wizard', {}, () => {
  const d = mountWithClose(NetworkEnableWizardComponent, {}, 'close', networkProviders);
  return { fixture: d.fixture, closes: d.closes, edit: () => { d.c.enableHostname = 'brain.example.com'; } };
});

dialogDismissSpecs('the network re-read dialog', {}, () => {
  const d = mountWithClose(NetworkRereadDialogComponent, { networkName: 'Net', spaces: [{ id: 'a', records: 1 }, { id: 'b', records: 2 }] }, 'closed', networkProviders);
  return { fixture: d.fixture, closes: d.closes, edit: () => { d.c.typedName.set('Net'); } };
});

dialogDismissSpecs('the space create dialog', { cancel: null }, () => {
  const d = mountWithClose(SpaceCreateDialogComponent, {}, 'closed', [
    SpacesStore,
    { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [], retiredSpaceIds: [] }), createSpace: () => of({ space: { id: 'x' } }) } },
    { provide: NetworksApi, useValue: { listNetworks: () => of({ networks: [] }) } },
  ]);
  return { fixture: d.fixture, closes: d.closes, edit: () => { d.c.form.label = 'Field notes'; } };
});

const RIGHTS = { instanceAdmin: false, createSpaces: false, floor: null, perSpace: {} };
const TOKEN = { id: 't1', name: 'one', spaces: [], rights: RIGHTS };
const tokenProviders = [
  { provide: AuthApi, useValue: { createToken: vi.fn(() => of({ token: TOKEN, plaintext: 'tok_x' })), updateToken: vi.fn(() => of({ token: TOKEN })) } },
  { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
  { provide: ToastService, useValue: toast },
];

dialogDismissSpecs('the token create dialog', {}, () => {
  const d = mountWithClose(TokenCreateDialogComponent, {}, 'close', tokenProviders);
  return { fixture: d.fixture, closes: d.closes, edit: () => { d.c.newName = 'ci-bot'; } };
});

dialogDismissSpecs('the token rights dialog', {}, () => {
  const d = mountWithClose(TokenRightsDialogComponent, { token: TOKEN, availableSpaces: [] }, 'close', tokenProviders);
  return { fixture: d.fixture, closes: d.closes, edit: () => { d.c.draftName = 'renamed'; } };
});

dialogDismissSpecs('the webhook create dialog', {}, () => {
  TestBed.configureTestingModule({
    imports: [WebhooksComponent, getTranslocoModule()],
    providers: [
      { provide: AdminApi, useValue: { listWebhooks: vi.fn(() => of({ webhooks: [] })), createWebhook: vi.fn(), updateWebhook: vi.fn() } },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [] }) } },
      { provide: ToastService, useValue: toast },
    ],
  });
  const fixture = TestBed.createComponent(WebhooksComponent);
  const c = fixture.componentInstance;
  fixture.detectChanges();
  c.openCreate();
  fixture.detectChanges();
  return { fixture, closes: () => (c.form() === null ? 1 : 0), edit: () => { c.form()!.url = 'https://hook.example.com/x'; } };
});

/** The Schema tab renders two draft-holding dialogs: the export-to-library one and the import-conflict one. */
function schemaTab() {
  TestBed.configureTestingModule({
    imports: [SpaceSchemaTabComponent, getTranslocoModule()],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: {} },
      { provide: ToastService, useValue: toast },
      { provide: SpacesStore, useValue: { spaces: signal([]), networks: signal([]), networksLoaded: signal(true), refreshNetworks: () => {}, networksForSpace: () => [], load: () => {} } },
      { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }), upsertSchemaLibraryEntry: () => of({ entry: {} }), exportSpaceSchemaToLibrary: () => of({ created: 1, updated: 0 }) } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceSchemaTabComponent);
  const state = TestBed.inject(SpaceSettingsState);
  state.settingsSpace.set({ id: 'proj', label: 'Project', meta: {} } as never);
  vi.spyOn(state, 'isDirty').mockReturnValue(false);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance as any };
}

dialogDismissSpecs('the schema tab export-to-library dialog', { backdrop: true }, () => {
  const { fixture, c } = schemaTab();
  c.openExportToLibrary();
  fixture.detectChanges();
  return {
    fixture,
    closes: () => (c.exportLibDialog() === null ? 1 : 0),
    edit: () => { c.exportLibDialog.set({ ...c.exportLibDialog()!, groupName: 'My group' }); },
  };
});

dialogDismissSpecs('the schema tab import-conflict dialog', { x: null }, () => {
  const { fixture, c } = schemaTab();
  c.importConflict.set({ kt: 'entity', name: 'person', state: emptyTypeSchemaState({}), allowAddAs: true });
  c.importConflictAddAsName.set('person-2');
  fixture.detectChanges();
  return {
    fixture,
    closes: () => (c.importConflict() === null ? 1 : 0),
    edit: () => { c.importConflictAddAsName.set('human'); },
  };
});
