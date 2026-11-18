/**
 * The repository invites no outside code.
 *
 * ## The rule
 *
 * Ythril is built by one maintainer. The repository therefore carries no file whose job is to bring in someone else's code: no
 * contribution guide, no contributor licence agreement, no pull-request template, no workflow that asks an author to sign. The README
 * says so in plain words, and no tracked text links to a contribution guide.
 *
 * ## The failure that bought it
 *
 * The README said "Issues and PRs welcome" while the project took none, a `CLA.md` promised a signing bot, and a workflow ran on every
 * pull request with a write token to ask for a signature nobody was ever going to give. Each was a tracked file that a template, a
 * scaffold or a habit puts back, and nothing in the tree would have noticed one coming back.
 *
 * ## How it reads
 *
 * The file list is git's (`trackedSources`), so a file only this machine has is not counted and a tracked one cannot hide. Each finder is
 * a pure function over a list of paths or a text, and the last block plants each shape and sees it found.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources, readTrackedSources } from './_sources.mjs';

/** A tracked path whose only job is to take in outside code, by its file name, wherever it sits. */
const INVITING_NAME = /^(contributing(\.[a-z]+)?|contribution-guide\.md|cla(\.[a-z]+)?|dco(\.[a-z]+)?|pull_request_template(\.[a-z]+)?|code_of_conduct(\.[a-z]+)?)$/i;

/** The tracked paths that invite outside code: by name, or anything under a pull-request template folder. */
export function invitingFiles(paths) {
  return paths.filter((p) => {
    const parts = p.split('/');
    if (parts.includes('node_modules')) return false;
    return INVITING_NAME.test(parts[parts.length - 1]) || parts.some((s) => /^pull_request_template$/i.test(s));
  });
}

/** Where a workflow asks an author to sign an agreement: the signing action, or a signatures file. */
export function signingSteps(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const code = line.replace(/#.*$/, '');
    if (/uses:\s*['"]?(contributor-assistant|cla-assistant)\//i.test(code) || /path-to-signatures\s*:/.test(code)) found.push(i + 1);
  });
  return found;
}

/** Sentences that welcome someone else's code. Issues are welcome, so a line that welcomes only issues is not one. */
export function invitations(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    const welcomes = /\b(prs?|pull requests?|patch(es)?|contributions?)\b[^.\n]*\bwelcome\b/i.test(line)
      || /\bwelcome\b[^.\n]*\b(prs?|pull requests?|patch(es)?|contributions?)\b/i.test(line);
    const refuses = /\b(no|not|never)\b/i.test(line);
    if (welcomes && !refuses) found.push(i + 1);
  });
  return found;
}

/** Markdown links whose target is a contribution guide. */
export function contributionLinks(text) {
  const found = [];
  text.split(/\r?\n/).forEach((line, i) => {
    if (/\]\([^)]*(contribution-guide|CONTRIBUTING)(\.md)?(#[^)]*)?\)/.test(line)) found.push(i + 1);
  });
  return found;
}

const TRACKED = trackedSources(['.'], { ext: null, floor: 500 });

describe('the repository invites no outside code', () => {
  it('no tracked file is a contribution guide, a contributor agreement or a pull-request template', () => {
    assert.deepEqual(invitingFiles(TRACKED), [],
      'Ythril takes no outside code, so a file whose job is to take it in promises something the project does not do');
  });

  it('no workflow asks an author to sign an agreement', () => {
    const workflows = readTrackedSources(['.github/workflows'], { ext: ['.yml', '.yaml'], floor: 3 });
    const bad = workflows.flatMap(({ file, text }) => signingSteps(text).map((n) => `${file}:${n}`));
    assert.deepEqual(bad, [], 'a signing check runs on pull requests the project does not take');
  });

  it('the README says no outside code is taken, welcomes issues, and welcomes no pull request', () => {
    const readme = readFileSync(join(REPO_ROOT, 'README.md'), 'utf8');
    assert.deepEqual(invitations(readme).map((n) => `README.md:${n}`), []);
    assert.match(readme, /takes no outside code/i, 'the README no longer says that Ythril takes no outside code');
    assert.match(readme, /\bissues?\b/i, 'the README no longer says where a bug report goes');
  });

  it('no tracked page links to a contribution guide', () => {
    const pages = readTrackedSources(['README.md', 'docs', 'schema/README.md', 'testing'], { ext: ['.md'], floor: 30 });
    const bad = pages.flatMap(({ file, text }) => contributionLinks(text).map((n) => `${file}:${n}`));
    assert.deepEqual(bad, [], 'a link to a page that does not exist');
  });
});

describe('each finder finds the shape it exists for, and leaves the conforming one alone', () => {
  it('invitingFiles', () => {
    const planted = ['CONTRIBUTING.md', 'docs/contribution-guide.md', 'CLA.md', '.github/PULL_REQUEST_TEMPLATE.md',
      '.github/PULL_REQUEST_TEMPLATE/bug.md', 'CODE_OF_CONDUCT.md', '.github/contributing.rst'];
    assert.deepEqual(invitingFiles(planted), planted);
    assert.deepEqual(invitingFiles(['docs/dev-guide.md', 'SECURITY.md', '.github/ISSUE_TEMPLATE/bug_report.md',
      'node_modules/x/CONTRIBUTING.md', 'server/src/util/classify.ts', 'docs/decisions.md']), []);
  });

  it('signingSteps', () => {
    assert.deepEqual(signingSteps('steps:\n  - uses: contributor-assistant/github-action@v2.6.1\n    with:\n      path-to-signatures: signatures/cla.json\n'), [2, 4]);
    assert.deepEqual(signingSteps('steps:\n  # uses: contributor-assistant/github-action@v2\n  - uses: actions/checkout@v4\n'), []);
  });

  it('invitations', () => {
    assert.deepEqual(invitations('Issues and PRs welcome — keep changes scoped.'), [1]);
    assert.deepEqual(invitations('We welcome pull requests.'), [1]);
    assert.deepEqual(invitations('Contributions are welcome!'), [1]);
    assert.deepEqual(invitations('Bug reports and ideas are welcome as issues.\nYthril takes no outside code: pull requests are not welcome.'), []);
  });

  it('contributionLinks', () => {
    assert.deepEqual(contributionLinks('See the [Contribution Guide](docs/contribution-guide.md#testing).'), [1]);
    assert.deepEqual(contributionLinks('See [how](../CONTRIBUTING.md).'), [1]);
    assert.deepEqual(contributionLinks('See the [Dev Guide](docs/dev-guide.md); the old contribution-guide.md is gone.'), []);
  });
});
