/**
 * MCP CallTool argument enforcement.
 *
 * The dispatcher now validates incoming args against each tool's advertised inputSchema (via ajv) before
 * running the handler — so `additionalProperties`, `enum`, numeric bounds, `pattern`, and `propertyNames`
 * are the REAL contract, not just documentation. These tests exercise the same `makeArgsValidator` the
 * router uses (per-connection, space-scoped schemas), covering the accept path and the breaking rejections.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ALL_TOOLS } from '../../server/dist/mcp/tools/index.js';
import { makeArgsValidator } from '../../server/dist/mcp/validate-args.js';

const schemas = {
  requiredSpace: { type: 'string', enum: ['general'], description: 'Space ID.' },
  optionalSpace: { type: 'string', enum: ['general'], description: 'Optional space ID.' },
};
const v = makeArgsValidator(schemas);
const tool = (name) => ALL_TOOLS.find(t => t.name === name);
const UUID = '3b241101-e2bb-4255-8caf-4136c566a962';

describe('MCP args enforcement — accept path', () => {
  it('accepts a well-formed recall call', () => {
    assert.equal(v.validate(tool('recall'), { space: 'general', query: 'hello', topK: 5 }), null);
  });
  it('accepts a valid recall filter (allowed key + operator)', () => {
    assert.equal(v.validate(tool('recall'), { query: 'x', filter: { 'properties.status': { eq: 'accepted' } } }), null);
  });
  it('accepts find_similar with the space OMITTED (now optional)', () => {
    assert.equal(v.validate(tool('similar'), { entryId: UUID, entryType: 'entity' }), null);
  });
});

describe('MCP args enforcement — breaking rejections', () => {
  const rejects = (name, args, needle) => {
    const err = v.validate(tool(name), args);
    assert.ok(err, `${name}: expected rejection for ${JSON.stringify(args)}`);
    if (needle) assert.ok(err.toLowerCase().includes(needle), `${name}: "${err}" should mention ${needle}`);
  };

  /** The counterpart, for a rule that deliberately moved OUT of this layer. */
  const accepts = (name, args) => {
    const err = v.validate(tool(name), args);
    assert.equal(err, null, `${name}: expected the validator to ACCEPT ${JSON.stringify(args)}, got "${err}"`);
  };

  it('rejects an unknown property (additionalProperties:false)', () => {
    rejects('recall', { query: 'x', bogus: 1 }, 'bogus');
  });
  it('rejects a missing required property', () => {
    rejects('remember', { space: 'general' }, 'fact');
  });
  it('rejects an out-of-range number (find_similar.topK > 100)', () => {
    rejects('similar', { entryId: UUID, entryType: 'entity', topK: 500 });
  });
  it('rejects the wrong maxTimeMS ceiling (filter.maxTimeMS > 10000)', () => {
    rejects('filter', { space: 'general', collection: 'memories', filter: {}, maxTimeMS: 99999 });
  });
  it('rejects a bad enum value (wipe_space.types)', () => {
    rejects('wipe_space', { space: 'general', types: ['bogus'] });
  });
  it('rejects a bad collection enum (filter.collection)', () => {
    rejects('filter', { space: 'general', collection: 'widgets', filter: {} });
  });
  it('does NOT reject a recall filter at the validator — the resolver owns that, in either grammar', () => {
    /*
     * Two tests were here: `rejects('recall', {filter: {evil: {eq: 1}}})` for an out-of-allowlist key, and
     * `rejects('recall', {filter: {tags: {regex: 'x'}}})` for an operator outside the set. Both asserted the
     * VALIDATOR refused, via a `propertyNames` pattern and an operator-object `additionalProperties`.
     *
     * **Those constraints made the tool refuse the raw-MongoDB grammar its own description promised and REST
     * delivers**, because this validator runs BEFORE the handler. Measured on one instance, one instant:
     * `{type: 'message', 'properties.readBy': {$not: {$regex: 'ythril'}}}` → REST 200, MCP
     * `/filter/type: must be object; /filter/properties.readBy: unexpected property '$not'`.
     *
     * **The refusals themselves have not gone anywhere** — `resolveRecallFilter` enforces the key allowlist
     * recursively (including inside `$or`) and refuses a MIXED filter, and it is now the only copy of that
     * rule. `recall-filter-parity-both-doors.test.js` proves both doors accept and refuse the same nine
     * filters against a live instance, which is the layer where this can actually be observed.
     *
     * This test is not a note that something was deleted: it FAILS if a structural constraint comes back,
     * which is the only way to keep the two doors from diverging again.
     */
    accepts('recall', { query: 'x', filter: { $or: [{ type: 'message' }, { 'properties.status': 'open' }] } });
    accepts('recall', { query: 'x', filter: { 'properties.readBy': { $not: { $regex: 'ythril' } } } });
    accepts('recall', { query: 'x', filter: { type: 'message' } });
    // The legacy grammar still passes the validator too — widening accepted more, never less.
    accepts('recall', { query: 'x', filter: { 'properties.status': { eq: 'open' } } });
  });
  it('rejects a non-UUID entryId (pattern)', () => {
    rejects('similar', { entryId: 'not-a-uuid', entryType: 'entity' });
  });
  it('rejects a space the token cannot see (enum)', () => {
    rejects('get_stats', { space: 'secret' });
  });
  it('bulk_write is EXEMPT from schema enforcement (partial-success: per-item errors, not call rejection)', () => {
    // bulk_write's contract is to process valid items and report per-item errors in the result, so the
    // dispatcher skips arg-validation for it (tool.skipSchemaValidation). Its rich schema stays in
    // tools/list for discovery; the handler validates each item.
    assert.equal(tool('bulk_write').skipSchemaValidation, true);
  });
});
