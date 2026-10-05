/**
 * `expected-in-ci:` is the one prefix that lets a skip pass the CI gate — so it is allowed in a LISTED file,
 * and names ONE cause.
 *
 * ## The failure this prevents
 *
 * The aggregator fails a CI run on any skip it did not expect (a skip is a test that proved nothing, and a green
 * run with skips in it is how an unbuilt client, a missing sidecar and an embedder that never came up each read
 * as "passing"). The exception is a skip whose reason starts `expected-in-ci:`: the LoCoMo corpus is fetched by
 * URL against a pinned hash and never committed, so the tests that read it cannot run on a runner that did not
 * fetch it, and saying so with a skip is honest.
 *
 * An exception with no owner spreads. Written into a red-team test it would turn "the stack never came up" into
 * an expected skip, and every unexpected skip the gate exists to catch would be one `expected-in-ci:` away from
 * passing. Two limits keep it what it was for:
 *
 *  1. **Only the files on the list below may carry it**, each with the reason it is allowed. A new corpus-reading
 *     test has to be added HERE, in review, on purpose — and the list is checked both ways: every listed file
 *     really carries the prefix (a list entry cannot outlive its test), and every test file that reads a corpus
 *     path is on it (a new reader cannot skip unlisted).
 *  2. **One cause per skip.** `the-extractor-finds-its-mentions` skipped for TWO reasons joined by `||` — the corpus
 *     is not fetched, or the NLP sidecar is not running — and printed one message for both. The first is expected
 *     on CI; the second is the sidecar being down, which must fail there. A prefix over both would excuse the
 *     second. The reason names the one cause the file is allowed (`corpus not fetched`) and nothing else, and
 *     the other cause throws under CI instead of skipping.
 *
 * ## Why a position, not a substring
 *
 * The prefix is looked for where it can excuse something — the argument of a `skip(...)` call, the value of a
 * `skip:` option, a binding or helper whose name says skip. Looking for the text would make this file refuse its
 * own fixtures, and every doc that explains the prefix.
 *
 * Run: node --test testing/standalone/a-skip-that-expects-ci-lives-in-a-listed-file.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import ts from 'typescript';
import { readFileSync } from 'node:fs';
import { testAndHelperFiles, staticText, inSkipPosition } from './_test-bodies.mjs';
import { parseSource, lineOf } from '../_shared/syntax-tree.mjs';
import { EXPECTED_IN_CI, EXPECTED_IN_CI_PREFIX as PREFIX } from '../_shared/expected-in-ci.mjs';
import { REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

// THE LIST lives in `testing/_shared/expected-in-ci.mjs`, because two readers ask it two questions: this gate (may a
// SOURCE carry the prefix) and `scripts/unexpected-skips.mjs` (may a RUN's skip stand). Written in this file it was one
// reader's copy; a second reader would have kept its own and the two lists could disagree about which files CI excuses.

/** Every skip reason in `text` that carries the prefix: `{ line, reason }`. */
export function expectedInCiSkips(file, text) {
  const sf = parseSource(file, text);
  const out = [];
  const visit = (n) => {
    const reason = ts.isStringLiteralLike(n) || ts.isTemplateExpression(n) ? staticText(n) : null;
    if (reason !== null && reason.includes(PREFIX) && inSkipPosition(n)) out.push({ line: lineOf(sf, n), reason });
    ts.forEachChild(n, visit);
  };
  visit(sf);
  return out;
}

/** The text after the prefix must be one of the file's causes, optionally followed by ` — detail` that joins nothing. */
function oneCause(reason, causes) {
  const rest = reason.slice(reason.indexOf(PREFIX) + PREFIX.length).trim();
  const cause = causes.find(c => rest.startsWith(c));
  if (!cause) return `names no cause this file is allowed (${causes.join(' | ')})`;
  const detail = rest.slice(cause.length);
  if (detail !== '' && !/^ [—-] /.test(detail)) return 'joins a second cause onto the first — one skip, one cause';
  if (/\bor\b|\band\b|;|,|\|\||&&/.test(detail)) return 'joins a second cause onto the first — one skip, one cause';
  return null;
}

/**
 * Every way `files` break the two rules, as readable lines.
 * @param {Array<{ file: string, text: string }>} files
 * @param {Record<string, { causes: string[], why: string }>} list
 */
export function expectedInCiViolations(files, list) {
  const bad = [];
  for (const { file, text } of files) {
    for (const { line, reason } of expectedInCiSkips(file, text)) {
      const allowed = list[file];
      if (!allowed) { bad.push(`${file}:${line}  carries ${PREFIX} but is not on the list of files allowed to`); continue; }
      const problem = oneCause(reason, allowed.causes);
      if (problem) bad.push(`${file}:${line}  "${reason.slice(0, 80)}" ${problem}`);
    }
  }
  return bad;
}

describe('the rules, on fixtures (the real tree is below)', () => {
  const LIST = { 'testing/standalone/corpus.test.js': { causes: ['corpus not fetched'], why: 'x' } };
  const fixture = (file, code) => expectedInCiViolations([{ file, text: code }], LIST);

  it('a redteam skip carrying the prefix is refused — redteam is not on the list', () => {
    const bad = fixture('testing/red-team-tests/some-attack.test.js',
      "it('x', (t) => { t.skip('expected-in-ci: corpus not fetched'); });");
    assert.equal(bad.length, 1, `not refused: ${JSON.stringify(bad)}`);
    assert.match(bad[0], /red-team-tests\/some-attack\.test\.js.*not on the list/);
  });

  it('the same skip in a listed file, naming its one cause, passes', () => {
    assert.deepEqual(fixture('testing/standalone/corpus.test.js',
      "it('x', (t) => { if (!has) return t.skip('expected-in-ci: corpus not fetched'); assert.ok(1); });"), []);
  });

  it('a detail after the cause is fine when it joins nothing', () => {
    assert.deepEqual(fixture('testing/standalone/corpus.test.js',
      "it('x', (t) => { t.skip('expected-in-ci: corpus not fetched — benchmarks/locomo/data.json'); });"), []);
  });

  it('two causes in one reason are refused', () => {
    const bad = fixture('testing/standalone/corpus.test.js',
      "it('x', (t) => { t.skip('expected-in-ci: corpus not fetched or the NLP sidecar is not running'); });");
    assert.equal(bad.length, 1, `not refused: ${JSON.stringify(bad)}`);
    assert.match(bad[0], /second cause/);
  });

  it('a cause the file is not allowed is refused — the sidecar being down must fail on CI', () => {
    const bad = fixture('testing/standalone/corpus.test.js',
      "it('x', (t) => { t.skip('expected-in-ci: the NLP sidecar is not running'); });");
    assert.equal(bad.length, 1, `not refused: ${JSON.stringify(bad)}`);
    assert.match(bad[0], /names no cause this file is allowed/);
  });

  it('is found where a skip is spelled as an option, a binding or a helper', () => {
    const forms = [
      "describe('x', { skip: has ? false : 'expected-in-ci: corpus not fetched' }, () => {});",
      "const skip = has ? false : 'expected-in-ci: corpus not fetched'; describe('x', { skip }, () => {});",
      "function corpusSkipReason() { return 'expected-in-ci: corpus not fetched'; }",
      "it('x', (t) => { t.skip(`expected-in-ci: corpus not fetched — ${name}`); });",
    ];
    for (const code of forms) {
      assert.equal(expectedInCiSkips('x.test.js', code).length, 1, `the prefix was not found in: ${code}`);
      assert.equal(fixture('testing/red-team-tests/y.test.js', code).length, 1, `an unlisted file was not refused for: ${code}`);
    }
  });

  it('prose and fixtures that mention the prefix are not skips', () => {
    assert.deepEqual(expectedInCiSkips('x.test.js',
      "// expected-in-ci: corpus not fetched\nconst doc = 'a skip reason may start expected-in-ci: and then the cause'; it('x', () => {});"), []);
  });
});

describe('the list is one list', () => {
  const read = (f) => readFileSync(`${REPO_ROOT}/${f}`, 'utf8');
  const READERS = ['testing/standalone/a-skip-that-expects-ci-lives-in-a-listed-file.test.js', 'scripts/unexpected-skips.mjs'];

  it('the list module is data with a reason per row, and the prefix is spelled once', () => {
    assert.equal(PREFIX, 'expected-in-ci:');
    const rows = Object.entries(EXPECTED_IN_CI);
    assert.ok(rows.length >= 1, 'an empty list allows nothing and checks nothing');
    for (const [file, { causes, why }] of rows) {
      assert.ok(Array.isArray(causes) && causes.length >= 1 && why.length > 40, `${file} is listed with no cause or no reason`);
    }
  });

  it('both readers import it, and neither keeps a literal of its own', () => {
    for (const f of READERS) {
      const text = read(f);
      assert.match(text, /expected-in-ci\.mjs'/, `${f} does not import the list module`);
      // A row of the real list names a real file; a fixture row (`corpus.test.js`) does not, so the file names are the tell.
      const code = stripComments(text);
      const listedFile = Object.keys(EXPECTED_IN_CI).find(name => code.includes(name));
      assert.equal(listedFile, undefined, `${f} writes a row of the list itself (${listedFile})`);
    }
  });
});

describe('the real tree', () => {
  const files = testAndHelperFiles();

  it('the list names real files, each with a reason — and every listed file really carries the prefix', () => {
    const entries = Object.entries(EXPECTED_IN_CI);
    assert.ok(entries.length >= 1, 'an empty list allows nothing and checks nothing');
    const byFile = new Map(files.map(f => [f.file, f]));
    const stale = [];
    for (const [file, { causes, why }] of entries) {
      assert.ok(causes.length >= 1 && why.length > 40, `${file} is listed with no cause or no reason`);
      const f = byFile.get(file);
      if (!f) { stale.push(`${file}  is not a tracked file — remove it from the list`); continue; }
      if (expectedInCiSkips(file, f.text).length === 0) {
        stale.push(`${file}  is listed but no skip in it starts ${PREFIX} — its corpus skip must say it is expected `
          + '(t.skip(\'expected-in-ci: corpus not fetched\')), or the row leaves the list');
      }
    }
    assert.deepEqual(stale, [], `the list and the tests disagree:\n  ${stale.join('\n  ')}`);
  });

  it('every test file that reads a corpus path is on the list (a new reader cannot skip unlisted)', () => {
    const readers = [];
    for (const { file, text } of files) {
      if (!file.endsWith('.test.js')) continue;
      const sf = parseSource(file, text);
      let reads = false;
      const visit = (n) => {
        if (ts.isPropertyAccessExpression(n) && n.name.text === 'cachePath') reads = true;
        ts.forEachChild(n, visit);
      };
      visit(sf);
      if (reads) readers.push(file);
    }
    assert.ok(readers.length >= 3, `only ${readers.length} corpus-reading test file(s) derived — the scan is broken`);
    const unlisted = readers.filter(f => !EXPECTED_IN_CI[f]);
    assert.deepEqual(unlisted, [], 'these read a pinned corpus that CI never fetches but are not on the list above, so '
      + `their skip could not say it is expected:\n  ${unlisted.join('\n  ')}`);
  });

  it('no file outside the list carries it, and no skip names more than its one cause', () => {
    assert.ok(files.length >= 800, `only ${files.length} files scanned — the listing is broken`);
    const bad = expectedInCiViolations(files, EXPECTED_IN_CI);
    assert.deepEqual(bad, [], bad.join('\n'));
  });
});
