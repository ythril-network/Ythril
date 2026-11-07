/**
 * The release gate is itself testable, because a gate that cannot fail is worse than no gate.
 *
 * Owner rule, 2026-08-04: *"i want the documentation lens to be a release gate from now on. docs/ MUST match code
 * and changelog must be carrying and notice MUST contain all attribution."*
 *
 * `scripts/release-gate.mjs` runs at tag time — in `publish.yml`, before login and before the build. The three
 * things it protects are the three a published release can never take back: an image on two public registries,
 * notes that do not describe it, and an attribution that was owed and not given. So the gate has to be right, and
 * "it printed PASSED once" is not evidence of that.
 *
 * ## What these tests are for
 *
 * The gate's own logic is what nothing else covers. The coverage gates it *invokes* have their own tests; the
 * parts unique to a release do not:
 *
 *  1. **The gate list cannot silently shrink.** Every gate it names must exist as a file. A renamed test would
 *     otherwise turn into a gate that quietly stopped running — the exact failure the list exists to prevent.
 *  2. **Mode detection is real.** `[Unreleased]` is *supposed* to be full between releases. The first version of
 *     the gate demanded it be empty unconditionally and failed on a healthy tree, which is how a gate teaches
 *     people to ignore it. So the release-only rules must be gated on actually releasing.
 *  3. **Every release-specific rule fires.** Version disagreement, a missing dated section, an empty one, and
 *     `[Unreleased]` left populated at release time — each asserted against a synthetic CHANGELOG rather than by
 *     trusting the prose.
 *  4. **The tag is compared, through the one module that knows tags.** The gate never compared the tag with the version
 *     (Q-683); `tagMatchesVersion` and `releaseTagOf` (scripts/_shared/release-tags.mjs, rows in release-tags.test.js) now do,
 *     and a describe block of its own holds that the gate calls them rather than spelling the rule itself.
 *
 * Run: node --test testing/standalone/release-gate-works.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const GATE = 'scripts/release-gate.mjs';
const src = readFileSync(join(ROOT, GATE), 'utf8');

/**
 * Code only. Assertions about what a gate CHECKS must not be satisfiable by the comment that explains the
 * check — that reads as coverage and makes deleting the explanation look like a fix.
 */
function withoutComments(text) {
  return text.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** The gate names its checks in two arrays; pull them out rather than duplicating the list here. */
function namedGates() {
  const out = [];
  for (const m of src.matchAll(/^\s*\['([a-z0-9-]+)',\s*'/gim)) out.push(m[1]);
  return out;
}

describe('the release gate names real gates', () => {
  it('finds the gate list — the parse still works', () => {
    const names = namedGates();
    assert.ok(names.length >= 10,
      `only ${names.length} gates parsed out of ${GATE}; the enumeration broke, not the gate`);
  });

  it('every named gate exists as a test file', () => {
    // A gate listed here and absent from the tree is a gate that stopped running. The script reports that
    // distinctly at runtime; this makes it a build failure rather than something noticed at the next release.
    const missing = namedGates()
      .map(n => `testing/standalone/${n}.test.js`)
      .filter(p => !existsSync(join(ROOT, p)));
    assert.deepEqual(missing, [], `the release gate names test files that do not exist:\n  ${missing.join('\n  ')}`);
  });

  it("covers all three of the owner's terms", () => {
    // The rule was stated as three things. If a future edit drops one of the groups, the gate would still pass
    // while enforcing less than was asked for.
    assert.match(src, /notice-coverage/, 'NOTICE attribution is not checked');
    assert.match(src, /env-var-docs-coverage/, 'docs/-matches-code is not checked');
    assert.match(src, /checkChangelog/, 'the CHANGELOG is not checked');
    assert.match(src, /lint:docs/, 'markdown in docs/ is not linted');
  });
});

describe('mode detection', () => {
  it('gates the [Unreleased]-must-be-empty rule on actually releasing', () => {
    // Between releases a populated [Unreleased] is correct. Asserted structurally because the alternative — run
    // the gate and see — depends on whether HEAD happens to be a tag when the suite runs.
    assert.match(src, /if \(!RELEASING\) return;/,
      'the [Unreleased] emptiness check is not gated on release mode, so it fails on every healthy mid-cycle tree '
      + 'and teaches everyone to ignore this gate');
  });

  it('the green CHANGELOG line does not claim a check that mid-cycle skips', () => {
    // `checkChangelog` returns early on the [Unreleased] rule unless RELEASING. So a success line naming that
    // rule unconditionally reports, in green, a check that did not run — and green is the colour people stop
    // reading after. It did exactly that for two releases, five lines below its own
    // "mid-cycle — [Unreleased] may hold entries" banner.
    //
    // Asserted structurally for the same reason as the test above: running the gate and reading its output
    // depends on whether HEAD happens to be a tag when the suite runs. Shape-agnostic on purpose — an
    // if/else satisfies it as readily as the ternary that is there now.
    const start = src.indexOf('checkChangelog(version);');
    assert.ok(start > 0, 'the CHANGELOG section moved — this test needs re-pointing, not deleting');
    // Comments stripped, and not as a formality: the first draft of this test PASSED against the pre-fix
    // code, because the comment written to explain the fix mentions RELEASING. A gate that reads prose
    // rewards deleting the prose.
    const region = withoutComments(src.slice(start, src.indexOf('\n}', start)));

    const claim = region.indexOf('[Unreleased] is empty');
    assert.ok(claim > 0,
      'the releasing-mode line no longer states that it checked [Unreleased]; if that claim was dropped on '
      + 'purpose, re-point this test at whatever states the coverage now');
    const branch = region.indexOf('RELEASING');
    assert.ok(branch > 0 && branch < claim,
      'the CHANGELOG success line is not gated on release mode, so a mid-cycle run claims [Unreleased] was '
      + 'checked while checkChangelog skipped it');
    assert.match(region, /not checked mid-cycle/,
      'the mid-cycle line does not say which check it skipped, so its silence reads as coverage');
  });

  it('detects release mode from git rather than from a flag alone', () => {
    // A flag somebody has to remember is not a gate. `publish.yml` runs with HEAD at the tag, so git can answer.
    assert.match(src, /describe.*--exact-match.*--tags/s,
      'release mode is not derived from git, so publish.yml would run the mid-cycle rules');
    assert.match(src, /--releasing/, 'there is no way to run the release rules before cutting the tag');
  });
});

describe('every release-specific rule actually fires', () => {
  /**
   * The gate reads real files, so its rules are exercised here against synthetic text using the same patterns.
   * That is a deliberate trade: it does not prove the gate's file I/O, and it does prove the rules are not
   * vacuous. The file I/O is covered by the gate having run green on this repo.
   */
  const version = '9.9.9';
  const dated = `## [${version}] — 2026-01-01`;

  it('a dated section for the version is required', () => {
    const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]\\s+[—-]\\s+(\\d{4}-\\d{2}-\\d{2})`, 'm');
    assert.ok(heading.test(`# Changelog\n\n${dated}\n\n- something\n`), 'the pattern rejects a valid heading');
    assert.ok(!heading.test(`# Changelog\n\n## [${version}]\n\n- something\n`),
      'an undated section passes, so a version could ship with no release date');
    assert.ok(!heading.test('# Changelog\n\n## [Unreleased]\n\n- something\n'),
      'a version with no section at all passes');
  });

  it('an em dash and a hyphen are both accepted as the date separator', () => {
    // The repo uses an em dash; a contributor typing a hyphen should not be told the section is missing, because
    // that error message points at the wrong problem entirely.
    const heading = new RegExp(`^## \\[${version.replace(/\./g, '\\.')}\\]\\s+[—-]\\s+(\\d{4}-\\d{2}-\\d{2})`, 'm');
    assert.ok(heading.test(`## [${version}] — 2026-01-01`), 'em dash rejected');
    assert.ok(heading.test(`## [${version}] - 2026-01-01`), 'hyphen rejected');
  });

  it('an empty release section is caught', () => {
    // An empty section is a stronger and falser claim than no section: it asserts that nothing changed.
    const countContent = (body) => body.split('\n').slice(1)
      .filter(l => l.trim() && !/^#{1,3} /.test(l.trim())).length;
    assert.ok(countContent(`${dated}\n\n### Added\n\n`) < 3, 'a section with only a subheading counts as content');
    assert.ok(countContent(`${dated}\n\n### Added\n\n- a\n- b\n- c\n`) >= 3, 'real content is miscounted as empty');
  });

  it('leftovers under [Unreleased] are counted, and subheadings are not mistaken for them', () => {
    // `### Fixed` alone under [Unreleased] is the residue of a template, not an unreleased change. Counting it
    // would block every release until someone deleted a heading, which is how a gate gets bypassed.
    const leftovers = (region) => region.split('\n').filter(l => l.trim() && !/^#{1,3} /.test(l.trim())).length;
    assert.equal(leftovers('\n\n### Fixed\n\n'), 0, 'a bare subheading is counted as an unreleased change');
    assert.equal(leftovers('\n\n### Fixed\n\n- a real change\n'), 1, 'a real leftover is not counted');
  });

  it('the version check looks at the lockfile too', () => {
    // The lockfile is the manifest nobody edits by hand, so it is the one that gets left behind on a bump.
    assert.match(src, /package-lock\.json/,
      'the lockfile is not checked, so a version bump can leave it naming the previous release');
  });
});

describe('the tag is compared with the version through release-tags.mjs, not re-derived in the gate', () => {
  // Bundle-225 (Q-683). The gate used to check that the four manifests agree with EACH OTHER and never with the tag, so a `v6.5.1`
  // cut on a tree that says 6.5.0 published an image, a Release and (now) an npm version under the wrong number, none of which can
  // be taken back; `contribution-guide.md` claimed the check existed. The comparison is a pure function with its own truth table
  // (release-tags.test.js: match, mismatch, no tag, non-v, prerelease, a dispatch on tagged main); this row holds that the GATE
  // asks that function, on the comment-stripped source, so a comment that mentions the tag satisfies nothing.
  const code = withoutComments(src);
  const checkVersionBody = () => {
    const start = code.indexOf('function checkVersion(');
    assert.ok(start > 0, 'checkVersion moved: this test needs re-pointing, not deleting');
    return code.slice(start, code.indexOf('\n}', start));
  };

  it('imports tagMatchesVersion and releaseTagOf from the shared module', () => {
    const imp = /import\s*\{([^}]*)\}\s*from\s*['"]\.\/_shared\/release-tags\.mjs['"]/.exec(code);
    assert.ok(imp, 'release-gate.mjs does not import from ./_shared/release-tags.mjs: the tag rule is spelled in the gate or not checked');
    const names = imp[1].split(',').map(n => n.trim().split(/\s+as\s+/)[0]);
    for (const needed of ['tagMatchesVersion', 'releaseTagOf']) {
      assert.ok(names.includes(needed), `release-gate.mjs does not import ${needed} from release-tags.mjs`);
    }
  });

  it('checkVersion decides the tag by calling both, only when releasing, and fails the version gate on a mismatch', () => {
    const body = checkVersionBody();
    // Which tag the run is on is asked once, in `currentReleaseTag`, which the date check (Q-717) shares; it is releaseTagOf's.
    assert.match(body, /\bcurrentReleaseTag\s*\(/, 'checkVersion never asks which tag the run is on');
    const helperStart = code.indexOf('function currentReleaseTag(');
    assert.ok(helperStart > 0, 'currentReleaseTag is gone: this test needs re-pointing, not deleting');
    assert.match(code.slice(helperStart, code.indexOf('\n}', helperStart)), /\breleaseTagOf\s*\(/,
      'currentReleaseTag does not ask releaseTagOf, so the tag is decided beside the shared module');
    assert.match(body, /\btagMatchesVersion\s*\(/, 'checkVersion never compares the tag with the version');
    const releasing = body.indexOf('RELEASING');
    assert.ok(releasing > 0 && releasing < body.indexOf('tagMatchesVersion('),
      'the tag comparison is not gated on RELEASING, so a mid-cycle run on any tagged commit would fail the gate');
    assert.match(body.slice(body.indexOf('tagMatchesVersion(')), /fail\(\s*'version'/,
      'a tag that differs from the version does not fail the version gate');
  });

  it('asks for the tag the way a run knows it: GITHUB_REF and GITHUB_REF_NAME, then git describe for a v* tag', () => {
    assert.match(code, /GITHUB_REF\b/, 'the gate does not read GITHUB_REF, so a tag push is not told from a branch dispatch');
    assert.match(code, /GITHUB_REF_NAME\b/, 'the gate does not read GITHUB_REF_NAME');
    assert.match(code, /['"]--match['"]\s*,\s*['"]v\*['"]/, 'the described tag is not restricted to v* tags, so any tag on HEAD would be compared');
  });

  it('does not re-derive the tag rule beside the shared module', () => {
    const body = checkVersionBody();
    assert.ok(!/['"`]v['"`]\s*\+|`v\$\{/.test(body), 'checkVersion spells "v" + version itself: that is tagMatchesVersion\'s one job');
  });
});

describe('it is wired into the release path, not merely available', () => {
  it('publish.yml runs the gate BEFORE the build', () => {
    const wf = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8');
    const gateAt = wf.indexOf('release:gate');
    const buildAt = wf.indexOf('Build and push');
    assert.ok(gateAt > 0, 'publish.yml does not run the release gate, so a tag can publish with stale docs');
    assert.ok(buildAt > 0, 'the Build and push step is gone — this assertion needs re-pointing');
    assert.ok(gateAt < buildAt,
      'the gate runs after the build, so a bad tag pays for a full multi-arch build before failing');
  });

  it('publish.yml fetches enough history for mode detection to work', () => {
    // A shallow clone with no tags makes `git describe --exact-match` fail, which reads as "not releasing" and
    // silently downgrades the release checks to their mid-cycle form. Nothing would look wrong.
    const wf = readFileSync(join(ROOT, '.github/workflows/publish.yml'), 'utf8');
    assert.match(wf, /fetch-depth:\s*0/,
      'publish.yml checks out shallow, so the gate cannot tell it is at a tag and would skip the release rules');
  });

  it('npm exposes both scripts', () => {
    const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
    assert.ok(pkg.scripts['release:gate'], 'npm run release:gate is missing');
    assert.ok(pkg.scripts['todo:check'], 'npm run todo:check is missing');
  });
});
