/**
 * EntityRefFieldComponent — the extracted entity-chip field (chips + inline picker).
 *
 * The six create/edit/drawer copies of this block are guarded by their own tab specs; this spec pins
 * the extracted component's own contract: it renders the picker's chips for the bound `target`, hosts
 * the inline `app-entity-search`, and picking/removing mutates the SAME target object by reference
 * (the behaviour every call site depends on).
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { BrainApi } from '../../core/brain-api.service';
import type { Entity } from '../../core/api.types';
import { EntityRefPicker } from './entity-ref-picker.service';
import { BrainStore } from './brain-store.service';
import { EntityRefFieldComponent } from './entity-ref-field.component';
import { isOnPush } from '../../testing/onpush';

function make(target: { linkEntities: string }) {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [EntityRefFieldComponent, getTranslocoModule()],
    providers: [
      EntityRefPicker, BrainStore,
      { provide: BrainApi, useValue: { recallBrain: vi.fn(() => of({ results: [], count: 0 })), searchEntitiesByName: vi.fn(() => of({ entities: [] })), getEntitiesByIds: vi.fn(() => of({ entities: [] })) } },
    ],
  });
  const fixture = TestBed.createComponent(EntityRefFieldComponent);
  fixture.componentRef.setInput('target', target);
  fixture.componentRef.setInput('spaceId', 'work');
  fixture.detectChanges();
  return fixture;
}

describe('EntityRefFieldComponent', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('is compiled as OnPush', () => {
    expect(isOnPush(EntityRefFieldComponent)).toBe(true);
  });

  it('always hosts the inline entity picker', () => {
    const f = make({ linkEntities: '' });
    expect(f.nativeElement.querySelector('app-entity-search')).toBeTruthy();
  });

  it('renders a chip per linked id, using the picker name cache for the label', () => {
    const f = make({ linkEntities: 'e1, e2' });
    const picker = TestBed.inject(EntityRefPicker);
    picker.entityNameCache.set({ e1: 'Ada' });
    f.detectChanges();
    const chips = [...f.nativeElement.querySelectorAll('.chip .chip-name')].map(n => n.textContent?.trim());
    expect(chips).toEqual(['Ada', 'e2']); // uncached id falls back to the id itself
  });

  it('picking appends to the bound target by reference', () => {
    const target = { linkEntities: '' };
    make(target);
    TestBed.inject(EntityRefPicker).pickEntity({ _id: 'e9', name: 'Grace' } as Entity, target);
    expect(target.linkEntities).toBe('e9');
  });

  it('removing a chip mutates the bound target by reference', () => {
    const target = { linkEntities: 'e1, e2' };
    make(target);
    TestBed.inject(EntityRefPicker).removeEntityId(target, 'e1');
    expect(target.linkEntities).toBe('e2');
  });
});
