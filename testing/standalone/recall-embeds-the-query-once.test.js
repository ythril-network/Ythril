/**
 * A cross-space recall embeds the query ONCE, not once per space.
 *
 * ## How this was found, and why the reported mechanism was wrong
 *
 * The canary operator moved their text embedder onto a shared GPU endpoint and reindexed six instances. With the
 * endpoint saturated, every `recall` from their platform instance failed, and their access log showed the shape
 * exactly:
 *
 *     192.0.2.215  POST /v1/embeddings  429  29B  0.4-3ms   (recall, x5, every time)
 *
 * **Five rejections per recall, never four, never six.** They inferred one embedding call per knowledge type —
 * memories, entities, edges, chrono, files — and said plainly that they were inferring from the count rather
 * than reading our code.
 *
 * The count was real and the mechanism was not. `recall.ts` contains exactly ONE `embed(...)` call, inside
 * `recall(spaceId, …)`. The fan-out is `recallGlobal`, which calls `recall` once per space. Their five was five
 * SPACES. That distinction is the whole value of checking: the fix belongs at the fan-out, and someone reading
 * the per-type search for a five-way loop would have found nothing and concluded the report was wrong.
 *
 * ## Why the assertion is on the call COUNT
 *
 * A latency assertion would pass on a faster machine while the fan-out was still N-wide, and a "results are
 * correct" assertion passes either way — the vectors were identical, which is why nothing noticed for as long
 * as the embedder kept saying yes. The count is the property; everything else is a side effect of it.
 *
 * Run: node --test testing/standalone/recall-embeds-the-query-once.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const strip = s => s.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');
const src = () => strip(readFileSync('server/src/brain/recall.ts', 'utf8'));

const fn = (name) => {
  const s = src();
  const i = s.indexOf(`export async function ${name}(`);
  if (i < 0) return null;
  // To the next top-level export, or the end.
  const next = s.indexOf('\nexport ', i + 10);
  return s.slice(i, next < 0 ? undefined : next);
};

describe('the query is embedded once per RECALL, not once per space', () => {
  it('recallGlobal embeds it itself', () => {
    const g = fn('recallGlobal');
    assert.ok(g, 'recallGlobal is gone — re-point this test');
    assert.match(g, /await embed\(query, 'query'\)/,
      'the fan-out must embed once up front; without it each space embeds the identical text again');
  });

  it('and hands the SAME vector to every space', () => {
    const g = fn('recallGlobal');
    assert.match(g, /\{ \.\.\.opts, embedded[ ,}]/,
      'the precomputed vector must reach each recall call, or embedding it up front is pure waste added to N '
      + 'per-space calls that still embed');
    // Spreading `opts` matters as much as adding `embedded`: replacing the bag would silently drop
    // maxTimeMS/degraded/includeFreshWrites, so a deadline the caller set would stop being honoured.
    assert.ok(!/filter, \{ embedded \}\)/.test(g),
      'the options bag must be SPREAD, not replaced — otherwise maxTimeMS and degraded are silently dropped');
  });

  it('recall uses the handed-down vector when it has one', () => {
    assert.match(src(), /const embResult = opts\?\.embedded \?\? await embed\(query, 'query'\)/,
      'recall must prefer the precomputed vector; ignoring it would keep the N-wide fan-out');
  });

  it('recall still embeds for its own single-space callers', () => {
    // The fallback is load-bearing: recall is called directly from the per-space routes and from traverse.
    // Making `embedded` required would have pushed the embed call out to every one of them.
    assert.match(src(), /opts\?\.embedded \?\? await embed/,
      'a single-space caller passes no vector and must still get one');
  });

  it('there is exactly ONE embed call site for a query in this module', () => {
    // Two would be two places to keep in step, and the second is where a future fan-out re-appears.
    const calls = [...src().matchAll(/await embed\(query, 'query'\)/g)].length;
    assert.equal(calls, 2,
      `expected exactly two: the fallback in recall and the one in recallGlobal. Found ${calls} — a third is a `
      + 'new fan-out, and it will embed the same text again');
  });

  it('findSimilar was already doing it right, and still is', () => {
    // Worth pinning as the precedent: it loops spaces with ONE vector taken from the source record. It is the
    // shape recallGlobal now has, and if it ever grew an embed call inside its loop that would be this same
    // bug in the other function.
    const s = src();
    const i = s.indexOf('const searchSpaces = crossSpaceIds');
    assert.ok(i > 0, 'the findSimilar space loop moved — re-point this');
    const loop = s.slice(i, s.indexOf('allResults.push(...spaceResults)', i));
    assert.ok(!/await embed\(/.test(loop),
      'findSimilar must not embed inside its per-space loop — it has a vector already');
  });
});
