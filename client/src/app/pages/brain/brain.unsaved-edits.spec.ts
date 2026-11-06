/**
 * The Brain page never loses a typed draft without asking (Q-701, bundle-238).
 *
 * ## The defect it prevents
 *
 * At 139c6938 the Brain page held no leave guard. A create form (facts, entities, edges, chrono), an inline row edit, the record
 * drawer and the hosted space-settings pop-up were each lost by one sidebar click, a tab click or a space chip; the tab strip even
 * UNMOUNTS the tab it leaves, so a half-typed form was destroyed with no question.
 *
 * ## The rules
 *
 * 1. Each record tab holds its create form while it is open, and its inline edit while a row is open, against what it was opened with:
 *    `UnsavedEdits.any()` is false untouched, true once a field differs, and false again after a save that succeeded or a cancel.
 * 2. The record drawer holds its edit draft against the record it opened (and re-baselines after a save).
 * 3. The hosted space-settings pop-up's `isDirty()` is held by the page.
 * 4. Switching the tab or the space asks the app's one discard question while a draft is held, and does nothing when it is declined.
 *    A clean switch is as immediate as it was.
 *
 * ## Seen red at a0238e3c
 *
 * `any()` was false for every case below that expects true, and a dirty tab switch changed the tab without asking.
 */
import { TestBed } from '@angular/core/testing';
import { By } from '@angular/platform-browser';
import { describe, it, expect, beforeEach } from 'vitest';
import { EMPTY, of } from 'rxjs';
import { ActivatedRoute } from '@angular/router';
import { SpacesApi } from '../../core/spaces-api.service';
import { BrainApi } from '../../core/brain-api.service';
import { FilesApi } from '../../core/files-api.service';
import { AdminApi } from '../../core/admin-api.service';
import { NetworksApi } from '../../core/networks-api.service';
import { AuthService } from '../../core/auth.service';
import { ConfirmDialogService } from '../../core/confirm-dialog.service';
import { UnsavedEdits } from '../../core/unsaved-edits';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { DRAWER_EDITORS, TAB_EDITORS, mountDrawer, mountTab, settle } from '../../testing/brain-editors-harness';
import { BrainComponent } from './brain.component';
import { FactsTabComponent } from './facts-tab.component';

/** The method that opens each tab's create form (the harness's `openCreate` also fills the form, which is not what "opened, untouched" means). */
const OPEN_FORM: Record<string, string> = { entity: 'openEntityForm', fact: 'openMemoryForm', edge: 'openEdgeForm', chrono: 'openChronoForm' };

beforeEach(() => TestBed.resetTestingModule());

describe('a record tab holds its create form and its inline edit (Q-701)', () => {
  for (const editor of TAB_EDITORS) {
    describe(editor.kind, () => {
      it('create form: clean untouched, dirty once filled, clean after a save that succeeded and after Cancel', async () => {
        const t = mountTab(editor);
        const unsaved = TestBed.inject(UnsavedEdits);
        expect(unsaved.any(), 'nothing is open').toBe(false);

        t.c[OPEN_FORM[editor.kind]!]();
        await settle(t.fixture);
        expect(unsaved.any(), 'an opened form nobody typed in loses nothing').toBe(false);

        editor.openCreate(t.c);
        await settle(t.fixture);
        expect(unsaved.any(), 'a filled create form would be lost by leaving').toBe(true);

        t.answerCreate({});
        editor.submitCreate(t.c);
        await settle(t.fixture);
        expect(unsaved.any(), 'the form closed on a successful create').toBe(false);

        editor.openCreate(t.c);
        await settle(t.fixture);
        expect(unsaved.any()).toBe(true);
        t.c[`show${{ entity: 'Entity', fact: 'Memory', edge: 'Edge', chrono: 'Chrono' }[editor.kind]}Form`].set(false);
        expect(unsaved.any(), 'Cancel closes the form').toBe(false);
      });

      it('inline edit: clean as opened, dirty once a field changes, clean after a save that succeeded and after Cancel', async () => {
        const t = mountTab(editor);
        const unsaved = TestBed.inject(UnsavedEdits);
        const record = editor.record();

        editor.openEdit(t.c, record);
        await settle(t.fixture);
        expect(unsaved.any(), 'an edit row opened and not touched loses nothing').toBe(false);

        t.c[editor.editForm].description = 'changed by the person';
        expect(unsaved.any(), 'an edited row would be lost by leaving').toBe(true);

        t.answerUpdate(record, {});
        editor.submitEdit(t.c, record._id);
        await settle(t.fixture);
        expect(unsaved.any(), 'the row closed on a successful save').toBe(false);

        editor.openEdit(t.c, record);
        t.c[editor.editForm].description = 'changed again';
        expect(unsaved.any()).toBe(true);
        t.c.recordList.cancelEdit();
        expect(unsaved.any(), 'Cancel closes the row').toBe(false);
      });
    });
  }
});

describe('the record drawer holds its edit draft (Q-701)', () => {
  for (const editor of DRAWER_EDITORS) {
    it(`${editor.kind}: clean as opened, dirty once a field changes, clean after a save that succeeded and after close`, async () => {
      const d = mountDrawer(editor);
      const unsaved = TestBed.inject(UnsavedEdits);
      const record = editor.record();
      expect(unsaved.any(), 'the drawer is closed').toBe(false);

      (d.state.open as (kind: string, record: unknown) => void)(editor.kind, record);
      await settle(d.fixture);
      expect(unsaved.any(), 'a record opened and not touched loses nothing').toBe(false);

      (d.state as any)[editor.editModel].description = 'changed by the person';
      expect(unsaved.any(), 'a drawer edit would be lost by leaving').toBe(true);

      d.answerUpdate(record, {});
      d.state.save();
      await settle(d.fixture);
      expect(unsaved.any(), 'what was sent is what is stored now').toBe(false);

      (d.state as any)[editor.editModel].description = 'changed again';
      expect(unsaved.any()).toBe(true);
      d.state.close();
      expect(unsaved.any(), 'a closed drawer holds nothing').toBe(false);
    });
  }

  it('a refused save keeps the draft held', async () => {
    const editor = DRAWER_EDITORS[1]!;
    const d = mountDrawer(editor);
    const unsaved = TestBed.inject(UnsavedEdits);
    d.state.open('fact', editor.record());
    await settle(d.fixture);
    d.state.drawerEditMemory.description = 'changed by the person';
    d.failUpdate(422, { error: 'schema_violation', message: 'no', introduced: [], preExisting: [], violations: [] });
    d.state.save();
    await settle(d.fixture);
    expect(unsaved.any(), 'the refused edit is still in the drawer').toBe(true);
  });
});

/** The page over a stubbed API, with the discard question answered by `answer.value`. */
function mountBrain(spaceIds: readonly string[] = ['work', 'other']) {
  const api = {
    listSpaces: () => of({ spaces: spaceIds.map(id => ({ id, label: id })) }),
    getSpaceStats: () => of({ facts: 0, entities: 0, edges: 0, chrono: 0, files: 0 }),
    getReindexStatus: () => of({ needsReindex: false }),
    getSpaceMeta: () => of({ tagSuggestions: [], typeSchemas: {} }),
    listFacts: () => of({ facts: [] }),
    getEntitiesByIds: () => of({ entities: [] }),
    mintEventsTicket: () => of({ ticket: 't', expiresInMs: 60000 }),
    getErModel: () => of({ spaceId: 'work', entityTypes: [], relationships: [], danglingEdges: 0, truncated: null, totals: { entities: 0, edges: 0 } }),
    getAbout: () => of(null), getEmbeddingQueue: () => of(null), getTokenAccess: () => of({ tokens: [] }), getCompleteness: () => of(null),
    getSpaceActivity: () => of({ spaceId: 'general', hours: 168, spaces: [] }), listVotes: () => of({ rounds: [] }),
  } as any;
  const answer = { value: false };
  const asked: unknown[] = [];
  TestBed.configureTestingModule({
    imports: [BrainComponent, getTranslocoModule()],
    providers: [
      { provide: SpacesApi, useValue: api }, { provide: BrainApi, useValue: api }, { provide: FilesApi, useValue: api },
      { provide: AdminApi, useValue: api }, { provide: NetworksApi, useValue: api },
      { provide: AuthService, useValue: { token: () => '' } },
      { provide: ActivatedRoute, useValue: { snapshot: { queryParamMap: { get: () => '' } }, queryParamMap: EMPTY } },
      { provide: ConfirmDialogService, useValue: { confirm: (o: unknown) => { asked.push(o); return Promise.resolve(answer.value); } } },
    ],
  });
  const fixture = TestBed.createComponent(BrainComponent);
  fixture.detectChanges();
  return { fixture, c: fixture.componentInstance, unsaved: TestBed.inject(UnsavedEdits), answer, asked };
}

describe('the Brain page asks before a tab or a space switch destroys a draft (Q-701)', () => {
  async function onFactsWithADraft() {
    const b = mountBrain();
    await b.c.setTab('facts');
    b.fixture.detectChanges();
    const tab = b.fixture.debugElement.query(By.directive(FactsTabComponent)).componentInstance as FactsTabComponent;
    tab.openMemoryForm();
    tab.memoryForm.fact = 'half typed';
    return { ...b, tab };
  }

  it('a tab switch with a dirty create form asks, and stays on the tab when declined', async () => {
    const b = await onFactsWithADraft();
    expect(b.unsaved.any()).toBe(true);
    b.answer.value = false;
    expect(await b.c.setTab('overview')).toBe(false);
    expect(b.asked.length, 'the discard question was asked once').toBe(1);
    expect(b.c.activeTab(), 'declined: nothing changed').toBe('facts');
    expect(b.tab.memoryForm.fact, 'the draft is still there').toBe('half typed');
  });

  it('a tab switch goes through when the discard is confirmed', async () => {
    const b = await onFactsWithADraft();
    b.answer.value = true;
    expect(await b.c.setTab('overview')).toBe(true);
    expect(b.c.activeTab()).toBe('overview');
    b.fixture.detectChanges();
    expect(b.unsaved.any(), 'the tab was destroyed with its draft, and its check went with it').toBe(false);
  });

  it('a space switch with a dirty draft asks, and stays on the space when declined', async () => {
    const b = await onFactsWithADraft();
    b.answer.value = false;
    expect(await b.c.selectSpace('other')).toBe(false);
    expect(b.asked.length).toBe(1);
    expect(b.c.activeSpaceId(), 'declined: still on the first space').toBe('work');
    expect(b.c.activeTab()).toBe('facts');
    b.answer.value = true;
    expect(await b.c.selectSpace('other')).toBe(true);
    expect(b.c.activeSpaceId()).toBe('other');
    expect(b.c.activeTab(), 'a switch lands on the space overview').toBe('overview');
  });

  it('a clean switch asks nothing and is immediate', async () => {
    const b = mountBrain();
    void b.c.setTab('entities');
    expect(b.c.activeTab(), 'no await needed when nothing is dirty').toBe('entities');
    void b.c.selectSpace('other');
    expect(b.c.activeSpaceId()).toBe('other');
    expect(b.asked).toEqual([]);
  });

  it('a discarded inline edit is gone: going back to the tab shows the row as a row, not an empty edit form', async () => {
    // The row being edited lives in page state (RecordListState.editingId), which outlives the tab. Before this, a confirmed switch
    // away and back re-rendered that row in edit mode over a blank model (found by bundle-238's brain group).
    for (const away of ['tab', 'space'] as const) {
      TestBed.resetTestingModule();
      const b = mountBrain();
      await b.c.setTab('facts');
      b.c.recordList.editingId.set('m1');
      b.answer.value = true;
      if (away === 'tab') await b.c.setTab('overview'); else await b.c.selectSpace('other');
      expect(b.c.recordList.editingId(), `a ${away} switch kept the discarded edit's row in edit mode`).toBe('');
    }
  });

  it('re-clicking the tab you are on keeps an inline edit open', async () => {
    const b = await onFactsWithADraft();
    b.c.recordList.editingId.set('m1');
    await b.c.setTab('facts');
    expect(b.c.recordList.editingId()).toBe('m1');
  });

  it('clicking the tab you are on does not ask', async () => {
    const b = await onFactsWithADraft();
    await b.c.setTab('facts');
    expect(b.asked).toEqual([]);
    expect(b.c.activeTab()).toBe('facts');
  });

  it('the hosted space-settings pop-up holds its draft while open', () => {
    const b = mountBrain();
    expect(b.unsaved.any()).toBe(false);
    b.c.openSpaceSettings();
    expect(b.unsaved.any(), 'opened and untouched').toBe(false);
    b.c.spaceSettings.stForm.label = 'a new label';
    expect(b.unsaved.any(), 'an edited label would be lost by leaving the page').toBe(true);
    b.c.spaceSettings.closeSettings();
    expect(b.unsaved.any(), 'a closed pop-up holds nothing').toBe(false);
  });
});
