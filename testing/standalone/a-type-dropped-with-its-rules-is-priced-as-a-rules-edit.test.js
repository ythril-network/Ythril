/**
 * Removing a type that carries rules is an edit of those rules, and is priced as one (F-46, ruling R6-12).
 *
 * ## What it prevents
 *
 * A rule at either level needs schema ADMIN (`meta.rules`); `meta.typeSchemas` alone is the schema WRITE rung, so the rights check prices
 * every type whose rules a body changes as a rules edit (`typeRuleEditsIn`). It found those types by walking the BODY's types — and under
 * `typeSchemasMode: 'replace'` a type is removed by leaving it OUT of the body. A schema writer could delete every rule of a space by
 * replacing its types with a map that did not name the ruled ones: the walk never met them.
 *
 * It also derived the base the write is merged over for itself, a second copy of the planner's (`planSpaceMetaUpdate`); the two now ask
 * one function, so the rights check prices the edit against the definitions the store will merge it over.
 *
 * ## What is asserted
 *
 * Through `refusalsForSpaceUpdate`, with a token holding schema write and nothing above it: a replace that drops a ruled type is refused
 * for that type's rules; a replace that drops an unruled type, or keeps the ruled one as it is, is not; a merge that leaves the ruled
 * type unnamed is not; a merge that changes a rule is (the control).
 *
 * Run: node --test testing/standalone/a-type-dropped-with-its-rules-is-priced-as-a-rules-edit.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratchEnv, resetConfig, rightsAt } from './_cel-doors.mjs';

// Before anything imports the server: the loader reads CONFIG_PATH when it is first imported.
const scratch = scratchEnv('ythril-type-rules-priced-');
after(() => scratch.cleanup());
const { rule, DECLARED, REPO_DIST } = await import('./_cel-rules.mjs');
const { refusalsForSpaceUpdate } = await import(`${REPO_DIST}auth/space-field-rights.js`);

const SPACE = 'ruledtypes';
const RULES = { below: rule('self.properties.b < 100.0', 'b must be below one hundred') };
const RULED = { propertySchemas: DECLARED, rules: RULES };
const PLAIN = { propertySchemas: DECLARED };
const STORED = { validationMode: 'strict', typeSchemas: { entity: { ruled: RULED, plain: PLAIN } } };
const RULE_FIELD = 'meta.typeSchemas.entity.ruled.rules';

let writer;
before(async () => {
  await resetConfig(scratch.configPath, { spaces: [{ id: SPACE, label: SPACE, builtIn: false, folders: [], meta: STORED }] });
  writer = await rightsAt(SPACE, { schema: 'write' });
});
const refusals = (body) => refusalsForSpaceUpdate(body, SPACE, false, writer);

describe('a schema writer may not remove a rule by removing its type', () => {
  it('a replace that leaves the ruled type out is a rules edit, refused below schema admin', () => {
    assert.ok(refusals({ meta: { typeSchemas: { entity: { plain: PLAIN } } }, typeSchemasMode: 'replace' }).includes(RULE_FIELD),
      'a replace dropped a type together with its rules and was priced as a plain type edit');
  });

  it('a replace that clears every type is a rules edit too', () => {
    assert.ok(refusals({ meta: { typeSchemas: {} }, typeSchemasMode: 'replace' }).includes(RULE_FIELD));
  });

  it('a replace that drops only an unruled type, keeping the ruled one as stored, is not', () => {
    assert.deepEqual(refusals({ meta: { typeSchemas: { entity: { ruled: RULED } } }, typeSchemasMode: 'replace' }), []);
  });

  it('a merge that does not name the ruled type leaves its rules alone', () => {
    assert.deepEqual(refusals({ meta: { typeSchemas: { entity: { plain: { propertySchemas: { a: { type: 'string' } } } } } } }), []);
  });

  it('the control: a merge that changes the rule is a rules edit', () => {
    const changed = { propertySchemas: DECLARED, rules: { below: rule('self.properties.b < 50.0', 'b must be below fifty') } };
    assert.deepEqual(refusals({ meta: { typeSchemas: { entity: { ruled: changed } } } }), [RULE_FIELD]);
  });
});
