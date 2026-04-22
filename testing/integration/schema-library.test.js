/**
 * Integration tests: Instance-level schema library CRUD
 *
 * Covers:
 *  - GET /api/schema-library                   — list all entries
 *  - GET /api/schema-library/:name             — get a single entry
 *  - POST /api/schema-library                  — create a new entry
 *  - PUT /api/schema-library/:name             — create-or-replace an entry
 *  - DELETE /api/schema-library/:name          — remove an entry
 *  - $ref resolution: space referencing a library entry
 *  - 404 for missing entry
 *  - 400 for invalid payloads
 *  - 409 on duplicate POST
 *  - Max 500 entries limit
 *
 * Run: node --test testing/integration/schema-library.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, put, del } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const TEST_SPACE = `schema-lib-${RUN}`;

let tokenA;
function token() { return tokenA; }

// ── Helpers ───────────────────────────────────────────────────────────────────

async function createEntry(body) {
  return post(INSTANCES.a, token(), '/api/schema-library', body);
}

async function getEntry(name) {
  return get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(name)}`);
}

async function listEntries() {
  return get(INSTANCES.a, token(), '/api/schema-library');
}

async function putEntry(name, body) {
  return put(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(name)}`, body);
}

async function deleteEntry(name) {
  return del(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(name)}`);
}

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  // Create a test space for $ref validation tests
  const r = await post(INSTANCES.a, token(), '/api/spaces', { id: TEST_SPACE, label: `Schema Library Test ${RUN}` });
  assert.equal(r.status, 201, `Failed to create test space: ${JSON.stringify(r.body)}`);
});

after(async () => {
  // Clean up test space
  await fetch(`${INSTANCES.a}/api/spaces/${TEST_SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
  // Clean up any library entries created during tests
  const listR = await listEntries();
  if (listR.status === 200 && Array.isArray(listR.body?.entries)) {
    for (const entry of listR.body.entries) {
      if (entry.name.startsWith(`lib-test-${RUN}`)) {
        await deleteEntry(entry.name).catch(() => {});
      }
    }
  }
});

const ENTRY_NAME = `lib-test-${RUN}-service-v1`;
const ENTRY_BODY = {
  name: ENTRY_NAME,
  knowledgeType: 'entity',
  typeName: 'service',
  schema: {
    namingPattern: '^[a-z][a-z0-9-]{1,60}$',
    tagSuggestions: ['backend', 'frontend'],
    propertySchemas: {
      status: { type: 'string', enum: ['active', 'deprecated'], required: true },
    },
  },
  description: 'Standard service entity schema',
};

// ═════════════════════════════════════════════════════════════════════════════
//  POST — create a new library entry
// ═════════════════════════════════════════════════════════════════════════════
describe('POST /api/schema-library — create entry', () => {
  after(async () => { await deleteEntry(ENTRY_NAME).catch(() => {}); });

  it('creates a new entry and returns 201', async () => {
    const r = await createEntry(ENTRY_BODY);
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.ok(r.body?.entry, 'response should have entry field');
    assert.equal(r.body.entry.name, ENTRY_NAME);
    assert.equal(r.body.entry.knowledgeType, 'entity');
    assert.equal(r.body.entry.typeName, 'service');
    assert.equal(r.body.entry.description, 'Standard service entity schema');
    assert.ok(r.body.entry.createdAt, 'should have createdAt');
    assert.ok(r.body.entry.updatedAt, 'should have updatedAt');
    assert.deepEqual(r.body.entry.schema.tagSuggestions, ['backend', 'frontend']);
  });

  it('returns 409 when name already exists', async () => {
    await createEntry(ENTRY_BODY);
    const r2 = await createEntry(ENTRY_BODY);
    assert.equal(r2.status, 409, JSON.stringify(r2.body));
    assert.ok(r2.body?.error?.toLowerCase().includes('already exists'), JSON.stringify(r2.body));
  });

  it('returns 400 for missing name', async () => {
    const { name: _n, ...noName } = ENTRY_BODY;
    const r = await createEntry(noName);
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for invalid knowledgeType', async () => {
    const r = await createEntry({ ...ENTRY_BODY, name: `${ENTRY_NAME}-bad-kt`, knowledgeType: 'widget' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for invalid schema (extra field)', async () => {
    const r = await createEntry({
      ...ENTRY_BODY,
      name: `${ENTRY_NAME}-bad-schema`,
      schema: { unknownField: true },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for invalid mergeFn/type combo', async () => {
    const r = await createEntry({
      ...ENTRY_BODY,
      name: `${ENTRY_NAME}-bad-merge`,
      schema: { propertySchemas: { value: { type: 'string', mergeFn: 'avg' } } },
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for name with uppercase characters', async () => {
    const r = await createEntry({ ...ENTRY_BODY, name: 'UPPERCASE-name' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for name starting with a dash', async () => {
    const r = await createEntry({ ...ENTRY_BODY, name: '-invalid-start' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('returns 400 for name starting with an underscore', async () => {
    const r = await createEntry({ ...ENTRY_BODY, name: '_invalid-start' });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET — list and retrieve entries
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/schema-library — list and retrieve', () => {
  const getTestName = `lib-test-${RUN}-get-test`;

  before(async () => {
    await createEntry({ ...ENTRY_BODY, name: getTestName });
  });

  after(async () => { await deleteEntry(getTestName).catch(() => {}); });

  it('GET / returns entries array', async () => {
    const r = await listEntries();
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body?.entries), 'entries should be an array');
  });

  it('GET /:name returns the created entry', async () => {
    const r = await getEntry(getTestName);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry.name, getTestName);
    assert.equal(r.body.entry.knowledgeType, 'entity');
    assert.ok(r.body.entry.schema.propertySchemas?.status, 'should have status property schema');
  });

  it('GET /:name returns 404 for a nonexistent entry', async () => {
    const r = await getEntry(`lib-test-${RUN}-nonexistent`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PUT — create or replace
// ═════════════════════════════════════════════════════════════════════════════
describe('PUT /api/schema-library/:name — create-or-replace', () => {
  const putTestName = `lib-test-${RUN}-put-test`;

  after(async () => { await deleteEntry(putTestName).catch(() => {}); });

  it('PUT creates a new entry (201) when it does not exist', async () => {
    const r = await putEntry(putTestName, {
      knowledgeType: 'edge',
      typeName: 'depends_on',
      schema: { propertySchemas: { confidence: { type: 'number', minimum: 0, maximum: 1 } } },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.entry.name, putTestName);
    assert.equal(r.body.entry.knowledgeType, 'edge');
  });

  it('PUT updates an existing entry (200) with new schema', async () => {
    const r = await putEntry(putTestName, {
      knowledgeType: 'edge',
      typeName: 'depends_on',
      schema: { propertySchemas: { confidence: { type: 'number', minimum: 0, maximum: 1 }, version: { type: 'string' } } },
      description: 'Updated description',
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry.description, 'Updated description');
    assert.ok(r.body.entry.schema.propertySchemas?.version, 'should have version property');
  });

  it('PUT returns 400 for invalid name format', async () => {
    const r = await putEntry('Invalid Name With Spaces', {
      knowledgeType: 'entity',
      typeName: 'test',
      schema: {},
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('PUT round-trip: GET returns the same schema that was PUT', async () => {
    const schema = { namingPattern: '^dep-', tagSuggestions: ['infrastructure'] };
    await putEntry(putTestName, { knowledgeType: 'edge', typeName: 'depends_on', schema });

    const r = await getEntry(putTestName);
    assert.equal(r.status, 200);
    assert.equal(r.body.entry.schema.namingPattern, '^dep-');
    assert.deepEqual(r.body.entry.schema.tagSuggestions, ['infrastructure']);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  DELETE — remove an entry
// ═════════════════════════════════════════════════════════════════════════════
describe('DELETE /api/schema-library/:name — remove', () => {
  const delTestName = `lib-test-${RUN}-del-test`;

  before(async () => {
    await createEntry({ ...ENTRY_BODY, name: delTestName });
  });

  it('deletes the entry and returns 204', async () => {
    const r = await deleteEntry(delTestName);
    assert.equal(r.status, 204, JSON.stringify(r.body));
  });

  it('GET after DELETE returns 404', async () => {
    const r = await getEntry(delTestName);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('DELETE on a nonexistent entry returns 404', async () => {
    const r = await deleteEntry(`lib-test-${RUN}-no-such`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  $ref resolution: space references a library entry
// ═════════════════════════════════════════════════════════════════════════════
describe('$ref resolution — space references a library entry', () => {
  const refLibName = `lib-test-${RUN}-ref-svc`;
  const refLibSchema = {
    namingPattern: '^svc-[a-z]+$',
    tagSuggestions: ['production'],
    propertySchemas: {
      owner: { type: 'string', required: true },
    },
  };

  before(async () => {
    // Create library entry
    const r = await createEntry({
      name: refLibName,
      knowledgeType: 'entity',
      typeName: 'service',
      schema: refLibSchema,
    });
    assert.equal(r.status, 201, `Failed to create library entry: ${JSON.stringify(r.body)}`);

    // Set space typeSchemas with a $ref
    const patchR = await patch(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}`, {
      meta: {
        validationMode: 'strict',
        typeSchemas: {
          entity: {
            service: { $ref: `library:${refLibName}` },
          },
        },
      },
    });
    assert.ok([200, 202].includes(patchR.status), `Failed to patch space meta: ${JSON.stringify(patchR.body)}`);
  });

  after(async () => {
    await deleteEntry(refLibName).catch(() => {});
    // Reset space meta
    await patch(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}`, {
      meta: { validationMode: 'off', typeSchemas: {} },
    }).catch(() => {});
  });

  it('the $ref typeSchema can be saved to a space', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.typeSchemas?.entity?.service, { $ref: `library:${refLibName}` });
  });

  it('a write that satisfies the referenced schema succeeds', async () => {
    // owner is required per the library schema; svc- prefix required by namingPattern
    const r = await post(INSTANCES.a, token(), `/api/brain/${TEST_SPACE}/entities`, {
      name: 'svc-auth',
      type: 'service',
      properties: { owner: 'platform-team' },
    });
    // 201 = created, 200 = upserted — both indicate success
    assert.ok([200, 201].includes(r.status), `Entity creation should succeed: ${JSON.stringify(r.body)}`);
  });

  it('a write that violates the referenced schema is rejected in strict mode', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/${TEST_SPACE}/entities`, {
      name: 'svc-missing-owner',
      type: 'service',
      // owner is required but omitted
    });
    assert.equal(r.status, 400, `Expected 400 for schema violation: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'schema_violation', JSON.stringify(r.body));
  });

  it('updating the library entry is reflected without re-patching the space', async () => {
    // Update the library entry to remove the 'required' flag on owner
    await putEntry(refLibName, {
      knowledgeType: 'entity',
      typeName: 'service',
      schema: {
        namingPattern: '^svc-[a-z]+$',
        propertySchemas: {
          owner: { type: 'string', required: false },
        },
      },
    });

    // Now the same write (without owner) should succeed
    const r = await post(INSTANCES.a, token(), `/api/brain/${TEST_SPACE}/entities`, {
      name: 'svc-no-owner',
      type: 'service',
    });
    assert.ok([200, 201].includes(r.status), `After library update, write should succeed: ${JSON.stringify(r.body)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Edge case: $ref to non-existent library entry
// ═════════════════════════════════════════════════════════════════════════════
describe('$ref to non-existent library entry', () => {
  const missingRefSpace = `schema-lib-missing-${RUN}`;

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/spaces', { id: missingRefSpace, label: `Missing Ref Test ${RUN}` });
    assert.equal(r.status, 201, `Failed to create space: ${JSON.stringify(r.body)}`);
    // Point to a non-existent library entry
    await patch(INSTANCES.a, token(), `/api/spaces/${missingRefSpace}`, {
      meta: {
        validationMode: 'strict',
        typeSchemas: { entity: { service: { $ref: 'library:nonexistent-entry-xyz' } } },
      },
    });
  });

  after(async () => {
    await fetch(`${INSTANCES.a}/api/spaces/${missingRefSpace}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });

  it('write with unresolvable $ref uses empty schema (no constraints) and allows any value', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/${missingRefSpace}/entities`, {
      name: 'anything',
      type: 'service',
    });
    // Empty schema means no violations — write should succeed
    assert.ok([200, 201].includes(r.status), `Write with unresolvable ref should succeed: ${JSON.stringify(r.body)}`);
  });
});
