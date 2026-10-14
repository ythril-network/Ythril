/**
 * What a rule says about ONE record: match, violated, could-not-evaluate or too-large — and when it says nothing (F-46).
 *
 * ## The four outcomes, and the fifth that is silence
 *
 * | outcome | the row | what it must not do |
 * |---|---|---|
 * | match | none | |
 * | violated | `{ field: 'rules.<name>' }` (`'meta.rules.<name>'` for a space rule); `reason` = the rule's message, then a SHORT HASH of the rule text | |
 * | could not evaluate (a runtime error, or an answer that is not a bool, on THIS record) | the same field, a reason that says so | echo a value, or the engine's own message |
 * | too large to check (the input caps below) | the same field, a reason that says so | echo a value |
 * | the rule does not apply | none | |
 *
 * **The hash** is what makes a violation's identity `(field, reason)` for the introduced/pre-existing split: two rules that
 * share a message are two violations, and one rule whose TEXT is edited is a new violation — a rule that was tightened cannot
 * be sheltered by the record having failed its looser self.
 *
 * **Could-not-evaluate and too-large are violations**, not exemptions: a record the engine cannot judge is not a record the
 * schema vouches for. Their reasons are value-free (the error CLASS only): a refusal is shown to callers, written to logs
 * and recorded in sync history, and a value that was too large to check is exactly the one nobody should be quoting.
 *
 * **Input caps per evaluation**, counted in CODE POINTS on the paths the rule reads, not on the whole record: a string
 * of 10 000 code points, a list of 100, 200 properties. A record that is huge somewhere the rule does not look is not
 * too large for this rule.
 *
 * **Absent means not applicable.** A property the rule reads that the record does not have makes the rule not apply — not a
 * violation, not could-not-evaluate. That covers `properties` only: `title`, `type`, `description` and `tags` are always there.
 *
 * **`off` evaluates nothing**: no rule rows, and the evaluation counter does not move.
 *
 * ## Why this is red on the base
 *
 * The evaluation tests build the record's view with `recordViewOf` (`brain/record-view.ts`), which does not exist; they fail on
 * that import. The seam is the one every write goes through (`validateEntity|Edge|Fact|Chrono(meta, view)`), so what is proved
 * here is what a write door sees.
 *
 * Run: node --test testing/standalone/a-cel-rule-says-what-it-found-on-a-record.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, rule, strictMeta, recordOf, validateRecord, ruleRows, schemaRules,
} from './_cel-rules.mjs';

const escape = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/** What follows the message in a violated rule's reason: the short hash. */
const tailAfter = (reason, message) => reason.slice(reason.indexOf(message) + message.length);

const BELOW = 'b must be below one hundred';
const metaB = (mode = 'strict', kind = 'entity') => strictMeta({ kind, mode, rules: { below: rule('self.properties.b < 100.0', BELOW) } });

describe('a rule that holds says nothing; a rule that fails is one row on its own field', () => {
  it('match: a record that satisfies the rule has no rule row, and a record that does not has exactly one', async () => {
    const holds = await validateRecord(metaB(), 'entity', recordOf.entity({ properties: { b: 5 } }));
    assert.deepEqual(ruleRows(holds), [], `a record that satisfies the rule was reported: ${JSON.stringify(holds)}`);
    const fails = ruleRows(await validateRecord(metaB(), 'entity', recordOf.entity({ properties: { b: 500 } })));
    assert.equal(fails.length, 1, `a record that breaks the rule has ${fails.length} rule rows: ${JSON.stringify(fails)}`);
    assert.equal(fails[0].field, 'rules.below');
  });

  it('violated: the reason is the rule\'s own message followed by a short hash of the rule text', async () => {
    const [row] = ruleRows(await validateRecord(metaB(), 'entity', recordOf.entity({ properties: { b: 500 } })));
    assert.ok(row, 'no rule row');
    assert.ok(row.reason.startsWith(BELOW), `the reason does not lead with the message: ${row.reason}`);
    assert.match(tailAfter(row.reason, BELOW), /[0-9a-f]{6,}/, `no short hash after the message: ${row.reason}`);
  });

  it('the hash is the rule\'s identity: stable for the same text, different for different text, whatever the message', async () => {
    const reasonFor = async (expression, name = 'r') => {
      const meta = strictMeta({ rules: { [name]: rule(expression, 'same message') } });
      return ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { b: 500 } })))[0]?.reason;
    };
    const first = await reasonFor('self.properties.b < 100.0');
    assert.ok(first, 'no violation to compare');
    assert.equal(await reasonFor('self.properties.b < 100.0'), first, 'the same rule gave a different reason twice');
    assert.notEqual(await reasonFor('self.properties.b < 200.0'), first,
      'an edited rule gave the old reason: a record that broke the looser rule would shelter a break of the tighter one');
  });

  it('every kind carries its type rules: entity, edge, fact and chrono', async () => {
    for (const kind of KINDS) {
      const meta = strictMeta({ kind, rules: { below: rule('self.properties.b < 100.0', BELOW) } });
      const rows = ruleRows(await validateRecord(meta, kind, recordOf[kind]({ properties: { b: 500 } })));
      assert.deepEqual(rows.map(r => r.field), ['rules.below'], `${kind}: ${JSON.stringify(rows)}`);
    }
  });

  it('a space rule is reported on its own field, and applies to the kinds it names (all of them when it names none)', async () => {
    const spaceRules = {
      everywhere: rule(`self.properties.a != 'forbidden'`, 'a is forbidden'),
      factsOnly: { ...rule(`self.properties.a != 'forbidden'`, 'a is forbidden on facts'), kinds: ['fact'] },
    };
    for (const kind of KINDS) {
      const meta = { validationMode: 'strict', rules: spaceRules };
      const rows = ruleRows(await validateRecord(meta, kind, recordOf[kind]({ properties: { a: 'forbidden' } })));
      const expected = kind === 'fact' ? ['meta.rules.everywhere', 'meta.rules.factsOnly'] : ['meta.rules.everywhere'];
      assert.deepEqual(rows.map(r => r.field).sort(), expected, `${kind}: ${JSON.stringify(rows)}`);
    }
  });

  it('a record that fails two rules has two rows, and one that fails one rule of two has one', async () => {
    const meta = strictMeta({ rules: { one: rule('self.properties.b < 100.0', 'one'), two: rule(`self.properties.a != 'x'`, 'two') } });
    const both = ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { a: 'x', b: 500 } })));
    assert.deepEqual(both.map(r => r.field).sort(), ['rules.one', 'rules.two']);
    const one = ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { a: 'y', b: 500 } })));
    assert.deepEqual(one.map(r => r.field), ['rules.one']);
  });
});

describe('what `self` is, per kind', () => {
  const cases = [
    { kind: 'entity', expression: `self.title == 'Acme'`, holds: recordOf.entity({ name: 'Acme' }), breaks: recordOf.entity({ name: 'Other' }), says: 'an entity\'s title is its name' },
    { kind: 'fact', expression: `self.title == 'a fact'`, holds: recordOf.fact({ fact: 'a fact' }), breaks: recordOf.fact({ fact: 'another' }), says: 'a fact\'s title is its text' },
    { kind: 'chrono', expression: `self.title == 'An event'`, holds: recordOf.chrono({ title: 'An event' }), breaks: recordOf.chrono({ title: 'Other' }), says: 'a chrono entry\'s title is its title' },
    { kind: 'edge', expression: `self.label == 'thing'`, holds: recordOf.edge({ label: 'thing' }), breaks: recordOf.edge({ label: 'other' }), says: 'an edge has its label' },
    { kind: 'entity', expression: `self.description == 'described'`, holds: recordOf.entity({ description: 'described' }), breaks: recordOf.entity({ description: '' }), says: 'the description is read' },
    { kind: 'edge', expression: `self.tags.exists(t, t == 'reviewed')`, holds: recordOf.edge({ tags: ['reviewed'] }), breaks: recordOf.edge({ tags: [] }), says: 'an edge\'s tags are read' },
    { kind: 'fact', expression: `self.type == 'thing'`, holds: recordOf.fact({ type: 'thing' }), breaks: recordOf.fact({ type: 'other' }), says: 'the type is read' },
  ];
  for (const c of cases) {
    it(`${c.kind}: ${c.says}`, async () => {
      // Rules are stored under the type the record has, so the broken record is stored under its own type's rules too.
      const meta = { validationMode: 'strict', rules: { r: { ...rule(c.expression, 'must hold'), kinds: [c.kind] } } };
      assert.deepEqual(ruleRows(await validateRecord(meta, c.kind, c.holds)), [], `${c.expression} on the record that satisfies it`);
      assert.deepEqual(ruleRows(await validateRecord(meta, c.kind, c.breaks)).map(r => r.field), ['meta.rules.r'], `${c.expression} on the record that breaks it`);
    });
  }

  it('size() counts code points: three emoji are three, not six', async () => {
    const meta = { validationMode: 'strict', rules: { three: rule('size(self.title) == 3', 'three characters') } };
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ name: '😀😀😀' }))), []);
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ name: '😀😀😀😀' }))).map(r => r.field), ['meta.rules.three']);
  });

  it('strings are strings, dates included, and numbers are doubles: ISO dates compare as strings, 5 equals 5.0', async () => {
    const meta = strictMeta({
      rules: { before: rule(`self.properties.when < '2027-01-01'`, 'before 2027'), five: rule('self.properties.b == 5.0', 'b is five') },
      propertySchemas: { when: { type: 'date' }, b: { type: 'number' } },
    });
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { when: '2026-10-14', b: 5 } }))), []);
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { when: '2028-02-01', b: 6 } }))).map(r => r.field).sort(),
      ['rules.before', 'rules.five']);
  });
});

describe('absent means the rule does not apply', () => {
  it('a property the rule reads that the record lacks: no row, not a violation and not could-not-evaluate', async () => {
    const rows = ruleRows(await validateRecord(metaB(), 'entity', recordOf.entity({ properties: {} })));
    assert.deepEqual(rows, [], `an absent property was reported: ${JSON.stringify(rows)}`);
    // The control that gives the silence meaning: the same rule applies the moment the property is there.
    assert.equal(ruleRows(await validateRecord(metaB(), 'entity', recordOf.entity({ properties: { b: 500 } }))).length, 1);
  });

  it('a rule over two properties does not apply while either is absent', async () => {
    const meta = strictMeta({ rules: { pair: rule('self.properties.b < 100.0 && self.properties.a != \'x\'', 'pair') } });
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { b: 500 } }))), [], 'a was absent');
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { a: 'x' } }))), [], 'b was absent');
    assert.equal(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { a: 'x', b: 500 } }))).length, 1, 'both present');
  });

  it('it is properties only: a description that is empty is a description, and the rule applies', async () => {
    const meta = strictMeta({ rules: { described: rule('size(self.description) > 0', 'needs a description') } });
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ description: '' }))).map(r => r.field), ['rules.described']);
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ description: 'yes' }))), []);
  });

  it('a rule that reads no property applies to every record', async () => {
    const meta = strictMeta({ rules: { named: rule(`self.title != 'Acme'`, 'not Acme') } });
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ name: 'Acme', properties: {} }))).map(r => r.field), ['rules.named']);
  });
});

describe('a rule that could not be evaluated says so, and says nothing of the record', () => {
  const SECRET = 'sk-live-never-print-this-value';

  it('a runtime error on this record: a string where the rule compares a number', async () => {
    const rows = ruleRows(await validateRecord(metaB(), 'entity', recordOf.entity({ properties: { b: SECRET } })));
    assert.equal(rows.length, 1, `a rule that could not run on the record has ${rows.length} rows: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].field, 'rules.below');
    assert.match(rows[0].reason, /could not (be )?evaluate/i, `the reason does not say the rule could not be evaluated: ${rows[0].reason}`);
    assert.doesNotMatch(JSON.stringify(rows[0]), new RegExp(escape(SECRET)), 'the row quotes the record\'s value');
    assert.doesNotMatch(rows[0].reason, /overload|no such|found no matching/i, 'the row quotes the engine\'s own message');
  });

  it('an answer that is not a bool on this record: the rule is a bool for every input the save tried and a number for this one', async () => {
    const meta = strictMeta({ rules: { odd: rule(`self.properties.a == 'magic-value-x1' ? 1 : true`, 'odd') } });
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { a: 'ordinary' } }))), []);
    const rows = ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { a: 'magic-value-x1' } })));
    assert.equal(rows.length, 1, JSON.stringify(rows));
    assert.match(rows[0].reason, /could not (be )?evaluate/i, rows[0].reason);
    assert.doesNotMatch(JSON.stringify(rows[0]), /magic-value-x1/, 'the row quotes the record\'s value');
  });

  it('could-not-evaluate is a violation, so it is a row under warn as it is under strict', async () => {
    for (const mode of ['strict', 'warn']) {
      const rows = ruleRows(await validateRecord(metaB(mode), 'entity', recordOf.entity({ properties: { b: SECRET } })));
      assert.equal(rows.length, 1, `${mode}: ${JSON.stringify(rows)}`);
    }
  });
});

describe('a record too large for the rule to read is too large to check', () => {
  const astral = (n) => '😀'.repeat(n);
  const stringRule = strictMeta({ rules: { shortish: rule('size(self.properties.a) > 0', 'a must not be empty') } });

  it('a string of 10 000 code points is read (it is 20 000 UTF-16 units: the cap is code points); 10 001 is too large', async () => {
    assert.deepEqual(ruleRows(await validateRecord(stringRule, 'entity', recordOf.entity({ properties: { a: astral(10_000) } }))), [],
      'a string of exactly the cap was refused');
    const rows = ruleRows(await validateRecord(stringRule, 'entity', recordOf.entity({ properties: { a: astral(10_001) } })));
    assert.equal(rows.length, 1, `10 001 code points: ${JSON.stringify(rows).slice(0, 300)}`);
    assert.match(rows[0].reason, /too large/i, rows[0].reason);
    assert.ok(JSON.stringify(rows[0]).length < 1000, 'the row carries the large value');
  });

  it('a list of 100 is read; 101 is too large — the tags are a list the rule reads', async () => {
    const meta = strictMeta({ rules: { tagged: rule('self.tags.size() >= 0', 'tags are countable') } });
    const tags = (n) => Array.from({ length: n }, (_, i) => `t${i}`);
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ tags: tags(100) }))), []);
    const rows = ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ tags: tags(101) })));
    assert.equal(rows.length, 1, JSON.stringify(rows).slice(0, 300));
    assert.match(rows[0].reason, /too large/i, rows[0].reason);
  });

  it('200 properties are read by a rule that reads the whole map; 201 are too large', async () => {
    const meta = { validationMode: 'strict', rules: { counted: { ...rule('size(self.properties) >= 0', 'countable'), kinds: ['entity'] } } };
    const props = (n) => Object.fromEntries(Array.from({ length: n }, (_, i) => [`p${i}`, i]));
    assert.deepEqual(ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: props(200) }))), []);
    const rows = ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: props(201) })));
    assert.equal(rows.length, 1, JSON.stringify(rows).slice(0, 300));
    assert.match(rows[0].reason, /too large/i, rows[0].reason);
  });

  it('the caps are counted on the paths the rule reads: a huge value elsewhere does not make THIS rule too large', async () => {
    const meta = strictMeta({ rules: { below: rule('self.properties.b < 100.0', BELOW) } });
    const rows = ruleRows(await validateRecord(meta, 'entity', recordOf.entity({ properties: { a: astral(50_000), b: 5 } })));
    assert.deepEqual(rows, [], `a rule that reads b was blamed for what a holds: ${JSON.stringify(rows).slice(0, 300)}`);
  });
});

describe('a space that is off evaluates no rule', () => {
  const violating = recordOf.entity({ properties: { b: 500 } });

  it('off: no rule row, however broken the record', async () => {
    assert.deepEqual(ruleRows(await validateRecord(metaB('off'), 'entity', violating)), []);
  });

  it('off: the engine is not run at all — the evaluation counter does not move; strict and warn move it', async () => {
    const { ruleEvaluationCount } = await schemaRules();
    const moved = async (mode) => {
      const before = ruleEvaluationCount();
      await validateRecord(metaB(mode), 'entity', violating);
      return ruleEvaluationCount() - before;
    };
    assert.equal(await moved('off'), 0, 'rules were evaluated in a space whose validation is off');
    assert.ok(await moved('strict') > 0, 'the control: strict never evaluated the rule, so the counter proves nothing');
    assert.ok(await moved('warn') > 0, 'warn never evaluated the rule');
  });
});
