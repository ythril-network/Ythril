/**
 * Every `server/dist` path a test imports has a `server/src` file behind it.
 *
 * ## The failure this catches, measured
 *
 * `link-inputs.ts` was renamed to `write-connections.ts`. The rename left `server/dist/brain/link-inputs.js`
 * on disk — `tsc` writes outputs, it does not remove the ones whose sources are gone — so a test still
 * importing the old path kept passing locally, for ever, against a compiled file with no source.
 *
 * CI has no such artifact: it builds into a clean tree, and the import failed there with
 * `ERR_MODULE_NOT_FOUND` at module load, which reads as "this test is broken" rather than as "this path
 * moved". One round trip to CI to learn something the working copy already knew.
 *
 * **It is worse than a wasted round trip when the rename is a SPLIT.** Import the old path and you get the
 * old module — the code as it was before it was divided — and every assertion passes against a file nothing
 * ships. The test reports green about a version of the module that no longer exists.
 *
 * ## Why the source, and not just "the dist file is present"
 *
 * Checking that the dist file exists passes on exactly the stale artifact this is about. The question is
 * whether a SOURCE still produces it, which is what makes the import a claim about the product rather than
 * about the build directory's history.
 *
 * Run: node --test testing/standalone/a-dist-import-has-a-source.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { ts, parseSource, walkEveryNode } from '../_shared/syntax-tree.mjs';

/** `../../server/dist/brain/write-connections.js` → `server/src/brain/write-connections.ts` */
const sourceFor = (distPath) =>
  `server/src/${distPath.replace(/^.*server\/dist\//, '').replace(/\.js$/, '.ts')}`;

/*
 * An IMPORT, not any string that happens to contain the path. The first version matched a quoted path
 * anywhere, and reported `verify-line.test.js` — where the string is a FIXTURE, deliberately naming an
 * untracked file to prove a verify clause refuses one. A gate that cannot tell an import from an example
 * fails on correct code, which is how gates get switched off. A regex over the text still could not: a
 * fixture that spells a whole import inside a template string matched it (every-local-named-import-is-exported's
 * own case), so the imports are read from the syntax tree: import and export declarations, `import()` and
 * `require()` with a literal path.
 */
const DIST = /server\/dist\/.+\.js$/;
function distImportsOf(file, text) {
  const found = [];
  walkEveryNode(parseSource(file, text), (node) => {
    let spec = null;
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) spec = node.moduleSpecifier.text;
    else if (ts.isCallExpression(node) && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) spec = node.arguments[0].text;
    if (spec && DIST.test(spec)) found.push(spec);
  });
  return found;
}

describe('a test that imports the build imports something that is still built', () => {
  it('every dist import resolves to a source file', () => {
    const tests = trackedSources(['testing'], { ext: ['.test.js', '.mjs'], floor: 100 });

    const orphans = [];
    for (const file of tests) {
      const text = readFileSync(join(REPO_ROOT, file), 'utf8');
      for (const distPath of distImportsOf(file, text)) {
        const src = sourceFor(distPath);
        // `.d.ts`-only and index re-exports are still sources; anything with no `.ts` at all is the case.
        if (!existsSync(join(REPO_ROOT, src))) orphans.push(`${file} → ${distPath} (no ${src})`);
      }
    }

    assert.deepEqual(orphans, [],
      'these import a compiled file whose SOURCE is gone:\n  ' + orphans.join('\n  ')
      + '\n\n      `tsc` writes outputs and never removes the ones whose sources were renamed away, so an '
      + 'import like this keeps passing locally against a module nothing ships — and fails in CI, which '
      + 'builds clean. Worse on a SPLIT: the old file is the code as it was before it was divided, and the '
      + 'assertions pass against a version that no longer exists.');
  });

  it('an import written inside a string is a fixture, not an import; a real import, a dynamic import and a require are', () => {
    // Bought by every-local-named-import-is-exported.test.js: its case proving a server/dist import is not judged carries
    // `import { x } from '../../server/dist/x.js'` inside a template string, and a regex over the text took it for an import.
    const q = '\x27';
    const fixture = `const files = { 'a.test.js': \`import { x } from ${q}../../server/dist/x.js${q};\` };\n`;
    assert.deepEqual(distImportsOf('f.test.js', fixture), []);
    const real = `import { a } from ${q}../../server/dist/a.js${q};\nconst b = await import(${q}../../server/dist/b.js${q});\nconst c = require(${q}../../server/dist/c.js${q});\nexport { d } from ${q}../../server/dist/d.js${q};\n`;
    assert.deepEqual(distImportsOf('f.test.js', real), ['../../server/dist/a.js', '../../server/dist/b.js', '../../server/dist/c.js', '../../server/dist/d.js']);
  });

  it('and the scan can actually see a dist import', () => {
    // A FLOOR on the reader itself. If `distImportsOf` ever stopped finding imports, the case above would report clean
    // having examined nothing — the same defect it exists to catch, one level up.
    const tests = trackedSources(['testing'], { ext: ['.test.js', '.mjs'], floor: 100 });
    const withImports = tests.filter(f => distImportsOf(f, readFileSync(join(REPO_ROOT, f), 'utf8')).length > 0);
    assert.ok(withImports.length > 10,
      `only ${withImports.length} test(s) appear to import from server/dist; the pattern is broken`);
  });
});
