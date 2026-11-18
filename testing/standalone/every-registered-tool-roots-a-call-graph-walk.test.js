/**
 * Every registered MCP tool roots a walk of the call-graph index (bundle-284, slice 6b).
 *
 * ## Why
 *
 * The gates that ask what a door can cause (`a-read-never-writes-a-space` and the others built on `_call-graph.mjs`) root a tool at its handler
 * object, found by the object's `name:` literal (`toolHandlerRoot`). Each asks only the tools its own rule covers, so a tool whose object the index
 * cannot read is simply never asked about: `space_schema_convert` was one, because a template nested inside its description stopped the index
 * reading the object, and no gate noticed, since none of them roots an admin-rung tool. This asks every tool in the registry, so the next one is
 * found the day it lands rather than the day a gate needs it.
 *
 * Run: node --test testing/standalone/every-registered-tool-roots-a-call-graph-walk.test.js (after `npm run build:server`)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { moduleIndex, toolHandlerRoot } from './_call-graph.mjs';
import { SERVER_CODE_ROOTS } from './_sources.mjs';
import { ALL_TOOLS } from '../../server/dist/mcp/tools/index.js';

/** Set a little under the registry's size when this was written, so a registry import that broke cannot pass on an empty list. */
const TOOL_FLOOR = 60;

describe('every registered MCP tool roots a call-graph walk', () => {
  it('each tool name resolves to exactly one handler object the index can read', () => {
    assert.ok(ALL_TOOLS.length >= TOOL_FLOOR, `only ${ALL_TOOLS.length} tool(s) in the registry, below ${TOOL_FLOOR}: the import broke`);
    const index = moduleIndex(SERVER_CODE_ROOTS);
    const unrooted = [];
    for (const { name } of ALL_TOOLS) {
      try { toolHandlerRoot(index, name); } catch (err) { unrooted.push(`${name}: ${String(err?.message ?? err).split('\n')[0]}`); }
    }
    assert.deepEqual(unrooted, [], `tool(s) no call-graph gate can root, so every question a gate asks about them answers "no":\n  ${unrooted.join('\n  ')}`);
  });
});
