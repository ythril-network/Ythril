/**
 * The Files page offers no write on a personal view (Q-531, plan rev 3.2 "Client": "One shared isView flag gates every write control: ...
 * file toolbar").
 *
 * ## The rule
 *
 * A view never writes: the server answers a write to it as a space that does not exist, so a control that offers one invites a form that can
 * only be refused. `every-write-control-asks-is-view.spec.ts` holds that every component with such a control READS the flag; this holds what
 * the flag DOES, for the four Files components that draw one: the toolbar (new folder, upload), the listing (re-embed, rename, delete), the
 * upload queue (retry, cancel, dismiss) and the metadata editor (save, re-embed). Each is asserted on a view and, as its control, on a space,
 * so a flag that hid everything everywhere could not pass.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { EntityRefPicker } from '../brain/entity-ref-picker.service';
import { BrainStore } from '../brain/brain-store.service';
import { ViewsStore } from '../../core/views.store';
import { VIEW_LENS } from '../../testing/personal-views';
import { FileToolbarComponent } from './file-toolbar.component';
import { FileListingComponent, type FileRow } from './file-listing.component';
import { UploadQueueComponent, type UploadItem } from './upload-queue.component';
import { FileMetaEditorComponent, type FileMetaModel } from './file-meta-editor.component';

beforeEach(() => TestBed.resetTestingModule());

/** A store that holds the caller's one view, as the shell leaves it. */
function withView() { TestBed.inject(ViewsStore).views.set([VIEW_LENS]); }

const labels = (el: HTMLElement) => [...el.querySelectorAll('button, label, input')].map(e => `${e.getAttribute('aria-label') ?? ''}|${e.textContent ?? ''}|${e.getAttribute('type') ?? ''}`).join('\n');

describe('the file toolbar', () => {
  function mount(spaceId: string) {
    TestBed.configureTestingModule({ imports: [FileToolbarComponent, getTranslocoModule()] });
    withView();
    const f = TestBed.createComponent(FileToolbarComponent);
    f.componentRef.setInput('activeSpaceId', spaceId);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('offers no new folder and no upload on a view', () => {
    const el = mount('@lens');
    expect(labels(el)).not.toContain('files.newFolder');
    expect(el.querySelector('input[type="file"]'), 'a file picker on a view').toBeNull();
  });

  it('offers both on a space (control)', () => {
    const el = mount('qa');
    expect(labels(el)).toContain('files.newFolder');
    expect(el.querySelector('input[type="file"]')).not.toBeNull();
  });
});

describe('the file listing', () => {
  const row: FileRow = {
    entry: { name: 'a.txt', size: 1, isFile: true, isDirectory: false, modified: '2026-10-01T10:00:00.000Z', embeddingStatus: 'failed' },
    renaming: false, requeueing: false, canRequeue: true, deleting: false,
  };
  function mount(isView: boolean) {
    TestBed.configureTestingModule({ imports: [FileListingComponent, getTranslocoModule()] });
    const f = TestBed.createComponent(FileListingComponent);
    f.componentRef.setInput('rows', [row]);
    f.componentRef.setInput('isView', isView);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('offers no re-embed, rename or delete on a view, and still lets the file be opened and downloaded', () => {
    const text = labels(mount(true));
    for (const write of ['files.reembedAriaLabel', 'files.renameEntryAriaLabel', 'files.deleteEntryAriaLabel']) expect(text, write).not.toContain(write);
    expect(text).toContain('files.downloadAriaLabel');
    expect(text).toContain('a.txt');
  });

  it('offers all three on a space (control)', () => {
    const text = labels(mount(false));
    for (const write of ['files.reembedAriaLabel', 'files.renameEntryAriaLabel', 'files.deleteEntryAriaLabel']) expect(text, write).toContain(write);
  });
});

describe('the upload queue', () => {
  const failed: UploadItem = { id: 1, file: new File(['x'], 'a.txt'), name: 'a.txt', status: 'failed', percent: 0, error: 'refused' };
  function mount(isView: boolean) {
    TestBed.configureTestingModule({ imports: [UploadQueueComponent, getTranslocoModule()] });
    const f = TestBed.createComponent(UploadQueueComponent);
    f.componentRef.setInput('uploads', [failed]);
    f.componentRef.setInput('isView', isView);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('has no retry or dismiss on a view', () => {
    expect(labels(mount(true))).not.toMatch(/common\.retry|files\.upload\.dismiss/);
  });

  it('has them on a space (control)', () => {
    expect(labels(mount(false))).toMatch(/common\.retry/);
  });
});

describe('the file metadata editor', () => {
  const model: FileMetaModel = { description: 'd', tags: ['t'], linkEntities: 'e1', linkFacts: ['m1'], linkChronos: ['c1'] };
  function mount(spaceId: string) {
    // The reference widgets inject the Brain shell's picker, which is the condition under which this form is ever shown.
    TestBed.configureTestingModule({
      imports: [FileMetaEditorComponent, getTranslocoModule()],
      providers: [EntityRefPicker, BrainStore, { provide: BrainApi, useValue: {
        listEntities: () => of({ entities: [] }), getEntitiesByIds: () => of({ entities: [] }), listFacts: () => of({ facts: [] }),
        getMemoriesByIds: () => of({ facts: [] }), listChrono: () => of({ chrono: [] }), getChrono: () => of({}),
      } }],
    });
    withView();
    const f = TestBed.createComponent(FileMetaEditorComponent);
    f.componentRef.setInput('model', model);
    f.componentRef.setInput('spaceId', spaceId);
    f.componentRef.setInput('canRetryEmbedding', true);
    f.detectChanges();
    return f.nativeElement as HTMLElement;
  }

  it('is read-only on a view: no save, no re-embed, and the fields are disabled', () => {
    const el = mount('@lens');
    expect(el.querySelector('button[type="submit"]'), 'a save button on a view').toBeNull();
    expect(labels(el)).not.toContain('brain.fileMeta.retryEmbedding');
    expect(el.querySelector('fieldset')?.disabled).toBe(true);
  });

  it('saves and re-embeds on a space (control)', () => {
    const el = mount('qa');
    expect(el.querySelector('button[type="submit"]')).not.toBeNull();
    expect(labels(el)).toContain('brain.fileMeta.retryEmbedding');
    expect(el.querySelector('fieldset')?.disabled).toBe(false);
  });
});
