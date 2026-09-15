/**
 * A tool description must not send an MCP caller to a REST route.
 *
 * ## The defect this was written for
 *
 * `reindex`'s description said: *"it runs in the background and may take minutes, so poll `space_meta` or
 * the REST reindex-status route rather than waiting on this call."*
 *
 * `space_meta` did not carry the reindex state. `needsReindex` was read by one route and by no tool at all.
 * So the only actually-working half of that sentence was the REST one — and for a pure-MCP client (Claude
 * Desktop, any agent with no HTTP door) the description named something it could not reach.
 *
 * That is worse than a missing capability. A schema description is what a caller reads *while constructing
 * arguments*, `help()` says so in as many words, and nobody reports a capability they were told to get
 * elsewhere. It is the same shape as `recall`'s filter description claiming a post-filter: the wrong sentence
 * was the one being read.
 *
 * ## What this gate holds
 *
 * 1. No tool description tells the reader to use a REST route or a `curl`. If a capability is worth naming in a
 *    tool schema, it is worth reaching from a tool.
 * 2. `space_meta` actually reports `needsReindex` — so the sentence `reindex` now carries is true. Asserted
 *    against the built tool's OUTPUT shape, not against its prose, because prose is what was wrong before.
 *
 * Run: node --test testing/standalone/tool-descriptions-name-reachable-things.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js');

/** A mention of the other door. */
const REST_REF = /\bREST\b|\bcurl\b|\b(?:GET|POST|PATCH|PUT|DELETE) \/api\//i;

/**
 * Naming a route is not the defect — being SENT to one is.
 *
 * `save_space` says *"Refusals match POST /api/spaces exactly, including 422 …"*, which is a parity statement:
 * useful to a reader who has both doors, harmless to one who does not, and true. `reindex` said *"poll … the
 * REST reindex-status route"*, which is an instruction an MCP-only caller cannot carry out.
 *
 * So the test is per SENTENCE, and a sentence that mentions the other door must be describing equivalence
 * rather than directing traffic. The first version of this gate flagged both and would have demanded a true
 * sentence be deleted.
 */
const PARITY_WORDS = /\bmatch(?:es|ing)?\b|\bsame\b|\bidentical\b|\bmirror(?:s|ed)?\b|\bequivalent\b|\bas on\b|\bthe REST (?:route|API|surface) (?:also|likewise)\b/i;
// `query` and `hit` are deliberately absent. `query` is a tool NAME — `help`'s own description says "how to
// choose between query / recall / filtered recall … and the REST API map", which is help describing its own
// contents rather than routing anyone anywhere. A verb list that swallows a tool name is a gate that fires on
// correct prose.
const DIRECTIVE = /\b(?:poll|use|call|fetch|see|visit|go to|invoke)\b/i;

describe('no tool description sends the reader to another door', () => {
  for (const tool of ALL_TOOLS) {
    it(tool.name, () => {
      const sentences = (tool.description ?? '').split(/(?<=[.!?])\s+/);
      for (const s of sentences) {
        if (!REST_REF.test(s)) continue;
        if (PARITY_WORDS.test(s)) continue;   // describing equivalence, not routing the caller
        assert.ok(!DIRECTIVE.test(s),
          `${tool.name} tells an MCP caller to reach for the other door: "${s.trim()}". An MCP-only client `
          + 'cannot follow it — name a tool, or add the capability to one.');
      }
    });
  }
});

describe('get_space_meta reports the reindex state the reindex tool points at', () => {
  const source = readFileSync('server/src/mcp/tools/spaces.ts', 'utf8');

  it('the reindex description names get_space_meta and its field', () => {
    const reindex = ALL_TOOLS.find(t => t.name === 'space_reindex');
    assert.ok(reindex, 'no space_reindex tool');
    assert.match(reindex.description, /poll `space_meta`/,
      'the description must name the tool a caller can actually reach');
    assert.match(reindex.description, /needsReindex/,
      'and the field, so the caller knows what to look at rather than diffing whole responses');
  });

  it('and get_space_meta puts it in the response', () => {
    // The OUTPUT, from source, because the description being right is exactly what was not enough last time.
    const meta = source.slice(source.indexOf('const metaResult = {'));
    assert.match(meta.slice(0, 900), /needsReindex: metaMemberIds\.some\(mid => needsReindex\(mid\)\)/,
      'get_space_meta must report needsReindex, summed over the member spaces like every other proxy read');
  });

  it('REST reports the same field, computed the same way', () => {
    // One capability, two doors. A field on one door only is how this started.
    const rest = readFileSync('server/src/api/spaces.ts', 'utf8');
    assert.match(rest, /const reindexNeeded = memberIds\.some\(mid => needsReindex\(mid\)\)/);
    assert.match(rest, /needsReindex: reindexNeeded,/);
  });

  it('the dedicated status route still exists — this adds a field, it does not remove a route', () => {
    const search = readFileSync('server/src/api/brain/search.ts', 'utf8');
    assert.match(search, /'\/spaces\/:spaceId\/reindex-status'/,
      'existing callers of the status route must keep working');
  });
});
