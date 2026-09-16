/**
 * U4 — unsaved-changes tracking in SpaceSettingsState.
 *
 * `isDirty()` drives the guard on all three editor exits (modal close, route leave, reload). It must
 * baseline clean on open, flip on any persisted edit (settings + schema + duplicates), ignore
 * transient/UI-only state, and re-baseline on markPristine — otherwise the guard either nags on a
 * pristine dialog or lets real edits vanish silently. The duplicates tab has its OWN save button, so
 * it's snapshotted separately (`dupeSnapshot`/`markDupePristine`) but still feeds `isDirty()`.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import type { Space } from '../../core/api.types';
import { SpacesApi } from '../../core/spaces-api.service';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSettingsState } from './space-settings-state.service';

function space(over: Partial<Space> = {}): Space {
  return { id: 'general', label: 'General', ...over } as Space;
}

describe('SpaceSettingsState — unsaved-changes (U4)', () => {
  let state: SpaceSettingsState;

  beforeEach(() => {
    TestBed.configureTestingModule({
      imports: [getTranslocoModule()],
      providers: [
        SpaceSettingsState,
        { provide: SpacesApi, useValue: { getSpaceStats: () => of({}) } },
      ],
    });
    state = TestBed.inject(SpaceSettingsState);
  });

  it('is not dirty when no dialog is open', () => {
    expect(state.isDirty()).toBe(false);
  });

  it('baselines clean immediately after openSettings', () => {
    state.openSettings(space({ meta: { purpose: 'hi' } }));
    expect(state.isDirty()).toBe(false);
  });

  it('goes dirty when a settings-tab field changes, clean again after markPristine', () => {
    state.openSettings(space());
    state.stForm.purpose = 'a new purpose';
    expect(state.isDirty()).toBe(true);
    state.markPristine();
    expect(state.isDirty()).toBe(false);
  });

  it('goes dirty when a schema type is added', () => {
    state.openSettings(space());
    state.schNewTypeInputs['entity'] = 'person';
    state.addType('entity');
    expect(state.isDirty()).toBe(true);
  });

  it('ignores transient input buffers and UI state', () => {
    state.openSettings(space());
    // Half-typed new-type input, active tab, selected type — none of these persist.
    state.schNewTypeInputs['entity'] = 'draft';
    state.settingsTab.set('schema');
    state.schemaCollTab.set('fact');
    state.schSelectedType = { kt: 'entity', name: 'whatever' };
    expect(state.isDirty()).toBe(false);
  });

  it('is not dirty after an edit is reverted (buildMeta normalization)', () => {
    state.openSettings(space());
    state.stForm.purpose = 'temp';
    expect(state.isDirty()).toBe(true);
    state.stForm.purpose = '';
    expect(state.isDirty()).toBe(false);
  });

  it('is not dirty once the dialog is closed even if fields still differ', () => {
    state.openSettings(space());
    state.stForm.purpose = 'edited';
    state.closeSettings();
    expect(state.isDirty()).toBe(false);
  });

  // ── duplicates tab (previously untracked → silent data loss on tab-switch/close) ──
  it('goes dirty when a duplicate rule is added', () => {
    state.openSettings(space());
    state.addDupeRule();
    expect(state.isDirty()).toBe(true);
  });

  it('goes dirty when the duplicate survivor policy or on-insert flag changes', () => {
    state.openSettings(space());
    state.dupeSurvivor = 'newer';
    expect(state.isDirty()).toBe(true);
    state.dupeSurvivor = 'older';
    expect(state.isDirty()).toBe(false);
    state.dupeOnInsert = true;
    expect(state.isDirty()).toBe(true);
  });

  it('markDupePristine re-baselines the duplicates snapshot after its own save', () => {
    state.openSettings(space());
    state.addDupeRule();
    expect(state.isDirty()).toBe(true);
    state.markDupePristine();          // what saveDupeRules() calls on success
    expect(state.isDirty()).toBe(false);
  });
});
