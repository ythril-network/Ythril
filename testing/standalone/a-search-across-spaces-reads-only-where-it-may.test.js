/**
 * A search that names no space reads only the spaces where the token holds the tool's area (`Q-89`).
 *
 * The dispatcher checks a NAMED space against the tool's rights row. A search that names none — `recall` or
 * `similar` with `space` omitted, or `similar` with `crossSpace: true` — searched every space the token could
 * REACH, and reach is not the area: a token holding only `files: read` in a space had that space's knowledge
 * ranked by `recall`. The REST `/similar` route narrowed its own set to `knowledge: read`; moving it onto the tool
 * would have dropped that, so the narrowing moved into the dispatcher, once, for every read tool.
 *
 * Run: npm run build -w server && node --test testing/standalone/a-search-across-spaces-reads-only-where-it-may.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { toolReach } from '../../server/dist/mcp/tool-rights-guard.js';
import { stripComments } from './_strip-comments.mjs';

const none = { knowledge: 'none', files: 'none', schema: 'none', dataQuality: 'none' };
const rights = perSpace => ({ instanceAdmin: false, createSpaces: false, floor: null, perSpace });
const r = rights({ k: { ...none, knowledge: 'read' }, f: { ...none, files: 'read' } });

describe('a read tool reaches only where it may read', () => {
  it('a space held for files alone is not searched by a knowledge tool', () => {
    assert.deepEqual(toolReach('recall', r, ['k', 'f']), ['k']);
    assert.deepEqual(toolReach('similar', r, ['k', 'f']), ['k']);
  });

  it('a tool with no rights row, or one that writes, is handed its reach unchanged', () => {
    // An instance-level tool is not a question about a space's area; a write tool's named space is checked
    // by the rung it needs, and narrowing its proxy members by that rung is a different decision.
    assert.deepEqual(toolReach('list_spaces', r, ['k', 'f']), ['k', 'f']);
    assert.deepEqual(toolReach('save_fact', r, ['k', 'f']), ['k', 'f']);
  });

  it('the dispatcher hands every handler the narrowed list', () => {
    const call = stripComments(readFileSync('server/src/mcp/call-tool.ts', 'utf8'));
    assert.match(call, /toolReach\(name, rights, accessibleSpaceIds\)/,
      'callTool hands the handler every reachable space, so a search that names none reads past the area');
  });
});
