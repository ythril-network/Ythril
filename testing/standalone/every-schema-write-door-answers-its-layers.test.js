/**
 * Every door that writes a space's schema is asked, by the multi-network write test, what it answers per network (`R5-1` (a),
 * `R6-8`, Q-67).
 *
 * ## Why this is a gate and not a list
 *
 * The per-network `layers` answer is promised on every schema-write door. The stack test that checks it
 * (`testing/integration/a-multi-network-schema-write-answers-per-network-on-every-door.test.js`) drives one case per door, and
 * a door table written by hand is the list this repo keeps finding a door missing from. So the doors are derived here: every
 * mounted route and every MCP tool whose handler reaches `applySpaceMetaUpdate` (the one function that turns a schema edit
 * into a round per network). Each must have a case in that file titled with its label (`PATCH /api/spaces/:id`,
 * `MCP schema_update`). A new schema-write door with no case is red here, on every push, without the stack.
 *
 * ## Seen red
 *
 * The checker is one function over a derived door set and a test source, so the same function judges the real file and a
 * copy with one case removed; the self-check below drops each door's case in turn and requires that door to be named.
 *
 * Run: node --test testing/standalone/every-schema-write-door-answers-its-layers.test.js   (reads server/src; no build needed)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { indexSources, toolHandlerRoot, routeHandlerRoots, walkFrom } from './_call-graph.mjs';
import { mountedRoutes } from './_routes.mjs';
import { trackedSources, REPO_ROOT } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const TARGET = 'server/src/spaces/meta-update.ts:applySpaceMetaUpdate';
const STACK_TEST = 'testing/integration/a-multi-network-schema-write-answers-per-network-on-every-door.test.js';

/** The doors (route and tool labels) whose handler reaches the schema-write function, derived from the call graph. */
function schemaWriteDoors() {
  const files = trackedSources('server/src', { untracked: true });
  const index = indexSources(new Map(files.map(f => [f, readFileSync(join(REPO_ROOT, f), 'utf8')])));
  assert.ok(index.bodies.has(TARGET), `${TARGET} is not in the index — the schema-write function moved; re-anchor this gate`);
  const toolObjects = [...index.objects.values()].filter(o => o.strings.get('name') && index.bodies.has(`${o.file}:${o.name}.handle`));
  const dispatchedTools = entry => [...entry.body.matchAll(/\bcallTool\s*\(\s*\{\s*name:\s*['"]([a-z_]+)['"]/g)]
    .map(m => { try { return toolHandlerRoot(index, m[1]); } catch { return null; } }).filter(Boolean);
  const doors = [
    ...mountedRoutes().map(r => ({ label: `${r.method} ${r.path}`, roots: routeHandlerRoots(index, r) })),
    ...toolObjects.map(t => ({ label: `MCP ${t.strings.get('name')}`, roots: [`${t.file}:${t.name}.handle`] })),
  ];
  return doors.filter(d => walkFrom(index, d.roots, { closures: true, edges: dispatchedTools }).seen.has(TARGET)).map(d => d.label);
}

/** The case titles a test source declares with `it('…'`, comments stripped so a commented-out case does not count. */
function caseTitles(src) {
  const titles = new Set();
  for (const m of stripComments(src).matchAll(/\bit\(\s*(['"`])((?:\\.|(?!\1).)*)\1/g)) titles.add(m[2].replace(/\\(.)/g, '$1'));
  return titles;
}

/** The derived doors the test source has no case for. */
function doorsWithoutACase(doors, src) {
  const titles = caseTitles(src);
  return doors.filter(d => !titles.has(d));
}

const DOORS = schemaWriteDoors();
const SOURCE = readFileSync(join(REPO_ROOT, STACK_TEST), 'utf8');

describe('every schema-write door is asked what it answers per network', () => {
  it('the doors are found on both surfaces', () => {
    assert.ok(DOORS.some(d => !d.startsWith('MCP ')), `no REST door reaches ${TARGET}: ${DOORS.join(', ')}`);
    assert.ok(DOORS.some(d => d.startsWith('MCP ')), `no MCP tool reaches ${TARGET}: ${DOORS.join(', ')}`);
  });

  it('the multi-network write test has a case for each of them', () => {
    const missing = doorsWithoutACase(DOORS, SOURCE);
    assert.deepEqual(missing, [], `${STACK_TEST} has no case titled with: ${missing.join(', ')}`);
  });

  it('the checker names a door whose case is removed (seen red per door)', () => {
    for (const door of DOORS) {
      const quoted = door.replace(/'/g, "\\'");
      const without = SOURCE.split(`it('${quoted}'`).join(`it('removed'`);
      assert.notEqual(without, SOURCE, `the case for ${door} was not found to remove`);
      assert.deepEqual(doorsWithoutACase(DOORS, without), [door], `removing the case for ${door} was not reported`);
    }
  });

  it('a commented-out case does not count', () => {
    const door = DOORS[0];
    const commented = SOURCE.split(`it('${door}'`).join(`// it('${door}'\n  it('removed'`);
    assert.deepEqual(doorsWithoutACase(DOORS, commented), [door]);
  });
});
