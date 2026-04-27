/**
 * Integration tests: Granular type schema CRUD
 *
 * Covers:
 *  - GET /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName
 *  - PUT /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName (upsert)
 *  - DELETE /api/spaces/:id/meta/typeSchemas/:knowledgeType/:typeName
 *  - Merge semantics: other types untouched on PUT
 *  - 404 for unknown space, unknown knowledge type, unknown type name
 *  - 400 for invalid payload (Zod rejection)
 *  - 400 for invalid knowledgeType
 *  - Max 200 types per knowledge type enforced
 *
 * Run: node --test testing/integration/type-schema-crud.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, put, delWithBody } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const TEST_SPACE = `type-schema-crud-${RUN}`;

let tokenA;
function token() { return tokenA; }

/** Helper: DELETE a single type definition */
async function delType(kt, typeName) {
  return fetch(`${INSTANCES.a}/api/spaces/${TEST_SPACE}/meta/typeSchemas/${kt}/${typeName}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
  }).then(async r => ({ status: r.status, body: await r.json().catch(() => null) }));
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  const r = await post(INSTANCES.a, token(), '/api/spaces', { id: TEST_SPACE, label: `Type Schema CRUD ${RUN}` });
  assert.equal(r.status, 201, `Failed to create test space: ${JSON.stringify(r.body)}`);
});

after(async () => {
  await fetch(`${INSTANCES.a}/api/spaces/${TEST_SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function setMeta(meta) {
  const r = await patch(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}`, { meta });
  assert.ok([200, 202].includes(r.status), `setMeta: expected 200/202, got ${r.status}: ${JSON.stringify(r.body)}`);
}

async function resetMeta() {
  // Use PUT /schema for full typeSchemas replacement (PATCH now merges, so
  // typeSchemas:{} via PATCH is a no-op and would not clear existing types).
  const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/schema`, { typeSchemas: {} });
  assert.ok([200, 202].includes(r.status), `resetMeta: PUT /schema failed: ${r.status}: ${JSON.stringify(r.body)}`);
  // Reset scalar meta fields separately (PUT /schema preserves them).
  await setMeta({ validationMode: 'off' });
}

// ═════════════════════════════════════════════════════════════════════════════
//  GET single type definition
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/spaces/:id/meta/typeSchemas/:kt/:typeName', () => {
  before(async () => {
    await setMeta({
      typeSchemas: {
        entity: {
          service: {
            namingPattern: '^[a-z][a-z0-9-]{1,60}$',
            tagSuggestions: ['backend', 'frontend'],
            propertySchemas: {
              status: { type: 'string', enum: ['active', 'deprecated'], required: true },
            },
          },
          team: {},
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('returns the specific type definition', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/service`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.knowledgeType, 'entity');
    assert.equal(r.body.typeName, 'service');
    assert.ok(typeof r.body.schema === 'object', 'response should have schema');
    assert.equal(r.body.schema.namingPattern, '^[a-z][a-z0-9-]{1,60}$');
    assert.deepEqual(r.body.schema.tagSuggestions, ['backend', 'frontend']);
    assert.ok(r.body.schema.propertySchemas?.status, 'should have status property schema');
    assert.equal(r.body.schema.propertySchemas.status.type, 'string');
    assert.equal(r.body.schema.propertySchemas.status.required, true);
  });

  it('returns an empty schema for a type with no configuration', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/team`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.typeName, 'team');
    assert.deepEqual(r.body.schema, {});
  });

  it('returns 404 for an unknown type name', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/nonexistent`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('returns 404 for an unknown space', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/no-such-space/meta/typeSchemas/entity/service`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('returns 400 for an invalid knowledgeType', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/widget/service`);
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PUT single type definition (upsert)
// ═════════════════════════════════════════════════════════════════════════════
describe('PUT /api/spaces/:id/meta/typeSchemas/:kt/:typeName — upsert', () => {
  before(async () => {
    await setMeta({
      validationMode: 'strict',
      typeSchemas: {
        entity: {
          existing_type: {
            propertySchemas: { team: { type: 'string', required: true } },
          },
        },
        edge: {
          owns: {},
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('adds a new entity type without touching existing types', async () => {
    const schema = {
      namingPattern: '^[a-z][a-z0-9-]{1,60}$',
      tagSuggestions: ['backend'],
      propertySchemas: {
        status: { type: 'string', enum: ['active', 'deprecated'], required: true },
      },
    };
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/service`, schema);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.knowledgeType, 'entity');
    assert.equal(r.body.typeName, 'service');
    assert.ok(r.body.schema, 'response should have schema');

    // Verify the existing type is untouched
    const getExisting = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/existing_type`);
    assert.equal(getExisting.status, 200, 'existing type should still be accessible');
    assert.ok(getExisting.body.schema.propertySchemas?.team, 'existing type properties should be intact');

    // Verify the edge type is untouched
    const edgeMeta = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/edge/owns`);
    assert.equal(edgeMeta.status, 200, 'edge type should still be accessible');
  });

  it('updates an existing type definition (merge/replace)', async () => {
    const updated = {
      namingPattern: '^[A-Z]',
      propertySchemas: {
        status: { type: 'string', required: false },
        priority: { type: 'number', minimum: 1, maximum: 5 },
      },
    };
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/service`, updated);
    assert.equal(r.status, 200, JSON.stringify(r.body));

    // Verify the updated definition is returned
    const getR = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/service`);
    assert.equal(getR.status, 200);
    assert.equal(getR.body.schema.namingPattern, '^[A-Z]');
    assert.ok(getR.body.schema.propertySchemas?.priority, 'priority property should be present');
  });

  it('adds a new edge type', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/edge/depends_on`, {
      propertySchemas: { confidence: { type: 'number', minimum: 0, maximum: 1 } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.typeName, 'depends_on');
  });

  it('adds a memory type', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/memory/note`, {
      propertySchemas: { source: { type: 'string', required: true } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.typeName, 'note');
  });

  it('adds a chrono type', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/chrono/deadline`, {
      propertySchemas: { priority: { type: 'string', enum: ['low', 'medium', 'high'] } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.typeName, 'deadline');
  });

  it('accepts an empty schema body (bare type with no configuration)', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/bare_type`, {});
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.schema, {});
  });

  it('returns 400 for an invalid knowledgeType', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/widget/service`, {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for an invalid schema body (unrecognised field)', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/bad_type`, {
      unknownField: true,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for an invalid mergeFn / type combination', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/bad_merge`, {
      propertySchemas: {
        value: { type: 'string', mergeFn: 'avg' },  // avg is numeric-only
      },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 404 for an unknown space', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/no-such-space/meta/typeSchemas/entity/service`, {});
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('meta version increments after PUT', async () => {
    const before = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    const vBefore = before.body.version ?? 0;

    await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/version_test`, {});

    const after = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    const vAfter = after.body.version ?? 0;
    assert.ok(vAfter > vBefore, `Version should increment: before=${vBefore}, after=${vAfter}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  DELETE single type definition
// ═════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/spaces/:id/meta/typeSchemas/:kt/:typeName', () => {
  before(async () => {
    await setMeta({
      typeSchemas: {
        entity: {
          to_delete: { propertySchemas: { x: { type: 'string' } } },
          keep_me:   { propertySchemas: { y: { type: 'number' } } },
        },
        edge: {
          keep_edge: {},
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('removes only the specified type, leaving others intact', async () => {
    const r = await delType('entity', 'to_delete');
    assert.equal(r.status, 204, JSON.stringify(r.body));

    // Deleted type should now 404
    const gone = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/to_delete`);
    assert.equal(gone.status, 404);

    // Other entity type should still exist
    const kept = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/keep_me`);
    assert.equal(kept.status, 200);

    // Edge type should still exist
    const edge = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/edge/keep_edge`);
    assert.equal(edge.status, 200);
  });

  it('returns 404 when deleting a non-existent type', async () => {
    const r = await delType('entity', 'no_such_type');
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('returns 400 for an invalid knowledgeType', async () => {
    const r = await delType('invalid_kt', 'some_type');
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 404 for an unknown space', async () => {
    const r = await fetch(`${INSTANCES.a}/api/spaces/no-such-space/meta/typeSchemas/entity/service`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    }).then(async resp => ({ status: resp.status, body: await resp.json().catch(() => null) }));
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('meta version increments after DELETE', async () => {
    // First add a type to delete
    await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/version_del_test`, {});

    const before = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    const vBefore = before.body.version ?? 0;

    await delType('entity', 'version_del_test');

    const after = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    const vAfter = after.body.version ?? 0;
    assert.ok(vAfter > vBefore, `Version should increment after DELETE: before=${vBefore}, after=${vAfter}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Max 200 types per knowledge type limit
// ═════════════════════════════════════════════════════════════════════════════
describe('PUT — max 200 types per knowledge type', () => {
  before(async () => {
    // Pre-populate 200 entity types via full PATCH
    const entityTypes = {};
    for (let i = 0; i < 200; i++) {
      entityTypes[`type_${i}`] = {};
    }
    await setMeta({ typeSchemas: { entity: entityTypes } });
  });

  after(async () => { await resetMeta(); });

  it('rejects a 201st entity type with 400', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/type_overflow`, {});
    assert.equal(r.status, 400, `Expected 400 when exceeding 200 types, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body?.error?.toLowerCase().includes('200') || r.body?.error?.toLowerCase().includes('max') || r.body?.error?.toLowerCase().includes('limit'),
      `Error should mention limit: ${JSON.stringify(r.body)}`);
  });

  it('allows updating an existing type (no count increase)', async () => {
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/type_0`, {
      tagSuggestions: ['updated'],
    });
    assert.equal(r.status, 200, `Updating existing type at max should succeed, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Round-trip: export single type then import via PUT
// ═════════════════════════════════════════════════════════════════════════════
describe('Round-trip: GET then PUT (export/import snippet)', () => {
  const originalSchema = {
    namingPattern: '^svc-[a-z]+$',
    tagSuggestions: ['prod', 'staging'],
    propertySchemas: {
      owner: { type: 'string', required: true },
      replicas: { type: 'number', minimum: 1, maximum: 10 },
    },
  };

  before(async () => {
    await resetMeta(); // ensure clean slate regardless of prior suite teardown
    const r = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/roundtrip_svc`, originalSchema);
    assert.equal(r.status, 200, `before: failed to seed roundtrip_svc: ${JSON.stringify(r.body)}`);
  });

  after(async () => { await resetMeta(); });

  it('GET returns the same schema that was PUT', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/roundtrip_svc`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.schema.namingPattern, originalSchema.namingPattern);
    assert.deepEqual(r.body.schema.tagSuggestions, originalSchema.tagSuggestions);
    assert.deepEqual(r.body.schema.propertySchemas, originalSchema.propertySchemas);
  });

  it('re-importing via PUT produces identical GET result', async () => {
    // GET the snippet
    const exported = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/roundtrip_svc`);
    assert.equal(exported.status, 200);

    // PUT the snippet back (simulates importing into a space)
    const importR = await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/roundtrip_svc`, exported.body.schema);
    assert.equal(importR.status, 200, `Re-import failed: ${JSON.stringify(importR.body)}`);

    // GET again — should be unchanged
    const final = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta/typeSchemas/entity/roundtrip_svc`);
    assert.equal(final.status, 200);
    assert.deepEqual(final.body.schema, exported.body.schema, 'Schema should be identical after round-trip');
  });
});
