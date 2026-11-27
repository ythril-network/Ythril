/**
 * The update that raises the triple index's write counter is spelled in ONE module, a leaf every writer of the state row imports
 * (bundle-378, Q-976, lens finding L1.2).
 *
 * ## The rule
 *
 * `writes` on the state row rises with every change of the index (`the-triple-index-write-counter-rises-with-each-change-db.test.js`). The update
 * part that raises it, `{ $inc: { writes: 1 } }`, was spelled as `RAISE_WRITES` in `store.ts`, inline in `stale-mark.ts` and inline in
 * `sync/positions-rollback.ts`: a fourth writer that spelled it wrongly (a second counter name, `+2`) would be a counter that says "unchanged" for a
 * changed index, which the planning-count cache believes. Here it is one constant in `rdf/triple-index/write-counter.ts`, a leaf: it imports nothing, so
 * `stale-mark.ts` (which keeps out of `store.ts`'s import cycle) and the rollback tool (which runs with no instance up) can import it.
 *
 * ## Held how
 *
 * Over the tracked server sources: no `$inc` of `writes` outside that module, and the module imports nothing. A hand-spelled copy fails this by name.
 *
 * ## Seen red
 *
 * On f91569511 the update is spelled in `store.ts`, `rdf/triple-index/stale-mark.ts` and `sync/positions-rollback.ts`, and the module does not exist.
 *
 * Run: node --test testing/standalone/the-triple-index-write-counter-update-is-spelled-in-one-module.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const MODULE = 'server/src/rdf/triple-index/write-counter.ts';
/** `$inc` naming the counter, however the braces and spaces fall. */
const SPELLED = /\$inc\s*:\s*(?:Object\.freeze\(\s*)?\{\s*writes\s*:/;
/** Comments out: a docblock that quotes the update is not a spelling of it. */
const code = stripComments;

describe('the write counter update is spelled in one module', () => {
  const sources = readTrackedSources(['server/src'], { ext: ['.ts'], specs: false, floor: 50 });

  it('no module but the leaf spells the update', () => {
    const spellers = sources.filter(s => SPELLED.test(code(s.text))).map(s => s.file.replace(/\\/g, '/'));
    assert.deepEqual(spellers, [MODULE], `the counter's update is spelled in ${spellers.join(', ')}; it belongs in ${MODULE} only`);
  });

  it('the leaf imports nothing, so a module outside the store\'s import cycle can take it', () => {
    const leaf = sources.find(s => s.file.replace(/\\/g, '/') === MODULE);
    assert.ok(leaf, `${MODULE} does not exist`);
    assert.doesNotMatch(code(leaf.text), /^\s*import\s/m, 'the leaf imports another module');
  });

  it('every writer of the counter imports it from the leaf', () => {
    for (const file of ['server/src/rdf/triple-index/store.ts', 'server/src/rdf/triple-index/stale-mark.ts', 'server/src/sync/positions-rollback.ts']) {
      const s = sources.find(x => x.file.replace(/\\/g, '/') === file);
      assert.ok(s, `${file} is not tracked`);
      assert.match(s.text, /from '[./]*(?:rdf\/triple-index\/|\.\/)?write-counter\.js'/, `${file} does not import the counter's update from write-counter.ts`);
    }
  });
});
