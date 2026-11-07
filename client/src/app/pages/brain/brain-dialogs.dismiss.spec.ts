/**
 * The Brain page's dialogs that hold a draft ask before Escape, X or Cancel discards it (Q-713, bundle-247): the personal-view create dialog,
 * the record drawer and the graph tab's entry pop-up.
 *
 * Each is mounted open, dirtied through its own state and dismissed every way it offers (`testing/dialog-dismiss-harness.ts`): a clean one
 * closes without a question, a dirty one asks, a refusal keeps it open, and a yes closes it.
 *
 * ## Seen red at 45f888b0
 *
 * `ConfirmDialogService.confirm` was never called for a dirty dismiss: every dirty case closed the dialog without asking.
 */
import { TestBed } from '@angular/core/testing';
import { vi } from 'vitest';
import { of } from 'rxjs';
import { dialogDismissSpecs } from '../../testing/dialog-dismiss-harness';
import { DRAWER_EDITORS, mountDrawer, settle } from '../../testing/brain-editors-harness';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { RetypeConfirmService } from '../../core/retype-confirm.service';
import { ViewsStore } from '../../core/views.store';
import { EntryPopupComponent } from '../../shared/entry-popup.component';
import { ViewCreateDialogComponent } from './view-create-dialog.component';

dialogDismissSpecs('the personal-view create dialog', {}, () => {
  TestBed.configureTestingModule({
    imports: [ViewCreateDialogComponent, getTranslocoModule()],
    providers: [{ provide: ViewsStore, useValue: { create: vi.fn(() => of({ id: '@made', name: 'made', members: ['qa'] })) } }],
  });
  const fixture = TestBed.createComponent(ViewCreateDialogComponent);
  fixture.componentRef.setInput('spaces', [{ id: 'qa', label: 'Quality' }]);
  let closed = 0;
  fixture.componentInstance.closed.subscribe(() => { closed++; });
  fixture.detectChanges();
  return { fixture, closes: () => closed, edit: () => { fixture.componentInstance.name = 'lens'; } };
});

dialogDismissSpecs('the record drawer', { cancel: null, x: 'brain.drawer.closeDetailsAriaLabel' }, async () => {
  const editor = DRAWER_EDITORS[0]!;
  const d = mountDrawer(editor);
  (d.state.open as (kind: string, record: unknown) => void)(editor.kind, editor.record());
  await settle(d.fixture);
  return {
    fixture: d.fixture,
    closes: () => (d.state.drawerRecord() === null ? 1 : 0),
    edit: () => { (d.state as any)[editor.editModel].description = 'changed by the person'; },
  };
});

dialogDismissSpecs('the entry pop-up', { x: null }, () => {
  const record = { _id: 'e1', name: 'Ada', type: 'person', properties: { age: 36 } };
  TestBed.configureTestingModule({
    imports: [EntryPopupComponent, getTranslocoModule()],
    providers: [
      { provide: BrainApi, useValue: { updateEntity: () => of(record) } },
      { provide: RetypeConfirmService, useValue: { confirm: vi.fn() } },
    ],
  });
  const fixture = TestBed.createComponent(EntryPopupComponent);
  fixture.componentRef.setInput('record', structuredClone(record));
  fixture.componentRef.setInput('recordType', 'entity');
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.componentRef.setInput('canEdit', true);
  let closed = 0;
  fixture.componentInstance.closed.subscribe(() => { closed++; });
  fixture.detectChanges();
  return { fixture, closes: () => closed, edit: () => { fixture.componentInstance.onFieldChange('name', 'Ada L'); } };
});
