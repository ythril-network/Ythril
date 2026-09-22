/**
 * FactRefFieldComponent — the extracted memory-reference field (chips + inline title typeahead).
 *
 * Sibling of the entity-ref-field spec. The two call sites (chrono create form + drawer chrono) are
 * guarded by their own specs; this pins the extracted component's own contract: it renders the picker's
 * chip titles for the bound `target`, hosts the `.mem-pick` search, and add/remove mutate the SAME
 * target object's `linkFacts` by reference.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import type { Fact } from '../../core/api.types';
import { EntityRefPicker } from './entity-ref-picker.service';
import { BrainStore } from './brain-store.service';
import { FactRefFieldComponent } from './fact-ref-field.component';
import { isOnPush } from '../../testing/onpush';

function make(target: { linkFacts: string[] }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [FactRefFieldComponent, getTranslocoModule()],
    providers: [
      EntityRefPicker, BrainStore,
      { provide: BrainApi, useValue: { listFacts: vi.fn(() => of({ facts: [] })), getMemory: vi.fn(() => of({} as Fact)) } },
    ],
  });
  const fixture = TestBed.createComponent(FactRefFieldComponent);
  fixture.componentRef.setInput('target', target);
  fixture.detectChanges();
  return fixture;
}

describe('FactRefFieldComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(FactRefFieldComponent)).toBe(true);
  });

  it('always hosts the inline memory search', () => {
    const f = make({ linkFacts: [] });
    expect(f.nativeElement.querySelector('.mem-pick input[type="search"]')).toBeTruthy();
  });

  it('renders a chip per linked id, using the picker title cache for the label', () => {
    const f = make({ linkFacts: ['m1'] });
    TestBed.inject(EntityRefPicker).memoryTitleCache.set({ m1: 'the cached fact' });
    f.detectChanges();
    const chips = [...f.nativeElement.querySelectorAll('.chip .chip-name')].map(n => n.textContent?.trim());
    expect(chips).toEqual(['the cached fact']);
  });

  it('adding a memory appends to the bound target by reference and caches its fact', () => {
    const target = { linkFacts: [] as string[] };
    make(target);
    const picker = TestBed.inject(EntityRefPicker);
    picker.addMemoryRef(target, { _id: 'm9', fact: 'a new fact' } as Fact);
    expect(target.linkFacts).toEqual(['m9']);
    expect(picker.memoryRefTitle('m9')).toBe('a new fact');
  });

  it('removing a memory mutates the bound target by reference', () => {
    const target = { linkFacts: ['m1', 'm2'] };
    make(target);
    TestBed.inject(EntityRefPicker).removeMemoryRef(target, 'm1');
    expect(target.linkFacts).toEqual(['m2']);
  });
});
