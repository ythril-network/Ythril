/**
 * The shape and the limits of a CEL rule, at N and at N+1 (F-46).
 *
 * ## What is held
 *
 * A type schema may carry `rules: { <name>: { rule, message } }` and a space `meta.rules: { <name>: { rule, message, kinds? } }`.
 * Every bound below is a number a caller can hit, so each is asserted on BOTH sides of the line: the bound itself is accepted
 * (an off-by-one that refuses a legal rule is a worse bug than one that admits a long one) and one past it is refused with a
 * refusal that is ABOUT `rules` — a refusal for some other reason (an unlisted key, which is what the strict body says today)
 * would otherwise pass every "refused" assertion by accident.
 *
 * | bound | N | N+1 |
 * |---|---|---|
 * | rule name | a lower-case letter then letters, digits, `_` and `-`: 1 to 64 characters | 65 characters, a capital or a digit first, a space, a dot |
 * | names that are not names | | `constructor`, `prototype`, `__proto__`, `toString`, `hasOwnProperty`, `valueOf` |
 * | rule text | 1000 characters | 1001 |
 * | message | 300 characters | 301 |
 * | rules on one type | 50 | 51 |
 * | rules on a space | 50 | 51 |
 * | rules APPLICABLE to one type (its own plus the space's that name its kind) | 50 | 51, refused when the meta is saved |
 *
 * The prototype names are refused by name, not by the pattern: `toString`, `hasOwnProperty` and `valueOf` all fit the pattern,
 * and a rules map is read by key (`rules[name]`), so one of them would answer from `Object.prototype` instead of from the map.
 * `__proto__` is built as an OWN key (an object literal's `__proto__` sets a prototype and tests nothing).
 *
 * ## Why this is red on the base
 *
 * `TypeSchemaZ`, `SpaceMetaBody` and `PutSchemaBody` are `.strict()` and declare no `rules`, so every accepted-at-N assertion
 * fails with `unrecognized_keys` today; the N+1 assertions are written to fail on the issue PATH as well (see
 * `refusedOnRules`), so they cannot pass for that reason once the field exists but its bound does not.
 *
 * Run: node --test testing/standalone/a-cel-rule-is-bounded-where-it-is-saved.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  KINDS, rule, ruleOfLength, manyRules, ownKeyed, parseTypeRules, parseSpaceRules, refusedOnRules, accepted,
  SpaceMetaBody, DECLARED, typeSchemasOf,
} from './_cel-rules.mjs';

/** Both places a rule can live, so each bound is asserted on both without writing it twice. */
const LEVELS = [
  { level: 'a type', parse: (rules) => parseTypeRules('entity', rules) },
  { level: 'a space', parse: (rules) => parseSpaceRules(rules) },
];

describe('a rule name', () => {
  const ok = rule(`self.properties.a == 'x'`);
  for (const { level, parse } of LEVELS) {
    it(`on ${level}: 1 to 64 characters of the pattern are accepted, 65 are refused`, () => {
      accepted(assert, parse({ a: ok }), 'one character');
      accepted(assert, parse({ [`a${'b'.repeat(63)}`]: ok }), '64 characters');
      accepted(assert, parse({ 'aB_c-9': ok }), 'mixed case, digit, underscore and hyphen after the first letter');
      refusedOnRules(assert, parse({ [`a${'b'.repeat(64)}`]: ok }), '65 characters');
    });

    it(`on ${level}: a name must start with a lower-case letter and hold only the pattern's characters`, () => {
      for (const name of ['Abc', '1abc', '_abc', '-abc', 'a b', 'a.b', 'a/b', 'a$b', 'ünï']) {
        refusedOnRules(assert, parse({ [name]: ok }), `the name ${JSON.stringify(name)}`);
      }
      refusedOnRules(assert, parse({ '': ok }), 'the empty name');
    });

    it(`on ${level}: the names Object.prototype answers to are refused, though three of them fit the pattern`, () => {
      for (const name of ['constructor', 'prototype', '__proto__', 'toString', 'hasOwnProperty', 'valueOf']) {
        refusedOnRules(assert, parse(ownKeyed(name, ok)), `the name ${name}`);
      }
      // The control that makes the refusals mean something: a name that merely CONTAINS one is a name.
      accepted(assert, parse({ constructorName: ok, myToString: ok }), 'a name that contains a prototype name');
    });
  }
});

describe('the rule text and the message', () => {
  for (const { level, parse } of LEVELS) {
    it(`on ${level}: the rule is accepted at 1000 characters and refused at 1001`, () => {
      accepted(assert, parse({ r: rule(ruleOfLength(1000)) }), 'a rule of 1000 characters');
      refusedOnRules(assert, parse({ r: rule(ruleOfLength(1001)) }), 'a rule of 1001 characters');
    });

    it(`on ${level}: the message is accepted at 300 characters and refused at 301`, () => {
      accepted(assert, parse({ r: rule(`self.properties.a == 'x'`, 'm'.repeat(300)) }), 'a message of 300 characters');
      refusedOnRules(assert, parse({ r: rule(`self.properties.a == 'x'`, 'm'.repeat(301)) }), 'a message of 301 characters');
    });

    it(`on ${level}: a rule is an object of exactly its keys — a missing rule, a missing message or an extra key is refused`, () => {
      refusedOnRules(assert, parse({ r: { message: 'no rule' } }), 'a rule with no expression');
      refusedOnRules(assert, parse({ r: { rule: `self.properties.a == 'x'` } }), 'a rule with no message');
      refusedOnRules(assert, parse({ r: { ...rule(`self.properties.a == 'x'`), severity: 'high' } }), 'a rule with a key nobody declared');
      refusedOnRules(assert, parse({ r: `self.properties.a == 'x'` }), 'a bare string instead of {rule, message}');
    });
  }
});

describe('how many rules', () => {
  it('a type holds 50 and refuses 51', () => {
    accepted(assert, parseTypeRules('entity', manyRules(50)), '50 rules on one type');
    refusedOnRules(assert, parseTypeRules('entity', manyRules(51)), '51 rules on one type');
  });

  it('a space holds 50 and refuses 51', () => {
    accepted(assert, parseSpaceRules(manyRules(50)), '50 rules on a space');
    refusedOnRules(assert, parseSpaceRules(manyRules(51)), '51 rules on a space');
  });

  it('the limit is per type: two types of 50 each are two legal types', () => {
    const both = {
      entity: {
        one: { propertySchemas: DECLARED, rules: manyRules(50, { prefix: 'one' }) },
        two: { propertySchemas: DECLARED, rules: manyRules(50, { prefix: 'two' }) },
      },
    };
    const parsed = SpaceMetaBody.safeParse({ typeSchemas: both });
    accepted(assert, parsed, 'two types of 50 rules each');
  });

  it('what is APPLICABLE to one type is bounded too: its own rules plus the space rules that name its kind', () => {
    // 30 + 20 = 50 applicable: legal. 30 + 21 = 51: refused when the meta is saved — never truncated at write time.
    const types = (n) => typeSchemasOf('entity', 'thing', manyRules(n, { prefix: 't' }));
    accepted(assert, SpaceMetaBody.safeParse({ typeSchemas: types(30), rules: manyRules(20, { prefix: 's' }) }), '30 type + 20 space rules');
    refusedOnRules(assert, SpaceMetaBody.safeParse({ typeSchemas: types(30), rules: manyRules(21, { prefix: 's' }) }),
      '30 type + 21 space rules, all of them applying to an entity');
  });

  it('a space rule that names other kinds does not count against a type of a kind it does not name', () => {
    const types = typeSchemasOf('entity', 'thing', manyRules(30, { prefix: 't' }));
    const forEdges = Object.fromEntries(Object.entries(manyRules(21, { prefix: 's' })).map(([k, v]) => [k, { ...v, kinds: ['edge'] }]));
    accepted(assert, SpaceMetaBody.safeParse({ typeSchemas: types, rules: forEdges }),
      '30 entity-type rules and 21 space rules that apply to edges only');
  });
});

describe('the kinds a space rule names', () => {
  const r = rule(`self.properties.a == 'x'`);
  it('each knowledge type, singular, is accepted, and several together', () => {
    for (const kind of KINDS) accepted(assert, parseSpaceRules({ r: { ...r, kinds: [kind] } }), `kinds: [${kind}]`);
    accepted(assert, parseSpaceRules({ r: { ...r, kinds: ['entity', 'fact'] } }), 'two kinds');
  });

  it('a plural, an unknown name and a non-list are refused', () => {
    for (const kinds of [['entities'], ['person'], 'entity', [7]]) {
      refusedOnRules(assert, parseSpaceRules({ r: { ...r, kinds } }), `kinds: ${JSON.stringify(kinds)}`);
    }
  });

  it('a TYPE rule has no `kinds`: the kind is the collection it sits under', () => {
    refusedOnRules(assert, parseTypeRules('entity', { r: { ...r, kinds: ['entity'] } }), 'a type rule that names kinds');
  });
});
