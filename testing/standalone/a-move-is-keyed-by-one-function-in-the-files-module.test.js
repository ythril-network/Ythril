/**
 * A move's key - its `from` and its `to` joined into one string - is built by `moveKey` in `files/moved-paths.ts` and nowhere
 * else under `server/src/files`.
 *
 * ## The defect it prevents
 *
 * Every set and map of moves (the marker store, the settle loop, the finish pass, the held-job lookup) is keyed by one spelling of
 * "this move": the two paths joined with a NUL byte, because a NUL cannot be in a path and so no pair of paths can collide. A
 * second place that builds the pair writes it a little differently (the other order, a `/` or `->`, or without the space id), and
 * the two sets then disagree about whether a move is the same move: a move that is owed is looked up and not found, which is
 * the move being forgotten rather than failing.
 *
 * ## What it holds
 *
 * Every tracked, non-test `.ts` file under `server/src/files` (comments blanked) is read for a NUL used as a SEPARATOR
 * (`\u0000`, `\u{0}`, `\x00` or `\0` in a key). A separator is a MOVE KEY when its two neighbouring operands are the two ends of
 * a move: in a template (`${a}<NUL>${b}`), a concatenation (`a + '<NUL>' + b`) or a join (`[a, b].join('<NUL>')`), one operand
 * is named `from` / `src` / `oldPath` / `fromPath` (bare or after a `.`) and the other `to` / `dst` / `newPath` / `toPath`. One
 * outside `moved-paths.ts` fails naming `file:line`. The rule reads the OPERANDS beside the separator, not the statement that
 * holds it, so how a file lays its code out cannot widen or narrow it.
 *
 * What it deliberately does NOT call a move key, and says so: a NUL-joined key whose operands are not a move's two ends. Three exist
 * (an upload id hashed from space, path and total; a once-per-record log key; the unreadable-file map), and merging them into
 * `moveKey` would be the failure the repository rules call herding callers that share a spelling. The gate asserts a FLOOR on how
 * many NUL separators it reads outside the home, so that exclusion is visible rather than assumed: a read that finds none has
 * broken, not found nothing.
 *
 * A NUL join elsewhere in the server (`sync/`, `brain/`) asks other questions and is outside what this reads, which is why the
 * title says `files`.
 *
 * Seen red by a synthetic mutation: the detector is exercised on source that builds a move key (a template, a concatenation, a
 * `join`, in either order) and on source that does not, and again on a real file with a key appended.
 *
 * Run: node --test testing/standalone/a-move-is-keyed-by-one-function-in-the-files-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

const HOME = 'server/src/files/moved-paths.ts';
/** `server/src/files` holds well over this many; a listing under it means the scan broke. */
const FILES_FLOOR = 60;

/** A NUL written as an escape inside a string or template. */
const NUL = '(?:\\\\u0000|\\\\u\\{0\\}|\\\\x00|\\\\0(?![0-9]))';
const nulSeparator = () => new RegExp(NUL, 'g');

const isFromEnd = (operand) => /(?:^|\.)(?:from|src|oldPath|fromPath)$/.test(operand.trim());
const isToEnd = (operand) => /(?:^|\.)(?:to|dst|newPath|toPath)$/.test(operand.trim());
/** Are these two operands a move's two ends, in either order? */
const aMovesEnds = (a, b) => (isFromEnd(a) && isToEnd(b)) || (isToEnd(a) && isFromEnd(b));

/** Every NUL separator of a source, `{ line }`, and every move key among them, `{ line, text }`: operands read beside the separator. */
function nulKeys(source) {
  const src = blankComments(source);
  const lineOf = (at) => src.slice(0, at).split('\n').length;
  const separators = [...src.matchAll(nulSeparator())].map(m => ({ line: lineOf(m.index) }));
  const moves = [];
  const note = (m, a, b) => { if (aMovesEnds(a, b)) moves.push({ line: lineOf(m.index), text: src.split('\n')[lineOf(m.index) - 1].trim().slice(0, 140) }); };
  for (const m of src.matchAll(new RegExp(`\\$\\{([^{}]*)\\}${NUL}(?=\\$\\{([^{}]*)\\})`, 'g'))) note(m, m[1], m[2]);
  for (const m of src.matchAll(new RegExp(`([\\w.$]+)\\s*\\+\\s*['"\`]${NUL}['"\`]\\s*\\+\\s*(?=([\\w.$]+))`, 'g'))) note(m, m[1], m[2]);
  for (const m of src.matchAll(new RegExp(`\\[([^\\[\\]]*)\\]\\s*\\.join\\(\\s*['"\`]${NUL}['"\`]\\s*\\)`, 'g'))) {
    const operands = m[1].split(',');
    operands.slice(1).forEach((b, i) => note(m, operands[i], b));
  }
  return { separators, moves };
}

describe('a move is keyed by one function in the files module', () => {
  it('recognises a move key in a template, a concatenation and a join, in either order, and not another NUL key', () => {
    const moves = (code) => nulKeys(code).moves.length;
    assert.equal(moves('const k = `${m.from}\\u0000${m.to}`;\n'), 1);
    assert.equal(moves('const k = `${to}\\0${from}`;\n'), 1);
    assert.equal(moves("const k = from + '\\0' + to;\n"), 1);
    assert.equal(moves("const k = [src, dst].join('\\x00');\n"), 1);
    assert.equal(moves('const k = `${spaceId}\\u0000${m.from}\\u0000${m.to}`;\n'), 1);
    assert.equal(moves('const k = `${spaceId}\\0${relPath}`;\n'), 0);
    assert.equal(moves('const k = `${spaceId}\\u0000${_id}`;\n'), 0);
    assert.equal(moves('const k = `${spaceId}\\0${filePath}\\0${total}`;\n'), 0);
    assert.equal(moves('if (name.includes("\\x00")) throw new Error("no");\n'), 0);
    assert.equal(nulKeys('if (name.includes("\\x00")) throw new Error("no");\n').separators.length, 1);
    assert.equal(nulKeys('// `${from}\\u0000${to}` in a comment\nconst x = 1;\n').separators.length, 0);
  });

  const sources = readTrackedSources(['server/src/files'], { floor: FILES_FLOOR, specs: false });
  const keys = sources.map(({ file, text }) => ({ file, ...nulKeys(text) }));

  it('reads the files module and sees the move key in its home (positive control)', () => {
    assert.ok(sources.length >= FILES_FLOOR, `only ${sources.length} files read`);
    assert.ok(keys.some(k => k.file === HOME && k.moves.length > 0), `${HOME} builds no move key the scan can see: the detector is broken`);
  });

  it('reads the NUL keys that are not moves, so that exclusion is visible', () => {
    const others = keys.filter(k => k.file !== HOME).reduce((n, k) => n + k.separators.length, 0);
    assert.ok(others >= 3, `only ${others} NUL separators found outside the home: the scan reads less than the module holds`);
  });

  it('no move key is built outside moved-paths.ts', () => {
    const stray = keys.filter(k => k.file !== HOME).flatMap(k => k.moves.map(m => ({ file: k.file, ...m })));
    assert.deepEqual(stray, [], `a move's key is built outside ${HOME}; call moveKey:\n`
      + stray.map(s => `  ${s.file}:${s.line}  ${s.text}`).join('\n'));
  });
});
