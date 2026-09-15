/**
 * `schema_update` over MCP — the same rules as the REST route, because it is the same function.
 *
 * ## What this is checking, and what it deliberately is not
 *
 * The refusal chain itself is pinned by `space-meta-update-contract.test.js` against the REST route, and both
 * surfaces now call `planSpaceMetaUpdate`. Re-asserting all five statuses here would be testing the same function
 * twice through two doors.
 *
 * What only this file can check is that the tool actually goes through that door: that a `$ref` to a missing
 * library entry is REFUSED rather than stored as an empty schema, that merge semantics are the REST default, and
 * that admin gating holds. A tool calling `updateSpace()` directly would pass a "did it write?" test and fail every
 * one of these — which is exactly the *two surfaces, one rule, one weaker* defect this batch is about.
 *
 * Run: node --test testing/integration/mcp-update-space-schema.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, delWithBody } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const SPACE = `mcp-schema-${RUN}`;

let tokenA;
let session;

// The MCP client harness lives in ../sync/mcp-session.js. It was copy-pasted into ten files while the
// transport was SSE; 4.0 removed SSE and one shared `POST /mcp` caller replaced every copy.

const meta = () => get(INSTANCES.a, tokenA, `/api/spaces/${SPACE}/meta`);

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, tokenA, '/api/spaces', { id: SPACE, label: `MCP schema ${RUN}` });
  assert.equal(r.status, 201, `space create failed: ${JSON.stringify(r.body)}`);
  session = await openMcpSession(tokenA);
});

after(async () => {
  session?.close();
  await delWithBody(INSTANCES.a, tokenA, `/api/spaces/${SPACE}`, { confirm: true }).catch(() => {});
});

describe('update_space_schema is offered and writes', () => {
  it('appears in tools/list for an admin token', async () => {
    // The parity map's row for this capability was DELETED when the tool landed, so the tool existing is what makes
    // that deletion honest. `mcp-rest-parity.test.js` gates the other direction.
    const names = (await session.listTools()).map(t => t.name);
    assert.ok(names.includes('schema_update'), `not offered: ${names.join(', ')}`);
  });

  it('writes a type schema an agent designed', async () => {
    const r = await session.callTool('schema_update', {
      space: SPACE,
      typeSchemas: { entity: { widget: { propertySchemas: { region: { type: 'string' } } } } },
    });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
    const after = await meta();
    assert.equal(after.body.typeSchemas?.entity?.widget?.propertySchemas?.region?.type, 'string',
      'the schema must be readable back through the REST meta endpoint — one store, two surfaces');
  });

  it('MERGES by default, so editing one type does not drop the others', async () => {
    await session.callTool('schema_update', {
      space: SPACE, typeSchemas: { entity: { gadget: { namingPattern: '^G-' } } },
    });
    const after = await meta();
    assert.ok(after.body.typeSchemas?.entity?.widget, 'the type not mentioned must survive');
    assert.ok(after.body.typeSchemas?.entity?.gadget, 'and the new one must be there');
  });

  it('`replace` is how a type is DELETED — the only way to express it', async () => {
    const r = await session.callTool('schema_update', {
      space: SPACE, typeSchemasMode: 'replace',
      typeSchemas: { entity: { gadget: { namingPattern: '^G-' } } },
    });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
    const after = await meta();
    assert.equal(after.body.typeSchemas?.entity?.widget, undefined, 'replace makes the payload authoritative');
    assert.ok(after.body.typeSchemas?.entity?.gadget, 'and keeps what it names');
  });

  it('writes the other meta fields too, so a wedged space can be repaired in one call', async () => {
    const r = await session.callTool('schema_update', {
      space: SPACE, validationMode: 'warn', usageNotes: 'written over MCP',
    });
    assert.ok(!r?.isError, `refused: ${JSON.stringify(r)}`);
    const after = await meta();
    assert.equal(after.body.validationMode, 'warn');
    assert.equal(after.body.usageNotes, 'written over MCP');
  });
});

describe('update_space_schema is held to the ROUTE rules, not looser ones', () => {
  it('REFUSES a $ref to a library entry that does not exist', async () => {
    // The whole reason the chain was extracted before the tool. A tool calling `updateSpace()` directly would store
    // this as an empty schema and report success — in a strict space that silently removes every constraint from
    // the type while the schema looks authored.
    const before = await meta();
    const r = await session.callTool('schema_update', {
      space: SPACE, typeSchemas: { entity: { broken: { $ref: `library:absent-${RUN}` } } },
    });
    assert.ok(r?.isError, `a broken $ref was accepted: ${JSON.stringify(r)}`);
    const text = r?.content?.[0]?.text ?? '';
    assert.match(text, /422/, 'the refusal must carry the status, so an agent can branch on it');
    assert.match(text, new RegExp(`absent-${RUN}`), 'and name the missing entry');
    const after = await meta();
    assert.equal(after.body.version, before.body.version, 'a refused write must not bump the meta version');
  });

  it('REFUSES an unknown field rather than silently dropping it', async () => {
    // `additionalProperties: false` on the tool schema is the first gate; the planner's `.strict()` meta body is the
    // second. Either is enough — what must not happen is a 200 that ignored the field.
    const r = await session.callTool('schema_update', { space: SPACE, validationMdoe: 'strict' });
    assert.ok(r?.isError, `a misspelled field was accepted: ${JSON.stringify(r)}`);
  });

  it('refuses a call that names no field at all', async () => {
    const r = await session.callTool('schema_update', { space: SPACE });
    assert.ok(r?.isError, `an empty update was accepted: ${JSON.stringify(r)}`);
  });
});
