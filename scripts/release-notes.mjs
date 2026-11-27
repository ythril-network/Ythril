#!/usr/bin/env node
/**
 * Print the CHANGELOG body for a version, for `gh release create --notes-file`.
 *
 * Usage: node scripts/release-notes.mjs 3.1.0 [out.md]
 *
 * Exits non-zero and says why when the section is missing or empty, so `publish.yml` fails loudly rather
 * than creating a Release with an empty body. A release note that says nothing is worse than a missing one:
 * it asserts that nothing changed.
 *
 * ## Why this exists at all
 *
 * `publish.yml` pushed images on every `v*` tag and created no GitHub Release, and nothing noticed for six
 * versions — `v2.6.0` through `v3.0.1` shipped as images while the Releases page showed **2.5.1 as Latest
 * for five weeks**. The images were the half a machine consumes and the Release is the half a person reads,
 * and only one of them had a mechanism.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { changelogSection, sectionContentLines, releaseBody, abridgeForRelease, RELEASE_BODY_MAX } from './changelog-section.mjs';
import { changelogMechanisms, describeMechanisms } from './_changelog-mechanisms.mjs';
import { codeSurfaces } from './_changelog-surfaces.mjs';

const version = process.argv[2];
const outPath = process.argv[3];

if (!version) {
  console.error('usage: node scripts/release-notes.mjs <version> [outfile]');
  process.exit(2);
}

const changelogText = readFileSync('CHANGELOG.md', 'utf8');
const section = changelogSection(changelogText, version);
if (!section) {
  console.error(`No dated CHANGELOG section for ${version}. Expected a line like "## [${version}] — YYYY-MM-DD".`);
  console.error('The tag was pushed without closing [Unreleased] into a dated heading, so there are no notes to publish.');
  process.exit(1);
}

/*
 * The notes are public text. A section that names an internal mechanism (a collection, a source path, a data-structure term,
 * a function) is refused here, as the preflight and the release gate refuse it, so the Releases page carries only what the
 * rule passed (Q-975). The rule holds `[Unreleased]` and releases after 6.5.7; an older section is never examined.
 */
const mechanisms = changelogMechanisms(changelogText, codeSurfaces()).filter(o => o.section === `[${version}]`);
if (mechanisms.length > 0) {
  console.error(describeMechanisms(mechanisms));
  console.error(`The ${version} CHANGELOG section would publish how the server works inside. Fix the lines, then cut the notes again.`);
  process.exit(1);
}

const content = sectionContentLines(section);
if (content.length < 3) {
  console.error(`The ${version} CHANGELOG section has ${content.length} content line(s).`);
  console.error('Publishing that as a release note would announce a version and describe none of it.');
  process.exit(1);
}

/*
 * THERE IS A CEILING AS WELL AS A FLOOR, and only the floor existed.
 *
 * The check above refuses a section too short to describe anything. Nothing checked the other end, because
 * every release until 4.0.0 fitted: that tag was cut, both registries took the image, and this step failed
 * with `422 body is too long (maximum is 125000 characters)` against 335 002 characters of notes.
 *
 * A major is where it breaks — 4.0.0 carries every entry since 3.0.0 — and the failure lands at the LAST
 * step, after everything else has published, which is the most expensive place for it to land.
 */
const full = releaseBody(section);
const body = abridgeForRelease(full, version);
if (outPath) {
  writeFileSync(outPath, body + '\n', 'utf8');
  console.error(body.length === full.length
    ? `wrote ${body.length} chars of notes for ${version} to ${outPath}`
    : `wrote ${body.length} chars of notes for ${version} to ${outPath} — ABRIDGED from ${full.length}, `
      + `over GitHub's ${RELEASE_BODY_MAX} limit; the body points at CHANGELOG.md at this tag`);
} else {
  process.stdout.write(body + '\n');
}
