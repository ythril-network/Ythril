/**
 * A recall can skip the reranker, on both doors and on every branch (`Q-88`).
 *
 * Owner, 2026-09-27: *"performance is also unbearable"*. Every debounced keystroke in a picker ran the full recall
 * including the cross-encoder, 16-25 s on a shared GPU. When the owner waits on it, speed wins. `rerank: false` skips
 * the over-fetch for the reranker and both rerank passes — the per-space one and the merged one — and nothing is
 * reported as degraded, because a skip the caller chose is not degradation.
 *
 * Structural, like `a-cross-space-recall-reranks-once.test.js`: the reranker needs a model to run, and what separates
 * a working switch from a broken one is whether every decision point reads it.
 *
 * Run: node --test testing/standalone/a-recall-can-skip-the-reranker.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const recall = stripComments(readFileSync('server/src/brain/recall.ts', 'utf8'));
const tool = stripComments(readFileSync('server/src/mcp/tools/search.ts', 'utf8'));

describe('every place the reranker is decided reads the switch', () => {
  it('the per-space recall: no reranking and no over-fetch for it when rerank is false', () => {
    assert.match(recall, /const reranking = rerankConfigured\(\) && opts\?\.rerank !== false;/,
      'recall() decides to rerank without asking the caller');
    // The over-fetch multiplier follows `reranking`, so it is skipped by the same decision.
    assert.match(recall, /perTypeFetch\(topK, reranking \? candidateMultiplier\(\) : 1\.5\)/);
  });

  it('the cross-space merge: the one merged pass is skipped too', () => {
    assert.match(recall, /const deferRerank = spaceIds\.length > 1 && rerankConfigured\(\) && opts\?\.rerank !== false;/,
      'recallGlobal still reranks the merged pool when the caller asked it not to');
  });

  it('the tool forwards it on every recallGlobal call, and only an explicit false skips', () => {
    const calls = [...tool.matchAll(/recallGlobal\([^;]*?\);/gs)].map(m => m[0]);
    assert.ok(calls.length >= 2, `found ${calls.length} recallGlobal call(s) in the recall tool — the scan is wrong`);
    for (const c of calls) assert.match(c, /\brerank\b/, `a recallGlobal call drops the switch: ${c.slice(0, 120)}`);
    assert.match(tool, /const rerank = a\['rerank'\] === false \? false : undefined;/);
  });
});

describe('the parameter is declared once, for both doors', () => {
  it('recall declares rerank, boolean, default true', async () => {
    const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
    const { toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');
    const recallTool = ALL_TOOLS.find(t => t.name === 'recall');
    const schema = recallTool.inputSchema(toolSchemasFor(['general']));
    assert.equal(schema.properties.rerank?.type, 'boolean', 'recall does not declare rerank');
    assert.equal(schema.properties.rerank?.default, true, 'the reranked answer must stay the default');
  });
});
