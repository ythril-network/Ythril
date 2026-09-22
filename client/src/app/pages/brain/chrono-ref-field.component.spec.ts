/**
 * ChronoRefFieldComponent — the extracted chrono-reference field (chips + inline title typeahead).
 *
 * Third sibling of the entity/memory ref-field specs. File-meta (its only consumer) is guarded by its
 * own spec; this pins the extracted component's contract: it renders the picker's chip titles for the
 * bound `target`, hosts the `.mem-pick` search, and add/remove mutate the SAME target object's
 * `linkChronos` by reference.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import type { ChronoEntry } from '../../core/api.types';
import { EntityRefPicker } from './entity-ref-picker.service';
import { BrainStore } from './brain-store.service';
import { ChronoRefFieldComponent } from './chrono-ref-field.component';
import { isOnPush } from '../../testing/onpush';

function make(target: { linkChronos: string[] }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [ChronoRefFieldComponent, getTranslocoModule()],
    providers: [
      EntityRefPicker, BrainStore,
      { provide: BrainApi, useValue: { listChrono: vi.fn(() => of({ chrono: [] })), getChrono: vi.fn(() => of({} as ChronoEntry)) } },
    ],
  });
  const fixture = TestBed.createComponent(ChronoRefFieldComponent);
  fixture.componentRef.setInput('target', target);
  fixture.detectChanges();
  return fixture;
}

describe('ChronoRefFieldComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(ChronoRefFieldComponent)).toBe(true);
  });

  it('always hosts the inline chrono search', () => {
    const f = make({ linkChronos: [] });
    expect(f.nativeElement.querySelector('.mem-pick input[type="search"]')).toBeTruthy();
  });

  it('renders a chip per linked id, using the picker title cache for the label', () => {
    const f = make({ linkChronos: ['c1'] });
    TestBed.inject(EntityRefPicker).chronoTitleCache.set({ c1: 'Launch day' });
    f.detectChanges();
    const chips = [...f.nativeElement.querySelectorAll('.chip .chip-name')].map(n => n.textContent?.trim());
    expect(chips).toEqual(['Launch day']);
  });

  it('adding a chrono entry appends to the bound target by reference and caches its title', () => {
    const target = { linkChronos: [] as string[] };
    make(target);
    const picker = TestBed.inject(EntityRefPicker);
    picker.addChronoRef(target, { _id: 'c9', title: 'Q3 review' } as ChronoEntry);
    expect(target.linkChronos).toEqual(['c9']);
    expect(picker.chronoRefTitle('c9')).toBe('Q3 review');
  });

  it('removing a chrono entry mutates the bound target by reference', () => {
    const target = { linkChronos: ['c1', 'c2'] };
    make(target);
    TestBed.inject(EntityRefPicker).removeChronoRef(target, 'c1');
    expect(target.linkChronos).toEqual(['c2']);
  });
});
