/**
 * The replicated families travel TARGETS FIRST: every family a reference can point at is sent before every family
 * that holds references — so on the push door, where each family is its own request, a reference never arrives
 * ahead of a target the same cycle carries (bundle-30 I13, pre-ship observability O1 / data-integrity DI-1).
 *
 * ## Why an order, and why it is derived
 *
 * The sender pushes one family per `batch-upsert` request in `REPLICATED_FAMILIES` order, and the receiver checks
 * strict linkage after each request. The order was facts, entities, edges, chrono, links, filemeta: edges before
 * the chrono entries they may point at, links before the files. Each was recorded missing, permanently.
 *
 * The sets are read from the code, never listed here: the targets are the collections `REF_KINDS` resolve to
 * (`collectionForRefKind`), the holders are the families the linkage check collects (`REFERENCE_FAMILIES`). A new
 * reference kind or a new referencing family is held to the rule the day it is declared.
 *
 * And the order is only worth something if both directions read it: the engine pushes by iterating the list, and
 * both push doors tell the check which families are still to come from the same list.
 *
 * Run: node --test testing/standalone/the-sync-order-puts-targets-before-references.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { REPLICATED_FAMILIES } = await import('../../server/dist/sync/replicated-families.js');
const { REF_KINDS } = await import('../../server/dist/config/types-knowledge.js');
const { collectionForRefKind } = await import('../../server/dist/brain/entity-refs.js');
const linkage = await import('../../server/dist/sync/linkage-check.js');
const src = (f) => stripComments(readFileSync(f, 'utf8'));

describe('the sync order puts targets before references', () => {
  it('every family a reference can point at comes before every family that holds references', () => {
    const holders = linkage.REFERENCE_FAMILIES;
    assert.ok(Array.isArray(holders) && holders.length >= 2,
      'the linkage check does not declare which families hold references (REFERENCE_FAMILIES) — nothing to order by');
    const position = new Map(REPLICATED_FAMILIES.map((f, i) => [f.payloadKey, i]));
    const targets = REF_KINDS.map(k => REPLICATED_FAMILIES.find(f => f.collection === collectionForRefKind(k)));
    assert.equal(targets.filter(Boolean).length, REF_KINDS.length,
      `a reference kind resolves to no replicated family: ${REF_KINDS.filter((_, i) => !targets[i])}`);
    const late = [];
    for (const h of holders) {
      assert.ok(position.has(h), `${h} is not a replicated family`);
      for (const t of targets) if (position.get(t.payloadKey) > position.get(h)) late.push(`${t.payloadKey} after ${h}`);
    }
    assert.deepEqual(late, [], `a target family travels after a family whose references point at it: ${late.join(', ')} `
      + `(order: ${REPLICATED_FAMILIES.map(f => f.payloadKey).join(', ')})`);
  });

  it('the engine pushes in that order, and both push doors take what is still to come from it', () => {
    const engine = src('server/src/sync/engine.ts');
    assert.match(engine, /for \(const family of REPLICATED_FAMILIES\) \{\s*pushed\[family\.payloadKey\] = await pushCollection\(/,
      'the push cycle no longer iterates REPLICATED_FAMILIES — the order above is not the order sent');
    const docs = src('server/src/api/sync/docs.ts');
    // `run` awaits the check, `start` starts it and answers (bundle-30 I13); either must say what is still to come.
    const runs = [...docs.matchAll(/linkage\.(?:run|start)\(([^)]*)\)/g)].map(m => m[1]);
    assert.ok(runs.length >= 2, `expected the single and the batch push door to run the check, found ${runs.length}`);
    for (const args of runs) {
      assert.match(args, /stillToCome:\s*familiesAfter\(/,
        `a push door checks without saying which families the sender has still to send: linkage.run(${args})`);
    }
  });

  it('familiesAfter names the collections after the last family a request carries', async () => {
    const { familiesAfter } = await import('../../server/dist/sync/replicated-families.js');
    assert.equal(typeof familiesAfter, 'function', 'there is no one place that answers "what has the sender still to send"');
    const keys = REPLICATED_FAMILIES.map(f => f.payloadKey);
    for (const [i, key] of keys.entries()) {
      assert.deepEqual(familiesAfter([key]), REPLICATED_FAMILIES.slice(i + 1).map(f => f.collection), `after ${key}`);
    }
    assert.deepEqual(familiesAfter([keys[0], keys.at(-1)]), [], 'a request carrying the last family leaves nothing to come');
  });
});
