/**
 * Integration tests: Instance-level schema library CRUD
 *
 * Covers:
 *  - GET /api/schema-library                        — list all entries
 *  - GET /api/schema-library/:name                  — get a single entry
 *  - POST /api/schema-library                       — create a new entry
 *  - PUT /api/schema-library/:name                  — create-or-replace an entry
 *  - DELETE /api/schema-library/:name               — remove an entry
 *  - $ref resolution: space referencing a library entry
 *  - 404 for missing entry
 *  - 400 for invalid payloads
 *  - 409 on duplicate POST
 *  - Max 500 entries limit
 *  - GET /api/schema-library/:name/usages           — link counter
 *  - Safe delete: unlink $refs then remove entry
 *  - PATCH /api/schema-library/:name/publish        — publish/unpublish toggle
 *  - GET /api/schema-library/public                 — unauthenticated public listing
 *  - GET /api/schema-library/public/:name           — unauthenticated public entry fetch
 *  - GET/POST/DELETE /api/schema-library/catalogs   — foreign catalog CRUD
 *  - GET /api/schema-library/catalogs/:name/entries — catalog proxy endpoint
 *  - SSRF validation on catalog URL
 *  - schemaGroup field on library entries (optional, editable, clearable)
 *  - GET /api/schema-library/groups                 — list distinct group names
 *  - POST /api/schema-library/groups/:group/apply   — bulk apply group to a space
 *  - POST /api/schema-library/export-space          — export space schema as group
 *
 * Run: node --test testing/integration/schema-library.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, put, del, reqJson } from '../sync/helpers.js';
import { legacyRights } from '../_shared/legacy-token-rights.mjs';

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

  it('returns 201 for name with uppercase characters (relaxed naming rules)', async () => {
    await del(INSTANCES.a, token(), `/api/schema-library/UPPERCASE-name`).catch(() => {});
    const r = await createEntry({ ...ENTRY_BODY, name: 'UPPERCASE-name' });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    await del(INSTANCES.a, token(), `/api/schema-library/UPPERCASE-name`).catch(() => {});
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
    const schema = { namingPattern: '^dep-' };
    await putEntry(putTestName, { knowledgeType: 'edge', typeName: 'depends_on', schema });

    const r = await getEntry(putTestName);
    assert.equal(r.status, 200);
    assert.equal(r.body.entry.schema.namingPattern, '^dep-');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PATCH /:name — merge into an existing entry
//
//  The reported gap: PUT requires knowledgeType, typeName and the whole schema, and REPLACES the schema. So
//  adding one optional property meant resending the type name, the description and every pre-existing
//  property — the shape in which a property gets dropped by accident. The integrator had resorted to
//  asserting afterwards that nothing was lost and no enum had narrowed.
//
//  So the assertion that matters here is not "the patch applied" — it is WHAT SURVIVED it.
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/schema-library/:name — merge', () => {
  const patchName = `lib-test-${RUN}-patch`;
  const patchEntry = (name, body) => patch(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(name)}`, body);

  before(async () => {
    const r = await putEntry(patchName, {
      knowledgeType: 'entity',
      typeName: 'service',
      description: 'the original description',
      schema: {
        namingPattern: '^svc-',
        propertySchemas: {
          tier: { type: 'string', enum: ['gold', 'silver'] },
          owner: { type: 'string' },
        },
      },
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
  });
  after(async () => { await deleteEntry(patchName).catch(() => {}); });

  it('adds ONE property without resending the others — the whole point', async () => {
    const r = await patchEntry(patchName, {
      schema: { propertySchemas: { region: { type: 'string' } } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ps = r.body.entry.schema.propertySchemas;
    assert.ok(ps.region, 'the new property must be added');
    assert.ok(ps.tier, 'a property not mentioned must SURVIVE — this is the bug being fixed');
    assert.ok(ps.owner, 'and so must the other one');
    // Nothing else may be collateral damage either.
    assert.equal(r.body.entry.typeName, 'service', 'typeName must survive a schema-only patch');
    assert.equal(r.body.entry.description, 'the original description');
    assert.equal(r.body.entry.schema.namingPattern, '^svc-');
  });

  it('does not narrow an enum it was not asked to touch', async () => {
    // Their exact after-the-fact assertion, made unnecessary: they were checking that a round-tripped PUT
    // had not silently dropped enum members.
    const r = await getEntry(patchName);
    assert.deepEqual(r.body.entry.schema.propertySchemas.tier.enum, ['gold', 'silver']);
  });

  it('replaces a named property rather than deep-merging it', async () => {
    // A property schema is one definition, so naming it means replacing it. Merging INTO it would make
    // removing a constraint impossible without a second mechanism.
    const r = await patchEntry(patchName, {
      schema: { propertySchemas: { tier: { type: 'string' } } },
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry.schema.propertySchemas.tier.enum, undefined,
      'naming a property replaces its definition');
    assert.ok(r.body.entry.schema.propertySchemas.region, 'other properties still survive');
  });

  it('deleteFields removes one property and leaves the rest', async () => {
    const r = await patchEntry(patchName, { deleteFields: ['propertySchemas.region'] });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry.schema.propertySchemas.region, undefined);
    assert.ok(r.body.entry.schema.propertySchemas.owner, 'the others survive the removal');
  });

  it('refuses an unrecognised deleteFields path instead of ignoring it', async () => {
    // A silently dropped typo leaves the caller believing a property was removed while it is still
    // validating records.
    const r = await patchEntry(patchName, { deleteFields: ['propertySchemasss.owner'] });
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /unrecognised/i);
  });

  it('a patch naming nothing is a 400, not a 200 no-op', async () => {
    const r = await patchEntry(patchName, {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
    assert.match(r.body.error, /At least one field/);
  });

  it('PATCH does not create — a missing entry is 404 and says to use PUT', async () => {
    const r = await patchEntry(`lib-test-${RUN}-does-not-exist`, { typeName: 'x' });
    assert.equal(r.status, 404, JSON.stringify(r.body));
    assert.match(r.body.error, /PUT/, 'the 404 should say how to create one');
  });

  it('null clears a scalar, absent preserves it', async () => {
    const cleared = await patchEntry(patchName, { description: null });
    assert.equal(cleared.status, 200, JSON.stringify(cleared.body));
    assert.equal(cleared.body.entry.description, undefined, 'null must clear');
    const after = await patchEntry(patchName, { typeName: 'service' });
    assert.equal(after.body.entry.description, undefined, 'and absent must not resurrect it');
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

  it('the $ref typeSchema can be saved to a space (raw meta preserves the $ref for round-trip)', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.deepEqual(r.body.typeSchemas?.entity?.service, { $ref: `library:${refLibName}` });
  });

  it('GET /meta?resolve=1 expands the $ref to the library entry\'s effective schema (fixes empty entry-form props)', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta?resolve=1`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const resolved = r.body.typeSchemas?.entity?.service;
    assert.ok(resolved && !resolved.$ref, `expected the $ref resolved away, got ${JSON.stringify(resolved)}`);
    // The library schema defines `owner` — it must surface so the UI can pre-fill it on the add form.
    assert.ok(resolved.propertySchemas?.owner, `resolved type must carry the library propertySchemas (owner), got ${JSON.stringify(resolved.propertySchemas)}`);
  });

  it('a write that satisfies the referenced schema succeeds', async () => {
    // owner is required per the library schema; svc- prefix required by namingPattern
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: 'svc-auth',
      type: 'service',
      properties: { owner: 'platform-team' },
    });
    // 201 = created, 200 = upserted — both indicate success
    assert.ok([200, 201].includes(r.status), `Entity creation should succeed: ${JSON.stringify(r.body)}`);
  });

  it('a write that violates the referenced schema is rejected in strict mode', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
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
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: 'svc-noowner',
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
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${missingRefSpace}/entities`, {
      name: 'anything',
      type: 'service',
    });
    // Empty schema means no violations — write should succeed
    assert.ok([200, 201].includes(r.status), `Write with unresolvable ref should succeed: ${JSON.stringify(r.body)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET /:name/usages — link counter endpoint
// ═════════════════════════════════════════════════════════════════════════════
describe('GET /api/schema-library/:name/usages — link counter', () => {
  const usageLibName = `lib-test-${RUN}-usage-counter`;
  const usageLibSchema = {
    propertySchemas: { version: { type: 'string' } },
  };
  const usageSpaceA = `schema-lib-usagea-${RUN}`;
  const usageSpaceB = `schema-lib-usageb-${RUN}`;

  before(async () => {
    // Create library entry
    const libR = await createEntry({
      name: usageLibName,
      knowledgeType: 'entity',
      typeName: 'app',
      schema: usageLibSchema,
    });
    assert.equal(libR.status, 201, `Failed to create usage lib entry: ${JSON.stringify(libR.body)}`);

    // Create two spaces that both $ref this entry
    const spaceAR = await post(INSTANCES.a, token(), '/api/spaces', { id: usageSpaceA, label: `Usage Space A ${RUN}` });
    assert.equal(spaceAR.status, 201, `Failed to create space A: ${JSON.stringify(spaceAR.body)}`);
    const spaceBR = await post(INSTANCES.a, token(), '/api/spaces', { id: usageSpaceB, label: `Usage Space B ${RUN}` });
    assert.equal(spaceBR.status, 201, `Failed to create space B: ${JSON.stringify(spaceBR.body)}`);

    // Wire $ref in both spaces
    for (const spaceId of [usageSpaceA, usageSpaceB]) {
      const pR = await patch(INSTANCES.a, token(), `/api/spaces/${spaceId}`, {
        meta: { typeSchemas: { entity: { app: { $ref: `library:${usageLibName}` } } } },
      });
      assert.ok([200, 202].includes(pR.status), `Failed to patch space ${spaceId}: ${JSON.stringify(pR.body)}`);
    }
  });

  after(async () => {
    await deleteEntry(usageLibName).catch(() => {});
    for (const id of [usageSpaceA, usageSpaceB]) {
      await fetch(`${INSTANCES.a}/api/spaces/${id}`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ confirm: true }),
      }).catch(() => {});
    }
  });

  it('returns 200 with a usages array', async () => {
    const r = await get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(usageLibName)}/usages`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body?.usages), 'usages should be an array');
  });

  it('reports both spaces as usages', async () => {
    const r = await get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(usageLibName)}/usages`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const ids = r.body.usages.map(u => u.spaceId);
    assert.ok(ids.includes(usageSpaceA), `Expected ${usageSpaceA} in usages: ${JSON.stringify(ids)}`);
    assert.ok(ids.includes(usageSpaceB), `Expected ${usageSpaceB} in usages: ${JSON.stringify(ids)}`);
  });

  it('each usage has the expected fields', async () => {
    const r = await get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(usageLibName)}/usages`);
    for (const u of r.body.usages) {
      assert.ok(u.spaceId, 'usage should have spaceId');
      assert.ok(u.spaceLabel, 'usage should have spaceLabel');
      assert.ok(u.knowledgeType, 'usage should have knowledgeType');
      assert.ok(u.typeName, 'usage should have typeName');
      assert.equal(u.knowledgeType, 'entity');
      assert.equal(u.typeName, 'app');
    }
  });

  it('returns empty usages array for an entry with no $refs', async () => {
    // Create an unlinked entry
    const unlinkedName = `lib-test-${RUN}-unlinked`;
    await createEntry({ name: unlinkedName, knowledgeType: 'fact', typeName: 'note', schema: {} });
    const r = await get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(unlinkedName)}/usages`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usages.length, 0, `Expected 0 usages, got ${r.body.usages.length}`);
    await deleteEntry(unlinkedName).catch(() => {});
  });

  it('returns 200 with empty array for non-existent entry name (no $ref can point to it)', async () => {
    // The endpoint scans spaces — if no space refs a non-existent name, usages is empty (not 404)
    const r = await get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(`lib-test-${RUN}-ghost`)}/usages`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usages.length, 0);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Safe delete: unlink $refs then remove library entry
// ═════════════════════════════════════════════════════════════════════════════
describe('safe delete — unlink $refs then delete library entry', () => {
  const safeLibName  = `lib-test-${RUN}-safe-del`;
  const safeSpaceId  = `schema-lib-safedel-${RUN}`;
  const safeSchema   = {
    namingPattern: '^svc-',
    propertySchemas: { tier: { type: 'string' } },
  };

  before(async () => {
    // Create library entry
    const libR = await createEntry({
      name: safeLibName,
      knowledgeType: 'entity',
      typeName: 'service',
      schema: safeSchema,
    });
    assert.equal(libR.status, 201, `Failed to create safe-del lib entry: ${JSON.stringify(libR.body)}`);

    // Create a space and wire the $ref
    const spR = await post(INSTANCES.a, token(), '/api/spaces', { id: safeSpaceId, label: `Safe Del ${RUN}` });
    assert.equal(spR.status, 201, `Failed to create safe-del space: ${JSON.stringify(spR.body)}`);
    const pR = await patch(INSTANCES.a, token(), `/api/spaces/${safeSpaceId}`, {
      meta: { typeSchemas: { entity: { service: { $ref: `library:${safeLibName}` } } } },
    });
    assert.ok([200, 202].includes(pR.status), `Failed to wire $ref: ${JSON.stringify(pR.body)}`);
  });

  after(async () => {
    await deleteEntry(safeLibName).catch(() => {});
    await fetch(`${INSTANCES.a}/api/spaces/${safeSpaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });

  it('usages reports the linked space before unlink', async () => {
    const r = await get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(safeLibName)}/usages`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usages.length, 1, `Expected 1 usage: ${JSON.stringify(r.body.usages)}`);
    assert.equal(r.body.usages[0].spaceId, safeSpaceId);
  });

  it('PUT inline schema replaces $ref in the space', async () => {
    // Simulate the client unlink: PUT the inline schema directly (replacing $ref)
    const r = await put(
      INSTANCES.a, token(),
      `/api/spaces/${safeSpaceId}/meta/typeSchemas/entity/service`,
      { ...safeSchema },
    );
    assert.equal(r.status, 200, `PUT inline schema failed: ${JSON.stringify(r.body)}`);

    // Verify the space no longer has a $ref
    const metaR = await get(INSTANCES.a, token(), `/api/spaces/${safeSpaceId}/meta`);
    assert.equal(metaR.status, 200);
    const stored = metaR.body.typeSchemas?.entity?.service;
    assert.ok(!stored?.$ref, `$ref should be gone after inline PUT; got: ${JSON.stringify(stored)}`);
    assert.equal(stored?.namingPattern, '^svc-', 'inline namingPattern should be stored');
  });

  it('usages is empty after inline replacement', async () => {
    const r = await get(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(safeLibName)}/usages`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.usages.length, 0, `Expected 0 usages after unlink: ${JSON.stringify(r.body.usages)}`);
  });

  it('DELETE succeeds after all refs are replaced', async () => {
    const r = await deleteEntry(safeLibName);
    assert.equal(r.status, 204, JSON.stringify(r.body));
  });

  it('GET after delete returns 404', async () => {
    const r = await getEntry(safeLibName);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('the space type schema remains intact as inline after library entry is gone', async () => {
    const metaR = await get(INSTANCES.a, token(), `/api/spaces/${safeSpaceId}/meta`);
    assert.equal(metaR.status, 200);
    const stored = metaR.body.typeSchemas?.entity?.service;
    assert.ok(!stored?.$ref, 'No $ref should remain');
    assert.equal(stored?.namingPattern, '^svc-', 'namingPattern should still be present as inline schema');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  PATCH /:name/publish — publish / unpublish toggle
// ═════════════════════════════════════════════════════════════════════════════
describe('PATCH /api/schema-library/:name/publish — publish toggle', () => {
  const pubName = `lib-test-${RUN}-publish`;

  before(async () => {
    const r = await createEntry({
      name: pubName,
      knowledgeType: 'entity',
      typeName: 'widget',
      schema: { namingPattern: '^pub-' },
      description: 'A publicly shared schema',
    });
    assert.equal(r.status, 201, `Failed to create entry: ${JSON.stringify(r.body)}`);
  });

  after(async () => { await deleteEntry(pubName).catch(() => {}); });

  it('entry starts unpublished (published is falsy)', async () => {
    const r = await getEntry(pubName);
    assert.equal(r.status, 200);
    assert.ok(!r.body.entry?.published, 'published should be falsy on creation');
  });

  it('PATCH publish:true sets published flag', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(pubName)}/publish`, { published: true });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry?.published, true, 'entry.published should be true');
  });

  it('entry is visible on GET /public after publishing', async () => {
    const r = await reqJson(INSTANCES.a, '', '/api/schema-library/public', { headers: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body?.entries), 'entries should be an array');
    const found = r.body.entries.find(e => e.name === pubName);
    assert.ok(found, `${pubName} should appear in public listing`);
    // public listing exposes limited fields, not schema
    assert.ok(found.knowledgeType, 'should have knowledgeType');
    assert.ok(found.typeName, 'should have typeName');
    assert.ok(!('schema' in found), 'public listing should not expose schema');
  });

  it('GET /public/:name returns the full entry when published', async () => {
    const r = await reqJson(INSTANCES.a, '', `/api/schema-library/public/${encodeURIComponent(pubName)}`, { headers: {} });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry?.name, pubName);
    assert.ok(r.body.entry?.schema, 'full entry should include schema');
  });

  it('PATCH publish:false removes from public listing', async () => {
    const patchR = await patch(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(pubName)}/publish`, { published: false });
    assert.equal(patchR.status, 200, JSON.stringify(patchR.body));
    assert.equal(patchR.body.entry?.published, false);

    const listR = await reqJson(INSTANCES.a, '', '/api/schema-library/public', { headers: {} });
    assert.equal(listR.status, 200);
    const found = listR.body.entries.find(e => e.name === pubName);
    assert.ok(!found, `${pubName} should not appear in public listing after unpublish`);
  });

  it('GET /public/:name returns 404 when unpublished', async () => {
    const r = await reqJson(INSTANCES.a, '', `/api/schema-library/public/${encodeURIComponent(pubName)}`, { headers: {} });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('PATCH publish requires admin token — rejects non-admin', async () => {
    // Create a non-admin token
    const createR = await post(INSTANCES.a, token(), '/api/tokens', { name: `non-admin-pub-${RUN}`});
    assert.equal(createR.status, 201, JSON.stringify(createR.body));
    const nonAdminToken = createR.body.plaintext;
    const r = await patch(INSTANCES.a, nonAdminToken, `/api/schema-library/${encodeURIComponent(pubName)}/publish`, { published: true });
    assert.ok([401, 403].includes(r.status), `Expected 401/403 for non-admin, got ${r.status}`);
    // cleanup
    await del(INSTANCES.a, token(), `/api/tokens/${createR.body.token?.id}`).catch(() => {});
  });

  it('PATCH publish returns 404 for non-existent entry', async () => {
    const r = await patch(INSTANCES.a, token(), `/api/schema-library/${encodeURIComponent(`lib-test-${RUN}-ghost-pub`)}/publish`, { published: true });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('GET /public is accessible without authentication', async () => {
    const r = await reqJson(INSTANCES.a, '', '/api/schema-library/public', { headers: {} });
    assert.equal(r.status, 200, 'Public endpoint should not require auth');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Foreign catalogs — CRUD and proxy
// ═════════════════════════════════════════════════════════════════════════════
describe('Foreign catalogs — CRUD and proxy endpoints', () => {
  const catName = `test-catalog-${RUN}`;

  after(async () => {
    await del(INSTANCES.a, token(), `/api/schema-library/catalogs/${encodeURIComponent(catName)}`).catch(() => {});
  });

  it('GET /catalogs returns empty array initially (for this run)', async () => {
    const r = await get(INSTANCES.a, token(), '/api/schema-library/catalogs');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body?.catalogs), 'catalogs should be an array');
  });

  it('GET /catalogs requires authentication', async () => {
    const r = await get(INSTANCES.a, null, '/api/schema-library/catalogs');
    assert.ok([401, 403].includes(r.status), `Expected 401/403 without auth, got ${r.status}`);
  });

  it('POST /catalogs creates a catalog link', async () => {
    const r = await post(INSTANCES.a, token(), '/api/schema-library/catalogs', {
      name: catName,
      url: 'https://example.com/api/schema-library',
      description: 'Test catalog',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.catalog?.name, catName);
    assert.equal(r.body.catalog?.url, 'https://example.com/api/schema-library');
    assert.ok(r.body.catalog?.createdAt, 'catalog should have createdAt');
  });

  it('POST /catalogs returns 409 on duplicate name', async () => {
    const r = await post(INSTANCES.a, token(), '/api/schema-library/catalogs', {
      name: catName,
      url: 'https://example.com/api/schema-library',
    });
    assert.equal(r.status, 409, `Expected 409 for duplicate catalog name, got ${r.status}`);
  });

  it('GET /catalogs lists the created catalog', async () => {
    const r = await get(INSTANCES.a, token(), '/api/schema-library/catalogs');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const found = r.body.catalogs.find(c => c.name === catName);
    assert.ok(found, `${catName} should appear in catalog list`);
  });

  it('POST /catalogs rejects private/loopback URLs (SSRF)', async () => {
    const blockedUrls = [
      'http://192.168.1.1/api/schema-library',
      'http://127.0.0.1/api/schema-library',
      'http://169.254.169.254/api/schema-library',
      'http://localhost/api/schema-library',
    ];
    for (const url of blockedUrls) {
      const r = await post(INSTANCES.a, token(), '/api/schema-library/catalogs', {
        name: `test-ssrf-${RUN}-${Date.now()}`,
        url,
      });
      assert.equal(r.status, 400, `Expected 400 for SSRF URL ${url}, got ${r.status}`);
    }
  });

  it('POST /catalogs rejects non-HTTPS URLs', async () => {
    const r = await post(INSTANCES.a, token(), '/api/schema-library/catalogs', {
      name: `test-http-${RUN}`,
      url: 'http://example.com/api/schema-library',
    });
    assert.equal(r.status, 400, `Expected 400 for non-HTTPS URL, got ${r.status}`);
  });

  it('GET /catalogs/:name/entries proxies to foreign catalog (returns 502/504 for unreachable host)', async () => {
    // example.com does not expose a schema library endpoint — expect a proxy error (not a 200)
    const r = await get(INSTANCES.a, token(), `/api/schema-library/catalogs/${encodeURIComponent(catName)}/entries`);
    // proxy will get a non-200 or timeout from example.com — server returns 502
    assert.ok([502, 504].includes(r.status), `Expected 502/504 from proxy, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('GET /catalogs/:name/entries returns 404 for unknown catalog', async () => {
    const r = await get(INSTANCES.a, token(), `/api/schema-library/catalogs/${encodeURIComponent(`ghost-cat-${RUN}`)}/entries`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('POST /catalogs requires admin token', async () => {
    const createR = await post(INSTANCES.a, token(), '/api/tokens', { name: `non-admin-cat-${RUN}`});
    assert.equal(createR.status, 201);
    const nonAdminToken = createR.body.plaintext;
    const r = await post(INSTANCES.a, nonAdminToken, '/api/schema-library/catalogs', {
      name: `test-nonadmin-${RUN}`,
      url: 'https://example.com/api/schema-library',
    });
    assert.ok([401, 403].includes(r.status), `Expected 401/403 for non-admin, got ${r.status}`);
    await del(INSTANCES.a, token(), `/api/tokens/${createR.body.token?.id}`).catch(() => {});
  });

  it('DELETE /catalogs/:name removes the catalog', async () => {
    const r = await del(INSTANCES.a, token(), `/api/schema-library/catalogs/${encodeURIComponent(catName)}`);
    assert.equal(r.status, 204, JSON.stringify(r.body));
  });

  it('catalog no longer listed after deletion', async () => {
    const r = await get(INSTANCES.a, token(), '/api/schema-library/catalogs');
    assert.equal(r.status, 200);
    const found = r.body.catalogs?.find(c => c.name === catName);
    assert.ok(!found, `${catName} should not appear after deletion`);
  });

  it('DELETE /catalogs/:name returns 404 for unknown name', async () => {
    const r = await del(INSTANCES.a, token(), `/api/schema-library/catalogs/${encodeURIComponent(`ghost-cat-${RUN}`)}`);
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Library access tokens — schemaLibrary flag
// ═════════════════════════════════════════════════════════════════════════════
describe('Library access tokens', () => {
  let libToken; // plaintext PAT with schemaLibrary: true

  before(async () => {
    const r = await post(INSTANCES.a, token(), '/api/tokens', {
      name: `lib-access-${RUN}`,
      schemaLibrary: true,
    });
    assert.equal(r.status, 201, `Failed to create schemaLibrary token: ${JSON.stringify(r.body)}`);
    libToken = r.body.plaintext;
  });

  after(async () => {
    const listR = await get(INSTANCES.a, token(), '/api/tokens');
    const found = listR.body?.tokens?.find(t => t.name === `lib-access-${RUN}`);
    if (found) await del(INSTANCES.a, token(), `/api/tokens/${found.id}`).catch(() => {});
  });

  it('schemaLibrary token is returned with schemaLibrary:true and readOnly:true', async () => {
    const listR = await get(INSTANCES.a, token(), '/api/tokens');
    assert.equal(listR.status, 200);
    const found = listR.body?.tokens?.find(t => t.name === `lib-access-${RUN}`);
    assert.ok(found, 'schemaLibrary token should appear in token list');
    assert.equal(found.schemaLibrary, true);
    assert.equal(found.readOnly, true);
    assert.deepEqual(found.spaces, [], 'schemaLibrary token should have empty spaces array');
    assert.equal(found.admin, false);
  });

  it('schemaLibrary token cannot be created with admin:true', async () => {
    const r = await post(INSTANCES.a, token(), '/api/tokens', {
      name: `lib-admin-${RUN}`,
      schemaLibrary: true,
      rights: legacyRights({ admin: true })
    });
    assert.equal(r.status, 400, `Expected 400 for schemaLibrary+admin combo, got ${r.status}`);
  });

  it('schemaLibrary token cannot be created with spaces', async () => {
    const r = await post(INSTANCES.a, token(), '/api/tokens', {
      name: `lib-spaces-${RUN}`,
      schemaLibrary: true,
      rights: legacyRights({ spaces: ['some-space'] })
    });
    assert.equal(r.status, 400, `Expected 400 for schemaLibrary+spaces combo, got ${r.status}`);
  });

  it('GET /public accepts schemaLibrary token (200)', async () => {
    const r = await reqJson(INSTANCES.a, libToken, '/api/schema-library/public', {});
    assert.equal(r.status, 200, `schemaLibrary token should be accepted on /public, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('GET /public/:name accepts schemaLibrary token (200 or 404 for unknown)', async () => {
    const r = await reqJson(INSTANCES.a, libToken, '/api/schema-library/public/nonexistent-entry-test', {});
    assert.ok([200, 404].includes(r.status), `schemaLibrary token on /public/:name got unexpected status ${r.status}`);
  });

  it('schemaLibrary token is rejected by requireAuth routes (403)', async () => {
    // GET /api/schema-library (authenticated list) should reject schemaLibrary token
    const r = await get(INSTANCES.a, libToken, '/api/schema-library');
    assert.equal(r.status, 403, `schemaLibrary token should be rejected on authenticated routes, got ${r.status}`);
  });

  it('schemaLibrary token is rejected by /api/tokens/me (403)', async () => {
    // GET /api/tokens/me uses requireAuth — schemaLibrary tokens must be blocked there too
    const r = await get(INSTANCES.a, libToken, '/api/tokens/me');
    assert.equal(r.status, 403, `schemaLibrary token should be rejected on /api/tokens/me, got ${r.status}`);
  });

  it('invalid Bearer token on /public returns 401', async () => {
    const r = await reqJson(INSTANCES.a, 'invalid-not-a-real-token', '/api/schema-library/public', {});
    assert.equal(r.status, 401, `Invalid token on /public should return 401, got ${r.status}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Catalog accessToken — stored and redacted
// ═════════════════════════════════════════════════════════════════════════════
describe('Catalog accessToken — stored but never returned', () => {
  const catName = `test-cat-tok-${RUN}`;

  after(async () => {
    await del(INSTANCES.a, token(), `/api/schema-library/catalogs/${encodeURIComponent(catName)}`).catch(() => {});
  });

  it('POST /catalogs stores accessToken and returns hasAccessToken:true', async () => {
    const r = await post(INSTANCES.a, token(), '/api/schema-library/catalogs', {
      name: catName,
      url: 'https://example.com/api/schema-library',
      accessToken: 'ythril-a-very-long-token-value-1234567890',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.catalog?.name, catName);
    assert.equal(r.body.catalog?.hasAccessToken, true, 'hasAccessToken should be true');
    assert.ok(!('accessToken' in r.body.catalog), 'accessToken must not be returned in response');
  });

  it('GET /catalogs redacts accessToken — hasAccessToken:true, no plaintext', async () => {
    const r = await get(INSTANCES.a, token(), '/api/schema-library/catalogs');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const found = r.body.catalogs?.find(c => c.name === catName);
    assert.ok(found, `${catName} should appear in catalog list`);
    assert.equal(found.hasAccessToken, true, 'hasAccessToken should be true in list');
    assert.ok(!('accessToken' in found), 'accessToken must not appear in catalog list response');
  });

  it('POST /catalogs without accessToken returns hasAccessToken:false', async () => {
    const noTokenName = `test-cat-notok-${RUN}`;
    const r = await post(INSTANCES.a, token(), '/api/schema-library/catalogs', {
      name: noTokenName,
      url: 'https://example.com/api/schema-library',
    });
    assert.equal(r.status, 201, JSON.stringify(r.body));
    assert.equal(r.body.catalog?.hasAccessToken, false, 'hasAccessToken should be false when no token provided');
    assert.ok(!('accessToken' in r.body.catalog), 'accessToken must not be returned');
    await del(INSTANCES.a, token(), `/api/schema-library/catalogs/${encodeURIComponent(noTokenName)}`).catch(() => {});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Schema group support
// ═════════════════════════════════════════════════════════════════════════════

describe('Schema group support — schemaGroup field, GET /groups, POST /export-space, POST /groups/:group/apply', () => {
  const GROUP_NAME = `test-group-${RUN}`;
  const GROUP_ENTRY_A = `lib-grp-${RUN}-entity-widget`;
  const GROUP_ENTRY_B = `lib-grp-${RUN}-memory-note`;
  const GROUP_SPACE   = `schema-lib-grp-${RUN}`;

  before(async () => {
    // Create two entries in the same group
    await createEntry({
      name: GROUP_ENTRY_A,
      knowledgeType: 'entity',
      typeName: 'widget',
      schema: { propertySchemas: { colour: { type: 'string' } } },
      schemaGroup: GROUP_NAME,
    });
    await createEntry({
      name: GROUP_ENTRY_B,
      knowledgeType: 'fact',
      typeName: 'note',
      schema: { namingPattern: '^note-' },
      schemaGroup: GROUP_NAME,
    });
    // Create the target space for apply tests
    await post(INSTANCES.a, token(), '/api/spaces', { id: GROUP_SPACE, label: `Group Space ${RUN}` });
  });

  after(async () => {
    await deleteEntry(GROUP_ENTRY_A).catch(() => {});
    await deleteEntry(GROUP_ENTRY_B).catch(() => {});
    await fetch(`${INSTANCES.a}/api/spaces/${GROUP_SPACE}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
  });

  // ── schemaGroup field ────────────────────────────────────────────────────

  it('POST stores and returns schemaGroup', async () => {
    const r = await getEntry(GROUP_ENTRY_A);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry.schemaGroup, GROUP_NAME);
  });

  it('PUT updates schemaGroup', async () => {
    const newGroup = `${GROUP_NAME}-alt`;
    const r = await putEntry(GROUP_ENTRY_A, {
      knowledgeType: 'entity',
      typeName: 'widget',
      schema: { propertySchemas: { colour: { type: 'string' } } },
      schemaGroup: newGroup,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(r.body.entry.schemaGroup, newGroup);
    // Restore original group
    await putEntry(GROUP_ENTRY_A, {
      knowledgeType: 'entity',
      typeName: 'widget',
      schema: { propertySchemas: { colour: { type: 'string' } } },
      schemaGroup: GROUP_NAME,
    });
  });

  it('PUT clears schemaGroup with null', async () => {
    const r = await putEntry(GROUP_ENTRY_B, {
      knowledgeType: 'fact',
      typeName: 'note',
      schema: { namingPattern: '^note-' },
      schemaGroup: null,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body.entry.schemaGroup, 'schemaGroup should be cleared with null');
    // Restore
    await putEntry(GROUP_ENTRY_B, {
      knowledgeType: 'fact',
      typeName: 'note',
      schema: { namingPattern: '^note-' },
      schemaGroup: GROUP_NAME,
    });
  });

  it('POST returns 400 for schemaGroup exceeding 200 chars', async () => {
    const r = await createEntry({
      name: `lib-grp-bad-${RUN}`,
      knowledgeType: 'entity',
      typeName: 'x',
      schema: {},
      schemaGroup: 'a'.repeat(201),
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  // ── GET /groups ──────────────────────────────────────────────────────────

  it('GET /groups returns groups array', async () => {
    const r = await get(INSTANCES.a, token(), '/api/schema-library/groups');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(Array.isArray(r.body?.groups), 'groups should be an array');
  });

  it('GET /groups includes the test group with correct count', async () => {
    const r = await get(INSTANCES.a, token(), '/api/schema-library/groups');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const found = r.body.groups.find(g => g.name === GROUP_NAME);
    assert.ok(found, `Expected group '${GROUP_NAME}' in groups list`);
    assert.ok(found.count >= 2, `Expected count >= 2 for group '${GROUP_NAME}', got ${found.count}`);
  });

  it('GET /groups returns empty array when no groups exist (only ungrouped entries)', async () => {
    // Create an entry without a group, then verify groups endpoint works
    const ungrpName = `lib-ungrp-${RUN}`;
    await createEntry({ name: ungrpName, knowledgeType: 'edge', typeName: 'links', schema: {} });
    const r = await get(INSTANCES.a, token(), '/api/schema-library/groups');
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(!r.body.groups.find(g => g.name === undefined), 'undefined group should not appear');
    await deleteEntry(ungrpName).catch(() => {});
  });

  // ── POST /groups/:group/apply ────────────────────────────────────────────

  it('POST /groups/:group/apply applies all entries to a space as $ref', async () => {
    const r = await post(INSTANCES.a, token(), `/api/schema-library/groups/${encodeURIComponent(GROUP_NAME)}/apply`, {
      spaceId: GROUP_SPACE,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.count === 'number' && r.body.count >= 2, `Expected count >= 2, got ${r.body.count}`);
    assert.ok(Array.isArray(r.body.applied), 'applied should be an array');
    const entityApplied = r.body.applied.find(a => a.knowledgeType === 'entity' && a.typeName === 'widget');
    const memoryApplied = r.body.applied.find(a => a.knowledgeType === 'fact' && a.typeName === 'note');
    assert.ok(entityApplied, 'entity widget should be in applied list');
    assert.ok(memoryApplied, 'memory note should be in applied list');
  });

  it('POST /groups/:group/apply creates $ref in space meta', async () => {
    // Apply group first
    await post(INSTANCES.a, token(), `/api/schema-library/groups/${encodeURIComponent(GROUP_NAME)}/apply`, {
      spaceId: GROUP_SPACE,
    });
    // Read space meta and verify $ref entries
    const r = await get(INSTANCES.a, token(), `/api/spaces/${GROUP_SPACE}/meta`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    const entityWidget = r.body.typeSchemas?.entity?.widget;
    assert.ok(entityWidget, 'entity widget type schema should exist');
    assert.equal(entityWidget.$ref, `library:${GROUP_ENTRY_A}`, `Expected $ref to ${GROUP_ENTRY_A}`);
  });

  it('POST /groups/:group/apply returns 404 for unknown group', async () => {
    const r = await post(INSTANCES.a, token(), `/api/schema-library/groups/no-such-group-${RUN}/apply`, {
      spaceId: GROUP_SPACE,
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('POST /groups/:group/apply returns 404 for unknown space', async () => {
    const r = await post(INSTANCES.a, token(), `/api/schema-library/groups/${encodeURIComponent(GROUP_NAME)}/apply`, {
      spaceId: `nonexistent-space-${RUN}`,
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('POST /groups/:group/apply returns 400 for missing spaceId', async () => {
    const r = await post(INSTANCES.a, token(), `/api/schema-library/groups/${encodeURIComponent(GROUP_NAME)}/apply`, {});
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  // ── POST /export-space ───────────────────────────────────────────────────

  it('POST /export-space exports typeSchemas as library entries', async () => {
    // Set up a space with inline typeSchemas
    const exportSpaceId = `schema-lib-export-${RUN}`;
    await post(INSTANCES.a, token(), '/api/spaces', { id: exportSpaceId, label: `Export Test ${RUN}` });
    await patch(INSTANCES.a, token(), `/api/spaces/${exportSpaceId}`, {
      meta: {
        typeSchemas: {
          entity: { server: { namingPattern: '^svc-' } },
          fact: { alert: { propertySchemas: { severity: { type: 'string' } } } },
        },
      },
    });

    const exportGroup = `export-test-${RUN}`;
    const r = await post(INSTANCES.a, token(), '/api/schema-library/export-space', {
      spaceId: exportSpaceId,
      groupName: exportGroup,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.ok(typeof r.body.created === 'number', 'response should have created count');
    assert.ok(typeof r.body.updated === 'number', 'response should have updated count');
    assert.ok(Array.isArray(r.body.entries), 'response should have entries array');
    assert.ok(r.body.created >= 2, `Expected at least 2 created, got ${r.body.created}`);

    // Verify entries were created with correct group
    for (const entry of r.body.entries) {
      assert.equal(entry.schemaGroup, exportGroup, `Entry ${entry.name} should have group ${exportGroup}`);
    }

    // Verify entity server entry
    const entityEntry = r.body.entries.find(e => e.knowledgeType === 'entity' && e.typeName === 'server');
    assert.ok(entityEntry, 'entity server entry should be created');
    assert.equal(entityEntry.schema.namingPattern, '^svc-');

    // Check group appears in GET /groups
    const gR = await get(INSTANCES.a, token(), '/api/schema-library/groups');
    const grp = gR.body.groups?.find(g => g.name === exportGroup);
    assert.ok(grp, `Group '${exportGroup}' should appear in groups list after export`);

    // Cleanup
    await fetch(`${INSTANCES.a}/api/spaces/${exportSpaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
    for (const entry of r.body.entries) {
      await deleteEntry(entry.name).catch(() => {});
    }
  });

  it('POST /export-space skips $ref entries', async () => {
    // Create a space where one type uses $ref and another is inline
    const refSpaceId = `schema-lib-refexp-${RUN}`;
    await post(INSTANCES.a, token(), '/api/spaces', { id: refSpaceId, label: `Ref Export ${RUN}` });
    await patch(INSTANCES.a, token(), `/api/spaces/${refSpaceId}`, {
      meta: {
        typeSchemas: {
          entity: {
            service: { $ref: `library:${GROUP_ENTRY_A}` },  // $ref — should be skipped
            product: { namingPattern: '^prod-' },          // inline — should be exported
          },
        },
      },
    });

    const refExportGroup = `refexp-${RUN}`;
    const r = await post(INSTANCES.a, token(), '/api/schema-library/export-space', {
      spaceId: refSpaceId,
      groupName: refExportGroup,
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    // Only 'product' should be exported, not 'service' ($ref)
    const serviceEntry = r.body.entries.find(e => e.typeName === 'service');
    const productEntry = r.body.entries.find(e => e.typeName === 'product');
    assert.ok(!serviceEntry, '$ref entries should be skipped during export');
    assert.ok(productEntry, 'inline entries should be exported');

    // Cleanup
    await fetch(`${INSTANCES.a}/api/spaces/${refSpaceId}`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ confirm: true }),
    }).catch(() => {});
    for (const entry of r.body.entries) {
      await deleteEntry(entry.name).catch(() => {});
    }
  });

  it('POST /export-space returns 404 for unknown space', async () => {
    const r = await post(INSTANCES.a, token(), '/api/schema-library/export-space', {
      spaceId: `nonexistent-${RUN}`,
      groupName: 'my-group',
    });
    assert.equal(r.status, 404, JSON.stringify(r.body));
  });

  it('POST /export-space returns 400 for missing groupName', async () => {
    const r = await post(INSTANCES.a, token(), '/api/schema-library/export-space', {
      spaceId: GROUP_SPACE,
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });

  it('POST /export-space returns 400 for missing spaceId', async () => {
    const r = await post(INSTANCES.a, token(), '/api/schema-library/export-space', {
      groupName: 'my-group',
    });
    assert.equal(r.status, 400, JSON.stringify(r.body));
  });
});
