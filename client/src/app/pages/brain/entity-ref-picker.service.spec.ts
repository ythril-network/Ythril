/**
 * EntityRefPicker — CHARACTERIZATION tests for the shared entity/memory/chrono reference picker.
 *
 * These began (A17.9b-2) as `brain.component.entity-picker.spec.ts`, written and proven green against
 * the unmodified component BEFORE the picker was extracted — pinning the string-keyed god-switch
 * (`pickEntity(ent, mode, field)` / `resolveEntityNamesForFlyout(key)` reaching into every form). The
 * extraction (A17.9b-3) replaced that switch with a target-based API on this service, so the same
 * behaviour is re-pinned here through the new surface:
 *
 *   - `pickEntity(ent, target)` appends the id to whatever form ref it is given and caches the name —
 *     the ten hard-coded branches collapse to one, and these tests prove the collapse is faithful by
 *     driving several distinct targets
 *   - `appendEntityId` de-dups and re-joins with ', '; `removeEntityId` drops one id and re-joins
 *   - `entityChips` resolves names from the cache, falls back to the raw id, trims and drops blanks
 *   - `resolveEntityNames` / `resolveEntityNamesFor` hit the API only for uncached ids
 *
 * The edge from/to endpoints did NOT move here — they set display fields on the shell's `edgeForm`
 * without touching the name cache, so that characterization now lives in brain.component.spec.ts.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { of } from 'rxjs';
import { type Entity } from '../../core/api.types';
import { BrainApi } from '../../core/brain-api.service';
import { BrainStore } from './brain-store.service';
import { EntityRefPicker } from './entity-ref-picker.service';

function entity(id: string, name = id): Entity {
  return { _id: id, name, tags: [], properties: {}, createdAt: '' } as unknown as Entity;
}

describe('EntityRefPicker (characterization)', () => {
  const getEntitiesByIds = vi.fn((_spaceId: string, _ids: string[]) => of({ entities: [] as Entity[] }));

  function create(): EntityRefPicker {
    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        EntityRefPicker,
        BrainStore,
        { provide: BrainApi, useValue: { getEntitiesByIds } },
      ],
    });
    const picker = TestBed.inject(EntityRefPicker);
    picker.spaceId.set('work');
    return picker;
  }

  beforeEach(() => {
    getEntitiesByIds.mockReset();
    getEntitiesByIds.mockImplementation(() => of({ entities: [] as Entity[] }));
  });

  // ── pickEntity: one target-based method replaces the ten-branch switch ─────

  it('pickEntity appends the id to the given target and caches the name', () => {
    const picker = create();
    const target = { linkEntities: '' };
    picker.pickEntity(entity('e1', 'Alice'), target);
    expect(target.linkEntities).toBe('e1');
    expect(picker.entityNameCache()['e1']).toBe('Alice');
  });

  it('pickEntity writes to whichever distinct target it is handed (no cross-talk)', () => {
    const picker = create();
    const memoryForm = { linkEntities: '' };
    const drawerEditChrono = { linkEntities: '' };
    picker.pickEntity(entity('e1', 'Alice'), memoryForm);
    picker.pickEntity(entity('e2', 'Bob'), drawerEditChrono);
    expect(memoryForm.linkEntities).toBe('e1');
    expect(drawerEditChrono.linkEntities).toBe('e2');
  });

  it('appendEntityId (via pickEntity) joins with ", " and de-duplicates', () => {
    const picker = create();
    const target = { linkEntities: 'x' };
    picker.pickEntity(entity('y'), target);
    expect(target.linkEntities).toBe('x, y');
    picker.pickEntity(entity('y'), target); // already present
    expect(target.linkEntities).toBe('x, y');
  });

  // ── removeEntityId / entityChips ───────────────────────────────────────────

  it('removeEntityId drops the id and re-joins the remaining with ", "', () => {
    const picker = create();
    const target = { linkEntities: 'a, b, c' };
    picker.removeEntityId(target, 'b');
    expect(target.linkEntities).toBe('a, c');
  });

  it('entityChips resolves names from the cache, falls back to the id, trims and drops blanks', () => {
    const picker = create();
    picker.entityNameCache.set({ e1: 'Alice' });
    expect(picker.entityChips('e1, , e2 ,')).toEqual([
      { id: 'e1', name: 'Alice' },
      { id: 'e2', name: 'e2' },
    ]);
  });

  // ── resolveEntityNamesFor (a form's comma-separated linkEntities, used on edit-open) ───────────

  it("resolveEntityNamesFor resolves a CSV field's UNCACHED ids and patches the cache", () => {
    const picker = create();
    picker.entityNameCache.set({ e1: 'Alice' }); // e1 known → only e2 requested
    getEntitiesByIds.mockReturnValue(of({ entities: [entity('e2', 'Bob')] }));

    picker.resolveEntityNamesFor('e1, e2');

    expect(getEntitiesByIds).toHaveBeenCalledTimes(1);
    expect(getEntitiesByIds).toHaveBeenCalledWith('work', ['e2']);
    expect(picker.entityNameCache()['e2']).toBe('Bob');
    expect(picker.entityNameCache()['e1']).toBe('Alice'); // preserved
  });

  it('resolveEntityNamesFor does not call the API when every id is already cached', () => {
    const picker = create();
    picker.entityNameCache.set({ e1: 'Alice' });
    picker.resolveEntityNamesFor('e1');
    expect(getEntitiesByIds).not.toHaveBeenCalled();
  });

  // ── resolveEntityNames (bulk, used when opening a record for edit) ──────────

  it('resolveEntityNames requests only uncached ids and merges the returned names', () => {
    const picker = create();
    picker.entityNameCache.set({ e1: 'Alice' });
    getEntitiesByIds.mockReturnValue(of({ entities: [entity('e2', 'Bob'), entity('e3', 'Cara')] }));

    picker.resolveEntityNames(['e1', 'e2', 'e3']);

    expect(getEntitiesByIds).toHaveBeenCalledWith('work', ['e2', 'e3']);
    expect(picker.entityNameCache()).toEqual({ e1: 'Alice', e2: 'Bob', e3: 'Cara' });
  });

  it('resolveEntityNames is a no-op with no space id', () => {
    const picker = create();
    picker.spaceId.set('');
    picker.resolveEntityNames(['e1']);
    expect(getEntitiesByIds).not.toHaveBeenCalled();
  });
});
