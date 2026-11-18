/**
 * No tracked .js, .mjs or .ts source holds two blank lines in a row (Q-867, bundle-312).
 *
 * ## The defect this refuses
 *
 * A double blank line went into bundle-311 (`testing/integration/files.test.js`, after `listOwnFileMeta`) and nothing refused it: the project has no
 * source-style lint, and 133 tracked files already held one. The owner's rule is a lint wherever a rule is machine-checkable.
 *
 * ## The part a copy gets wrong
 *
 * A blank line inside a template literal (or JSX text) is CONTENT; a string or a regular expression cannot hold one, but the rule reads them as literals too. A rule that counts every empty
 * line reports those, and a fixer built on it changes a runtime text or the output a test expects. The rule is `testing/_shared/blank-line-runs.mjs`, which
 * reads the source as a syntax tree; this file holds it to the tracked tree and to a truth table, and `scripts/collapse-blank-lines.mjs` (the fixer) to
 * the same rule.
 *
 * ## What is asserted
 *
 * - **The tracked tree** (listed by git, every `.js`, `.mjs` and `.ts` file, CRLF and LF alike): no file holds a run of two or more blank lines outside a literal.
 * - **A planted copy** of a real file: a second blank line added between two statements of it is refused, at that line, and in the CRLF form of the same file;
 *   the same line added inside a template literal of another real file is not.
 * - **The truth table**: a template with substitutions (head, middle and tail parts) keeps its blank lines, a substitution's code does not, and a backslash-continued string is read through. Blank
 *   lines; a comment, a block comment and a whitespace-only line do not; the collapse keeps each line ending, even in a file that mixes them, and
 *   leaves a clean file as it is.
 * - **The fixer**: run in a scratch checkout, it collapses a run and leaves a template literal's blank lines, keeping the line endings.
 *
 * Seen red on the unchanged tree: the tracked-tree case lists the files that hold a run; the fixer case finds no script.
 *
 * Run: node --test testing/standalone/no-source-has-two-blank-lines-in-a-row.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT } from './_sources.mjs';
import { blankLineSources, collapseBlankLines, contentBlankLines, surplusBlankLines } from '../_shared/blank-line-runs.mjs';
import { makeScratchRepo } from '../_shared/scratch-git-repo.mjs';
import { testChildEnv } from '../_shared/test-child-env.mjs';

const files = blankLineSources();
const read = (file) => readFileSync(join(REPO_ROOT, file), 'utf8');

describe('no tracked source holds two blank lines in a row', () => {
  it('finds the tracked tree', () => {
    assert.ok(files.length > 1000, `expected the whole tracked source tree, got ${files.length} files`);
    assert.ok(files.some(f => f.endsWith('.ts')) && files.some(f => f.endsWith('.mjs')) && files.some(f => f.endsWith('.js')), 'a covered extension is missing');
  });

  it('every tracked file passes', () => {
    const offenders = [];
    for (const file of files) {
      const surplus = surplusBlankLines(file, read(file));
      if (surplus.length > 0) offenders.push(`${file}:${surplus[0]}  ${surplus.length} surplus blank line(s)`);
    }
    assert.deepEqual(offenders, [],
      `${offenders.length} tracked file(s) hold two or more blank lines in a row outside a literal. Run \`node scripts/collapse-blank-lines.mjs\` to collapse them:\n${offenders.join('\n')}`);
  });
});

describe('the rule on a planted copy of a real file', () => {
  /** The first tracked file with two statements apart by one blank line, and the offset just after that blank line. */
  const between = () => {
    for (const file of files) {
      const m = /;(\r?\n)(\r?\n)(?=[A-Za-z])/.exec(read(file));
      if (m) return { file, text: read(file), at: m.index + 1 + m[1].length + m[2].length, extra: m[2] };
    }
    throw new Error('no tracked file has two statements one blank line apart: the plant has nothing to copy');
  };

  it('a second blank line between two statements is refused, at that line', () => {
    const { file, text, at, extra } = between();
    const before = surplusBlankLines(file, text);
    const planted = text.slice(0, at) + extra + text.slice(at);
    const line = planted.slice(0, at).split('\n').length;
    const after = surplusBlankLines(file, planted);
    assert.equal(after.length, before.length + 1, 'the planted blank line is not counted');
    assert.ok(after.includes(line + 1) || after.includes(line), `the planted line ${line + 1} is not among ${after}`);
  });

  it('the same plant in the CRLF form of the file is refused too, and the collapse gives the file back', () => {
    const { file, text, at, extra } = between();
    const crlf = (t) => t.replace(/\r?\n/g, '\r\n');
    const planted = crlf(text.slice(0, at) + extra + text.slice(at));
    assert.equal(surplusBlankLines(file, planted).length, surplusBlankLines(file, crlf(text)).length + 1);
    assert.equal(collapseBlankLines(file, planted), collapseBlankLines(file, crlf(text)));
  });

  it('a blank line doubled inside a template literal of a real file is left alone', () => {
    const inside = files.map(file => ({ file, text: read(file) }))
      .filter(({ text }) => text.includes('`') && /\n[ \t]*\r?\n/.test(text))
      .map(({ file, text }) => ({ file, text, content: contentBlankLines(file, text) }))
      .find(({ content }) => content.length > 0);
    assert.ok(inside, 'no tracked file holds a blank line inside a literal: the plant has nothing to copy');
    const { file, text, content } = inside;
    const lines = text.split('\n');
    const idx = content[0] - 1;
    const doubled = [...lines.slice(0, idx + 1), lines[idx], ...lines.slice(idx + 1)].join('\n');
    assert.notEqual(doubled, text);
    assert.equal(surplusBlankLines(file, doubled).length, surplusBlankLines(file, text).length, 'a blank line inside a literal was counted');
    // The collapse of the doubled text is longer than the collapse of the original by exactly the doubled line: it removed nothing inside the literal.
    assert.equal(collapseBlankLines(file, doubled).length - collapseBlankLines(file, text).length, lines[idx].length + 1, 'the collapse removed a content line');
  });
});

describe('the rule, row by row', () => {
  const surplus = (text, file = 'x.js') => surplusBlankLines(file, text);

  it('a run outside a literal is refused from its second line on', () => {
    assert.deepEqual(surplus('a();\n\n\nb();\n'), [3]);
    assert.deepEqual(surplus('a();\n\n\n\nb();\n'), [3, 4]);
    assert.deepEqual(surplus('a();\n\nb();\n'), []);
  });

  it('a whitespace-only line is blank', () => {
    assert.deepEqual(surplus('a();\n\n \t\nb();\n'), [3]);
  });

  it('blank lines in a comment are layout', () => {
    assert.deepEqual(surplus('/*\n\n\n*/\na();\n'), [3]);
    assert.deepEqual(surplus('a(); // note\n\n\n// more\nb();\n'), [3]);
  });

  it('blank lines in a template literal are content: head, middle and tail', () => {
    const text = 'const s = `one\n\n\ntwo ${x}\n\n\nthree ${y}\n\n\nfour`;\nconst t = `\n\n`;\n';
    assert.deepEqual(surplus(text), []);
    assert.equal(collapseBlankLines('x.js', text), text);
    assert.deepEqual(contentBlankLines('x.js', text), [2, 3, 5, 6, 8, 9, 12]);
  });

  it('a double blank inside a substitution of a template is layout', () => {
    assert.deepEqual(surplus('const s = `a ${f(\n1,\n\n\n2)} b`;\n'), [4]);
  });

  it('a string continued with backslashes holds no blank line, and the lines after it are read from the right place', () => {
    const text = "const s = 'one\\\n\\\n\\\ntwo';\n\n\nf();\n";
    assert.deepEqual(surplus(text), [6]);
    assert.equal(collapseBlankLines('x.js', text), "const s = 'one\\\n\\\n\\\ntwo';\n\nf();\n");
  });

  it('a TypeScript file is read as TypeScript', () => {
    assert.deepEqual(surplus('const a: Array<string> = [];\n\n\nconst b = <T,>(x: T): T => x;\n', 'x.ts'), [3]);
  });

  it('the collapse keeps each line ending, a mixed file included, and leaves a clean file alone', () => {
    assert.equal(collapseBlankLines('x.js', 'a();\r\n\r\n\r\nb();\r\n'), 'a();\r\n\r\nb();\r\n');
    assert.equal(collapseBlankLines('x.js', 'a();\n\n\nb();\n'), 'a();\n\nb();\n');
    assert.equal(collapseBlankLines('x.js', 'a();\r\n\n\r\n\nb();\n'), 'a();\r\n\nb();\n');
    const clean = 'a();\r\n\r\nb();\n';
    assert.equal(collapseBlankLines('x.js', clean), clean);
  });

  it('trailing blank lines at the end of a file are a run too', () => {
    assert.deepEqual(surplus('a();\n\n\n'), [3]);
    assert.equal(collapseBlankLines('x.js', 'a();\n\n\n'), 'a();\n\n');
  });
});

describe('the fixer collapses what the rule refuses and nothing else', () => {
  const SCRIPT = join(REPO_ROOT, 'scripts/collapse-blank-lines.mjs');

  it('exists', () => {
    assert.ok(existsSync(SCRIPT), 'scripts/collapse-blank-lines.mjs does not exist');
  });

  it('collapses a run, keeps a template literal and the line endings, and leaves a clean file untouched', () => {
    const repo = makeScratchRepo({ prefix: 'blank-lines-' });
    try {
      const template = 'export const text = `a\n\n\nb`;\n';
      mkdirSync(join(repo.dir, 'src'), { recursive: true });
      writeFileSync(join(repo.dir, 'src/lf.js'), `import x from 'x';\n\n\nexport const y = x;\n\n\n\n${template}`);
      writeFileSync(join(repo.dir, 'src/crlf.ts'), 'const a = 1;\r\n\r\n\r\nconst b = 2;\r\n');
      writeFileSync(join(repo.dir, 'src/clean.mjs'), 'export const z = 1;\n\nexport const w = 2;\n');
      writeFileSync(join(repo.dir, 'src/notes.md'), 'one\n\n\ntwo\n');
      repo.git('add', '-A');
      const r = spawnSync(process.execPath, [SCRIPT, '--root', repo.dir], { encoding: 'utf8', env: testChildEnv() });
      assert.equal(r.status, 0, `the fixer failed: ${r.stdout}${r.stderr}`);
      assert.equal(readFileSync(join(repo.dir, 'src/lf.js'), 'utf8'), `import x from 'x';\n\nexport const y = x;\n\n${template}`);
      assert.equal(readFileSync(join(repo.dir, 'src/crlf.ts'), 'utf8'), 'const a = 1;\r\n\r\nconst b = 2;\r\n');
      assert.equal(readFileSync(join(repo.dir, 'src/clean.mjs'), 'utf8'), 'export const z = 1;\n\nexport const w = 2;\n');
      assert.equal(readFileSync(join(repo.dir, 'src/notes.md'), 'utf8'), 'one\n\n\ntwo\n', 'a file outside the covered extensions was changed');
    } finally {
      repo.cleanup();
    }
  });
});
