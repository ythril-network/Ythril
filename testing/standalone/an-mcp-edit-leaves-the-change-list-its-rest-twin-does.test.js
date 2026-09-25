/**
 * An edit made through MCP leaves the same audit change list as the same edit through REST (`Q-50`).
 *
 * A REST route hands the audit middleware `req.auditSnapshots`, and the entry gets `changes`. `callTool` wrote the
 * MCP entry from the operation alone, so the identical edit left a thinner entry depending on the door — nine
 * tools, including every record edit. A tool now calls `ctx.recordChanges(before, after)` and the dispatcher turns
 * it into `changes` the way the middleware does.
 *
 * ## The set is DERIVED
 *
 * Every mounted route whose handler sets `req.auditSnapshots` and that the capability map pairs with a tool is a
 * subject; the tool's handler must call `recordChanges`. A pair added next year is checked without editing this
 * file, and a floor stops an empty derivation from passing.
 *
 * Run: node --test testing/standalone/an-mcp-edit-leaves-the-change-list-its-rest-twin-does.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { mountedRoutesWithSource } from './_routes.mjs';
import { CAPABILITIES } from './_capability-map.mjs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

/** `PATCH /api/x/:spaceId/y/:id` and `PATCH /api/x/:a/y/:b` are one route: parameter names do not matter. */
const shape = (methodAndPath) => methodAndPath.replace(/:[A-Za-z_]+/g, ':p');

const toolSources = trackedSources(['server/src/mcp/tools'], { floor: 10 })
  .map(f => stripComments(readFileSync(f, 'utf8')));

/** The handler text of one tool: from its `name:` to the next tool's, in whichever file declares it. */
function toolWindow(tool) {
  for (const src of toolSources) {
    const at = src.indexOf(`name: '${tool}'`);
    if (at < 0) continue;
    const next = src.indexOf("name: '", at + 1);
    return src.slice(at, next < 0 ? undefined : next);
  }
  return null;
}

const recording = mountedRoutesWithSource().filter(r => /req\.auditSnapshots\s*=/.test(r.source));
const pairs = recording.flatMap(r => CAPABILITIES
  .filter(([, , route]) => shape(route) === shape(`${r.method.toUpperCase()} ${r.path}`))
  .map(([, tool, route]) => ({ tool, route })));

describe('every tool whose REST twin records changes records them too', () => {
  it('the derivation found its subjects', () => {
    assert.ok(recording.length >= 10, `only ${recording.length} routes set auditSnapshots — the route reader has lost its subjects`);
    assert.ok(pairs.length >= 8, `only ${pairs.length} tool pairs — the capability map join has lost its subjects: ${JSON.stringify(pairs)}`);
  });

  for (const { tool, route } of pairs) {
    it(`${tool} (twin of ${route})`, () => {
      const win = toolWindow(tool);
      assert.ok(win, `no handler found for ${tool}`);
      assert.match(win, /recordChanges/, `${tool} writes an audit entry without the change list ${route} records`);
    });
  }
});
