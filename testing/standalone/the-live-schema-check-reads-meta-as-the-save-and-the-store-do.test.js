/**
 * The live schema check (`POST /validate-schema`, MCP `schema_validate`) reads a meta the way the rest of the server does: a PROPOSED one
 * as a save parses it, the STORED one as a store reads what it holds (F-46, Q-216, ruling R6-7).
 *
 * ## What it prevents
 *
 * `beginSchemaValidate` parsed both with `SpaceMetaBody.safeParse` itself:
 *
 * - **the stored meta whole and strict, answering `400`** — so a space whose stored meta carries a key from a newer build (the tolerant
 *   reader keeps the layer and names the key) could not be checked at all: the live check refused the space's own schema, which every
 *   write door reads without complaint (`readStoredMeta`);
 * - **the proposed meta past `parseSpaceMeta`** — the one parse a save runs, with its union-branch picker and its bound on the parts it
 *   names — so a meta the save refuses in one sentence was refused here in another.
 *
 * ## What is asserted
 *
 * A stored meta with a key this release does not know is checked (200, the rule in it applied). A proposed meta the save refuses is
 * refused with the save's own words (`parseSpaceMeta(...).message`).
 *
 * Run: node --test testing/standalone/the-live-schema-check-reads-meta-as-the-save-and-the-store-do.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { scratchEnv, resetConfig, adminRights } from './_cel-doors.mjs';

// Before anything imports the server: the loader reads CONFIG_PATH when it is first imported.
const scratch = scratchEnv('ythril-live-check-meta-');
after(() => scratch.cleanup());
const { rule, typeSchemasOf, REPO_DIST } = await import('./_cel-rules.mjs');

const { beginSchemaValidate } = await import(`${REPO_DIST}spaces/schema-validate-door.js`);
const { parseSpaceMeta } = await import(`${REPO_DIST}spaces/body-schemas.js`);

const SPACE = 'livecheck';
const BELOW = 'b must be below one hundred';
const RULED = { validationMode: 'strict', typeSchemas: typeSchemasOf('entity', 'thing', { below: rule('self.properties.b < 100.0', BELOW) }) };
const sampleOf = (b) => ({ sample: { kind: 'entity', record: { name: 'Acme', type: 'thing', properties: { b } } } });

async function check(storedMeta, body) {
  await resetConfig(scratch.configPath, { spaces: [{ id: SPACE, label: SPACE, builtIn: false, folders: [], meta: storedMeta }] });
  return beginSchemaValidate({ spaceId: SPACE, memberIds: [SPACE], body, rights: await adminRights(), callerKey: 'test' });
}

describe('the stored meta is read as a store reads what it holds', () => {
  it('a stored meta carrying a key from a newer build is checked, not refused', async () => {
    const out = await check({ ...RULED, aKeyFromANewerBuild: { anything: true } }, sampleOf(500));
    assert.equal(out.status, 200, `the live check refused the space's own stored meta: ${out.error}`);
    assert.deepEqual(out.answer.violations.flatMap(v => v.violations).map(r => r.field), ['rules.below'],
      'the rule in the stored meta was not applied');
  });

  it('the control: the same meta without the unknown key is checked alike', async () => {
    const out = await check(RULED, sampleOf(500));
    assert.equal(out.status, 200, out.error);
    assert.deepEqual(out.answer.violations.flatMap(v => v.violations).map(r => r.field), ['rules.below']);
  });
});

describe('a proposed meta is parsed as the save parses it', () => {
  const REFUSED = [
    ['a property schema of an unknown type', { typeSchemas: { entity: { thing: { propertySchemas: { a: { type: 'no-such-type' } } } } } }],
    // More failing parts than the save names: the save's sentence is bounded, and a sentence of every one is the second spelling.
    ['a dozen types each with a broken property', { typeSchemas: { entity: Object.fromEntries(Array.from({ length: 12 },
      (_, i) => [`t${i}`, { propertySchemas: { a: { type: 'no-such-type' } } }])) } }],
    ['a rule that reads a property the type does not declare',
      { typeSchemas: typeSchemasOf('entity', 'thing', { r: rule(`self.properties.undeclared == 'x'`) }) }],
    ['an unknown top-level key', { notAMetaKey: 1 }],
  ];
  for (const [what, proposed] of REFUSED) {
    it(`${what}: refused in the save's words`, async () => {
      const save = parseSpaceMeta(proposed);
      assert.equal(save.ok, false, `the fixture is not one the save refuses: ${what}`);
      const out = await check({}, { meta: proposed, ...sampleOf(1) });
      assert.equal(out.status, 400, `${what}: the live check accepted a meta the save refuses`);
      assert.equal(out.error, save.message, `${what}: the live check and the save refuse one meta in two sentences`);
    });
  }
});
