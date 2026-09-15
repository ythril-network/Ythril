/**
 * `includeContent` reaches BOTH doors.
 *
 * ## The asymmetry
 *
 * MCP `recall` has had `includeContent` since it shipped: a caller can ask for file-chunk locations and
 * metadata WITHOUT the passage bodies, which is the difference between one expensive call and a cheap
 * two-phase flow — recall to find where something is, then read only the chunk you chose. A passage body is
 * by far the largest field a result carries, and every field is paid for `topK` times.
 *
 * REST had no way to ask. An integrator pointed it out, and it is the same shape as the four
 * two-surfaces-one-rule defects fixed on 2026-08-05 (`save_edge` existence checks,
 * `excludeFromVectorSearch` over REST and then over MCP, the recall ceiling): a capability that reaches one
 * door and not the other.
 *
 * ## Why the gate is written as a comparison
 *
 * The item was filed asking for exactly this — *"if it is wanted, it belongs behind the same cross-surface
 * gate as the others so it cannot regress on one side"*. So the check is not "REST has a flag"; it is "the
 * two surfaces agree", which is the property that was violated and the only one worth holding.
 *
 * Run: node --test testing/standalone/recall-include-content-both-surfaces.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const REST = 'server/src/api/brain/search.ts';
const MCP = 'server/src/mcp/tools/search.ts';

describe('recall exposes includeContent on both surfaces', () => {
  const rest = read(REST);
  const mcp = read(MCP);

  it('MCP still has it — otherwise this gate is comparing REST to nothing', () => {
    assert.match(mcp, /includeContent/, `${MCP} no longer mentions includeContent`);
    assert.match(mcp, /includeContent: \{/, 'the MCP tool must still ADVERTISE it in its schema');
  });

  it('REST accepts it', () => {
    assert.match(rest, /includeContent/, `${REST} does not accept includeContent — the asymmetry is back`);
  });

  it('both default to TRUE, so neither surface silently thins an existing caller’s results', () => {
    // The default is the compatibility guarantee: only an explicit `false` opts out.
    assert.match(mcp, /a\['includeContent'\] !== false/, 'MCP must treat only an explicit false as opt-out');
    assert.match(rest, /includeContentRaw !== false/, 'REST must treat only an explicit false as opt-out');
  });

  it('REST refuses a non-boolean rather than coercing it', () => {
    // `"false"` is truthy. An opt-out that silently does nothing is worse than one that errors — and this is
    // the flag whose whole purpose is to make a response smaller.
    assert.match(rest, /`includeContent` must be a boolean/);
  });

  it('drops only `content`, and only on file results', () => {
    // The flag is about the passage body. Thinning anything else would make it a different feature with the
    // same name on the two surfaces — which is the defect class this gate exists for, one level in.
    assert.match(rest, /r\.type !== 'file'/, 'the strip must be scoped to file results');
    assert.match(rest, /const \{ content: _dropped, \.\.\.rest \} = r/, 'and drop `content` alone');
  });

  it('every traverse path honours it too', () => {
    // A caller who asked not to be sent passage bodies did not stop meaning it because they also asked for
    // graph expansion. An option that lapses on one code path is the same defect one level down.
    //
    // Anchored on `buildGraphWithSpill(`, which is what a graph-augmented response is BUILT with, rather than on
    // one implementation's variable name. The previous anchor was `const results: RecallTraverseItem[]`, and
    // when the flat item type was deleted this gate failed against code that still did the right thing —
    // demanding the old lines back rather than the property.
    //
    // Both routes, not one: `/recall` and `/find-similar` each expand a graph, and the flag has to survive on
    // both. `similar`'s traverse existed on MCP alone for a while, so this is the site where the two
    // surfaces most recently disagreed.
    // The window used to be `at + 900`, and a comment added above the strip pushed the call out of it — the
    // gate went red against code that still did the right thing, for the second time in this file's life. A
    // character count is the wrong bound twice over: it also spans different LINES on a CRLF working copy
    // than in CI's LF checkout. So the window now ends at the next `res.json(` — the structural end of the
    // response this branch is building — and the assertion is about what happens inside it.
    const sites = [...rest.matchAll(/buildGraphWithSpill\(/g)].map(m => m.index);
    assert.equal(sites.length, 2, `expected /recall and /find-similar to build a graph, found ${sites.length}`);
    for (const at of sites) {
      const responseAt = rest.indexOf('res.json(', at);
      assert.ok(responseAt > at,
        'no `res.json(` after a graph build — the handler changed shape, so this gate measures nothing');
      const window = rest.slice(at, responseAt);
      assert.match(window, /stripContentIfAsked\([^)]*safeIncludeContent\)/,
        'a traverse response must apply the same strip as the plain one');
      // The same question for the flag that arrived beside it. `includeDiagnostics` is recursive by the
      // owner's ruling — the `_graph` subtree follows it at every depth — and the only way a traverse branch
      // can honour that is by nesting through `mapGraphNodes`, which takes the flag. Attaching
      // `graph.bySeed` raw is how REST used to return the whole edge document, vector included.
      assert.match(window, /mapGraphNodes\([^;]*safeIncludeDiagnostics(, safeProjection)?\)/,
        'a traverse response must nest through mapGraphNodes and pass the diagnostics flag down');
    }
  });

  it('does not mutate the results it was given', () => {
    // `seeds` is also handed to the traverse builder and to the audit outcome; deleting a field in place
    // would change what those saw.
    assert.match(rest, /return results\.map\(/, 'the strip must copy rather than delete in place');
  });

  it('both surfaces document it', () => {
    // Named files, NOT `readGuide()` from `_docs.mjs`.
    //
    // That helper concatenates every part of the integration guide, and `16-mcp.md` is one of those parts —
    // so both sides of this two-surface comparison would be the same string and the check would pass on a
    // single mention in either. A helper that exists to make a check split-proof would have made this one
    // vacuous. The cost is that a further split has to update the path here; the gate names the part it
    // reads so that failure is a missing file, not a silent pass.
    const restDoc = read('docs/integration-guide/04a-recall-api.md');
    const mcpDoc = read('docs/integration-guide/16-mcp.md');
    for (const [name, doc] of [['recall-api', restDoc], ['mcp', mcpDoc]]) {
      assert.match(doc, /includeContent/, `${name} guide does not mention includeContent`);
    }
  });
});
