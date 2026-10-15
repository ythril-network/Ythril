/**
 * A check with a proposed meta runs only rules its caller could save (b23 wave 7, finding S2) — in BOTH modes (a sample, and the
 * stored-data walk), on both doors, `POST /api/spaces/:id/validate-schema` and MCP `schema_validate`.
 *
 * ## What it prevents
 *
 * A check evaluates a PROPOSED meta and needs only `schema: read`. Measured, the heaviest rule set the save-time price accepts
 * takes about half a second to evaluate on one record at the input caps, synchronously on the event loop. A sample is not on the
 * heavy-call rail; the stored-data walk runs the proposed rules over up to 10 000 records and yields only between pages — so a
 * read-only token could keep the server blocked for most of every minute. Saving a rule needs
 * `schema: admin` (`SPACE_FIELD_RIGHTS['meta.rules']`, a type's rules priced the same by `typeRuleEditsIn`). The rule: a caller may RUN
 * only rules it could SAVE. Checking with the stored rules — or a proposed meta whose rules equal the stored ones, which is what the
 * UI always sends (the whole staged meta) — stays open to a reader.
 *
 * ## What is held, each on BOTH doors (the numbered cases are samples; the stored-data mode is held by the second block)
 *
 * 1. a `schema: read` token sampling a proposed meta with a NEW type rule is refused (403), the sentence naming the type's rules field;
 * 2. the same with a changed `meta.rules`, and with both at once (each field is named);
 * 3. the same token sampling the STORED meta, and a proposed meta whose rules equal the stored ones but whose other parts differ, is
 *    answered, and so is one whose rules are those of this instance's own definitions when a network layer adds more to the stored ones;
 * 4. a `schema: admin` token (and an instance administrator) with new rules is answered; a `schema: write` token is refused, because
 *    the rights table says admin and the door does not word a rung of its own;
 * 5. the two doors refuse in the same words.
 *
 * The stored-data mode: a reader with a new rule is refused 403 with the same sentence, the stored rules and equal rules are answered,
 * an administrator is answered — and a refusal costs the caller NO heavy-call slot (the refusal comes before the rail).
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-check-with-a-proposed-meta-runs-only-rules-its-caller-could-save-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  scratchEnv, response, rightsAt, adminRights, routeOf, requestOf, callMcp, resetConfig, violationRows,
} from './_cel-doors.mjs';

const skip = await mongoSkipReason();
const scratch = scratchEnv('ythril-sample-rules-');
const { rule, typeSchemasOf, DECLARED } = await import('./_cel-rules.mjs');

const SPACE = 'samplerules';
const OTHER = 'otherrules';

const TYPE_RULE = rule('self.properties.b < 100.0', 'b must be below one hundred');
const SPACE_RULE = rule(`self.properties.a != 'forbidden'`, 'a must not be forbidden');
const NEW_TYPE_RULE = rule('self.properties.b > 0.0', 'b must be above zero');

/** The meta the space stores: one type rule and one space rule. */
const STORED = {
  validationMode: 'strict',
  typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE }),
  rules: { notForbidden: SPACE_RULE },
};
const sampleOf = (properties) => ({ sample: { kind: 'entity', record: { name: 'Typed by the caller', type: 'thing', description: '', tags: [], properties } } });
/** A record that breaks the stored type rule, and one that holds it. */
const BREAKS = sampleOf({ a: 'fine', b: 500 });
const HOLDS = sampleOf({ a: 'fine', b: 5 });

const safeJson = (t) => { try { return JSON.parse(t); } catch { return undefined; } };
let restValidate;

/** `key`: the token the heavy-call rail counts against; without it every call is a new token, so nothing is ever counted twice. */
async function viaRest(rights, space, body, key) {
  const res = response();
  const req = requestOf({ params: { id: space }, body, rights });
  if (key) req.authToken.id = key;
  try { await restValidate.at(-1)(req, res, () => {}); }
  catch (err) { res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }); }
  return { status: res.statusCode, refused: res.statusCode >= 400, body: res.body, error: res.body?.error, text: JSON.stringify(res.body ?? '') };
}
async function viaMcp(rights, space, body, key) {
  const o = key
    ? await mcpAs(key, 'schema_validate', { space, ...body }, rights)
    : await callMcp('schema_validate', { space, ...body }, rights);
  return { status: o.status, refused: o.isError, body: o.structured ?? safeJson(o.text), error: o.text.replace(/^Error:\s*/, ''), text: o.text };
}
/** `callMcp` as one named token (`_cel-doors.mjs` mints a new one per call). */
async function mcpAs(tokenId, name, args, rights) {
  const { callTool } = await import('../../server/dist/mcp/call-tool.js');
  const out = await callTool({ name, args, caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId, tokenLabel: tokenId } });
  return { status: out.status, isError: out.result?.isError === true, text: (out.result?.content ?? []).map(c => c.text ?? '').join('\n'), structured: out.result?.structuredContent };
}
const DOORS = { 'POST /api/spaces/:id/validate-schema': viaRest, 'schema_validate': viaMcp };

describe('a check with a proposed meta runs only rules its caller could save', { skip }, () => {
  let reader, writer, admin, instanceAdmin, mongo;

  before(async () => {
    mongo = await openTestMongo('samplerules');
    await resetConfig(scratch.configPath, { spaces: [
      { id: SPACE, label: 'Sample rules', folders: [], completeLinkage: true, meta: STORED },
      // A space whose network layer adds a rule to its own definitions: what the check stores (`meta`) holds both, what it OWNS one.
      { id: OTHER, label: 'Layered', folders: [], completeLinkage: true,
        meta: { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, layered: NEW_TYPE_RULE }) },
        ownMeta: { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE }) } },
    ] });
    const { spacesRouter } = await import('../../server/dist/api/spaces.js');
    restValidate = routeOf(spacesRouter, 'post', '/:id/validate-schema');
    reader = await rightsAt(SPACE, { schema: 'read' });
    writer = await rightsAt(SPACE, { schema: 'write' });
    admin = await rightsAt(SPACE, { schema: 'admin' });
    instanceAdmin = await adminRights();
  });
  after(async () => { await closeTestMongo(); scratch.cleanup(); });

  for (const [door, run] of Object.entries(DOORS)) {
    describe(door, () => {
      it('1: a reader sampling a proposed meta with a NEW type rule is refused, naming the type\'s rules field and what it needs', async () => {
        const proposed = { ...STORED, typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, above: NEW_TYPE_RULE }) };
        const a = await run(reader, SPACE, { meta: proposed, ...BREAKS });
        assert.equal(a.status, 403, `${door}: ${a.text.slice(0, 300)}`);
        assert.equal(a.refused, true);
        assert.ok(a.error.includes('meta.typeSchemas.entity.thing.rules (admin on schema)'), `${door}: the refusal does not name the field and its need: ${a.error}`);
        assert.ok(!a.error.includes('meta.rules (') && !a.error.includes('meta.typeSchemas (') , `${door}: it names a field that is not a rule edit: ${a.error}`);
        assert.deepEqual(violationRows(a.body), [], `${door}: a refused check still evaluated and answered rows`);
      });

      it('1b: a rule on a type the stored schema does not have is a new rule too', async () => {
        const proposed = { ...STORED, typeSchemas: { entity: { ...STORED.typeSchemas.entity, gadget: { propertySchemas: DECLARED, rules: { r: NEW_TYPE_RULE } } } } };
        const a = await run(reader, SPACE, { meta: proposed, ...HOLDS });
        assert.equal(a.status, 403, `${door}: ${a.text.slice(0, 300)}`);
        assert.ok(a.error.includes('meta.typeSchemas.entity.gadget.rules (admin on schema)'), a.error);
      });

      it('2: a reader sampling a proposed meta with a changed `meta.rules` is refused, naming it', async () => {
        const proposed = { ...STORED, rules: { notForbidden: rule(`self.properties.a != 'other'`, 'a must not be other') } };
        const a = await run(reader, SPACE, { meta: proposed, ...HOLDS });
        assert.equal(a.status, 403, `${door}: ${a.text.slice(0, 300)}`);
        assert.ok(a.error.includes('meta.rules (admin on schema)'), `${door}: ${a.error}`);
        assert.ok(!a.error.includes('meta.typeSchemas.'), `${door}: it names a type's rules, which this meta leaves as stored: ${a.error}`);
      });

      it('2b: a space rule added where the stored meta has none, and a rule removed, are changes; both fields are named at once', async () => {
        const both = { ...STORED, rules: { notForbidden: SPACE_RULE, another: NEW_TYPE_RULE },
          typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, above: NEW_TYPE_RULE }) };
        const a = await run(reader, SPACE, { meta: both, ...HOLDS });
        assert.equal(a.status, 403, `${door}: ${a.text.slice(0, 300)}`);
        assert.ok(a.error.includes('meta.rules (admin on schema)') && a.error.includes('meta.typeSchemas.entity.thing.rules (admin on schema)'),
          `${door}: the sentence does not name each rule field: ${a.error}`);
        const removed = { ...STORED, rules: undefined };
        const b = await run(reader, SPACE, { meta: removed, ...HOLDS });
        assert.equal(b.status, 403, `${door}: a changed rule set (a rule left out) was answered: ${b.text.slice(0, 300)}`);
      });

      it('3: the same reader sampling the STORED meta is answered with the stored rules\' rows', async () => {
        const a = await run(reader, SPACE, BREAKS);
        assert.equal(a.status, 200, `${door}: ${a.text.slice(0, 300)}`);
        assert.ok(violationRows(a.body).some(r => r.field === 'rules.below'), `${door}: no row for the stored type rule: ${a.text.slice(0, 300)}`);
        assert.deepEqual(violationRows((await run(reader, SPACE, HOLDS)).body), []);
      });

      it('3b: a proposed meta whose rules equal the stored ones, whatever else differs, is answered', async () => {
        // The UI sends the whole staged meta: the rules as stored (keys in another order), the rest edited.
        const staged = {
          validationMode: 'warn',
          purpose: 'edited in the panel',
          rules: { notForbidden: { message: SPACE_RULE.message, rule: SPACE_RULE.rule } },
          typeSchemas: { entity: { thing: { rules: { below: { message: TYPE_RULE.message, rule: TYPE_RULE.rule } }, propertySchemas: { ...DECLARED, extra: { type: 'string' } } } } },
        };
        const a = await run(reader, SPACE, { meta: staged, ...BREAKS });
        assert.equal(a.status, 200, `${door}: a reader was refused for rules it left as stored: ${a.text.slice(0, 300)}`);
        assert.ok(violationRows(a.body).some(r => r.field === 'rules.below'), `${door}: ${a.text.slice(0, 300)}`);
        // A type with no rules, added, edits no rule either.
        const withType = { ...STORED, typeSchemas: { entity: { ...STORED.typeSchemas.entity, plain: { propertySchemas: DECLARED } } } };
        const b = await run(reader, SPACE, { meta: withType, ...HOLDS });
        assert.equal(b.status, 200, `${door}: ${b.text.slice(0, 300)}`);
      });

      it('3c: the effective stored meta of a layered space is the stored rules too, not an edit of the own ones', async () => {
        const layeredReader = await rightsAt(OTHER, { schema: 'read' });
        const effective = { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, layered: NEW_TYPE_RULE }) };
        const a = await run(layeredReader, OTHER, { meta: effective, ...BREAKS });
        assert.equal(a.status, 200, `${door}: ${a.text.slice(0, 300)}`);
        // A rule that is neither the own definition's nor the effective one's is new.
        const novel = { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, layered: rule('self.properties.b > 1.0', 'novel') }) };
        const b = await run(layeredReader, OTHER, { meta: novel, ...BREAKS });
        assert.equal(b.status, 403, `${door}: ${b.text.slice(0, 300)}`);
      });

      it('4: a `schema: admin` token and an instance administrator are answered with new rules', async () => {
        const proposed = { ...STORED, rules: { notForbidden: SPACE_RULE, another: rule('self.properties.b != 7.0', 'b must not be seven') },
          typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, above: rule('self.properties.b > 10.0', 'b must be above ten') }) };
        for (const [who, rights] of [['schema admin', admin], ['instance administrator', instanceAdmin]]) {
          const a = await run(rights, SPACE, { meta: proposed, ...sampleOf({ a: 'fine', b: 7 }) });
          assert.equal(a.status, 200, `${door}: ${who}: ${a.text.slice(0, 300)}`);
          const fields = violationRows(a.body).map(r => r.field);
          assert.ok(fields.includes('rules.above') && fields.includes('meta.rules.another'), `${door}: ${who}: the new rules were not evaluated: ${fields.join(', ')}`);
        }
      });

      it('4b: a `schema: write` token is refused for a new rule: the rights table says admin', async () => {
        const proposed = { ...STORED, typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, above: NEW_TYPE_RULE }) };
        const a = await run(writer, SPACE, { meta: proposed, ...HOLDS });
        assert.equal(a.status, 403, `${door}: ${a.text.slice(0, 300)}`);
      });
    });
  }

  it('5: the two doors refuse in the same words', async () => {
    const proposed = { ...STORED, rules: { notForbidden: SPACE_RULE, another: NEW_TYPE_RULE },
      typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, above: NEW_TYPE_RULE }) };
    const rest = await viaRest(reader, SPACE, { meta: proposed, ...HOLDS });
    const mcp = await viaMcp(reader, SPACE, { meta: proposed, ...HOLDS });
    assert.equal(rest.status, 403);
    assert.equal(mcp.status, 403);
    assert.equal(mcp.error, rest.error, 'the doors word the refusal differently');
  });

  it('a meta the save would refuse is still refused first, in the save\'s words, whoever asks', async () => {
    const bad = { typeSchemas: { entity: { thing: { propertySchemas: { a: { type: 'no-such-type' } } } } } };
    const [r, m] = [await viaRest(reader, SPACE, { meta: bad, ...HOLDS }), await viaMcp(reader, SPACE, { meta: bad, ...HOLDS })];
    assert.equal(r.status, 400, r.text.slice(0, 300));
    assert.equal(m.status, 400, m.text.slice(0, 300));
  });

  describe('the stored-data mode runs only rules its caller could save either', () => {
    const NEW_TYPE = { ...STORED, typeSchemas: typeSchemasOf('entity', 'thing', { below: TYPE_RULE, above: rule('self.properties.b > 10.0', 'b must be above ten') }) };
    const NEW_SPACE = { ...STORED, rules: { notForbidden: rule(`self.properties.a != 'other'`, 'a must not be other') } };
    const entity = (i, properties) => ({
      _id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, spaceId: SPACE, name: `Seeded ${i}`, type: 'thing', description: '', tags: [],
      properties, seq: i, createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z', author: { instanceId: 'samplerules', instanceLabel: 'test' },
    });
    let serial = 0;
    const keyOf = (door) => `rail-${door}-${++serial}`;

    before(async () => {
      await mongo.col(`${SPACE}_entities`).deleteMany({});
      await mongo.col(`${SPACE}_entities`).insertMany([entity(1, { a: 'fine', b: 500 }), entity(2, { a: 'fine', b: 5 })]);
    });

    for (const [door, run] of Object.entries(DOORS)) {
      describe(door, () => {
        it('a reader with a NEW type rule, or a changed space rule, is refused 403 naming the field, and nothing is read', async () => {
          const t = await run(reader, SPACE, { meta: NEW_TYPE });
          assert.equal(t.status, 403, `${door}: ${t.text.slice(0, 300)}`);
          assert.ok(t.error.includes('meta.typeSchemas.entity.thing.rules (admin on schema)'), `${door}: ${t.error}`);
          assert.equal(t.body?.progress, undefined, `${door}: a refused check read the store`);
          const s2 = await run(reader, SPACE, { meta: NEW_SPACE });
          assert.equal(s2.status, 403, `${door}: ${s2.text.slice(0, 300)}`);
          assert.ok(s2.error.includes('meta.rules (admin on schema)'), `${door}: ${s2.error}`);
        });

        it('a reader with the stored rules, or a proposed meta carrying them unchanged, is answered with the stored rule\'s rows', async () => {
          const stored = await run(reader, SPACE, {});
          assert.equal(stored.status, 200, `${door}: ${stored.text.slice(0, 300)}`);
          assert.ok(violationRows(stored.body).some(r => r.field === 'rules.below'), `${door}: ${stored.text.slice(0, 300)}`);
          const equal = await run(reader, SPACE, { meta: { ...STORED, validationMode: 'warn', purpose: 'edited' } });
          assert.equal(equal.status, 200, `${door}: ${equal.text.slice(0, 300)}`);
          assert.ok(violationRows(equal.body).some(r => r.field === 'rules.below'), `${door}: ${equal.text.slice(0, 300)}`);
        });

        it('a schema administrator is answered with new rules', async () => {
          const a = await run(admin, SPACE, { meta: NEW_TYPE });
          assert.equal(a.status, 200, `${door}: ${a.text.slice(0, 300)}`);
          assert.ok(violationRows(a.body).some(r => r.field === 'rules.above'), `${door}: the new rule was not evaluated: ${a.text.slice(0, 300)}`);
        });

        it('a refusal costs no heavy-call slot: more refused calls than the rail allows, and the same token is still answered', async () => {
          const { HEAVY_CALLS_PER_WINDOW } = await import('../../server/dist/rate-limit/heavy-tool.js');
          const key = keyOf('refused');
          for (let i = 0; i < HEAVY_CALLS_PER_WINDOW + 3; i++) {
            const r = await run(reader, SPACE, { meta: NEW_TYPE }, key);
            assert.equal(r.status, 403, `${door}: call ${i}: ${r.text.slice(0, 200)}`);
          }
          const ok = await run(reader, SPACE, {}, key);
          assert.equal(ok.status, 200, `${door}: refusals were charged to the rail: ${ok.text.slice(0, 200)}`);
        });

        it('the control: answered stored-data checks ARE counted, so the case above says something', async () => {
          const { HEAVY_CALLS_PER_WINDOW } = await import('../../server/dist/rate-limit/heavy-tool.js');
          const key = keyOf('answered');
          for (let i = 0; i < HEAVY_CALLS_PER_WINDOW; i++) assert.equal((await run(reader, SPACE, {}, key)).status, 200);
          assert.equal((await run(reader, SPACE, {}, key)).status, 429, `${door}: the rail did not count answered runs`);
        });
      });
    }
  });
});
