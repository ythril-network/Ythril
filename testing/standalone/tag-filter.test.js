/**
 * Single-tag search: case-insensitive SUBSTRING, applied the same way by every record type.
 *
 * Tag search used to require the whole tag, so typing "arch" found nothing on a record tagged
 * `architecture`. That presents as "no results" rather than "keep typing" — the tag was unfindable
 * unless you already knew it exactly, which defeats the point of a search box.
 *
 * The five record types had also drifted into five different answers to "what is a tag match":
 * memories used an anchored case-insensitive regex, entities/file-meta/edges used exact
 * case-SENSITIVE equality, and chrono used `$all`. The same query behaved differently per tab and only
 * one tab ignored case.
 *
 * The structural half of this file matters as much as the unit half: a shared helper that four of five
 * call sites use is not a fix. It has to be all five, and a sixth site added later has to be visible.
 *
 * Run: node --test testing/standalone/tag-filter.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

let tagContains;

before(async () => {
  ({ tagContains } = await import('../../server/dist/brain/tag-filter.js'));
});

describe('tagContains', () => {
  it('matches a partial word — the reported bug', () => {
    const m = tagContains('arch');
    assert.match('architecture', new RegExp(m.$regex, m.$options));
  });

  it('matches regardless of case', () => {
    const m = tagContains('ARCH');
    assert.match('architecture', new RegExp(m.$regex, m.$options));
    assert.equal(m.$options, 'i');
  });

  it('still matches the whole tag', () => {
    const m = tagContains('architecture');
    assert.match('architecture', new RegExp(m.$regex, m.$options));
  });

  it('matches in the middle and at the end, not just as a prefix', () => {
    for (const needle of ['chitect', 'ture']) {
      const m = tagContains(needle);
      assert.match('architecture', new RegExp(m.$regex, m.$options), `"${needle}" should hit`);
    }
  });

  it('does not match an unrelated tag', () => {
    const m = tagContains('arch');
    assert.doesNotMatch('database', new RegExp(m.$regex, m.$options));
  });

  it('is UNANCHORED — the anchors were the bug, so pin their absence', () => {
    const m = tagContains('arch');
    assert.ok(!m.$regex.startsWith('^'), 'a leading ^ restores whole-tag matching');
    assert.ok(!m.$regex.endsWith('$'), 'a trailing $ restores whole-tag matching');
  });

  it('escapes the user input — this is a raw string going into a regex', () => {
    // Same injection/ReDoS route already closed on the chrono `?search=` filter. A crafted value must
    // become a literal, not a pattern.
    const m = tagContains('(a+)+$');
    const re = new RegExp(m.$regex, m.$options);
    assert.match('literal (a+)+$ tag', re, 'the metacharacters must match literally');
    assert.doesNotMatch('aaaaaaaa', re, 'the input must not act as a quantifier');
  });

  it('treats a dot as a literal, not "any character"', () => {
    const m = tagContains('a.c');
    const re = new RegExp(m.$regex, m.$options);
    assert.match('a.c', re);
    assert.doesNotMatch('abc', re, 'an unescaped dot would match this');
  });
});

describe('every single-tag call site uses the shared helper', () => {
  // Derived from the source, not asserted as a count: a count passes with a site still using the old
  // exact match, which is exactly the gap that shipped in #480 and had to be fixed in #481.
  const SITES = [
    ['server/src/api/brain/_shared.ts', 'facts'],
    ['server/src/api/brain/entities.ts', 'entities'],
    ['server/src/api/brain/file-meta.ts', 'file meta'],
    ['server/src/brain/edges.ts', 'edges'],
    ['server/src/brain/chrono.ts', 'chrono'],
  ];

  for (const [file, label] of SITES) {
    it(`${label} (${file}) matches tags via tagContains`, () => {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert.ok(src.includes('tagContains'), `${file} must use the shared matcher`);
    });
  }

  it('no call site still builds an anchored whole-tag regex', () => {
    for (const [file] of SITES) {
      const src = readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8');
      assert.ok(
        !/\$regex:\s*`\^\$\{escapeRegex\(tag\)\}\$`/.test(src),
        `${file} still anchors its tag regex — partial search will not hit there`,
      );
    }
  });

  it('the plural tags/tagsAny params keep their exact set semantics', () => {
    // Integrations select an exact set with these; widening them to substring would over-match
    // silently. Only the singular `?tag=` box changed.
    const src = readFileSync(new URL('../../server/src/brain/chrono.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('$all: filter.tags'), 'tags (AND) must still be an exact $all');
    assert.ok(src.includes('$in: filter.tagsAny'), 'tagsAny (OR) must still be an exact $in');
  });
});
