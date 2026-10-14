/**
 * Rules and the live check live in all five places a capability lives, and each says the same thing (F-46; CLAUDE.md "The five
 * places a capability lives — all of them, same commit").
 *
 * ## The five, for this capability
 *
 * | place | rules (`meta.rules`, `typeSchemas.*.*.rules`) | the live check (`sample`, `schema_validate`) |
 * |---|---|---|
 * | REST route | `PATCH /api/spaces/:id`, `PUT .../schema`, single-type `PUT` (bodies, `cel-rules-on-both-doors-db`) | `POST .../validate-schema` |
 * | MCP tool | `schema_update` and `save_space` carry `rules` | `schema_validate`, new |
 * | integration guide | `06a-schema-api.md` | `06a-schema-api.md`, `16-mcp.md` |
 * | user guide | `04-settings.md` (Schema tab), `03-files-and-schemas.md` (Validate) | the same page |
 * | token rights | `SPACE_FIELD_RIGHTS['meta.rules']`: schema admin | `TOOL_RIGHTS.schema_validate`, an audit entry |
 *
 * The first two are held by `cel-rules-on-both-doors-db` and `schema-validate-answers-alike-on-both-doors-db`, which drive them.
 * This file holds what a behaviour test cannot see: that the tool EXISTS under the name the plan gives it and takes what the route
 * takes, that the description a caller reads while building arguments states the limits and the guarantee, that the rights row is
 * the one the owner's ruling names, and that the two pages an operator and an integrator would open say the capability is there.
 *
 * ## What the descriptions must say, and what they must not
 *
 * An MCP schema description is read WHILE arguments are being built, and a stale sentence in it is the failure CLAUDE.md names. For
 * a rule that is the GUARANTEE and the LIMITS, in the caller's terms:
 *
 * - the limits that refuse a rule at save: the rule text (1000 characters), the message (300), the rules per type (50) and per
 *   space (50);
 * - that `meta.rules` is REPLACED whole and a type's rules go with the type, so a rule is deleted by sending the map without it;
 * - that a rule that cannot be applied is refused when the schema is saved, naming the rule.
 *
 * It does not say HOW a rule is evaluated (the engine, the cost model): a sentence about the mechanism has to be revisited
 * every time the mechanism gains a case, and nobody does.
 *
 * ## Why this is red on the base
 *
 * None of it exists: `schema_update` has no `rules`, `schema_validate` is not a tool, `SPACE_FIELD_RIGHTS` has no `meta.rules`
 * row, and neither guide has a page for either.
 *
 * Run: node --test testing/standalone/a-rule-capability-lives-in-all-five-places.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');
const { SPACE_FIELD_RIGHTS } = await import('../../server/dist/auth/space-field-rights.js');
const { TOOL_RIGHTS, ROUTE_RIGHTS } = await import('../../server/dist/auth/space-rights.js');
const { MCP_TOOL_OPERATIONS } = await import('../../server/dist/mcp/audit-map.js');
const { SpaceMetaBody } = await import('../../server/dist/spaces/body-schemas.js');

const schemas = { requiredSpace: { type: 'string' }, optionalSpace: { type: 'string' }, spaceList: { type: 'array', items: { type: 'string' } } };
const toolNamed = (name) => ALL_TOOLS.find(t => t.name === name);
const propsOf = (name) => toolNamed(name)?.inputSchema(schemas).properties ?? {};
const doc = (file) => readFileSync(file, 'utf8');
const spell = (r) => (typeof r === 'string' ? r : `${r.area}:${r.needs}`);

describe('the MCP door: `schema_update` and `save_space` carry rules, and say what a caller needs to build them', () => {
  const desc = () => JSON.stringify(propsOf('schema_update')['rules'] ?? {}) + (toolNamed('schema_update')?.description ?? '');

  it('`schema_update` declares `rules`, an object, as the REST body does', () => {
    const rules = propsOf('schema_update')['rules'];
    assert.ok(rules, 'schema_update has no `rules`: a caller of the tool cannot write what a caller of PATCH can');
    assert.equal(rules.type, 'object', '`rules` is not declared as an object');
  });

  it('its description states the limits at which a rule is refused: 1000 characters, 300 for the message, 50 per type and per space', () => {
    const text = desc();
    for (const [limit, what] of [['1000', 'the rule text'], ['300', 'the message'], ['50', 'rules per type and per space']]) {
      assert.match(text, new RegExp(`\\b${limit}\\b`), `the description does not state the limit of ${what} (${limit}): a caller finds it by being refused`);
    }
  });

  it('it says a rule is replaced with its owner and is deleted by leaving it out, and that an unusable rule is refused when saved', () => {
    const text = desc();
    assert.match(text, /replace/i, 'the description does not say rules are replaced');
    assert.match(text, /whole|wholly|entire|as a unit|with the type/i, 'the description does not say what is replaced (the whole map, the type with its rules)');
    assert.match(text, /refus/i, 'the description does not say a rule that cannot be applied is refused');
  });

  it('it states the guarantee and not the mechanism: no engine name, no cost model', () => {
    assert.match(desc(), /\brules?\b/i, 'there is no description of rules to hold: a description that says nothing names no mechanism either');
    assert.doesNotMatch(desc(), /@bufbuild|RE2|cel-js|AST|synthetic|comprehension nesting/i,
      'the description names a mechanism: it has to be revisited every time the mechanism gains a case');
  });

  it('`typeSchemas` lists `rules` among the fields a type carries, so the complete list the description points at is complete', () => {
    assert.match(String(propsOf('schema_update')['typeSchemas']?.description ?? ''), /\brules\b/, 'the typeSchemas description does not name `rules` among the type fields');
  });

  it('`save_space`\'s `meta` description names rules among what it accepts', () => {
    assert.match(String(propsOf('save_space')['meta']?.description ?? ''), /\brules\b/, 'save_space cannot be told it creates a space with rules');
  });

  it('the help text for schemas tells an agent rules exist and where they are written', () => {
    const help = stripComments(readFileSync('server/src/mcp/tools/help-sections.ts', 'utf8'));
    const guide = help.slice(help.indexOf('const SCHEMA_GUIDE'), help.indexOf('`;', help.indexOf('const SCHEMA_GUIDE')));
    assert.ok(guide.length > 200, 're-anchor: SCHEMA_GUIDE was not found');
    assert.match(guide, /\brules\b/, 'help()\'s schema section does not mention rules');
    assert.match(guide, /schema_validate/, 'help()\'s schema section does not point at the live check');
  });
});

describe('the live check is a tool too, and takes what the route takes', () => {
  it('`schema_validate` is registered', () => {
    assert.ok(toolNamed('schema_validate'), 'there is no schema_validate tool: the live check is REST-only, the defect this repository pays for most');
  });

  it('it takes the route\'s parameters under the route\'s names: the proposed meta, a sample, the page', () => {
    const props = propsOf('schema_validate');
    for (const name of ['space', 'meta', 'sample', 'limit']) {
      assert.ok(props[name], `schema_validate has no \`${name}\`; POST validate-schema takes it`);
    }
    assert.equal(props['sample']?.type, 'object', '`sample` is not an object (`{ kind, record }`)');
  });

  it('it does not mutate, so a read-only token may use it', () => {
    assert.equal(toolNamed('schema_validate')?.mutating, false, 'a dry run is declared mutating');
  });

  it('it has an audit entry: a stored-data check with the caller\'s rules is a read of the space\'s data and is audited as one', () => {
    assert.ok('schema_validate' in MCP_TOOL_OPERATIONS, 'schema_validate has no entry in the MCP audit map');
  });

  it('the REST route\'s body schema is documented with `sample` beside `meta`', () => {
    assert.match(doc('docs/integration-guide/06a-schema-api.md'), /\bsample\b/, '06a-schema-api.md does not document `sample`');
  });
});

describe('token rights: rules are schema admin, and the live check reads the schema', () => {
  it('`meta.rules` is a row of the settings table, and its rung is the one the owner named for it: schema admin', () => {
    assert.ok('rules' in SpaceMetaBody.shape, 'SpaceMetaBody does not accept `rules`: the row below would be a stale one');
    assert.equal(spell(SPACE_FIELD_RIGHTS['meta.rules'] ?? 'none'), 'schema:admin',
      'meta.rules is not schema:admin, the rung of validationMode, the other setting that changes what writes are refused');
  });

  it('the live check is `schema: read` on both doors, and the rows agree', () => {
    const route = ROUTE_RIGHTS.find(r => r.route === '/api/spaces/:id/validate-schema' && r.method === 'POST');
    const tool = TOOL_RIGHTS.find(r => r.tool === 'schema_validate');
    assert.ok(route, 'the validate-schema route lost its rights row');
    assert.ok(tool, 'schema_validate has no TOOL_RIGHTS row: it would be allowed and only partly governed, and every call would log a warning naming it');
    assert.deepEqual([tool.area, tool.needs], [route.area, route.needs], 'the two doors ask different rungs for the same check');
    assert.deepEqual([route.area, route.needs], ['schema', 'read']);
  });
});

describe('the two pages an integrator and an operator would open', () => {
  it('06a-schema-api.md documents the `rules` field of a type and of the space, and the limits', () => {
    const text = doc('docs/integration-guide/06a-schema-api.md');
    assert.match(text, /`rules`/, 'the schema API page does not document `rules`');
    assert.match(text, /1,?000 (characters|chars)/i, '06a-schema-api.md does not state the rule-text limit (1000 characters)');
    // One sentence or line that names both: a sentence is the unit the claim is made in, so the window is the sentence.
    const sentences = text.split(/[.\n]/);
    assert.ok(sentences.some(s => /message/i.test(s) && /\b300\b/.test(s)), '06a-schema-api.md does not state the message limit (300)');
    assert.match(text, /\b50 rules\b|\b50 per\b|\bat most 50\b|\bup to 50\b/i, '06a-schema-api.md does not state the count limit (50 per type and per space)');
  });

  it('16-mcp.md documents `schema_validate`', () => {
    assert.match(doc('docs/integration-guide/16-mcp.md'), /schema_validate/, 'the MCP page does not list the live-check tool');
  });

  it('07-tokens-api.md lists the rung of `schema_validate` and of the settings that need schema admin', () => {
    assert.match(doc('docs/integration-guide/07-tokens-api.md'), /schema_validate/, 'the tokens page does not say what the live-check tool needs');
  });

  it('the user guide\'s settings page tells an operator rules exist and where to write them', () => {
    const text = doc('docs/userguide/04-settings.md');
    assert.match(text, /\brules?\b[^.\n]*\b(CEL|expression)\b|\b(CEL|expression)\b[^.\n]*\brules?\b/i, 'the settings page does not describe a schema rule');
  });
});
