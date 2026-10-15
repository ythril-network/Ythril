/**
 * A sample check runs only rules its caller could save (b23 wave 7, finding S2) — on both doors, `POST /api/spaces/:id/validate-schema`
 * and MCP `schema_validate`.
 *
 * ## What it prevents
 *
 * A sample check evaluates a PROPOSED meta and needs only `schema: read`. Measured, the heaviest rule set the save-time price accepts
 * takes about half a second to evaluate on one record at the input caps, synchronously on the event loop, and the sample check is not
 * on the heavy-call rail — so a read-only token could keep the server blocked for most of every minute. Saving a rule needs
 * `schema: admin` (`SPACE_FIELD_RIGHTS['meta.rules']`, a type's rules priced the same by `typeRuleEditsIn`). The rule: a caller may RUN
 * only rules it could SAVE. Sampling the stored rules — or a proposed meta whose rules equal the stored ones, which is what the UI
 * always sends (the whole staged meta) — stays open to a reader.
 *
 * ## What is held, each on BOTH doors
 *
 * 1. a `schema: read` token sampling a proposed meta with a NEW type rule is refused (403), the sentence naming the type's rules field;
 * 2. the same with a changed `meta.rules`, and with both at once (each field is named);
 * 3. the same token sampling the STORED meta, and a proposed meta whose rules equal the stored ones but whose other parts differ, is
 *    answered, and so is one whose rules are those of this instance's own definitions when a network layer adds more to the stored ones;
 * 4. a `schema: admin` token (and an instance administrator) with new rules is answered; a `schema: write` token is refused, because
 *    the rights table says admin and the door does not word a rung of its own;
 * 5. the two doors refuse in the same words.
 *
 * Run: node --test testing/standalone/a-sample-check-runs-only-rules-its-caller-could-save.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import {
  scratchEnv, response, rightsAt, adminRights, routeOf, requestOf, callMcp, resetConfig, violationRows,
} from './_cel-doors.mjs';

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

async function viaRest(rights, space, body) {
  const res = response();
  try { await restValidate.at(-1)(requestOf({ params: { id: space }, body, rights }), res, () => {}); }
  catch (err) { res.status(err?.status ?? 500).json({ error: String(err?.message ?? err) }); }
  return { status: res.statusCode, refused: res.statusCode >= 400, body: res.body, error: res.body?.error, text: JSON.stringify(res.body ?? '') };
}
async function viaMcp(rights, space, body) {
  const o = await callMcp('schema_validate', { space, ...body }, rights);
  return { status: o.status, refused: o.isError, body: o.structured ?? safeJson(o.text), error: o.text.replace(/^Error:\s*/, ''), text: o.text };
}
const DOORS = { 'POST /api/spaces/:id/validate-schema': viaRest, 'schema_validate': viaMcp };

describe('a sample check runs only rules its caller could save', () => {
  let reader, writer, admin, instanceAdmin;

  before(async () => {
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
  after(() => scratch.cleanup());

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
});
