/**
 * A script that is also a module asks `scripts/_shared/script-cli.mjs` whether it was RUN, and reads its flags there
 * (bundle-56 dedup, `check-i-no-second-copy-written`).
 *
 * ## What this prevents
 *
 * `process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url` was written five times in one
 * bundle, `valueOf = (flag) => ...` three, and each copy decided for itself what a flag with no value meant. The
 * module holds the guard a copy drops (an absent `argv[1]` is "not run", never a throw; a flag without its value is
 * refused, never read as "the working directory"). A sixth copy is the defect again.
 *
 * ## The rule, and how it is read
 *
 * No `.mjs` under `scripts/`, `testing/_init/` or `testing/standalone/` outside the module itself reads
 * `process.argv[1]` — the only thing the entry test is made of — or defines its own `valueOf`. The set of files is
 * the tracked listing with a floor; comments are blanked before reading, so a docblock that explains the old spelling
 * is not a copy of it.
 *
 * Run: node --test testing/standalone/a-script-asks-one-module-whether-it-was-run.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { REPO_ROOT, trackedSources } from './_sources.mjs';
import { blankComments } from './_strip-comments.mjs';

/** The one module allowed to spell it. */
const MODULE = 'scripts/_shared/script-cli.mjs';

/** What a copy is made of: the entry test's only ingredient, and a hand-written flag reader. */
const COPIES = [
  [/\bprocess\.argv\[1\]/, 'reads process.argv[1] to decide whether it was run'],
  [/\b(?:const|let|function)\s+valueOf\b/, 'defines its own valueOf flag reader'],
];

/** `[{ line, why }]` for every copy in `text`, comments blanked first. */
function copiesIn(text) {
  const code = blankComments(text);
  return COPIES.flatMap(([re, why]) => [...code.matchAll(new RegExp(re.source, 'g'))]
    .map(m => ({ line: code.slice(0, m.index).split('\n').length, why })));
}

describe('a script asks one module whether it was run', () => {
  const files = trackedSources(['scripts', 'testing/_init', 'testing/standalone'], { ext: ['.mjs'], floor: 40 });

  it('no script outside the module spells the entry test or its own flag reader', () => {
    const found = files.filter(f => f !== MODULE)
      .flatMap(f => copiesIn(readFileSync(join(REPO_ROOT, f), 'utf8')).map(c => `${f}:${c.line} ${c.why}`));
    assert.deepEqual(found, [], 'these files carry a second copy: import isEntryPoint / readFlags from scripts/_shared/script-cli.mjs');
  });

  it('the instrument sees the module\'s own entry test, so a clean tree means something', () => {
    assert.ok(files.includes(MODULE), 'the module is not in the scanned set');
    const own = copiesIn(readFileSync(join(REPO_ROOT, MODULE), 'utf8'));
    assert.ok(own.some(c => /argv\[1\]/.test(c.why)), 'the detector did not find process.argv[1] in the one file that spells it');
  });

  describe('the detector, on snippets', () => {
    const cases = [
      ['the spelling the bundle wrote five times', 'const entry = process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url;', 2],
      ['the endsWith variant', "if (process.argv[1] && process.argv[1].endsWith('x.mjs')) main();", 2],
      ['a hand-written valueOf', "const valueOf = (flag) => { const i = argv.indexOf(flag); return argv[i + 1]; };", 1],
      ['argv read from the third slot on', 'const args = process.argv.slice(2);', 0],
      ['a docblock that explains the old spelling', '/** `process.argv[1]` was compared with import.meta.url */\nconst x = 1;', 0],
      ['a line comment that does', '// const valueOf = (flag) => flag;\nconst x = 1;', 0],
      ['a call of the module', "import { isEntryPoint } from './_shared/script-cli.mjs';\nif (isEntryPoint(import.meta.url)) main();", 0],
    ];
    for (const [name, text, expected] of cases) {
      it(`${name}: ${expected} copy(ies)`, () => assert.equal(copiesIn(text).length, expected));
    }
  });
});
