/**
 * The rename ledger of the Schema tab (Q-747, bundle-285).
 *
 * The Save dialog proposes its conversion steps from what the operator renamed. A rename that is not recorded looks like a removal plus
 * an addition, and the records' values under the old name would be lost; a rename recorded wrongly proposes a step the server refuses
 * or, worse, one that moves values the schema does not mean to move. So the ledger answers one question: "what does the STORED schema
 * need to become the staged one, as far as names go?" It speaks in STORED names (the name when the space was opened or last saved),
 * not in whatever name a thing had between two edits.
 *
 * The ledger is derived from the staged definitions (each stored type and property remembers the name it was stored under), so no
 * host has to remember to tell it anything and no entry can outlive the thing it names.
 */
import { TestBed } from '@angular/core/testing';
import { describe, it, expect } from 'vitest';
import { of } from 'rxjs';
import { SpacesApi } from '../../core/spaces-api.service';
import type { Space } from '../../core/api.types';
import { getTranslocoModule } from '../../testing/transloco-testing';
import { SpaceSettingsState, emptyTypeSchemaState } from './space-settings-state.service';

const STATS = { spaceId: 'work', facts: 1, entities: 2, edges: 3, chrono: 4, files: 5 };

function make() {
  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    imports: [getTranslocoModule()],
    providers: [SpaceSettingsState, { provide: SpacesApi, useValue: { getSpaceStats: () => of(STATS) } }],
  });
  return TestBed.inject(SpaceSettingsState);
}

const stored = {
  id: 'work', label: 'Work',
  meta: {
    typeSchemas: {
      entity: {
        person: { propertySchemas: { company: { type: 'string' }, email: { type: 'string' }, age: { type: 'number' } } },
        client: { propertySchemas: { name: { type: 'string' } } },
      },
      fact: { note: { propertySchemas: { text: { type: 'string' } } } },
    },
  },
} as unknown as Space;

function opened() {
  const s = make();
  s.openSettings(stored);
  return s;
}

const NOTHING = { types: [], props: [] };

describe('the ledger starts empty and speaks in stored names', () => {
  it('is empty when the space was just opened', () => {
    expect(opened().renameLedger()).toEqual(NOTHING);
  });

  it('records a property rename with the type, the stored name and the new name', () => {
    const s = opened();
    expect(s.renameProp('entity', 'person', 'company', 'employer')).toBe(null);
    expect(s.renameLedger()).toEqual({
      types: [],
      props: [{ kind: 'entity', type: 'person', wasType: 'person', from: 'company', to: 'employer' }],
    });
  });

  it('records a type rename with the kind, the stored name and the new name', () => {
    const s = opened();
    expect(s.renameType('entity', 'client', 'customer')).toBe(null);
    expect(s.renameLedger()).toEqual({ types: [{ kind: 'entity', from: 'client', to: 'customer' }], props: [] });
    expect(s.typeWas('entity', 'customer')).toBe('client');
    expect(s.typeWas('entity', 'person')).toBe(null);
  });

  it('lists every rename of every kind, kinds in their order and types and properties in the order they stand', () => {
    const s = opened();
    s.renameProp('fact', 'note', 'text', 'body');
    s.renameProp('entity', 'person', 'email', 'mail');
    s.renameProp('entity', 'person', 'company', 'employer');
    s.renameType('entity', 'client', 'customer');
    const ledger = s.renameLedger();
    expect(ledger.types.map(t => `${t.kind}:${t.from}>${t.to}`)).toEqual(['entity:client>customer']);
    expect(ledger.props.map(p => `${p.kind}:${p.type}:${p.from}>${p.to}`)).toEqual([
      'entity:person:company>employer', 'entity:person:email>mail', 'fact:note:text>body',
    ]);
  });
});

describe('a chain of renames is one rename', () => {
  it('a to b to c says a to c, for a property', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'firm');
    s.renameProp('entity', 'person', 'firm', 'employer');
    expect(s.renameLedger().props).toEqual([{ kind: 'entity', type: 'person', wasType: 'person', from: 'company', to: 'employer' }]);
  });

  it('a to b to c says a to c, for a type', () => {
    const s = opened();
    s.renameType('entity', 'client', 'buyer');
    s.renameType('entity', 'buyer', 'customer');
    expect(s.renameLedger().types).toEqual([{ kind: 'entity', from: 'client', to: 'customer' }]);
  });

  it('renaming back removes the rename, for a property and for a type', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.renameProp('entity', 'person', 'employer', 'company');
    s.renameType('entity', 'client', 'customer');
    s.renameType('entity', 'customer', 'client');
    expect(s.renameLedger()).toEqual(NOTHING);
    expect(s.typeWas('entity', 'client')).toBe(null);
  });

  it('the rename back leaves the schema as clean as it was opened', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    expect(s.isDirty()).toBe(true);
    s.renameProp('entity', 'person', 'employer', 'company');
    expect(s.isDirty()).toBe(false);
  });
});

describe('a rename that something else undoes leaves nothing to convert', () => {
  it('rename then remove: the property is gone, there is no rename to propose', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.removeProp('entity', 'person', 'employer');
    expect(s.renameLedger()).toEqual(NOTHING);
  });

  it('add then rename: a property that was never stored has no stored name', () => {
    const s = opened();
    s.typeState('entity', 'person')._newPropInput = 'nickname';
    s.addProp('entity', 'person');
    expect(s.renameProp('entity', 'person', 'nickname', 'alias')).toBe(null);
    expect(s.renameLedger()).toEqual(NOTHING);
  });

  it('a type added in this sitting and renamed has no stored name either', () => {
    const s = opened();
    s.schNewTypeInputs = { ...s.schNewTypeInputs, entity: 'draft' };
    s.addType('entity');
    s.renameType('entity', 'draft', 'final');
    expect(s.renameLedger()).toEqual(NOTHING);
    expect(s.typeWas('entity', 'final')).toBe(null);
  });

  it('a removed type takes its rename and its property renames with it', () => {
    const s = opened();
    s.renameProp('entity', 'client', 'name', 'title');
    s.renameType('entity', 'client', 'customer');
    s.removeType('entity', 'customer');
    expect(s.renameLedger()).toEqual(NOTHING);
  });

  it('a stored type that was removed and added again is a new type', () => {
    const s = opened();
    s.removeType('entity', 'client');
    s.schNewTypeInputs = { ...s.schNewTypeInputs, entity: 'client' };
    s.addType('entity');
    s.renameType('entity', 'client', 'customer');
    expect(s.renameLedger()).toEqual(NOTHING);
  });
});

describe('a renamed type keeps its property renames, whichever was renamed first', () => {
  it('property first, then the type', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.renameType('entity', 'person', 'human');
    expect(s.renameLedger()).toEqual({
      types: [{ kind: 'entity', from: 'person', to: 'human' }],
      props: [{ kind: 'entity', type: 'human', wasType: 'person', from: 'company', to: 'employer' }],
    });
  });

  it('type first, then the property', () => {
    const s = opened();
    s.renameType('entity', 'person', 'human');
    s.renameProp('entity', 'human', 'company', 'employer');
    expect(s.renameLedger().props).toEqual([{ kind: 'entity', type: 'human', wasType: 'person', from: 'company', to: 'employer' }]);
  });

  it('renaming the type back leaves the property renames under the stored type name', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.renameType('entity', 'person', 'human');
    s.renameType('entity', 'human', 'person');
    expect(s.renameLedger()).toEqual({
      types: [],
      props: [{ kind: 'entity', type: 'person', wasType: 'person', from: 'company', to: 'employer' }],
    });
  });

  it('the stored name of a property is the same whichever type name it sits under', () => {
    const s = opened();
    s.renameType('entity', 'person', 'human');
    s.renameType('entity', 'human', 'member');
    s.renameProp('entity', 'member', 'email', 'mail');
    s.renameProp('entity', 'member', 'mail', 'address');
    expect(s.renameLedger().props).toEqual([{ kind: 'entity', type: 'member', wasType: 'person', from: 'email', to: 'address' }]);
  });
});

describe('a refused rename records nothing', () => {
  it('a property name the type already holds is refused, and the ledger and the schema stay as they were', () => {
    const s = opened();
    expect(s.renameProp('entity', 'person', 'company', 'email')).toBe('exists');
    expect(s.typeState('entity', 'person').propertySchemas.map(p => p.key)).toEqual(['company', 'email', 'age']);
    expect(s.renameLedger()).toEqual(NOTHING);
    expect(s.isDirty()).toBe(false);
  });

  it('a type name another type holds is refused', () => {
    const s = opened();
    expect(s.renameType('entity', 'client', 'person')).toBe('exists');
    expect(s.renameLedger()).toEqual(NOTHING);
  });

  it('empty and missing are refused', () => {
    const s = opened();
    expect(s.renameProp('entity', 'person', 'company', ' ')).toBe('empty');
    expect(s.renameProp('entity', 'person', 'ghost', 'x')).toBe('missing');
    expect(s.renameProp('entity', 'nobody', 'company', 'x')).toBe('missing');
    expect(s.renameLedger()).toEqual(NOTHING);
  });
});

describe('the ledger lives as long as the schema it was recorded against', () => {
  it('opening a space clears it', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.renameType('entity', 'client', 'customer');
    s.openSettings(stored);
    expect(s.renameLedger()).toEqual(NOTHING);
  });

  it('a save (markPristine) clears it, and the next rename names the name that was just saved', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.renameType('entity', 'client', 'customer');
    s.markPristine();
    expect(s.renameLedger()).toEqual(NOTHING);
    expect(s.typeWas('entity', 'customer')).toBe(null);
    s.renameProp('entity', 'person', 'employer', 'firm');
    expect(s.renameLedger().props).toEqual([{ kind: 'entity', type: 'person', wasType: 'person', from: 'employer', to: 'firm' }]);
  });

  it('is derived from the definitions, so a state the editor replaced (an import) answers for what is there', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.schTypeSchemas = { ...s.schTypeSchemas, entity: { ...s.schTypeSchemas.entity, person: emptyTypeSchemaState() } };
    expect(s.renameLedger()).toEqual(NOTHING);
  });
});

describe('the bookkeeping never reaches the server', () => {
  it('buildMeta carries the new keys and no stored-name field', () => {
    const s = opened();
    s.renameProp('entity', 'person', 'company', 'employer');
    s.renameType('entity', 'client', 'customer');
    const meta = JSON.stringify(s.buildMeta());
    expect(meta).toContain('"employer"');
    expect(meta).toContain('"customer"');
    expect(meta).not.toMatch(/_was|_stored|wasType/);
  });
});
