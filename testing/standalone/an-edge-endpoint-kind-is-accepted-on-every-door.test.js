/**
 * An edge can be written through three doors, and all three accept the endpoint kinds — or the field is a
 * capability only one kind of client has.
 *
 * ## Why three, and why that is the whole risk
 *
 * `POST /edges` and `PATCH /edges/:id`, the `save_edge` and `update_edge` MCP tools, and the bulk importer
 * (which is itself two doors sharing one implementation) all reach `upsertEdge`. Each of them re-derives what
 * a valid endpoint looks like: REST called `assertRefsResolve(..., 'entity', ...)`, the MCP tool tested
 * `UUID_V4_RE` itself with its own message, and bulk had a third copy of the same pattern. Every one of those
 * was correct while both endpoints were always entities.
 *
 * So the field is not "added to the document". Left alone, each door would have refused a file endpoint in a
 * different way: REST with *"expects entity IDs (UUID v4)"*, MCP with *"must be a valid UUID v4 (entity ID),
 * not a name"*, and bulk with a per-item error — while the document, the sync schema and the docs all said it
 * was supported.
 *
 * ## What it asserts, and what it deliberately does not
 *
 * The MCP half **exercises the compiled schema**, because `additionalProperties: false` is enforced by the
 * dispatcher before a handler runs: a tool that does not DECLARE `toKind` refuses the call outright, and no
 * amount of handler code helps. That is exactly how `traverse`'s three link flags came to be refused by MCP
 * and answered 200 by REST.
 *
 * The REST half reads source, because a route has no published schema to exercise — but it asserts the
 * MECHANISM per door (the value is read from the body AND reaches the writer), not merely that the identifier
 * appears somewhere in the file.
 *
 * Run: node --test testing/standalone/an-edge-endpoint-kind-is-accepted-on-every-door.test.js
 * (requires a prior `npm run build` in server/ so server/dist exists)
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const { REF_KINDS } = await import('../../server/dist/config/types-knowledge.js');
const { edgeEndpointKindSchema, edgeEndpointKind, isWellFormedRef } = await import('../../server/dist/brain/entity-refs.js');
const { save_edgeTool, update_edgeTool } = await import('../../server/dist/mcp/tools/edge.js');
const { save_bulkTool } = await import('../../server/dist/mcp/tools/bulk.js');

const STUB = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } };
const src = (p) => stripComments(readFileSync(p, 'utf8'));

const FIELDS = ['fromKind', 'toKind'];

describe('the MCP door declares the kinds', () => {
  it('the tools are the ones this gate thinks they are', () => {
    // Floors everything below: a renamed export would import as undefined and every loop would pass over
    // nothing at all.
    for (const tool of [save_edgeTool, update_edgeTool, save_bulkTool]) {
      assert.ok(tool?.inputSchema, 'an edge-writing tool is gone or renamed — re-anchor this gate');
    }
  });

  for (const [name, tool] of [['save_edge', save_edgeTool], ['update_edge', update_edgeTool]]) {
    for (const field of FIELDS) {
      it(`${name} accepts \`${field}\``, () => {
        const props = tool.inputSchema(STUB).properties ?? {};
        assert.ok(field in props,
          `${name} does not declare ${field}, and its schema sets additionalProperties:false — so the `
          + 'dispatcher refuses the call before the handler runs, while REST accepts the same field');
      });
    }
  }

  for (const field of FIELDS) {
    it(`bulk_write's edge item accepts \`${field}\``, () => {
      /*
       * The item schema is `additionalProperties: false` too, which is easy to miss because it is nested two
       * levels down inside an array. A field added to the single-write tool and not here is a capability that
       * works one edge at a time and is refused in a batch.
       */
      const item = save_bulkTool.inputSchema(STUB).properties?.edges?.items?.properties ?? {};
      assert.ok(field in item,
        `bulk_write's edge item omits ${field}, so a batch import cannot write what upsert_edge can`);
    });
  }

  it('every tool offers the SAME set of kinds, from one definition', () => {
    /*
     * Three schemas, one builder. Written out three times, a fifth kind would reach some tools and not others
     * — a valid enum refusing a kind the database stores, differently per tool.
     */
    const expected = edgeEndpointKindSchema('to');
    const item = save_bulkTool.inputSchema(STUB).properties?.edges?.items?.properties ?? {};
    for (const props of [save_edgeTool.inputSchema(STUB).properties, update_edgeTool.inputSchema(STUB).properties, item]) {
      assert.deepEqual(props.toKind, expected, 'a tool spells its own kind schema out instead of sharing one');
    }
    assert.deepEqual([...expected.enum].sort(), [...REF_KINDS].sort(),
      'the published enum and the accepted set have drifted — one of them is a lie to whoever reads it');
  });
});

describe('the REST door reads them and passes them on', () => {
  const route = src('server/src/api/brain/edges.ts');

  it('the create route destructures both from the body', () => {
    const line = route.split('\n').find(l => l.includes('} = req.body') && l.includes('from,'));
    assert.ok(line, 'the create route no longer destructures `from` — re-anchor this gate');
    for (const f of FIELDS) assert.ok(line.includes(f), `the create route never reads ${f} from the body`);
  });

  it('the create route refuses a kind that is not one of the four', () => {
    // Not "it validates something": the refusal has to name the allowed set, and it has to come from
    // REF_KINDS rather than a literal list in the route, or the route is the copy that goes stale.
    assert.match(route, /REF_KINDS\.join/,
      'the route does not build its refusal from REF_KINDS, so its allowed set is a second list');
    assert.match(route, /must be one of/, 'the route has no refusal message for a bad kind');
  });

  it('the patch route accepts a correction', () => {
    /*
     * A patch is the ONLY way to fix a wrong or missing kind. An edge's identity is its (from, to, label)
     * triplet so the endpoint cannot be moved, and delete-and-recreate does not work on a sync network: a
     * tombstone only removes its issuer's own content, so a peer-authored edge survives its own deletion.
     */
    const line = route.split('\n').find(l => l.includes('} = req.body') && l.includes('deleteFields'));
    assert.ok(line, 'the patch route no longer destructures deleteFields — re-anchor this gate');
    for (const f of FIELDS) assert.ok(line.includes(f), `the patch route cannot correct ${f}`);
  });

  it('and both endpoints are resolved against the kind, not against entity', () => {
    // The half that makes the field mean anything. `assertRefsResolve(..., 'entity', ...)` on a file endpoint
    // refuses a legitimate path with a message about UUIDs, which is how a supported field ships unusable.
    assert.doesNotMatch(route, /assertRefsResolve\([^)]*'entity'/,
      'a REST endpoint is still resolved as an entity regardless of the kind it declares');
    assert.match(route, /assertRefsResolve\([^)]*edgeEndpointKind\(/,
      'the REST route does not resolve its endpoints against the declared kind');
  });
});

describe('the bulk importer reads them and passes them on', () => {
  const bulk = src('server/src/brain/bulk.ts');

  it('it reads both from the item', () => {
    for (const f of FIELDS) {
      assert.ok(bulk.includes(`item['${f}']`), `the bulk importer never reads ${f} from an edge item`);
    }
  });

  it('its shape check honours the kind', () => {
    /*
     * Bulk keeps its own shape check on purpose — its contract is per-item, so it must report WHICH index
     * failed rather than letting the writer throw. Keeping the check while hardcoding UUID is what makes it
     * the weaker of two implementations of one rule.
     */
    /*
     * Bounded by the edge block's OWN start and the end of the loop it opens, not by "wherever chrono
     * happens to be". It read up to `const chrono = slice(` — and when edges moved to run LAST, so that a
     * batch reference could name a chrono entry, that slice inverted and came back empty. A window bounded
     * by a NEIGHBOUR is a window that fails on the neighbour moving.
     */
    const from = bulk.indexOf('const edges = slice(');
    assert.ok(from > 0, 'the bulk edge block is gone — re-anchor this gate');
    const next = bulk.indexOf('\n  // ──', from);
    const edgeBlock = bulk.slice(from, next > from ? next : undefined);
    assert.ok(edgeBlock.length > 200, `the bulk edge block is ${edgeBlock.length} chars — re-anchor this gate`);
    assert.doesNotMatch(edgeBlock, /UUID_V4_RE\.test\((from|to)\)/,
      'bulk still tests an edge endpoint against the UUID pattern regardless of its kind, so a file-ended '
      + 'edge is refused item by item while the same edge writes fine one at a time');
    assert.match(edgeBlock, /isWellFormedRef\(fromKind, from\)/, 'bulk does not check `from` against its kind');
    assert.match(edgeBlock, /isWellFormedRef\(toKind, to\)/, 'bulk does not check `to` against its kind');
  });
});

describe('the sync ingest door checks each endpoint against its own kind', () => {
  it('the link-violation check reads the declared kind rather than assuming entity', () => {
    /*
     * The fourth door, and the one a mutation run caught this gate missing: reverting
     * `checkEdgeLinkViolations` to a hardcoded entity left every other assertion here passing. It is the
     * quietest of the four, because it does not refuse anything — it RECORDS. A file-ended edge would arrive,
     * store correctly, and generate two link violations per edge for an operator to read as real damage.
     */
    const body = bodyOf(src('server/src/api/sync/_shared.ts'), 'checkEdgeLinkViolations');
    assert.ok(body.length > 200, 'checkEdgeLinkViolations is gone or renamed — re-anchor this gate');
    assert.match(body, /edgeEndpointKind\(/,
      'sync decides the kind of an endpoint for itself instead of reading what the edge declares');
    assert.match(body, /collectionForRefKind\(/,
      'sync names the collection to search directly, so the collection is decided in two places');
    assert.doesNotMatch(body, /_entities/,
      'sync still looks an edge endpoint up in the entities collection regardless of its kind');
  });
});

describe('the reading of an absent kind is in one place', () => {
  it('absent means entity', () => {
    assert.equal(edgeEndpointKind(undefined), 'entity');
    assert.equal(edgeEndpointKind('file'), 'file');
  });

  it('and a file endpoint is a path while every other kind is a UUID', () => {
    /*
     * The asymmetry that makes a single hardcoded check wrong. Exercised rather than read, because "the code
     * branches on kind" is a decision being MADE, not a decision being CORRECT.
     */
    const uuid = '3f2504e0-4f89-41d3-9a0c-0305e82c3301';
    assert.ok(isWellFormedRef('entity', uuid));
    assert.ok(!isWellFormedRef('entity', 'photos/party.jpg'));
    assert.ok(isWellFormedRef('file', 'photos/party.jpg'));
    assert.ok(!isWellFormedRef('file', '/photos/party.jpg'), 'a leading slash would never match a stored _id');
    assert.ok(!isWellFormedRef('file', '../secrets/keys.txt'), 'a traversal segment must not be storable');
    assert.ok(!isWellFormedRef('file', 'photos\\party.jpg'), 'a backslash would never match a stored _id');
  });

  it('no door reads the absent case for itself', () => {
    /*
     * `kind ?? 'entity'` written at a call site is the coalesce nobody notices is missing at the fourth one.
     *
     * **DERIVED, because "no door" is the claim.** It named four files — the four doors that existed when it
     * was written — so a fifth was outside everything the gate read while its title went on covering all of
     * them (`Q-6`, 2026-09-07). `brain/edges.ts` is excluded because the four-argument form there is the
     * function's own definition.
     */
    const files = trackedSources('server/src')
      .filter(f => f.endsWith('.ts') && f !== 'server/src/brain/edges.ts');
    assert.ok(files.length > 100, `only ${files.length} server sources found; the listing is broken`);

    const offenders = files.filter(f => /(fromKind|toKind)\s*\?\?\s*'entity'/.test(src(f)));
    assert.deepEqual(offenders, [],
      `${offenders.join(', ')} reads the absent case itself instead of calling edgeEndpointKind. One door `
      + 'that coalesces differently is an edge stored with an endpoint kind the others would have refused.');
  });
});
