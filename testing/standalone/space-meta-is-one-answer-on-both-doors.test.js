/**
 * The space meta is assembled by ONE function, and both doors call it (`Q-95`, `Q-168`).
 *
 * ## How this was found
 *
 * `GET /api/spaces/:id/meta` and MCP `space_meta` each assembled the whole answer by hand — the meta, five counts
 * per member, `needsReindex`, the actual schema per member, the proxy shape — which is the shape this repo pays
 * for most: one rule, two implementations, and the day they differ is invisible from either door. They had
 * already drifted on one parameter: REST took `?resolve=1` (library `$ref` types expanded, default raw) and MCP
 * had no `resolve` at all and always expanded, so an agent could not see the stored `$ref` and a REST caller and
 * an agent describing "the same meta" were describing different documents (`Q-168`).
 *
 * ## What is held
 *
 *   1. Both door handlers call `spaceMetaAnswer`, and neither counts or builds the actual schema itself.
 *   2. The actual schema is built in exactly one module — derived over every tracked server source, so a third
 *      door written next year is held to it too.
 *   3. `resolve` exists on both doors, and each door's default comes from `META_RESOLVE_DEFAULT` — the one place
 *      the two defaults are written — and each door's description says what its default is.
 *
 * Run: node --test testing/standalone/space-meta-is-one-answer-on-both-doors.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { readTrackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

const restSrc = stripComments(readFileSync('server/src/api/spaces.ts', 'utf8'));
const mcpSrc = stripComments(readFileSync('server/src/mcp/tools/spaces.ts', 'utf8'));

/** The REST meta handler: from its registration to the next route registration. */
const restHandler = () => {
  const i = restSrc.indexOf("spacesRouter.get('/:id/meta',");
  assert.ok(i > -1, 'the REST meta route was not found');
  const j = restSrc.indexOf('spacesRouter.', i + 10);
  return restSrc.slice(i, j > -1 ? j : undefined);
};
/** The MCP handler: from the tool's declaration to the next exported tool. */
const mcpHandler = () => {
  const i = mcpSrc.indexOf('export const space_metaTool');
  assert.ok(i > -1, 'the space_meta tool was not found');
  const j = mcpSrc.indexOf('export const ', i + 10);
  return mcpSrc.slice(i, j > -1 ? j : undefined);
};

describe('both doors call the one function', () => {
  for (const [door, body] of [['REST', restHandler], ['MCP', mcpHandler]]) {
    it(`${door} calls spaceMetaAnswer and assembles nothing itself`, () => {
      const h = body();
      assert.match(h, /\bspaceMetaAnswer\(/, `${door} does not call spaceMetaAnswer`);
      assert.doesNotMatch(h, /countDocuments\(/, `${door} still counts the collections itself`);
      assert.doesNotMatch(h, /buildErModel|actualSchemaOf|spaceShapeOf/, `${door} still builds the actual schema itself`);
    });
  }
});

describe('the actual schema is built in one module', () => {
  it('nothing outside brain/space-shape.ts builds it', () => {
    const builders = readTrackedSources(['server/src'], { floor: 300, specs: false, untracked: true })
      .filter(f => !f.file.endsWith('.test.ts') && f.file !== 'server/src/brain/space-shape.ts' && f.file !== 'server/src/brain/er-model.ts')
      .filter(f => /\b(buildErModel|observeErShape|readErShape)\(/.test(stripComments(f.text)))
      .map(f => f.file);
    assert.deepEqual(builders, [], 'a second place builds what a space holds, past the cache');
  });
});

describe('resolve is one parameter with a stated default on each door', () => {
  let tool, META_RESOLVE_DEFAULT;
  before(async () => {
    ({ space_metaTool: tool } = await import('../../server/dist/mcp/tools/spaces.js'));
    ({ META_RESOLVE_DEFAULT } = await import('../../server/dist/spaces/space-meta-answer.js'));
  });

  it('the MCP tool declares resolve, a boolean', () => {
    const props = tool.inputSchema({ requiredSpace: { type: 'string' } }).properties ?? {};
    assert.equal(props.resolve?.type, 'boolean', 'space_meta has no `resolve` — REST has had `?resolve=` for years');
  });

  it('each door takes its default from META_RESOLVE_DEFAULT', () => {
    assert.equal(typeof META_RESOLVE_DEFAULT?.rest, 'boolean');
    assert.equal(typeof META_RESOLVE_DEFAULT?.mcp, 'boolean');
    assert.match(restHandler(), /META_RESOLVE_DEFAULT\.rest/, 'REST writes its own default');
    assert.match(mcpHandler(), /META_RESOLVE_DEFAULT\.mcp/, 'MCP writes its own default');
  });

  it('each door says what its default is', () => {
    const word = v => (v ? 'true' : 'false');
    const props = tool.inputSchema({ requiredSpace: { type: 'string' } }).properties;
    assert.match(props.resolve.description, new RegExp(`default ${word(META_RESOLVE_DEFAULT.mcp)}`, 'i'),
      'the MCP description does not state its default');
    assert.match(props.resolve.description, new RegExp(`REST[^.]*default[^.]*${word(META_RESOLVE_DEFAULT.rest)}`, 'i'),
      'the MCP description does not state that REST defaults the other way');
    const guide = readFileSync('docs/integration-guide/06-spaces-api.md', 'utf8');
    assert.match(guide, /`resolve`[^\n]*MCP[^\n]*default/i, 'the integration guide does not state both defaults');
  });
});
