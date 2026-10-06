/**
 * A proxy space is never the subject of the link conversion — not walked, not marked, not reported.
 *
 * ## How this was found
 *
 * Reported by the platform canary on the 5.4.3 roll, 2026-09-27T0830Z (`Q-78`): every boot of one instance
 * logged *"drop-link-arrays: 2 space(s) still hold their links as arrays … team, crafts"*, and both are
 * proxies. A proxy holds no records of its own — its members do, and convert in their own right — so the boot
 * conversion skips it and never marks it. The array clear that runs after it asked the other question: *"is
 * this space marked?"* — and for a proxy made before 5.0 the answer is no, for ever. One rule, and the copy
 * that forgot it was the one that RECORDS rather than refuses: a warning an operator reads as a failed
 * migration, naming a remedy that walks nothing.
 *
 * ## The rule, and where it lives
 *
 * `linkConversionConcerns(space)` answers whether a space is a subject of the conversion. Every site that
 * decides conversion work asks it — the derived set below, so a fifth site written next year is held to it
 * without anyone remembering this file.
 *
 * Run: node --test testing/standalone/a-proxy-is-never-a-link-conversion-subject.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

let linkConversionConcerns, isProxy;
before(async () => {
  ({ linkConversionConcerns } = await import('../../server/dist/brain/links-conversion.js'));
  ({ isProxy } = await import('../../server/dist/spaces/proxy.js'));
});

describe('which spaces the conversion concerns', () => {
  const cases = [
    ['a real space', { id: 'a' }, true],
    ['a real space with an empty member list (only a hand-edited config makes one)', { id: 'a', proxyFor: [] }, true],
    ['a proxy over named members', { id: 'p', proxyFor: ['a', 'b'] }, false],
    ['a wildcard proxy', { id: 'p', proxyFor: ['*'] }, false],
  ];
  for (const [label, space, expected] of cases) {
    it(`${label}: ${expected ? 'converted' : 'skipped'}`, () => {
      assert.equal(linkConversionConcerns(space), expected);
      assert.equal(isProxy(space), !expected);
    });
  }
  it('no space at all is not a proxy', () => {
    assert.equal(isProxy(undefined), false);
  });
});

describe('every site that decides conversion work asks the one question', () => {
  /*
   * DERIVED, not listed: a file that CHOOSES spaces from the configuration for link work — it reads
   * `getConfig().spaces` and either walks them (the walker or its preview) or records the ones left
   * unconverted. A benchmark converting one fixed space chooses nothing. The count floor makes an empty scan fail.
   */
  const sites = [
    ...readTrackedSources(['server/src'], { floor: 100 }),
    ...readTrackedSources(['scripts'], { ext: ['.mjs'], floor: 1 }),
  ]
    .map(f => ({ ...f, code: stripComments(f.text) }))
    .filter(f => /getConfig\(\)\.spaces/.test(f.code)
      && (/\b(convertSpaceLinks|convertAndMarkSpaces|previewSpaceLinks)\(/.test(f.code) || /\bunconverted\.push\(/.test(f.code)));

  it('finds the sites (boot, full run, script, array clear)', () => {
    assert.ok(sites.length >= 4, `only ${sites.length} site(s): ${sites.map(s => s.file).join(', ')}`);
  });

  for (const s of sites) {
    it(`${s.file} asks linkConversionConcerns, and tests for a proxy nowhere by hand`, () => {
      assert.match(s.code, /\blinkConversionConcerns\(/, `${s.file} decides conversion work without the shared rule`);
      assert.doesNotMatch(s.code, /proxyFor/, `${s.file} keeps its own copy of the proxy test`);
    });
  }
});
