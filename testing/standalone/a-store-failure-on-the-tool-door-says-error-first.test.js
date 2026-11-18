/**
 * A store failure on the tool door answers in the same grammar as every other failure of a tool: the text starts `Error: ` (Q-339).
 *
 * ## The finding
 *
 * Every refusal and failure a tool answers read `Error: <sentence>` on MCP and in the `error` of `POST /api/<tool>`, except one kind:
 * a store failure answered the bare sentence, a comment said so on purpose ("no `Error: ` before it") and the rule was kept for the
 * kind that needed it least. An agent that tells a failure from a result by the first word of the text met two grammars for one door.
 * The owner decided the prefix is the rule and the store failure follows it ("A and make it one module, not 35 places").
 *
 * ## What is asserted
 *
 * With the tool's handler throwing the driver's own error for a lost connection, `callTool` answers `503` and `retryable: true`, and
 *  - the MCP text is `Error: ` followed by the store failure's sentence, word for word the `error` of its structured body;
 *  - the REST tool door's `error` is that same text;
 *  - the structured body's own `error` stays the bare sentence (a client that reads the object, and the classic routes that answer the
 *    sentence alone, are unchanged);
 *  - the driver's text (an address) reaches neither.
 *
 * Run: node --test testing/standalone/a-store-failure-on-the-tool-door-says-error-first.test.js   (after `npm run build:server`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import { configureSpaces } from './_configured-spaces.mjs';

const { MongoNetworkError } = createRequire(path.resolve('server/package.json'))('mongodb');
const SPACE = 'storefailprobe';
const TOOL = 'space_stats';
const ADDRESS = '10.9.9.9:27017';

describe('a store failure on the tool door says `Error: ` first', () => {
  let callTool, restToolBody, tool, realHandle, configured, ADMIN;
  before(async () => {
    configured = await configureSpaces([SPACE], 'store-failure-error-first');
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    ({ restToolBody } = await import('../../server/dist/api/tools.js'));
    const { TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    ADMIN = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    tool = TOOLS_BY_NAME.get(TOOL);
    assert.ok(tool, `no tool '${TOOL}': re-anchor this test`);
    realHandle = tool.handle;
  });
  after(() => {
    if (tool) tool.handle = realHandle;
    if (configured?.dir) fs.rmSync(configured.dir, { recursive: true, force: true });
  });

  async function failing(transport) {
    let fired = 0;
    tool.handle = async () => { fired += 1; throw new MongoNetworkError(`connection 3 to ${ADDRESS} closed`); };
    try {
      const out = await callTool({ name: TOOL, args: { space: SPACE }, caller: { rights: ADMIN, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport, tokenId: 't', tokenLabel: 't' } });
      assert.equal(fired, 1, `the tool's handler never ran, so the call was refused before the store was asked: ${JSON.stringify(out.result)}`);
      return out;
    } finally { tool.handle = realHandle; }
  }

  it('MCP: the text is `Error: ` and the store failure\'s sentence, which is the structured body\'s error word for word', async () => {
    const out = await failing('mcp');
    const text = out.result.content.map(c => c.text).join('\n');
    const sc = out.result.structuredContent ?? {};
    assert.equal(out.status, 503, `answered ${out.status}: ${text}`);
    assert.equal(sc.retryable, true, 'the store failure is not marked retryable');
    assert.equal(sc.storeSideFailure, true, 'the store failure is not marked as the store\'s');
    assert.equal(typeof sc.error, 'string', 'the structured body carries no error sentence');
    assert.ok(!sc.error.startsWith('Error:'), `the structured body's sentence was prefixed: ${sc.error}`);
    assert.equal(text, `Error: ${sc.error}`, 'the text is not `Error: ` followed by the structured sentence');
    assert.ok(!JSON.stringify(out.result).includes(ADDRESS), 'the driver\'s address reached the answer');
  });

  it('POST /api/<tool>: the body\'s error is the same text', async () => {
    const out = await failing('rest');
    const body = restToolBody(out);
    assert.equal(out.status, 503, `answered ${out.status}`);
    assert.equal(body.ok, false);
    assert.match(String(body.error), /^Error: A store-side failure/, `the REST tool door's error reads ${JSON.stringify(body.error)}`);
    assert.equal(body.error, `Error: ${body.data.error}`, 'the REST error is not `Error: ` followed by the structured sentence');
    assert.ok(!JSON.stringify(body).includes(ADDRESS), 'the driver\'s address reached the answer');
  });
});
