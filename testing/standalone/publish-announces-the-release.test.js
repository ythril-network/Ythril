/**
 * Publishing a tag creates the GitHub Release, and its notes come from the CHANGELOG.
 *
 * ## What this is for
 *
 * `publish.yml` triggers on `v*`, builds, and pushes to both registries — correctly, every time. It did not
 * create a **GitHub Release**, and nothing else did either, so `v2.6.0`, `v2.7.0`, `v2.8.0`, `v2.8.1`,
 * `v3.0.0` and `v3.0.1` all shipped as images with no entry on the Releases page. It showed **2.5.1 from
 * 2026-08-07 as Latest** for six versions and five weeks, which for anyone watching read as a project that
 * had stopped.
 *
 * Nothing noticed because nothing was watching for an ABSENCE. Every existing check asked whether a thing
 * that happened was correct; none asked whether a thing had happened at all. Found by hand while cutting
 * 3.1.0 — `gh release list` beside `git tag`.
 *
 * ## Gated on the RULE
 *
 * The section extraction is exercised by calling it, not grepped: a release body is the one artefact nobody
 * proof-reads, and a truncating slice would ship notes that read as complete. The workflow assertions are
 * about the properties that were wrong or that are easy to get wrong — the permission, the ordering, and
 * `--latest` being a decision rather than a default.
 *
 * Run: node --test testing/standalone/publish-announces-the-release.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  changelogSection, sectionContentLines, releaseBody,
  abridgeForRelease, RELEASE_BODY_MAX, RELEASE_BODY_TARGET, entriesWithSection, isBreaking,
} from '../../scripts/changelog-section.mjs';

const wf = readFileSync('.github/workflows/publish.yml', 'utf8');
const changelog = readFileSync('CHANGELOG.md', 'utf8');

/**
 * The release this gate exercises the extraction against, READ OUT OF THE FILE.
 *
 * It named `3.1.0` — the release being cut when the gate was written, which lived in `CHANGELOG.md` and was
 * going to stay there. It did not: `CHANGELOG.md` holds ONE major series, so cutting 4.0.0 archived every
 * 3.x section and three of this file's cases went red against a version that had simply moved.
 *
 * A gate anchored to a specific version is only as durable as that version's residence. The newest release
 * is the honest anchor: there is always exactly one, it is always in this file, and it is the one whose
 * notes the next publish will actually ship.
 */
const NEWEST = /^## \[(\d+\.\d+\.\d+)\] /m.exec(changelog)?.[1];
const PREVIOUS = [...changelog.matchAll(/^## \[(\d+\.\d+\.\d+)\] /gm)][1]?.[1] ?? null;

describe('the section extraction is one implementation, and it is bounded structurally', () => {
  it('finds a real release and stops at the next heading', () => {
    assert.ok(NEWEST, 'no dated release in CHANGELOG.md — this gate is measuring nothing');
    const s = changelogSection(changelog, NEWEST);
    assert.ok(s, `no ${NEWEST} section — this gate is measuring nothing`);
    assert.ok(s.startsWith(`## [${NEWEST}]`), 'starts at its own heading');
    assert.equal((s.match(/^## \[/gm) ?? []).length, 1,
      'the section swallowed a later release — it must stop at the next `## [` heading');
    // Only meaningful once there IS a previous release in this file. At the FIRST release of a new major
    // there is not, and asserting against one would fail on exactly the state the archive split creates.
    if (PREVIOUS) {
      assert.ok(!s.includes(`## [${PREVIOUS}]`), 'and specifically not reach the previous release');
    }
  });

  it('the body drops the heading and keeps everything else', () => {
    const s = changelogSection(changelog, NEWEST);
    const body = releaseBody(s);
    assert.ok(!body.startsWith(`## [${NEWEST}]`), 'the heading is the Release title, not part of its notes');
    assert.ok(body.length > 1000,
      `the ${NEWEST} notes came out ${body.length} chars. A truncating extraction ships notes that read as `
      + 'complete, which is the failure a character-bounded slice would produce and nobody would proof-read.');
  });

  it('a version with no dated heading returns null rather than a wrong section', () => {
    // The failure that matters: a tag pushed without closing `[Unreleased]`. Returning the NEXT section
    // would publish another release's notes under this version's name.
    assert.equal(changelogSection(changelog, '99.99.99'), null);
    assert.equal(changelogSection('## [Unreleased]\n\n### Fixed\n\n- a thing\n', NEWEST), null,
      'an undated [Unreleased] is not a release section');
  });

  it('content lines ignore headings, so an empty section cannot pass as full', () => {
    const empty = '## [9.9.9] — 2026-01-01\n\n### Fixed\n\n### Changed\n';
    assert.equal(sectionContentLines(empty).length, 0,
      'a section holding only headings claims something changed and names none of it');
    assert.ok(sectionContentLines(changelogSection(changelog, NEWEST)).length >= 3);
  });
});

describe('a body too long for GitHub is abridged, not refused', () => {
  /*
   * MEASURED, and it cost a tag. `v4.0.0` was pushed, both registries took the image, and the Release step
   * failed with `422 body is too long (maximum is 125000 characters)` against **335 002 characters** of
   * notes. Every release before it fitted, so nothing had ever exercised a ceiling: `release-notes.mjs` had
   * a FLOOR — refusing a section too short to describe anything — and nothing at the other end.
   *
   * A major is where it breaks, because a major carries every entry since the last one. And it breaks at
   * the LAST step, after the images have published, which is the most expensive place for it to land.
   *
   * The limit is passed explicitly here so the cases exercise the real code path without a 300 KB fixture.
   */
  const entry = (n) => `- **Entry ${n}.** ${'x'.repeat(200)}`;
  const many = Array.from({ length: 60 }, (_, i) => entry(i)).join('\n');

  it('leaves a body that already fits completely alone', () => {
    // The common case, and the one a ceiling must not touch: every release before 4.0.0 fitted.
    assert.equal(abridgeForRelease(many, '9.9.9', 100_000), many);
  });

  it('fits inside the limit, and the limit it fits inside is under GitHub\'s', () => {
    const out = abridgeForRelease(many, '9.9.9', 3_000);
    assert.ok(out.length <= 3_000, `abridged to ${out.length}, over the 3000 asked for`);
    assert.ok(RELEASE_BODY_TARGET < RELEASE_BODY_MAX,
      'the target must sit UNDER the hard limit — this body is full of em-dashes, so its byte length runs '
      + 'ahead of its character length, and being right about which one GitHub counts is not worth the margin');
  });

  it('cuts between entries, never inside one', () => {
    /*
     * The rule the module header already states: *"a slice bounded by a character count would ship a
     * truncated release note that reads as complete"*. A body that stops mid-sentence is exactly that.
     */
    const out = abridgeForRelease(many, '9.9.9', 3_000);
    const shown = out.split('\n').filter(l => l.startsWith('- **Entry '));
    assert.ok(shown.length >= 1, 'nothing survived — the budget maths left no room for a single entry');
    for (const l of shown) {
      assert.ok(l.endsWith('x'.repeat(10)), `an entry was cut mid-text: ${l.slice(-40)}`);
    }
  });

  it('says it is abridged at BOTH ends, and how many of how many', () => {
    // The top one is the one that matters: a reader who stops halfway through a body this size never
    // reaches a footer, and would take a window onto the notes for all of them.
    const out = abridgeForRelease(many, '9.9.9', 3_000);
    const shown = out.split('\n').filter(l => l.startsWith('- **Entry ')).length;
    assert.match(out.split('\n')[0], /abridged/i, 'the first line must say so');
    assert.ok(out.includes(`${shown} of 60 entries`), 'the count must be the REAL one, not the budgeted one');
    assert.match(out, /End of the abridged notes/, 'and the end must say where it ended');
    assert.ok(out.includes('/blob/v9.9.9/CHANGELOG.md'),
      'both notices must point at the CHANGELOG AT THIS TAG — a link to main would drift away from the notes');
  });

  it('and a single entry bigger than the whole budget still says where the notes are', () => {
    // Rather than returning an empty body, which announces a version and describes none of it — the exact
    // failure the floor above this file exists to prevent.
    const huge = `- **One enormous entry.** ${'y'.repeat(5_000)}`;
    const out = abridgeForRelease(huge, '9.9.9', 1_000);
    assert.match(out, /too long to show here/);
    assert.ok(out.includes('/blob/v9.9.9/CHANGELOG.md'));
  });

  /*
   * MEASURED AGAIN, and the second measurement is what these cases are for. An operator read the abridged
   * 4.0.0 notes and missed the largest change in the release — the link system, which changes what happens
   * to every caller writing `entityIds`. They found it because their own owner asked, not because the
   * release told them. 81 of 227 entries were shown, chosen by nothing but document order.
   *
   * **The finding is the truncation, not the omission.** A prefix is not a summary, and no amount of
   * raising the budget fixes a selection rule that is "whatever came first".
   */
  const breaker = (n) => `- **BREAKING: entry ${n}.** ${'b'.repeat(200)}`;
  const late = [...Array.from({ length: 40 }, (_, i) => entry(i)), breaker(98), breaker(99)].join('\n');

  it('keeps every breaking entry, even one written last', () => {
    const out = abridgeForRelease(late, '9.9.9', 3_000);
    for (const n of [98, 99]) {
      assert.ok(out.includes(`entry ${n}.`),
        `breaking entry ${n} was dropped. It is at the END of the section, which is exactly where the link `
        + 'system sat in 4.0.0 — and a reader who never sees it finds out from their next failed write.');
    }
  });

  it('puts them FIRST, because a reader who stops early has to have seen them', () => {
    const out = abridgeForRelease(late, '9.9.9', 3_000);
    const firstBreaking = out.indexOf('BREAKING: entry 98');
    const firstOrdinary = out.indexOf('- **Entry 0.**');
    assert.ok(firstBreaking > -1 && firstOrdinary > -1, 'expected both kinds in the output');
    assert.ok(firstBreaking < firstOrdinary,
      'the breaking entries are below the ordinary ones, so the abridgement still buries them');
  });

  it('a removal counts as breaking even when nobody wrote the word', () => {
    /*
     * The half that is not the word. Several genuine removals in 4.0.0 never say "breaking" — the section
     * heading is the claim, and an entry under `### Removed` is breaking by construction.
     */
    const withRemoval = ['### Added', ...Array.from({ length: 40 }, (_, i) => entry(i)),
      '', '### Removed', `- **The old endpoint is gone.** ${'r'.repeat(200)}`].join('\n');
    const out = abridgeForRelease(withRemoval, '9.9.9', 3_000);
    assert.ok(out.includes('The old endpoint is gone.'),
      'an entry under ### Removed was dropped — a removal breaks a caller whether or not its author '
      + 'happened to use the word');
  });

  it('shortens a breaking entry rather than dropping it, when they cannot all fit whole', () => {
    /*
     * The third measurement, found cutting 5.0.0: lifting the breaking entries first is not enough on its
     * own once they no longer fit BETWEEN THEM. 20 entries totalling 26 452 characters meant any budget
     * under that dropped whole entries off the end of the lifted block — the original failure one level
     * in, with the reader's guard down because the notes now promise the breaking ones come first.
     *
     * The fixture is sized so the headlines fit and the bodies cannot, which is the case the reserve
     * exists for. Every headline present; at least one entry NOT present in full, or the fixture has
     * stopped exercising anything.
     */
    const fat = Array.from({ length: 12 }, (_, i) => `- **BREAKING: fat ${i}.**
  ${'x'.repeat(800)}`);
    const out = abridgeForRelease(fat.join('\n'), '9.9.9', 4_000);
    for (let i = 0; i < 12; i++) {
      assert.ok(out.includes(`BREAKING: fat ${i}.`),
        `breaking entry ${i} is absent entirely — a headline costs one line and is what sends a reader to `
        + 'the full notes; an entry that is not there cannot');
    }
    assert.ok(!out.includes(fat[11]),
      'every entry fitted whole, so this fixture no longer exercises the reserve — widen the bodies');
  });

  it('and says which of them were shortened, rather than counting them as shown', () => {
    const fat = Array.from({ length: 12 }, (_, i) => `- **BREAKING: fat ${i}.**
  ${'x'.repeat(800)}`);
    const out = abridgeForRelease(fat.join('\n'), '9.9.9', 4_000);
    assert.match(out, /are cut to their opening lines/,
      '"12 of 12 breaking entries are shown" over entries cut to one line each is the reassurance this '
      + "abridger's own history argues against");
  });

  it('says how many breaking entries it is showing, not only how many entries', () => {
    const out = abridgeForRelease(late, '9.9.9', 3_000);
    assert.match(out, /2 of 2 breaking entries are shown first/,
      'the notice does not tell a reader whether the entries they must act on are all present');
  });

  it('leaves a body with nothing breaking in it alone, apart from the cut', () => {
    // No headings invented where there is nothing to head. The common shape is a minor release with no
    // breaking entries at all, and it must not grow a "Breaking changes" section containing nothing.
    const out = abridgeForRelease(many, '9.9.9', 3_000);
    assert.ok(!out.includes('## Breaking changes'), 'an empty Breaking changes heading was added');
    assert.ok(!out.includes('breaking'), 'the notice mentions breaking entries in a body that has none');
  });

  it('keeps the paragraphs a release opens with, which are the only summary it has', () => {
    /*
     * Every major since 3.0 opens with a few paragraphs saying what the release IS, before any bullet. The
     * previous abridger kept them by accident — its split left them stuck to the front of the first entry —
     * and ranking the entries is exactly the change that would have silently dropped them. Which would have
     * traded one buried summary for a missing one.
     */
    const intro = '**9.9 is the release where something happened.**\n\nA paragraph about it.';
    const out = abridgeForRelease(`${intro}\n\n${late}`, '9.9.9', 3_000);
    assert.ok(out.includes('9.9 is the release where something happened.'),
      'the opening summary was dropped — the best description of the release, gone from its own notes');
    assert.ok(out.indexOf('A paragraph about it.') < out.indexOf('BREAKING: entry 98'),
      'the opening summary is no longer at the opening');
  });

  it('every breaking entry in the NEWEST real release survives being abridged hard', () => {
    /*
     * Against the real file rather than a fixture, because the fixtures are the shape I already thought of.
     * Read out of the changelog for the same reason `NEWEST` exists above: a case anchored to one version
     * is only as durable as that version's residence in this file.
     */
    const section = changelogSection(changelog, NEWEST);
    const full = releaseBody(section);
    const breaking = entriesWithSection(full).filter(isBreaking);
    if (breaking.length === 0) return; // A release with nothing breaking has nothing to protect here.

    const out = abridgeForRelease(full, NEWEST, 20_000);
    const missing = breaking.filter(e => !out.includes(e.text.split('\n')[0]));
    assert.deepEqual(missing.map(e => e.text.slice(0, 60)), [],
      `abridging ${NEWEST} to 20 000 characters dropped ${missing.length} breaking `
      + `${missing.length === 1 ? 'entry' : 'entries'} of ${breaking.length}.`);
  });
});

describe('the workflow announces what it published', () => {
  it('creates a Release', () => {
    assert.match(wf, /gh release create/,
      'publish.yml pushes images and never announces them — six tags shipped invisibly that way');
    assert.match(wf, /release-notes\.mjs/,
      'the notes must come from the CHANGELOG, not be typed into the workflow');
  });

  it('has the permission to do it', () => {
    // The reason it never existed: `contents: read` cannot create a Release, and a missing permission fails
    // at the API rather than at review time.
    const perms = wf.slice(wf.indexOf('permissions:'), wf.indexOf('jobs:'));
    assert.match(perms, /contents:\s*write/,
      'contents: write is required to create a Release; with `read` the step fails at the API');
  });

  it('announces LAST — after the image and after the licence checks', () => {
    // A Release is an announcement. Announcing a build that then fails its own NOTICE verification is worse
    // than announcing nothing, so the ordering is the assertion rather than a comment.
    const create = wf.indexOf('gh release create');
    const push = wf.indexOf('Build and push');
    const notice = wf.indexOf('Verify the licence and notices are in the published image');
    assert.ok(push > -1 && notice > -1, 'the workflow changed shape — this gate is measuring nothing');
    assert.ok(create > push, 'the Release must come after the image is pushed');
    assert.ok(create > notice, 'and after the published image passes its licence checks');
  });

  it('treats `--latest` as a decision, not a default', () => {
    // `gh` marks a new release latest unless told otherwise. Correct for a forward release, wrong for a
    // backfilled older one — that would announce a superseded version as newest, which is precisely what
    // filling the six-release backlog would do.
    assert.match(wf, /--latest="?\$\{?LATEST/,
      'the workflow must pass an explicit --latest computed from whether this tag is the highest');
    assert.match(wf, /git tag --list 'v\*' --sort=-v:refname/,
      'and compute it from the tags rather than assuming the newest push is the newest version');
  });

  it('re-running a tag updates the notes instead of failing the publish', () => {
    // `gh release create` errors when the release exists. A re-run — a retried publish, a re-pushed tag —
    // would then fail AFTER the images were already pushed, reporting a broken release for a build that
    // succeeded.
    assert.match(wf, /gh release view .* >\/dev\/null 2>&1/,
      'the step must check for an existing Release');
    assert.match(wf, /gh release edit/, 'and update it rather than erroring');
  });
});
