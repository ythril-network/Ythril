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
import { provideHttpClient } from '@angular/common/http';
import { HttpTestingController, provideHttpClientTesting } from '@angular/common/http/testing';
import { describe, it, expect, beforeEach } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';
import { RecordDrawerState } from './record-drawer-state.service';
import { RecordDrawerComponent } from './record-drawer.component';
import { isOnPush } from '../../testing/onpush';
import { aMemory, anEntity } from '../../testing/records';

/** getEntitiesByIds is the only API the open() → resolveEntityNames path can touch here. */
function makeApi() {
  return { getEntitiesByIds: () => of({ entities: [] }) } as any;
}

describe('RecordDrawerComponent', () => {
  function create() {
    TestBed.configureTestingModule({
      imports: [RecordDrawerComponent, getTranslocoModule()],
      providers: [
        // The Type definition row (b268, C3) reads the versions door through the real SchemaApi.
        provideHttpClient(), provideHttpClientTesting(),
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

  describe('the Type definition row (b268, C3, design r4 §7.7)', () => {
    const asksOf = (http: HttpTestingController) => http.match(r => r.url.split('?')[0] === '/api/spaces/work/schema-versions').map(req => {
      const q = new URLSearchParams(req.request.urlWithParams.split('?')[1] ?? '');
      for (const k of req.request.params.keys()) q.set(k, req.request.params.get(k)!);
      return Object.fromEntries(q);
    });

    it('sits right after Seq, and asks the standing of the record\'s own stamp for its kind and type', async () => {
      const fixture = create();
      const state = TestBed.inject(RecordDrawerState);
      const http = TestBed.inject(HttpTestingController);
      state.spaceId.set('work');
      state.open('entity', anEntity({ type: 'person', schemaFingerprint: 'cc33dd44cc33dd44' } as never));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const drawer = fixture.nativeElement.querySelector('.drawer') as HTMLElement;
      const row = drawer.querySelector('app-record-type-definition');
      expect(row, 'the drawer has no Type definition row').not.toBeNull();
      const field = row!.closest('.drawer-field') ?? row!;
      const before = field.previousElementSibling as HTMLElement | null;
      expect(before?.textContent, 'the row does not follow Seq').toContain('common.seq');
      expect(asksOf(http)).toEqual([{ fps: 'cc33dd44cc33dd44', kind: 'entity', type: 'person' }]);
    });

    it('a record with no stamp shows the row as No version and asks nothing', async () => {
      const fixture = create();
      const state = TestBed.inject(RecordDrawerState);
      const http = TestBed.inject(HttpTestingController);
      state.spaceId.set('work');
      state.open('entity', anEntity({ type: 'person' }));
      fixture.detectChanges();
      await fixture.whenStable();
      fixture.detectChanges();
      const row = (fixture.nativeElement as HTMLElement).querySelector('app-record-type-definition');
      expect(row, 'the drawer has no Type definition row').not.toBeNull();
      expect(row!.textContent).toContain('brain.drawer.typeDefinition.none');
      expect(asksOf(http)).toEqual([]);
    });
  });
});
