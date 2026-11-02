/**
 * No source file holds a raw U+2028 (line separator) or U+2029 (paragraph separator) character.
 *
 * ## The defect this prevents
 *
 * Both characters end a line for a JavaScript or TypeScript comment and for many editors and diff tools, while they are invisible.
 * A raw one inside a regular expression or a string literal changes what the code means: in a character class it breaks the build,
 * and inside a comment it can end the comment early and let the rest of the line run as code. Written as the escape (a backslash,
 * the letter u and the four hex digits), the same code is visible and safe.
 *
 * It bought itself during Q-669 (2026-11-02): a tool that writes files turned those escapes in `schema/src/typescript.ts` into
 * the raw characters, and the same happened to the first draft of this very file. The build caught the first; a raw separator in a
 * comment or a string the build accepts would not have been caught by anything. So every tracked or new source file of the server,
 * the schema package, the client and the tests is read, and a raw one fails, naming the file and line.
 *
 * Run: node --test testing/standalone/no-source-file-holds-a-raw-line-or-paragraph-separator.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';

/** The two characters, built from their code points so this file never holds them raw itself. */
const SEPARATORS = [String.fromCharCode(0x2028), String.fromCharCode(0x2029)];

/** Every `file:line` holding a raw separator in `sources`. */
function rawSeparators(sources) {
  const found = [];
  for (const { file, text } of sources) {
    if (!SEPARATORS.some(s => text.includes(s))) continue;
    text.split('\n').forEach((line, i) => {
      if (SEPARATORS.some(s => line.includes(s))) found.push(`${file}:${i + 1}`);
    });
  }
  return found;
}

describe('no source file holds a raw U+2028 or U+2029', () => {
  it('the tracked and new sources of server, schema, client and testing hold none', () => {
    const sources = readTrackedSources(['server/src', 'schema/src', 'client/src', 'testing'], {
      ext: ['.ts', '.js', '.mjs', '.cjs'], untracked: true,
    });
    assert.ok(sources.length > 500, `read only ${sources.length} source files; the scan is not seeing the repository`);
    assert.deepEqual(rawSeparators(sources), [], 'write the escape form (backslash, u, the hex digits) instead of the raw character');
  });

  it('the reader finds a planted raw separator and names its line, and passes the escaped form', () => {
    const escaped = '\\' + 'u2028';
    const planted = [
      { file: 'planted.ts', text: `const ok = 1;\nconst bad = /[${SEPARATORS[0]}]/;\n` },
      { file: 'clean.ts', text: `const fine = /[${escaped}]/;\n` },
    ];
    assert.deepEqual(rawSeparators(planted), ['planted.ts:2']);
  });
});
