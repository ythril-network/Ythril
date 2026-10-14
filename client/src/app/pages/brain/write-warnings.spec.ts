/**
 * A write that SUCCEEDED can still carry `warnings`, and every record editor keeps them on screen (bundle-23, R6-14).
 *
 * Under `warn` mode (and for a violation a strict space does not block) the server stores the record and answers it with
 * `warnings: Row[]`. Until now no editor read the field, so the one signal that says "this record breaks the schema" was
 * dropped on the floor by exactly the screens an operator writes records from. A toast is not an answer: it goes in
 * seconds, and a warning is about a record that stays wrong until someone fixes it. So the contract is a persistent inline
 * notice, `[data-testid="write-warnings"]` with `role="status"`, in every editor, that:
 *   - lists each warning's field,
 *   - is not a toast,
 *   - is still there after later change detection and after a minute of timers,
 *   - is replaced by the next save's warnings and gone when a save carries none,
 *   - can be dismissed with `[data-testid="write-warnings-dismiss"]`.
 *
 * The editors are a table (`testing/brain-editors-harness.ts`): the four tabs, each through its create form AND its inline
 * edit, and the record drawer for all four kinds. The table is checked against the source so a fifth editor is a red test,
 * not an untested screen. Red on the unchanged base because nothing renders the notice and `RecordDrawerState` has no
 * `drawerWarnings`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { TestBed } from '@angular/core/testing';
import { of } from 'rxjs';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import {
  TAB_EDITORS, DRAWER_EDITORS, derivedEditorTabFiles, derivedDrawerKinds, uncoveredEditors,
  mountTab, mountDrawer, settle, writeWarningsNotice, WARNINGS_DISMISS_SELECTOR,
  type MountedTab, type MountedDrawer, type TabEditor, type DrawerEditor, type WireRow,
} from '../../testing/brain-editors-harness';

const FIRST: WireRow[] = [{ field: 'properties.colour', reason: 'is not declared for this type', outcome: 'violated', declared: ['size'] }];
const SECOND: WireRow[] = [
  { field: 'properties.shade', reason: 'is not declared for this type', outcome: 'violated', declared: ['size'] },
  { field: 'properties.finish', reason: 'is not declared for this type', outcome: 'violated', declared: ['size'] },
];

const text = (el: HTMLElement | null): string => el?.textContent ?? '';

describe('the editor table covers every record editor the source has', () => {
  it('derives a non-empty set and finds nothing uncovered', () => {
    expect(derivedEditorTabFiles().length, 'no editor tab was derived: the derivation is broken').toBeGreaterThanOrEqual(4);
    expect(derivedDrawerKinds().length, 'no drawer kind was derived: the derivation is broken').toBeGreaterThanOrEqual(4);
    expect(uncoveredEditors()).toEqual([]);
  });
});

type Via = 'create' | 'edit';
const VIAS: Via[] = ['create', 'edit'];

/** One write through `via`, answered with `warnings` (absent when undefined). Ends with change detection run. */
function write(m: MountedTab, ed: TabEditor, via: Via, warnings?: WireRow[]): void {
  const extra = warnings === undefined ? {} : { warnings };
  const call = via === 'create' ? ed.createApi : ed.updateApi;
  const before = m.api[call].mock.calls.length;
  if (via === 'create') {
    m.answerCreate(extra);
    ed.openCreate(m.c);
    ed.submitCreate(m.c);
  } else {
    const rec = ed.record();
    m.c.store[ed.storeList].set([rec]);
    m.answerUpdate(rec, extra);
    ed.openEdit(m.c, rec);
    ed.submitEdit(m.c, rec._id);
  }
  // The driver must have reached the API, or "no notice" would prove nothing about the editor.
  expect(m.api[call].mock.calls.length, `${call} was not called: the spec's driver did not submit`).toBe(before + 1);
  m.fixture.detectChanges();
}

describe.each(TAB_EDITORS.map(ed => [ed.kind, ed] as const))('the %s tab keeps the warnings of a successful write', (_kind, ed) => {
  describe.each(VIAS)('through its %s path', (via) => {
    let m: MountedTab;
    beforeEach(() => { m = mountTab(ed); });
    afterEach(() => { vi.useRealTimers(); });

    it('shows a role=status notice that lists the warning field, and raises no toast', () => {
      write(m, ed, via, FIRST);
      const notice = writeWarningsNotice(m.host);
      expect(notice, 'no [data-testid="write-warnings"] after a write that carried warnings').not.toBeNull();
      expect(notice!.getAttribute('role')).toBe('status');
      expect(text(notice)).toContain('colour');
      expect(m.toast.toasts(), 'a warning about a record that stays wrong must not be a toast').toEqual([]);
    });

    it('is still there after further change detection and a minute of timers', () => {
      vi.useFakeTimers();
      write(m, ed, via, FIRST);
      m.fixture.detectChanges();
      m.fixture.detectChanges();
      vi.advanceTimersByTime(60_000);
      m.fixture.detectChanges();
      expect(writeWarningsNotice(m.host), 'the notice went away without being dismissed').not.toBeNull();
      expect(text(writeWarningsNotice(m.host))).toContain('colour');
    });

    it('is replaced by the next save\'s warnings', () => {
      write(m, ed, via, FIRST);
      write(m, ed, via, SECOND);
      const t = text(writeWarningsNotice(m.host));
      expect(t).toContain('shade');
      expect(t).toContain('finish');
      expect(t, 'the previous save\'s warning is still listed').not.toContain('colour');
    });

    it('is gone when a later save carries no warnings', () => {
      write(m, ed, via, FIRST);
      expect(writeWarningsNotice(m.host), 'precondition: the first save\'s warnings are shown').not.toBeNull();
      write(m, ed, via, undefined);
      expect(writeWarningsNotice(m.host), 'a stale warning outlived the clean save that fixed it').toBeNull();
      write(m, ed, via, FIRST);
      expect(writeWarningsNotice(m.host), 'precondition: the warnings are shown again').not.toBeNull();
      write(m, ed, via, []);
      expect(writeWarningsNotice(m.host), 'an empty warnings list must not render an empty notice').toBeNull();
    });

    it('can be dismissed, stays dismissed, and a later save\'s warnings show it again', () => {
      write(m, ed, via, FIRST);
      const close = m.host.querySelector<HTMLElement>(WARNINGS_DISMISS_SELECTOR);
      expect(close, 'no [data-testid="write-warnings-dismiss"] to close the notice with').not.toBeNull();
      close!.click();
      m.fixture.detectChanges();
      m.fixture.detectChanges();
      expect(writeWarningsNotice(m.host)).toBeNull();
      write(m, ed, via, SECOND);
      expect(text(writeWarningsNotice(m.host))).toContain('shade');
    });
  });
});

/** One drawer save answered with `warnings`; the drawer stays open after a save. */
function saveDrawer(m: MountedDrawer, ed: DrawerEditor, warnings?: WireRow[]): void {
  const rec = ed.record();
  if (m.state.drawerRecord() === null) m.state.open(ed.kind as never, rec as never);
  const before = m.api[ed.updateApi].mock.calls.length;
  m.answerUpdate(rec, warnings === undefined ? {} : { warnings });
  m.state.save();
  expect(m.api[ed.updateApi].mock.calls.length, `${ed.updateApi} was not called: the drawer did not save`).toBe(before + 1);
  m.fixture.detectChanges();
}

describe.each(DRAWER_EDITORS.map(ed => [ed.kind, ed] as const))('the record drawer (%s) keeps the warnings of a successful save', (_kind, ed) => {
  let m: MountedDrawer;
  beforeEach(() => { m = mountDrawer(ed); });
  afterEach(() => { vi.useRealTimers(); });

  it('shows a role=status notice inside the drawer that lists the warning field, and raises no toast', () => {
    saveDrawer(m, ed, FIRST);
    expect(m.state.drawerRecord(), 'the drawer is meant to stay open after a save').not.toBeNull();
    const notice = m.host.querySelector<HTMLElement>('.drawer [data-testid="write-warnings"]');
    expect(notice, 'no [data-testid="write-warnings"] inside the drawer').not.toBeNull();
    expect(notice!.getAttribute('role')).toBe('status');
    expect(text(notice)).toContain('colour');
    expect(m.toast.toasts()).toEqual([]);
  });

  it('is still there after further change detection and a minute of timers', () => {
    vi.useFakeTimers();
    saveDrawer(m, ed, FIRST);
    m.fixture.detectChanges();
    vi.advanceTimersByTime(60_000);
    m.fixture.detectChanges();
    expect(text(writeWarningsNotice(m.host))).toContain('colour');
  });

  it('is replaced by the next save\'s warnings and gone when a save carries none', () => {
    saveDrawer(m, ed, FIRST);
    saveDrawer(m, ed, SECOND);
    const t = text(writeWarningsNotice(m.host));
    expect(t).toContain('shade');
    expect(t).not.toContain('colour');
    saveDrawer(m, ed, undefined);
    expect(m.state.drawerRecord(), 'the drawer stays open after the clean save').not.toBeNull();
    expect(writeWarningsNotice(m.host)).toBeNull();
  });

  it('can be dismissed with the close button', () => {
    saveDrawer(m, ed, FIRST);
    const close = m.host.querySelector<HTMLElement>(WARNINGS_DISMISS_SELECTOR);
    expect(close, 'no [data-testid="write-warnings-dismiss"] in the drawer').not.toBeNull();
    close!.click();
    m.fixture.detectChanges();
    expect(writeWarningsNotice(m.host)).toBeNull();
  });
});

/** RecordDrawerState on its own, as record-drawer-state.service.spec.ts mounts it: the signal the drawer renders. */
describe('RecordDrawerState.drawerWarnings', () => {
  function create(): RecordDrawerState {
    TestBed.resetTestingModule();
    const answers: Record<string, unknown> = {};
    TestBed.configureTestingModule({
      providers: [RecordDrawerState, BrainStore, EntityRefPicker, {
        provide: BrainApi,
        useValue: {
          getEntitiesByIds: () => of({ entities: [] }), getRecordsByIds: () => of([]),
          updateFact: (_s: string, id: string, _b: unknown) => of({ _id: id, ...(answers['fact'] as object) }),
          updateEntity: (_s: string, id: string, _b: unknown) => of({ _id: id, ...(answers['entity'] as object) }),
          updateEdge: (_s: string, id: string, _b: unknown) => of({ _id: id, ...(answers['edge'] as object) }),
          updateChrono: (_s: string, id: string, _b: unknown) => of({ _id: id, ...(answers['chrono'] as object) }),
        },
      }],
    });
    const state = TestBed.inject(RecordDrawerState);
    state.spaceId.set('work');
    (state as unknown as { _answers: Record<string, unknown> })._answers = answers;
    return state;
  }
  const warningsOf = (s: RecordDrawerState): unknown => (s as unknown as { drawerWarnings?: () => unknown }).drawerWarnings?.();
  const answerWith = (s: RecordDrawerState, kind: string, extra: object): void => {
    (s as unknown as { _answers: Record<string, unknown> })._answers[kind] = extra;
  };

  it.each(DRAWER_EDITORS.map(e => [e.kind, e] as const))('holds the rows of a successful %s save, replaces them, and empties on a clean save', (_k, ed) => {
    const s = create();
    s.open(ed.kind as never, ed.record() as never);
    answerWith(s, ed.kind, { warnings: FIRST });
    s.save();
    expect(warningsOf(s)).toEqual(FIRST);
    answerWith(s, ed.kind, { warnings: SECOND });
    s.save();
    expect(warningsOf(s)).toEqual(SECOND);
    answerWith(s, ed.kind, {});
    s.save();
    expect(((warningsOf(s) as unknown[] | null | undefined) ?? []).length).toBe(0);
  });

  it('is not left over when the drawer is opened on another record', () => {
    const s = create();
    const ed = DRAWER_EDITORS[0];
    s.open(ed.kind as never, ed.record() as never);
    answerWith(s, ed.kind, { warnings: FIRST });
    s.save();
    expect(warningsOf(s), 'precondition: the save recorded its warnings').toEqual(FIRST);
    s.open(ed.kind as never, ed.record({ _id: 'other' }) as never);
    expect(((warningsOf(s) as unknown[] | null | undefined) ?? []).length, 'another record inherited the previous record\'s warnings').toBe(0);
  });
});
