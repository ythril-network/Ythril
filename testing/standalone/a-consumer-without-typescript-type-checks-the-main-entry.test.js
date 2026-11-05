/**
 * A consumer that has no `typescript` installed type-checks the schema package (`.`): `schema/dist/index.d.ts` and every declaration file it reaches never
 * reference the compiler (Q-687, design v3 item 12).
 *
 * ## The defect this prevents
 *
 * `typescript` is an OPTIONAL peer of the package: only the schema package's from-typescript entry uses it, through the caller's own copy. If `index.d.ts` (or a module
 * it reaches) wrote `import type ts from 'typescript'`, `export * from './from-typescript.js'`, or `import('typescript').Program` in a signature, every
 * consumer that does not install the compiler would get "Cannot find module 'typescript'" from its own `tsc` the day it imported the package, and
 * `skipLibCheck: false` consumers would fail outright; the runtime would be fine, so no test of the built JS would see it. The main entry never loads the
 * compiler at runtime (held by the child-process test) and, held here, never names it in a type.
 *
 * ## What is held
 *
 * - The declaration closure of `schema/dist/index.d.ts` (the files the TypeScript program reaches from it) holds no file of `node_modules/typescript`, and no
 *   declaration file under `schema/dist` names `typescript` by an import, a re-export, an `import()` type or a `/// <reference types>`.
 * - The same closure for `internal.d.ts` (the server's door is no door for the compiler either).
 * - That closure type-checks: no diagnostic of the program is reported for a file under `schema/dist`.
 * - The reader has floors (it reached many files) and is proven on planted declaration files in a temp directory: a type import, a re-export, an `import()`
 *   type and a reference directive are each seen, and a clean one is not.
 *
 * Run: node --test testing/standalone/a-consumer-without-typescript-type-checks-the-main-entry.test.js
 * (requires a prior `npm run build -w schema`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import ts from 'typescript';
import { stripComments } from './_strip-comments.mjs';

/** A way a declaration file names the compiler: a static import or re-export, an `import()` type, a `require`, a reference directive. */
const NAMES_COMPILER = [
  /\bfrom\s*['"]typescript['"]/, /^\s*import\s*['"]typescript['"]/m, /\bimport\s*\(\s*['"]typescript['"]\s*\)/, /\brequire\s*\(\s*['"]typescript['"]\s*\)/,
];

/**
 * What `entry` (an absolute `.d.ts`) reaches of the compiler: `{ files, reaches, named, diagnostics }`. `files` is the closure's size, `reaches` the closure's
 * files that ARE the compiler's, `named` the closure's own files (outside `node_modules`) that name it, `diagnostics` the program's problems in those own files.
 */
export function compilerReach(entry) {
  const program = ts.createProgram([entry], { module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext, noEmit: true, types: ['node'] });
  const all = program.getSourceFiles();
  const norm = (f) => f.replace(/\\/g, '/');
  const own = all.filter(f => !norm(f.fileName).includes('/node_modules/') && !norm(f.fileName).includes('/typescript/lib/'));
  // The compiler's own declarations (`typescript.d.ts`, `typescript/lib/*.d.ts` beyond the default libs the checker always loads) are what a reference reaches.
  const reaches = all.filter(f => /\/node_modules\/typescript\//.test(norm(f.fileName)) && !/\/typescript\/lib\/lib\.[^/]*\.d\.ts$/.test(norm(f.fileName))).map(f => norm(f.fileName));
  const named = own.filter(f => {
    const text = stripComments(f.text);
    return NAMES_COMPILER.some(re => re.test(text)) || /\/\/\/\s*<reference\s+types=["']typescript["']/.test(f.text);
  }).map(f => norm(f.fileName));
  const diagnostics = own.flatMap(f => [...program.getSyntacticDiagnostics(f), ...program.getSemanticDiagnostics(f)])
    .map(d => `${d.file ? norm(d.file.fileName) : ''}: ${ts.flattenDiagnosticMessageText(d.messageText, '\n')}`);
  return { files: all.length, reaches, named, diagnostics };
}

describe('the reader this gate stands on (planted declaration files)', () => {
  /** One planted package: `index.d.ts` with `body`, in a fresh temp directory the callback may read. */
  const planted = (body, check) => {
    const dir = mkdtempSync(join(tmpdir(), 'ythril-consumer-'));
    try {
      writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
      writeFileSync(join(dir, 'index.d.ts'), body);
      return check(compilerReach(join(dir, 'index.d.ts')));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };

  it('sees a type import, a re-export, an import() type and a reference directive of the compiler', () => {
    for (const body of [
      "import type ts from 'typescript';\nexport declare const p: ts.Program;\n",
      "export * from 'typescript';\n",
      "export type P = import('typescript').Program;\n",
      '/// <reference types="typescript" />\nexport declare const x: number;\n',
    ]) planted(body, r => assert.ok(r.named.length >= 1, `a planted file naming the compiler was not seen: ${body}`));
  });

  it('does not see a clean file, or a comment that names the compiler', () => {
    planted("// import type ts from 'typescript'\n/** `import('typescript')` is in the entry, not here */\nexport declare const x: number;\n",
      r => assert.deepEqual([r.named, r.reaches, r.diagnostics], [[], [], []]));
  });
});

describe('a consumer without typescript type-checks the main entry', () => {
  for (const entry of ['index.d.ts', 'internal.d.ts']) {
    describe(`schema/dist/${entry}`, () => {
      const reach = compilerReach(join(process.cwd(), 'schema/dist', entry));

      it('reaches many declaration files (the reader is not blind)', () => {
        assert.ok(reach.files >= 15, `the program reached only ${reach.files} files from ${entry}: build the package first`);
      });

      it('reaches no file of the compiler, and none of its own files names it', () => {
        assert.deepEqual(reach.reaches, [], `${entry} reaches the compiler's own declarations`);
        assert.deepEqual(reach.named, [], `${entry}'s closure names typescript: a consumer without it fails to type-check`);
      });

      it('type-checks: the program reports nothing in a file under schema/dist', () => {
        assert.deepEqual(reach.diagnostics, []);
      });
    });
  }

  it('the built declarations hold no from-typescript reference in the main entries (a text check beside the program)', () => {
    for (const entry of ['index.d.ts', 'internal.d.ts']) {
      assert.doesNotMatch(readFileSync(join(process.cwd(), 'schema/dist', entry), 'utf8'), /from-typescript/, `${entry} reaches the from-typescript entry`);
    }
  });
});
