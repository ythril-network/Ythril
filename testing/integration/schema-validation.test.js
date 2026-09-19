/**
 * Integration tests: Space schema validation (strict / warn / off)
 *
 * Covers:
 *  - PATCH meta to set validationMode (strict and warn)
 *  - Strict mode blocks writes (memory, entity, edge, chrono) with 400
 *  - Warn mode passes writes with warnings in response body
 *  - Bulk write: strict skips violating items, warn records warnings
 *  - GET /api/spaces/:id/meta returns schema + stats
 *  - POST /api/spaces/:id/validate-schema dry-run
 *  - Cleanup: resets meta to off
 *
 * Run: node --test testing/integration/schema-validation.test.js
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { INSTANCES, post, get, patch, put } from '../sync/helpers.js';
import { openMcpSession } from '../sync/mcp-session.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIGS = path.join(__dirname, '..', 'sync', 'configs');
const RUN = Date.now();
const TEST_SPACE = `schema-test-${RUN}`;

let tokenA;
function token() { return tokenA; }

before(async () => {
  tokenA = fs.readFileSync(path.join(CONFIGS, 'a', 'token.txt'), 'utf8').trim();
  // Create a dedicated, non-networked space for schema validation tests
  const r = await post(INSTANCES.a, token(), '/api/spaces', { id: TEST_SPACE, label: `Schema Test ${RUN}`, meta: { strictLinkage: false } });
  assert.equal(r.status, 201, `Failed to create test space: ${JSON.stringify(r.body)}`);
});

after(async () => {
  // Teardown: delete the test space
  await fetch(`${INSTANCES.a}/api/spaces/${TEST_SPACE}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token()}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ confirm: true }),
  }).catch(() => {});
});

// ── Helper: PATCH meta on test space ───────────────────────────────────────
async function setMeta(meta) {
  const r = await patch(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}`, { meta });
  assert.ok([200, 202].includes(r.status), `Expected 200/202 setting meta, got ${r.status}: ${JSON.stringify(r.body)}`);
  return r;
}

// ── Helper: reset meta to off ──────────────────────────────────────────────
async function resetMeta() {
  // Use PUT (full replacement) to clear all typeSchemas; PATCH merges and
  // would leave existing type definitions intact when given an empty object.
  await put(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/schema`, { typeSchemas: {} });
  await setMeta({ validationMode: 'off' });
}

// ═════════════════════════════════════════════════════════════════════════════
//  STRICT MODE — writes must be blocked
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — strict mode', () => {
  before(async () => {
    await setMeta({
      validationMode: 'strict',
      typeSchemas: {
        entity: {
          service: {
            namingPattern: '^[A-Z]',
            propertySchemas: { team: { type: 'string', enum: ['alpha', 'beta'], required: true } },
          },
          person: {
            propertySchemas: { team: { type: 'string', enum: ['alpha', 'beta'], required: true } },
          },
        },
        edge: {
          depends_on: {
            propertySchemas: { confidence: { type: 'number', minimum: 0, maximum: 1, required: true } },
          },
          owns: {},
        },
        fact: {
          note: {
            propertySchemas: { source: { type: 'string', required: true } },
          },
        },
        chrono: {
          event: {
            propertySchemas: { priority: { type: 'string', enum: ['low', 'medium', 'high'], required: true } },
          },
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('rejects entity with disallowed type', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: 'SomeEntity',
      type: 'widget',
      properties: { team: 'alpha' },
    });
    assert.equal(r.status, 400, `Expected 400 for disallowed type, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'schema_violation');
    assert.ok(r.body.violations.length > 0);
  });

  it('rejects entity with naming pattern violation', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: 'lowercase-name',
      type: 'service',
      properties: { team: 'alpha' },
    });
    assert.equal(r.status, 400, `Expected 400 for naming violation, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'schema_violation');
  });

  it('rejects entity with missing required property', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: 'GoodName',
      type: 'person',
      properties: {},
    });
    assert.equal(r.status, 400, `Expected 400 for missing property, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'schema_violation');
    assert.ok(r.body.violations.some(v => v.field === 'properties.team'), `Expected 'team' violation`);
  });

  it('rejects entity with invalid enum value', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: 'GoodName',
      type: 'person',
      properties: { team: 'gamma' },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'schema_violation');
  });

  it('accepts valid entity', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: 'ValidService',
      type: 'service',
      properties: { team: 'alpha' },
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects memory with missing required property', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/facts`, {
      fact: `Schema strict test ${RUN}`,
      type: 'note',
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'schema_violation');
    assert.ok(r.body.violations.some(v => v.field === 'properties.source'));
  });

  it('accepts valid memory', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/facts`, {
      fact: `Schema strict test ${RUN} valid`,
      type: 'note',
      properties: { source: 'test-suite' },
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects edge with disallowed label', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/edges`, {
      from: 'a',
      to: 'b',
      label: 'invalid-label',
      properties: { confidence: 0.5 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'schema_violation');
  });

  it('rejects edge with property out of range', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/edges`, {
      from: 'a',
      to: 'b',
      label: 'depends_on',
      properties: { confidence: 5 },
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'schema_violation');
    assert.ok(r.body.violations.some(v => v.reason.includes('<=')));
  });

  it('rejects chrono with missing required property', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Schema strict chrono ${RUN}`,
      type: 'event',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400);
    assert.equal(r.body.error, 'schema_violation');
    assert.ok(r.body.violations.some(v => v.field === 'properties.priority'));
  });

  it('accepts valid chrono', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Schema strict chrono ${RUN} valid`,
      type: 'event',
      startsAt: new Date().toISOString(),
      properties: { priority: 'high' },
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  WARN MODE — writes pass with warnings
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — warn mode', () => {
  before(async () => {
    await setMeta({
      validationMode: 'warn',
      typeSchemas: {
        entity: {
          service: {},
          person: {
            propertySchemas: { team: { type: 'string', required: true } },
          },
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('allows entity with disallowed type but includes warnings', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: `WarnTest-${RUN}`,
      type: 'widget',
      properties: { team: 'alpha' },
    });
    assert.equal(r.status, 201, `Expected 201 in warn mode, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.ok(r.body.warnings?.length > 0 || r.body.warning, 'Expected warnings in response');
  });

  it('allows entity with missing required property but includes warnings', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: `WarnTest2-${RUN}`,
      type: 'person',
      properties: {},
    });
    assert.equal(r.status, 201);
    assert.ok(r.body.warnings?.length > 0 || r.body.warning, 'Expected warnings');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  BULK WRITE — strict mode skips violating items
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — bulk write strict mode', () => {
  before(async () => {
    await setMeta({
      validationMode: 'strict',
      typeSchemas: {
        entity: {
          service: {
            propertySchemas: { team: { type: 'string', required: true } },
          },
        },
        edge: {
          depends_on: {
            propertySchemas: { confidence: { type: 'number', required: true } },
          },
        },
        fact: {
          note: {
            propertySchemas: { source: { type: 'string', required: true } },
          },
        },
        chrono: {
          event: {
            propertySchemas: { priority: { type: 'string', required: true } },
          },
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('skips memories that violate schema, inserts valid ones', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/bulk`, {
      facts: [
        { fact: `Bulk valid ${RUN}`, type: 'note', properties: { source: 'test' } },
        { fact: `Bulk invalid ${RUN}`, type: 'note' },  // missing required 'source'
        { fact: `Bulk valid2 ${RUN}`, type: 'note', properties: { source: 'test2' } },
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.facts, 2, 'two valid memories should be inserted');
    assert.ok(r.body.errors.some(e => e.type === 'fact' && e.index === 1 && e.reason.includes('schema_violation')),
      'violating memory should have schema_violation error');
  });

  it('skips entities that violate schema', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/bulk`, {
      entities: [
        { name: `BulkValid-${RUN}`, type: 'service', properties: { team: 'alpha' } },
        { name: `BulkBad-${RUN}`, type: 'widget', properties: { team: 'alpha' } },  // disallowed type
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.entities, 1, 'only valid entity should be inserted');
    assert.ok(r.body.errors.some(e => e.type === 'entity' && e.index === 1 && e.reason.includes('schema_violation')));
  });

  it('skips edges that violate schema', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/bulk`, {
      edges: [
        { from: 'a', to: 'b', label: 'depends_on', properties: { confidence: 0.9 } },
        { from: 'c', to: 'd', label: 'invalid_label', properties: { confidence: 0.5 } },  // disallowed label
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.edges, 1, 'only valid edge should be inserted');
    assert.ok(r.body.errors.some(e => e.type === 'edge' && e.index === 1 && e.reason.includes('schema_violation')));
  });

  it('skips chrono that violate schema', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/bulk`, {
      chrono: [
        { title: `BulkGood-${RUN}`, type: 'event', startsAt: new Date().toISOString(), properties: { priority: 'high' } },
        { title: `BulkBad-${RUN}`, type: 'event', startsAt: new Date().toISOString() },  // missing priority
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.chrono, 1, 'only valid chrono should be inserted');
    assert.ok(r.body.errors.some(e => e.type === 'chrono' && e.index === 1 && e.reason.includes('schema_violation')));
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  BULK WRITE — warn mode records warnings but writes all
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — bulk write warn mode', () => {
  before(async () => {
    await setMeta({
      validationMode: 'warn',
      typeSchemas: {
        entity: {
          service: {
            propertySchemas: { team: { type: 'string', required: true } },
          },
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('writes all entities but records warnings for violating ones', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/bulk`, {
      entities: [
        { name: `BulkWarnValid-${RUN}`, type: 'service', properties: { team: 'alpha' } },
        { name: `BulkWarnBad-${RUN}`, type: 'widget', properties: { team: 'alpha' } },  // disallowed type
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.entities, 2, 'both entities should be inserted in warn mode');
    assert.ok(r.body.errors.some(e => e.type === 'entity' && e.reason.includes('schema_warning')),
      'violating entity should have schema_warning error');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  GET meta endpoint
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — GET /api/spaces/:id/meta', () => {
  before(async () => {
    await setMeta({
      validationMode: 'strict',
      typeSchemas: { entity: { service: {} } },
      purpose: 'Integration test schema',
    });
  });

  after(async () => { await resetMeta(); });

  it('returns meta with collection stats', async () => {
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    // Response is flat: {spaceId, spaceName, ...metaPublic, stats}
    assert.equal(r.body.validationMode, 'strict');
    assert.ok(typeof r.body.typeSchemas === 'object', 'Response should have typeSchemas');
    assert.ok(typeof r.body.stats === 'object', 'Response should have stats');
    // previousVersions should be stripped from public response
    assert.equal(r.body.previousVersions, undefined, 'previousVersions should be stripped');
  });

  it('reports needsReindex, the field the reindex tool tells callers to poll', async () => {
    // `reindex` returns as soon as the job STARTS, and its description says to poll `space_meta`. That was
    // only true over REST until now: `needsReindex` reached no tool, so a client with no HTTP door could start a
    // multi-minute job and never learn it finished. Asserted as a BOOLEAN rather than for truthiness — an
    // absent field and a `false` one are the same to `if (!x)` and opposite to a caller polling for a change.
    const r = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    assert.equal(r.status, 200, JSON.stringify(r.body));
    assert.equal(typeof r.body.needsReindex, 'boolean', `needsReindex must be present: ${JSON.stringify(r.body.needsReindex)}`);

    // And it agrees with the dedicated route, which is the thing it was added to replace polling.
    const status = await get(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/reindex-status`);
    assert.equal(status.status, 200, JSON.stringify(status.body));
    assert.equal(r.body.needsReindex, status.body.needsReindex,
      'two answers to one question must not disagree');
  });

  it('MCP space_meta reports the same field', async (t) => {
    // The whole point: the door that was told to poll can now poll.
    let session;
    try {
      session = await openMcpSession(token());
    } catch (e) {
      return t.skip(`MCP session unavailable: ${e.message}`);
    }
    try {
      const res = await session.callTool('space_meta', { space: TEST_SPACE });
      const text = res?.content?.[0]?.text ?? '';
      const meta = JSON.parse(text);
      assert.equal(typeof meta.needsReindex, 'boolean',
        `space_meta must carry needsReindex: ${text.slice(0, 200)}`);
      const status = await get(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/reindex-status`);
      assert.equal(meta.needsReindex, status.body.needsReindex, 'both doors, one answer');
    } finally {
      session.close();
    }
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  POST validate-schema dry-run
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — POST validate-schema dry-run', () => {
  before(async () => {
    await setMeta({
      validationMode: 'strict',
      typeSchemas: {
        entity: {
          service: { propertySchemas: { team: { type: 'string', required: true } } },
          person: { propertySchemas: { team: { type: 'string', required: true } } },
        },
      },
    });
    // Insert a valid entity
    await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: `DryRunGood-${RUN}`,
      type: 'service',
      properties: { team: 'valid' },
    });
  });

  after(async () => { await resetMeta(); });

  it('returns scan results for existing data', async () => {
    const r = await post(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/validate-schema`, {});
    assert.equal(r.status, 200, `Expected 200, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.spaceId, TEST_SPACE, 'Response should include spaceId');
    assert.ok(typeof r.body.totalViolations === 'number', 'Response should have totalViolations count');
    assert.ok(Array.isArray(r.body.violations), 'Response should have violations array');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  CUSTOM CHRONO TYPES — typeSchemas.chrono overrides global enum
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — custom chrono types', () => {
  before(async () => {
    await setMeta({
      validationMode: 'strict',
      typeSchemas: {
        chrono: {
          incident: {
            propertySchemas: { severity: { type: 'string', enum: ['low', 'medium', 'high'], required: true } },
          },
          'fix-shipped': {},
          resolved: {},
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('accepts a chrono entry with a custom type', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Custom type chrono ${RUN}`,
      type: 'incident',
      startsAt: new Date().toISOString(),
      properties: { severity: 'high' },
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.type, 'incident');
  });

  it('rejects a chrono entry with a global built-in type when custom types are defined', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Built-in type chrono ${RUN}`,
      type: 'event',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400, `Expected 400 when using built-in type with custom schema, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects a custom chrono entry with missing required property (strict mode)', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Missing props chrono ${RUN}`,
      type: 'incident',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400, `Expected 400 for missing required property, got ${r.status}: ${JSON.stringify(r.body)}`);
    assert.equal(r.body.error, 'schema_violation');
    assert.ok(r.body.violations.some(v => v.field === 'properties.severity'));
  });

  it('accepts a custom chrono type with no propertySchemas (no required constraints)', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Fix shipped chrono ${RUN}`,
      type: 'fix-shipped',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('bulk write accepts custom chrono types', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/bulk`, {
      chrono: [
        { title: `BulkCustomGood-${RUN}`, type: 'incident', startsAt: new Date().toISOString(), properties: { severity: 'low' } },
        { title: `BulkCustomBad-${RUN}`, type: 'event', startsAt: new Date().toISOString() },  // built-in type, not in custom schema
      ],
    });
    assert.equal(r.status, 207, JSON.stringify(r.body));
    assert.equal(r.body.inserted.chrono, 1, 'only valid chrono should be inserted');
    assert.ok(r.body.errors.some(e => e.type === 'chrono' && e.index === 1), 'built-in type should be rejected');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  DEFAULT CHRONO TYPES — no custom typeSchemas.chrono → 5 built-ins apply
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — default chrono types (no custom schema)', () => {
  before(async () => {
    // Validation mode is on but no custom chrono types
    await setMeta({ validationMode: 'strict', typeSchemas: { entity: { service: {} } } });
  });

  after(async () => { await resetMeta(); });

  it('accepts a chrono entry with a built-in type when no custom types are defined', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Default type chrono ${RUN}`,
      type: 'event',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 201, `Expected 201, got ${r.status}: ${JSON.stringify(r.body)}`);
  });

  it('rejects a chrono entry with an unknown type when no custom types are defined', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/chrono`, {
      title: `Unknown type chrono ${RUN}`,
      type: 'unknown-type',
      startsAt: new Date().toISOString(),
    });
    assert.equal(r.status, 400, `Expected 400 for unknown type, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  OFF mode — no validation at all
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — off mode passes everything', () => {
  before(async () => {
    await setMeta({
      validationMode: 'off',
      typeSchemas: {
        entity: {
          service: { propertySchemas: { team: { type: 'string', required: true } } },
        },
      },
    });
  });

  after(async () => { await resetMeta(); });

  it('allows entity that would violate schema in strict mode', async () => {
    const r = await post(INSTANCES.a, token(), `/api/brain/spaces/${TEST_SPACE}/entities`, {
      name: `OffMode-${RUN}`,
      type: 'widget',  // not in entityTypes
      properties: {},  // missing 'team'
    });
    assert.equal(r.status, 201, `Expected 201 with mode=off, got ${r.status}: ${JSON.stringify(r.body)}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
//  Meta versioning
// ═════════════════════════════════════════════════════════════════════════════
describe('Schema validation — meta versioning', () => {
  before(async () => { await resetMeta(); });
  after(async () => { await resetMeta(); });

  it('meta version increments on each update', async () => {
    await setMeta({ validationMode: 'warn', purpose: 'v1' });
    const r1 = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    const v1 = r1.body.version ?? 0;

    await setMeta({ validationMode: 'strict', purpose: 'v2' });
    const r2 = await get(INSTANCES.a, token(), `/api/spaces/${TEST_SPACE}/meta`);
    const v2 = r2.body.version ?? 0;

    assert.ok(v2 > v1, `Version should increment: v1=${v1}, v2=${v2}`);
  });
});
