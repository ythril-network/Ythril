/**
 * A search that exists as a tool answers REST through that tool, so both doors return one shape (`Q-89`).
 *
 * `recall` was collapsed onto its tool long ago. `similar` was not: REST built its own flat results
 * (`{_id, name, …, score}`) and its own `source` (the whole record with `score: 1`) while MCP returned each hit as
 * `{score, spaceId, type, record}` and `source` as `{type, id, summary}` — and its description called that "the SAME
 * per-result shape recall returns". One capability, two shapes by door. Owner ruling 2026-09-29: REST changes to the
 * nested shape, as a breaking change in the next minor.
 *
 * Pinned at the source, because the integration suite that drives both doors needs a running instance.
 *
 * Run: node --test testing/standalone/a-search-door-answers-in-the-tools-shape.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { balancedFrom } from './_structural-window.mjs';

const search = stripComments(readFileSync('server/src/api/brain/search.ts', 'utf8'));
const routeBody = (path) => {
  const start = search.indexOf(`searchRouter.post('${path}'`);
  assert.ok(start >= 0, `the ${path} route is not in search.ts`);
  const next = search.indexOf('searchRouter.', start + 10);
  return search.slice(start, next > 0 ? next : undefined);
};

describe('a search answers REST through its tool', () => {
  for (const [path, tool] of [['/recall', 'recall'], ['/similar', 'similar']]) {
    it(`${path} delegates to the \`${tool}\` tool`, () => {
      assert.match(routeBody(path), new RegExp(`callTool\\(\\{\\s*name: '${tool}'`),
        `${path} builds its own answer instead of the tool's, so the two doors can disagree about its shape`);
    });
  }

  it('REST no longer flattens a hit, so the flattening helper is gone', () => {
    assert.doesNotMatch(search, /function projectResults\(/,
      'projectResults flattens a hit into REST\'s old shape; nothing may call it once both searches use the tool');
  });

  it('an entry the tool cannot find is a 404 on REST, as the route answered before', () => {
    const call = stripComments(readFileSync('server/src/mcp/call-tool.ts', 'utf8'));
    // The `if` block itself, bounded by its own closing brace rather than a character cap.
    const at = call.indexOf('if (err instanceof NotFoundError) {');
    assert.ok(at >= 0, 'callTool no longer branches on NotFoundError — re-anchor this gate');
    const branch = balancedFrom(call, call.indexOf('{', at), 'the NotFoundError branch');
    assert.match(branch, /status: 404/,
      'callTool classifies NotFoundError as a 400, so REST /similar would answer 400 for a missing entry');
  });
});
