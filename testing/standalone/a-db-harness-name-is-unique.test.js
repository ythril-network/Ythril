/**
 * Every harness database name is unique — because the offline suite runs in PARALLEL.
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
 * ## Derived, never listed — however the name reaches the harness (Q-792)
 *
 * The subject is every name the tree hands the harness (`_harness-names.mjs`): a literal or a same-file `const`, given to
 * `openTestMongo` or to any door that reaches it (`openPushDoor`, `openPullDoor`, `openViewDoors`, ...) positionally or as
 * `suite:`. The sweep was a regex over literal `openTestMongo('x')` and three hand-listed wrappers; it saw about half the
 * claims, and the clash `gonedel` (an `openPullDoor` in one file, an `openPushDoor` in another) hid in the other half. A site
 * whose name the sweep cannot resolve is named in `_harness-names.allow.json`, so a new one fails here rather than going
 * unchecked. A planted copy of two real files proves the sweep finds a const-named claim, a `suite:` claim through a wrapper,
 * and the clash each copy makes with its original.
 *
 * Run: node --test testing/standalone/a-db-harness-name-is-unique.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as sweep from './_harness-names.mjs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const { harnessNames } = sweep;

/** Set from the count measured when the sweep moved to the syntax tree (Q-792: 722 claim sites; the old regex found 306). */
const NAME_FLOOR = 700;

const ALLOW = JSON.parse(readFileSync(new URL('./_harness-names.allow.json', import.meta.url), 'utf8'));
const ENTRIES = ALLOW.entries ?? [];

/** Names claimed by more than one file, as `name: fileA, fileB`. */
function clashesOf(claims) {
  const byName = new Map();
  for (const { file, name } of claims) byName.set(name, new Set([...(byName.get(name) ?? []), file]));
  return [...byName].filter(([, files]) => files.size > 1).map(([name, files]) => `${name}: ${[...files].join(', ')}`);
}

describe('a db harness name is unique', () => {
  it('the sweep finds the DB-backed files, so an empty set cannot pass', () => {
    // An empty scan passes every loop written over it and reports a green tick about nothing.
    const names = harnessNames();
    assert.ok(names.length >= NAME_FLOOR,
      `only ${names.length} harness name(s) found, below the floor of ${NAME_FLOOR} — the sweep is broken, not the tests`);
  });

  it('no two files open the same harness database', () => {
    const clashes = clashesOf(harnessNames());
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

  it('the timing reporter\'s suite: is no claim, because the function it is passed to reaches no harness', () => {
    const reporter = harnessNames().filter(n => n.file.startsWith('testing/_init/') || n.file === 'testing/_shared/test-times-harness.mjs');
    assert.deepEqual(reporter.map(n => `${n.file}:${n.line} -> '${n.name}'`), [], 'a suite: that opens no database was read as a claim');
  });
});

describe('the sweep sees a name however it reaches the harness (planted copies of real files)', () => {
  // Copies of two real files under new names, added to the real tree: each copy claims what its original claims, so each makes
  // a clash with it. The const-named call is `openTestMongo(SUITE)`; the wrapper claim is `openPullDoor({ suite: '...' })`.
  const CONST_NAMED = 'testing/standalone/a-backup-never-carries-a-read-spill-db.test.js';
  const THROUGH_WRAPPER = 'testing/standalone/a-byte-arrival-emits-nothing-db.test.js';
  const real = readTrackedSources('testing', { ext: ['.test.js', '.mjs'], floor: 100 })
    .map(({ file, text }) => ({ file: file.replace(/\\/g, '/'), text }));
  const copyOf = (file) => ({ file: file.replace(/([^/]+)$/, 'planted-copy-of-$1'), text: real.find(s => s.file === file).text });
  const planted = [copyOf(CONST_NAMED), copyOf(THROUGH_WRAPPER)];

  it('the originals still carry the shapes the control plants', () => {
    assert.match(stripComments(real.find(s => s.file === CONST_NAMED).text), /openTestMongo\(\s*[A-Z_]+\s*\)/, `${CONST_NAMED} no longer opens the harness through a const`);
    assert.match(stripComments(real.find(s => s.file === THROUGH_WRAPPER).text), /openPullDoor\(\s*\{\s*suite:\s*'/, `${THROUGH_WRAPPER} no longer claims through openPullDoor's suite:`);
  });

  it('finds the const-named claim, the claim through a wrapper, and the clash each copy makes with its original', () => {
    const claims = harnessNames([...real, ...planted]);
    for (const p of planted) {
      const names = claims.filter(c => c.file === p.file).map(c => c.name);
      assert.ok(names.length > 0, `the planted ${p.file} claims nothing: the sweep cannot see how it reaches the harness`);
      const clashes = clashesOf(claims);
      for (const name of names) {
        assert.ok(clashes.some(c => c.startsWith(`${name}: `) && c.includes(p.file)), `the planted copy's '${name}' clash with its original is not found`);
      }
    }
  });
});

describe(`the unresolved harness sites (${ENTRIES.length} named in _harness-names.allow.json)`, () => {
  const today = new Date().toISOString().slice(0, 10);
  const label = (e) => `${e.file}: ${e.expression}`;

  it('every site whose name the sweep cannot resolve is named in the allowlist', () => {
    assert.equal(typeof sweep.unresolvedHarnessSites, 'function', 'the sweep does not report the sites it cannot resolve');
    const open = sweep.unresolvedHarnessSites().filter(u => !ENTRIES.some(e => e.file === u.file && e.expression === u.expression));
    assert.deepEqual(open.map(u => `${u.file}:${u.line} ${u.expression}`), [],
      'the sweep cannot resolve the name these sites hand the harness, so no clash on them can be seen: hand it a literal or a '
      + 'same-file const, or name the site in _harness-names.allow.json with a reason and a reviewBy date');
  });

  it('every entry still names a site the sweep cannot resolve', () => {
    const sites = sweep.unresolvedHarnessSites?.() ?? [];
    const stale = ENTRIES.filter(e => !sites.some(u => u.file === e.file && u.expression === e.expression));
    assert.deepEqual(stale.map(label), [], 'these entries name no unresolved site any more: remove them');
  });

  it('every entry has a file, an expression, a reason of three words or more and a reviewBy date not yet past', () => {
    const bad = ENTRIES.filter(e => !(typeof e.file === 'string' && typeof e.expression === 'string'
      && typeof e.reason === 'string' && e.reason.trim().split(/\s+/).length >= 3
      && typeof e.reviewBy === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy)
      && !Number.isNaN(Date.parse(e.reviewBy)) && new Date(e.reviewBy).toISOString().slice(0, 10) === e.reviewBy));
    assert.deepEqual(bad.map(label), [], 'each entry needs file, expression, reason (3+ words) and reviewBy (YYYY-MM-DD)');
    const late = ENTRIES.filter(e => e.reviewBy < today);
    assert.deepEqual(late.map(e => `${label(e)} (reviewBy ${e.reviewBy}, today ${today})`), [], 'review the entry: resolve the site, or renew the date with a reason');
  });
});
