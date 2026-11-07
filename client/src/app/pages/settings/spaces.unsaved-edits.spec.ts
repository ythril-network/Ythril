/**
 * The space settings surfaces hold their drafts (Q-701): the Danger tab (retention, the embeddings tick, the rename id), the network layers
 * order, the create dialog, a type's rename field, and the Schema tab's export-to-library dialog and import-conflict name.
 *
 * Before this, the spaces route's guard asked only about what `SpaceSettingsState.isDirty()` reads; the Danger tab's three drafts and these
 * other fields were outside it, so one sidebar click lost them. The dialogs' own dismiss asking first is held in
 * settings-dialogs.dismiss.spec.ts (Q-713).
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { describe, it, expect, vi } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { SpaceDangerTabComponent } from './space-danger-tab.component';
import { SpaceSchemaLayersComponent } from './space-schema-layers.component';
import { SpaceCreateDialogComponent } from './space-create-dialog.component';
import { SchemaTypeNameComponent } from './schema-type-name.component';
import { SpaceSchemaTabComponent } from './space-schema-tab.component';
import { SpaceSettingsState, emptyTypeSchemaState } from './space-settings-state.service';
import { SpacesStore } from './spaces-store.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

const SPACE = { id: 'proj', label: 'Project', meta: {}, recordTtlDays: { entity: 30 } };

function danger() {
  const updateSpace = vi.fn(() => of({ space: SPACE }));
  const renameSpace = vi.fn((_id: string, newId: string) => of({ space: { ...SPACE, id: newId } }));
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [SpaceDangerTabComponent, getTranslocoModule()],
    providers: [
      SpaceSettingsState,
      { provide: SpacesApi, useValue: { updateSpace, renameSpace, getSpaceStats: vi.fn(() => of({})), reembedSpace: vi.fn() } },
      { provide: NetworksApi, useValue: { listNetworks: vi.fn(() => of({ networks: [] })), leaveNetwork: vi.fn() } },
      { provide: SpacesStore, useValue: { spaces: signal([]), networks: signal([]), networksLoaded: signal(true), refreshNetworks: () => {}, networksForSpace: () => [], load: () => {} } },
      { provide: ToastService, useValue: { error: () => {}, success: () => {}, show: () => {} } },
      { provide: ConfirmDialogService, useValue: { confirm: vi.fn().mockResolvedValue(true) } },
    ],
  });
  const fixture = TestBed.createComponent(SpaceDangerTabComponent);
  const state = TestBed.inject(SpaceSettingsState);
  state.settingsSpace.set(SPACE as never);
  state.dangerRenameId = SPACE.id;
  TestBed.tick();
  fixture.detectChanges();
  return { c: fixture.componentInstance, state, edits: TestBed.inject(UnsavedEdits) };
}

describe('the space Danger tab holds its drafts (Q-701)', () => {
  it('is clean when opened', () => {
    expect(danger().edits.any()).toBe(false);
  });

  it('an edited retention window is held until it is saved', async () => {
    const { c, edits } = danger();
    c.ttl = { ...c.ttl, entity: 90 };
    expect(edits.any()).toBe(true);
    await c.saveRetention();
    expect(edits.any()).toBe(false);
  });

  it('a retention window typed back to the saved value is clean', () => {
    const { c, edits } = danger();
    c.ttl = { ...c.ttl, fact: 5 };
    c.ttl = { ...c.ttl, fact: null };
    expect(edits.any()).toBe(false);
  });

  it('the embeddings tick is held until it is saved', async () => {
    const { c, edits } = danger();
    c.suppress.set(true);
    expect(edits.any()).toBe(true);
    await c.saveSuppress();
    expect(edits.any()).toBe(false);
  });

  it('a typed rename id is held until the rename is done', async () => {
    const { c, state, edits } = danger();
    state.dangerRenameId = 'proj-2';
    expect(edits.any()).toBe(true);
    await c.submitDangerRename();
    expect(edits.any()).toBe(false);
  });
});

describe('the network layers order holds its dirty flag (Q-701)', () => {
  it('a moved network is held until the order is saved', () => {
    const view = { spaceId: 's', own: {}, precedence: ['a', 'b'], clashes: [], layers: [{ networkId: 'a', networkLabel: 'A', meta: {} }, { networkId: 'b', networkLabel: 'B', meta: {} }] };
    const api = { getSchemaLayers: vi.fn(() => of(view)), setNetworkPrecedence: vi.fn((_id: string, n: string[]) => of({ ...view, precedence: n })), proposeToNetwork: vi.fn() };
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SpaceSchemaLayersComponent, getTranslocoModule()],
      providers: [{ provide: SchemaApi, useValue: api }, { provide: ToastService, useValue: { success: vi.fn(), error: vi.fn() } }],
    });
    const f = TestBed.createComponent(SpaceSchemaLayersComponent);
    f.componentRef.setInput('spaceId', 's');
    f.detectChanges();
    const edits = TestBed.inject(UnsavedEdits);
    expect(edits.any()).toBe(false);
    f.componentInstance.move(0, 1);
    expect(edits.any()).toBe(true);
    f.componentInstance.save();
    expect(edits.any()).toBe(false);
  });
});

describe('the space create dialog holds its form (Q-701)', () => {
  function open() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SpaceCreateDialogComponent, getTranslocoModule()],
      providers: [
        SpacesStore,
        { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [], retiredSpaceIds: [] }), createSpace: () => of({ space: { id: 'x' } }) } },
        { provide: NetworksApi, useValue: { listNetworks: () => of({ networks: [] }) } },
      ],
    });
    const fixture = TestBed.createComponent(SpaceCreateDialogComponent);
    fixture.detectChanges();
    return { c: fixture.componentInstance, edits: TestBed.inject(UnsavedEdits) };
  }

  it('is clean when opened', () => {
    expect(open().edits.any()).toBe(false);
  });

  it('a typed label is held until the space is created', () => {
    const { c, edits } = open();
    c.form.label = 'Field notes';
    expect(edits.any()).toBe(true);
    c.createSpace();
    expect(edits.any()).toBe(false);
  });

  it('a changed validation mode is held', () => {
    const { c, edits } = open();
    c.form.validationMode = 'off';
    expect(edits.any()).toBe(true);
  });
});

describe('a type name being renamed is held (Q-701)', () => {
  function open(result: 'empty' | 'exists' | 'missing' | null) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({ imports: [SchemaTypeNameComponent, getTranslocoModule()] });
    const fixture = TestBed.createComponent(SchemaTypeNameComponent);
    fixture.componentRef.setInput('name', 'Person');
    fixture.componentRef.setInput('rename', () => result);
    fixture.detectChanges();
    return { c: fixture.componentInstance, edits: TestBed.inject(UnsavedEdits) };
  }

  it('is clean until the field is opened and changed', () => {
    const { c, edits } = open(null);
    expect(edits.any()).toBe(false);
    c.start();
    expect(edits.any()).toBe(false);
  });

  it('a changed name is held until it is committed', () => {
    const { c, edits } = open(null);
    c.start();
    c.draft = 'Persons';
    expect(edits.any()).toBe(true);
    c.commit();
    expect(edits.any()).toBe(false);
  });

  it('a refused name stays held, and a cancelled one is not', () => {
    const { c, edits } = open('exists');
    c.start();
    c.draft = 'Task';
    c.commit();
    expect(edits.any()).toBe(true);
    c.cancel();
    expect(edits.any()).toBe(false);
  });
});

describe('the Schema tab holds its export dialog and import-conflict name (Q-701)', () => {
  function open() {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [SpaceSchemaTabComponent, getTranslocoModule()],
      providers: [
        SpaceSettingsState,
        { provide: SpacesApi, useValue: {} },
        { provide: ToastService, useValue: { show: () => {}, error: () => {}, success: () => {}, info: () => {} } },
        { provide: SchemaApi, useValue: {
          listSchemaLibrary: () => of({ entries: [] }),
          upsertSchemaLibraryEntry: () => of({ entry: {} }),
          exportSpaceSchemaToLibrary: () => of({ created: 1, updated: 0 }),
        } },
      ],
    });
    const fixture = TestBed.createComponent(SpaceSchemaTabComponent);
    TestBed.inject(SpaceSettingsState).settingsSpace.set({ id: 'proj', label: 'Project', meta: {} } as never);
    fixture.detectChanges();
    return { c: fixture.componentInstance, edits: TestBed.inject(UnsavedEdits) };
  }

  it('is clean when opened', () => {
    expect(open().edits.any()).toBe(false);
  });

  it('an export dialog is clean when opened, held once a field is typed, and clean when it ends', () => {
    const { c, edits } = open();
    // The export is offered only while the editor has no unsaved changes of its own (`state.isDirty()`); this state was never opened by the popup.
    vi.spyOn(TestBed.inject(SpaceSettingsState), 'isDirty').mockReturnValue(false);
    c.openExportToLibrary();
    expect(edits.any()).toBe(false);
    c.exportLibDialog.set({ ...c.exportLibDialog()!, groupName: 'My group' });
    expect(edits.any()).toBe(true);
    c.doExportToLibrary();
    expect(edits.any()).toBe(false);
  });

  it('a closed export dialog is not a draft', () => {
    const { c, edits } = open();
    c.openExportToLibrary();
    c.exportLibDialog.set({ ...c.exportLibDialog()!, namePrefix: 'x-' });
    c.closeExportToLibrary();
    expect(edits.any()).toBe(false);
  });

  it('an import-conflict name is clean as suggested, held once typed over, and clean when the conflict ends', () => {
    const { c, edits } = open();
    c.importConflict.set({ kt: 'entity', name: 'person', state: emptyTypeSchemaState({}), allowAddAs: true });
    c.importConflictAddAsName.set('person-2');
    expect(edits.any()).toBe(false);
    c.importConflictAddAsName.set('human');
    expect(edits.any()).toBe(true);
    c.dismissImportConflict();
    expect(edits.any()).toBe(false);
  });
});
