/**
 * The per-type schema edits, tested directly now that they are pure.
 *
 * These operations used to live on `SpaceSettingsState` and reach into its own map, so the only way to
 * exercise them was through the service — which meant the settings page's `TestBed` had to be stood up to
 * assert that a duplicate property key is refused. They are plain functions over a state object now, and
 * this file is what that buys.
 *
 * `space-schema-tab.component.spec.ts` still covers the service's own behaviour end to end. That is the
 * characterization net proving this extraction changed nothing; this file pins the rules themselves.
 */
import { describe, it, expect } from 'vitest';
import { emptyTypeSchemaState, typeSchemaFromState, type TypeSchemaState } from './space-settings-state.service';
import {
  addProp, removeProp, addEnumVal, removeEnumVal, canAddProp,
  toggleEndpoint, endpointsFor, isAnyEnd, endpointPairs, endNamesFor, isStaleEndName, UNTYPED_END,
} from './type-schema-edits';

const state = (over: Partial<TypeSchemaState> = {}): TypeSchemaState => emptyTypeSchemaState(over);
const prop = (key: string, s = {}) => ({ key, s, _enumInput: '' });

describe('an edge label\'s permitted ends', () => {
  /*
   * `G-12`. Two fields both API doors have accepted since S-1, both reported by the space validator, and
   * both carried safely through a save — with no way for an operator to set either. These pin the rules the
   * control has to obey, and every one of them is a rule the API will otherwise enforce with a 400.
   */

  it('a side starts as ANY type, which is not the same as an empty list', () => {
    /*
     * The distinction the whole control rests on. `endpoints.from` absent means any entity type may be the
     * source; `endpoints.from: []` is refused by the API (`min(1)`) and, if it were not, would forbid every
     * edge of the label. An operator clearing the last checkbox must land on the first, never the second.
     */
    const s = state();
    expect(endpointsFor(s, 'from')).toEqual([]);
    expect(isAnyEnd(s, 'from')).toBe(true);
  });

  it('toggling a type name on and off returns the side to ANY rather than to empty', () => {
    const s = state();
    toggleEndpoint(s, 'from', 'person');
    expect(endpointsFor(s, 'from')).toEqual(['person']);
    expect(isAnyEnd(s, 'from')).toBe(false);

    toggleEndpoint(s, 'from', 'person');
    expect(isAnyEnd(s, 'from')).toBe(true);
    // And the object itself is gone, not left as `{ from: [] }` for the serialiser to trip over.
    expect(s.endpoints).toBeUndefined();
  });

  it('the two sides are independent — restricting one leaves the other ANY', () => {
    const s = state();
    toggleEndpoint(s, 'to', 'document');
    expect(endpointsFor(s, 'to')).toEqual(['document']);
    expect(isAnyEnd(s, 'from')).toBe(true);
    expect(s.endpoints).toEqual({ to: ['document'] });
  });

  it('UNTYPED is a choice like any other name, and means an entity with no type', () => {
    /*
     * Not "unset". An entity may genuinely have no type, and permitting that is a decision an operator can
     * make — which is why it is a row in the list rather than the absence of one.
     */
    const s = state();
    toggleEndpoint(s, 'from', 'UNTYPED');
    toggleEndpoint(s, 'from', 'person');
    expect(endpointsFor(s, 'from')).toEqual(['UNTYPED', 'person']);
  });

  it('the permitted pairs are the CROSS PRODUCT, and the preview says so', () => {
    /*
     * The owner's ruling, 2026-08-31, and the one thing this control must not get wrong: two lists mean every
     * combination, not pairing by position. Two side-by-side lists imply pairs to most people, so the preview
     * is what makes the control honest — 2 x 3 is six permitted pairs, not two.
     */
    const s = state();
    for (const n of ['person', 'team']) toggleEndpoint(s, 'from', n);
    for (const n of ['document', 'note', 'UNTYPED']) toggleEndpoint(s, 'to', n);

    const pairs = endpointPairs(s);
    expect(pairs.length).toBe(6);
    expect(pairs).toContain('person \u2192 document');
    expect(pairs).toContain('team \u2192 UNTYPED');
    // Pairing by position would produce these two and nothing else.
    expect(pairs.length).not.toBe(2);
  });

  it('a preview with one side ANY names the other side and says any for the first', () => {
    const s = state();
    toggleEndpoint(s, 'to', 'document');
    expect(endpointPairs(s)).toEqual(['* \u2192 document']);
  });

  it('and with both sides ANY there is nothing to preview', () => {
    expect(endpointPairs(state())).toEqual([]);
  });
});

describe('what the serialiser sends for an edge', () => {
  it('omits endpoints entirely when both sides are ANY', () => {
    // `endpoints: {}` is refused by the API with "an empty object constrains nothing", so a type nobody
    // restricted must not carry the key at all.
    const ts = typeSchemaFromState('edge', state());
    expect(ts.endpoints).toBeUndefined();
  });

  it('sends only the side that is restricted', () => {
    const s = state();
    toggleEndpoint(s, 'from', 'person');
    expect(typeSchemaFromState('edge', s).endpoints).toEqual({ from: ['person'] });
  });

  it('never sends an empty array, whatever the state holds', () => {
    /*
     * Belt to the toggle's braces, and deliberately so: the API caps a side at `min(1)`, and a state carrying
     * `{ from: [] }` from an older save or a hand-edited draft would 400 the whole space PATCH — one type's
     * empty list taking every other type's edits with it.
     */
    const s = state({ endpoints: { from: [], to: ['document'] } });
    expect(typeSchemaFromState('edge', s).endpoints).toEqual({ to: ['document'] });

    const both = state({ endpoints: { from: [], to: [] } });
    expect(typeSchemaFromState('edge', both).endpoints).toBeUndefined();
  });

  it('drops a blank member, which the API accepts and nothing can match', () => {
    /*
     * The API caps a member at `z.string().min(1)`, and a single space satisfies that — so `"  "` is a
     * storable endpoint name that no entity type can ever equal. The picker cannot produce one; a hand-written
     * PATCH can, and then every edge of the label is a violation against a rule nobody can read.
     *
     * Written because a mutant that removed the trim SURVIVED: the case above used an empty array, which the
     * length test already caught, so the trim itself was unasserted.
     */
    const s = state({ endpoints: { from: ['  ', 'person'], to: [' '] } });
    expect(typeSchemaFromState('edge', s).endpoints).toEqual({ from: ['person'] });

    const allBlank = state({ endpoints: { from: ['   '] } });
    expect(typeSchemaFromState('edge', allBlank).endpoints).toBeUndefined();
  });

  it('sends functional only when it is set', () => {
    expect(typeSchemaFromState('edge', state()).functional).toBeUndefined();
    expect(typeSchemaFromState('edge', state({ functional: true })).functional).toBe(true);
    // False is a STATEMENT here, unlike suppressEmbeddings: the field has no third state, and an operator
    // who unticks it is saying this label is not functional.
    expect(typeSchemaFromState('edge', state({ functional: false })).functional).toBe(false);
  });

  it('drops both on a type that is not an edge, because the API refuses them there', () => {
    const s = state({ endpoints: { from: ['person'] }, functional: true });
    const ts = typeSchemaFromState('entity', s);
    expect(ts.endpoints).toBeUndefined();
    expect(ts.functional).toBeUndefined();
  });
});

describe('adding a property', () => {
  it('adds the pending key and returns it', () => {
    const s = state({ _newPropInput: 'tier' });
    expect(addProp(s)).toBe('tier');
    expect(s.propertySchemas.map(p => p.key)).toEqual(['tier']);
  });

  it('clears the input even when the key is refused', () => {
    // A rejected duplicate left sitting in the box reads as "the button did nothing", which is the bug
    // report we would get instead of the duplicate we prevented.
    const s = state({ _newPropInput: 'tier', propertySchemas: [prop('tier')] });
    expect(addProp(s)).toBeNull();
    expect(s._newPropInput).toBe('');
    expect(s.propertySchemas).toHaveLength(1);
  });

  it('refuses blank and whitespace-only keys', () => {
    for (const input of ['', '   ', '\t']) {
      const s = state({ _newPropInput: input });
      expect(addProp(s)).toBeNull();
      expect(s.propertySchemas).toHaveLength(0);
    }
  });

  it('trims the key it stores', () => {
    const s = state({ _newPropInput: '  tier  ' });
    expect(addProp(s)).toBe('tier');
    expect(s.propertySchemas[0]!.key).toBe('tier');
  });

  it('canAddProp answers without mutating, so a template can disable the button', () => {
    const s = state({ _newPropInput: 'tier', propertySchemas: [prop('tier')] });
    expect(canAddProp(s)).toBeNull();
    expect(s._newPropInput).toBe('tier');
  });

  it('returning the key is what lets a caller expand the new row', () => {
    // The settings tab expands the row it just created. It cannot do that for a key that was never added,
    // which is why this returns the key rather than a boolean.
    const s = state({ _newPropInput: 'repo' });
    const key = addProp(s);
    expect(key).not.toBeNull();
    expect(s.propertySchemas.some(p => p.key === key)).toBe(true);
  });
});

describe('removing a property', () => {
  it('removes only the named key', () => {
    const s = state({ propertySchemas: [prop('a'), prop('b')] });
    removeProp(s, 'a');
    expect(s.propertySchemas.map(p => p.key)).toEqual(['b']);
  });

  it('removing a key that is not there is a no-op, not a throw', () => {
    const s = state({ propertySchemas: [prop('a')] });
    expect(() => removeProp(s, 'nope')).not.toThrow();
    expect(s.propertySchemas).toHaveLength(1);
  });
});

describe('enum values', () => {
  it('adds the pending value and clears the input', () => {
    const s = state({ propertySchemas: [{ key: 'tier', s: {}, _enumInput: 'gold' }] });
    addEnumVal(s, 'tier');
    expect(s.propertySchemas[0]!.s.enum).toEqual(['gold']);
    expect(s.propertySchemas[0]!._enumInput).toBe('');
  });

  it('a typed "4" does not duplicate a stored 4', () => {
    // The input is text and the stored value may be a number. Comparing strictly would grow a list with two
    // entries that LOOK identical and that no record could satisfy twice.
    const s = state({ propertySchemas: [{ key: 'n', s: { enum: [4] }, _enumInput: '4' }] });
    addEnumVal(s, 'n');
    expect(s.propertySchemas[0]!.s.enum).toEqual([4]);
  });

  it('ignores a blank value rather than storing an empty option', () => {
    const s = state({ propertySchemas: [{ key: 'tier', s: {}, _enumInput: '   ' }] });
    addEnumVal(s, 'tier');
    expect(s.propertySchemas[0]!.s.enum).toBeUndefined();
  });

  it('does nothing for a property that does not exist', () => {
    const s = state({ propertySchemas: [prop('a')] });
    expect(() => addEnumVal(s, 'nope')).not.toThrow();
  });

  it('removes a value, leaving the rest', () => {
    const s = state({ propertySchemas: [{ key: 'tier', s: { enum: ['gold', 'silver'] }, _enumInput: '' }] });
    removeEnumVal(s, 'tier', 'gold');
    expect(s.propertySchemas[0]!.s.enum).toEqual(['silver']);
  });

  it('replaces the schema object rather than mutating it in place', () => {
    // The entry's `s` is handed to a template. Replacing it is what makes the change visible; mutating the
    // same object would leave an OnPush view showing the old list.
    const original = { enum: ['gold', 'silver'] };
    const s = state({ propertySchemas: [{ key: 'tier', s: original, _enumInput: '' }] });
    removeEnumVal(s, 'tier', 'gold');
    expect(s.propertySchemas[0]!.s).not.toBe(original);
    expect(original.enum).toEqual(['gold', 'silver']);
  });
});

/**
 * B-16 — a declared edge end must stay REMOVABLE after its entity type is deleted. Owner-reported
 * 2026-09-17: the picker listed the types the space currently declares, so a stored name that was no
 * longer one of them had no checkbox at all. Nothing to untick, still enforced, invisible.
 */
describe('endNamesFor — the picker offers what is declared AND what is picked', () => {
  const withEnds = (from: string[], to: string[] = []) =>
    ({ endpoints: { from, to }, propertySchemas: [] }) as never;

  it('offers a picked name the space no longer declares', () => {
    const names = endNamesFor(['org'], withEnds(['person']));
    expect(names).toContain('person');
    expect(names).toContain('org');
  });

  it('offers each name ONCE when it is both declared and picked', () => {
    const names = endNamesFor(['person', 'org'], withEnds(['person']));
    expect(names.filter(n => n === 'person')).toHaveLength(1);
  });

  it('keeps UNTYPED last, and does not duplicate it when it is picked', () => {
    const names = endNamesFor(['org'], withEnds([UNTYPED_END, 'person']));
    expect(names[names.length - 1]).toBe(UNTYPED_END);
    expect(names.filter(n => n === UNTYPED_END)).toHaveLength(1);
  });

  it('covers BOTH sides — a stale name on `to` alone is still offered', () => {
    expect(endNamesFor(['org'], withEnds([], ['ghost']))).toContain('ghost');
  });

  it('is the declared vocabulary when nothing is picked', () => {
    expect(endNamesFor(['b', 'a'], { propertySchemas: [] } as never)).toEqual(['a', 'b', UNTYPED_END]);
  });
});

describe('isStaleEndName — an offered name the space no longer declares', () => {
  it('is true for a picked name that was deleted', () => {
    expect(isStaleEndName(['org'], 'person')).toBe(true);
  });

  it('is false for a declared name', () => {
    expect(isStaleEndName(['person'], 'person')).toBe(false);
  });

  it('is false for UNTYPED, which is never a declared type', () => {
    // It is a real choice rather than a stray, so marking it as deleted would be a lie.
    expect(isStaleEndName([], UNTYPED_END)).toBe(false);
  });
});
