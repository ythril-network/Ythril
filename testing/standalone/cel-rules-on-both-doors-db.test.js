/**
 * A rule is written, refused, replaced and reported the same way on every door that can write one — and only by a caller with
 * the rung that governs it (F-46, rulings R6-5, R6-12; the CLAUDE.md rule that REST and MCP are one API with two doors).
 *
 * ## The doors, and why each is here
 *
 * | capability | REST | MCP |
 * |---|---|---|
 * | write a space's meta (type rules, `meta.rules`) | `PATCH /api/spaces/:id` | `schema_update` |
 * | replace the whole schema | `PUT /api/spaces/:id/schema` | `schema_update` with `typeSchemasMode: replace` |
 * | write one type | `PUT /api/spaces/:id/meta/typeSchemas/:kind/:type` | `schema_update` (merge) |
 * | create a space with rules | `POST /api/spaces` | `save_space` |
 * | read what is stored and what is dead | `GET /api/spaces/:id/meta` | `space_meta` |
 * | a write the rules judge | `POST /api/brain/spaces/:s/entities` | `save_entity` |
 *
 * Each is driven in-process (`_cel-doors.mjs`): the REST door through its chain from `denyReadOnly` on, so the per-field guard
 * is in it, and the MCP door through `callTool`, the dispatch every MCP request and `POST /api/<tool>` go through.
 *
 * ## What is held
 *
 * 1. **Accepted.** A sound rule at a type and at the space is stored by every write door (the control that gives each refusal
 *    below its meaning: a door that refuses every body would pass them all).
 * 2. **Refused alike.** A rule the save refuses is refused by every door, nothing is stored, and the refusal says WHICH RULE and
 *    WHY — not "unrecognized key", which is what the base says to every rule and what an unrelated refusal would also say. The
 *    two meta doors answer in the same words.
 * 3. **At the rung that governs it.** `meta.rules` and a type rule need `schema: admin` — the rung of `validationMode`, the other
 *    setting that changes what writes are refused — and a `schema: write` caller keeps every other schema edit.
 * 4. **Replaced as the owner is replaced.** `meta.rules` is replaced whole by a write that names it and left alone by one that
 *    does not; a type's rules go with the type.
 * 5. **Reported once, as names.** A stored rule that no longer compiles is listed on `space_meta` by name on both doors, with
 *    neither its text nor its message.
 * 6. **Judged alike.** A strict write that breaks a rule is refused on both doors, naming the same rule field and the same
 *    reason; under warn it lands and is reported.
 *
 * ## Why this is red on the base
 *
 * `TypeSchemaZ` and `SpaceMetaBody` are strict and declare no `rules`, so the control in (1) is refused on every door, and the
 * rest are written to fail on their own claim too (a refusal that does not name the rule is not the refusal asked for).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/cel-rules-on-both-doors-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  scratchEnv, response, rightsAt, adminRights, routeOf, chainFrom, requestOf, callMcp, resetConfig, storedMeta, violationRows, withoutStatus,
} from './_cel-doors.mjs';

const skip = await mongoSkipReason();
const scratch = scratchEnv('ythril-cel-doors-');
const { rule, DECLARED, typeSchemasOf } = await import('./_cel-rules.mjs');

const SPACE = 'celdoors';
const BELOW = 'b must be below one hundred';
const SOUND_TYPE_RULE = rule('self.properties.b < 100.0', BELOW);
const SOUND_SPACE_RULE = rule(`self.title != 'Forbidden'`, 'that title is not allowed');

/** The space every case starts from: strict, one entity type with three declared properties and no rules. */
const baseMeta = (extra = {}) => ({ validationMode: 'strict', suppressEmbeddings: true, typeSchemas: typeSchemasOf('entity', 'thing', undefined), ...extra });
const spaceEntry = (meta = baseMeta()) => ({ id: SPACE, label: 'Rule doors', folders: [], completeLinkage: true, meta });

let mongo, spacesRouter, entitiesRouter, ADMIN;
let restPatch, restPutSchema, restPutType, restCreate, restMeta, restEntity;

// ── the doors: each answers { status, refused, text, body } ────────────────────────────────────────────────────────────

/** The route's own handler, past the guards (a create or a read has no per-field guard to keep in the chain). */
async function finalOnly(handlers, req) {
  const res = response();
  try { await handlers.at(-1)(req, res, () => {}); } catch (err) { res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }); }
  return res;
}

const restAnswer = (res) => ({ status: res.statusCode, refused: res.statusCode >= 400, body: res.body, text: JSON.stringify(res.body ?? '') });
const mcpAnswer = (o) => ({ status: o.status, refused: o.isError, body: o.structured, text: o.text });

const DOORS = {
  /** meta + type rules, merged */
  'PATCH /api/spaces/:id': async (rights, { meta, typeSchemasMode }) => restAnswer(await chainFrom(restPatch, 'denyReadOnly',
    requestOf({ params: { id: SPACE }, body: { meta, ...(typeSchemasMode ? { typeSchemasMode } : {}) }, rights }), response())),
  'schema_update': async (rights, { meta, typeSchemasMode }) => mcpAnswer(await callMcp('schema_update', { space: SPACE, ...meta, ...(typeSchemasMode ? { typeSchemasMode } : {}) }, rights)),
};

/** A `typeSchemas` body carrying one entity type with `rules`, as each door wants it. */
const typeBody = (rules) => ({ typeSchemas: typeSchemasOf('entity', 'thing', rules) });

describe('a rule is written, refused and read the same way on every door', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('celdoors');
    await resetConfig(scratch.configPath, { spaces: [spaceEntry()] });
    ({ spacesRouter } = await import('../../server/dist/api/spaces.js'));
    ({ entitiesRouter } = await import('../../server/dist/api/brain/entities.js'));
    restPatch = routeOf(spacesRouter, 'patch', '/:id');
    restPutSchema = routeOf(spacesRouter, 'put', '/:id/schema');
    restPutType = routeOf(spacesRouter, 'put', '/:id/meta/typeSchemas/:knowledgeType/:typeName');
    restCreate = routeOf(spacesRouter, 'post', '/');
    restMeta = routeOf(spacesRouter, 'get', '/:id/meta');
    restEntity = routeOf(entitiesRouter, 'post', '/spaces/:spaceId/entities');
    ADMIN = await adminRights();
  });

  after(async () => { await closeTestMongo(); scratch.cleanup(); });
  beforeEach(async () => {
    await resetConfig(scratch.configPath, { spaces: [spaceEntry()] });
    await mongo.col(`${SPACE}_entities`).deleteMany({});
  });

  // ── 1. accepted ─────────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a sound rule is stored by every write door', () => {
    const cases = {
      'PATCH /api/spaces/:id': async () => DOORS['PATCH /api/spaces/:id'](ADMIN, { meta: { ...typeBody({ below: SOUND_TYPE_RULE }), rules: { named: SOUND_SPACE_RULE } } }),
      'schema_update': async () => DOORS['schema_update'](ADMIN, { meta: { ...typeBody({ below: SOUND_TYPE_RULE }), rules: { named: SOUND_SPACE_RULE } } }),
      'PUT /api/spaces/:id/schema (the type rule)': async () => restAnswer(await chainFrom(restPutSchema, 'denyReadOnly',
        requestOf({ params: { id: SPACE }, body: typeBody({ below: SOUND_TYPE_RULE }), rights: ADMIN }), response())),
      'PUT /api/spaces/:id/meta/typeSchemas/:kind/:type (the type rule)': async () => restAnswer(await chainFrom(restPutType, 'denyReadOnly',
        requestOf({ params: { id: SPACE, knowledgeType: 'entity', typeName: 'thing' }, body: { propertySchemas: DECLARED, rules: { below: SOUND_TYPE_RULE } }, rights: ADMIN }), response())),
    };
    for (const [door, run] of Object.entries(cases)) {
      it(`${door}`, async () => {
        const answer = await run();
        assert.equal(answer.refused, false, `${door} refused a sound rule: ${answer.text}`);
        const stored = await storedMeta(SPACE);
        assert.deepEqual(Object.keys(stored.typeSchemas?.entity?.thing?.rules ?? {}), ['below'], `${door}: the type's rule was not stored`);
        assert.equal(stored.typeSchemas.entity.thing.rules.below.rule, SOUND_TYPE_RULE.rule, `${door}: the rule text was changed on the way in`);
        if (door.includes('PATCH') || door === 'schema_update') {
          assert.deepEqual(Object.keys(stored.rules ?? {}), ['named'], `${door}: the space's rule was not stored`);
        }
      });
    }

    it('POST /api/spaces and save_space create a space that carries its rules', async () => {
      const meta = { validationMode: 'strict', ...typeBody({ below: SOUND_TYPE_RULE }), rules: { named: SOUND_SPACE_RULE } };
      const rest = restAnswer(await finalOnly(restCreate, requestOf({ body: { id: 'celcreatedrest', label: 'Created by REST', meta }, rights: ADMIN })));
      const mcp = mcpAnswer(await callMcp('save_space', { id: 'celcreatedmcp', label: 'Created by MCP', meta }, ADMIN));
      assert.equal(rest.refused, false, `REST create refused a space with sound rules: ${rest.text}`);
      assert.equal(mcp.refused, false, `save_space refused a space with sound rules: ${mcp.text}`);
      for (const id of ['celcreatedrest', 'celcreatedmcp']) {
        const stored = await storedMeta(id);
        assert.deepEqual(Object.keys(stored?.rules ?? {}), ['named'], `${id}: the space's rules were not stored`);
        assert.deepEqual(Object.keys(stored?.typeSchemas?.entity?.thing?.rules ?? {}), ['below'], `${id}: the type's rules were not stored`);
      }
    });
  });

  // ── 2. refused alike ────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a rule the save refuses is refused by every door, naming the rule and the reason', () => {
    /** One bad rule per way a rule is bad; `says` is what a refusal must carry beside the rule's name. */
    const BAD = [
      { label: 'text that is not an expression', rule: rule('self.properties.a ==', 'm'), says: /compile|parse|expression|syntax/i },
      { label: 'an unknown function', rule: rule('frobnicate(self.properties.a)', 'm'), says: /function|frobnicate|undeclared/i },
      { label: 'an invalid regex literal', rule: rule(`self.properties.a.matches('(')`, 'm'), says: /regex|pattern|matches/i },
      { label: 'a rule that is not a bool', rule: rule('self.properties.a', 'm'), says: /bool|true or false/i },
      { label: 'a property the type does not declare', rule: rule(`self.properties.nope == 'x'`, 'm'), says: /nope|declared/i },
      { label: 'a rule over 1000 characters', rule: rule(`self.properties.a == '${'x'.repeat(1000)}'`, 'm'), says: /1000|long|length|character/i },
    ];

    for (const bad of BAD) {
      it(`${bad.label}: both meta doors refuse it, store nothing and say alike`, async () => {
        const before_ = await storedMeta(SPACE);
        const meta = typeBody({ broken: bad.rule });
        const rest = await DOORS['PATCH /api/spaces/:id'](ADMIN, { meta });
        const mcp = await DOORS['schema_update'](ADMIN, { meta });
        for (const [door, a] of [['PATCH', rest], ['schema_update', mcp]]) {
          assert.equal(a.refused, true, `${door} accepted ${bad.label}: ${a.text}`);
          assert.match(a.text, /broken/, `${door}: the refusal does not name the rule 'broken': ${a.text}`);
          assert.match(a.text, bad.says, `${door}: the refusal does not say why (${bad.says}): ${a.text}`);
          assert.doesNotMatch(a.text, /unrecogni[sz]ed key/i, `${door}: this is the strict body refusing an undeclared field, not a verdict on the rule: ${a.text}`);
        }
        assert.equal(rest.status, 400, `PATCH answered ${rest.status}`);
        const restText = rest.body?.error ?? rest.text;
        assert.equal(withoutStatus(mcp.text), restText, 'the two doors refuse the same rule in different words');
        assert.deepEqual(await storedMeta(SPACE), before_, `a refused rule changed the stored meta`);
      });
    }

    it('the whole-schema and single-type REST doors refuse the same rules the same way', async () => {
      const before_ = await storedMeta(SPACE);
      for (const bad of BAD) {
        const put = restAnswer(await chainFrom(restPutSchema, 'denyReadOnly',
          requestOf({ params: { id: SPACE }, body: typeBody({ broken: bad.rule }), rights: ADMIN }), response()));
        const one = restAnswer(await chainFrom(restPutType, 'denyReadOnly',
          requestOf({ params: { id: SPACE, knowledgeType: 'entity', typeName: 'thing' }, body: { propertySchemas: DECLARED, rules: { broken: bad.rule } }, rights: ADMIN }), response()));
        for (const [door, a] of [['PUT schema', put], ['PUT type', one]]) {
          assert.equal(a.refused, true, `${door} accepted ${bad.label}: ${a.text}`);
          assert.match(a.text, /broken/, `${door}: the refusal does not name the rule: ${a.text}`);
          assert.match(a.text, bad.says, `${door}: the refusal does not say why: ${a.text}`);
        }
      }
      assert.deepEqual(await storedMeta(SPACE), before_, 'a refused rule changed the stored meta');
    });

    it('a space rule is refused the same way, and an edge rule that reads self.from is refused on both', async () => {
      const spaceBad = { meta: { rules: { broken: rule('self.properties.a ==', 'm') } } };
      const edgeBad = { meta: { rules: { fromrule: { ...rule(`self.from != ''`, 'm'), kinds: ['edge'] } } } };
      for (const [what, body, name] of [['a space rule that is not an expression', spaceBad, 'broken'], ['a space edge rule on self.from', edgeBad, 'fromrule']]) {
        const rest = await DOORS['PATCH /api/spaces/:id'](ADMIN, body);
        const mcp = await DOORS['schema_update'](ADMIN, body);
        for (const [door, a] of [['PATCH', rest], ['schema_update', mcp]]) {
          assert.equal(a.refused, true, `${door} accepted ${what}`);
          assert.match(a.text, new RegExp(name), `${door}: ${what}: the refusal does not name the rule: ${a.text}`);
          assert.doesNotMatch(a.text, /unrecogni[sz]ed key/i, `${door}: ${what}: ${a.text}`);
        }
        assert.equal(withoutStatus(mcp.text), rest.body?.error ?? rest.text, `${what}: the two doors disagree`);
      }
    });

    it('a space created with a broken rule is refused by POST /api/spaces and save_space, and no space is made', async () => {
      const meta = { validationMode: 'strict', rules: { broken: rule('self.properties.a ==', 'm') } };
      const rest = restAnswer(await finalOnly(restCreate, requestOf({ body: { id: 'celbadrest', label: 'Bad by REST', meta }, rights: ADMIN })));
      const mcp = mcpAnswer(await callMcp('save_space', { id: 'celbadmcp', label: 'Bad by MCP', meta }, ADMIN));
      for (const [door, a] of [['REST create', rest], ['save_space', mcp]]) {
        assert.equal(a.refused, true, `${door} created a space with a rule that is not an expression: ${a.text}`);
        assert.match(a.text, /broken/, `${door}: the refusal does not name the rule: ${a.text}`);
      }
      assert.equal(await storedMeta('celbadrest'), undefined);
      assert.equal(await storedMeta('celbadmcp'), undefined);
    });
  });

  // ── 3. the rung that governs it ─────────────────────────────────────────────────────────────────────────────────────

  describe('rules need schema admin, and a schema writer keeps every other schema edit', () => {
    let writer, admin;
    before(async () => {
      writer = await rightsAt(SPACE, { schema: 'write', knowledge: 'read' });
      admin = await rightsAt(SPACE, { schema: 'admin', knowledge: 'read' });
    });

    const refusedForRung = (answer, what) => {
      assert.equal(answer.refused, true, `${what}: accepted`);
      assert.ok(answer.status === 403 || /\b403\b|admin/i.test(answer.text), `${what}: refused, but not for the rung (status ${answer.status}): ${answer.text}`);
    };

    it('PATCH: meta.rules at schema:write is refused, at schema:admin it is stored', async () => {
      refusedForRung(await DOORS['PATCH /api/spaces/:id'](writer, { meta: { rules: { named: SOUND_SPACE_RULE } } }), 'a schema writer setting meta.rules');
      assert.equal((await storedMeta(SPACE)).rules, undefined, 'a refused rule was stored');
      const ok = await DOORS['PATCH /api/spaces/:id'](admin, { meta: { rules: { named: SOUND_SPACE_RULE } } });
      assert.equal(ok.refused, false, `a schema admin was refused: ${ok.text}`);
      assert.deepEqual(Object.keys((await storedMeta(SPACE)).rules ?? {}), ['named']);
    });

    it('PATCH: a type rule at schema:write is refused, the same type without rules is accepted, at schema:admin the rule is stored', async () => {
      refusedForRung(await DOORS['PATCH /api/spaces/:id'](writer, { meta: typeBody({ below: SOUND_TYPE_RULE }) }), 'a schema writer adding a type rule');
      assert.equal((await storedMeta(SPACE)).typeSchemas.entity.thing.rules, undefined, 'a refused type rule was stored');
      // The control: the same writer, the same type, an ordinary schema edit.
      const plain = await DOORS['PATCH /api/spaces/:id'](writer, { meta: { typeSchemas: { entity: { thing: { propertySchemas: { ...DECLARED, extra: { type: 'string' } } } } } } });
      assert.equal(plain.refused, false, `a schema writer was refused an edit that touches no rule: ${plain.text}`);
      const ok = await DOORS['PATCH /api/spaces/:id'](admin, { meta: typeBody({ below: SOUND_TYPE_RULE }) });
      assert.equal(ok.refused, false, `a schema admin was refused: ${ok.text}`);
    });

    it('PATCH: a schema writer may keep a rule that is already there while editing the type (an unchanged rule is not a change)', async () => {
      await resetConfig(scratch.configPath, { spaces: [spaceEntry(baseMeta({ typeSchemas: typeSchemasOf('entity', 'thing', { below: SOUND_TYPE_RULE }) }))] });
      const edit = await DOORS['PATCH /api/spaces/:id'](writer, {
        meta: { typeSchemas: typeSchemasOf('entity', 'thing', { below: SOUND_TYPE_RULE }, { ...DECLARED, extra: { type: 'string' } }) } });
      assert.equal(edit.refused, false, `a schema writer re-sending a type with its rules unchanged was refused: ${edit.text}`);
      const changed = await DOORS['PATCH /api/spaces/:id'](writer, {
        meta: { typeSchemas: typeSchemasOf('entity', 'thing', { below: rule('self.properties.b < 5.0', BELOW) }) } });
      refusedForRung(changed, 'a schema writer CHANGING a rule');
    });

    it('PUT single type: a type with rules needs schema:admin, without rules schema:write is enough', async () => {
      const send = async (rights, body) => restAnswer(await chainFrom(restPutType, 'denyReadOnly',
        requestOf({ params: { id: SPACE, knowledgeType: 'entity', typeName: 'thing' }, body, rights }), response()));
      refusedForRung(await send(writer, { propertySchemas: DECLARED, rules: { below: SOUND_TYPE_RULE } }), 'a schema writer putting a type with a rule');
      const plain = await send(writer, { propertySchemas: { ...DECLARED, extra: { type: 'string' } } });
      assert.equal(plain.refused, false, `a schema writer was refused a type with no rules: ${plain.text}`);
      const ok = await send(admin, { propertySchemas: DECLARED, rules: { below: SOUND_TYPE_RULE } });
      assert.equal(ok.refused, false, `a schema admin was refused: ${ok.text}`);
    });

    it('schema_update: a schema writer is refused outright (the tool is the admin rung), an admin writes the rules', async () => {
      refusedForRung(await DOORS['schema_update'](writer, { meta: { rules: { named: SOUND_SPACE_RULE } } }), 'a schema writer through schema_update');
      assert.equal((await storedMeta(SPACE)).rules, undefined);
      const ok = await DOORS['schema_update'](admin, { meta: { rules: { named: SOUND_SPACE_RULE } } });
      assert.equal(ok.refused, false, `a schema admin was refused: ${ok.text}`);
    });

    it('PUT schema is the admin rung by its route row, and the row is what says so', async () => {
      const { ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
      const row = ROUTE_RIGHTS.find(r => r.route === '/api/spaces/:id/schema' && r.method === 'PUT');
      assert.deepEqual([row?.area, row?.needs], ['schema', 'admin'], 'the whole-schema replace is no longer the admin rung, so a writer could replace every rule');
    });
  });

  // ── 4. replaced as the owner is replaced ────────────────────────────────────────────────────────────────────────────

  describe('meta.rules is replaced whole and a type\'s rules go with the type', () => {
    for (const door of Object.keys(DOORS)) {
      it(`${door}: a map that names fewer rules deletes the rest, {} clears, and a write that does not name rules leaves them`, async () => {
        const send = (meta) => DOORS[door](ADMIN, { meta });
        const first = await send({ rules: { one: SOUND_SPACE_RULE, two: rule('size(self.title) > 1', 'longer') } });
        assert.equal(first.refused, false, first.text);
        assert.deepEqual(Object.keys((await storedMeta(SPACE)).rules ?? {}).sort(), ['one', 'two']);
        assert.equal((await send({ rules: { three: rule('size(self.title) > 2', 'longest') } })).refused, false);
        assert.deepEqual(Object.keys((await storedMeta(SPACE)).rules ?? {}), ['three'], 'the map sent was unioned with the stored one');
        assert.equal((await send({ purpose: 'unrelated' })).refused, false);
        assert.deepEqual(Object.keys((await storedMeta(SPACE)).rules ?? {}), ['three'], 'a write that does not name rules changed them');
        assert.equal((await send({ rules: {} })).refused, false);
        assert.deepEqual((await storedMeta(SPACE)).rules ?? {}, {}, 'an empty map did not clear the rules');
      });

      it(`${door}: a type written without rules has none: its rules went with the type it replaced`, async () => {
        const send = (meta) => DOORS[door](ADMIN, { meta });
        assert.equal((await send(typeBody({ below: SOUND_TYPE_RULE }))).refused, false);
        assert.deepEqual(Object.keys((await storedMeta(SPACE)).typeSchemas.entity.thing.rules ?? {}), ['below']);
        assert.equal((await send({ typeSchemas: typeSchemasOf('entity', 'thing', undefined, { ...DECLARED, extra: { type: 'string' } }) })).refused, false);
        assert.equal((await storedMeta(SPACE)).typeSchemas.entity.thing.rules, undefined, 'the type\'s rules survived its replacement');
      });
    }
  });

  // ── 5. reported once, as names ──────────────────────────────────────────────────────────────────────────────────────

  describe('a stored rule that no longer compiles is reported by name on both doors', () => {
    const DEAD_TEXT = 'self.properties.b <';
    const DEAD_MESSAGE = 'this message belongs to a dead rule';

    beforeEach(async () => {
      await resetConfig(scratch.configPath, { spaces: [spaceEntry(baseMeta({
        typeSchemas: typeSchemasOf('entity', 'thing', { dead: rule(DEAD_TEXT, DEAD_MESSAGE), live: SOUND_TYPE_RULE }),
        rules: { spacedead: rule('size(self.title) >', DEAD_MESSAGE) },
      }))] });
    });

    it('GET /api/spaces/:id/meta and space_meta list the same dead rules, names only', async () => {
      const restRes = await finalOnly(restMeta, requestOf({ params: { id: SPACE }, rights: ADMIN }));
      const mcp = await callMcp('space_meta', { space: SPACE }, ADMIN);
      const restInvalid = restRes.body?.invalidRules;
      const mcpInvalid = mcp.structured?.invalidRules;
      assert.ok(restInvalid !== undefined, `GET /meta has no invalidRules: ${JSON.stringify(restRes.body).slice(0, 300)}`);
      assert.ok(mcpInvalid !== undefined, `space_meta has no invalidRules: ${JSON.stringify(mcp.structured ?? mcp.text).slice(0, 300)}`);
      assert.deepEqual(mcpInvalid, restInvalid, 'the two doors report different dead rules');
      const listed = JSON.stringify(restInvalid);
      for (const name of ['dead', 'spacedead']) assert.match(listed, new RegExp(name), `${name} is not reported: ${listed}`);
      assert.doesNotMatch(listed, /live/, 'a live rule is reported as dead');
      assert.ok(!listed.includes(DEAD_TEXT.trim()) && !listed.includes(DEAD_MESSAGE), 'the report quotes a rule\'s text or message: it is names only');
    });
  });

  // ── 6. judged alike ─────────────────────────────────────────────────────────────────────────────────────────────────

  describe('a write the rules judge is judged alike on both doors', () => {
    const withRule = (mode) => resetConfig(scratch.configPath, { spaces: [spaceEntry(baseMeta({
      validationMode: mode, typeSchemas: typeSchemasOf('entity', 'thing', { below: SOUND_TYPE_RULE }) }))] });
    const REST_ENTITY = (properties) => async () => restAnswer(await chainFrom(restEntity, 'denyReadOnly',
      requestOf({ params: { spaceId: SPACE }, body: { name: 'Acme', type: 'thing', properties }, rights: ADMIN }), response()));
    const MCP_ENTITY = (properties) => async () => mcpAnswer(await callMcp('save_entity', { space: SPACE, name: 'Acme', type: 'thing', properties }, ADMIN));

    it('strict: both refuse a record that breaks the rule, name the rule field and say the same reason, and write nothing', async () => {
      await withRule('strict');
      const rest = await REST_ENTITY({ b: 500 })();
      const mcp = await MCP_ENTITY({ b: 500 })();
      assert.equal(rest.refused, true, `REST wrote a record that breaks a strict rule: ${rest.text}`);
      assert.equal(mcp.refused, true, `save_entity wrote a record that breaks a strict rule: ${mcp.text}`);
      const restRows = violationRows(rest.body).filter(r => r.field === 'rules.below');
      const mcpRows = violationRows(mcp.body ?? mcp.text).filter(r => r.field === 'rules.below');
      assert.ok(restRows.length > 0, `REST does not name rules.below: ${rest.text}`);
      assert.ok(mcpRows.length > 0, `save_entity does not name rules.below: ${mcp.text}`);
      assert.ok(restRows[0].reason.startsWith(BELOW), `the reason does not lead with the rule's message: ${restRows[0].reason}`);
      assert.equal(mcpRows[0].reason, restRows[0].reason, 'the two doors give different reasons for the same rule');
      assert.equal(await mongo.col(`${SPACE}_entities`).countDocuments({}), 0, 'a refused write stored a record');
    });

    it('strict: a record that satisfies the rule is written by both (the control)', async () => {
      await withRule('strict');
      for (const [door, run] of [['REST', REST_ENTITY({ b: 5 })], ['save_entity', MCP_ENTITY({ b: 5 })]]) {
        const a = await run();
        assert.equal(a.refused, false, `${door} refused a record that satisfies the rule: ${a.text}`);
      }
      assert.equal(await mongo.col(`${SPACE}_entities`).countDocuments({}), 2);
    });

    it('warn: both write the record and report the break', async () => {
      await withRule('warn');
      for (const [door, run] of [['REST', REST_ENTITY({ b: 500 })], ['save_entity', MCP_ENTITY({ b: 500 })]]) {
        const a = await run();
        assert.equal(a.refused, false, `${door} refused under warn: ${a.text}`);
        assert.ok(violationRows(a.body ?? a.text).some(r => r.field === 'rules.below') || /rules\.below/.test(a.text), `${door} did not report the break: ${a.text}`);
      }
      assert.equal(await mongo.col(`${SPACE}_entities`).countDocuments({}), 2);
    });

    it('off: neither door evaluates the rule', async () => {
      // The counter is the proof the engine was not run (a record that is merely not refused proves nothing: nothing evaluates a
      // rule at all on the base), and strict moving it is the control that says the counter counts.
      const { ruleEvaluationCount } = await import('../../server/dist/spaces/schema-rules.js');
      await withRule('strict');
      const strictFrom = ruleEvaluationCount();
      await REST_ENTITY({ b: 500 })();
      assert.ok(ruleEvaluationCount() > strictFrom, 'the control: a strict write did not move the evaluation counter');
      await withRule('off');
      const from = ruleEvaluationCount();
      for (const [door, run] of [['REST', REST_ENTITY({ b: 500 })], ['save_entity', MCP_ENTITY({ b: 500 })]]) {
        const a = await run();
        assert.equal(a.refused, false, `${door} refused in a space whose validation is off: ${a.text}`);
        assert.doesNotMatch(a.text, /rules\.below/, `${door} reported a rule in a space whose validation is off`);
      }
      assert.equal(ruleEvaluationCount(), from, 'a rule was evaluated in a space whose validation is off');
    });
  });
});
