/**
 * The two MCP tools that write space settings take the same keys as the bodies they stand for (Q-320, bundle-128, design-v3
 * section 8.2 G8, and N3).
 *
 * ## Two parity gates, one file
 *
 *  - **(i) `schema_update` against `SpaceMetaBody`.** The tool's declared properties are the meta body's keys, plus the two
 *    top-level `UpdateSpaceBody` keys it also forwards (`typeSchemasMode`, `targetNetwork`), minus a reasoned `NOT_META` list
 *    (EMPTY today, and it may only be added to with a reason). P16 found that nothing compared them: a new meta key reached REST
 *    and not the tool, which is the parity defect `CLAUDE.md` names. It holds today (this half is a guard against the next key,
 *    and is NOT red on the unchanged base; its comparison is shown to fail by a control).
 *  - **(ii) `update_space` against `UpdateSpaceBody`.** Every key of the body is declared by the tool, or settable by nobody
 *    (derived from `SPACE_FIELD_RIGHTS`' `'nobody'` rows, `completeLinkage`), or in `EXEMPT` with a reason. The existing gaps
 *    (`maxGiB`, `recordTtlDays`, the `dupeRules` family, the five media levels) are named exemptions that point at Q-500, which
 *    closes them; N3 ruled that THIS bundle adds only `unknownWriteFields`, so the new key is NOT exempt: the body must take it and
 *    the tool must declare it. That is the half that is red on the unchanged base.
 *
 * The rights difference is pinned as a reasoned row rather than left as folklore: REST charges `unknownWriteFields` at
 * `schema:admin` (`SPACE_FIELD_RIGHTS`), and `update_space` is `spaceAdmin` for every key it takes, which is stricter and
 * pre-existing.
 *
 * Run: node --test testing/standalone/a-settings-tool-and-its-body-schema-take-the-same-keys.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const bodySchemas = await import('../../server/dist/spaces/body-schemas.js');
const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');

const shapeKeys = (schema) => Object.keys(schema?.shape ?? schema?._def?.schema?.shape ?? {});
const declared = (name) => Object.keys(ALL_TOOLS.find(t => t.name === name)?.inputSchema({}).properties ?? {});

/** Top-level `UpdateSpaceBody` keys that `schema_update` also forwards, beside the meta. */
const SCHEMA_UPDATE_TAKES_TOP_LEVEL = new Map([
  ['typeSchemasMode', 'a top-level body key in the schema area, and the one a `replace` of the type map needs'],
  ['targetNetwork', 'a top-level body key in the networks area: sending a definition to a network'],
]);
/** `SpaceMetaBody` keys `schema_update` does not take. EMPTY, and an entry needs its reason. */
const NOT_META = new Map();

/** Keys `update_space` declares that are not top-level body keys. */
const UPDATE_SPACE_EXTRA = new Map([['space', 'the addressing argument, a path segment on REST'], ['purpose', 'the body\'s `meta.purpose`']]);

/**
 * Body keys `update_space` does not declare, each with the reason it is allowed to be absent. `maxGiB` and the instance-local
 * settings are the existing gaps Q-500 closes; the rest are other tools' keys.
 */
const EXEMPT = new Map([
  ['meta', 'the container of the meta settings, which `schema_update` writes'],
  ['typeSchemasMode', '`schema_update` takes it (see SCHEMA_UPDATE_TAKES_TOP_LEVEL)'],
  ['targetNetwork', '`schema_update` takes it (see SCHEMA_UPDATE_TAKES_TOP_LEVEL)'],
  ...['maxGiB', 'recordTtlDays', 'dupeRules', 'dupeMergeSurvivor', 'dupeRulesOnInsert',
    'documentExtraction', 'imageAnalysis', 'audioAnalysis', 'videoAnalysis', 'textAnalysis']
    .map(k => [k, 'an instance-local setting `update_space` does not take yet: Q-500 closes this gap']),
]);

/** What `schema_update` lacks and what it has beyond the meta body — the comparison, as a function so a control can break it. */
function metaParity(toolKeys, metaKeys) {
  const want = new Set([...metaKeys.filter(k => !NOT_META.has(k)), ...SCHEMA_UPDATE_TAKES_TOP_LEVEL.keys()]);
  const have = new Set(toolKeys.filter(k => k !== 'space'));
  return {
    toolLacks: [...want].filter(k => !have.has(k)).sort(),
    toolHasBeyond: [...have].filter(k => !want.has(k)).sort(),
  };
}

describe('(i) schema_update takes the keys of the meta body', () => {
  it('the two agree today, over a derived set with a floor', () => {
    const meta = shapeKeys(bodySchemas.SpaceMetaBody);
    assert.ok(meta.length >= 8, `only ${meta.length} SpaceMetaBody keys were read`);
    assert.deepEqual(metaParity(declared('schema_update'), meta), { toolLacks: [], toolHasBeyond: [] });
  });

  it('control: a key the body gained and the tool did not is found, and so is one the tool took with no body behind it', () => {
    const meta = shapeKeys(bodySchemas.SpaceMetaBody);
    assert.deepEqual(metaParity(declared('schema_update'), [...meta, 'aNewMetaKey']).toolLacks, ['aNewMetaKey']);
    assert.deepEqual(metaParity([...declared('schema_update'), 'invented'], meta).toolHasBeyond, ['invented']);
  });
});

describe('(ii) update_space takes the instance-local settings of the update body', () => {
  const bodyKeys = shapeKeys(bodySchemas.UpdateSpaceBody);
  const toolKeys = declared('update_space');

  it('reads both sides, with a floor', () => {
    assert.ok(bodyKeys.length >= 14, `only ${bodyKeys.length} UpdateSpaceBody keys were read`);
    assert.ok(toolKeys.length >= 3, 'update_space declares almost nothing');
  });

  it('every body key is declared, settable by nobody, or exempt with a reason', () => {
    const nobody = new Set(Object.entries(SPACE_FIELD_RIGHTS).filter(([, v]) => v === 'nobody').map(([k]) => k));
    assert.ok(nobody.size >= 1, 'the table has no `nobody` row — the derivation is wrong, not the code');
    const gaps = bodyKeys.filter(k => !toolKeys.includes(k) && !nobody.has(k) && !EXEMPT.has(k));
    assert.deepEqual(gaps, [], 'update_space does not take these body keys and nothing says why: add the argument or a reasoned EXEMPT row');
  });

  it('the setting this bundle adds is NOT exempt: the body takes unknownWriteFields and update_space declares it (N3)', () => {
    assert.ok(bodyKeys.includes('unknownWriteFields'), 'UpdateSpaceBody does not take `unknownWriteFields`, so PATCH /api/spaces/:id cannot set it');
    assert.ok(toolKeys.includes('unknownWriteFields'), 'update_space does not declare `unknownWriteFields`, so the MCP door cannot set it');
  });

  it('every exemption still names a real gap (a closed gap must leave the list)', () => {
    const stale = [...EXEMPT.keys()].filter(k => !bodyKeys.includes(k) || toolKeys.includes(k));
    assert.deepEqual(stale, [], 'these exemptions no longer describe a gap: delete their rows');
  });

  it('update_space declares nothing the body does not have (beyond its two reasoned extras)', () => {
    assert.deepEqual(toolKeys.filter(k => !bodyKeys.includes(k) && !UPDATE_SPACE_EXTRA.has(k)), []);
  });

  it('the rights difference is the pinned one: REST charges schema:admin, update_space is spaceAdmin for every key', () => {
    assert.deepEqual(SPACE_FIELD_RIGHTS['unknownWriteFields'], { area: 'schema', needs: 'admin' },
      'unknownWriteFields has no top-level SPACE_FIELD_RIGHTS row at schema:admin (design-v3 1)');
    assert.equal(ALL_TOOLS.find(t => t.name === 'update_space')?.spaceAdmin, true);
  });
});