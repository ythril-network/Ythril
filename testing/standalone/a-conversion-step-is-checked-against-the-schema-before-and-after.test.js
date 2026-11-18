/**
 * A conversion step is checked against the schema as it was and as it will be, and refused with a code and the index of the step (Q-745,
 * bundle-284 design r4 sections 1.1 and 1.3).
 *
 * ## The defect this prevents
 *
 * A schema change that renames a property, maps an enum value, renames a type or splits one declares HOW the records already stored map to
 * the new schema. A step that names a property the old schema never declared, a value the new enum does not hold, or a type the new schema
 * does not have would be saved, carried to every member of a network by the vote, and then rewrite records into a shape no schema accepts.
 * A rename whose old name is STILL declared would move values that every schema still accepts under the old name (own and layer definitions
 * union their properties, so a rename between two names both declared is not a rename). So every step is held to the schema before and the
 * schema after, by this one module, before anything is written.
 *
 * ## What is held
 *
 * - Each row of the check table: what the BEFORE schema must declare, what the AFTER schema must declare and must not, and what is refused
 *   whatever the schemas say (a name renamed to itself, two renames sharing a name, a key equal to its value, two type steps on one `from`).
 *   Each refusal is a named code and the index of the offending step; the control beside it is the same step with the one fault removed,
 *   so a module that refuses everything does not pass.
 * - A property's old name must be gone from the after-type (`requireGone`, on unless a caller turns it off).
 * - A property step names the type AS IT IS AFTER the type steps; its before-schema is the type its records came from (the `from` of the type
 *   step that targets it), and a property step on a type the type steps move away is `type_not_reached`.
 * - Every bound: over it is refused (never cut), at it is accepted, by the check and by the parse of the body.
 *
 * Seen red on afb6eb8c: `schema/dist/internal.js` exports none of these names, so every case fails on that.
 *
 * Run: node --test testing/standalone/a-conversion-step-is-checked-against-the-schema-before-and-after.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as pkg from '../../schema/dist/internal.js';

const { conversionStepIssues, ConvertRecordsZ, MAX_RULES_PER_SPACE, MAX_RULE_LENGTH, TYPE_NAME_MAX } = pkg;

const props = (propertySchemas) => ({ propertySchemas });
const STATUS = ['open', 'wip', 'done'];

/** The schema before: two entity types and an edge label. */
const before = () => ({
  typeSchemas: {
    entity: {
      person: props({ name: { type: 'string' }, status: { type: 'string', enum: [...STATUS] }, age: { type: 'number' } }),
      company: props({ title: { type: 'string' } }),
    },
    edge: { knows: props({ since: { type: 'string' } }) },
  },
});

/** A copy of `meta` edited by `edit`, so each after-schema is the before-schema plus the one change a case is about. */
const edited = (meta, edit) => {
  const copy = structuredClone(meta);
  edit(copy.typeSchemas);
  return copy;
};
const declaring = (kind, name, propertySchemas) => (types) => { (types[kind] ??= {})[name] = props(propertySchemas); };

const rename = (extra = {}) => ({ op: 'renameProperty', kind: 'entity', type: 'person', from: 'name', to: 'fullName', ...extra });
const mapEnum = (extra = {}) => ({ op: 'mapEnum', kind: 'entity', type: 'person', property: 'status', values: { open: 'OPEN', wip: 'WIP' }, ...extra });
const renameType = (extra = {}) => ({ op: 'renameType', kind: 'entity', from: 'company', to: 'organisation', ...extra });
const WHEN_OPEN = 'self.properties.status == "open"';
const split = (extra = {}) => ({ op: 'splitType', kind: 'entity', from: 'person', cases: [{ when: WHEN_OPEN, to: 'activePerson' }], otherwise: 'person', ...extra });

/** The after-schema in which `rename()` holds. */
const afterRename = () => edited(before(), declaring('entity', 'person', { fullName: { type: 'string' }, status: { type: 'string', enum: [...STATUS] }, age: { type: 'number' } }));
/** The after-schema in which `mapEnum()` holds. */
const afterMap = () => edited(before(), declaring('entity', 'person', { name: { type: 'string' }, status: { type: 'string', enum: ['OPEN', 'WIP', 'done'] }, age: { type: 'number' } }));
/** The after-schema in which `renameType()` holds. */
const afterRenameType = () => edited(before(), declaring('entity', 'organisation', { title: { type: 'string' } }));
/** The after-schema in which `split()` holds. */
const afterSplit = () => edited(before(), declaring('entity', 'activePerson', { name: { type: 'string' }, status: { type: 'string', enum: [...STATUS] } }));

/** The one step a case is about sits at index 1, behind a good step at index 0, so a wrong index is seen. */
const GOOD_FIRST = { op: 'renameType', kind: 'edge', from: 'knows', to: 'knew' };
const withEdge = (meta) => edited(meta, declaring('edge', 'knew', { since: { type: 'string' } }));
const checked = (steps, b, a, options) => conversionStepIssues(steps, b, a, options);
const issuesAt = (issues, step) => issues.filter(i => i.step === step);

/** Asserts that `steps` (the good step first) is refused at index 1 with `code`, and says so in words. */
function refusedAt1(steps, b, a, code, options) {
  const issues = checked([GOOD_FIRST, ...steps], withEdge(b), withEdge(a), options);
  const own = issuesAt(issues, 1).map(i => i.code);
  assert.ok(own.includes(code), `expected ${code} at step 1, got ${JSON.stringify(issues)}`);
  assert.deepEqual(issuesAt(issues, 0), [], `the good step at index 0 is not blamed: ${JSON.stringify(issues)}`);
  for (const i of issues) {
    assert.equal(typeof i.message, 'string');
    assert.ok(i.message.length > 0, 'a refusal says what is wrong in words');
  }
}
/** Asserts that the same steps, fault removed, are accepted. */
function acceptedAt1(steps, b, a, options) {
  const issues = checked([GOOD_FIRST, ...steps], withEdge(b), withEdge(a), options);
  assert.deepEqual(issues, [], `a step with no fault is accepted: ${JSON.stringify(issues)}`);
}

describe('the exports a later slice codes against', () => {
  it('the check, the body and the bounds are exported by the package\'s internal entry', () => {
    assert.equal(typeof conversionStepIssues, 'function');
    assert.equal(typeof ConvertRecordsZ?.safeParse, 'function', 'the zod body of a ConvertRecords');
    assert.equal(pkg.CONVERSION_STEPS_MAX, MAX_RULES_PER_SPACE, 'at most as many steps as a space may have rules');
    assert.equal(pkg.CONVERSION_VALUES_MAX, 200);
    assert.equal(pkg.CONVERSION_CASES_MAX, 20);
  });

  it('a good step of each of the four kinds is accepted, and the same four together', () => {
    assert.deepEqual(checked([rename()], before(), afterRename()), []);
    assert.deepEqual(checked([mapEnum()], before(), afterMap()), []);
    assert.deepEqual(checked([renameType()], before(), afterRenameType()), []);
    assert.deepEqual(checked([split()], before(), afterSplit()), []);
    assert.deepEqual(checked([], before(), before()), [], 'no steps: nothing to refuse');
  });
});

describe('renameProperty', () => {
  it('before must declare `from` on the type', () => {
    acceptedAt1([rename()], before(), afterRename());
    refusedAt1([rename({ from: 'nickname' })], before(), edited(afterRename(), declaring('entity', 'person', { fullName: { type: 'string' } })), 'property_not_declared_before');
  });

  it('after must declare `to` on the type', () => {
    refusedAt1([rename()], before(), edited(before(), declaring('entity', 'person', { status: { type: 'string' } })), 'property_not_declared_after');
  });

  it('after must NOT declare `from` on the type: both names declared is not a rename', () => {
    const bothDeclared = edited(before(), declaring('entity', 'person', { name: { type: 'string' }, fullName: { type: 'string' } }));
    refusedAt1([rename()], before(), bothDeclared, 'property_still_declared');
    refusedAt1([rename()], before(), bothDeclared, 'property_still_declared', { requireGone: true });
  });

  it('`requireGone: false` lifts that one row and no other', () => {
    const bothDeclared = edited(before(), declaring('entity', 'person', { name: { type: 'string' }, fullName: { type: 'string' } }));
    acceptedAt1([rename()], before(), bothDeclared, { requireGone: false });
    // `to` is still required after, and `from` before, whatever the option says.
    refusedAt1([rename()], before(), edited(before(), declaring('entity', 'person', { name: { type: 'string' } })), 'property_not_declared_after', { requireGone: false });
    refusedAt1([rename({ from: 'nickname' })], before(), bothDeclared, 'property_not_declared_before', { requireGone: false });
  });

  it('refuses a name renamed to itself', () => {
    refusedAt1([rename({ to: 'name' })], before(), before(), 'same_name');
  });

  it('refuses two renames that share a `from` on one type, and two that share a `to`', () => {
    const afterTwo = edited(before(), declaring('entity', 'person', { fullName: { type: 'string' }, alias: { type: 'string' }, status: { type: 'string' } }));
    const issuesFrom = checked([rename(), rename({ to: 'alias' })], before(), afterTwo);
    assert.ok(issuesAt(issuesFrom, 1).some(i => i.code === 'duplicate_property_rename'), 'the SECOND of the two is the one named');
    assert.deepEqual(issuesAt(issuesFrom, 0).filter(i => i.code === 'duplicate_property_rename'), []);
    const afterShareTo = edited(before(), declaring('entity', 'person', { fullName: { type: 'string' } }));
    const issuesTo = checked([rename(), rename({ from: 'status' })], before(), afterShareTo);
    assert.ok(issuesAt(issuesTo, 1).some(i => i.code === 'duplicate_property_rename'));
  });

  it('two renames of one `from` on DIFFERENT types are not a collision', () => {
    const b = edited(before(), declaring('entity', 'company', { name: { type: 'string' } }));
    const a = edited(b, (t) => {
      t.entity.person = props({ fullName: { type: 'string' } });
      t.entity.company = props({ fullName: { type: 'string' } });
    });
    assert.deepEqual(checked([rename(), rename({ type: 'company' })], b, a), []);
  });

  it('a type the steps do not name is read as itself, and a type that is not declared at all is refused', () => {
    refusedAt1([rename({ type: 'ghost' })], before(), before(), 'property_not_declared_before');
  });

  it('works for an edge label as the type', () => {
    const b = before();
    const a = edited(b, declaring('edge', 'knows', { sinceDate: { type: 'string' } }));
    assert.deepEqual(checked([{ op: 'renameProperty', kind: 'edge', type: 'knows', from: 'since', to: 'sinceDate' }], b, a), []);
    const bad = checked([{ op: 'renameProperty', kind: 'edge', type: 'knows', from: 'since', to: 'sinceDate' }], b, b);
    assert.ok(bad.some(i => i.code === 'property_not_declared_after'));
  });
});

describe('mapEnum', () => {
  it('before must declare the property with an enum holding every key', () => {
    acceptedAt1([mapEnum()], before(), afterMap());
    refusedAt1([mapEnum({ property: 'ghost' })], before(), afterMap(), 'property_not_declared_before');
    refusedAt1([mapEnum({ property: 'age', values: { a: 'b' } })], before(), afterMap(), 'enum_not_declared_before');
    refusedAt1([mapEnum({ values: { open: 'OPEN', gone: 'WIP' } })], before(), afterMap(), 'enum_key_not_in_before');
  });

  it('after must declare the property with an enum holding every value', () => {
    const noEnum = edited(before(), declaring('entity', 'person', { name: { type: 'string' }, status: { type: 'string' } }));
    refusedAt1([mapEnum()], before(), noEnum, 'enum_not_declared_after');
    const missingValue = edited(before(), declaring('entity', 'person', { name: { type: 'string' }, status: { type: 'string', enum: ['OPEN', 'done'] } }));
    refusedAt1([mapEnum()], before(), missingValue, 'enum_value_not_in_after');
    const noProperty = edited(before(), declaring('entity', 'person', { name: { type: 'string' } }));
    refusedAt1([mapEnum()], before(), noProperty, 'property_not_declared_after');
  });

  it('refuses a key equal to its value', () => {
    refusedAt1([mapEnum({ values: { open: 'open', wip: 'WIP' } })], before(), afterMap(), 'value_equals_key');
  });

  it('refuses two maps of one property of one type: which of them wins would depend on the order of the list', () => {
    const second = mapEnum({ values: { done: 'DONE' } });
    const a = edited(before(), declaring('entity', 'person', { name: { type: 'string' }, status: { type: 'string', enum: ['OPEN', 'WIP', 'DONE', 'done'] } }));
    const issues = checked([mapEnum(), second], before(), a);
    assert.ok(issuesAt(issues, 1).some(i => i.code === 'duplicate_enum_map'), 'the SECOND of the two is the one named');
    assert.deepEqual(issuesAt(issues, 0), []);
    const other = checked([mapEnum(), mapEnum({ type: 'company', property: 'title', values: { a: 'b' } })], before(), a);
    assert.ok(!other.some(i => i.code === 'duplicate_enum_map'), 'a map of another type is not a collision');
  });

  it('names the property by its AFTER name: a rename of the property in the same change is read through', () => {
    const a = edited(before(), declaring('entity', 'person', { name: { type: 'string' }, state: { type: 'string', enum: ['OPEN', 'WIP', 'done'] } }));
    const steps = [rename({ from: 'status', to: 'state' }), mapEnum({ property: 'state' })];
    assert.deepEqual(checked(steps, before(), a), [], 'before declares `status` with the keys, after declares `state` with the values');
    const wrongName = checked([rename({ from: 'status', to: 'state' }), mapEnum({ property: 'status' })], before(), a);
    assert.ok(wrongName.some(i => i.step === 1), 'the before-name of a renamed property is not the property name of the map');
  });
});

describe('renameType', () => {
  it('before must declare `from`, after must declare `to`', () => {
    acceptedAt1([renameType()], before(), afterRenameType());
    refusedAt1([renameType({ from: 'ghost' })], before(), afterRenameType(), 'type_not_declared_before');
    refusedAt1([renameType()], before(), before(), 'type_not_declared_after');
  });

  it('a type the steps leave in the after-schema is accepted: types are not required gone', () => {
    const kept = afterRenameType();
    assert.ok(kept.typeSchemas.entity.company, 'fixture: the old type is still declared after');
    assert.deepEqual(checked([renameType()], before(), kept), []);
  });

  it('refuses a type renamed to itself', () => {
    refusedAt1([renameType({ to: 'company' })], before(), before(), 'same_name');
  });

  it('refuses two type steps on one `from`, a rename and a split included', () => {
    const a = edited(afterRenameType(), declaring('entity', 'activePerson', { name: { type: 'string' }, status: { type: 'string', enum: [...STATUS] } }));
    const twoRenames = checked([renameType({ from: 'person', to: 'activePerson' }), renameType({ from: 'person', to: 'organisation' })], before(), a);
    assert.deepEqual(twoRenames.map(i => [i.step, i.code]), [[1, 'duplicate_type_step']], 'the SECOND step on the one `from` is the one named');
    const renameThenSplit = checked([renameType({ from: 'person', to: 'organisation' }), split()], before(), edited(a, declaring('entity', 'person', { name: { type: 'string' } })));
    assert.ok(renameThenSplit.some(i => i.step === 1 && i.code === 'duplicate_type_step'), JSON.stringify(renameThenSplit));
    assert.ok(!renameThenSplit.some(i => i.step === 0), 'the first step is not blamed');
  });

  it('the same `from` under another kind is another type', () => {
    const b = edited(before(), declaring('edge', 'company', { w: { type: 'string' } }));
    const a = edited(b, (t) => { t.entity.organisation = props({ title: { type: 'string' } }); t.edge.firm = props({ w: { type: 'string' } }); });
    assert.deepEqual(checked([renameType(), { op: 'renameType', kind: 'edge', from: 'company', to: 'firm' }], b, a), []);
  });
});

describe('splitType', () => {
  it('before must declare `from`; after must declare every case `to` and the `otherwise`', () => {
    acceptedAt1([split()], before(), afterSplit());
    refusedAt1([split({ from: 'ghost' })], before(), afterSplit(), 'type_not_declared_before');
    refusedAt1([split()], before(), before(), 'type_not_declared_after');
    refusedAt1([split({ otherwise: 'nowhere' })], before(), afterSplit(), 'type_not_declared_after');
  });

  it('a split with no `otherwise` is accepted (a record no case matches is then not convertible at run time)', () => {
    acceptedAt1([split({ otherwise: undefined })], before(), afterSplit());
  });

  it('a split with no case is refused', () => {
    refusedAt1([split({ cases: [] })], before(), afterSplit(), 'no_cases');
  });

  it('refuses a `when` the rules judge refuses, in the judge\'s own words, and says which case', () => {
    const cases = [{ when: WHEN_OPEN, to: 'activePerson' }, { when: 'self.properties.nickname == "x"', to: 'activePerson' }];
    refusedAt1([split({ cases })], before(), afterSplit(), 'condition_refused');
    const issues = checked([GOOD_FIRST, split({ cases })], withEdge(before()), withEdge(afterSplit()));
    const own = issues.filter(i => i.code === 'condition_refused');
    assert.equal(own.length, 1, 'only the second case is refused');
    assert.match(own[0].message, /nickname/, 'it names what the condition reads that the type does not declare');
    assert.match(own[0].message, /does not declare/);
  });
});

describe('a property step names the type as it is after the type steps', () => {
  it('a rename on a type another step moved to takes its before-schema from the `from` of that step', () => {
    const steps = [renameType(), rename({ type: 'organisation', from: 'title', to: 'legalName' })];
    const a = edited(before(), declaring('entity', 'organisation', { legalName: { type: 'string' } }));
    assert.deepEqual(checked(steps, before(), a), [], '`title` is declared by `company`, which `organisation` came from');
    const bad = checked([renameType(), rename({ type: 'organisation', from: 'name', to: 'legalName' })], before(), a);
    assert.ok(bad.some(i => i.step === 1 && i.code === 'property_not_declared_before'), '`name` is declared by person, not by company');
  });

  it('a split\'s target takes its before-schema from the split\'s `from`', () => {
    const steps = [split(), rename({ type: 'activePerson', from: 'name', to: 'fullName' })];
    const a = edited(afterSplit(), declaring('entity', 'activePerson', { fullName: { type: 'string' }, status: { type: 'string', enum: [...STATUS] } }));
    assert.deepEqual(checked(steps, before(), a), []);
  });

  it('refuses a property step on a type the type steps move away: its records are no longer of that type', () => {
    const steps = [renameType(), rename({ type: 'company', from: 'title', to: 'label' })];
    const a = edited(afterRenameType(), declaring('entity', 'company', { label: { type: 'string' } }));
    const issues = checked(steps, before(), a);
    assert.ok(issues.some(i => i.step === 1 && i.code === 'type_not_reached'), JSON.stringify(issues));
  });

  it('a type that is the source AND a target of its own split is reached', () => {
    const steps = [split(), rename({ type: 'person', from: 'name', to: 'fullName' })];
    const a = edited(afterSplit(), declaring('entity', 'person', { fullName: { type: 'string' } }));
    assert.equal(checked(steps, before(), a).filter(i => i.code === 'type_not_reached').length, 0);
  });
});

describe('every bound is refused over and accepted at', () => {
  /** `n` renames of one type's properties, in a before-schema and an after-schema in which each holds. */
  const manyRenames = (n) => {
    const names = (prefix) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`${prefix}${i}`, { type: 'string' }]));
    return {
      steps: Array.from({ length: n }, (_, i) => ({ op: 'renameProperty', kind: 'entity', type: 'wide', from: `a${i}`, to: `b${i}` })),
      b: { typeSchemas: { entity: { wide: props(names('a')) } } },
      a: { typeSchemas: { entity: { wide: props(names('b')) } } },
    };
  };
  const enumOf = (n, prefix) => Array.from({ length: n }, (_, i) => `${prefix}${i}`);
  const mapOf = (n) => ({
    step: { op: 'mapEnum', kind: 'entity', type: 'wide', property: 'p', values: Object.fromEntries(enumOf(n, 'k').map((k, i) => [k, `v${i}`])) },
    b: { typeSchemas: { entity: { wide: props({ p: { type: 'string', enum: enumOf(n, 'k') } }) } } },
    a: { typeSchemas: { entity: { wide: props({ p: { type: 'string', enum: enumOf(n, 'v') } }) } } },
  });
  const casesOf = (n) => ({
    step: { op: 'splitType', kind: 'entity', from: 'person', cases: Array.from({ length: n }, (_, i) => ({ when: `self.properties.status == "s${i}"`, to: 'activePerson' })) },
  });

  it('steps: at most CONVERSION_STEPS_MAX', () => {
    const ok = manyRenames(pkg.CONVERSION_STEPS_MAX);
    assert.deepEqual(checked(ok.steps, ok.b, ok.a), []);
    assert.equal(ConvertRecordsZ.safeParse({ steps: ok.steps }).success, true);
    const over = manyRenames(pkg.CONVERSION_STEPS_MAX + 1);
    const issues = checked(over.steps, over.b, over.a);
    const own = issues.filter(i => i.code === 'too_many_steps');
    assert.equal(own.length, 1, JSON.stringify(issues.slice(0, 3)));
    assert.equal(own[0].step, pkg.CONVERSION_STEPS_MAX, 'the first step over the bound is the one named');
    assert.equal(ConvertRecordsZ.safeParse({ steps: over.steps }).success, false, 'the body refuses what the check refuses');
  });

  it('values in one mapEnum: at most CONVERSION_VALUES_MAX', () => {
    const ok = mapOf(pkg.CONVERSION_VALUES_MAX);
    assert.deepEqual(checked([ok.step], ok.b, ok.a), []);
    assert.equal(ConvertRecordsZ.safeParse({ steps: [ok.step] }).success, true);
    const over = mapOf(pkg.CONVERSION_VALUES_MAX + 1);
    const issues = checked([over.step], over.b, over.a);
    assert.ok(issues.some(i => i.step === 0 && i.code === 'too_many_values'), JSON.stringify(issues.slice(0, 3)));
    assert.equal(ConvertRecordsZ.safeParse({ steps: [over.step] }).success, false);
  });

  it('cases in one split: at most CONVERSION_CASES_MAX', () => {
    const a = afterSplit();
    const ok = casesOf(pkg.CONVERSION_CASES_MAX);
    assert.deepEqual(checked([ok.step], before(), a), []);
    assert.equal(ConvertRecordsZ.safeParse({ steps: [ok.step] }).success, true);
    const over = casesOf(pkg.CONVERSION_CASES_MAX + 1);
    const issues = checked([over.step], before(), a);
    assert.ok(issues.some(i => i.step === 0 && i.code === 'too_many_cases'), JSON.stringify(issues.slice(0, 3)));
    assert.equal(ConvertRecordsZ.safeParse({ steps: [over.step] }).success, false);
  });

  it('a type name: at most TYPE_NAME_MAX characters, in every field that names a type', () => {
    const longName = 'x'.repeat(TYPE_NAME_MAX + 1);
    const exact = 'y'.repeat(TYPE_NAME_MAX);
    const make = {
      renameTypeTo: (n) => ({ step: renameType({ to: n }), a: edited(before(), declaring('entity', n, { title: { type: 'string' } })), b: before() }),
      renameTypeFrom: (n) => ({ step: renameType({ from: n, to: 'organisation' }), a: afterRenameType(), b: edited(before(), declaring('entity', n, { title: { type: 'string' } })) }),
      renamePropertyType: (n) => ({ step: rename({ type: n }), a: edited(afterRename(), declaring('entity', n, { fullName: { type: 'string' } })), b: edited(before(), declaring('entity', n, { name: { type: 'string' } })) }),
      splitOtherwise: (n) => ({ step: split({ otherwise: n }), a: edited(afterSplit(), declaring('entity', n, { name: { type: 'string' } })), b: before() }),
      splitCaseTo: (n) => ({ step: split({ cases: [{ when: WHEN_OPEN, to: n }] }), a: edited(afterSplit(), declaring('entity', n, { name: { type: 'string' } })), b: before() }),
    };
    for (const [field, build] of Object.entries(make)) {
      const ok = build(exact);
      assert.deepEqual(checked([ok.step], ok.b, ok.a), [], `${field}: a name at the bound is accepted`);
      assert.equal(ConvertRecordsZ.safeParse({ steps: [ok.step] }).success, true, `${field}: the body accepts it`);
      const over = build(longName);
      const issues = checked([over.step], over.b, over.a);
      assert.ok(issues.some(i => i.step === 0 && i.code === 'type_name_too_long'), `${field}: ${JSON.stringify(issues.slice(0, 2))}`);
      assert.equal(ConvertRecordsZ.safeParse({ steps: [over.step] }).success, false, `${field}: the body refuses it`);
    }
  });

  it('a `when`: at most MAX_RULE_LENGTH characters', () => {
    const padded = (length) => {
      const head = 'self.properties.status == "';
      return `${head}${'a'.repeat(length - head.length - 1)}"`;
    };
    const exact = padded(MAX_RULE_LENGTH);
    assert.equal(exact.length, MAX_RULE_LENGTH);
    const at = split({ cases: [{ when: exact, to: 'activePerson' }] });
    assert.deepEqual(checked([at], before(), afterSplit()), []);
    assert.equal(ConvertRecordsZ.safeParse({ steps: [at] }).success, true);
    const long = split({ cases: [{ when: padded(MAX_RULE_LENGTH + 1), to: 'activePerson' }] });
    const issues = checked([long], before(), afterSplit());
    assert.ok(issues.some(i => i.step === 0 && i.code === 'condition_too_long'), JSON.stringify(issues));
    assert.equal(ConvertRecordsZ.safeParse({ steps: [long] }).success, false);
  });

  it('an empty `when`, an unknown op and a step with no kind are refused by the body and named by the check', () => {
    for (const step of [split({ cases: [{ when: '', to: 'activePerson' }] }), { op: 'dropEverything', kind: 'entity', from: 'a' }, { op: 'renameType', from: 'a', to: 'b' }, { ...renameType(), extra: 1 }]) {
      assert.equal(ConvertRecordsZ.safeParse({ steps: [step] }).success, false, JSON.stringify(step));
      const issues = checked([step], before(), before());
      assert.ok(issues.some(i => i.step === 0), `${JSON.stringify(step)} is named at index 0`);
    }
  });
});
