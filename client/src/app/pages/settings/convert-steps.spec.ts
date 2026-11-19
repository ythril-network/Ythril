/**
 * The steps a Save proposes, from the rename ledger and the difference between the stored and the staged schema (bundle-285 slice S5,
 * Q-747; plan sections 3.1 item 2, 5 rows D4 and E, 9; handover s5 "Steps from the ledger").
 *
 * What these hold, in the pieces a later change could drop without any other test noticing:
 *
 * - **A block per changed type, in STORED names.** A renamed property is a step `from` the name the records still carry; a renamed type
 *   is a block whose records are those of its OLD name; an unchanged type has no block; a type that is new or removed has none.
 * - **The server's order.** The type step first, then the property steps (a property step names the type by its NEW name).
 * - **Nothing the ledger does not hold is a step.** A removed enum value is an OFFER of a map, never a step, and its target is never
 *   invented: the offered row has an empty target and is not a step until a person chooses one.
 * - **A rule that still names a renamed property's old name is a warning**, naming the rule: a rename does not rewrite rules. A naming
 *   pattern is none: it checks a record's name and cannot name a property (S6 dropped the warning S5 built for it).
 * - **The editor's rows are strings throughout**, so a half-typed row is representable and is not a step (and so is never sent).
 *
 * ## Seen red
 *
 * Red at beabdcccb: `pages/settings/convert-steps.ts` does not exist.
 */
import { describe, it, expect } from 'vitest';
import type { TypeSchema } from '../../core/api.types';
import type { ConversionStep } from '../../core/conversion.types';
import type { RenameLedger } from './type-schema-edits';
import {
  convertBlocks, editOf, locateStep, offerStep, sortEdits, stepOf, stepsOfEdits, typesOf, enumValuesOf, withAddedTypes,
  type ConvertSchemas, type EditStep,
} from './convert-steps';

const NO_RENAMES: RenameLedger = { types: [], props: [] };

const person = (props: Record<string, Record<string, unknown>> = { company: { type: 'string' } }, more: Partial<TypeSchema> = {}): TypeSchema =>
  ({ propertySchemas: props, ...more }) as TypeSchema;

describe('which types get a block', () => {
  it('an unchanged type has no block', () => {
    const schemas: ConvertSchemas = { entity: { person: person() } };
    expect(convertBlocks(schemas, structuredClone(schemas), NO_RENAMES)).toEqual([]);
  });

  it('a type whose definition differs has a block with no step: its records are stamped, and the dialog counts them', () => {
    const original: ConvertSchemas = { entity: { person: person() } };
    const staged: ConvertSchemas = { entity: { person: person({ company: { type: 'string', required: true } }) } };
    expect(convertBlocks(original, staged, NO_RENAMES)).toEqual([
      { kind: 'entity', type: 'person', steps: [], offers: [], warnings: [] },
    ]);
  });

  it('a type that is new (no stored copy, no rename) and a type that was removed have no block: nothing of theirs is converted', () => {
    const original: ConvertSchemas = { entity: { gone: person(), person: person() } };
    const staged: ConvertSchemas = { entity: { person: person(), fresh: person() } };
    expect(convertBlocks(original, staged, NO_RENAMES)).toEqual([]);
  });

  it('is the same whatever order the keys of a definition were written in', () => {
    const original: ConvertSchemas = { entity: { person: { description: 'd', propertySchemas: { a: { type: 'string', required: true } } } } };
    const staged: ConvertSchemas = { entity: { person: { propertySchemas: { a: { required: true, type: 'string' } }, description: 'd' } } };
    expect(convertBlocks(original, staged, NO_RENAMES)).toEqual([]);
  });

  it('reads each kind apart: the same name under two kinds is two types, and an edge is read by its label', () => {
    const original: ConvertSchemas = { entity: { x: person() }, fact: { x: person() }, edge: { knows: person() } };
    const staged: ConvertSchemas = { entity: { x: person() }, fact: { x: person({ other: { type: 'string' } }) }, edge: { knows: person({ since: { type: 'number' } }) } };
    expect(convertBlocks(original, staged, NO_RENAMES).map(b => `${b.kind}:${b.type}`)).toEqual(['fact:x', 'edge:knows']);
  });
});

describe('the steps come from the ledger, in stored names', () => {
  const original: ConvertSchemas = { entity: { person: person({ company: { type: 'string' } }) } };
  const staged: ConvertSchemas = { entity: { person: person({ employer: { type: 'string' } }) } };

  it('a renamed property is one renameProperty step `from` the stored name, on the type', () => {
    const ledger: RenameLedger = { types: [], props: [{ kind: 'entity', type: 'person', wasType: 'person', from: 'company', to: 'employer' }] };
    const [block] = convertBlocks(original, staged, ledger);
    expect(block!.steps).toEqual<ConversionStep[]>([{ op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' }]);
    expect(block!.type).toBe('person');
    expect(block!.was).toBeUndefined();
  });

  it('a renamed type is one block named by its NEW name that remembers the old one: its records are counted under the old name', () => {
    const o: ConvertSchemas = { entity: { client: person() } };
    const s: ConvertSchemas = { entity: { customer: person() } };
    const ledger: RenameLedger = { types: [{ kind: 'entity', from: 'client', to: 'customer' }], props: [] };
    expect(convertBlocks(o, s, ledger)).toEqual([{
      kind: 'entity', type: 'customer', was: 'client', offers: [], warnings: [],
      steps: [{ op: 'renameType', kind: 'entity', from: 'client', to: 'customer' }],
    }]);
  });

  it('a type rename with no other difference still has a block: the rename is the change', () => {
    const o: ConvertSchemas = { entity: { client: person() } };
    const s: ConvertSchemas = { entity: { customer: person() } };
    const blocks = convertBlocks(o, s, { types: [{ kind: 'entity', from: 'client', to: 'customer' }], props: [] });
    expect(blocks).toHaveLength(1);
  });

  it('puts the type step first and the property step after it, which names the type by its NEW name: the order the server applies', () => {
    const o: ConvertSchemas = { entity: { client: person({ tel: { type: 'string' } }) } };
    const s: ConvertSchemas = { entity: { customer: person({ phone: { type: 'string' } }) } };
    const ledger: RenameLedger = {
      types: [{ kind: 'entity', from: 'client', to: 'customer' }],
      props: [{ kind: 'entity', type: 'customer', wasType: 'client', from: 'tel', to: 'phone' }],
    };
    const [block] = convertBlocks(o, s, ledger);
    expect(block!.steps).toEqual<ConversionStep[]>([
      { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' },
      { op: 'renameProperty', kind: 'entity', type: 'customer', from: 'tel', to: 'phone' },
    ]);
  });

  it('keeps each rename in its own kind and type: a rename in one type gives the other no step', () => {
    const o: ConvertSchemas = { entity: { person: person({ a: {} }), org: person({ a: {} }) } };
    const s: ConvertSchemas = { entity: { person: person({ b: {} }), org: person({ a: {} }) } };
    const ledger: RenameLedger = { types: [], props: [{ kind: 'entity', type: 'person', wasType: 'person', from: 'a', to: 'b' }] };
    const blocks = convertBlocks(o, s, ledger);
    expect(blocks.map(b => b.type)).toEqual(['person']);
  });
});

describe('a removed enum value is an offer, never a step', () => {
  const withEnum = (values: unknown[]): TypeSchema => person({ status: { type: 'string', enum: values } });

  it('offers a map for the values the stored enum had and the staged one lacks, and puts no step in the block', () => {
    const [block] = convertBlocks({ entity: { person: withEnum(['active', 'lead']) } }, { entity: { person: withEnum(['current']) } }, NO_RENAMES);
    expect(block!.steps).toEqual([]);
    expect(block!.offers).toEqual([{ kind: 'entity', type: 'person', property: 'status', removed: ['active', 'lead'] }]);
  });

  it('never invents the target: the offered row has an empty target for each value and is not a step until a person chooses', () => {
    const [block] = convertBlocks({ entity: { person: withEnum(['active', 'lead']) } }, { entity: { person: withEnum(['current']) } }, NO_RENAMES);
    const row = offerStep(block!.offers[0]!);
    expect(row).toEqual({ op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', pairs: [{ from: 'active', to: '' }, { from: 'lead', to: '' }] });
    expect(stepOf(row)).toBeNull();
  });

  it('is offered under the property\'s NEW name when it was renamed, reading the stored enum under its old name', () => {
    const o: ConvertSchemas = { entity: { person: person({ state: { type: 'string', enum: ['a', 'b'] } }) } };
    const s: ConvertSchemas = { entity: { person: person({ status: { type: 'string', enum: ['b'] } }) } };
    const ledger: RenameLedger = { types: [], props: [{ kind: 'entity', type: 'person', wasType: 'person', from: 'state', to: 'status' }] };
    const [block] = convertBlocks(o, s, ledger);
    expect(block!.offers).toEqual([{ kind: 'entity', type: 'person', property: 'status', removed: ['a'] }]);
    expect(block!.steps).toHaveLength(1);
  });

  it('offers nothing for a value that was only added, for an enum the staged type no longer has, or for a property with no stored enum', () => {
    expect(convertBlocks({ entity: { person: withEnum(['a']) } }, { entity: { person: withEnum(['a', 'b']) } }, NO_RENAMES)[0]!.offers).toEqual([]);
    expect(convertBlocks({ entity: { person: withEnum(['a']) } }, { entity: { person: person({ status: { type: 'string' } }) } }, NO_RENAMES)[0]!.offers).toEqual([]);
    expect(convertBlocks({ entity: { person: person({ status: { type: 'string' } }) } }, { entity: { person: withEnum(['a']) } }, NO_RENAMES)[0]!.offers).toEqual([]);
  });

  it('compares values as text: a stored 4 and a staged "4" are the same allowed value, and a number is offered as its text', () => {
    expect(convertBlocks({ entity: { person: withEnum([4, 5]) } }, { entity: { person: withEnum(['4']) } }, NO_RENAMES)[0]!.offers)
      .toEqual([{ kind: 'entity', type: 'person', property: 'status', removed: ['5'] }]);
  });

  it('reads the stored enum of a renamed type under the type\'s old name', () => {
    const o: ConvertSchemas = { entity: { client: withEnum(['a', 'b']) } };
    const s: ConvertSchemas = { entity: { customer: withEnum(['b']) } };
    const [block] = convertBlocks(o, s, { types: [{ kind: 'entity', from: 'client', to: 'customer' }], props: [] });
    expect(block!.offers).toEqual([{ kind: 'entity', type: 'customer', property: 'status', removed: ['a'] }]);
  });
});

describe('a rule that still names the old name of a renamed property is a warning, a naming pattern is not', () => {
  const ledger: RenameLedger = { types: [], props: [{ kind: 'entity', type: 'person', wasType: 'person', from: 'company', to: 'employer' }] };
  const original: ConvertSchemas = { entity: { person: person({ company: { type: 'string' } }) } };
  const stagedWith = (more: Partial<TypeSchema>): ConvertSchemas => ({ entity: { person: person({ employer: { type: 'string' } }, more) } });

  it('names the rule, the old name and the new one', () => {
    const [block] = convertBlocks(original, stagedWith({ rules: { 'has-company': { rule: 'self.properties.company != ""', message: 'm' } } }), ledger);
    expect(block!.warnings).toEqual([{ kind: 'rule', type: 'person', rule: 'has-company', property: 'company', to: 'employer' }]);
  });

  it('finds the bracket spelling too, and says each rule once', () => {
    const [block] = convertBlocks(original, stagedWith({ rules: {
      a: { rule: 'self.properties["company"] != "" && self.properties.company != "x"', message: 'm' },
      b: { rule: "self.properties['company'] != ''", message: 'm' },
    } }), ledger);
    expect(block!.warnings.map(w => (w.kind === 'rule' ? w.rule : w.kind))).toEqual(['a', 'b']);
  });

  it('does not warn for another property whose name merely starts with the old one, for the new name, or for a rule that names neither', () => {
    const [block] = convertBlocks(original, stagedWith({ rules: {
      a: { rule: 'self.properties.companyName != ""', message: 'm' },
      b: { rule: 'self.properties.employer != ""', message: 'm' },
      c: { rule: 'self.name != ""', message: 'm' },
      d: { rule: 'self.properties.xcompany != ""', message: 'm' },
    } }), ledger);
    expect(block!.warnings).toEqual([]);
  });

  it('never warns about a naming pattern, even one holding the old property name as a whole word: a pattern checks a record\'s NAME and cannot name a property', () => {
    expect(convertBlocks(original, stagedWith({ namingPattern: '^company-[a-z]+$' }), ledger)[0]!.warnings).toEqual([]);
    expect(convertBlocks(original, stagedWith({ namingPattern: 'company' }), ledger)[0]!.warnings).toEqual([]);
    expect(convertBlocks(original, stagedWith({ namingPattern: '^companyX-[a-z]+$' }), ledger)[0]!.warnings).toEqual([]);
    // a rule beside the pattern still warns, so the pattern is the only thing dropped
    const both = convertBlocks(original, stagedWith({ namingPattern: 'company', rules: { r: { rule: 'self.properties.company != ""', message: 'm' } } }), ledger)[0]!;
    expect(both.warnings.map(w => w.kind)).toEqual(['rule']);
  });

  it('warns only for a renamed property: a rule naming a property that was not renamed is none of the ledger\'s business', () => {
    const [block] = convertBlocks(original, stagedWith({ rules: { r: { rule: 'self.properties.age > 0', message: 'm' } } }), ledger);
    expect(block!.warnings).toEqual([]);
  });

  it('does not warn when the type declares the old name again: the name is in use, not stale', () => {
    const staged: ConvertSchemas = { entity: { person: person({ employer: { type: 'string' }, company: { type: 'string' } }, { rules: { r: { rule: 'self.properties.company != ""', message: 'm' } } }) } };
    expect(convertBlocks(original, staged, ledger)[0]!.warnings).toEqual([]);
  });

  it('warns on the block of the type that carries the rule, and on no other', () => {
    const orgRules = { rules: { r: { rule: 'self.properties.company != ""', message: 'm' } } };
    const o: ConvertSchemas = { entity: { person: person({ company: {} }), org: person({ company: {} }, orgRules) } };
    const s: ConvertSchemas = { entity: { person: person({ employer: {} }), org: person({ company: {} }, orgRules) } };
    const blocks = convertBlocks(o, s, ledger);
    expect(blocks.map(b => b.type)).toEqual(['person']);
    expect(blocks[0]!.warnings).toEqual([]);
  });
});

describe('the editor\'s rows', () => {
  const rename: ConversionStep = { op: 'renameProperty', kind: 'entity', type: 'person', from: 'company', to: 'employer' };
  const map: ConversionStep = { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { active: 'current', lead: 'prospect' } };
  const retype: ConversionStep = { op: 'renameType', kind: 'entity', from: 'client', to: 'customer' };
  const split: ConversionStep = { op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'self.properties.kind == "org"', to: 'organization' }], otherwise: 'person' };

  it('a complete step becomes a row and comes back as the same step', () => {
    for (const step of [rename, map, retype, split]) expect(stepOf(editOf(step)), step.op).toEqual(step);
  });

  it('a row with an empty name, an empty target, an unchanged name or no case is not a step yet', () => {
    const incomplete: EditStep[] = [
      { op: 'renameProperty', kind: 'entity', type: 'person', from: 'a', to: '' },
      { op: 'renameProperty', kind: 'entity', type: 'person', from: '', to: 'b' },
      { op: 'renameProperty', kind: 'entity', type: 'person', from: 'a', to: 'a' },
      { op: 'renameProperty', kind: 'entity', type: 'person', from: '  ', to: 'b' },
      { op: 'renameType', kind: 'entity', from: 'a', to: '' },
      { op: 'renameType', kind: 'entity', from: 'a', to: 'a' },
      { op: 'mapEnum', kind: 'entity', type: 'person', property: '', pairs: [{ from: 'a', to: 'b' }] },
      { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', pairs: [] },
      { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', pairs: [{ from: 'a', to: '' }] },
      { op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', pairs: [{ from: 'a', to: 'a' }] },
      { op: 'splitType', kind: 'entity', from: 'contact', cases: [], otherwise: '' },
      { op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: '', to: 'x' }], otherwise: '' },
      { op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'a == 1', to: '' }], otherwise: '' },
    ];
    for (const row of incomplete) expect(stepOf(row), JSON.stringify(row)).toBeNull();
  });

  it('a map that names one old value twice is not a step: a record cannot be mapped two ways', () => {
    expect(stepOf({ op: 'mapEnum', kind: 'entity', type: 'person', property: 's', pairs: [{ from: 'a', to: 'x' }, { from: 'a', to: 'y' }] })).toBeNull();
  });

  it('a split with no `otherwise` is a step without the key (the server leaves a record no case matches unconverted), never `otherwise: ""`', () => {
    const step = stepOf({ op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'a == 1', to: 'x' }], otherwise: '' });
    expect(step).toEqual({ op: 'splitType', kind: 'entity', from: 'contact', cases: [{ when: 'a == 1', to: 'x' }] });
    expect(step && 'otherwise' in step).toBe(false);
  });

  it('puts the type steps first and the property steps after them, the maps last, each group in the order it has: the order sent and the order the server applies', () => {
    const rows = [map, rename, split, retype].map(editOf);
    expect(sortEdits(rows).map(r => r.op)).toEqual(['splitType', 'renameType', 'renameProperty', 'mapEnum']);
    const two = [{ ...rename, from: 'x' }, rename].map(editOf);
    expect(sortEdits(two).map(r => (r.op === 'renameProperty' ? r.from : ''))).toEqual(['x', 'company']);
  });

  it('sends only the complete rows, in the order shown: that is the list an index the server names counts in', () => {
    const rows: EditStep[] = [editOf(rename), { op: 'renameType', kind: 'entity', from: 'a', to: '' }, editOf(retype)];
    expect(stepsOfEdits(rows)).toEqual([rename, retype]);
  });

  it('finds the row an index names among the steps SENT, skipping a half-typed row', () => {
    const rows: EditStep[][] = [
      [editOf(rename), { op: 'renameType', kind: 'entity', from: 'a', to: '' }],
      [editOf(retype), editOf(map)],
    ];
    expect(locateStep(rows, 0)).toEqual({ block: 0, row: 0 });
    expect(locateStep(rows, 1)).toEqual({ block: 1, row: 0 });
    expect(locateStep(rows, 2)).toEqual({ block: 1, row: 1 });
    expect(locateStep(rows, 3)).toBeNull();
    expect(locateStep(rows, -1)).toBeNull();
  });
});

describe('the staged schema as the editor and the save read it', () => {
  const staged: ConvertSchemas = {
    entity: { contact: person({ status: { type: 'string', enum: ['a', 4, true] } }), person: person() },
    edge: { knows: person() },
  };

  it('lists the types of a kind in the order the schema holds them, and an unknown kind has none', () => {
    expect(typesOf(staged, 'entity')).toEqual(['contact', 'person']);
    expect(typesOf(staged, 'fact')).toEqual([]);
  });

  it('lists the values of a property\'s enum as text, and none for a property or type that has no enum', () => {
    expect(enumValuesOf(staged, 'entity', 'contact', 'status')).toEqual(['a', '4', 'true']);
    expect(enumValuesOf(staged, 'entity', 'contact', 'nope')).toEqual([]);
    expect(enumValuesOf(staged, 'entity', 'nobody', 'status')).toEqual([]);
  });

  it('adds a new type as a COPY of the source, without touching what it was given', () => {
    const copy = withAddedTypes(staged, [{ kind: 'entity', name: 'organization', copyOf: 'contact' }]);
    expect(typesOf(copy, 'entity')).toEqual(['contact', 'person', 'organization']);
    expect(copy.entity!['organization']).toEqual(staged.entity!['contact']);
    expect(copy.entity!['organization']).not.toBe(staged.entity!['contact']);
    copy.entity!['organization']!.propertySchemas!['status']!.enum!.push('z');
    expect(staged.entity!['contact']!.propertySchemas!['status']!.enum).toEqual(['a', 4, true]);
    expect(typesOf(staged, 'entity')).toEqual(['contact', 'person']);
  });

  it('keeps a type that already has the name, and gives a source it does not know an empty definition', () => {
    const copy = withAddedTypes(staged, [{ kind: 'entity', name: 'person', copyOf: 'contact' }, { kind: 'fact', name: 'note', copyOf: 'missing' }]);
    expect(copy.entity!['person']).toEqual(staged.entity!['person']);
    expect(copy.fact).toEqual({ note: {} });
  });
});
