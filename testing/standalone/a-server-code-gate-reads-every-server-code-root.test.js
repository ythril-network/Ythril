/**
 * A gate that scans the server's code names its roots through `SERVER_CODE_ROOTS`, never the literal `'server/src'` (Q-682).
 *
 * ## What it prevents
 *
 * The schema package's source (`schema/src`) is server code: the server imports it by name and runs it. When it was moved out of
 * `server/src`, about 140 gates still listed `'server/src'` alone, so the moved lines stopped being checked for size, redaction,
 * docblocks and list-in-prose rules, and nothing failed. A gate written the same way tomorrow would drop the next package the same
 * way. `SERVER_CODE_ROOTS` (`_sources.mjs`) is the one place the roots are named; a gate that scans server code reads it.
 *
 * ## The rule
 *
 * In every tracked `.js`, `.mjs` and `.cjs` under `testing/` and `scripts/`, a string literal that is exactly `server/src` (any quotes), found
 * in the file's syntax tree, is a scan of the server's code written without the schema package. A file that means `server/src` alone (a rule that is about the server's own tree, a planted fixture, a git command that is
 * the subject of a test) is named in `a-server-code-gate-reads-every-server-code-root.allow.json` with a reason and a reviewBy date.
 *
 * The scope is the repository's tracked files, so a new gate is covered the day it is written. The allowlist is read as data: an entry
 * with no reason, a past reviewBy, or a file that no longer holds the literal fails, and the count of entries is printed.
 *
 * Run: node --test testing/standalone/a-server-code-gate-reads-every-server-code-root.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, SERVER_CODE_ROOTS, readTrackedSources } from './_sources.mjs';
import { ts, parseSource, lineOf, walkEveryNode } from '../_shared/syntax-tree.mjs';

const ALLOW = JSON.parse(readFileSync(new URL('./a-server-code-gate-reads-every-server-code-root.allow.json', import.meta.url), 'utf8')).entries;
const FLOOR = 400;
/** The literal this rule is about, built from the constant so this file never spells it. */
const SERVER_ROOT = SERVER_CODE_ROOTS[0];
/**
 * `{ file, lines }` for every file with a string literal that is exactly the root. Read from the syntax tree: a comment that names the path, a
 * longer string that holds it (`'server/src/brain/x.ts'`, a fixture's prose) and a string inside a template are not scans; lines are the file's own.
 */
function aloneOf(sources) {
  const out = [];
  for (const { file, text } of sources) {
    const sf = parseSource(file, text);
    const lines = [];
    walkEveryNode(sf, n => {
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && n.text === SERVER_ROOT) lines.push(lineOf(sf, n));
    });
    if (lines.length) out.push({ file, lines });
  }
  return out;
}

const scripts = () => readTrackedSources(['testing', 'scripts'], { ext: ['.js', '.mjs', '.cjs'], floor: FLOOR });

describe('SERVER_CODE_ROOTS names the server code', () => {
  it('holds the server and the schema package, both directories of tracked sources', () => {
    assert.deepEqual(SERVER_CODE_ROOTS.map(r => r.split('/')[0]), ['server', 'schema']);
    assert.ok(SERVER_CODE_ROOTS.every(r => r.endsWith('/src')));
    for (const root of SERVER_CODE_ROOTS) {
      const found = readTrackedSources(root, { floor: 10 });
      assert.ok(found.every(f => f.file.startsWith(`${root}/`)), root);
    }
  });
});

describe('a gate over the server code reads every root', () => {
  it('no gate names the server root alone, but those the allowlist explains', () => {
    const allowed = new Set(ALLOW.map(e => e.file));
    const offenders = aloneOf(scripts()).filter(o => !allowed.has(o.file));
    assert.deepEqual(offenders.map(o => `${o.file}:${o.lines.join(',')}`), [],
      'these name the server root alone and so skip schema/src: read SERVER_CODE_ROOTS (testing/standalone/_sources.mjs), or add the file to the .allow.json with a reason');
  });

  it('every allowlist entry has a reason, a future reviewBy, and a file that still names the root alone', () => {
    const today = new Date().toISOString().slice(0, 10);
    const holding = new Set(aloneOf(scripts()).map(o => o.file));
    for (const e of ALLOW) {
      assert.ok(typeof e.reason === 'string' && e.reason.length >= 20, `${e.file}: a reason of at least 20 characters`);
      assert.match(e.reviewBy ?? '', /^\d{4}-\d{2}-\d{2}$/, `${e.file}: reviewBy`);
      assert.ok(e.reviewBy > today, `${e.file}: reviewBy ${e.reviewBy} has passed`);
      assert.ok(holding.has(e.file), `${e.file} no longer names the root alone: drop its entry`);
    }
    console.log(`server-code root allowlist: ${ALLOW.length} entries`);
  });

  it('fails on a planted copy: a real gate with its constant put back to the literal', () => {
    const real = readFileSync(join(REPO_ROOT, 'testing/standalone/_oversize-files.mjs'), 'utf8');
    assert.ok(real.includes('SERVER_CODE_ROOTS'), 'the model gate reads the constant');
    const planted = real.replaceAll('SERVER_CODE_ROOTS', `['${SERVER_ROOT}']`);
    assert.equal(aloneOf([{ file: 'planted.mjs', text: real }]).length, 0, 'the real gate is clean');
    assert.equal(aloneOf([{ file: 'planted.mjs', text: planted }]).length, 1, 'the planted copy is caught');
    const withComment = `// scans '${SERVER_ROOT}'\n${real}`;
    assert.equal(aloneOf([{ file: 'c.mjs', text: withComment }]).length, 0, 'a comment naming it is not a scan');
    const longer = `const f = "git ls-files '${SERVER_ROOT}'; ${SERVER_ROOT}/brain/x.ts"; const g = '${SERVER_ROOT}/brain';`;
    assert.equal(aloneOf([{ file: 'l.mjs', text: longer }]).length, 0, 'a longer string that holds the path is not a scan');
    assert.deepEqual(aloneOf([{ file: 'p.mjs', text: `\n\nconst x = trackedSources('${SERVER_ROOT}');` }]), [{ file: 'p.mjs', lines: [3] }]);
  });
});
