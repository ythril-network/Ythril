import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { RecordListState } from './record-list-state.service';

/**
 * The state is built through the injector: `failEdit` words a coded refusal (bundle-81, decision 27), so it holds the translation service, and
 * `new RecordListState()` outside an injection context has none to hold. The two cases below are otherwise as they were.
 */
function state(): RecordListState {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({ imports: [getTranslocoModule()], providers: [RecordListState] });
  return TestBed.inject(RecordListState);
}

describe('RecordListState', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('starts idle', () => {
    const s = state();
    expect(s.loading()).toBe(false);
    expect(s.loadError()).toBeNull();
    expect(s.editingId()).toBe('');
    expect(s.confirmDeleteId()).toBe('');
  });

  it('cancelEdit clears the editing id and error but leaves saving/confirm untouched', () => {
    const s = state();
    s.editingId.set('m1');
    s.editError.set('boom');
    s.editSaving.set(true);
    s.confirmDeleteId.set('m2');

    s.cancelEdit();

    expect(s.editingId()).toBe('');
    expect(s.editError()).toBe('');
    // cancelEdit is intentionally narrow — it does not touch saving or the delete confirmation.
    expect(s.editSaving()).toBe(true);
    expect(s.confirmDeleteId()).toBe('m2');
  });
});
