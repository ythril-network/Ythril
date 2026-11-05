/**
 * The release tag has ONE reading: which version a tag names, whether it is the highest release, and which tag a run is on
 * (`scripts/_shared/release-tags.mjs`, bundle-225, Q-683).
 *
 * ## The rule this holds
 *
 * Three questions about a `v*` tag are asked by three callers and answered once, by pure functions:
 *
 *  - `tagMatchesVersion(tag, version)` — is the tag exactly `v` + the manifests' version? (`release-gate.mjs`)
 *  - `isHighestReleaseTag(tag, tags)` — is the tag the highest NON-PRERELEASE `v*` tag of the list, by numeric semver order?
 *    (`release-latest.mjs`, which the Release step's `--latest` and `publish-schema.mjs`'s npm dist-tag both read)
 *  - `releaseTagOf({ ref, refName, describe })` — the tag a run is on: `GITHUB_REF` when it is `refs/tags/...`, else
 *    `git describe --exact-match --tags --match 'v*'`, else none. (`release-gate.mjs`)
 *
 * ## The defect it prevents (Q-683)
 *
 *  1. `release-gate.mjs` never compared the tag with the manifests' version (`contribution-guide.md` claimed it did): a tag
 *     `v6.5.1` cut on a tree that says 6.5.0 published an image, a Release and now an npm version under the wrong number, and
 *     none of the three can be taken back (npm never accepts the same version twice).
 *  2. The Release step's `--latest` came from `git tag --list 'v*' --sort=-v:refname | head -n1`, which ranks `v7.0.0-rc.1`
 *     ABOVE `v6.9.0` (a prerelease is "highest" to a version sort), so a release candidate was announced as Latest. npm's
 *     `latest` dist-tag would have moved to it the same way, and every `npm install` without a tag would then fetch a
 *     candidate. A second copy of the rule, for npm, was the alternative; one module is the design.
 *
 * ## The failure that bought it
 *
 * The first two sites of the same question ("is this the highest tag") were a shell sort and, in the first design of the npm
 * job, a registry `dist-tags.latest` compare. Two spellings of one rule is how the shell one got prereleases wrong without
 * anyone reading it. Rows below are the truth tables; the module is pure, so none needs git.
 *
 * ## Choices the rows fix where the design left a detail open
 *
 *  - `tagMatchesVersion` of NO tag is `false`: nothing is not a match. The release gate asks `releaseTagOf` first and skips the
 *    comparison when there is no tag (a hand `--releasing` check before the tag exists checks nothing new).
 *  - `isHighestReleaseTag` is `false` for an empty list and for a tag the list does not contain: it is "the tag IS the highest
 *    of the list", the shell rule it replaces (`[ "$TAG" = "$HIGHEST" ]`), so a checkout that did not fetch its tags never
 *    claims Latest.
 *  - `releaseTagOf` trims what `describe` returns (a child process prints a newline) and answers none when `describe` throws
 *    (git exits non-zero when HEAD is not exactly a tag).
 *
 * Run: node --test testing/standalone/release-tags.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tagMatchesVersion, isHighestReleaseTag, releaseTagOf } from '../../scripts/_shared/release-tags.mjs';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();

describe('tagMatchesVersion: the tag is exactly v + the version', () => {
  const ROWS = [
    ['a match', 'v6.5.0', '6.5.0', true],
    ['a patch that differs', 'v6.5.1', '6.5.0', false],
    ['a minor that differs', 'v6.6.0', '6.5.0', false],
    ['a major that differs', 'v7.5.0', '6.5.0', false],
    ['the tag lacks the v (a non-v tag is no release tag)', '6.5.0', '6.5.0', false],
    ['an upper-case V', 'V6.5.0', '6.5.0', false],
    ['a doubled v', 'vv6.5.0', '6.5.0', false],
    ['a prerelease tag on a prerelease version', 'v6.6.0-rc.1', '6.6.0-rc.1', true],
    ['a prerelease tag on the release version', 'v6.6.0-rc.1', '6.6.0', false],
    ['the release tag on a prerelease version', 'v6.6.0', '6.6.0-rc.1', false],
    ['a different prerelease', 'v6.6.0-rc.2', '6.6.0-rc.1', false],
    ['numeric, not textual: 6.10.0 is not 6.1.0', 'v6.10.0', '6.1.0', false],
    ['a prefix of the version', 'v6.5', '6.5.0', false],
    ['the version is a prefix of the tag', 'v6.5.0', '6.5', false],
    ['a trailing newline (a describe that was not trimmed)', 'v6.5.0\n', '6.5.0', false],
    ['a leading space', ' v6.5.0', '6.5.0', false],
    ['a trailing dot', 'v6.5.0.', '6.5.0', false],
    ['a leading zero is another number', 'v06.5.0', '6.5.0', false],
    ['no tag at all (null)', null, '6.5.0', false],
    ['no tag at all (undefined)', undefined, '6.5.0', false],
    ['an empty tag', '', '6.5.0', false],
    ['the bare v', 'v', '', false],
    ['an empty version never matches a real tag', 'v6.5.0', '', false],
    ['no version (undefined)', 'v6.5.0', undefined, false],
  ];
  for (const [what, tag, version, expected] of ROWS) {
    it(`${what}: tagMatchesVersion(${JSON.stringify(tag)}, ${JSON.stringify(version)}) is ${expected}`, () => {
      assert.equal(tagMatchesVersion(tag, version), expected);
    });
  }
});

describe('isHighestReleaseTag: the highest non-prerelease v* tag of the list, by numeric semver order', () => {
  const ROWS = [
    // — identity of the answer: the tag against the list
    ['the only tag', 'v6.5.0', ['v6.5.0'], true],
    ['the highest of several', 'v6.5.0', ['v6.3.0', 'v6.4.0', 'v6.5.0'], true],
    ['not the highest: a later patch exists', 'v6.5.0', ['v6.5.0', 'v6.5.1'], false],
    ['not the highest: a later minor exists', 'v6.5.0', ['v6.5.0', 'v6.6.0'], false],
    ['not the highest: a later major exists', 'v6.5.0', ['v6.5.0', 'v7.0.0'], false],
    ['an older line after a newer one (a backfill)', 'v5.9.9', ['v5.9.9', 'v6.5.0'], false],
    // — numeric, not textual (the sort that put 6.9 above 6.10 is the defect a text compare brings)
    ['6.10.0 is higher than 6.9.0', 'v6.10.0', ['v6.9.0', 'v6.10.0'], true],
    ['6.9.0 is lower than 6.10.0', 'v6.9.0', ['v6.9.0', 'v6.10.0'], false],
    ['6.5.10 is higher than 6.5.9', 'v6.5.10', ['v6.5.9', 'v6.5.10'], true],
    ['10.0.0 is higher than 9.9.9', 'v10.0.0', ['v9.9.9', 'v10.0.0'], true],
    ['9.9.9 is lower than 10.0.0', 'v9.9.9', ['v9.9.9', 'v10.0.0'], false],
    // — equal tags
    ['equal: the tag listed twice is still the highest', 'v6.5.0', ['v6.5.0', 'v6.5.0'], true],
    ['equal: the same tag among lower ones', 'v6.5.0', ['v6.4.0', 'v6.5.0', 'v6.5.0'], true],
    // — nothing to compare against
    ['an empty list vouches for nothing', 'v6.5.0', [], false],
    ['a list that does not contain the tag does not vouch for it, even when the tag is higher', 'v6.5.0', ['v6.4.0'], false],
    // — prereleases are never highest, and never beat a release
    ['a prerelease tag is never highest (alone in the list)', 'v6.6.0-rc.1', ['v6.6.0-rc.1'], false],
    ['a prerelease tag is never highest (above every release)', 'v7.0.0-rc.1', ['v6.9.0', 'v7.0.0-rc.1'], false],
    ['a prerelease tag is never highest (below the release it precedes)', 'v6.6.0-rc.1', ['v6.5.0', 'v6.6.0-rc.1', 'v6.6.0'], false],
    ['a prerelease tag is never highest (beta)', 'v7.0.0-beta.2', ['v7.0.0-beta.2'], false],
    ['a prerelease above the release does not take the release off the top', 'v6.9.0', ['v6.9.0', 'v7.0.0-rc.1'], true],
    ['a prerelease of the same version does not take the release off the top', 'v6.5.0', ['v6.5.0-rc.1', 'v6.5.0'], true],
    ['several prereleases above, the release is still highest', 'v6.9.0', ['v7.0.0-alpha.1', 'v7.0.0-beta.1', 'v7.0.0-rc.1', 'v6.9.0'], true],
    // — non-v and malformed tags are ignored (neither highest nor beating)
    ['a non-v tag is not a release tag', '6.5.0', ['6.5.0'], false],
    ['a non-v tag in the list never beats a v tag', 'v6.5.0', ['v6.5.0', '9.9.9'], true],
    ['words in the list never beat a v tag', 'v6.5.0', ['v6.5.0', 'latest', 'nightly', 'release-9.9'], true],
    ['a v tag that is not a version never beats one', 'v6.5.0', ['v6.5.0', 'v7.x', 'vfoo', 'v7'], true],
    ['a v tag that is not a version is not highest', 'v7.x', ['v6.5.0', 'v7.x'], false],
    // — no tag at all
    ['no tag (null)', null, ['v6.5.0'], false],
    ['no tag (undefined)', undefined, ['v6.5.0'], false],
    ['an empty tag', '', ['v6.5.0'], false],
  ];
  for (const [what, tag, tags, expected] of ROWS) {
    it(`${what}: isHighestReleaseTag(${JSON.stringify(tag)}, ${JSON.stringify(tags)}) is ${expected}`, () => {
      assert.equal(isHighestReleaseTag(tag, tags), expected);
    });
  }

  it('the answer does not depend on the order of the list (every order of three tags across 6.2 / 6.9 / 6.10)', () => {
    const permutations = (xs) => (xs.length <= 1 ? [xs] : xs.flatMap((x, i) => permutations([...xs.slice(0, i), ...xs.slice(i + 1)]).map((p) => [x, ...p])));
    const orders = permutations(['v6.2.0', 'v6.9.0', 'v6.10.0']);
    assert.equal(orders.length, 6, 'the permutations were not enumerated');
    for (const list of orders) {
      assert.equal(isHighestReleaseTag('v6.10.0', list), true, `v6.10.0 is the highest of ${JSON.stringify(list)}`);
      assert.equal(isHighestReleaseTag('v6.9.0', list), false, `v6.9.0 is not the highest of ${JSON.stringify(list)}`);
      assert.equal(isHighestReleaseTag('v6.2.0', list), false, `v6.2.0 is not the highest of ${JSON.stringify(list)}`);
    }
  });

  it('does not change the list it is given', () => {
    const tags = ['v6.10.0', 'v6.2.0', 'v6.9.0'];
    const before = [...tags];
    isHighestReleaseTag('v6.10.0', tags);
    assert.deepEqual(tags, before, 'the list was sorted in place, so the caller\'s order (git\'s) changed under it');
  });
});

describe('a prerelease tag is never announced or published as the highest release (the shell sort did)', () => {
  // The rule the Release step's `--latest` and the npm dist-tag now share. These rows are the ones the replaced
  // `git tag --list 'v*' --sort=-v:refname | head -n1` answered wrongly: it ranks 7.0.0-rc.1 above 6.9.0.
  const RELEASES = ['v6.8.0', 'v6.9.0'];
  for (const pre of ['v7.0.0-rc.1', 'v7.0.0-beta.1', 'v7.0.0-alpha', 'v6.9.1-rc.1', 'v6.10.0-0']) {
    it(`${pre} is not highest, and the latest release stays highest with it in the list`, () => {
      const tags = [...RELEASES, pre];
      assert.equal(isHighestReleaseTag(pre, tags), false, `${pre} was announced as the highest release`);
      assert.equal(isHighestReleaseTag('v6.9.0', tags), true, `${pre} took the highest release off the top`);
    });
  }
});

describe('releaseTagOf: the tag a run is on', () => {
  /** A `describe` that records its calls and answers `result`; a function result stands for the child process throwing. */
  const fake = (result) => {
    const calls = [];
    const fn = () => {
      calls.push(1);
      if (result instanceof Error) throw result;
      return result;
    };
    return { fn, calls };
  };

  it('a tag ref answers its name, and git is never asked', () => {
    const d = fake('v0.0.1-wrong');
    assert.equal(releaseTagOf({ ref: 'refs/tags/v6.5.0', refName: 'v6.5.0', describe: d.fn }), 'v6.5.0');
    assert.equal(d.calls.length, 0, 'describe was consulted on a tag ref, so the run could answer another tag than the one pushed');
  });

  it('a prerelease tag ref answers its name', () => {
    assert.equal(releaseTagOf({ ref: 'refs/tags/v6.6.0-rc.1', refName: 'v6.6.0-rc.1', describe: fake(null).fn }), 'v6.6.0-rc.1');
  });

  it('a dispatch on a branch HEAD that is exactly a tag answers the described tag, not the branch name', () => {
    const d = fake('v6.5.0');
    const tag = releaseTagOf({ ref: 'refs/heads/main', refName: 'main', describe: d.fn });
    assert.equal(tag, 'v6.5.0', 'a dispatch on tagged main compared the branch name or nothing');
    assert.equal(d.calls.length, 1, 'describe is asked exactly once');
  });

  it('a branch ref whose HEAD is no tag answers none (describe says so by answering null)', () => {
    assert.equal(releaseTagOf({ ref: 'refs/heads/main', refName: 'main', describe: fake(null).fn }), null);
  });

  it('a branch ref whose HEAD is no tag answers none (describe says so by throwing, as git exits non-zero)', () => {
    assert.equal(releaseTagOf({ ref: 'refs/heads/main', refName: 'main', describe: fake(new Error('fatal: no tag exactly matches')).fn }), null);
  });

  it('a pull-request ref falls through to describe', () => {
    assert.equal(releaseTagOf({ ref: 'refs/pull/12/merge', refName: '12/merge', describe: fake('v6.5.0').fn }), 'v6.5.0');
  });

  it('a local run (no GITHUB_REF) asks git', () => {
    assert.equal(releaseTagOf({ ref: undefined, refName: undefined, describe: fake('v6.4.0').fn }), 'v6.4.0');
    assert.equal(releaseTagOf({ ref: '', refName: '', describe: fake('v6.4.0').fn }), 'v6.4.0');
  });

  it('a local run on no tag answers none', () => {
    assert.equal(releaseTagOf({ ref: undefined, refName: undefined, describe: fake(null).fn }), null);
    assert.equal(releaseTagOf({ ref: undefined, refName: undefined, describe: fake('').fn }), null);
  });

  it('what describe prints is trimmed: a child process ends its answer with a newline', () => {
    assert.equal(releaseTagOf({ ref: 'refs/heads/main', refName: 'main', describe: fake('v6.5.0\n').fn }), 'v6.5.0',
      'the untrimmed tag never matches a version, so every dispatch on a tag would refuse');
    assert.equal(releaseTagOf({ ref: undefined, refName: undefined, describe: fake('\n').fn }), null, 'a blank answer is no tag');
  });
});

describe('the module stays pure, and the callers use it instead of re-deriving it', () => {
  const read = (rel) => stripComments(readFileSync(join(ROOT, rel), 'utf8'));

  it('release-tags.mjs touches neither git, the file system, the network nor the environment', () => {
    const src = read('scripts/_shared/release-tags.mjs');
    for (const forbidden of [/child_process/, /node:fs|from\s+['"]fs['"]/, /node:net|node:http|\bfetch\(/, /process\.env|process\.argv/]) {
      assert.ok(!forbidden.test(src), `release-tags.mjs matches ${forbidden}: it must be a function of its arguments, or its rows prove nothing about the real run`);
    }
  });

  it('release-latest.mjs asks the shared rule over the tag list and sorts nothing itself', () => {
    const src = read('scripts/release-latest.mjs');
    assert.match(src, /import\s*\{[^}]*\bisHighestReleaseTag\b[^}]*\}\s*from\s*['"]\.\/_shared\/release-tags\.mjs['"]/,
      'release-latest.mjs does not import isHighestReleaseTag from the shared module');
    assert.match(src, /isHighestReleaseTag\s*\(/, 'release-latest.mjs imports the rule and never calls it');
    assert.match(src, /import\s*\{[^}]*\blistReleaseTags\b[^}]*\}\s*from\s*['"]\.\/_shared\/release-tag-list\.mjs['"]/,
      'release-latest.mjs does not list the v* tags through the shared reader');
    assert.match(src, /listReleaseTags\s*\(/, 'release-latest.mjs imports the tag reader and never calls it');
    assert.match(read('scripts/_shared/release-tag-list.mjs'), /['"]tag['"][\s\S]*['"]--list['"][\s\S]*['"]v\*['"]/,
      'the shared tag reader does not list the v* tags through git');
    assert.ok(!/\.sort\(|--sort|localeCompare/.test(src),
      'release-latest.mjs orders tags itself: a second ordering is the defect this module removes');
  });
});
