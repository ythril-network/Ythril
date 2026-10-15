/**
 * A CEL rule is priced at save by what it can make an evaluation DO, and that includes what it BUILDS (F-46, bundle-23 pre-ship).
 *
 * ## What is held
 *
 * The input a rule reads is capped (a list of 100, a string of 10 000 code points), and the save-time price of a loop or a scan
 * assumed those caps for what the loop runs over. A rule can make a list or a string of its own by `+` — `self.tags + self.tags + ...`,
 * dozens of times inside the 200-part limit — and loop over it or scan it: neither is capped, and `@bufbuild/cel` has no run-time cost
 * limit and no interrupt, so the price at save is the only bound there is. The price therefore follows the SIZE of each value:
 *
 * - a loop over a built list costs per element of what it runs over, so the same body is dearer over `self.tags + self.tags + ...`
 *   than over `self.tags`;
 * - a scan (`matches`, `contains`, `startsWith`, `endsWith`) costs by the size of the text it scans, so a scan of a string built by
 *   `+` is dearer than the scan of one read;
 * - what an ordinary rule costs is not changed: the same set built from reads alone is accepted, which is the control each case holds
 *   beside it (a refusal that also hits the control is the node limit or the shape, not the price).
 *
 * Each case fixes the same number of rules on both sides, so only what the rule builds differs between accepted and refused. The
 * rules' other limits are asserted, so only the cost can be what refuses.
 *
 * Run: node --test testing/standalone/a-cel-rule-is-priced-by-what-it-builds.test.js
 * (requires a prior `npm run build --workspace=server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  rule, parseTypeRules, parseSpaceRules, refusedOnRules, accepted, issuesText,
} from './_cel-rules.mjs';

const repeat = (n, text) => Array(n).fill(text).join(' + ');
const REGEX = `'^[a-z]+$'`;
const COST_WORDS = /cost|budget/i;

/** `count` copies of one rule, as a rules map. */
const copies = (count, expression, prefix = 'r') =>
  Object.fromEntries(Array.from({ length: count }, (_, i) => [`${prefix}${i + 1}`, rule(expression, `${prefix} ${i + 1} failed`)]));

/** The expression must fit the other limits, so that only the price can refuse it. */
const fits = (expression) => {
  assert.ok(expression.length <= 1000,`the fixture is ${expression.length} characters: over the rule limit, so a refusal would be for length`);
  return expression;
};

/** A loop of ten regex tests over `range`. */
const loopOver = (range, tests = 10) => `(${range}).all(t, ${Array(tests).fill(`t.matches(${REGEX})`).join(' && ')})`;

/** What a refusal for the price says, for one set of rules on one type. */
const refusedForPrice = (rules, what) => {
  const rows = refusedOnRules(assert, parseTypeRules('entity', rules), what);
  assert.match(JSON.stringify(rows), COST_WORDS, `${what}: refused, but not for the cost: ${JSON.stringify(rows)}`);
};

describe('a loop over a list the rule built is priced by that list', () => {
  const built = fits(loopOver(repeat(40, 'self.tags')));
  const read = fits(loopOver('self.tags'));

  it('the same ten-regex loop over the tags as they are read: fifty of them are accepted (the control)', () => {
    accepted(assert, parseTypeRules('entity', copies(50, read)), 'fifty loops over self.tags');
  });

  it('one loop over forty concatenated copies of the tags is a rule the other limits allow', () => {
    accepted(assert, parseTypeRules('entity', copies(1, built)), 'ONE loop over a built list');
  });

  it('three of them are over the budget: the loop is priced for the list it runs over, not for one read of it', () => {
    refusedForPrice(copies(3, built), 'three loops over a list of forty concatenated copies of the tags');
  });

  it('the same holds on a space rule (the set that applies to a kind is priced alike)', () => {
    const rows = refusedOnRules(assert, parseSpaceRules(copies(3, built)), 'three space rules over a built list');
    assert.match(JSON.stringify(rows), COST_WORDS, `refused, but not for the cost: ${JSON.stringify(rows)}`);
  });

  it('the larger branch of a ternary is the size of the result', () => {
    const viaTernary = fits(loopOver(`self.title == 'x' ? ${repeat(40, 'self.tags')} : self.tags`));
    accepted(assert, parseTypeRules('entity', copies(1, viaTernary)), 'ONE loop over a ternary');
    refusedForPrice(copies(3, viaTernary), 'three loops over a list that is built in one branch of a ternary');
  });

  it('a list filtered out of a built list is as big as the list it came from, so the loop over it is priced for that',() => {
    const indexed = fits(loopOver(`(${repeat(40, 'self.tags')}).filter(x, x.size() > 0)`));
    accepted(assert, parseTypeRules('entity', copies(1, indexed)), 'ONE loop over a filtered built list');
    refusedForPrice(copies(3, indexed), 'three loops over a filtered built list');
  });
});

describe('a scan of text the rule built is priced by the size it built', () => {
  const built = fits(`self.tags.all(t, (${repeat(30, 'self.description')}).matches(${REGEX}))`);
  const read = fits(`self.tags.all(t, self.description.matches(${REGEX}))`);

  it('the scan of the description as it is read, inside a loop: fifty of them are accepted (the control)', () => {
    accepted(assert, parseTypeRules('entity', copies(50, read)), 'fifty scans of one read');
  });

  it('one scan of thirty concatenated copies is a rule the other limits allow', () => {
    accepted(assert, parseTypeRules('entity', copies(1, built)), 'ONE scan of a built string');
  });

  it('fifty of them are over the budget: the scan is priced for the text it scans', () => {
    refusedForPrice(copies(50, built), 'fifty scans of a string of thirty concatenated copies of the description');
  });

  it('the scans that are not regexes are priced the same way: contains, startsWith and endsWith', () => {
    for (const fn of ['contains', 'startsWith', 'endsWith']) {
      const heavy = fits(`self.tags.all(t, ${Array(35).fill(`t.${fn}('a')`).join(' && ')})`);
      accepted(assert, parseTypeRules('entity', copies(1, heavy)), `ONE loop of 35 ${fn} tests`);
      refusedForPrice(copies(50, heavy), `fifty loops of 35 ${fn} tests`);
    }
  });
});

describe('a loop over a map the rule reads is priced for the map, which holds more than a list does', () => {
  // `self.properties` is capped at 200 entries and a list at 100, so a loop over the properties visits twice what one over the tags does.
  // Fifteen regex tests per loop, fifty rules: within the budget at 100 per element, over it at 200.
  const overMap = fits(`self.properties.all(k, ${Array(15).fill(`k.matches(${REGEX})`).join(' && ')})`);
  const overList = fits(`self.tags.all(t, ${Array(15).fill(`t.matches(${REGEX})`).join(' && ')})`);

  it('the same loop over the tags: fifty of them are accepted (the control)', () => {
    accepted(assert, parseTypeRules('entity', copies(50, overList)), 'fifty loops over self.tags');
  });

  it('one loop over the properties is a rule the other limits allow', () => {
    accepted(assert, parseTypeRules('entity', copies(1, overMap)), 'ONE loop over self.properties');
  });

  it('fifty of them are over the budget: the properties hold up to 200 entries, and the loop is priced for that', () => {
    refusedForPrice(copies(50, overMap), 'fifty loops over self.properties');
    const rows = refusedOnRules(assert, parseSpaceRules(copies(50, overMap)), 'fifty space rules looping over self.properties');
    assert.match(JSON.stringify(rows), COST_WORDS, `refused, but not for the cost: ${JSON.stringify(rows)}`);
  });

  it('indexing the map by name reads it whole alike', () => {
    const indexed = fits(overMap.replace('self.properties', `self['properties']`));
    refusedForPrice(copies(50, indexed), `fifty loops over self['properties']`);
  });
});

describe('what an ordinary rule costs is not changed', () => {
  it('a loop with a regex on each tag, a scan of the title and a comparison of two properties are accepted together, fifty times', () => {
    const ordinary = `self.tags.all(t, t.matches(${REGEX})) && self.title.startsWith('a') && self.properties.a == self.properties.a`;
    accepted(assert, parseTypeRules('entity', copies(50, ordinary)), 'fifty ordinary rules');
  });

  it('a string put together from a few reads is as cheap as it looks', () => {
    const joined = `(self.title + ' ' + self.description).matches(${REGEX})`;
    accepted(assert, parseTypeRules('entity', copies(50, joined)), 'fifty scans of a title and a description joined');
    assert.equal(issuesText(parseTypeRules('entity', copies(50, joined))), '[]');
  });
});
