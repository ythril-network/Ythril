/**
 * RecordDrawerComponent — the drawer's rendering contract, relocated here when it became its own
 * component (A17.9b-5). Two of these began life in brain.component.spec.ts against the monolith.
 *
 * The load-bearing case: the drawer renders PLAIN edit models (`drawerEditMemory`, …) through ngModel.
 * A plain-field write does not mark an OnPush view dirty on its own — these render only because
 * `RecordDrawerState.open()` writes the `drawerRecord` SIGNAL in the same turn. The component is
 * OnPush from birth, so if that sibling signal write were ever dropped the title would render empty
 * and the first test would fail rather than the bug shipping silently.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordDrawerComponent } from './record-drawer.component';
import { isOnPush } from '../../testing/onpush';
import { aMemory } from '../../testing/records';

/** getEntitiesByIds is the only API the open() → resolveEntityNames path can touch here. */
function makeApi() {
  return { getEntitiesByIds: () => of({ entities: [] }) } as any;
}

describe('RecordDrawerComponent', () => {
  function create() {
    TestBed.configureTestingModule({
      imports: [RecordDrawerComponent, getTranslocoModule()],
      providers: [
        RecordDrawerState,
        BrainStore,
        EntityRefPicker,
        { provide: BrainApi, useValue: makeApi() },
      ],
    });
    const fixture = TestBed.createComponent(RecordDrawerComponent);
    fixture.detectChanges();
    return fixture;
  }

  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(RecordDrawerComponent)).toBe(true);
  });

  it('renders nothing until a record is opened', () => {
    const fixture = create();
    expect(fixture.nativeElement.querySelector('.drawer')).toBeNull();
  });

  it('opens the detail drawer AND renders its plain (non-signal) form model', async () => {
    // The load-bearing case. `open()` writes the `drawerRecord` SIGNAL (which marks the OnPush view
    // dirty) and the plain `drawerEditMemory` field in the same turn. The drawer title binds that
    // plain field — so this asserts the plain-field write is picked up by the CD pass the signal
    // write scheduled. Drop the sibling signal write and this goes blank.
    const fixture = create();
    const state = TestBed.inject(RecordDrawerState);

    state.open('fact', aMemory({ fact: 'a load-bearing fact' }));
    fixture.detectChanges();

    const drawer = fixture.nativeElement.querySelector('.drawer');
    expect(drawer, 'the drawer should be open').toBeTruthy();
    const title = fixture.nativeElement.querySelector('.drawer-title') as HTMLElement;
    expect(title.textContent).toContain('a load-bearing fact');

    // And the ngModel-bound textarea reflects the same plain field. ngModel writes its DOM value in
    // a microtask, so let that settle before reading it.
    await fixture.whenStable();
    const textarea = drawer.querySelector('textarea') as HTMLTextAreaElement;
    expect(textarea.value).toBe('a load-bearing fact');
  });

  it('edits the description in a multiline <textarea> (F7), preserving newlines', async () => {
    // F7 swapped the single-line description <input> for a <textarea rows=3>. A record whose
    // description spans several lines must round-trip those newlines into the editor.
    const fixture = create();
    const state = TestBed.inject(RecordDrawerState);
    const multiline = 'line one\nline two\nline three';

    state.open('fact', aMemory({ fact: 'f', description: multiline }));
    fixture.detectChanges();
    await fixture.whenStable();

    const descField = fixture.nativeElement.querySelector(
      '.drawer textarea[name="drwMemDesc"]',
    ) as HTMLTextAreaElement | null;
    // It must be a textarea (not the old input), and it must keep the newlines.
    expect(descField, 'description should be a <textarea>').toBeTruthy();
    expect(descField!.tagName).toBe('TEXTAREA');
    expect(descField!.value).toBe(multiline);
  });
});
