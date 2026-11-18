/**
 * The in-product Help page offers every shipped guide — and every guide it offers actually ships.
 *
 * This is the gate for a failure with no error message. `HELP_DOCS` is a hand-written list (deliberately:
 * it is what keeps the document id out of any concatenated path, so there is no traversal surface), which
 * means the two ways it can rot are both silent:
 *
 *  1. A new file lands in `docs/` and nobody adds it here. The guide exists, ships in the image, and is
 *     unreachable from the product — the exact "you have to leave the UI" problem this page closed.
 *  2. A file is renamed or deleted and the entry stays. The build copies nothing, the fetch 404s, and the
 *     only person who finds out is the operator who clicked it.
 *
 * It also checks the pieces that make the assets appear at all — the angular.json glob and the
 * Dockerfile COPY. Without the COPY the glob resolves to nothing in the image and Help ships empty,
 * which no unit test of the component can see because the component is fine.
 *
 * Run: node --test testing/standalone/help-docs-coverage.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const HELP_COMPONENT = 'client/src/app/pages/settings/help.component.ts';
const src = readFileSync(HELP_COMPONENT, 'utf8');

/**
 * Every markdown path HELP_DOCS references — the `file:` of each entry, plus the `parts:` of a guide
 * that is split across files.
 *
 * The parts matter here for the same reason the whole check exists: `git ls-files 'docs/*.md'` does not
 * descend, so before this the seventeen files of the split integration guide were invisible to BOTH
 * sides of the comparison and the gate would have gone on passing while shipping nothing.
 */
const listed = [
  ...[...src.matchAll(/file:\s*'([^']+)'/g)].map(m => m[1]),
  // ANY nested folder, not just `integration-guide/`. The pattern used to name that one folder literally, so
  // `docs/decisions/` arrived as three shipped-but-unoffered files and this gate — correctly — went red. Naming the
  // folder was the narrow part: a second split guide is exactly the case the check exists for, and hardcoding the
  // first one meant the second could only be caught by failing.
  ...[...src.matchAll(/'([a-z0-9][a-z0-9-]*\/[^']+\.md)'/g)].map(m => m[1]),
];
/** The `id:` values, needed for the i18n check. */
const ids = [...src.matchAll(/id:\s*'([^']+)',\s*file:/g)].map(m => m[1]);

/**
 * What SHIPS is what git tracks — not what happens to be in the working tree.
 *
 * `readdirSync` was wrong here and cost a red CI run: `docs/docker-build-protocol.md` is gitignored, so
 * it exists on a maintainer's disk and in no clone, no image and no build. The filesystem view made this
 * gate demand a Help entry for it, and that entry would have 404'd for every user. A local-only file is
 * invisible to the build, so it must be invisible to the check that guards the build.
 */
// `docs/*.md` does not descend; `docs/**/*.md` in git's pathspec does not mean what a shell glob means
// either. Two explicit patterns, so a nested guide cannot hide from this the way the split parts would
// have. (The repo has one level of nesting; a third pattern is cheaper than a wrong assumption.)
const shippedGuides = execFileSync('git', ['ls-files', 'docs/*.md', 'docs/*/*.md'], { encoding: 'utf8' })
  .split('\n').filter(Boolean).map(p => p.replace(/^docs\//, ''));

/**
 * The files the client build copies into `assets/docs` from the REPOSITORY ROOT, read from angular.json: an asset
 * entry whose input is `..` and whose output is `assets/docs` names them by its glob. Today that is NOTICE, the
 * third-party notices (`Q-916`): Markdown that lives beside the licence and not under `docs/`, so the `docs/` listing
 * above cannot see it. Only a tracked file counts, for the same reason as above.
 */
const rootDocs = Object.values(JSON.parse(readFileSync('client/angular.json', 'utf8')).projects ?? {})
  .flatMap(project => project?.architect?.build?.options?.assets ?? [])
  .filter(a => typeof a === 'object' && a.input === '..' && a.output === 'assets/docs' && /^[A-Za-z0-9._-]+$/.test(a.glob ?? ''))
  .map(a => a.glob)
  .filter(name => execFileSync('git', ['ls-files', '--', name], { encoding: 'utf8' }).trim() === name);

const shipped = [...shippedGuides, ...rootDocs];

describe('Help page — the offered guides and the shipped ones are the same set', () => {
  it('offers every tracked markdown file in docs/', () => {
    // A `git ls-files` that returned nothing would make this assertion vacuous. (The next test would
    // fail loudly in that case, but a check that can quietly check nothing is worth ruling out here.)
    assert.ok(shipped.length > 0, 'no tracked docs found — the check would be measuring nothing');
    const missing = shipped.filter(f => !listed.includes(f));
    assert.deepEqual(missing, [],
      `these guides ship but the Help page does not offer them — add them to HELP_DOCS in ${HELP_COMPONENT}`);
  });

  it('offers nothing that does not ship', () => {
    const dangling = listed.filter(f => !shipped.includes(f));
    assert.deepEqual(dangling, [],
      `HELP_DOCS points at files that are not in docs/ — the fetch would 404 for the operator who clicks it`);
  });

  it('gives every offered guide a title in all three locales', () => {
    // set-claim: the shipped UI locales, as a coverage input. A fourth locale is a product decision.
    // An unregistered key renders as the raw key — visible, but it looks like a bug rather than a guide.
    for (const locale of ['en', 'de', 'pl']) {
      const dict = JSON.parse(readFileSync(`client/public/assets/i18n/${locale}.json`, 'utf8'));
      for (const id of ids) {
        assert.ok(dict[`help.doc.${id}`], `${locale}.json is missing help.doc.${id}`);
      }
    }
  });
});

describe('Help page — the third-party notices are readable inside the instance (Q-916)', () => {
  // NOTICE ships in the image, where a user of the web client never sees it. The About page points to it, and the
  // pointer is only worth something if the document behind it is offered, copied by the build and copied into the
  // stage that runs the build.
  const NOTICES = 'NOTICE';

  it('the Help page offers the notices file', () => {
    assert.ok(listed.includes(NOTICES), `HELP_DOCS in ${HELP_COMPONENT} has no entry whose file is ${NOTICES}`);
  });

  it('angular.json copies the notices file from the repository root into assets/docs', () => {
    assert.ok(rootDocs.includes(NOTICES),
      `client/angular.json has no asset { "glob": "${NOTICES}", "input": "..", "output": "assets/docs" }: the Help entry would 404`);
  });

  it('the Dockerfile copies the notices file into the client build stage', () => {
    const df = readFileSync('Dockerfile', 'utf8');
    const clientStage = df.slice(0, df.indexOf('AS builder'));
    const buildAt = clientStage.search(/RUN\s+npm run build:prod --workspace=client/);
    const copyAt = clientStage.search(/^COPY\s+NOTICE\s+\.\/\s*$/m);
    assert.ok(buildAt >= 0, 'the client stage no longer runs `npm run build:prod --workspace=client`: this case reads the wrong stage');
    assert.ok(copyAt >= 0 && copyAt < buildAt,
      'the client build stage must `COPY NOTICE ./` before the build: without it the asset glob matches nothing in the image and the page links to a document that is not there');
  });

  it('the About page links to it', () => {
    const about = readFileSync('client/src/app/pages/settings/about.component.ts', 'utf8');
    const id = [...src.matchAll(/id:\s*'([^']+)',\s*file:\s*'NOTICE'/g)].map(m => m[1])[0];
    assert.ok(id, 'no Help id is declared for the notices file');
    assert.ok(about.includes(`doc: '${id}'`), `about.component.ts has no link carrying the query parameter doc: '${id}'`);
  });
});

describe('Help page — the assets actually reach the build', () => {
  it('angular.json copies docs/*.md into the client assets', () => {
    const ng = readFileSync('client/angular.json', 'utf8');
    assert.ok(ng.includes('"input": "../docs"'),
      'the docs asset glob is gone — Help would render nothing, with no build error');
    assert.ok(ng.includes('assets/docs'), 'the docs assets must land under assets/docs, where the page fetches them');
  });

  it('the Dockerfile copies docs/ into the client build stage', () => {
    // The glob above is relative to client/, so without this COPY the image builds cleanly and ships a
    // Help page with nothing behind it.
    const df = readFileSync('Dockerfile', 'utf8');
    const clientStage = df.slice(0, df.indexOf('AS builder'));
    assert.ok(/COPY\s+docs\/\s+\.\/docs\//.test(clientStage),
      'the client build stage must COPY docs/ — otherwise the asset glob matches nothing in the image');
  });
});
