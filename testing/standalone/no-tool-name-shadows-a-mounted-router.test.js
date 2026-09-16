/**
 * A tool name must never collide with a mounted `/api` path segment.
 *
 * ## What this is guarding
 *
 * The REST door onto the tools is ONE generic route — `POST /api/:tool` — mounted in front of every other
 * `/api` router so that `POST /api/save_fact` reaches the registry. A greedy `/:param` mount sees every
 * single-segment `/api` path, so it would also see `POST /api/spaces`, which creates a space.
 *
 * It does not, because the route calls `next('router')` for a segment that is not a tool name. That guard
 * is one line and it holds today. What it cannot survive is a tool NAMED after a mounted segment: a tool
 * called `spaces` would make `TOOLS_BY_NAME.has('spaces')` true, the guard would let it through, and space
 * creation would quietly start answering as a tool call. Nothing would error. The 200 would even look
 * plausible.
 *
 * ## Why a gate rather than a convention
 *
 * Tool names are snake_case and router segments are kebab or single words, so the two sets are disjoint by
 * habit — and a habit is exactly what a gate is for. `space_stats` is a tool and `spaces` is a router, one
 * character and one underscore apart.
 *
 * ## Derivation, not a list
 *
 * Both sides are read out of the running code: the names from the registry, the segments from the mount
 * graph every other route gate uses. A hand-written list of either would be a corrected list with a later
 * expiry date, and a floor on each catches the reading that silently returned nothing.
 */
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';

let toolNames;
let apiSegments;

before(async () => {
  const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
  toolNames = new Set(ALL_TOOLS.map(t => t.name));

  /*
   * The FIRST path segment under `/api`, for every mounted route except the generic tool route itself —
   * which declares `/:tool` and would otherwise contribute the literal `:tool`.
   */
  apiSegments = new Set();
  for (const r of mountedRoutes()) {
    const m = /^\/api\/([^/:]+)(?:\/|$)/.exec(r.path);
    if (m) apiSegments.add(m[1]);
  }
});

describe('no tool name shadows a mounted router', () => {
  test('both sets were actually read', () => {
    // A scan that returns nothing passes every loop written over it, and an empty intersection is the
    // result this gate is hoping for — so the empty READING and the clean result are indistinguishable
    // without a floor.
    assert.ok(toolNames.size > 30, `expected the tool registry, got ${toolNames.size} names`);
    assert.ok(apiSegments.size > 10, `expected the mounted /api surface, got ${apiSegments.size} segments`);
  });

  test('no tool name is also an /api path segment', () => {
    const clash = [...toolNames].filter(n => apiSegments.has(n));
    assert.deepEqual(clash, [],
      `these tool names shadow a mounted /api router, so POST /api/<name> would be served by the tool `
      + `door instead of the router: ${clash.join(', ')}. Rename the tool — the mount order cannot be `
      + 'fixed by reordering, because the tool door has to come first for every OTHER tool to work.');
  });
});
