/**
 * Every `openTestMongo` suite name is unique — because the offline suite runs in PARALLEL.
 *
 * ## What a duplicate costs, and only since the suite went parallel
 *
 * `openTestMongo('foo')` connects to `ythril_harness_foo` and **drops that database on entry and on
 * exit**. The drop is deliberate: a run killed mid-test would otherwise leave documents behind and the
 * next run would inherit them, which is how a database-backed suite starts passing for the wrong reason.
 *
 * Two files sharing a name were harmless while every file ran one at a time — the second simply started
 * from a clean database, which is what it wanted anyway. Under parallelism they run at the SAME TIME and
 * each drops the other's data mid-assertion. The failure is intermittent, blames whichever file was
 * unlucky, and says nothing about the name it shares.
 *
 * So this is not tidiness. It is the guard that the change to parallel execution owes.
 *
 * ## Derived, never listed
 *
 * The subject is every `openTestMongo('…')` call in the tree. A list of known names would be a second
 * copy of a fact the files already hold, and a new file is in scope the day it is written.
 *
 * Run: node --test testing/standalone/a-db-harness-name-is-unique.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** Every literal suite name handed to the harness, with the file that used it. */
function harnessNames() {
  const found = [];
  for (const { file, text } of readTrackedSources('testing', { ext: ['.test.js', '.mjs'], floor: 100 })) {
    // The harness module DEFINES the function and takes the name as a parameter — it claims no database.
    if (file.replace(/\\/g, '/').endsWith('_mongo-harness.mjs')) continue;
    for (const m of stripComments(text).matchAll(/openTestMongo\(\s*'([^']+)'/g)) {
      found.push({ file: file.replace(/\\/g, '/'), name: m[1] });
    }
  }
  return found;
}

describe('a db harness name is unique', () => {
  it('the sweep finds the DB-backed files, so an empty set cannot pass', () => {
    // An empty scan passes every loop written over it and reports a green tick about nothing.
    const names = harnessNames();
    assert.ok(names.length >= 30,
      `only ${names.length} harness name(s) found — the sweep is broken, not the tests`);
  });

  it('no two files open the same harness database', () => {
    const byName = new Map();
    for (const { file, name } of harnessNames()) {
      byName.set(name, [...(byName.get(name) ?? []), file]);
    }
    const clashes = [...byName.entries()]
      .filter(([, files]) => files.length > 1)
      .map(([name, files]) => `${name}: ${files.join(', ')}`);
    assert.deepEqual(clashes, [],
      'these files share a harness database:\n  ' + clashes.join('\n  ')
      + '\n\n      `openTestMongo` DROPS the database on entry and on exit, and the offline standalone'
      + '\n      suite runs in parallel — so two files sharing a name delete each other\'s documents'
      + '\n      mid-assertion. The failure is intermittent and blames whichever file was unlucky.'
      + '\n      Give each file its own name; it is only a label.');
  });

  it('a name says which file it belongs to, loosely — so a clash is obvious in review', () => {
    /*
     * Not an exact derivation, deliberately: the names are short by hand (`hopbound`, `linkconvert`) and
     * forcing them to match a filename would be churn for no safety. What IS checked is that a name is
     * not so generic that the next author reaches for it too — the clash above is the real guard, and
     * this only keeps the obvious collisions from being written in the first place.
     */
    const generic = harnessNames().filter(n => ['test', 'db', 'tmp', 'suite', 'x'].includes(n.name));
    assert.deepEqual(generic.map(n => `${n.file} -> '${n.name}'`), [],
      'a harness name this generic is one the next file will pick too');
  });
});
