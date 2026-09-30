/**
 * The embed-queue listing answers one way on both doors (`Q-109`).
 *
 * REST `GET …/embedding-queue/records` paged across a proxy's members with `skip` and summed their counts; MCP
 * `list_embed_jobs` read only the named space, took no `skip`, and so could report `failed: 500` beside a list that
 * never reaches failure #201. The two also disagreed on `limit`: MCP refused above 200 while REST echoed a 500 it then
 * quietly served as 200. One act now answers both, and the caps are its own.
 *
 * Run: npm run build -w server && node --test testing/standalone/the-embed-queue-lists-one-way-on-both-doors.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const act = await import('../../server/dist/brain/embed-jobs-page.js').catch(() => ({}));
const { TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js');
const { toolSchemasFor, materialisedSchema } = await import('../../server/dist/mcp/tool-schema.js');

describe('the embed-queue listing', () => {
  it('both doors answer through the one act', () => {
    const rest = stripComments(readFileSync('server/src/api/brain/embed-jobs.ts', 'utf8'));
    const mcp = stripComments(readFileSync('server/src/mcp/tools/embed.ts', 'utf8'));
    assert.match(rest, /embedJobsPage\(/, 'REST lists the queue itself');
    assert.match(mcp, /embedJobsPage\(/, 'MCP lists the queue itself');
    for (const [door, src] of [['REST', rest], ['MCP', mcp]]) {
      assert.doesNotMatch(src, /listEmbedJobs\(/, `${door} reads the queue around the act`);
    }
  });

  it('MCP reaches the members of a proxy and every page, as REST does', () => {
    const mcp = stripComments(readFileSync('server/src/mcp/tools/embed.ts', 'utf8'));
    assert.match(mcp, /memberSpacesWithin\(/, 'list_embed_jobs reads only the named space, so a proxy lists nothing of its members');
    const props = materialisedSchema(TOOLS_BY_NAME.get('list_embed_jobs'), toolSchemasFor(['a', 'b']), ['a', 'b']).properties;
    assert.equal(props.skip?.type, 'integer', 'list_embed_jobs takes no skip, so jobs past the first page are unreachable');
  });

  it('the caps are the act\'s, stated once, and a limit past them is refused, not served smaller', async () => {
    assert.equal(typeof act.embedJobsPage, 'function', 'there is no shared act');
    assert.equal(act.MAX_JOB_PAGE, 200);
    const props = materialisedSchema(TOOLS_BY_NAME.get('list_embed_jobs'), toolSchemasFor(['a']), ['a']).properties;
    assert.equal(props.limit.maximum, act.MAX_JOB_PAGE, 'the tool schema states a different ceiling from the act');
    const refused = await act.embedJobsPage([], { limit: 500 });
    assert.equal(refused.ok, false, 'a limit of 500 was accepted — REST used to echo it and serve 200');
    assert.match(refused.error, /limit/);
    assert.equal((await act.embedJobsPage([], { skip: -1 })).ok, false, 'a negative skip must be refused');
    assert.equal((await act.embedJobsPage([], { status: 'done' })).ok, false, 'an unknown status must be refused');
  });
});
