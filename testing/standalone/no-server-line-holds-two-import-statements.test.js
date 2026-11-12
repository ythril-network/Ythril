/**
 * No line of the server's TypeScript holds two import (or re-export) statements.
 *
 * ## Why a lint
 *
 * A revert in bundle-265 (32cd0ca8) left `import { spaceActApplied } from '../networks/round-state.js';import { warnOnce } from '../util/warn-once.js';`
 * on one line of `sync/space-exchange-set.ts`. The compiler takes it, no formatter runs in preflight, and the review lens found it by eye (Q1). A line a
 * reader skims as one import hides the second, and every gate that reads imports line by line (`no-runtime-import-cycles` anchors its pattern at a line
 * start) misses the second statement's edge.
 *
 * ## Seen red
 *
 * At c244852b: `server/src/sync/space-exchange-set.ts:39`.
 *
 * Run: node --test testing/standalone/no-server-line-holds-two-import-statements.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';

/** A module specifier closing a statement, then a second import or re-export on the same line. */
const FUSED = /['"]\s*;\s*(?:import|export)\b[^\n]*['"]/;
const STARTS_A_STATEMENT = /^\s*(?:import|export)\b/;

describe('no server line holds two import statements', () => {
  const sources = readTrackedSources('server/src', { untracked: true });

  it('read the server tree', () => {
    assert.ok(sources.length >= 150, `only ${sources.length} server sources were read: the listing is broken`);
  });

  it('every import and re-export statement has a line of its own', () => {
    const found = [];
    for (const { file, text } of sources) {
      text.split('\n').forEach((line, i) => {
        if (STARTS_A_STATEMENT.test(line) && FUSED.test(line)) found.push(`${file}:${i + 1}: ${line.trim()}`);
      });
    }
    assert.deepEqual(found, [], 'split each onto its own line: a second statement after a `;` is skimmed past by a reader and by every line-anchored import gate');
  });

  it('the rule finds a fused pair and passes a single statement (it is not vacuous)', () => {
    const fused = "import { a } from './a.js';import { b } from './b.js';";
    assert.ok(STARTS_A_STATEMENT.test(fused) && FUSED.test(fused));
    assert.ok(FUSED.test("export { a } from './a.js'; export * from './b.js';"));
    assert.ok(!FUSED.test("import { a } from './a.js';"));
    assert.ok(!FUSED.test("import type { A } from './a.js'; // import is a word in a comment"));
  });
});
