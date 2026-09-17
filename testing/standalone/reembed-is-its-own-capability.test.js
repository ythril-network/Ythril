/**
 * Re-embedding a space and BACKFILLING one are two capabilities, and both doors must have both.
 *
 * ## The defect this is written against
 *
 * `_capability-map.mjs` paired `POST /api/spaces/:id/reembed` with `space_reindex` and called it answered.
 * They are opposite acts:
 *
 * | | `space_reindex` | `space_reembed` |
 * |---|---|---|
 * | touches | EVERY record, with the configured model | only records with NO vector |
 * | for | recovery after changing embedder or model | the way back from `suppressEmbeddings` |
 * | returns | `status: 'started'`, fire-and-forget | counts, awaited — the counts are the answer |
 *
 * So the backfill was REST-only and nobody could see it: the map said a tool covered it, and the parity
 * gate reads the map. **The gap was inside the file `B-7` built to end exactly this**, and the map's own
 * docblock names that pairing as the judgement it could not derive — which is what makes a wrong judgement
 * there worse than no entry at all.
 *
 * ## What is asserted, and why not simply "the tool exists"
 *
 * A tool named `space_reembed` that forwarded to the reindex planner would satisfy that and re-introduce
 * the defect. So this asserts the two reach DIFFERENT modules, and that the tool reaches the same one its
 * REST twin does — which is the actual claim: one capability, one procedure, two doors.
 *
 * Run: node --test testing/standalone/reembed-is-its-own-capability.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { trackedSources } from './_sources.mjs';
import { enclosingBlockFrom } from './_structural-window.mjs';
import { CAPABILITIES } from './_capability-map.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

/**
 * Every MCP tool source, from the tree rather than from a list — a tool may live in any of them.
 *
 * Through `trackedSources`, not a local `git ls-files`: the FLOOR is the part a hand-rolled copy leaves
 * out, and a listing that quietly returned nothing would make the search below find no declaration and
 * report the tool as MISSING. A measurement that can come back empty fails in the direction that looks
 * like a real defect, which is the worst way for a gate to be wrong.
 */
const toolFiles = () => trackedSources('server/src/mcp/tools', { floor: 10, untracked: true });

let ALL_TOOLS;
let TOOL_RIGHTS;
let ROUTE_RIGHTS;

before(async () => {
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
  ({ TOOL_RIGHTS, ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js'));
});

describe('the backfill is a capability of its own', () => {
  it('a tool answers it', () => {
    const names = ALL_TOOLS.map(t => t.name);
    assert.ok(names.includes('space_reembed'),
      `no tool backfills missing embeddings. \`POST /api/spaces/:id/reembed\` is then REST-only, which is `
      + `the defect this file exists for. Tools: ${names.join(', ')}`);
  });

  it('and it is NOT the reindex tool wearing a second name', () => {
    /*
     * The failure mode a bare existence check invites. Both tools take a space and both touch embeddings,
     * so a forwarding implementation looks right from the outside and answers the wrong question — which
     * is precisely how the pairing came to be recorded as answered in the first place.
     */
    /*
     * The file is FOUND, not named. This read `spaces.ts` and broke the day the tool moved to `embed.ts` —
     * with a message saying the tool was not declared, which is the one thing that was not true. A gate
     * that names a path asserts where code lives; the claim here is about what the code DOES.
     */
    const found = toolFiles()
      .map(f => ({ f, text: src(f) }))
      .find(({ text }) => text.includes("name: 'space_reembed'"));
    assert.ok(found, 'no tool file declares space_reembed — the tool is gone, not merely moved');
    const { text } = found;
    const at = text.indexOf("name: 'space_reembed'");
    // The declaration's own braces, not a character count: a window of N characters spans different code
    // on CRLF than on LF, and it silently reads into the NEXT tool — which here is `space_reindex`, so a
    // char window would find `startReindex(` in the neighbour and fail a tool that is perfectly correct.
    const body = enclosingBlockFrom(text, at, 'the space_reembed declaration');
    assert.match(body, /reembedSpace\(/,
      'the backfill tool must call `reembedSpace`, the module its REST twin calls');
    assert.doesNotMatch(body, /startReindex\(|planReindex\(/,
      'the backfill tool reaches the REINDEX planner — that is the two capabilities collapsing back into '
      + 'one, which is the defect rather than the fix');
  });

  it('both doors are priced the same, and from the tables that govern them', () => {
    // Not a literal `admin` written here twice: the claim is that the two tables AGREE, which is what a
    // caller discovers the hard way when they do not.
    const tool = TOOL_RIGHTS.find(r => r.tool === 'space_reembed');
    const route = ROUTE_RIGHTS.find(r => r.route === '/api/spaces/:id/reembed' && r.method === 'POST');
    assert.ok(tool, 'space_reembed has no TOOL_RIGHTS row — it would be governed by its flags instead');
    assert.ok(route, 'the reembed route has no ROUTE_RIGHTS row — re-anchor this gate');
    assert.equal(tool.area, route.area, 'the two doors disagree about which AREA governs the backfill');
    assert.equal(tool.needs, route.needs, 'the two doors disagree about the RUNG the backfill needs');
  });

  it('the capability map no longer pairs the route with the reindex tool', () => {
    const forRoute = CAPABILITIES.filter(([, , r]) => r === 'POST /api/spaces/:id/reembed').map(([, t]) => t);
    assert.deepEqual(forRoute, ['space_reembed'],
      `the map still answers the backfill route with ${forRoute.join(', ') || 'nothing'}. A pairing is only `
      + 'true when both doors answer the same QUESTION — touching the same vectors is not enough.');
  });
});
