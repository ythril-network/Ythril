/**
 * A split's condition is judged by the rules judge and priced with the others of its split, never by a second compiler (Q-745, bundle-284
 * design r4 sections 1.3 and 1.4, finding S7).
 *
 * ## The defect this prevents
 *
 * `splitType` carries a CEL `when` per case. A condition that does not parse, reads a property the type does not declare, or answers
 * a number instead of true or false would be saved and then fail on every record the run reads. And the price: a split has up to twenty
 * cases, each evaluated against each record, so each case alone being under the rules budget says nothing about the twenty together.
 * Writing a second compiler or a second pricing for conditions would give the save and the run two answers to "can an instance apply this
 * text", which is the split decision 19 holds the schema package to: one analysis, in `schema/src/rules.ts`.
 *
 * ## What is held
 *
 * - `conditionIssues(kind, beforeTypeSchema, texts)` refuses a text the judge refuses, WITH the judge's words: a non-boolean `when`, an
 *   unparseable one, one that reads a property the before-type does not declare; each issue's path names the case.
 * - The cost of all the cases of one split is SUMMED against the rules budget: a split whose cases are each under it and together over it is
 *   refused, once, naming the budget; `conversionStepIssues` answers the same with the code `conditions_over_budget` at the step.
 * - Source gate: `conditionIssues` calls the one private `judge`, `conversion-steps.ts` holds no compiler of its own, and the package has one
 *   place that parses CEL.
 * - The run-time half (`evaluateCondition` in `server/src/spaces/schema-rules.ts` calls `programFor`; no other compile site there) is slice 2's
 *   and is a todo here until that slice fills it.
 *
 * Seen red on afb6eb8c: `schema/dist/internal.js` has no `conditionIssues` and no `conversionStepIssues`, so every behaviour case fails on that.
 *
 * Run: node --test testing/standalone/a-split-condition-is-judged-by-the-rules-judge.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import * as pkg from '../../schema/dist/internal.js';

const { conditionIssues, conversionStepIssues, typeRuleIssues } = pkg;

const BEFORE_PERSON = {
  propertySchemas: { name: { type: 'string' }, status: { type: 'string', enum: ['open', 'wip', 'done'] }, age: { type: 'number' } },
};
/** The judge's reason for `text` as a type rule of the before-type: the words a condition's refusal must carry. */
const judgesWords = (text) => {
  const issues = typeRuleIssues('entity', { ...BEFORE_PERSON, rules: { r: { rule: text, message: 'm' } } });
  return issues.filter(i => i.path.join('.') === 'rules.r').map(i => i.message.replace(/^rule 'r' /, ''));
};
const metaOf = (types) => ({ typeSchemas: { entity: types } });
const BEFORE = metaOf({ person: BEFORE_PERSON });
const AFTER = metaOf({ person: BEFORE_PERSON, activePerson: BEFORE_PERSON });
const splitOf = (whens) => ({
  op: 'splitType', kind: 'entity', from: 'person', cases: whens.map(when => ({ when, to: 'activePerson' })), otherwise: 'person',
});

/**
 * A condition that is under the budget alone and over it twice: one loop over a list the text builds by `+` (twenty-eight tags), a string built
 * the same way inside it, and a regex scan of that string, which the rules price at the size of what they scan. Twenty-eight is the size
 * at which the judge prices one such rule under the budget and two over it (the fixture case below holds that against the judge itself).
 */
const TWENTY_EIGHT = (piece) => Array(28).fill(piece).join(' + ');
const HEAVY = `(${TWENTY_EIGHT('self.tags')}).exists(t, (${TWENTY_EIGHT('t')}).matches("^a"))`;

describe('conditionIssues refuses what the rules judge refuses, in its words', () => {
  it('accepts a condition over a declared property, and none at all', () => {
    assert.deepEqual(conditionIssues('entity', BEFORE_PERSON, ['self.properties.status == "open"', 'self.properties.age > 3']), []);
    assert.deepEqual(conditionIssues('entity', BEFORE_PERSON, []), []);
  });

  it('refuses a non-boolean `when` with the judge\'s sentence, and names the case', () => {
    const text = 'self.properties.name';
    const words = judgesWords(text);
    assert.equal(words.length, 1, `fixture: the judge refuses ${JSON.stringify(text)} as a type rule once: ${JSON.stringify(words)}`);
    assert.match(words[0], /does not answer true or false/);
    const issues = conditionIssues('entity', BEFORE_PERSON, ['self.properties.status == "open"', text]);
    assert.equal(issues.length, 1);
    assert.deepEqual(issues[0].path, [1], 'the second case is the one refused');
    assert.ok(issues[0].message.includes(words[0]), `the message carries the judge's words: ${issues[0].message}`);
  });

  it('refuses a `when` that reads a property the before-type does not declare, and one that does not parse', () => {
    for (const text of ['self.properties.nickname == "x"', 'self.properties.status ==']) {
      const words = judgesWords(text);
      assert.ok(words.length > 0, `fixture: the judge refuses ${JSON.stringify(text)}`);
      const issues = conditionIssues('entity', BEFORE_PERSON, [text]);
      assert.ok(issues.length >= 1, text);
      assert.deepEqual(issues[0].path, [0]);
      for (const w of words) assert.ok(issues.some(i => i.message.includes(w)), `${text}: the judge says ${JSON.stringify(w)}`);
    }
  });

  it('reads the declared properties of the type it is given: the same text is refused for a type that does not declare them', () => {
    const text = 'self.properties.status == "open"';
    assert.deepEqual(conditionIssues('entity', BEFORE_PERSON, [text]), []);
    assert.ok(conditionIssues('entity', { propertySchemas: { name: { type: 'string' } } }, [text]).length > 0);
  });

  it('judges for the kind it is given: an edge has no title', () => {
    const edgeType = { propertySchemas: { since: { type: 'string' } } };
    assert.deepEqual(conditionIssues('edge', edgeType, ['self.label == "knows"']), []);
    assert.ok(conditionIssues('edge', edgeType, ['self.title == "x"']).length > 0);
  });
});

describe('the cost of a split\'s cases is summed against the budget', () => {
  it('fixture: the heavy condition is under the budget alone and over it twice (as the judge itself prices type rules)', () => {
    const asRules = (n) => typeRuleIssues('entity', {
      ...BEFORE_PERSON,
      rules: Object.fromEntries(Array.from({ length: n }, (_, i) => [`r${i}`, { rule: HEAVY, message: 'm' }])),
    }).map(i => i.message);
    assert.deepEqual(asRules(1), [], 'one is under the budget and judged fine');
    assert.ok(asRules(2).some(m => /cost budget/.test(m)), 'two are over it');
  });

  it('refuses cases each under the budget and together over it, once, naming the budget', () => {
    assert.deepEqual(conditionIssues('entity', BEFORE_PERSON, [HEAVY]), [], 'one case alone is accepted');
    const issues = conditionIssues('entity', BEFORE_PERSON, [HEAVY, HEAVY]);
    assert.equal(issues.length, 1, JSON.stringify(issues));
    assert.match(issues[0].message, /cost budget/);
    assert.deepEqual(issues[0].path, [], 'the refusal is about the split as a whole, not one case');
  });

  it('conversionStepIssues answers the same at the step: `conditions_over_budget`, for the over-budget split alone', () => {
    assert.deepEqual(conversionStepIssues([splitOf([HEAVY])], BEFORE, AFTER), [], 'one heavy case alone is accepted');
    const over = conversionStepIssues([splitOf([HEAVY, HEAVY])], BEFORE, AFTER);
    assert.ok(over.some(i => i.step === 0 && i.code === 'conditions_over_budget'), JSON.stringify(over));
    assert.ok(!over.some(i => i.code === 'condition_refused'), 'no case is refused by itself');
    const b = metaOf({ person: BEFORE_PERSON, company: BEFORE_PERSON });
    const a = metaOf({ person: BEFORE_PERSON, company: BEFORE_PERSON, activePerson: BEFORE_PERSON, activeCompany: BEFORE_PERSON });
    const second = { op: 'splitType', kind: 'entity', from: 'company', cases: [{ when: HEAVY, to: 'activeCompany' }, { when: HEAVY, to: 'activeCompany' }], otherwise: 'company' };
    const named = conversionStepIssues([splitOf([HEAVY]), second], b, a);
    assert.deepEqual(named.map(i => [i.step, i.code]), [[1, 'conditions_over_budget']], 'the budget is per split: the first split is not blamed for the second');
  });

  it('two splits that are each under the budget are accepted though together they are over it', () => {
    const b = metaOf({ person: BEFORE_PERSON, company: BEFORE_PERSON });
    const a = metaOf({ person: BEFORE_PERSON, company: BEFORE_PERSON, activePerson: BEFORE_PERSON, activeCompany: BEFORE_PERSON });
    const second = { op: 'splitType', kind: 'entity', from: 'company', cases: [{ when: HEAVY, to: 'activeCompany' }], otherwise: 'company' };
    assert.deepEqual(conversionStepIssues([splitOf([HEAVY]), second], b, a), []);
  });

  it('a `when` the judge refuses is a `condition_refused` at its step, with the judge\'s words', () => {
    const issues = conversionStepIssues([splitOf(['self.properties.name'])], BEFORE, AFTER);
    const own = issues.filter(i => i.code === 'condition_refused');
    assert.equal(own.length, 1, JSON.stringify(issues));
    assert.equal(own[0].step, 0);
    assert.ok(own[0].message.includes(judgesWords('self.properties.name')[0]));
  });
});

describe('the one judge, in the source', () => {
  const SRC = 'schema/src';
  const read = (file) => readFileSync(join(SRC, file), 'utf8').replace(/\r\n/g, '\n');
  const code = (file) => stripComments(read(file));

  /** The text of `export function name(...) { ... }`, to the first closing brace at the start of a line. */
  function bodyOf(src, name) {
    const at = src.indexOf(`export function ${name}(`);
    assert.ok(at >= 0, `${name} is declared as an exported function`);
    const end = src.indexOf('\n}\n', at);
    assert.ok(end > at, `${name} ends`);
    return src.slice(at, end);
  }

  it('`conditionIssues` calls the private `judge` and compiles nothing itself', () => {
    const body = bodyOf(code('rules.ts'), 'conditionIssues');
    assert.match(body, /\bjudge\(/, 'it asks the judge');
    assert.doesNotMatch(body, /\bcel\.|\bcompileRule\(|\bparsed\(|\bboolProblem\(|\banalyse\(/, 'it runs none of the judge\'s parts by hand');
    assert.doesNotMatch(read('rules.ts'), /export (const|function) judge\b/, 'the judge stays private: callers ask conditionIssues');
  });

  it('the cost it sums is the budget the rules sum against: one constant, used by both', () => {
    const src = code('rules.ts');
    const typeBody = bodyOf(src, 'typeRuleIssues');
    const conditionBody = bodyOf(src, 'conditionIssues');
    assert.match(typeBody, /COST_BUDGET/);
    assert.match(conditionBody, /COST_BUDGET/);
    assert.equal((src.match(/const COST_BUDGET\b/g) ?? []).length, 1, 'COST_BUDGET is declared once');
  });

  it('`conversion-steps.ts` holds no compile site and no second price', () => {
    const src = code('conversion-steps.ts');
    assert.doesNotMatch(src, /@bufbuild\/cel/, 'it does not import the engine');
    assert.doesNotMatch(src, /\bcel\.|\bcompileRule\b|\bruleEngine\b|\bcelEnv\b/);
    assert.match(src, /\bconditionIssues\b/, 'it asks the rules module about a condition');
    assert.doesNotMatch(src, /COST_BUDGET|10_000_000/, 'it keeps no budget of its own');
  });

  it('the package has one place that parses CEL: `rules.ts`', () => {
    const files = readdirSync(SRC).filter(f => f.endsWith('.ts'));
    const parsers = files.filter(f => /\bcel\.parse\(|from '@bufbuild\/cel'|import\('@bufbuild\/cel'\)/.test(code(f)));
    assert.deepEqual(parsers, ['rules.ts']);
    assert.equal((code('rules.ts').match(/\bcel\.parse\(/g) ?? []).length, 1, 'one parse call in the package');
  });

  it.todo('slice 2: `evaluateCondition` (server/src/spaces/schema-rules.ts) is built on `programFor`, and the server has no other compile site');
});
