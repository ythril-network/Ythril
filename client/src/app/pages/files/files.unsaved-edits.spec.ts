/**
 * The Brain page's Files tab holds the drafts of its three typed controls (Q-701, bundle-238).
 *
 * A row's rename box, the toolbar's new-folder box and the file-meta form each hold a value that one button sends. Leaving the
 * page, reloading or switching tab with one changed lost it silently.
 *
 * ## The rules
 *
 * 1. Clean when the control is not open, and clean as opened (the rename box holds the entry's own name, the new-folder box is empty,
 *    the meta form holds the record as loaded).
 * 2. Dirty once the person has typed something that differs, through the control itself (the DOM event), not a member write.
 * 3. Clean after the button that sends it succeeded, and after Cancel.
 *
 * The page runs over the fake file server (`testing/files-page-harness.ts`), so what is sent and answered is the real wire.
 *
 * ## Seen red at a0238e3c
 *
 * `UnsavedEdits.any()` was false with a changed rename, a typed folder name and an edited description.
 *
 * The meta form is mounted alone (as `file-meta-editor.component.spec.ts` does): its reference widgets need the Brain shell's picker, which the
 * page's fake-server harness does not provide.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { BrainApi } from '../../core/brain-api.service';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainStore } from '../brain/brain-store.service';
import { EntityRefPicker } from '../brain/entity-ref-picker.service';
import { FileMetaEditorComponent, type FileMetaModel } from './file-meta-editor.component';
import { mountFilesPage, type MountedPage } from '../../testing/files-page-harness';

beforeEach(() => TestBed.resetTestingModule());

const entryOf = (page: MountedPage, name: string) => page.c.listing.entries().find((e: any) => e.name === name);

/** Type into a control the way a person does: set its value and fire `input`, then let the page see it. */
async function typeInto(page: MountedPage, selector: string, value: string): Promise<void> {
  const control = page.el.querySelector<HTMLInputElement | HTMLTextAreaElement>(selector);
  if (!control) throw new Error(`no control ${selector}`);
  control.value = value;
  control.dispatchEvent(new Event('input'));
  await page.settle();
}

describe('the Files tab holds its typed controls (Q-701)', () => {
  it('a row rename: clean as opened, dirty once the name differs, clean after the rename and after Cancel', async () => {
    const page = await mountFilesPage({ '/a.txt': 1 });
    const unsaved = TestBed.inject(UnsavedEdits);
    expect(unsaved.any(), 'no rename open').toBe(false);

    page.c.startRename(entryOf(page, 'a.txt'));
    await page.settle();
    expect(unsaved.any(), 'the box holds the entry\'s own name').toBe(false);

    await typeInto(page, 'input[name="rn"]', 'b.txt');
    expect(unsaved.any(), 'a typed new name would be lost by leaving').toBe(true);

    page.c.renamingEntry.set('');
    await page.settle();
    expect(unsaved.any(), 'Cancel closes the box').toBe(false);

    page.c.startRename(entryOf(page, 'a.txt'));
    await page.settle();
    await typeInto(page, 'input[name="rn"]', 'b.txt');
    expect(unsaved.any()).toBe(true);
    page.c.confirmRename(entryOf(page, 'a.txt'));
    await page.settle();
    expect(page.server.sentWith('PATCH').length, 'the rename was sent').toBe(1);
    expect(unsaved.any(), 'renamed').toBe(false);
  });

  it('the new-folder box: clean while empty, dirty once a name is typed, clean after the folder was made and after Cancel', async () => {
    const page = await mountFilesPage({ '/a.txt': 1 });
    const unsaved = TestBed.inject(UnsavedEdits);
    page.c.showNewFolder.set(true);
    await page.settle();
    expect(unsaved.any(), 'an open, empty box').toBe(false);

    await typeInto(page, 'input[name="fn"]', 'reports');
    expect(unsaved.any(), 'a typed folder name').toBe(true);

    page.c.showNewFolder.set(false);
    page.c.newFolderName.set('');
    await page.settle();
    expect(unsaved.any(), 'Cancel closes the box').toBe(false);

    page.c.showNewFolder.set(true);
    await page.settle();
    await typeInto(page, 'input[name="fn"]', 'reports');
    expect(unsaved.any()).toBe(true);
    page.c.createFolder();
    await page.settle();
    expect(page.server.sentWith('POST').length, 'the folder was asked for').toBeGreaterThan(0);
    expect(unsaved.any(), 'made').toBe(false);
  });

});

describe('the file-meta form holds its model (Q-701)', () => {
  /** The editor as the Brain shell renders it: the reference widgets inject the picker the shell provides. */
  function mountEditor(model: FileMetaModel) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [FileMetaEditorComponent, getTranslocoModule()],
      providers: [
        EntityRefPicker, BrainStore,
        { provide: BrainApi, useValue: {
          listEntities: () => of({ entities: [] }), getEntitiesByIds: () => of({ entities: [] }),
          listFacts: () => of({ facts: [] }), getMemoriesByIds: () => of({ facts: [] }),
          listChrono: () => of({ chrono: [] }), getChrono: () => of({}),
        } },
      ],
    });
    const fixture = TestBed.createComponent(FileMetaEditorComponent);
    fixture.componentRef.setInput('model', model);
    fixture.detectChanges();
    return { fixture, el: fixture.nativeElement as HTMLElement, unsaved: TestBed.inject(UnsavedEdits) };
  }
  const loaded = (): FileMetaModel => ({ description: 'd', tags: ['t'], linkEntities: 'e1', linkFacts: ['m1'], linkChronos: ['c1'] });

  it('is clean as loaded, dirty once a field is typed into, clean once the page re-seeds it (Save or Cancel)', async () => {
    const e = mountEditor(loaded());
    await e.fixture.whenStable(); // ngModel wires its control in a microtask
    expect(e.unsaved.any(), 'the record as loaded').toBe(false);

    const box = e.el.querySelector<HTMLTextAreaElement>('textarea[name="detailDesc"]')!;
    box.value = 'what this file is';
    box.dispatchEvent(new Event('input'));
    await e.fixture.whenStable();
    expect(e.unsaved.any(), 'a typed description would be lost by leaving').toBe(true);

    // Save and Cancel both end in the page replacing the model wholesale (`FileMetaStore.seed`), a new object the editor receives.
    e.fixture.componentRef.setInput('model', loaded());
    e.fixture.detectChanges();
    expect(e.unsaved.any(), 're-seeded: the edit is saved or discarded').toBe(false);
  });

  it('is dirty when a reference list changes in place, and holds nothing without a model', () => {
    const m = loaded();
    const e = mountEditor(m);
    m.linkFacts = [...m.linkFacts, 'm2'];
    expect(e.unsaved.any(), 'a picked fact reference').toBe(true);
    e.fixture.componentRef.setInput('model', null);
    e.fixture.detectChanges();
    expect(e.unsaved.any(), 'no model, nothing to lose').toBe(false);
  });
});
