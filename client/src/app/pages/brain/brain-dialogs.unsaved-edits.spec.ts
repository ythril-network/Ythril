/**
 * The Brain page's two dialogs hold their drafts (Q-701, bundle-238): the personal-view create dialog and the graph tab's entry pop-up.
 *
 * This file holds that the dialogs REGISTER the draft, so leaving the page, reloading or closing the tab with one dirty and open asks.
 * Their own dismiss (X, Escape, backdrop) asking first is held in brain-dialogs.dismiss.spec.ts (Q-713).
 *
 * ## The rules
 *
 * 1. The create dialog is dirty once it holds a name, a ticked space or the "all spaces" mode, and clean again once the view was made.
 * 2. The entry pop-up is dirty once its working copy differs from the record it was given (or last saved), clean after a save, after Reset,
 *    and when it holds no record.
 *
 * ## Seen red at a0238e3c
 *
 * `UnsavedEdits.any()` was false for every dirty case.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of, throwError } from 'rxjs';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { ViewsStore } from '../../core/views.store';
import { BrainApi } from '../../core/brain-api.service';
import { RetypeConfirmService } from '../../core/retype-confirm.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { EntryPopupComponent } from '../../shared/entry-popup.component';
import { ViewCreateDialogComponent } from './view-create-dialog.component';

beforeEach(() => TestBed.resetTestingModule());

describe('the personal-view create dialog holds its draft (Q-701)', () => {
  function mount() {
    const create = vi.fn(() => of({ id: '@made', name: 'made', members: ['qa'] }));
    TestBed.configureTestingModule({
      imports: [ViewCreateDialogComponent, getTranslocoModule()],
      providers: [{ provide: ViewsStore, useValue: { create } }],
    });
    const fixture = TestBed.createComponent(ViewCreateDialogComponent);
    fixture.componentRef.setInput('spaces', [{ id: 'qa', label: 'Quality' }, { id: 'ops', label: 'Operations' }]);
    const made: unknown[] = [];
    fixture.componentInstance.created.subscribe(v => made.push(v));
    fixture.detectChanges();
    return { fixture, c: fixture.componentInstance as any, create, made, unsaved: TestBed.inject(UnsavedEdits) };
  }

  it('is clean as opened, dirty once a name is typed, a space ticked or the mode changed', () => {
    const d = mount();
    expect(d.unsaved.any(), 'opened and untouched').toBe(false);
    d.c.name = 'lens';
    expect(d.unsaved.any(), 'a typed name').toBe(true);
    d.c.name = '   ';
    expect(d.unsaved.any(), 'blanks are not a draft').toBe(false);
    d.c.toggle('qa');
    expect(d.unsaved.any(), 'a ticked space').toBe(true);
    d.c.toggle('qa');
    expect(d.unsaved.any()).toBe(false);
    d.c.mode.set('all');
    expect(d.unsaved.any(), 'the all-spaces mode').toBe(true);
  });

  it('is clean once the view was made, before the page has torn the dialog down', () => {
    const d = mount();
    d.c.name = 'lens';
    d.c.toggle('qa');
    expect(d.unsaved.any()).toBe(true);
    d.c.submit();
    expect(d.made.length, 'the view was created').toBe(1);
    expect(d.unsaved.any(), 'the page opens the new view next: it must not ask about the dialog that just did its job').toBe(false);
  });
});

describe('the entry pop-up holds its working copy (Q-701)', () => {
  const RECORD = { _id: 'e1', name: 'Ada', type: 'person', properties: { age: 36 } };

  function mount(updateEntity: (...args: unknown[]) => unknown = () => of({ ...RECORD, name: 'Ada L' })) {
    TestBed.configureTestingModule({
      imports: [EntryPopupComponent, getTranslocoModule()],
      providers: [
        { provide: BrainApi, useValue: { updateEntity } },
        { provide: RetypeConfirmService, useValue: { confirm: vi.fn() } },
      ],
    });
    const fixture = TestBed.createComponent(EntryPopupComponent);
    fixture.componentRef.setInput('record', structuredClone(RECORD));
    fixture.componentRef.setInput('recordType', 'entity');
    fixture.componentRef.setInput('spaceId', 'work');
    fixture.componentRef.setInput('canEdit', true);
    fixture.detectChanges();
    return { fixture, c: fixture.componentInstance, unsaved: TestBed.inject(UnsavedEdits) };
  }

  it('is clean as opened, dirty once a field or the raw JSON changes, clean after Reset', () => {
    const p = mount();
    expect(p.unsaved.any(), 'opened and untouched').toBe(false);
    p.c.onFieldChange('name', 'Ada L');
    expect(p.unsaved.any(), 'a changed field').toBe(true);
    p.c.undo();
    expect(p.unsaved.any(), 'Reset goes back to the record').toBe(false);
    p.c.onRawJsonChange(JSON.stringify({ ...RECORD, description: 'typed in the JSON' }));
    expect(p.unsaved.any(), 'a changed raw JSON').toBe(true);
  });

  it('is clean after a save that succeeded, and dirty again after a refused one', () => {
    const p = mount();
    p.c.onFieldChange('name', 'Ada L');
    expect(p.unsaved.any()).toBe(true);
    p.c.save();
    expect(p.unsaved.any(), 'the stored record is the working copy now').toBe(false);

    TestBed.resetTestingModule();
    const q = mount(() => throwError(() => ({ status: 422, error: { error: 'schema_violation', message: 'no', introduced: [], preExisting: [], violations: [] } })));
    q.c.onFieldChange('name', 'Ada L');
    q.c.save();
    expect(q.unsaved.any(), 'a refused save keeps the edit').toBe(true);
  });

  it('holds nothing when it holds no record', () => {
    const p = mount();
    p.c.onFieldChange('name', 'Ada L');
    expect(p.unsaved.any()).toBe(true);
    p.fixture.componentRef.setInput('record', null);
    p.fixture.detectChanges();
    expect(p.unsaved.any(), 'a closed pop-up has nothing to lose').toBe(false);
  });
});
