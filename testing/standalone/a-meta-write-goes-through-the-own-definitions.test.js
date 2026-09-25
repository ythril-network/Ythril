/**
 * Once a network sends a space schema, `space.meta` is REBUILT from the space's own definitions and the network
 * layers (`F-39.2`, `spaces/effective-meta.ts`). A write that sets `meta` directly is then undone at the next
 * recompute — silently, and only on a space in a network, which is the case nobody tests by hand.
 *
 * So every site that writes a space's meta goes through `commitOwnMetaEdit`, except two with a reason:
 *  - `spaces/effective-meta.ts` — it IS the recompute;
 *  - `spaces/meta-update.ts` — the edit path for a space in NO network, where there is no layer; it keeps
 *    `ownMeta` in step itself, which the second case checks.
 *
 * The sites are derived from the source (every `updateSpace(…, { …meta… })` call), with a floor.
 *
 * Run: node --test testing/standalone/a-meta-write-goes-through-the-own-definitions.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const ALLOWED = new Map([
  ['server/src/spaces/effective-meta.ts', 'it is the recompute itself'],
  ['server/src/spaces/meta-update.ts', 'the edit path for a space in no network; keeps ownMeta in step'],
]);

const files = trackedSources(['server/src'], { floor: 100 });
const writers = files.filter(f => /updateSpace\([^;]*?\{[^;}]*\bmeta\b/s.test(stripComments(readFileSync(f, 'utf8'))));

describe('a meta write goes through the own definitions', () => {
  it('the scan found the writers it must judge', () => {
    assert.ok(writers.length >= 2, `only ${writers.length} meta writers found — the pattern has lost its subjects`);
  });

  it('no file writes a space\'s meta around the layers', () => {
    const around = writers.map(f => f.replace(/\\/g, '/')).filter(f => !ALLOWED.has(f));
    assert.deepEqual(around, [], `these write space.meta directly; use commitOwnMetaEdit (spaces/effective-meta.ts): ${around.join(', ')}`);
  });

  it('the no-network edit path keeps ownMeta in step', () => {
    assert.match(stripComments(readFileSync('server/src/spaces/meta-update.ts', 'utf8')), /\.ownMeta = replicatedMetaOf\(mergedMeta\)/);
  });
});
