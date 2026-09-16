/**
 * Every record type REST can delete, MCP can delete.
 *
 * ## The reported gap
 *
 * *"An agent can `delete_space_data` over MCP but cannot delete one edge."* REST has deleted all four record types
 * since it existed; MCP shipped `delete_fact` and nothing else. So the only edge-removal reachable from an
 * agent was **destroying the entire space** — the most destructive operation available standing in for the
 * least.
 *
 * That is the two-surfaces-one-rule shape four other defects already had, and it is why this is a gate rather
 * than three tools: the asymmetry was not introduced deliberately, it accumulated. A fifth record type, or a
 * second delete route, will accumulate the same way unless something compares the two lists.
 *
 * ## What this asserts, and why it reads REST first
 *
 * The REST routes are the reference. The check derives what MUST exist from the routers rather than from a
 * hardcoded list of four names — a list would have been written to match today's tools and would agree with
 * itself forever.
 *
 * The entity delete additionally has to carry the REST route's referential guard. Shipping the tool WITHOUT it
 * would close the reported gap while opening a worse one: an agent able to leave dangling references that a
 * REST client is refused. A weaker rule on the second surface is the defect, not the absence of the surface.
 *
 * Run: node --test testing/standalone/mcp-delete-parity.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { join } from 'node:path';

const ROOT = process.cwd();
const read = (p) => readFileSync(join(ROOT, p), 'utf8');

/** Record types REST deletes one-by-id, read from the routers themselves. */
function restSingleDeletes() {
  const found = new Set();
  for (const [file, collection] of [
    ['server/src/api/brain/entities.ts', 'entities'],
    ['server/src/api/brain/edges.ts', 'edges'],
    ['server/src/api/brain/chrono.ts', 'chrono'],
    ['server/src/api/brain/facts.ts', 'facts'],
  ]) {
    let src;
    try { src = read(file); } catch { continue; }
    // A single-record delete ends in `/:id`; the bulk wipe does not, and must not count.
    if (new RegExp(`\\.delete\\('/spaces/:spaceId/${collection}/:id'`).test(src)) found.add(collection);
  }
  return found;
}

const MCP_TOOL_FOR = {
  entities: 'delete_entity',
  edges: 'delete_edge',
  chrono: 'delete_chrono',
  facts: 'delete_fact',
};

describe('MCP can delete everything REST can delete', () => {
  const registry = read('server/src/mcp/tools/index.ts');
  const rest = restSingleDeletes();

  it('found the REST delete routes to compare against', () => {
    // Floors the enumeration: if the route pattern changes, every tool looks unnecessary and this file
    // passes while checking nothing.
    assert.ok(rest.size >= 4, `only found single-record DELETE routes for: ${[...rest].join(', ') || 'nothing'}`);
  });

  it('registers a delete tool for each of them', () => {
    const missing = [...rest]
      .map(c => MCP_TOOL_FOR[c])
      .filter(tool => !new RegExp(`^\\s*${tool}Tool,`, 'm').test(registry));
    assert.deepEqual(missing, [],
      'REST deletes these record types one at a time and MCP does not — leaving `delete_space_data` as the only way '
      + 'an agent can remove one of them');
  });

  it('every delete tool is marked mutating, so a read-only token cannot reach it', () => {
    for (const [file, tool] of [
      ['server/src/mcp/tools/entity.ts', 'delete_entity'],
      ['server/src/mcp/tools/edge.ts', 'delete_edge'],
      ['server/src/mcp/tools/chrono.ts', 'delete_chrono'],
      ['server/src/mcp/tools/fact.ts', 'delete_fact'],
    ]) {
      const src = read(file);
      const at = src.indexOf(`name: '${tool}'`);
      assert.ok(at > 0, `${tool} not found in ${file}`);
      // Sliced to the NEXT tool rather than a fixed 400 characters. `mutating` sits a few lines after `name`
      // in source order, but a `description` between them is prose and can be any length — X-2 grew several
      // past 400 and this reported `delete_entity` as unmarked while it was marked all along. A window sized
      // to today's prose is a gate that fails on an edit to a comment.
      const next = src.indexOf("name: '", at + 20);
      const block = next === -1 ? src.slice(at) : src.slice(at, next);
      assert.match(block, /mutating: true/, `${tool} must be marked mutating`);
    }
  });
});

describe('the MCP entity delete carries the REST route’s referential guard', () => {
  const mcp = read('server/src/mcp/tools/entity.ts');
  const restSrc = read('server/src/api/brain/entities.ts');
  const tool = mcp.slice(mcp.indexOf("name: 'delete_entity'"));

  it('both doors call the SAME guard', () => {
    /*
     * Stronger than what this used to assert, which was that each door called `isStrictLinkage` and
     * `findEntityBacklinks` itself. That is satisfiable by two copies of one rule, and it WAS two copies,
     * which drifted: REST answered `Cannot delete: entity has inbound references` with structured rows, and
     * the tool threw different prose with none. Identical calls are not one rule; one function is.
     */
    for (const [name, src] of [['REST', restSrc], ['the MCP tool', tool]]) {
      assert.match(src, /entityDeleteBlockers\(mid, id\)/,
        `${name} does not use the shared delete guard, so its refusal can drift from the other door's`);
    }
  });

  it('and neither re-implements what the guard decides', () => {
    // The three things that were written out twice: the linkage check, the face exemption, and the
    // wording. Any of them reappearing in a door means the guard was bypassed rather than extended.
    //
    // Comments stripped, because both doors now carry a comment SAYING what the old wording was — a check
    // that reads the raw file fires on the note explaining the fix, which is this repo's most repeated
    // gate defect.
    for (const [name, src] of [['REST', stripComments(restSrc)], ['the MCP tool', stripComments(tool)]]) {
      assert.doesNotMatch(src, /b\.type !== 'face'/,
        `${name} filters face rows itself, and that exemption belongs to the guard: it reports them WITHOUT `
        + 'blocking, so a UI can warn about unlabelling while the delete is refused for another reason');
      assert.doesNotMatch(src, /still referenced by|inbound references/,
        `${name} words the refusal itself again`);
    }
  });

  it('the guard is where the rule actually lives', () => {
    // The floor: if that module were gutted, both cases above would still pass while nothing was enforced.
    const guard = read('server/src/brain/entity-delete-guard.ts');
    assert.match(guard, /isStrictLinkage\(spaceId\)/, 'the guard does not consult the opt-out');
    // The third argument is the record KIND, added in 4.0 so a memory or chrono entry can be the target too.
    // Matched loosely on the two that matter: pinning the exact argument list is a check on a signature
    // rather than on the guard doing its job, and it went red on the change that widened it.
    assert.match(guard, /findEntityReferences\(spaceId, entityId/, 'the guard does not look for references');
    assert.match(guard, /b\.type !== 'face'/, 'the face exemption is nowhere');
  });

  it('checks BEFORE deleting, not after', () => {
    // Anchored on the shared guard now rather than on the reference scan the tool used to call itself. The
    // property is the same and it is the one that matters: a check after the delete is not a check.
    const guard = tool.indexOf('entityDeleteBlockers(');
    const del = tool.indexOf('await deleteEntity(');
    assert.ok(guard > 0 && del > guard, 'the delete guard must run before the delete');
  });
});
