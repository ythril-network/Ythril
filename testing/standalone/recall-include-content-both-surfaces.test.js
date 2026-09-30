/**
 * `includeFileContent` reaches BOTH doors.
 *
 * ## The asymmetry
 *
 * MCP `recall` has had `includeFileContent` since it shipped: a caller can ask for file-chunk locations and
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
import { routeBody, delegatesCleanly } from './_delegating-routes.mjs';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom, bodyOf } from './_structural-window.mjs';
import { ALL_TOOLS } from '../../server/dist/mcp/tools/index.js';
import { makeArgsValidator } from '../../server/dist/mcp/validate-args.js';
import { toRecallRecord } from '../../server/dist/mcp/tools/shared.js';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');
const REST = 'server/src/api/brain/search.ts';
const MCP = 'server/src/mcp/tools/search.ts';
const schemas = {
  requiredSpace: { type: 'string', enum: ['general'], description: 'Space ID.' },
  optionalSpace: { type: 'string', enum: ['general'], description: 'Optional space ID.' },
};
const schemaOf = (name) => ALL_TOOLS.find(t => t.name === name).inputSchema(schemas);
const toolNamed = (name) => ALL_TOOLS.find(t => t.name === name);
const validator = makeArgsValidator(schemas, ['general']);
const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';
const FILE_HIT = { _id: 'c1', type: 'file', score: 0.9, spaceId: 'general', path: 'doc.md', parentFileId: 'f1',
  chunkIndex: 2, headingText: 'Intro', content: 'the passage' };
const FACT_HIT = { _id: 'm1', type: 'fact', score: 0.8, spaceId: 'general', fact: 'a fact', content: 'not a passage' };

describe('recall exposes includeFileContent on both surfaces', () => {
  const rest = stripComments(read(REST));
  const mcp = stripComments(read(MCP));

  it('MCP still has it — otherwise this gate is comparing REST to nothing', () => {
    assert.match(mcp, /includeFileContent/, `${MCP} no longer mentions includeFileContent`);
    assert.match(mcp, /includeFileContent: \{/, 'the MCP tool must still ADVERTISE it in its schema');
  });

  /*
   * ## Where REST's half lives now (`Q-89`)
   *
   * REST held its own copy: `stripContentIfAsked`, its own `includeFileContentRaw !== false` default, its own
   * "must be a boolean" refusal, and the strip applied again on each traverse branch. `/recall` and then
   * `/similar` collapsed onto `callTool`, so REST takes the flag by handing the body to the tool, and the
   * tool's single row builder — `hitRow` → `toRecallRecord` — is the one implementation both doors answer
   * through. The cases below assert each property where it now lives, and that REST reaches it.
   */
  it('REST accepts it — by handing the body to a tool that advertises it', () => {
    for (const [path, tool] of [['/recall', 'recall'], ['/similar', 'similar']]) {
      const body = routeBody(rest, path);
      assert.ok(body, `POST ${path} is not in ${REST} — re-anchor this gate`);
      assert.ok(delegatesCleanly(body, `POST ${path}`),
        `POST ${path} no longer delegates to the ${tool} tool, so it must take includeFileContent itself — the asymmetry is back`);
      assert.ok(schemaOf(tool).properties.includeFileContent,
        `the ${tool} tool does not advertise includeFileContent, so neither door takes it`);
    }
  });

  it('both default to TRUE, so neither surface silently thins an existing caller’s results', () => {
    // The default is the compatibility guarantee: only an explicit `false` opts out. One per search tool,
    // and the count is a floor on sites found rather than a total.
    const sites = (mcp.match(/a\['includeFileContent'\] !== false/g) ?? []).length;
    assert.ok(sites >= 2, `only ${sites} tool site(s) treat only an explicit false as opt-out; recall and similar both must`);
    for (const tool of ['recall', 'similar']) {
      assert.equal(schemaOf(tool).properties.includeFileContent.default, true, `${tool} must advertise the default as true`);
    }
    // And the builder keeps content when the flag is absent, so a caller that never sends it loses nothing.
    assert.equal(toRecallRecord(FILE_HIT).content, 'the passage', 'an absent flag must keep the passage');
  });

  it('a non-boolean is refused rather than coerced, on both tools and so on both doors', () => {
    // `"false"` is truthy. An opt-out that silently does nothing is worse than one that errors — and this is
    // the flag whose whole purpose is to make a response smaller. Exercised through the dispatcher's own
    // validator, which is what refuses it for a REST caller now.
    for (const [tool, args] of [['recall', { query: 'x' }], ['similar', { entryId: UUID, entryType: 'entity' }]]) {
      assert.equal(validator.validate(toolNamed(tool), { ...args, includeFileContent: false }), null,
        `${tool} must accept a boolean includeFileContent — otherwise the refusal below proves nothing`);
      assert.notEqual(validator.validate(toolNamed(tool), { ...args, includeFileContent: 'false' }), null,
        `${tool} coerces a string includeFileContent instead of refusing it`);
    }
  });

  it('drops only `content`, and only on file results', () => {
    // The flag is about the passage body. Thinning anything else would make it a different feature with the
    // same name on the two surfaces — which is the defect class this gate exists for, one level in.
    const kept = toRecallRecord(FILE_HIT, { includeFileContent: true });
    const thinned = toRecallRecord(FILE_HIT, { includeFileContent: false });
    assert.equal(kept.content, 'the passage', 'the fixture must carry a passage, or the drop below proves nothing');
    assert.equal(thinned.content, undefined, 'includeFileContent: false must drop the passage');
    const { content: _dropped, ...others } = kept;
    assert.deepEqual(thinned, others, 'and drop `content` alone — path, chunk index and heading are the point of the flag');
    assert.deepEqual(toRecallRecord(FACT_HIT, { includeFileContent: false }), toRecallRecord(FACT_HIT),
      'the strip must be scoped to file results');
  });

  it('every traverse path honours it too', () => {
    // A caller who asked not to be sent passage bodies did not stop meaning it because they also asked for
    // graph expansion. An option that lapses on one code path is the same defect one level down.
    //
    // Anchored on `traversedAnswer(` — the one builder every traversing answer goes through (Q-126) — and on
    // the row it is handed. REST's own traverse branches went with its handlers (`/recall`, then `/similar` at
    // `Q-89`); this case measured those windows, and after the collapse it found none and looped over
    // nothing while passing. So it measures the tool's sites, which are the only implementation there is,
    // with a floor so an empty sweep fails.
    const sites = [...mcp.matchAll(/traversedAnswer\(/g)].map(m => m.index);
    assert.ok(sites.length >= 2, `only ${sites.length} traversing answer(s) in ${MCP}; recall and similar both expand a graph`);
    for (const at of sites) {
      const args = balancedFrom(mcp, mcp.indexOf('(', at), 'a traversedAnswer call');
      assert.match(args, /shapeRow: \(r, nodes\) => hitRow\(r, shape, nodes\)/,
        'a traverse response must shape its rows through the same builder, with the same shape, as the plain one');
    }
    // The same builder on the plain branches, so the flag cannot mean one thing plain and another traversed.
    assert.ok((mcp.match(/\.map\(r => hitRow\(r, shape\)\)/g) ?? []).length >= 2,
      'a plain search branch shapes its rows without hitRow, so the flag has two implementations again');
    const row = bodyOf(mcp, 'hitRow');
    assert.match(row, /includeFileContent: shape\.includeFileContent/, 'hitRow must pass the flag to the record builder');
    // `includeDiagnostics` is recursive by the owner's ruling — the `_graph` subtree follows it at every depth — and
    // the only way a traverse branch can honour that is by nesting through `mapGraphNodes`, which takes the flag.
    assert.match(row, /mapGraphNodes\(nodes, graphNodeRecord, shape\.includeDiagnostics, shape\.projection\)/,
      'a traverse response must nest through mapGraphNodes and pass the diagnostics flag down');
  });

  it('does not mutate the results it was given', () => {
    // The seeds are also handed to the traverse builder and to the audit outcome; deleting a field in place
    // would change what those saw.
    const input = structuredClone(FILE_HIT);
    toRecallRecord(input, { includeFileContent: false });
    assert.deepEqual(input, FILE_HIT, 'the strip must copy rather than delete in place');
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
      assert.match(doc, /includeFileContent/, `${name} guide does not mention includeFileContent`);
    }
  });
});
