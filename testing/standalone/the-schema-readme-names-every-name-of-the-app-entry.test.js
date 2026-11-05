/**
 * `schema/README.md`'s export table names every name the schema package's app entry exports, and no other (Q-668, docs lens S2).
 *
 * ## The defect this prevents
 *
 * The README told an app author "What else is exported" and listed about 43 of the 61 values and 28 types the entry has; the integration guide
 * (`06a-schema-api.md`) says "its README lists every export". The surface test holds the entry to a fixed list, so a new export is a
 * decision, but nothing held the README to that list: an export added or renamed there left the table naming a name that is gone, or silent
 * about one that is public. A table that "lists every export" is a claim a machine can check.
 *
 * ## What is held
 *
 * - Every name in `APP_VALUES` and `APP_TYPES` (`_schema-app-entry-names.mjs`, the list the surface test holds the built entry to) is in the
 *   first column of the table under "What else is exported".
 * - Every name the first column holds is in one of the two lists: a table that names an export the entry lacks is as wrong as one that omits one.
 * - No name is listed twice.
 * - The reader has floors: an unread section gives no names, and "no name missing from nothing" passes by accident.
 * - The planted copies: the README with one name dropped, one invented and one listed twice are each refused by the same function.
 *
 * Run: node --test testing/standalone/the-schema-readme-names-every-name-of-the-app-entry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { APP_VALUES, APP_TYPES } from './_schema-app-entry-names.mjs';
import { tableNames as readTableNames, tableGaps as readTableGaps } from './_readme-export-table.mjs';

const README = join(REPO_ROOT, 'schema', 'README.md');
const SECTION = 'What else is exported';

/** The readers are `_readme-export-table.mjs`, the one reader every README gate shares; this gate reads its own section. */
const tableNames = (readme) => readTableNames(readme, SECTION);
const tableGaps = (readme, expected) => readTableGaps(readme, expected, SECTION);

const EXPECTED = [...APP_VALUES, ...APP_TYPES];

describe('the reader this gate stands on', () => {
  it('reads the table, and the lists it is held to are whole', () => {
    const names = tableNames(readFileSync(README, 'utf8'));
    // Floors: an unread table gives no names, and a list read short would hold the README to less than the entry exports.
    assert.ok(APP_VALUES.length >= 50 && APP_TYPES.length >= 20, 'the app entry lists are read short');
    assert.ok(names.length >= 50, `the table reads ${names.length} names: the reader is broken`);
    assert.ok(names.includes('validateSpaceMeta') && names.includes('TypeSchema'));
    assert.equal(new Set(EXPECTED).size, EXPECTED.length, 'a name is in both lists, or in one twice');
  });

  it('planted copies: a name dropped from the table, one invented, one listed twice', () => {
    const real = readFileSync(README, 'utf8');
    assert.deepEqual(tableGaps(real, EXPECTED), { missing: [], extra: [], repeated: [] }, 'the real README is the baseline');
    const dropped = real.replace('`hasReDoSRisk`, ', '');
    assert.notEqual(dropped, real, 'the plant must change the README');
    assert.deepEqual(tableGaps(dropped, EXPECTED).missing, ['hasReDoSRisk']);
    const invented = real.replace('`hasReDoSRisk`, ', '`hasReDoSRisk`, `notAnExport`, ');
    assert.deepEqual(tableGaps(invented, EXPECTED).extra, ['notAnExport']);
    const doubled = real.replace('`hasReDoSRisk`, ', '`hasReDoSRisk`, `peerText`, ');
    assert.deepEqual(tableGaps(doubled, EXPECTED).repeated, ['peerText']);
  });
});

describe('schema/README.md lists every export of the app entry', () => {
  it('names every value and type, and nothing else', () => {
    const gaps = tableGaps(readFileSync(README, 'utf8'), EXPECTED);
    assert.deepEqual(gaps.missing, [], `the README's "${SECTION}" table lacks: ${gaps.missing.join(', ')}`);
    assert.deepEqual(gaps.extra, [], `the README's "${SECTION}" table names what the app entry does not export: ${gaps.extra.join(', ')}`);
    assert.deepEqual(gaps.repeated, [], `the README's "${SECTION}" table names twice: ${gaps.repeated.join(', ')}`);
  });
});
