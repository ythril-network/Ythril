/**
 * `convertRecords` is ONE parameter on `PATCH /api/spaces/:id` and MCP `schema_update`, and of no other schema door (`Q-745`, bundle-284
 * design 2.2).
 *
 * ## What it prevents
 *
 * A parameter one door takes and the other drops is the defect this repository pays for most (`schema_update` once declared `whenDuePasses`
 * and the handler dropped it before the write). `convertRecords` has four places that must agree: the body (`UpdateSpaceBody`), the tool's
 * input schema, the list of arguments the tool forwards as the BODY and not as `meta` (`NOT_META`: left out of it, the steps would be sent
 * into the space meta and refused as an unknown meta field, or worse, stored), and the rights table (`SPACE_FIELD_RIGHTS`: a field with no
 * row is refused by the guard, and one with the wrong row lets a `schema` writer start a rewrite of every record of a type). A fifth, the
 * `targetNetwork` refusal of every field but the meta, must let it through.
 *
 * ## What holds
 *
 * - the body takes `convertRecords` in the shape the schema package exports, strictly, and a body that names only it asks for something;
 * - the tool declares the same shape (the body's own JSON schema), and its description says the guarantee and its cost to the caller;
 * - `NOT_META` holds it, and the tool forwards it beside `meta`, not inside;
 * - its field row is `knowledge: admin`, the rung of the other whole-space rewrites, and an update carrying it is refused to a token without it;
 * - a `targetNetwork` proposal admits it;
 * - no other schema door takes it: not the schema PUT, the single-type PUT or the library.
 *
 * Run: node --test testing/standalone/convert-records-is-one-parameter-on-both-doors.test.js
 * (requires a prior server build)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { tempInstanceDir, bootInstance, removeInstanceDir } from './_vote-round-instance.mjs';
import { SELF } from './_vote-round-sites.mjs';
import { stripComments } from './_strip-comments.mjs';

const dir = tempInstanceDir('ythril-convert-param-');
const NET = '22222222-2222-4222-8222-222222222222';

// The zod the server's schemas were built with: `toJSONSchema` reads a schema's internals, so it is the same copy that reads them.
const { z } = createRequire(new URL('../../server/dist/spaces/body-schemas.js', import.meta.url))('zod');
const { UpdateSpaceBody, PutSchemaBody, SpaceMetaBody } = await import('../../server/dist/spaces/body-schemas.js');
const { SPACE_FIELD_RIGHTS, settingsFieldsIn, refusalsForSpaceUpdate } = await import('../../server/dist/auth/space-field-rights.js');
const { schema_updateTool } = await import('../../server/dist/mcp/tools/spaces.js');
const { CONVERSION_STEPS_MAX } = await import('../../schema/dist/internal.js');

const STEPS = { steps: [{ op: 'renameProperty', kind: 'entity', type: 'Person', from: 'fullName', to: 'name' }] };
const META = { purpose: 'people' };
const code = (file) => stripComments(readFileSync(new URL(`../../${file}`, import.meta.url), 'utf8'));
const toolSchema = () => schema_updateTool.inputSchema({ requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' } });

describe('the body takes convertRecords', () => {
  it('in the shape the schema package exports, beside meta', () => {
    const parsed = UpdateSpaceBody.parse({ meta: META, convertRecords: STEPS });
    assert.deepEqual(parsed.convertRecords, STEPS);
    assert.deepEqual(UpdateSpaceBody.parse({ meta: META, convertRecords: {} }).convertRecords, {});
  });

  it('strictly: an unknown key in it, a step that is not one, and more steps than the bound are refused', () => {
    assert.equal(UpdateSpaceBody.safeParse({ meta: META, convertRecords: { steps: [], extra: 1 } }).success, false);
    assert.equal(UpdateSpaceBody.safeParse({ meta: META, convertRecords: { steps: [{ op: 'dropEverything', kind: 'entity' }] } }).success, false);
    assert.equal(UpdateSpaceBody.safeParse({ meta: META, convertRecords: { steps: Array.from({ length: CONVERSION_STEPS_MAX + 1 }, () => STEPS.steps[0]) } }).success, false);
  });

  it('a body that names only convertRecords has asked for something (the planner says what is missing: a meta)', () => {
    assert.equal(UpdateSpaceBody.safeParse({ convertRecords: STEPS }).success, true,
      'refused as an empty request, so the caller is told to send "at least one of ..." and never that a meta is missing');
  });

  it('it is a top-level key and never a meta field', () => {
    assert.ok('convertRecords' in UpdateSpaceBody.shape, 'convertRecords is not a key of the body');
    assert.ok(!('convertRecords' in SpaceMetaBody.shape), 'convertRecords is a meta field, which would store it in the space');
  });
});

describe('the tool declares the same parameter', () => {
  /** The shape without its words: every `description` (the top one and a nested parameter's) and `$schema`, at any depth. */
  const strip = (node) => {
    if (Array.isArray(node)) return node.map(strip);
    if (node === null || typeof node !== 'object') return node;
    return Object.fromEntries(Object.entries(node).filter(([k]) => k !== 'description' && k !== '$schema').map(([k, v]) => [k, strip(v)]));
  };

  it('with the body\'s own shape', () => {
    const declared = toolSchema().properties.convertRecords;
    assert.ok(declared, 'schema_update does not declare convertRecords');
    assert.deepEqual(strip(declared), strip(z.toJSONSchema(UpdateSpaceBody.shape.convertRecords, { io: 'input' })));
  });

  it('whose description states the guarantee and its cost to the caller, in plain words', () => {
    const text = toolSchema().properties.convertRecords.description;
    assert.match(text, /every record/i, 'it does not say which records the run rewrites');
    assert.match(text, /whoever last wrote/i, 'it does not say that a record another member wrote is rewritten too');
    assert.match(text, /sync/i, 'it does not say that the run asks the peers for one sync first');
    assert.match(text, /cannot be reached/i, 'it does not say that a peer that cannot be reached is not waited for');
    assert.match(text, /already converted/i, 'it does not say that a copy another member converted is not rewritten here');
    assert.match(text, /later version wins/i, 'it does not say what happens when two members rewrite one record');
    assert.match(text, /needs `meta`|with `meta`|a schema change/i, 'it does not say that it goes with a schema change');
    assert.match(text, /bad_conversion_step/, 'it does not name the refusal a bad step answers');
    assert.match(text, /vote/i, 'it does not say how a networked space carries it');
    assert.ok(text.length < 2500, `the description is ${text.length} characters`);
  });

  it('and the tool does not offer it as a meta field: NOT_META holds it', () => {
    const src = code('server/src/mcp/tools/spaces.ts');
    const set = /const NOT_META = new Set\(\[([^\]]*)\]\)/.exec(src);
    assert.ok(set, 'NOT_META was not found: re-anchor this gate');
    assert.match(set[1], /'convertRecords'/, 'convertRecords is forwarded into the meta');
  });

  it('and the tool forwards it beside the meta, as targetNetwork is', () => {
    const src = code('server/src/mcp/tools/spaces.ts');
    assert.match(src, /body\['convertRecords'\]\s*=\s*a\['convertRecords'\]/, 'the handler drops convertRecords before the write');
  });
});

describe('the rights row', () => {
  it('is knowledge: admin, the rung of the other whole-space rewrites', () => {
    assert.deepEqual(SPACE_FIELD_RIGHTS['convertRecords'], { area: 'knowledge', needs: 'admin' });
    assert.deepEqual(SPACE_FIELD_RIGHTS['recordTtlDays'], SPACE_FIELD_RIGHTS['convertRecords'], 'priced differently from the other whole-space rewrite');
  });

  it('is asked of an update that carries it, and a token without it is refused', () => {
    assert.deepEqual(settingsFieldsIn({ meta: META, convertRecords: STEPS }), ['meta.purpose', 'convertRecords']);
    assert.deepEqual(refusalsForSpaceUpdate({ convertRecords: STEPS }, 'people', false, undefined), ['convertRecords']);
    assert.deepEqual(refusalsForSpaceUpdate({ convertRecords: STEPS }, 'people', true, undefined), []);
  });
});

describe('a targetNetwork proposal admits it', () => {
  before(async () => {
    await bootInstance(dir, {
      instanceId: SELF,
      spaces: [{ id: 'people', label: 'People', folders: [], meta: {} }],
      networks: [{
        id: NET, label: 'Net', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['people'], votingDeadlineHours: 24,
        createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
        members: [{ instanceId: 'aaaaaaaa-0000-4000-8000-0000000000a1', label: 'peer', url: 'https://peer.example', tokenHash: 'h', direction: 'both' }],
      }],
    });
  });
  after(() => { removeInstanceDir(dir); });

  it('which refuses every other field, and not this one', async () => {
    const { planSpaceMetaUpdate } = await import('../../server/dist/spaces/meta-update.js');
    const { getConfig } = await import('../../server/dist/config/loader.js');
    const space = getConfig().spaces.find(s => s.id === 'people');
    const ok = planSpaceMetaUpdate({ spaceId: 'people', space, body: { meta: META, targetNetwork: NET, convertRecords: {} }, ifMatch: undefined });
    assert.equal(ok.ok, true, JSON.stringify(ok));
    const refused = planSpaceMetaUpdate({ spaceId: 'people', space, body: { meta: META, targetNetwork: NET, label: 'x' }, ifMatch: undefined });
    assert.equal(refused.ok, false, 'the control field was admitted: the test cannot tell the refusal from its absence');
    assert.match(refused.refusal.body.error, /targetNetwork proposes that network's schema only/);
  });
});

describe('no other schema door takes it', () => {
  it('the schema PUT body is the type map and nothing else', () => {
    assert.equal(PutSchemaBody.safeParse({ typeSchemas: {}, convertRecords: STEPS }).success, false);
  });

  it('the schema PUT, the single-type PUT and DELETE, and the library routes never read convertRecords', () => {
    for (const file of ['server/src/api/schema-library.ts']) {
      assert.doesNotMatch(code(file), /convertRecords/, `${file} takes convertRecords: a door that converts nothing until Convert`);
    }
    const routes = code('server/src/api/spaces.ts');
    const patchAt = routes.indexOf("spacesRouter.patch('/:id'");
    const putAt = routes.indexOf("spacesRouter.put('/:id/schema'");
    assert.ok(patchAt >= 0 && putAt > patchAt, 're-anchor: the PATCH and the schema PUT were not found in this order');
    assert.doesNotMatch(routes.slice(putAt), /convertRecords/, 'a door after PATCH takes convertRecords');
  });
});
