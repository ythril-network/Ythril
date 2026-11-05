/**
 * `schema/README.md` names every name `@ythril/schema/from-typescript` exports in a section of its own, and lists every reason of its closed lists, no
 * more and no fewer (Q-687, design v3 items 11, 12 and 14).
 *
 * ## The defect this prevents
 *
 * The app entry's README table is held to the entry's list (`the-schema-readme-names-every-name-of-the-app-entry.test.js`); the from-typescript entry is
 * a second public surface behind its own export, with its own names and a closed list of reasons an app's `switch` reads (`UNREPRESENTED_REASONS`). A
 * name added there with no README row, or a reason added with no bullet, leaves an app author to read the source; and the README's own sentence for the
 * forward direction ("the whole list ... a reason added is a deliberate edit an app's switch can see") was a claim no test held either.
 *
 * ## What is held
 *
 * - The README has the section `## Read a space meta from TypeScript`; the first column of its table holds every name of `FROM_TYPESCRIPT_VALUES` and
 *   `FROM_TYPESCRIPT_TYPES` (`_schema-app-entry-names.mjs`), no other name, and no name twice. The section is its own: the app entry's table
 *   (`What else is exported`) names none of them.
 * - The section's bullets list exactly the reasons of the built `UNREPRESENTED_REASONS`, each once. The forward direction's `UNTRANSLATED_REASONS` is held the
 *   same way to its bullets under `Generate TypeScript types` (the baseline this follows).
 * - The readers have floors, and are proven on planted READMEs: a name dropped, one invented, one listed twice, a reason dropped, one invented.
 *
 * Run: node --test testing/standalone/the-schema-readme-names-every-name-of-the-from-typescript-entry.test.js
 * (requires a prior `npm run build -w @ythril/schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './_sources.mjs';
import { FROM_TYPESCRIPT_VALUES, FROM_TYPESCRIPT_TYPES } from './_schema-app-entry-names.mjs';
import { tableNames, tableGaps, bulletReasons } from './_readme-export-table.mjs';
import * as app from '../../schema/dist/index.js';

const README = join(REPO_ROOT, 'schema', 'README.md');
const SECTION = 'Read a space meta from TypeScript';
const FORWARD_SECTION = 'Generate TypeScript types';
const EXPECTED = [...FROM_TYPESCRIPT_VALUES, ...FROM_TYPESCRIPT_TYPES];

/** What the bullets list that the tuple lacks, what the tuple has that no bullet lists, and what a bullet lists twice. */
function reasonGaps(readme, section, tuple) {
  const listed = bulletReasons(readme, section);
  return {
    missing: [...tuple].filter(r => !listed.includes(r)).sort(),
    extra: listed.filter(r => !tuple.includes(r)).sort(),
    repeated: listed.filter((r, i) => listed.indexOf(r) !== i).sort(),
  };
}

/** A README of the shape the real one has: the section, a table, bullets. Planted rows start from it. */
const PLANTED = [
  '# pkg', '', `## ${SECTION}`, '',
  '| export | what it is |', '| --- | --- |',
  `| \`${FROM_TYPESCRIPT_VALUES.join('`, `')}\` | values |`,
  `| \`${FROM_TYPESCRIPT_TYPES.join('`, `')}\` | types |`, '',
  '- `first-reason`: one', '- `second-reason`: two', '', '## Next', '',
  '| `NotInThisSection` | x |', '- `not-a-reason`: y', '',
].join('\n');

describe('the readers this gate stands on (proved on planted READMEs)', () => {
  it('read the section\'s table and bullets, and stop at the next section', () => {
    assert.deepEqual(tableNames(PLANTED, SECTION), EXPECTED);
    assert.deepEqual(bulletReasons(PLANTED, SECTION), ['first-reason', 'second-reason']);
    assert.ok(EXPECTED.length >= 6, 'the entry lists are read short');
  });

  it('a missing section throws: it never reads as "no names"', () => {
    assert.throws(() => tableNames('# pkg\n\n## Other\n', SECTION), /has no "## Read a space meta from TypeScript" section/);
    assert.throws(() => bulletReasons('# pkg\n', SECTION), /has no "##/);
  });

  it('a name dropped, one invented and one listed twice are each named', () => {
    assert.deepEqual(tableGaps(PLANTED, EXPECTED, SECTION), { missing: [], extra: [], repeated: [] });
    const dropped = PLANTED.replace(`\`${FROM_TYPESCRIPT_TYPES[0]}\`, `, '');
    assert.notEqual(dropped, PLANTED);
    assert.deepEqual(tableGaps(dropped, EXPECTED, SECTION).missing, [FROM_TYPESCRIPT_TYPES[0]]);
    assert.deepEqual(tableGaps(PLANTED.replace('| values |', ', `notAnExport` | values |'), EXPECTED, SECTION).extra, ['notAnExport']);
    assert.deepEqual(tableGaps(PLANTED.replace('| values |', `, \`${FROM_TYPESCRIPT_TYPES[1]}\` | values |`), EXPECTED, SECTION).repeated, [FROM_TYPESCRIPT_TYPES[1]]);
  });

  it('a reason dropped, one invented and one listed twice are each named', () => {
    const tuple = ['first-reason', 'second-reason'];
    assert.deepEqual(reasonGaps(PLANTED, SECTION, tuple), { missing: [], extra: [], repeated: [] });
    assert.deepEqual(reasonGaps(PLANTED, SECTION, [...tuple, 'third-reason']).missing, ['third-reason']);
    assert.deepEqual(reasonGaps(PLANTED.replace('- `second-reason`: two', '- `second-reason`: two\n- `made-up`: no'), SECTION, tuple).extra, ['made-up']);
    assert.deepEqual(reasonGaps(PLANTED.replace('- `first-reason`: one', '- `first-reason`: one\n- `first-reason`: again'), SECTION, tuple).repeated, ['first-reason']);
  });
});

describe('schema/README.md states the from-typescript entry', () => {
  const readme = () => readFileSync(README, 'utf8');

  it(`has a section "## ${SECTION}" whose table names every name of the entry, and no other`, () => {
    const gaps = tableGaps(readme(), EXPECTED, SECTION);
    assert.deepEqual(gaps.missing, [], `the README's "${SECTION}" table lacks: ${gaps.missing.join(', ')}`);
    assert.deepEqual(gaps.extra, [], `the README's "${SECTION}" table names what the entry does not export: ${gaps.extra.join(', ')}`);
    assert.deepEqual(gaps.repeated, [], `the README's "${SECTION}" table names twice: ${gaps.repeated.join(', ')}`);
  });

  it('the app entry\'s table names none of them (the entry is behind its own export)', () => {
    const inMain = tableNames(readme(), 'What else is exported').filter(n => EXPECTED.includes(n));
    assert.deepEqual(inMain, [], 'the app entry\'s README table lists a from-typescript name');
    assert.ok(EXPECTED.every(n => !(n in app)), 'the app entry exports a from-typescript name');
  });

  it('its bullets list exactly the reasons of UNREPRESENTED_REASONS, each once', async () => {
    const built = join(REPO_ROOT, 'schema', 'dist', 'from-typescript.js');
    assert.ok(existsSync(built), 'schema/dist/from-typescript.js does not exist: the entry is not built (or not written)');
    const { UNREPRESENTED_REASONS } = await import(pathToFileURL(built).href);
    assert.ok(UNREPRESENTED_REASONS.length >= 12, 'UNREPRESENTED_REASONS is read short');
    const gaps = reasonGaps(readme(), SECTION, UNREPRESENTED_REASONS);
    assert.deepEqual(gaps.missing, [], `the README's "${SECTION}" bullets lack the reasons: ${gaps.missing.join(', ')}`);
    assert.deepEqual(gaps.extra, [], `the README's "${SECTION}" bullets list reasons the entry does not have: ${gaps.extra.join(', ')}`);
    assert.deepEqual(gaps.repeated, [], `the README's "${SECTION}" bullets list twice: ${gaps.repeated.join(', ')}`);
  });

  it('the forward direction\'s UNTRANSLATED_REASONS is held to its bullets the same way', () => {
    const gaps = reasonGaps(readme(), FORWARD_SECTION, app.UNTRANSLATED_REASONS);
    assert.ok(app.UNTRANSLATED_REASONS.length >= 10, 'UNTRANSLATED_REASONS is read short');
    assert.deepEqual(gaps, { missing: [], extra: [], repeated: [] });
  });
});
