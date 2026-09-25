/**
 * An unchanged schema layer writes nothing (`F-39.2` follow-up, found in the pre-ship lens pass).
 *
 * `pullSpaceMetaFromUpstream` runs for every space on every sync cycle and hands what it receives to
 * `storeNetworkLayer`. It stored the layer and recomputed unconditionally, and the recompute saved the config even
 * when nothing had changed — a full config rewrite per space per cycle, the write loop this repo has met before
 * (`versionCheckedAt` stamped every round turned an idle network into a continuous write loop).
 *
 * A source gate, because the property is "this path does not reach `saveConfig`", and the module reads the live
 * config singleton; the two early exits it pins are small enough to read.
 *
 * Run: node --test testing/standalone/an-unchanged-schema-layer-writes-nothing.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { blockAfter } from './_structural-window.mjs';

const SRC = stripComments(readFileSync('server/src/spaces/effective-meta.ts', 'utf8'));
const body = (fn) => {
  const at = SRC.indexOf(`export function ${fn}(`);
  assert.ok(at > -1, `${fn} not found — re-anchor this gate`);
  return blockAfter(SRC, SRC.indexOf(')', at), fn);
};

describe('an unchanged schema layer writes nothing', () => {
  it('storeNetworkLayer returns before storing or recomputing when the layer is the same', () => {
    const b = body('storeNetworkLayer');
    const same = b.search(/isDeepStrictEqual\(net\.schemaLayers\?\.\[spaceId\], meta\)\) return false/);
    assert.ok(same > -1, 'storeNetworkLayer must return early for an identical layer');
    assert.ok(same < b.indexOf('recomputeEffectiveMeta('), 'the early return must come before the recompute');
  });

  it('an unchanged recompute saves only when the caller changed stored state', () => {
    const b = body('recomputeEffectiveMeta');
    assert.match(b, /if \(setApart \|\| persist\) saveConfig\(cfg\);/,
      'the equal branch must not save unconditionally');
    assert.doesNotMatch(b, /\{\s*saveConfig\(cfg\);\s*return false;\s*\}/, 'the old unconditional save is back');
  });
});
