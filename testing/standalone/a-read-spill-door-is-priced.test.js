/**
 * Both doors to a read spill are priced — and the REST one is priced as NOT area-scoped, which is the trap.
 *
 * ## Why this is not an ordinary `ROUTE_RIGHTS` row (Q-92, design point 3)
 *
 * A spill is found by its id alone: `GET /api/brain/spills/:id`, MCP `read_spill {id}`, no `space` parameter.
 * Which spaces it touches is a fact about a STORED DOCUMENT (its `memberSpaceIds`), and `ROUTE_RIGHTS` has no
 * scope shape for that. A `path`-scoped row would resolve `:id` to no space at all — `[]` — and an empty scope
 * passes every per-space check, so the row would look like governance and govern nothing.
 *
 * So the route gets a `NOT_AREA_SCOPED` row whose `why` says where the check really happens (the act checks
 * knowledge read against the spill's stored member spaces), and the tool gets its `TOOL_RIGHTS` row at the rung
 * that produced the spill. A row in `ROUTE_RIGHTS` for this path is the opposite of that decision.
 *
 * The route and the tool are looked up in what the server actually mounts and registers, so a row for a door
 * nobody serves cannot pass.
 *
 * Run: node --test testing/standalone/a-read-spill-door-is-priced.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';

const ROUTE = '/api/brain/spills/:id';
const TOOL = 'read_spill';

let ROUTE_RIGHTS, TOOL_RIGHTS, NOT_AREA_SCOPED, ALL_TOOLS;

before(async () => {
  ({ ROUTE_RIGHTS, TOOL_RIGHTS, NOT_AREA_SCOPED } = await import('../../server/dist/auth/space-rights.js'));
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

describe('the read-spill doors exist and are priced', () => {
  it(`GET ${ROUTE} is mounted`, () => {
    const served = mountedRoutes().filter(r => r.path === ROUTE).map(r => r.method);
    assert.deepEqual(served, ['GET'], `the spill download route is not served (found: ${served.join(', ') || 'none'})`);
  });

  it(`${TOOL} is a registered tool`, () => {
    assert.ok(ALL_TOOLS.some(t => t.name === TOOL), 'MCP and REST are one API: the route needs its tool, same commit');
  });

  it('the route is NOT_AREA_SCOPED, and its reason names the stored member spaces', () => {
    const row = NOT_AREA_SCOPED.find(r => r.route === ROUTE);
    assert.ok(row, `no NOT_AREA_SCOPED row for ${ROUTE}: every call would log an ungoverned-route warning`);
    assert.match(row.why, /member spaces?/i,
      'the reason must say where the check really is, or the next reader "fixes" it with a ROUTE_RIGHTS row');
  });

  it('and it is NOT in ROUTE_RIGHTS, where a path scope would resolve to no space and pass everything', () => {
    const rows = ROUTE_RIGHTS.filter(r => r.route === ROUTE);
    assert.deepEqual(rows, [], 'a ROUTE_RIGHTS row prices a scope this route does not have');
  });

  it('the tool is priced at knowledge read, the rung that produced the spill', () => {
    const row = TOOL_RIGHTS.find(r => r.tool === TOOL);
    assert.ok(row, `no TOOL_RIGHTS row for ${TOOL}: an unpriced tool is governed by its admin flag alone`);
    assert.deepEqual({ area: row.area, needs: row.needs }, { area: 'knowledge', needs: 'read' });
  });
});
