/**
 * A relative import of a tracked `.js` file with no `.ts` twin resolves to that file (Q-870, bundle-316).
 *
 * ## The defect this refuses
 *
 * `resolveRelativeSpecifier` (`_relative-specifier.mjs`) read `./x.js` as the server writes it, a spelling of `x.ts`, and answered `null` when
 * there was no such `.ts` file. A test helper written as a `.js` file (`testing/sync/helpers.js`) has no twin, so every import of one resolved to
 * nothing, and a gate that follows imports (the text-only classifier, which reads a test's closure) took a real helper for a path that leads nowhere. The
 * `.ts` file still wins when both exist, because the server's own imports are written that way.
 *
 * Run: node --test testing/standalone/a-relative-import-of-a-tracked-js-file-resolves-as-itself.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveRelativeSpecifier } from './_relative-specifier.mjs';

const tracked = (...files) => { const set = new Set(files); return (p) => set.has(p); };

describe('resolveRelativeSpecifier', () => {
  it('resolves ./x.js to the tracked .js file when there is no .ts twin', () => {
    assert.equal(resolveRelativeSpecifier('../sync/helpers.js', 'testing/standalone/a.test.js', tracked('testing/sync/helpers.js')), 'testing/sync/helpers.js');
  });

  it('prefers the .ts file when both exist (the server writes ./x.js for x.ts)', () => {
    assert.equal(resolveRelativeSpecifier('./x.js', 'server/src/a.ts', tracked('server/src/x.ts', 'server/src/x.js')), 'server/src/x.ts');
  });

  it('still resolves a .mjs file, a directory index and a missing file as before', () => {
    assert.equal(resolveRelativeSpecifier('./h.mjs', 'testing/standalone/a.test.js', tracked('testing/standalone/h.mjs')), 'testing/standalone/h.mjs');
    assert.equal(resolveRelativeSpecifier('./dir', 'server/src/a.ts', tracked('server/src/dir/index.ts')), 'server/src/dir/index.ts');
    assert.equal(resolveRelativeSpecifier('./gone.js', 'server/src/a.ts', tracked()), null);
    assert.equal(resolveRelativeSpecifier('typescript', 'server/src/a.ts', tracked('typescript')), null, 'a bare specifier is never a relative path');
  });
});
