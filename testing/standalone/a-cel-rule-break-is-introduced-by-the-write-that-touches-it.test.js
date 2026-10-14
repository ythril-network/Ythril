/**
 * Whose fault a rule's violation is: introduced by this write, or pre-existing (F-46, ruling R6-3, owner P-6).
 *
 * ## The rule for a rule
 *
 * A schema violation is `introduced` — and blocks a write in a strict space — when the record AFTER the write breaks it and the
 * record BEFORE did not. That is P-6 (a record that was already broken must stay editable: `freezes records`, the canary report).
 * For a rule R6-3 adds one clause, because a rule's identity is `(field, reason)` and a record can break the same rule twice
 * without it being the same break:
 *
 * > a rule's break is introduced when the record after the write breaks it AND (the record before did not, OR the write changed
 * > a path the rule references).
 *
 * So the record that already breaks a rule keeps its edits unrelated to that rule (a description, a tag), and cannot use the
 * rule's earlier failure to shelter a NEW failure of the same rule: changing the very property the rule reads, to another value
 * that also fails, is a new break and is refused.
 *
 * ## The case this was written for: a stuffed record
 *
 * A record that arrives over sync or an import is recorded, never refused. One arriving with a 50 000-character property is
 * "too large to check" for every rule that reads that property — a violation, pre-existing. Without the clause above that
 * pre-existing violation would shelter every later write of the record, including one that replaces the huge value with another
 * huge value; "could not evaluate" and "too large" would be permanent exemptions that any peer could hand out.
 *
 * ## What is asserted
 *
 * Through the classifiers every write goes through (`classify<Kind>UpsertAgainst`): `introduced`, `preExisting` and `blocked`, by
 * the identity of the rule row. A write that changes nothing the rule reads leaves a pre-existing break pre-existing, in every
 * state of the rule (violated, could not evaluate, too large). Under `warn` the break is reported and never blocks.
 *
 * Run: node --test testing/standalone/a-cel-rule-break-is-introduced-by-the-write-that-touches-it.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { rule, strictMeta, recordOf, ruleRows, evaluation } from './_cel-rules.mjs';

const BELOW = 'b must be below one hundred';
const meta = (mode = 'strict') => strictMeta({ mode, rules: { below: rule('self.properties.b < 100.0', BELOW) } });
const fieldsOf = (violations) => ruleRows(violations).map(v => v.field);

/** `classifyEntityUpsertAgainst` with the shapes a stored entity and an incoming write have. */
async function classify(m, existing, incoming) {
  const { writeValidation } = await evaluation();
  return writeValidation.classifyEntityUpsertAgainst(m, existing, incoming);
}

const stored = (o = {}) => recordOf.entity({ description: 'as stored', ...o });
const write = (o = {}) => ({ name: 'Acme', type: 'thing', ...o });

describe('a break the write introduces blocks it; a break the record already had does not', () => {
  it('an insert that breaks the rule introduces the break', async () => {
    const c = await classify(meta(), null, write({ properties: { b: 500 } }));
    assert.deepEqual(fieldsOf(c.introduced), ['rules.below']);
    assert.equal(c.blocked, true);
  });

  it('a write that fixes the break leaves nothing, and a write that breaks a sound record introduces it', async () => {
    const fixed = await classify(meta(), stored({ properties: { b: 500 } }), write({ properties: { b: 5 } }));
    assert.deepEqual([fieldsOf(fixed.introduced), fieldsOf(fixed.preExisting), fixed.blocked], [[], [], false]);
    const broken = await classify(meta(), stored({ properties: { b: 5 } }), write({ properties: { b: 500 } }));
    assert.deepEqual(fieldsOf(broken.introduced), ['rules.below']);
    assert.equal(broken.blocked, true);
  });

  it('a record that already breaks the rule stays editable by writes that do not touch what the rule reads', async () => {
    const c = await classify(meta(), stored({ properties: { b: 500 } }), write({ description: 'edited', properties: {} }));
    assert.deepEqual(fieldsOf(c.preExisting), ['rules.below'], 'the unchanged break is not reported as pre-existing');
    assert.deepEqual(fieldsOf(c.introduced), [], 'the edit was blamed for a break it did not cause');
    assert.equal(c.blocked, false, 'a description edit was refused for a rule it did not touch: the record is frozen');
  });

  it('...but not by a write that changes what the rule reads, even to a value that fails it the same way', async () => {
    const c = await classify(meta(), stored({ properties: { b: 500 } }), write({ properties: { b: 600 } }));
    assert.deepEqual(fieldsOf(c.introduced), ['rules.below'],
      'the record\'s earlier failure sheltered a new failure of the same rule');
    assert.equal(c.blocked, true);
  });

  it('a write that sends the property back unchanged did not change it', async () => {
    const c = await classify(meta(), stored({ properties: { b: 500 } }), write({ properties: { b: 500 } }));
    assert.deepEqual(fieldsOf(c.preExisting), ['rules.below'], 'the unchanged break must still be reported');
    assert.deepEqual(fieldsOf(c.introduced), []);
    assert.equal(c.blocked, false, 'a round trip of the record as it was is not a change');
  });

  it('only the rule\'s own paths count: changing another property is not touching the rule', async () => {
    const c = await classify(meta(), stored({ properties: { a: 'old', b: 500 } }), write({ properties: { a: 'new' } }));
    assert.deepEqual(fieldsOf(c.preExisting), ['rules.below'], 'the unchanged break must still be reported');
    assert.deepEqual(fieldsOf(c.introduced), []);
    assert.equal(c.blocked, false);
  });

  it('a rule on the title is touched by renaming the record, and by nothing else', async () => {
    const m = strictMeta({ rules: { named: rule(`self.title != 'Forbidden'`, 'not that name') } });
    const rename = await classify(m, stored({ name: 'Forbidden' }), write({ name: 'Forbidden', description: 'edited' }));
    assert.equal(rename.blocked, false, 'an edit that leaves the name alone was refused for the name');
    const renamed = await classify(m, stored({ name: 'Fine' }), write({ name: 'Forbidden' }));
    assert.deepEqual(fieldsOf(renamed.introduced), ['rules.named']);
    assert.equal(renamed.blocked, true);
  });

  it('under warn the same break is reported and nothing blocks', async () => {
    const c = await classify(meta('warn'), stored({ properties: { b: 500 } }), write({ properties: { b: 600 } }));
    assert.deepEqual(fieldsOf(c.introduced), ['rules.below']);
    assert.equal(c.blocked, false);
    assert.deepEqual(fieldsOf(c.warnings), ['rules.below'], 'warn returns the break');
  });
});

describe('could not evaluate and too large are breaks like any other: a record that arrived stuffed cannot shelter a new one', () => {
  it('could not evaluate: pre-existing for an unrelated edit, introduced when the property the rule reads is replaced', async () => {
    const existing = stored({ properties: { b: 'not-a-number' } });
    const unrelated = await classify(meta(), existing, write({ description: 'edited', properties: {} }));
    assert.deepEqual(fieldsOf(unrelated.preExisting), ['rules.below']);
    assert.equal(unrelated.blocked, false);
    const replaced = await classify(meta(), existing, write({ properties: { b: 'still-not-a-number' } }));
    assert.deepEqual(fieldsOf(replaced.introduced), ['rules.below']);
    assert.equal(replaced.blocked, true);
  });

  it('too large (a record that arrived over sync with a 50 000-character value): an unrelated edit is allowed, a replacement of the value is not', async () => {
    const sizeRule = strictMeta({ rules: { present: rule('size(self.properties.a) > 0', 'a must not be empty') } });
    const huge = 'x'.repeat(50_000);
    const existing = stored({ properties: { a: huge } });
    const before = ruleRows((await classify(sizeRule, null, write({ properties: { a: huge } }))).introduced);
    assert.equal(before.length, 1, 'the fixture: a value over the cap is a break on its own');
    assert.match(before[0].reason, /too large/i, before[0].reason);

    const unrelated = await classify(sizeRule, existing, write({ description: 'edited', properties: {} }));
    assert.deepEqual(fieldsOf(unrelated.preExisting), ['rules.present'], 'the arrived break is not pre-existing');
    assert.equal(unrelated.blocked, false, 'a stuffed record became uneditable');

    const replaced = await classify(sizeRule, existing, write({ properties: { a: `${huge}y` } }));
    assert.deepEqual(fieldsOf(replaced.introduced), ['rules.present'],
      'a stuffed record sheltered a new too-large value: the exemption is one any peer can hand out');
    assert.equal(replaced.blocked, true);

    const shrunk = await classify(sizeRule, existing, write({ properties: { a: 'small' } }));
    assert.deepEqual([fieldsOf(shrunk.introduced), fieldsOf(shrunk.preExisting), shrunk.blocked], [[], [], false], 'the repair passes');
  });
});

describe('the clause holds for every kind, and for space rules', () => {
  it('an edge, a fact and a chrono entry, each with its own classifier', async () => {
    const { writeValidation } = await evaluation();
    const m = (kind) => strictMeta({ kind, rules: { below: rule('self.properties.b < 100.0', BELOW) } });
    const cases = [
      { kind: 'edge', run: (existing, incoming) => writeValidation.classifyEdgeUpsertAgainst(m('edge'), existing, incoming),
        existing: recordOf.edge({ properties: { b: 500 } }), unrelated: { label: 'thing', description: 'edited' }, touching: { label: 'thing', properties: { b: 600 } } },
      { kind: 'fact', run: (existing, incoming) => writeValidation.classifyFactUpsertAgainst(m('fact'), existing, incoming),
        existing: recordOf.fact({ properties: { b: 500 } }), unrelated: { type: 'thing', tags: ['edited'] }, touching: { type: 'thing', properties: { b: 600 } } },
      { kind: 'chrono', run: (existing, incoming) => writeValidation.classifyChronoUpsertAgainst(m('chrono'), existing, incoming),
        existing: recordOf.chrono({ properties: { b: 500 } }), unrelated: { type: 'thing', description: 'edited' }, touching: { type: 'thing', properties: { b: 600 } } },
    ];
    for (const c of cases) {
      const unrelated = c.run(c.existing, c.unrelated);
      assert.equal(unrelated.blocked, false, `${c.kind}: an unrelated edit of a record that already breaks the rule was refused`);
      assert.deepEqual(fieldsOf(unrelated.preExisting), ['rules.below'], `${c.kind}: the unchanged break is not pre-existing`);
      const touching = c.run(c.existing, c.touching);
      assert.equal(touching.blocked, true, `${c.kind}: a write that replaces the property the rule reads was not refused`);
      assert.deepEqual(fieldsOf(touching.introduced), ['rules.below'], `${c.kind}`);
    }
  });

  it('a space rule is held to the same clause as a type rule', async () => {
    const m = { validationMode: 'strict', rules: { below: { ...rule('self.properties.b < 100.0', BELOW), kinds: ['entity'] } } };
    const unrelated = await classify(m, stored({ properties: { b: 500 } }), write({ description: 'edited', properties: {} }));
    assert.deepEqual(fieldsOf(unrelated.preExisting), ['meta.rules.below']);
    assert.equal(unrelated.blocked, false);
    const touching = await classify(m, stored({ properties: { b: 500 } }), write({ properties: { b: 600 } }));
    assert.deepEqual(fieldsOf(touching.introduced), ['meta.rules.below']);
    assert.equal(touching.blocked, true);
  });
});
