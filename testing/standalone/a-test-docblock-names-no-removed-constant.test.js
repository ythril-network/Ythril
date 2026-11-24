/**
 * A backticked SCREAMING_SNAKE name in a test file's leading docblock must be spelled somewhere else in the repository.
 *
 * ## The defect it prevents, and the failure that bought it
 *
 * A test's leading docblock says what the test holds, and names the constants the behaviour is bound by. When a change removes a constant, the
 * test is rewritten to the new mechanism, and the docblock's sentence about the old one stays: it names a bound the product no longer has, and a
 * reader looking for it finds nothing. The review of Q-953 (bundle-270) found the idle bound's old constant named so in the stall test's
 * docblock (line 9), after the change had removed it in favour of the upload pace's knob. No test could fail on it: prose is not compiled.
 *
 * ## What it reads
 *
 * - **The subject set is derived**: the leading block comment of every tracked `.js`, `.mjs` and `.ts` file under `testing/` (the tests and the
 *   helpers they import), and in it each backticked name with at least one underscore, in capitals and digits. A name with no underscore
 *   (`GET`, `JSON`) is a word, not a constant.
 * - **A name stands** when any tracked text file spells it, a comment of the product's code included (a docblock that says what a constant
 *   replaced still finds the replaced name there), except in the leading docblocks of the subject files themselves: a docblock cannot be kept
 *   true by another docblock, nor by itself.
 * - A name that does not stand is reported with its file and its line in the file as it is (the docblock is read from the original text, never
 *   from a stripped copy, so the line is the line the reader greps).
 *
 * ## Stated limits
 *
 * Existence, not correctness: a name that is spelled elsewhere but no longer means what the docblock says is not found. Names in a plain
 * (not backticked) sentence, and in a block comment that is not the file's first, are not read. A name the docblock gives as history ("the
 * version it replaces named `X`"), or that another party owns (a Node error code, a Docker variable), is an exception.
 *
 * ## Exceptions
 *
 * `a-test-docblock-names-no-removed-constant.allow.json`: each name with its reason and a review date. An entry with no reason, past its date, or
 * for a name that stands after all, fails the check.
 *
 * ## Seen red
 *
 * On the base it was written against, the first run named `an-rdf-import-upload-that-stalls-is-refused-and-frees-the-door-db.test.js` line 9.
 *
 * Run: node --test testing/standalone/a-test-docblock-names-no-removed-constant.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTrackedTextSources } from './_sources.mjs';

/** A backticked constant name: capitals and digits with at least one underscore. Built fresh per use (a global regex is stateful). */
const constantNames = () => /`([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)`/g;
/** A bare constant name, as a source spells it. */
const bareNames = () => /\b[A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+\b/g;
/** A test file or helper under `testing/`: a file whose leading docblock is a subject of the check. */
const isSubject = (file) => file.startsWith('testing/') && /\.(?:js|mjs|ts)$/.test(file);

/** The leading block comment of a source: its text and the line (1-based) it starts on, or null when the file does not begin with one. */
export function leadingDocblock(text) {
  const m = /^(?:#![^\n]*\n)?\s*(\/\*\*[\s\S]*?\*\/)/.exec(text);
  if (!m) return null;
  const start = m[0].length - m[1].length;
  return { block: m[1], line: text.slice(0, start).split('\n').length };
}

/** The constant names a docblock mentions in backticks, each with its line in the file. */
export function namedConstants(docblock) {
  const out = [];
  docblock.block.split('\n').forEach((text, i) => { for (const m of text.matchAll(constantNames())) out.push({ name: m[1], line: docblock.line + i }); });
  return out;
}

/** Every constant-shaped word the files spell, a subject file's leading docblock left out. */
export function standingNames(files) {
  const standing = new Set();
  for (const { file, text } of files) {
    const docblock = isSubject(file) ? leadingDocblock(text) : null;
    const read = docblock ? text.replace(docblock.block, '') : text;
    for (const m of read.matchAll(bareNames())) standing.add(m[0]);
  }
  return standing;
}

/** The names the leading docblocks of the subject files mention and `standing` lacks: `{ file, line, name }`. */
export function absentMentions(files, standing) {
  const out = [];
  for (const { file, text } of files) {
    const docblock = isSubject(file) ? leadingDocblock(text) : null;
    if (!docblock) continue;
    for (const { name, line } of namedConstants(docblock)) if (!standing.has(name)) out.push({ file, line, name });
  }
  return out;
}

const ALLOW_FILE = 'testing/standalone/a-test-docblock-names-no-removed-constant.allow.json';
const ALLOW = JSON.parse(readFileSync(new URL('./a-test-docblock-names-no-removed-constant.allow.json', import.meta.url), 'utf8'));
const TODAY = new Date().toISOString().slice(0, 10);

/** Every tracked text file but the allowlist, which spells every name it excepts and would make each stand. */
const FILES = readTrackedTextSources(['.'], { floor: 1000 }).filter(f => f.file !== ALLOW_FILE);
const STANDING = standingNames(FILES);

describe('the check itself works before it is trusted', () => {
  it('derives its subjects and its spellings from the repository', () => {
    assert.ok(FILES.filter(f => isSubject(f.file)).length >= 300, 'the subject files were not found');
    assert.ok(FILES.filter(f => isSubject(f.file) && leadingDocblock(f.text)).length >= 300, 'the leading docblocks were not found');
    assert.ok(STANDING.size >= 1000, `only ${STANDING.size} constant names spelled in the repository`);
  });

  it('reads a backticked constant of the leading docblock, at its line in the file, and nothing else', () => {
    const text = ['/**', ' * A test of `THE_REMOVED_BOUND` and `GET`, not of THE_PLAIN_WORD.', ' */', 'import x from "y";', '/** A second block names `ANOTHER_REMOVED_ONE`. */'].join('\n');
    assert.deepEqual(namedConstants(leadingDocblock(text)), [{ name: 'THE_REMOVED_BOUND', line: 2 }]);
    assert.equal(leadingDocblock('import x from "y";\n/** late */'), null);
  });

  it('a fixture whose docblock names a removed constant fails, and one naming a spelled constant passes', () => {
    const files = [
      { file: 'server/src/a.ts', text: 'export const STILL_SPELLED_BOUND = 1;\n// it replaced KEPT_AS_HISTORY_ONLY\n' },
      { file: 'testing/standalone/stale.test.js', text: '/**\n * Held by `THE_REMOVED_BOUND`, which `ANOTHER_DOCBLOCK_ONLY` also names.\n */\n' },
      { file: 'testing/standalone/other.test.js', text: '/**\n * Held by `ANOTHER_DOCBLOCK_ONLY` and `STILL_SPELLED_BOUND` and `KEPT_AS_HISTORY_ONLY`.\n */\n' },
    ];
    const found = absentMentions(files, standingNames(files));
    assert.deepEqual(found.map(m => `${m.file}:${m.line} ${m.name}`), [
      'testing/standalone/stale.test.js:2 THE_REMOVED_BOUND',
      'testing/standalone/stale.test.js:2 ANOTHER_DOCBLOCK_ONLY',
      'testing/standalone/other.test.js:2 ANOTHER_DOCBLOCK_ONLY',
    ], 'a name only docblocks mention is absent, one a product comment or code spells stands');
  });

  it('every exception gives a reason and a future review date, and names a constant that is still absent', () => {
    for (const e of ALLOW.entries) {
      assert.ok(typeof e.reason === 'string' && e.reason.length > 20, `'${e.name}' needs a reason naming whose it is`);
      assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(e.reviewBy) && e.reviewBy >= TODAY, `'${e.name}' is past its review date (${e.reviewBy}): decide it again`);
      assert.ok(!STANDING.has(e.name), `'${e.name}' is excepted but the repository spells it: drop the exception`);
    }
  });
});

describe(`every constant a test's leading docblock names is spelled elsewhere (${ALLOW.entries.length} exceptions)`, () => {
  it('names nothing the repository no longer has', () => {
    const excepted = new Set(ALLOW.entries.map(e => e.name));
    const open = absentMentions(FILES, STANDING).filter(m => !excepted.has(m.name));
    assert.deepEqual(open.map(m => `${m.file}:${m.line}  ${m.name}`), [],
      'These names are in a leading docblock and spelled nowhere else: name what the test uses now, or drop the sentence. A name another party owns, or one '
      + 'given as history, goes in a-test-docblock-names-no-removed-constant.allow.json with a reason and a reviewBy date.');
  });
});
