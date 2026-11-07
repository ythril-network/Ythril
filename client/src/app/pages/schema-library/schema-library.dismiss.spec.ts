/**
 * The schema library's five draft-holding dialogs ask before Escape, X or Cancel discards a draft (Q-713, bundle-247): the type entry
 * dialog, the add-catalog dialog, the library-token name, the export-space dialog and the apply-group dialog.
 *
 * One component renders them all, and each closes through its own guard: closing one asks about that dialog's draft and no other. Each is
 * mounted open, dirtied through its own fields and dismissed every way it offers (`testing/dialog-dismiss-harness.ts`).
 *
 * ## Seen red at 45f888b0
 *
 * `ConfirmDialogService.confirm` was never called for a dirty dismiss: every dirty case closed the dialog without asking.
 */
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { dialogDismissSpecs } from '../../testing/dialog-dismiss-harness';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { AuthApi } from '../../core/auth-api.service';
import { SchemaApi } from '../../core/schema-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { ToastService } from '../../core/toast.service';
import { SchemaLibraryComponent } from './schema-library.component';

function mount() {
  TestBed.configureTestingModule({
    imports: [SchemaLibraryComponent, getTranslocoModule()],
    providers: [
      { provide: SchemaApi, useValue: { listSchemaLibrary: () => of({ entries: [] }), getSchemaLibraryUsages: () => of({ usages: [] }) } },
      { provide: SpacesApi, useValue: { listSpaces: () => of({ spaces: [{ id: 'work', label: 'work' }] }) } },
      { provide: AuthApi, useValue: { createToken: vi.fn(() => of({ plaintext: 'secret' })) } },
      { provide: ToastService, useValue: { show: vi.fn(), error: vi.fn(), success: vi.fn(), info: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(SchemaLibraryComponent);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance as any };
}

dialogDismissSpecs('the schema library type entry dialog', { cancel: null }, () => {
  const { fixture, c } = mount();
  c.openCreate();
  fixture.detectChanges();
  return { fixture, closes: () => (c.showDialog() ? 0 : 1), edit: () => { c.form.typeName = 'invoice'; c.form.name = 'invoice'; } };
});

dialogDismissSpecs('the schema library add-catalog dialog', { cancel: null }, () => {
  const { fixture, c } = mount();
  c.openAddCatalog();
  fixture.detectChanges();
  return { fixture, closes: () => (c.showAddCatalog() ? 0 : 1), edit: () => { c.newCatalog.name = 'partner'; } };
});

dialogDismissSpecs('the schema library token name dialog', {}, () => {
  const { fixture, c } = mount();
  c.showCreateLibToken.set(true);
  fixture.detectChanges();
  return { fixture, closes: () => (c.showCreateLibToken() ? 0 : 1), edit: () => { c.libTokenName.set('ci'); } };
});

dialogDismissSpecs('the schema library export-space dialog', {}, () => {
  const { fixture, c } = mount();
  c.openExportSpace();
  fixture.detectChanges();
  return { fixture, closes: () => (c.exportSpaceDialog() === null ? 1 : 0), edit: () => { c.exportSpaceDialog.update((d: any) => ({ ...d, spaceId: 'work' })); } };
});

dialogDismissSpecs('the schema library apply-group dialog', {}, () => {
  const { fixture, c } = mount();
  c.openApplyGroup();
  fixture.detectChanges();
  return { fixture, closes: () => (c.applyGroupDialog() === null ? 1 : 0), edit: () => { c.applyGroupDialog.update((d: any) => ({ ...d, spaceId: 'work' })); } };
});
