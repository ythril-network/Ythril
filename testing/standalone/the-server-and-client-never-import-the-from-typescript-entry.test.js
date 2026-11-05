/**
 * No file of `server/src` or `client/src` imports `@ythril/schema/from-typescript` (Q-687, design v3 item 12).
 *
 * ## The defect this prevents
 *
 * The entry reads TypeScript source with the CALLER'S compiler, loaded by a dynamic `import('typescript')`. `typescript` is a development dependency of
 * this repository and an optional peer of the package, and the published image installs with `--omit=dev`: it carries no compiler. A server module that imported
 * the entry would pass every test on a developer's machine (where `typescript` is installed) and fail on the first call in the image, with an install
 * message the operator cannot act on. The client bundle would pull the entry (and its closed host over `sys.readFile`) into the browser. The entry is for
 * apps that write schemas; the server and the client have no use for it, and a gate says so before a convenience import appears.
 *
 * ## What is held
 *
 * - No tracked source under `server/src` or `client/src` (`.ts`, `.tsx`, `.js`, `.mjs`, `.cjs`) names the entry: not as a static import, a
 *   re-export, a dynamic `import()`, a `require`, nor by a path into `schema/src` or `schema/dist` (`.../from-typescript`).
 * - The scan has floors (it saw both trees), and is proven on planted sources: each form above is refused, a comment naming it and the main entry
 *   `@ythril/schema` and `@ythril/schema/internal` are not.
 *
 * Run: node --test testing/standalone/the-server-and-client-never-import-the-from-typescript-entry.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** The ways a source names the entry: the package specifier, or a path to its module in the package's source or build. */
const ENTRY_NAMED = /@ythril\/schema\/from-typescript|\bschema\/(?:src|dist)\/from-typescript\b/;

/** Whether `text`, read as source, names the entry. Comments are not code; the specifier is looked for in what is left. */
export const namesTheEntry = (text) => ENTRY_NAMED.test(stripComments(text));

describe('the scan this gate stands on (planted sources)', () => {
  it('refuses each way of naming the entry', () => {
    for (const form of [
      "import { spaceMetaFromTypeScript } from '@ythril/schema/from-typescript';",
      "export * from '@ythril/schema/from-typescript';",
      "const m = await import('@ythril/schema/from-typescript');",
      "const m = require('@ythril/schema/from-typescript');",
      "import x from '../../schema/dist/from-typescript.js';",
      "import x from '../../../schema/src/from-typescript.js';",
    ]) assert.equal(namesTheEntry(form), true, form);
  });

  it('does not refuse the main entries, a different module of the same name stem, or a comment', () => {
    for (const ok of [
      "import { validateSpaceMeta } from '@ythril/schema';",
      "import { LruMap } from '@ythril/schema/internal';",
      "import { typesOfSpaceMeta } from '@ythril/schema'; // never '@ythril/schema/from-typescript'",
      "/* @ythril/schema/from-typescript is for apps */\nconst a = 1;",
      "import { x } from './from-typescript-notes.js';",
    ]) assert.equal(namesTheEntry(ok), false, ok);
  });
});

describe('server/src and client/src never import @ythril/schema/from-typescript', () => {
  const files = [
    ...trackedSources('server/src', { ext: ['.ts', '.js', '.mjs', '.cjs'], floor: 100 }),
    ...trackedSources('client/src', { ext: ['.ts', '.tsx', '.js', '.mjs'], floor: 20 }),
  ];

  it('scanned both trees', () => {
    assert.ok(files.some(f => f.startsWith('server/src/')) && files.some(f => f.startsWith('client/src/')), 'one of the two trees was not listed');
  });

  it('none of the files names the entry', () => {
    const named = files.filter(f => namesTheEntry(readFileSync(f, 'utf8')));
    assert.deepEqual(named, [], `these files import the from-typescript entry, which the image (--omit=dev) and the browser cannot load:\n${named.join('\n')}`);
  });
});
