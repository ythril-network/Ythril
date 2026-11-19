/**
 * Renaming a property of a type, as a pure edit over one `TypeSchemaState` (Q-747, bundle-285).
 *
 * Until now the editor could add a property and remove one and nothing between, so a rename was a removal plus an addition and the
 * records' values under the old key were left behind. The later Save dialog builds its conversion steps from what was renamed, so
 * the edit has to say what it renamed, in the stored name. Three rules are the point of this file:
 *
 *  - a rename keeps the property's definition and its place in the list (re-keying must not reorder rows under the operator's cursor);
 *  - a name another property already holds, or no name at all, is refused and changes nothing: never a silent merge of two
 *    definitions into one key;
 *  - the edit remembers the STORED name (`_was`) of a property that existed when the schema was opened or last saved, and of nothing
 *    else: rename twice and it is still the stored name, rename back and it is gone, rename a property that was only just added and
 *    there is nothing stored to convert from.
 *
 * `_stored` and `_was` are the editor's own bookkeeping (like `_enumInput`): they never reach the wire.
 */
import { describe, it, expect } from 'vitest';
import { emptyTypeSchemaState, typeSchemaFromState, type TypeSchemaState } from './space-settings-state.service';
import { addProp, markStored, renameProp, trackRename } from './type-schema-edits';

const prop = (key: string, s: object = {}, extra: object = {}) => ({ key, s, _enumInput: '', ...extra });
/** A type as it is right after the space was opened: every property is a stored one. */
const opened = (...keys: string[]): TypeSchemaState => {
  const state = emptyTypeSchemaState({ propertySchemas: keys.map(k => prop(k, { type: 'string', description: `the ${k}` })) });
  markStored(state);
  return state;
};
const keys = (state: TypeSchemaState): string[] => state.propertySchemas.map(p => p.key);

describe('renameProp: what a rename keeps', () => {
  it('keeps the definition of the property and its place in the list', () => {
    const state = emptyTypeSchemaState({ propertySchemas: [prop('a'), prop('b', { type: 'number', minimum: 3, enum: [3, 4] }), prop('c')] });
    const definition = state.propertySchemas[1]!.s;
    expect(renameProp(state, 'b', 'x')).toBe(null);
    expect(keys(state)).toEqual(['a', 'x', 'c']);
    expect(state.propertySchemas[1]!.s).toBe(definition);
    expect(state.propertySchemas[1]!.s).toEqual({ type: 'number', minimum: 3, enum: [3, 4] });
  });

  it('keeps the half-typed enum value of the row', () => {
    const state = emptyTypeSchemaState({ propertySchemas: [{ key: 'a', s: {}, _enumInput: 'half' }] });
    expect(renameProp(state, 'a', 'b')).toBe(null);
    expect(state.propertySchemas[0]!._enumInput).toBe('half');
  });

  it('trims the new name', () => {
    const state = emptyTypeSchemaState({ propertySchemas: [prop('a')] });
    expect(renameProp(state, 'a', '  employer  ')).toBe(null);
    expect(keys(state)).toEqual(['employer']);
  });

  it('writes the new key to the wire, in the same place, with no bookkeeping field', () => {
    const state = opened('a', 'b', 'c');
    renameProp(state, 'b', 'x');
    const wire = typeSchemaFromState('entity', state);
    expect(Object.keys(wire.propertySchemas ?? {})).toEqual(['a', 'x', 'c']);
    expect(JSON.stringify(wire)).not.toMatch(/_was|_stored/);
  });
});

describe('renameProp: what it refuses, and that a refusal changes nothing', () => {
  it('refuses an empty name', () => {
    const state = opened('a', 'b');
    expect(renameProp(state, 'a', '')).toBe('empty');
    expect(renameProp(state, 'a', '   ')).toBe('empty');
    expect(keys(state)).toEqual(['a', 'b']);
    expect(state.propertySchemas[0]!._was).toBeUndefined();
  });

  it('refuses a name another property of the type holds, and does not merge the two', () => {
    const state = opened('a', 'b');
    const before = state.propertySchemas.map(p => ({ ...p }));
    expect(renameProp(state, 'a', 'b')).toBe('exists');
    expect(renameProp(state, 'a', ' b ')).toBe('exists');
    expect(state.propertySchemas).toEqual(before);
  });

  it('refuses a property that is not there', () => {
    const state = opened('a');
    expect(renameProp(state, 'ghost', 'x')).toBe('missing');
    expect(keys(state)).toEqual(['a']);
  });

  it('takes the same name as a no-op, not as a clash with itself', () => {
    const state = opened('a', 'b');
    expect(renameProp(state, 'a', 'a')).toBe(null);
    expect(renameProp(state, 'a', ' a ')).toBe(null);
    expect(keys(state)).toEqual(['a', 'b']);
    expect(state.propertySchemas[0]!._was).toBeUndefined();
  });

  it('lets a name be taken that another property gave up in the same sitting', () => {
    const state = opened('a', 'b');
    expect(renameProp(state, 'b', 'c')).toBe(null);
    expect(renameProp(state, 'a', 'b')).toBe(null);
    expect(keys(state)).toEqual(['b', 'c']);
    expect(state.propertySchemas.map(p => p._was)).toEqual(['a', 'b']);
  });
});

describe('renameProp: the stored name it remembers', () => {
  it('a stored property remembers the name it was stored under', () => {
    const state = opened('company');
    renameProp(state, 'company', 'employer');
    expect(state.propertySchemas[0]!._was).toBe('company');
  });

  it('two renames in a row still say the stored name, never the one in between', () => {
    const state = opened('a');
    renameProp(state, 'a', 'b');
    renameProp(state, 'b', 'c');
    expect(keys(state)).toEqual(['c']);
    expect(state.propertySchemas[0]!._was).toBe('a');
  });

  it('renaming back to the stored name forgets the rename', () => {
    const state = opened('a');
    renameProp(state, 'a', 'b');
    renameProp(state, 'b', 'a');
    expect(state.propertySchemas[0]!._was).toBeUndefined();
    expect('_was' in state.propertySchemas[0]!).toBe(false);
  });

  it('renaming back by way of a third name forgets it too', () => {
    const state = opened('a');
    renameProp(state, 'a', 'b');
    renameProp(state, 'b', 'c');
    renameProp(state, 'c', 'a');
    expect('_was' in state.propertySchemas[0]!).toBe(false);
  });

  it('a property added in this sitting has no stored name, so renaming it records nothing', () => {
    const state = opened('a');
    state._newPropInput = 'nickname';
    addProp(state);
    expect(renameProp(state, 'nickname', 'alias')).toBe(null);
    expect(keys(state)).toEqual(['a', 'alias']);
    expect('_was' in state.propertySchemas[1]!).toBe(false);
  });

  it('a stored property that was removed and added again is a new property, not the stored one', () => {
    const state = opened('a');
    state.propertySchemas = [];
    state._newPropInput = 'a';
    addProp(state);
    renameProp(state, 'a', 'z');
    expect('_was' in state.propertySchemas[0]!).toBe(false);
  });

  it('markStored makes what is there the stored schema and forgets the renames', () => {
    const state = opened('a');
    renameProp(state, 'a', 'b');
    markStored(state);
    expect(state.propertySchemas[0]!._stored).toBe(true);
    expect('_was' in state.propertySchemas[0]!).toBe(false);
    renameProp(state, 'b', 'c');
    expect(state.propertySchemas[0]!._was).toBe('b');
  });
});

describe('trackRename: the one rule properties and types share', () => {
  it('records the stored name of a stored thing, the earliest one on a chain, and nothing for a thing that was never stored', () => {
    const stored: { _stored?: boolean; _was?: string } = { _stored: true };
    trackRename(stored, 'a', 'b');
    expect(stored._was).toBe('a');
    trackRename(stored, 'b', 'c');
    expect(stored._was).toBe('a');
    trackRename(stored, 'c', 'a');
    expect('_was' in stored).toBe(false);

    const added: { _stored?: boolean; _was?: string } = {};
    trackRename(added, 'x', 'y');
    expect('_was' in added).toBe(false);
  });
});
