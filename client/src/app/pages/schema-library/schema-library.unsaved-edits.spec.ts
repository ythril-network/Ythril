/**
 * The schema library holds the drafts of its five forms (Q-701, bundle-238).
 *
 * The library's type-entry dialog, add-catalog dialog, library-token name, export-space dialog and apply-group dialog each hold typed or
 * picked values that one button sends. Leaving the page, reloading or closing the tab with one open and changed lost it silently.
 *
 * ## The rules (per form)
 *
 * 1. Clean when the form is not open, and clean as it opened (a create form blank, an edit form holding the entry's own values).
 * 2. Dirty once a value differs from what it opened with.
 * 3. Clean after the button that sends it succeeded (the type, catalog and token dialogs close; the export and apply dialogs stay open
 *    with their result line, and what they were asked to do is done).
 * 4. Clean after the dialog is closed.
 *
 * ## Seen red at a0238e3c
 *
 * `UnsavedEdits.any()` was false for every dirty case.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { type SchemaLibraryEntry } from '../../core/api.types';
import { AuthApi } from '../../core/auth-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SchemaLibraryComponent } from './schema-library.component';

const ENTRY: SchemaLibraryEntry = {
  name: 'crm-person', knowledgeType: 'entity', typeName: 'person',
  schema: { propertySchemas: { role: { type: 'string' } } } as SchemaLibraryEntry['schema'],
  description: 'A person in the CRM', schemaGroup: 'crm',
  createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-02T00:00:00.000Z',
};

beforeEach(() => TestBed.resetTestingModule());

function mount() {
  const schemaApi = {
    listSchemaLibrary: vi.fn(() => of({ entries: [ENTRY] })),
    getSchemaLibraryUsages: vi.fn(() => of({ usages: [] })),
    createSchemaLibraryEntry: vi.fn(() => of({ entry: { ...ENTRY, name: 'new-one' } })),
    upsertSchemaLibraryEntry: vi.fn(() => of({ entry: ENTRY })),
    addSchemaCatalog: vi.fn(() => of({ catalog: { name: 'c', url: 'https://x/api/schema-library' } })),
    exportSpaceSchemaToLibrary: vi.fn(() => of({ created: 1, updated: 0, entries: [] })),
    applyGroupToSpace: vi.fn(() => of({ count: 2 })),
  };
  TestBed.configureTestingModule({
    imports: [SchemaLibraryComponent, getTranslocoModule()],
    providers: [
      { provide: SchemaApi, useValue: schemaApi },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [{ id: 'work', label: 'work' }] }) } },
      { provide: AuthApi, useValue: { createToken: vi.fn(() => of({ plaintext: 'secret' })) } },
      { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(SchemaLibraryComponent);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance as any, unsaved: TestBed.inject(UnsavedEdits) };
}

describe('the schema library holds its drafts (Q-701)', () => {
  it('type entry dialog: a create form, an edit form, saved and closed', () => {
    const l = mount();
    expect(l.unsaved.any(), 'nothing open').toBe(false);

    l.c.openCreate();
    expect(l.unsaved.any(), 'a blank create form').toBe(false);
    l.c.form.typeName = 'invoice';
    l.c.form.name = 'invoice';
    expect(l.unsaved.any(), 'a typed type name').toBe(true);
    l.c.saveEntry();
    expect(l.c.showDialog(), 'the save closed the dialog').toBe(false);
    expect(l.unsaved.any(), 'saved').toBe(false);

    l.c.openEdit(ENTRY);
    expect(l.unsaved.any(), 'an edit form as opened').toBe(false);
    l.c.form.description = 'changed';
    expect(l.unsaved.any(), 'a changed description').toBe(true);
    l.c.closeDialog();
    expect(l.unsaved.any(), 'closed').toBe(false);

    l.c.openEdit(ENTRY);
    l.c.form.schemaState.propertySchemas = [];
    l.c.form.schemaState._newPropInput = 'half-typed-name';
    expect(l.unsaved.any(), 'a half-typed property name is part of the draft').toBe(true);
  });

  it('add-catalog dialog', () => {
    const l = mount();
    l.c.openAddCatalog();
    expect(l.unsaved.any(), 'blank').toBe(false);
    l.c.newCatalog.name = 'partner';
    l.c.newCatalog.url = 'https://partner.example';
    expect(l.unsaved.any()).toBe(true);
    l.c.addCatalog();
    expect(l.c.showAddCatalog(), 'the add closed the dialog').toBe(false);
    expect(l.unsaved.any(), 'added').toBe(false);
  });

  it('library token name', () => {
    const l = mount();
    l.c.showCreateLibToken.set(true);
    expect(l.unsaved.any(), 'an open, empty name').toBe(false);
    l.c.libTokenName.set('ci');
    expect(l.unsaved.any(), 'a typed name').toBe(true);
    l.c.libTokenName.set('   ');
    expect(l.unsaved.any(), 'blanks are not a name').toBe(false);
    l.c.libTokenName.set('ci');
    l.c.createLibraryToken();
    expect(l.unsaved.any(), 'created: the revealed secret is shown, the name box is gone').toBe(false);
  });

  it('export-space dialog', () => {
    const l = mount();
    l.c.openExportSpace();
    expect(l.unsaved.any(), 'blank').toBe(false);
    l.c.exportSpaceDialog.update((d: any) => ({ ...d, spaceId: 'work', groupName: 'crm' }));
    expect(l.unsaved.any(), 'a picked space and a group').toBe(true);
    l.c.doExportSpace();
    expect(l.c.exportSpaceDialog().result, 'the export ran').not.toBe('');
    expect(l.unsaved.any(), 'exported: the dialog shows its result and holds nothing more to send').toBe(false);
    l.c.exportSpaceDialog.set(null);
    expect(l.unsaved.any()).toBe(false);
  });

  it('apply-group dialog', () => {
    const l = mount();
    l.c.groupFilter.set('crm');
    l.c.openApplyGroup();
    expect(l.unsaved.any(), 'opened with the filtered group preselected').toBe(false);
    l.c.applyGroupDialog.update((d: any) => ({ ...d, spaceId: 'work' }));
    expect(l.unsaved.any(), 'a picked space').toBe(true);
    l.c.applyGroupDialog.update((d: any) => ({ ...d, spaceId: '', group: 'other' }));
    expect(l.unsaved.any(), 'a changed group').toBe(true);
    l.c.applyGroupDialog.update((d: any) => ({ ...d, spaceId: 'work', group: 'crm' }));
    l.c.doApplyGroup();
    expect(l.c.applyGroupDialog().result, 'the apply ran').not.toBe('');
    expect(l.unsaved.any(), 'applied').toBe(false);
  });
});
