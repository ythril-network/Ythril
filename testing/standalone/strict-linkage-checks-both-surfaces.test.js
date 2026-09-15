/**
 * Strict linkage means the endpoint EXISTS, not that it is UUID-shaped — on every write surface.
 *
 * ## The defect, reported by the canary
 *
 * `save_edge` over MCP, in a space with `strictLinkage: true`, with `to:` a **chrono** uuid: it returned
 * 201 and an edge id. The edge stored fine and was then absent from `traverse` and from
 * `recall(traverse: 1)` alike — missing from `nodes` AND from `edges`, because both hydrate neighbours out
 * of the entity collection and a non-entity endpoint yields nothing.
 *
 * So the caller got **an id for a link that does not exist**, which is worse than an error. They could not
 * clean it up either — no `delete_edge` on the MCP surface — and parked the dead edge with `ttlDays: 1`.
 * It cost them a 33-day incident timeline that had to be reassembled by name regex instead of by traversal.
 *
 * ## Why it was invisible
 *
 * The REST route has always called `assertRefsResolve`, which asks the database whether the id names an
 * entity. The MCP tool checked `UUID_V4_RE` and stopped — and a chrono's `_id` is a perfectly good UUID v4.
 * Two surfaces onto one rule, one of them enforcing a weaker version of it, and each reads as complete on
 * its own. Same shape as `waitForEmbedding` reaching one route of four.
 *
 * This gate is written against BOTH surfaces for that reason. Pinning only the MCP tool would leave the
 * next surface free to reintroduce it.
 *
 * ## What 3.7 changed, and why the rule got STRONGER rather than weaker
 *
 * This gate used to read *"resolves to an entity"*, asserting the literal `'entity'` as the second argument on
 * both surfaces. That was right while both endpoints were always entities. From 3.7 an endpoint declares its
 * kind, and the literal is now exactly what must NOT be there: passing `'entity'` regardless refuses a
 * legitimate file endpoint with a message about UUIDs, and looks a chrono endpoint up in the wrong collection.
 *
 * So the requirement is now *the endpoint is looked up in the collection its own kind names*. That still fails
 * on the canary's original defect — a shape check with no existence check — and additionally fails on
 * hardcoding a kind. The old form is asserted ABSENT, because it is the failure now.
 *
 * The bulk importer is deliberately not on this list, and `assertRefsResolve`'s own docblock says why: a bulk
 * payload may reference a record created earlier in the same payload, so a database check would refuse valid
 * forward references. Bulk keeps the shape check alone, and
 * `an-edge-endpoint-kind-is-accepted-on-every-door` holds that ITS shape check honours the kind.
 *
 * Run: node --test testing/standalone/strict-linkage-checks-both-surfaces.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = process.cwd();

/** Comments stripped, so the gate cannot pass on the prose that documents it. */
const code = (p) => readFileSync(join(ROOT, p), 'utf8')
  .split(/\r?\n/).filter(l => !/^\s*\/\//.test(l)).join('\n')
  .replace(/\/\*[\s\S]*?\*\//g, '');

/** Every surface that writes an edge and therefore owes the same linkage guarantee. */
const EDGE_WRITE_SURFACES = {
  rest: 'server/src/api/brain/edges.ts',
  mcp: 'server/src/mcp/tools/edge.ts',
};

describe('strict linkage is enforced by existence on every edge write surface', () => {
  it('the detector distinguishes a shape check from an existence check', () => {
    // Mutation-check the matcher: the whole finding is that one surface had the first and not the second,
    // so a gate that cannot tell them apart would have passed on the bug.
    const shapeOnly = "if (!isWellFormedRef(toKind, to)) throw new Error('bad');";
    const existence = "await assertRefsResolve(wt.target, 'to', toKind, [to]);";
    assert.equal(/assertRefsResolve\([^)]*'to'/.test(shapeOnly), false);
    assert.ok(/assertRefsResolve\([^)]*'to'/.test(existence));
  });

  it('both surfaces check that `from` AND `to` EXIST', () => {
    const missing = [];
    for (const [surface, file] of Object.entries(EDGE_WRITE_SURFACES)) {
      const src = code(file);
      for (const side of ['from', 'to']) {
        const re = new RegExp(`assertRefsResolve\\([^)]*'${side}'`);
        if (!re.test(src)) missing.push(`${surface}.${side}`);
      }
    }
    assert.deepEqual(missing, [],
      'A UUID v4 that names a chrono passes a shape check and stores an edge that every graph query '
      + 'ignores — the caller gets an id for a link that does not exist. Shape is not existence: use '
      + 'assertRefsResolve on BOTH endpoints, as the REST route always has.');
  });

  it('and each endpoint is looked up in the collection its own KIND names', () => {
    // set-claim: the two ENDS of an edge. Closed by what an edge is, not by anything the source lists.
    /*
     * The half 3.7 added. A hardcoded `'entity'` is not a smaller version of the guarantee, it is a different
     * and wrong one: a file endpoint is a path, so it fails a UUID check and is absent from the entities
     * collection — every legitimate file-ended edge would be refused, on a field the document, the sync
     * schema and both guides all say is supported.
     */
    for (const [surface, file] of Object.entries(EDGE_WRITE_SURFACES)) {
      const src = code(file);
      assert.doesNotMatch(src, /assertRefsResolve\([^)]*'(from|to)'[^)]*'entity'/,
        `${surface} resolves an edge endpoint as an entity regardless of the kind the edge declares`);
      for (const side of ['from', 'to']) {
        const re = new RegExp(`assertRefsResolve\\([^)]*'${side}',\\s*(${side}Kind|edgeEndpointKind\\()`);
        assert.match(src, re,
          `${surface} does not pass the declared kind when resolving \`${side}\``);
      }
    }
  });

  it('a shape check alone is never the whole guard', () => {
    // The specific regression to prevent: someone removes the existence call and leaves the UUID test,
    // which still looks like validation at a glance.
    for (const [surface, file] of Object.entries(EDGE_WRITE_SURFACES)) {
      const src = code(file);
      if (!/UUID_V4_RE\.test\((from|to)\)/.test(src)) continue;
      assert.match(src, /assertRefsResolve/,
        `${surface} shape-checks an edge endpoint but never asks whether it exists`);
    }
  });
});
