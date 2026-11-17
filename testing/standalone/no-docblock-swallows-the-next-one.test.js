/**
 * A `/**` that meets another `/**` before it closes has swallowed everything between them.
 *
 * ## The defect
 *
 * `types-knowledge.ts` carried an unclosed docblock: the `*​/` went out with the field it described
 * (`tagSuggestions`, removed in #894) and the opener stayed. The next `/** … *​/` down the file terminated it,
 * so the field AFTER that — `propertySchemas`, one of the most-read fields in the schema model — was
 * documented as **"RETIRED — read and written, consumed by nothing."**
 *
 * It reached the emitted declarations too, so an editor's hover said the same thing.
 *
 * ## Why nothing caught it
 *
 * Every gate that reads these interfaces strips comments first — correctly, because they are checking code.
 * `documented-interfaces-match-code.test.js` does exactly that, and it is right to. **A comment defect is
 * invisible to every check that removes comments before looking**, which is the whole class, so it needs a
 * check that reads them on purpose.
 *
 * A brace or paren counter would not find it either: the file parses, compiles and lints. The only symptom is
 * that a human reads the wrong sentence about the right field.
 *
 * ## The rule
 *
 * Scanning left to right outside strings: after a `/**` the next thing must be its own `*​/`. Meeting a second
 * opener first means the first block never closed, and every field between the two is documented by whatever
 * that block says.
 *
 * Run: node --test testing/standalone/no-docblock-swallows-the-next-one.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources, SERVER_CODE_ROOTS } from './_sources.mjs';
import { readFileSync } from 'node:fs';

/** Every server source file, tracked AND untracked-but-not-ignored. */
function sourceFiles() {
  return trackedSources(SERVER_CODE_ROOTS, { untracked: true });
}

/**
 * Unclosed doc comments in one source, as `{ line, text }`.
 *
 * String and template literals are skipped, because `'/**'` inside one is not a comment — and this codebase
 * writes comment syntax into strings often enough (gate messages, error text) that not skipping them would
 * report a file per run and get the whole check disabled.
 */
function swallowedBlocks(src) {
  const out = [];
  let i = 0;
  let line = 1;
  while (i < src.length) {
    const c = src[i];
    if (c === '\n') { line++; i++; continue; }
    // Skip string and template literals whole.
    if (c === '"' || c === "'" || c === '`') {
      const quote = c;
      i++;
      while (i < src.length && src[i] !== quote) {
        if (src[i] === '\n') line++;
        i += src[i] === '\\' ? 2 : 1;
      }
      i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '/') {              // line comment — runs to EOL, cannot swallow
      while (i < src.length && src[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const openedAt = line;
      const isDoc = src[i + 2] === '*';
      i += 2;
      /*
       * Walk to the FIRST of `*​/` or a LINE-INITIAL `/**`.
       *
       * Line-initial, not merely `/*` anywhere: block comments do not nest in TypeScript, so a `/*` inside a
       * comment body is prose, not an opener. The first version matched it anywhere and reported four files
       * whose comments mention `/api/sync/*` and `assets/i18n/*.json` — all correct code. A gate that fires on
       * ordinary prose is one somebody switches off, so the shape it looks for has to be the shape the defect
       * actually takes: a new docblock starting its own line while the previous one is still open.
       */
      let atLineStart = false;
      while (i < src.length) {
        if (src[i] === '\n') { line++; i++; atLineStart = true; continue; }
        if (atLineStart && /\s/.test(src[i])) { i++; continue; }   // indentation keeps the line-start state
        if (src[i] === '*' && src[i + 1] === '/') { i += 2; break; }
        if (atLineStart && src[i] === '/' && src[i + 1] === '*' && src[i + 2] === '*') {
          // The rest of THAT LINE, not a character count. It only feeds the failure message, but a magic
          // number is a magic number — and the line is the natural unit here anyway, since what the reader
          // needs is the opener that collided, not a fixed number of characters around it.
          if (isDoc) {
            const eol = src.indexOf('\n', i);
            out.push({ line: openedAt, text: src.slice(i, eol === -1 ? src.length : eol).trim() });
          }
          break;                                        // report once; the scan resumes at the inner opener
        }
        atLineStart = false;
        i++;
      }
      continue;
    }
    i++;
  }
  return out;
}

describe('the scanner works before anything is concluded from it', () => {
  it('finds a swallow in a fixture', () => {
    // Without this, a scanner that matched nothing would report the whole tree clean.
    const bad = 'interface A {\n  /**\n   * doc for a field that was deleted\n  /** kept */\n  kept?: string;\n}';
    assert.equal(swallowedBlocks(bad).length, 1, 'the scanner must see an unclosed docblock');
  });

  it('passes a correctly closed pair', () => {
    const good = 'interface A {\n  /** one */\n  a?: string;\n  /** two */\n  b?: string;\n}';
    assert.deepEqual(swallowedBlocks(good), []);
  });

  it('does not report comment syntax inside a string', () => {
    // The false positive that would get this gate switched off: gate messages and error text quote comment
    // syntax routinely, and a scanner that read those would fire on a file per run.
    const s = "const msg = 'write /** here */ and /** there';\nconst t = `a /** b`;\n";
    assert.deepEqual(swallowedBlocks(s), []);
  });

  it('walked a real tree', () => {
    assert.ok(sourceFiles().length > 100, `only ${sourceFiles().length} server sources found — the scan broke`);
  });
});

describe('no docblock swallows the next one', () => {
  it('every doc comment closes before the next begins', () => {
    const problems = [];
    for (const file of sourceFiles()) {
      for (const b of swallowedBlocks(readFileSync(file, 'utf8'))) {
        problems.push(`${file}:${b.line} — …${b.text}…`);
      }
    }
    assert.deepEqual(
      problems, [],
      'A `/**` that meets another before it closes documents every declaration between the two. The field '
      + 'that reads as documented is being described by a comment written for something else — which is worse '
      + 'than an undocumented field, because it is believed. It reaches the emitted `.d.ts` and an editor '
      + 'hover with it.',
    );
  });
});
