/**
 * A schema-library type reads back with BOTH its reference and its definition, on both doors, and writing that
 * answer back keeps the reference (`Q-168`, owner ruling D-6).
 *
 * ## How this was found
 *
 * `GET /api/spaces/:id/meta` returned a library type as its stored `{ "$ref": "library:<name>" }` unless asked
 * `?resolve=1`, and MCP `space_meta` always returned it REPLACED by the library entry's definition, with the
 * `$ref` gone. So the two doors answered one question with two documents, an agent could never see that a type
 * was linked to the library, and neither answer could be written back whole: the resolved one detached the type
 * from its entry, and a body carrying both halves was refused by the strict schema.
 *
 * The owner's ruling: *"as always one module 2 doors... most capable and least destructive and least breaking"*.
 *
 * ## What is held
 *
 *   a. By default both doors return `{ $ref, ...definition }` — the stored reference and the definition side by
 *      side, so a reader of either shape finds what it reads today.
 *   b. That answer written back (a GET → edit elsewhere → PUT round trip) stores `{ $ref }` alone, on every door
 *      that takes type schemas: the definition beside a `$ref` is server-owned.
 *   c. A definition EDITED beside a `$ref` is refused with a 400 naming the field — the edit would otherwise be
 *      lost, because the type's definition lives in the library entry.
 *   d. `resolve: false` returns the stored form alone, on both doors.
 *
 * Run: node --test testing/standalone/a-library-type-is-read-and-written-back-whole-db.test.js
 * (requires a prior `npm run build` in server/, and the test Mongo)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';

const skip = await mongoSkipReason();
const SPACE = 'libtype';
const REF = 'library:svc';
const DEFINITION = { description: 'a service', propertySchemas: { tier: { type: 'string' } } };
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-libtype-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');

const RIGHTS = { instanceAdmin: true, perSpace: {} };

describe('a library type is read and written back whole', { skip }, () => {
  let loader, spacesTools, spacesRouter, bodySchemas, metaUpdate;

  /** The REST door: the route's own handler, past the auth middleware the test does not exercise. */
  const restMeta = async (query = {}) => {
    const layer = spacesRouter.stack.find(l => l.route?.path === '/:id/meta' && l.route.methods.get);
    assert.ok(layer, 'GET /:id/meta is not on the spaces router');
    const handler = layer.route.stack.at(-1).handle;
    const res = { code: 200, body: undefined, status(c) { this.code = c; return this; }, json(b) { this.body = b; return this; } };
    await handler({ params: { id: SPACE }, query, get: () => undefined, authToken: { rights: RIGHTS } }, res);
    assert.equal(res.code, 200, JSON.stringify(res.body));
    return res.body;
  };
  /** The MCP door. */
  const mcpMeta = async (args = {}) => {
    const r = await spacesTools.space_metaTool.handle({ callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE], args: { space: SPACE, ...args }, rights: RIGHTS });
    return r.structuredContent;
  };
  const stored = () => loader.getConfig().spaces.find(s => s.id === SPACE).meta.typeSchemas.entity.service;
  const resetStored = () => { loader.getConfig().spaces.find(s => s.id === SPACE).meta.typeSchemas = { entity: { service: { $ref: REF } } }; };

  before(async () => {
    fs.writeFileSync(path.join(tmpDir, 'schema-library.json'), JSON.stringify([
      { name: 'svc', knowledgeType: 'entity', typeName: 'service', schema: DEFINITION },
    ], null, 2), { mode: 0o600 });
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'libtype', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: SPACE, label: 'Library type', builtIn: true, folders: [], completeLinkage: true,
        meta: { validationMode: 'warn', typeSchemas: { entity: { service: { $ref: REF } } } } }],
    }, null, 2), { mode: 0o600 });
    loader = await import('../../server/dist/config/loader.js');
    loader.loadConfig();
    await openTestMongo('libtype');
    spacesTools = await import('../../server/dist/mcp/tools/spaces.js');
    ({ spacesRouter } = await import('../../server/dist/api/spaces.js'));
    bodySchemas = await import('../../server/dist/spaces/body-schemas.js');
    metaUpdate = await import('../../server/dist/spaces/meta-update.js');
  });
  after(async () => {
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  describe('a. by default both doors return the reference AND the definition', () => {
    for (const [door, read] of [['REST', () => restMeta()], ['MCP', () => mcpMeta()]]) {
      it(door, async () => {
        const t = (await read()).typeSchemas.entity.service;
        assert.equal(t.$ref, REF, `${door} dropped the stored reference: ${JSON.stringify(t)}`);
        assert.deepEqual(t.propertySchemas, DEFINITION.propertySchemas, `${door} did not carry the definition: ${JSON.stringify(t)}`);
        assert.equal(t.description, DEFINITION.description);
      });
    }
    it('and the two doors return the same document', async () => {
      assert.deepEqual((await restMeta()).typeSchemas, (await mcpMeta()).typeSchemas);
    });
  });

  describe('d. resolve false returns the stored form alone, on both doors', () => {
    it('REST', async () => assert.deepEqual((await restMeta({ resolve: 'false' })).typeSchemas.entity.service, { $ref: REF }));
    it('MCP', async () => assert.deepEqual((await mcpMeta({ resolve: false })).typeSchemas.entity.service, { $ref: REF }));
  });

  describe('b. the default answer written back keeps the reference', () => {
    it('through the meta update both doors share (PATCH /api/spaces/:id, schema_update)', async () => {
      resetStored();
      const typeSchemas = (await mcpMeta()).typeSchemas;
      const space = loader.getConfig().spaces.find(s => s.id === SPACE);
      const decision = metaUpdate.planSpaceMetaUpdate({ spaceId: SPACE, space, body: { meta: { typeSchemas } }, ifMatch: undefined });
      assert.ok(decision.ok, `the round trip was refused: ${JSON.stringify(decision.refusal)}`);
      const r = await spacesTools.schema_updateTool.handle({ callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE], args: { space: SPACE, typeSchemas }, rights: RIGHTS });
      assert.ok(!r.isError, JSON.stringify(r.content));
      assert.deepEqual(stored(), { $ref: REF }, `the stored type was cut loose from its library entry: ${JSON.stringify(stored())}`);
    });
    it('through PUT /api/spaces/:id/schema and the single-type PUT', async () => {
      const typeSchemas = (await restMeta()).typeSchemas;
      const put = bodySchemas.PutSchemaBody.safeParse({ typeSchemas });
      assert.ok(put.success, put.error?.message);
      assert.deepEqual(put.data.typeSchemas.entity.service, { $ref: REF });
      const one = bodySchemas.TypeSchemaZ.safeParse(typeSchemas.entity.service);
      assert.ok(one.success, one.error?.message);
      assert.deepEqual(one.data, { $ref: REF });
    });
  });

  describe('c. an edited definition beside a $ref is refused, naming the field', () => {
    const edited = async () => {
      const typeSchemas = structuredClone((await mcpMeta()).typeSchemas);
      typeSchemas.entity.service.propertySchemas.tier.type = 'number';
      return typeSchemas;
    };
    const named = msg => {
      assert.match(msg, /propertySchemas/, `the refusal does not name the field: ${msg}`);
      assert.match(msg, /library/i, `the refusal does not say where the definition lives: ${msg}`);
    };
    it('through the shared meta update, as a 400', async () => {
      resetStored();
      const space = loader.getConfig().spaces.find(s => s.id === SPACE);
      const decision = metaUpdate.planSpaceMetaUpdate({ spaceId: SPACE, space, body: { meta: { typeSchemas: await edited() } }, ifMatch: undefined });
      assert.equal(decision.ok, false, 'an edit that would be silently lost was accepted');
      assert.equal(decision.refusal.status, 400);
      named(decision.refusal.body.error);
      assert.deepEqual(stored(), { $ref: REF });
    });
    it('through MCP schema_update', async () => {
      const r = await spacesTools.schema_updateTool.handle({ callSpace: SPACE, callSpaces: [SPACE], accessibleSpaceIds: [SPACE], args: { space: SPACE, typeSchemas: await edited() }, rights: RIGHTS });
      assert.equal(r.isError, true);
      assert.match(r.content[0].text, /Error \(400\)/);
      named(r.content[0].text);
    });
    it('through PUT /api/spaces/:id/schema', async () => {
      const put = bodySchemas.PutSchemaBody.safeParse({ typeSchemas: await edited() });
      assert.equal(put.success, false);
      named(put.error.message);
    });
  });
});
