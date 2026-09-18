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
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { FILTER_DOORS } from '../_shared/search-doors.mjs';

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
  /*
   * THE SITES ARE NO LONGER FIVE FILES, and this block used to name them.
   *
   * Five hand-written paths, each asserted to contain `tagContains`, was the right gate while five
   * routes each assembled their own list filter. They now go through `conveniencePredicate`, so the
   * matcher is reached once — and a list of five names would have gone green on a sixth route that
   * never appeared in it, which is the failure mode `CLAUDE.md` calls *a gate concluding about more
   * than it checks*.
   *
   * So the rule is stated forwards: ONE module answers "what is a tag match", and nothing anywhere in
   * the tree answers it a second time with an anchored regex.
   */
  const CONVENIENCES = 'server/src/brain/list-conveniences.ts';

  it('the one module that assembles list filters matches tags via tagContains', () => {
    const src = readFileSync(new URL(`../../${CONVENIENCES}`, import.meta.url), 'utf8');
    assert.ok(src.includes('tagContains'),
      `${CONVENIENCES} must use the shared matcher — it is the only place the single-tag box is read`);
  });

  it('and both doors reach it, so an agent and the browser match tags the same way', () => {
    // The parity half, which is why the module exists rather than five tidier copies. `filter` gained
    // the conveniences in the same change that collapsed the five assemblies.
    for (const door of FILTER_DOORS) {
      const src = readFileSync(new URL(`../../${door}`, import.meta.url), 'utf8');
      // `resolvePredicate` since `B-19`: the doors stopped calling the convenience assembly directly when
      // the derived-status step joined it, because a door holding the ORDER of the two is a door that can
      // get it wrong. It is still the one entry point both of them go through.
      assert.ok(src.includes('resolvePredicate('),
        `${door} does not reach the shared list-filter assembly, so its \`tag\` can drift`);
    }
  });

  it('no call site anywhere still builds an anchored whole-tag regex', () => {
    /*
     * DERIVED over the tree rather than over the five names above. An anchored `^tag$` is the original
     * defect — "arch" finding nothing on a record tagged `architecture` — and the file that reintroduces
     * it is by definition one nobody thought to list.
     */
    const sources = trackedSources(['server/src']);
    assert.ok(sources.length >= 100, `only ${sources.length} sources scanned — the sweep broke`);
    const anchored = sources.filter(f =>
      /\$regex:\s*`\^\$\{escapeRegex\((?:tag|filter\.tag)\)\}\$`/.test(readFileSync(f, 'utf8')));
    assert.deepEqual(anchored, [],
      `these anchor a tag regex, so a partial tag search will not hit there: ${anchored.join(', ')}`);
  });

  it('the plural tags/tagsAny params keep their exact set semantics', () => {
    // Integrations select an exact set with these; widening them to substring would over-match
    // silently. Only the singular `?tag=` box changed.
    const src = readFileSync(new URL('../../server/src/brain/chrono.ts', import.meta.url), 'utf8');
    assert.ok(src.includes('$all: filter.tags'), 'tags (AND) must still be an exact $all');
    assert.ok(src.includes('$in: filter.tagsAny'), 'tagsAny (OR) must still be an exact $in');
  });
});
