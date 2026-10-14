/**
 * A rule the instance could never apply is refused when the schema is SAVED, where the author is standing (F-46).
 *
 * ## Why it is the save that decides
 *
 * A rule is stored, replicated to every member of a network and evaluated on every write of a strict space. One that does not
 * compile, names a property nobody declared, or answers something other than true/false does not fail once: it fails on every
 * write of its type, for ever, with a refusal that points at the record. `a-pattern-too-risky-to-run-is-refused-not-applied`
 * is the model — the refusal moves to save time so what remains at write time says which of the two happened.
 *
 * `@bufbuild/cel` gives parse and evaluation and nothing else (no exported checker, no cost estimate: ADR, R5-7), so the check
 * is ours and is what this file holds:
 *
 * | what is wrong | how it is caught |
 * |---|---|
 * | an unknown function | the rule does not compile / cannot run on any input |
 * | an invalid regex literal (`matches('(')`, a look-ahead RE2 does not have) | the literal is compiled at save |
 * | a regex pattern that is not a string literal | refused: `matches` accepts only literal patterns, so a record can never choose the regex |
 * | a result that is not a bool | evaluated across a SYNTHETIC SET of inputs: every referenced property present, all absent, and
 * |   | each referenced path on its own absent while the rest are present — 3 + 2 per path, LINEAR, never every combination |
 * | `self.from` / `self.to` on an edge rule (and any other field the kind's view lacks) | the reference check: an inline or bulk edge is validated before its ends exist |
 * | a type rule that reads a property its type does not declare | the reference check; a SPACE rule's `properties` is an open map |
 * | more than 200 AST nodes | counted on the parsed expression |
 * | a comprehension inside a comprehension | quadratic work: refused (nesting <= 1) |
 * | an APPLICABLE set whose priced cost is over the fixed budget | priced from the AST at save, deterministically — never from a clock |
 *
 * ## Why every refusal is asserted against a control
 *
 * Every row has the same rule written correctly accepted beside it. A check that refuses everything would pass every "refused"
 * assertion, and the base — which refuses every rule, as an unknown key — does exactly that for them.
 *
 * Run: node --test testing/standalone/a-cel-rule-is-checked-when-the-schema-is-saved.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rule, expressionOfNodes, manyRules, parseTypeRules, parseSpaceRules, refusedOnRules, accepted, issuesText,
  DECLARED, KINDS, andChain, SpaceMetaBody,
} from './_cel-rules.mjs';

/** One rule through the type door of `kind` and through the space door narrowed to `kind`: the same check, said twice. */
const both = (kind, expression, { propertySchemas = DECLARED } = {}) => [
  { door: `a ${kind} type rule`, result: parseTypeRules(kind, { r: rule(expression, 'must hold') }, propertySchemas) },
  { door: `a space rule for ${kind}`, result: parseSpaceRules({ r: { ...rule(expression, 'must hold'), kinds: [kind] } }) },
];

/** Assert `expression` is accepted by both doors of `kind`. */
const acceptsOn = (kind, expression, what = expression) => {
  for (const { door, result } of both(kind, expression)) accepted(assert, result, `${door}: ${what}`);
};

/** Assert `expression` is refused on `rules` by both doors of `kind`, and that the refusal says what is wrong. */
const refusesOn = (kind, expression, says, what = expression) => {
  for (const { door, result } of both(kind, expression)) {
    const rows = refusedOnRules(assert, result, `${door}: ${what}`);
    assert.match(JSON.stringify(rows), says, `${door}: the refusal does not say what is wrong (${says}): ${JSON.stringify(rows)}`);
  }
};

describe('a rule that is sound is accepted for every kind (the controls)', () => {
  const sound = {
    entity: [`self.properties.a == 'x'`, `self.title.matches('^[A-Z]')`, `size(self.description) <= 100`, `self.type == 'thing'`,
      `self.tags.all(t, t.size() > 0)`, `self.properties.b >= 0.0 && self.properties.b <= 100.0`],
    edge: [`self.label == 'thing'`, `self.properties.a != ''`, `size(self.description) <= 100`, `self.tags.all(t, t.size() > 0)`],
    fact: [`self.title.size() > 3`, `self.properties.a == 'x'`, `self.tags.exists(t, t == 'reviewed')`],
    chrono: [`self.title.matches('^[A-Z]')`, `self.properties.a == 'x'`, `self.type == 'thing'`],
  };
  for (const kind of KINDS) {
    it(`${kind}: the rules a person would write for it`, () => {
      for (const expression of sound[kind]) acceptsOn(kind, expression);
    });
  }

  it('a rule that tests presence and a rule that holds for every input are bool everywhere', () => {
    acceptsOn('entity', `has(self.properties.a) ? true : false`);
    acceptsOn('entity', `!has(self.properties.a) || self.properties.a == 'x'`);
  });
});

describe('a rule that does not compile or cannot run is refused', () => {
  it('an unknown function, as a call and as a method', () => {
    for (const expression of [`frobnicate(self.properties.a)`, `self.properties.a.frobnicate()`, `self.title.frobnicate() == 1`]) {
      refusesOn('entity', expression, /function|frobnicate|undeclared|unknown/i, expression);
    }
  });

  it('text that is not an expression at all', () => {
    for (const expression of ['self.properties.a ==', '((', `self.properties.a == 'unterminated`, '']) {
      for (const { door, result } of both('entity', expression)) {
        refusedOnRules(assert, result, `${door}: ${JSON.stringify(expression)}`);
      }
    }
  });

  it('a regex literal the linear engine cannot compile: an unbalanced group, an open class, a look-ahead, a back-reference', () => {
    for (const pattern of ['(', '[a-', '(?=a)b', '(a)\\\\1']) {
      refusesOn('entity', `self.properties.a.matches('${pattern}')`, /regex|pattern|matches|compile/i, `matches('${pattern}')`);
    }
    // The control that gives them meaning: a valid pattern in the same position is accepted.
    acceptsOn('entity', `self.properties.a.matches('^[a-z]+$')`);
    acceptsOn('entity', `matches(self.properties.a, '^[a-z]+$')`, 'the function form of matches');
  });

  it('a pattern that is not a string literal: a record cannot choose the regex that is run over it', () => {
    for (const expression of [
      `self.properties.a.matches(self.properties.a)`,
      `self.properties.a.matches('^' + self.properties.a)`,
      `matches(self.properties.a, self.title)`,
    ]) {
      refusesOn('entity', expression, /literal|pattern|matches/i, expression);
    }
  });

  it('a pattern RE2 refuses by size (a repeat above its limit) is refused at save, not found at the first write', () => {
    refusesOn('entity', `self.properties.a.matches('a{1001}')`, /regex|pattern|matches|compile|repeat/i, 'matches(a{1001})');
  });

  it('a pattern that backtracking engines choke on is ACCEPTED: the engine is linear, so it is only a pattern', () => {
    // The point of RE2 (and of this being `@bufbuild/cel` rather than a native-regex library). Refusing it at save would be
    // `hasReDoSRisk` all over again — a heuristic that turns away ordinary rules — and the runtime test proves it is safe.
    acceptsOn('entity', `self.properties.a.matches('(a+)+$')`);
  });
});

describe('a rule must answer true or false, on every input the save can think of', () => {
  it('a rule that is simply not a bool: a string, a number, a list, a map', () => {
    for (const expression of [`self.properties.a`, `1 + 2`, `self.properties.b`, `self.tags`, `size(self.title)`]) {
      refusesOn('entity', expression, /bool|true or false|boolean/i, expression);
    }
  });

  it('a rule that is a bool only for some inputs (`c ? true : \'x\'`) is caught by the all-absent input', () => {
    // With the property absent the condition is false and the answer is the string. Neither of the other inputs reaches it.
    refusesOn('entity', `has(self.properties.a) ? true : 'x'`, /bool|true or false|boolean/i);
    // And the same shape the other way round is fine: it is a bool whatever the condition says.
    acceptsOn('entity', `has(self.properties.a) ? true : false`);
  });

  it('a rule that is not a bool only when ONE of its paths is absent is caught, among thirty, in time (the set is linear)', { timeout: 30_000 }, () => {
    // 30 referenced paths. Checking every combination of present/absent is 2^30 evaluations — the save would never answer.
    // The set is 3 + 2 per path: the fault below is reachable only when p17 is absent and every other path is present, which is
    // one of the per-path inputs and neither of the three global ones.
    const paths = Array.from({ length: 30 }, (_, i) => `p${String(i + 1).padStart(2, '0')}`);
    const props = Object.fromEntries(paths.map(p => [p, { type: 'string' }]));
    const faultAt = (k) => `(!has(self.properties.${paths[k]}) && ${paths.filter((_, i) => i !== k).map(p => `has(self.properties.${p})`).join(' && ')}) ? 'x' : true`;
    const expression = faultAt(16);
    assert.ok(expression.length <= 1000, `the fixture itself is over the rule limit (${expression.length})`);
    const started = Date.now();
    const caught = parseTypeRules('entity', { r: rule(expression, 'one path absent') }, props);
    refusedOnRules(assert, caught, 'a rule that answers a string when exactly p17 is absent');
    // The control: the same thirty paths, a rule that is a bool for every input.
    const clean = parseTypeRules('entity', { r: rule(`${paths.map(p => `has(self.properties.${p})`).join(' && ')} ? true : false`, 'all') }, props);
    accepted(assert, clean, 'thirty paths, a bool for every input');
    assert.ok(Date.now() - started < 20_000, 'the save took longer than a linear set needs');
  });
});

describe('a rule reads only what its record has', () => {
  it('self.from and self.to are refused on an edge rule: an inline or bulk edge is validated before its ends exist', () => {
    for (const expression of [`self.from == 'x'`, `self.to != ''`, `self.from != self.to`]) {
      refusesOn('edge', expression, /from|to|self|field|declared/i, expression);
    }
    acceptsOn('edge', `self.label != ''`);
  });

  it('an edge has no title, and nothing has a field nobody declared', () => {
    refusesOn('edge', `self.title != ''`, /title|self|field|declared/i);
    for (const kind of KINDS) refusesOn(kind, `self.nosuchfield == 'x'`, /nosuchfield|self|field|declared/i, `${kind}: self.nosuchfield`);
    for (const kind of KINDS) refusesOn(kind, `other.properties.a == 'x'`, /other|variable|undeclared|self/i, `${kind}: a variable that is not self`);
  });

  it('a type rule may read only the properties its type declares', () => {
    const { result: onDeclared } = both('entity', `self.properties.a == 'x'`)[0];
    accepted(assert, onDeclared, 'a rule on a declared property');
    for (const expression of [`self.properties.nope == 'x'`, `has(self.properties.nope)`, `self.properties.a == 'x' && self.properties.nope == 1.0`]) {
      const result = parseTypeRules('entity', { r: rule(expression, 'reads nope') });
      const rows = refusedOnRules(assert, result, `a type rule: ${expression}`);
      assert.match(JSON.stringify(rows), /nope|declared|propert/i, `the refusal does not name the property: ${JSON.stringify(rows)}`);
    }
  });

  it('a type that declares no properties declares none to read', () => {
    refusedOnRules(assert, parseTypeRules('entity', { r: rule(`self.properties.a == 'x'`, 'm') }, {}), 'a rule on an undeclared property of a type with no property schemas');
    accepted(assert, parseTypeRules('entity', { r: rule(`self.title != ''`, 'm') }, {}), 'a rule that reads no property, on a type that declares none');
  });

  it('a SPACE rule reads properties as an open map: it governs types that declare their own', () => {
    accepted(assert, parseSpaceRules({ r: rule(`self.properties.anything_at_all == 'x'`, 'm') }), 'a space rule on a property no schema names');
  });

  it('a space rule that names a kind is held to that kind\'s view', () => {
    accepted(assert, parseSpaceRules({ r: { ...rule(`self.title != ''`, 'm'), kinds: ['entity'] } }), 'self.title for entities');
    refusedOnRules(assert, parseSpaceRules({ r: { ...rule(`self.title != ''`, 'm'), kinds: ['edge'] } }), 'self.title for edges, which have no title');
    refusedOnRules(assert, parseSpaceRules({ r: { ...rule(`self.from != ''`, 'm'), kinds: ['edge'] } }), 'self.from for edges');
  });
});

describe('the size of a rule', () => {
  it('200 AST nodes are accepted and 201 are refused', () => {
    accepted(assert, parseTypeRules('entity', { r: rule(expressionOfNodes(199)) }), '199 nodes');
    accepted(assert, parseTypeRules('entity', { r: rule(expressionOfNodes(200)) }), '200 nodes');
    const over = parseTypeRules('entity', { r: rule(expressionOfNodes(201)) });
    const rows = refusedOnRules(assert, over, '201 nodes');
    assert.match(JSON.stringify(rows), /200|node|complex|large|size/i, `the refusal does not say it is the size: ${JSON.stringify(rows)}`);
    // The same on the space door, so a bound written on one door only is the defect this file exists to catch.
    accepted(assert, parseSpaceRules({ r: rule(expressionOfNodes(200)) }), '200 nodes on a space');
    refusedOnRules(assert, parseSpaceRules({ r: rule(expressionOfNodes(201)) }), '201 nodes on a space');
  });

  it('the operands of a chain count once each, not once per comparison: 100 operands are the 199-node fixture', () => {
    // The fixture's own claim, so the boundary above is a boundary of what it says it is.
    assert.equal(andChain(100).split('&&').length, 100);
    assert.equal(andChain(101).split('&&').length, 101);
  });

  it('a comprehension may not contain a comprehension: one level is accepted, two are refused', () => {
    acceptsOn('entity', `self.tags.all(t, t.size() > 0)`);
    acceptsOn('entity', `self.tags.all(t, t.size() > 0) && self.tags.exists(t, t == 'reviewed')`, 'two comprehensions side by side');
    for (const expression of [
      `self.tags.all(a, self.tags.exists(b, a == b))`,
      `self.tags.map(a, self.tags.filter(b, b == a)).size() > 0`,
      `self.tags.exists_one(a, self.tags.all(b, b.size() >= a.size()))`,
    ]) {
      refusesOn('entity', expression, /comprehension|nest|quadratic|loop|depth/i, expression);
    }
  });
});

describe('the priced cost of an applicable set is bounded at save, deterministically', () => {
  /** The heaviest rule that fits the other limits: one comprehension over the tags, a regex on each. */
  const heavyRule = `self.tags.all(t, ${Array(35).fill(`t.matches('^[a-z]+$')`).join(' && ')})`;

  it('the fixture is a rule the other limits allow (so only the cost can refuse it)', () => {
    assert.ok(heavyRule.length <= 1000, `the heavy rule is ${heavyRule.length} characters`);
    accepted(assert, parseTypeRules('entity', { r: rule(heavyRule, 'each tag is lower-case') }), 'ONE heavy rule on its own');
  });

  it('fifty heavy rules on one type are over budget and refused; fifty light ones are not', () => {
    const heavy = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`h${i + 1}`, rule(heavyRule, `heavy ${i + 1}`)]));
    const rows = refusedOnRules(assert, parseTypeRules('entity', heavy), 'fifty maximal comprehension rules');
    assert.match(JSON.stringify(rows), /cost|budget|expensive|too (heavy|much)/i, `the refusal does not say it is the cost: ${JSON.stringify(rows)}`);
    accepted(assert, parseTypeRules('entity', manyRules(50)), 'fifty trivial rules');
  });

  it('the verdict is a function of the rules alone: the same set is refused the same way every time', () => {
    const heavy = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`h${i + 1}`, rule(heavyRule, `heavy ${i + 1}`)]));
    const answers = [1, 2, 3].map(() => issuesText(parseTypeRules('entity', heavy)));
    refusedOnRules(assert, parseTypeRules('entity', heavy), 'fifty maximal comprehension rules');
    assert.equal(answers[1], answers[0], 'the same rules were refused differently the second time: the price depends on something other than the rules');
    assert.equal(answers[2], answers[0]);
  });

  it('the set is the APPLICABLE one: fifty heavy rules are over budget whether they are the type\'s, the space\'s or a mix', () => {
    const typeRules = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`t${i + 1}`, rule(heavyRule, `type ${i + 1}`)]));
    const spaceRules = Object.fromEntries(Array.from({ length: 25 }, (_, i) => [`s${i + 1}`, { ...rule(heavyRule, `space ${i + 1}`), kinds: ['entity'] }]));
    const together = { typeSchemas: { entity: { thing: { propertySchemas: DECLARED, rules: typeRules } } }, rules: spaceRules };
    refusedOnRules(assert, SpaceMetaBody.safeParse(together), '25 + 25 heavy rules applicable to one entity type');
    // The same fifty, but the space ones name another kind: they are not applicable to this type, so they are not in ITS price.
    const elsewhere = Object.fromEntries(Object.entries(spaceRules).map(([k, v]) => [k, { ...v, kinds: ['edge'] }]));
    const apart = SpaceMetaBody.safeParse({ ...together, rules: elsewhere });
    const rows = JSON.stringify(issuesText(apart));
    assert.doesNotMatch(rows, /cost|budget/i, `rules for another kind were priced against this type: ${rows}`);
  });
});
