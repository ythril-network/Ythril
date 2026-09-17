/**
 * MCP tool-schema completeness (F1 self-describing surface).
 *
 * An agent must be able to discover every possible input, value, bound, and operator for a tool from
 * `tools/list` alone. These tests pin the machine-readable invariants that make that true across ALL_TOOLS,
 * plus the highest-value per-tool enrichments (filter.filter operators, recall filter key allowlist, the
 * corrected filter.maxTimeMS ceiling, similar's omit-space harmonisation) and the pure scope resolver.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS } from '../../server/dist/mcp/tools/index.js';
import { resolveFindSimilarScope } from '../../server/dist/mcp/tools/search.js';

// Stub ToolSchemas (the space fragments the router builds per-connection).
const schemas = {
  requiredSpace: { type: 'string', description: 'Space ID to operate on.' },
  optionalSpace: { type: 'string', description: 'Optional space ID. Omit to search across all accessible spaces.' },
};
const schemaOf = (name) => ALL_TOOLS.find(t => t.name === name).inputSchema(schemas);

/**
 * The depth bound on a `traverse` property, wherever the schema keeps it.
 *
 * It was a plain `{type: 'number', minimum, maximum}` until `traverse` grew its object form; the bound now lives
 * on each `oneOf` branch — the number itself, and the object's `depth`. Reading it through one helper is what
 * lets the assertions below keep asking the question they were always asking (*is the range advertised, so a
 * caller sees it without reading prose*) rather than being weakened to fit the new shape.
 *
 * Returns every place a bound is declared, so a branch that quietly lost one fails rather than being averaged
 * away by a sibling that kept it.
 */
function traverseBounds(prop) {
  const branches = prop.oneOf ?? [prop];
  return branches.map(b => (b.type === 'object' ? b.properties?.depth : b))
    .map(b => ({ minimum: b?.minimum, maximum: b?.maximum }));
}

describe('MCP tool schemas — universal invariants', () => {
  it('exposes exactly 46 tools', () => {
    // 45 -> 46: `space_reembed`. It is not a NEW capability — `POST /api/spaces/:id/reembed` has always
    // backfilled records with no vector. It had no tool, and nobody could see that because the capability
    // map paired the route with `space_reindex`, which does the opposite thing. Prerequisites done: a
    // `TOOL_RIGHTS` row matching the route's rung, an audit-map entry under the route's own operation,
    // and the map pairing corrected.
    //
    // 48 -> 45: `er_model`, `find_entities_by_name` and `list_chrono` FOLDED into others at 5.0.
    // Prerequisites done for each: their audit-map entries and rights rows are gone, their docs rows are
    // gone, and each has a `_DEPRECATIONS.md` row naming what replaces it. `er_model`'s answer lives on as
    // `actualSchema` on `space_meta`, on BOTH doors; the other two are `filter` with a collection.
    //
    // A deliberate tripwire, not a fact worth asserting for its own sake: the number changing means a tool
    // was added or removed, and every tool needs an audit mapping, a read-only classification and a docs
    // row. Bump it when you have done those three, never to make the suite quiet.
    // 36 -> 37: `schema_update`. Its three prerequisites are done — `audit-map.ts` maps it to
    // `space.update`, it is `mutating: true` + `admin: true` and listed among the tools a readOnly token cannot
    // see, and `16-mcp.md` carries its row.
    // 37 -> 38: `save_space`. Prerequisites done — `audit-map.ts` maps it to `space.create`, it is
    // `mutating: true` + `admin: true` and listed among the tools a readOnly token cannot see, and `16-mcp.md`
    // carries its row.
    // 38 -> 39: `reindex`, the LAST row of the capability map. Prerequisites done — audit mapping, readOnly
    // classification, docs row.
    // 39 -> 41: `list_embed_jobs` + `retry_embed_record`, the brain-record half of the embed queue. These are the
    // first pair to arrive WITH their REST route rather than after it, which is the whole point — the capability map
    // was five rows long because five routes shipped alone. Prerequisites done for both: `retry_embed_record` maps
    // to `brain.retry_embedding` and is listed among the tools a readOnly token cannot see, `list_embed_jobs` is
    // read-only and deliberately visible to a readOnly token, and `16-mcp.md` carries a row for each.
    // 41 -> 42: `er_model`. Prerequisites done — `audit-map.ts` maps it to `brain.er_model` (and the REST
    // route is now audited too, which it was not while `stats` was), it is read-only and deliberately
    // visible to a readOnly token, and `16-mcp.md` carries its row.
    // 42 -> 43: `retry_embed_media`, the bulk counterpart to `retry_embed_file`. Prerequisites done —
    // `audit-map.ts` maps it to `file.retry_embedding_all` like the route it mirrors, it is `mutating: true` and listed among
    // the tools a readOnly token cannot see, and `16-mcp.md` carries its row.
    // 43 -> 44: `update_file_meta`. Prerequisites done — `audit-map.ts` maps it to `file.meta.update` like
    // the route it mirrors, it is `mutating: true` and listed among the tools a readOnly token cannot see,
    // and `16-mcp.md` carries its row.
    // 44 -> 46: `save_link` + `delete_link`, the link write door. Prerequisites done for both:
    // `audit-map.ts` maps them to `link.create` / `link.delete`, both are `mutating: true` and listed among
    // the tools a readOnly token cannot see, and `16-mcp.md` carries a row for each. They ship WITH their
    // REST routes rather than after them, which is the rule the capability map exists to enforce.
    // 46 -> 47: `delete_entity_preview` (`F-17`). Prerequisites done — `audit-map.ts` maps it to
    // `entity.cascade_preview`, it is READ-ONLY and deliberately visible to a readOnly token (it deletes
    // nothing and answers the same question the 409 already answers), and `16-mcp.md` carries its row in
    // the tool table, the read-only list and the REST mapping.
    // 47 -> 48: `graph_link_preflight` (`F-25`). Prerequisites done -- `audit-map.ts` maps it to
    // `link.convert_preflight`, it is READ-ONLY and visible to a readOnly token (it writes nothing and
    // answers a question about writes that already happened), and `16-mcp.md` carries its row. It ships
    // WITH its REST route rather than after it.
    assert.equal(ALL_TOOLS.length, 46);
  });

  it('every tool advertises a closed object schema (type:object, additionalProperties:false)', () => {
    for (const t of ALL_TOOLS) {
      const s = t.inputSchema(schemas);
      assert.equal(s.type, 'object', `${t.name}: type must be object`);
      assert.equal(s.additionalProperties, false, `${t.name}: must set additionalProperties:false so the option set is discoverable as complete`);
      assert.equal(typeof s.properties, 'object', `${t.name}: properties must be an object`);
      assert.ok(Array.isArray(s.required), `${t.name}: required must be an array`);
    }
  });
});

describe('MCP tool schemas — high-value enrichments', () => {
  it('filter.filter documents the MongoDB operator allowlist + regex/depth rules', () => {
    const filter = schemaOf('filter').properties.filter;
    for (const op of ['$eq', '$in', '$regex', '$options', '$elemMatch', '$mod']) {
      assert.ok(filter.description.includes(op), `filter.filter description must list ${op}`);
    }
    assert.ok(/depth 8/.test(filter.description), 'filter.filter must document the depth-8 cap');
  });

  it('filter.maxTimeMS advertises the REAL 10000 ceiling (not the old prose 30000)', () => {
    const m = schemaOf('filter').properties.maxTimeMS;
    assert.equal(m.maximum, 10000);
    assert.equal(m.default, 5000);
  });

  it('filter.limit carries a real floor and a real default, and NO maximum', async () => {
    /*
     * The `maximum: 100` this used to require was removed deliberately at 5.0, with the default raised
     * to 200 — owner, 2026-09-17: *"cap should be a parameter and default to 200"*.
     *
     * The dispatcher enforces this schema BEFORE the handler runs, so a `maximum` here REFUSES a page the
     * REST door serves: a 400 on one door and an answer on the other, which is the parity defect
     * `CLAUDE.md` names as worse than either alone. And a silent clamp was the worse half of that — a
     * caller asking for 200 got 100, with `truncated` making it read as a correct short page, while the
     * per-collection list routes `filter` replaces serve 200 or 500.
     *
     * The floor stays: zero and negatives have no honest answer, so both doors refuse them.
     */
    const l = schemaOf('filter').properties.limit;
    assert.equal(l.minimum, 1);
    assert.equal(l.maximum, undefined,
      'a `maximum` here refuses a page the REST door serves — the bound is the byte budget, not a row count');
    // Read from the resolver rather than restated, so the two cannot default differently.
    const { DEFAULT_QUERY_LIMIT } = await import('../../server/dist/brain/query.js');
    assert.equal(l.default, DEFAULT_QUERY_LIMIT);
  });

  it('recall.filter carries NO structural constraint, and traverse/minScore still carry bounds', () => {
    /*
     * THIS ASSERTION IS INVERTED FROM WHAT IT WAS, deliberately. It used to require
     * `filter.propertyNames.pattern` and check the key allowlist through it.
     *
     * That pattern refused `$or`/`$and`/`$not` as keys and required every value to be an operator object, so
     * the MCP tool rejected the raw-MongoDB grammar that its own description promised and REST delivers.
     * **The dispatcher validates arguments before the handler runs**, so it was a hard refusal the resolver
     * never got to answer. Measured: `{type: 'message', 'properties.readBy': {$not: {$regex: 'ythril'}}}` →
     * REST 200, MCP `/filter/type: must be object; /filter/properties.readBy: unexpected property '$not'`.
     *
     * The key allowlist is NOT gone — `resolveRecallFilter` enforces it recursively, in either grammar, and is
     * now the only copy. `query`'s filter has always been declared this way for the same reason.
     *
     * So this now guards the fix rather than the defect: reinstating a structural constraint here would
     * re-break parity, and this fails if anyone does. The behavioural half — which filters are accepted and
     * which refused, on BOTH doors — is `recall-filter-parity-both-doors.test.js`.
     */
    const recall = schemaOf('recall');
    const filter = recall.properties.filter;
    assert.equal(filter.type, 'object', 'filter is still an object');
    assert.equal(filter.propertyNames, undefined,
      'a propertyNames pattern refuses $or/$and/$not as keys — that is what broke parity');
    assert.equal(filter.additionalProperties, undefined,
      'an additionalProperties operator-object shape refuses raw Mongo values, including a bare string');
    assert.match(filter.description, /RAW MONGODB is accepted/,
      'and the description must keep saying so, since it is what a caller reads while building arguments');

    // BOTH forms carry the bound — the bare depth and the object's `depth`. Asserting every branch rather
    // than the property is stricter than the check it replaced: a `oneOf` where one arm forgot its range would
    // advertise an unbounded depth on exactly the form a caller reaches for when they want control.
    const recallBounds = traverseBounds(recall.properties.traverse);
    assert.ok(recallBounds.length >= 2, 'traverse should offer both a depth and an object form');
    for (const b of recallBounds) {
      assert.equal(b.minimum, 0, 'a traverse branch lost its lower bound');
      assert.equal(b.maximum, 5, 'a traverse branch lost its upper bound');
    }
    assert.equal(recall.properties.minScore.minimum, 0);
    assert.equal(recall.properties.minScore.maximum, 1);
  });

  it('bulk_write arrays advertise the 500-item cap', () => {
    const props = schemaOf('save_bulk').properties;
    for (const k of ['facts', 'entities', 'edges', 'chrono']) {
      assert.equal(props[k].maxItems, 500, `bulk_write.${k} must cap at 500`);
    }
  });

  it('find_similar is harmonised to omit-space, and crossSpace is kept rather than deprecated', () => {
    const fs = schemaOf('similar');
    assert.ok(!fs.required.includes('space'), 'space must be optional (omit → all accessible spaces)');
    assert.deepEqual(fs.required, ['entryId', 'entryType']);
    assert.ok(fs.properties.traverse, 'find_similar must expose traverse (parity with recall)');
    // Same shape as recall's, in the same release — the parity this test is named for extends to the form
    // the parameter takes, not only to its presence.
    for (const b of traverseBounds(fs.properties.traverse)) {
      assert.equal(b.maximum, 5, 'a find_similar traverse branch lost its upper bound');
    }
    assert.equal(traverseBounds(fs.properties.traverse).length,
      traverseBounds(schemaOf('recall').properties.traverse).length,
      'find_similar and recall must offer the SAME traverse forms — a narrowing valid on one search and '
      + 'refused on the other is the asymmetry this tool already carries a comment about');
    assert.equal(ALL_TOOLS.find(t => t.name === 'similar').spaceRequired, false);

    // THIS ASSERTION WAS REVERSED IN 3.0, and the reason is worth more than the line it replaces.
    //
    // `crossSpace` was slated for removal as row 1.2 of the deprecation checklist — omitting `space` says
    // the same thing, so the tool took two spellings for one idea. Removing it from the tool turned
    // `mcp-rest-parity`'s "find-similar ↔ find_similar" case RED: the REST route takes the space in its
    // PATH, so "omit the space" is not expressible there and `crossSpace: true` is its only route to the
    // same capability. Dropping it on one door alone is the parameter-level divergence that gate exists
    // to catch.
    //
    // So the flag is KEPT on both doors, and the schema description must stop promising a removal that
    // cannot happen — a caller reading "DEPRECATED" builds around an absence that will never arrive, and
    // an `inputSchema` description is what they read while constructing arguments.
    const desc = fs.properties.crossSpace.description;
    assert.ok(!/DEPRECATED/i.test(desc),
      'crossSpace is kept for REST parity — calling it deprecated tells a caller to avoid a supported flag');
    assert.match(desc, /OMIT `space`/i, 'the description must still name the idiomatic MCP form');
    assert.match(desc, /PATH/, 'and say WHY the flag exists, or the next reader files it as a duplicate again');
  });

  it('id fields carry a UUID-v4 pattern', () => {
    const pat = schemaOf('similar').properties.entryId.pattern;
    const re = new RegExp(pat);
    assert.ok(re.test('3b241101-e2bb-4255-8caf-4136c566a962'), 'valid uuid v4 accepted');
    assert.ok(!re.test('not-a-uuid'), 'non-uuid rejected by the pattern');
  });
});

describe('resolveFindSimilarScope (find_similar space resolution)', () => {
  const members = (space) => (space === 'proxy' ? ['m1', 'm2'] : [space]);
  const accessible = ['a', 'b', 'c'];

  it('with a space (no crossSpace): base is the resolved member, search stays in that space', () => {
    const r = resolveFindSimilarScope(['a'], false, accessible, members);
    assert.deepEqual(r.candidateBases, ['a']);
    assert.equal(r.searchIds, undefined);
  });

  it('with a proxy space: base is the first member', () => {
    const r = resolveFindSimilarScope(['proxy'], false, accessible, members);
    assert.deepEqual(r.candidateBases, ['m1']);
  });

  it('omitting the space searches all accessible spaces and probes each for the source', () => {
    const r = resolveFindSimilarScope(undefined, false, accessible, members);
    assert.deepEqual(r.candidateBases, accessible);
    assert.deepEqual(r.searchIds, accessible);
  });

  it('SEVERAL spaces: the source is probed in each, and the search spans exactly those', () => {
    /*
     * The list case, 5.0. It is NOT the same as omitting the space — that searches everything reachable,
     * this searches the three the caller named and nothing else. The difference matters most in the
     * answer's SIZE: a byte budget spent on spaces nobody asked about is the cost this exists to remove.
     */
    const r = resolveFindSimilarScope(['a', 'c'], false, accessible, members);
    assert.deepEqual(r.searchIds, ['a', 'c'], 'exactly the named spaces, not every accessible one');
    assert.deepEqual(r.candidateBases, ['a', 'c'],
      'the source may be in any of them, so each is a candidate base — first one holding the entry wins');
  });

  it('a proxy inside a list expands to its members', () => {
    // A proxy holds no records of its own, so a list naming one and not expanding it searches an empty
    // collection and answers "nothing found" for a space the caller explicitly named.
    const r = resolveFindSimilarScope(['a', 'proxy'], false, accessible, members);
    assert.deepEqual(r.searchIds, ['a', 'm1', 'm2']);
  });

  it('a one-element list means exactly what the single space meant', () => {
    const one = resolveFindSimilarScope(['a'], false, accessible, members);
    assert.equal(one.searchIds, undefined, 'still the narrow form — search only that space');
    assert.deepEqual(one.candidateBases, ['a']);
  });

  it('legacy crossSpace:true forces cross-space even when a space is given', () => {
    const r = resolveFindSimilarScope(['a'], true, accessible, members);
    assert.deepEqual(r.candidateBases, accessible);
    assert.deepEqual(r.searchIds, accessible);
  });
});
