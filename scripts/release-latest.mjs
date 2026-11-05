#!/usr/bin/env node
/**
 * Prints `true` or `false`: is the given tag the highest release of this repository's `v*` tags? (Q-683)
 *
 * Usage: `node scripts/release-latest.mjs v6.5.0`
 *
 * ## The question it answers
 *
 * The Release step of `publish.yml` passes `--latest=<this answer>` to `gh release create`, so a backfilled older tag is not
 * announced as the newest version. The ranking is `scripts/_shared/release-tags.mjs`'s `isHighestReleaseTag`; this script only
 * lists the tags and prints the answer. It sorts nothing itself.
 *
 * ## What it prevents
 *
 * The step used to sort inline (`git tag --list 'v*' --sort=-v:refname | head -n1`), which ranks `v7.0.0-rc.1` above `v6.9.0`: a
 * release candidate was announced as Latest. A missing tag argument is refused (exit 1) instead of answering `false`: a Release
 * step whose `GITHUB_REF_NAME` came out empty would otherwise publish a Release marked not-latest and say nothing.
 */
import { listReleaseTags } from './_shared/release-tag-list.mjs';
import { isHighestReleaseTag } from './_shared/release-tags.mjs';
import { isEntryPoint } from './_shared/script-cli.mjs';

if (isEntryPoint(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.length !== 1 || !args[0]) {
    console.error('usage: node scripts/release-latest.mjs <tag>   (exactly one tag, such as v6.5.0)');
    process.exit(1);
  }
  try {
    process.stdout.write(`${isHighestReleaseTag(args[0], listReleaseTags())}\n`);
  } catch (error) {
    console.error(`release-latest: could not list the v* tags: ${error.message}`);
    process.exit(1);
  }
}
