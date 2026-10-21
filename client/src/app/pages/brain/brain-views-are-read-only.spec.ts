/**
 * The Brain page's record tabs and its record drawer offer no write on a personal view (Q-531, plan rev 3.2 "Client": "One shared isView flag
 * gates every write control: Brain tabs, record drawer, review tab, retype flow").
 *
 * ## The rule
 *
 * A view never writes: the server answers a write to it as a space that does not exist, so a control that offers one invites a form that can
 * only be refused. `every-write-control-asks-is-view.spec.ts` holds that each such component READS the flag; this holds what the flag DOES, over
 * the same four tabs the editor harness covers (entities, facts, edges, chrono: add, delete) and the drawer (save, editable fields), each on a
 * view and, as its control, on a space - so a flag that hid everything everywhere could not pass. The review tab hides its whole body on a view,
 * and its sentence is the one the Brain page's overview gives for every config panel.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { TAB_EDITORS, DRAWER_EDITORS, mountTab, mountDrawer, settle } from '../../testing/brain-editors-harness';
import { ViewsStore } from '../../core/views.store';
import { VIEW_LENS } from '../../testing/personal-views';
import { ReviewTabComponent } from './review-tab.component';
import { DuplicatesApi } from '../../core/duplicates-api.service';
import { ContradictionsApi } from '../../core/contradictions-api.service';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { ToastService } from '../../core/toast.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';

/** Open `editor`'s tab on `spaceId`, holding one record, with the caller's one view in the store. */
async function tabOn(editor: (typeof TAB_EDITORS)[number], spaceId: string) {
  const m = mountTab(editor);
  TestBed.inject(ViewsStore).views.set([VIEW_LENS]);
  m.fixture.componentRef.setInput('spaceId', spaceId);
  (m.c.store[editor.storeList] as { set(rows: unknown[]): void }).set([editor.record()]);
  await settle(m.fixture);
  return m.host;
}

describe('the record tabs', () => {
  for (const editor of TAB_EDITORS) {
    it(`${editor.kind}: no add and no delete on a view`, async () => {
      const host = await tabOn(editor, '@lens');
      expect(host.querySelector('.content-header .btn-primary'), 'an add button on a view').toBeNull();
      expect(host.querySelector('tbody .icon-btn.danger'), 'a delete button on a view').toBeNull();
      expect(host.querySelector('tbody tr'), 'the record is still shown, read-only').not.toBeNull();
    });

    it(`${editor.kind}: add and delete on a space (control)`, async () => {
      const host = await tabOn(editor, 'work');
      expect(host.querySelector('.content-header .btn-primary')).not.toBeNull();
      expect(host.querySelector('tbody .icon-btn.danger')).not.toBeNull();
    });
  }
});

describe('the record drawer', () => {
  for (const editor of DRAWER_EDITORS) {
    const open = (spaceId: string) => {
      const m = mountDrawer(editor);
      TestBed.inject(ViewsStore).views.set([VIEW_LENS]);
      m.state.spaceId.set(spaceId);
      // The drawer's overloads pair each kind with its own record type; the harness table is data, so the pairing is by construction.
      (m.state.open as (kind: string, record: unknown) => void)(editor.kind, editor.record());
      return m;
    };

    it(`${editor.kind}: no Save and disabled fields on a view`, async () => {
      const m = open('@lens');
      await settle(m.fixture);
      expect(m.host.querySelector('.drawer-header .btn-primary'), 'a Save button on a view').toBeNull();
      expect(m.host.querySelector('fieldset')?.disabled, 'editable fields on a view').toBe(true);
    });

    it(`${editor.kind}: Save and editable fields on a space (control)`, async () => {
      const m = open('work');
      await settle(m.fixture);
      expect(m.host.querySelector('.drawer-header .btn-primary')).not.toBeNull();
      expect(m.host.querySelector('fieldset')?.disabled).toBe(false);
    });
  }
});

describe('the review tab', () => {
  function mount(isView: boolean) {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      imports: [ReviewTabComponent, getTranslocoModule()],
      providers: [
        { provide: DuplicatesApi, useValue: { listDuplicates: () => { throw new Error('a view asked for duplicates'); } } },
        { provide: ContradictionsApi, useValue: { listContradictions: () => { throw new Error('a view asked for contradictions'); } } },
        { provide: SpacesApi, useValue: { getCompleteness: () => { throw new Error('a view asked for completeness'); } } },
        { provide: BrainApi, useValue: {} },
        { provide: ToastService, useValue: {} },
        { provide: ConfirmDialogService, useValue: {} },
      ],
    });
    const fixture = TestBed.createComponent(ReviewTabComponent);
    fixture.componentRef.setInput('spaceId', '@lens');
    fixture.componentRef.setInput('isView', isView);
    return fixture;
  }

  it('says it is not available on a view, and offers no scan, merge or dismissal', () => {
    const f = mount(true);
    expect(() => f.detectChanges()).not.toThrow();
    const text = (f.nativeElement as HTMLElement).textContent ?? '';
    expect(text).toContain('views.notAvailable');
    expect((f.nativeElement as HTMLElement).querySelectorAll('button').length).toBe(0);
  });
});
