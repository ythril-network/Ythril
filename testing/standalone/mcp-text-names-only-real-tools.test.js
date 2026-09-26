/**
 * Everything an MCP client reads as reference names only tools and parameters that exist.
 *
 * Found by the Q-45 cleanup audit, 2026-09-24: the server instructions — the first text a connecting agent
 * reads — named `list_chrono`, `find_similar`, `list_peers` and `sync_now`, and the help text named
 * `find_entities_by_name`, `get_space_meta` and a `query` tool, months after all of them were renamed or
 * folded away. A stale tool name costs the caller a failed call, and nothing on the server side notices.
 *
 * Derived, not listed: the texts are rendered from the live modules, and every snake_case word in them must
 * be a tool name or a parameter some tool's schema declares. A list of RETIRED names would pass the next
 * rename that nobody adds to it.
 *
 * Run: node --test testing/standalone/mcp-text-names-only-real-tools.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let tools, schemas, helpSections, spaceScopeSentence;
before(async () => {
  ({ ALL_TOOLS: tools } = await import('../../server/dist/mcp/tools/index.js'));
  const { toolSchemasFor } = await import('../../server/dist/mcp/tool-schema.js');
  schemas = toolSchemasFor(['general']);
  ({ helpSections } = await import('../../server/dist/mcp/tools/help-sections.js'));
  ({ spaceScopeSentence } = await import('../../server/dist/mcp/space-scope-sentence.js'));
});

/** Tool names, and every property name any tool's input schema declares, at any depth. */
function vocabulary() {
  const words = new Set([...tools.map(t => t.name), ...DATA_VALUES.keys()]);
  const walk = (o) => {
    if (!o || typeof o !== 'object') return;
    if (o.properties && typeof o.properties === 'object') for (const k of Object.keys(o.properties)) words.add(k);
    for (const v of Object.values(o)) walk(v);
  };
  for (const t of tools) walk(t.inputSchema(schemas));
  return words;
}

/**
 * DATA that happens to be snake_case, never a tool or a parameter. Each is named in a description as an
 * example value a caller will see or write, which is exactly why it must not be mistaken for a tool name.
 */
const DATA_VALUES = new Map([
  ['depends_on', 'an example edge label (save_edge: direction is part of the meaning)'],
  ['reports_to', 'an example edge label'],
  ['vote_pending', 'the status a network write returns while a vote round is open'],
  ['change_note', 'the first half of the webhook event name change_note.received (F-42)'],
  // A former NAME, kept on purpose: an integrator whose call fails with "unknown tool" needs to find out what
  // it became (embed-job-tools-say-which-queue.test.js asserts it stays).
  ['retry_failed_embeddings', 'the name retry_embed_media had until 3.1'],
]);

/** The snake_case words of a text — the shape every tool name has and prose words do not. */
const snakeWords = (text) => [...new Set(text.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? [])];

describe('MCP reference text names only real tools and parameters', () => {
  it('the vocabulary was actually read', () => {
    assert.ok(tools.length >= 30, `only ${tools.length} tools`);
    assert.ok(vocabulary().size > tools.length + 50, 'parameter names were not collected');
  });

  it('the server instructions\' space sentence', () => {
    const s = spaceScopeSentence(tools, schemas);
    const unknown = snakeWords(s).filter(w => !vocabulary().has(w));
    assert.deepEqual(unknown, [], s);
    assert.match(s, /\brecall\b/, 'recall takes an optional space, so the sentence must name it');
  });

  it('help(), every section', () => {
    const ctx = { accessibleSpaces: [{ id: 'general', label: 'General' }], accessibleSpaceIds: ['general'] };
    const sections = helpSections(ctx, tools.map(t => ({ name: t.name, description: t.description })), 0);
    assert.ok(sections.length >= 5, `only ${sections.length} help sections`);
    const vocab = vocabulary();
    const unknown = sections.flatMap(sec => {
      const text = [sec.title, sec.preamble, sec.body, ...(sec.lines ?? [])].filter(Boolean).join('\n');
      return snakeWords(text).filter(w => !vocab.has(w)).map(w => `${sec.id}: ${w}`);
    });
    assert.deepEqual(unknown, [], 'help names things no tool is called and no parameter is named');
  });

  it('every tool description', () => {
    const vocab = vocabulary();
    const unknown = tools.flatMap(t => snakeWords(t.description ?? '').filter(w => !vocab.has(w)).map(w => `${t.name}: ${w}`));
    assert.deepEqual(unknown, [], 'a tool description names a tool or parameter that does not exist');
  });
});
