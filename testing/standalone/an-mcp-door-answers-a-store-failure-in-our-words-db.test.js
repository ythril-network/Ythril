/**
 * The MCP dispatcher — and the REST door of every `POST /api/<tool>`, which is `callTool` too — answers a store failure in
 * OUR words, at the status the release line gave it, and says which kind of failure it was (`Q-361`).
 *
 * ## What `callTool` is held to
 *
 * A tool handler that throws is classified HERE, once, for every door: a store failure answers `503` with `retryable` and
 * `storeSideFailure` in `structuredContent`; everything else answers `400` with `Error: <text>`. Both carried the driver's
 * text (`structuredContent.error` and the `Error:` line), and one of them carried OUR text as if it were the store's: a
 * refusal that merely quotes `notes/mongot-setup.md` matched the `mongot` pattern and answered `503` retryable.
 *
 * Driven through the real `callTool` with a tool whose handler throws what the driver throws — real driver classes
 * (`_store-failure-fixtures.mjs`) — so the classifier is asked, not a copy of it. The tool's handler is replaced for the
 * run and put back by hand.
 *
 * ## Pins (green on the base, kept)
 *
 * A store-side failure answers `503` with `retryable: true`, `storeSideFailure: true`; any other driver class answers
 * `400`; a server's refusal keeps its words at `400`; our capability sentence (`$vectorSearch is not supported …`) is a
 * `503` in its own words. The log keeps the existing line the dispatcher writes (`tool 'x' error in space …`) — ONE line
 * for the failure, not a second one for the answer.
 *
 * ## Seen red
 *
 * On 6eb5a333 (v5.6.3): the `503` text and `structuredContent.error` carry the driver's message and its cause; a pool-cleared
 * or other driver class answers `400` with `Error: <driver's message>`; an own refusal naming `mongot` answers `503`.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/an-mcp-door-answers-a-store-failure-in-our-words-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import {
  HOST_TEXT, LEAK, SENTENCES, STORE_SIDE, STORE_SIDE_NAMES, STORE_CODES, ADDRESS_CODES, SERVER_REFUSALS, addressError,
  driverSideErrors, serverError, sendReadFailureOf, wrappers,
} from './_store-failure-fixtures.mjs';
import { logLinesDuring } from './_log-lines.mjs';

const skip = await mongoSkipReason();

const S = 'storetool';
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-storetool-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['DATA_ROOT'] = tmpDir;
process.env['YTHRIL_MODELS_OFFLINE'] = '1';
const WRAPPERS = await wrappers();

const TOOL = 'space_stats';
let callTool, tool, original, refs;

const caller = () => ({
  rights: { instanceAdmin: true, createSpaces: true, floor: null,
    perSpace: { [S]: Object.fromEntries(['knowledge', 'files', 'schema', 'dataQuality', 'networks'].map(a => [a, 'admin'])) } },
  tokenId: 'tok-1', tokenLabel: 'store-failure test', ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp',
});

/** What the dispatcher answers when the tool's handler throws `err`, with the lines it logged. */
async function throwing(err) {
  tool.handle = async () => { throw err; };
  const { lines, result } = await logLinesDuring(() => callTool({ name: TOOL, args: { space: S }, caller: caller() }));
  return { ...result, lines };
}

const textOf = o => o.result.content.map(c => c.text).join('\n');

describe('the tool dispatcher answers a store failure in our words', { skip }, () => {
  before(async () => {
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      spaces: [{ id: S, label: 'Store tool', folders: [] }], networks: [], tokens: [],
    }, null, 2), { mode: 0o600 });
    await openTestMongo('storetool');
    (await import('../../server/dist/config/loader.js')).loadConfig();
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { TOOLS_BY_NAME } = await import('../../server/dist/mcp/tools/index.js');
    refs = await import('../../server/dist/brain/entity-refs.js');
    tool = TOOLS_BY_NAME.get(TOOL);
    assert.ok(tool, `the ${TOOL} tool is gone — re-anchor this test on a tool that takes a space`);
    original = tool.handle;
  });
  after(async () => {
    if (tool) tool.handle = original;
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('PIN: the fixture reaches the dispatcher — an ordinary throw is a 400 in its own words', async () => {
    const out = await throwing(new Error('Missing required fields: name'));
    assert.equal(out.status, 400);
    assert.equal(textOf(out), 'Error: Missing required fields: name');
  });

  for (const { name, make } of driverSideErrors()) {
    const storeSide = STORE_SIDE_NAMES.includes(name);
    it(`${name}: no driver text in the text or in structuredContent; ${storeSide ? '503 retryable' : '400'}, as before`, async () => {
      const out = await throwing(make());
      const everything = `${textOf(out)} ${JSON.stringify(out.result.structuredContent ?? {})}`;
      assert.doesNotMatch(everything, LEAK, `the answer carries the driver's text: ${everything.slice(0, 300)}`);
      assert.equal(out.status, storeSide ? 503 : 400, 'a status the release line answered changed');
      assert.equal(out.result.isError, true);
      if (storeSide) {
        assert.equal(out.result.structuredContent?.retryable, true);
        assert.equal(out.result.structuredContent?.storeSideFailure, true);
        assert.match(textOf(out), STORE_SIDE);
      } else {
        assert.equal(out.result.structuredContent?.storeSideFailure, undefined, 'a 400 is not a store-side failure');
      }
    });
  }

  it('a pooled connection cleared under a command: "not available right now", 400', async () => {
    const make = driverSideErrors().find(d => d.name === 'MongoPoolClearedError').make;
    const out = await throwing(make());
    assert.equal(out.status, 400);
    assert.equal(textOf(out), `Error: ${SENTENCES.unavailable}`);
  });

  it('any other driver class with no server answer: "could not complete this request", 400', async () => {
    const make = driverSideErrors().find(d => d.name === 'MongoInvalidArgumentError').make;
    const out = await throwing(make());
    assert.equal(out.status, 400);
    assert.equal(textOf(out), `Error: ${SENTENCES.incomplete}`);
  });

  it('the failure is logged ONCE, with the driver\'s text — the dispatcher\'s own line, not a second for the answer', async () => {
    const make = driverSideErrors().find(d => d.name === 'MongoServerSelectionError').make;
    const out = await throwing(make());
    const logged = out.lines.filter(l => l.includes('172.16.0.9'));
    assert.equal(logged.length, 1, `logged: ${JSON.stringify(out.lines.map(l => l.slice(0, 140)))}`);
    assert.ok(logged[0].includes(`'${TOOL}'`), `the line does not name the tool: ${logged[0]}`);
  });

  it('PIN: a server\'s refusal keeps its words at 400 — they are how a caller fixes the request', async () => {
    const refusal = await throwing(serverError(51091, 'Location51091', 'Regular expression is invalid: missing closing parenthesis'));
    assert.equal(refusal.status, 400);
    assert.equal(textOf(refusal), 'Error: Regular expression is invalid: missing closing parenthesis');
  });

  it('PIN: a step-down is a 503, retryable, with the store\'s code', async () => {
    const stepDown = await throwing(serverError(189, 'PrimarySteppedDown', `not primary; ${HOST_TEXT}`));
    assert.equal(stepDown.status, 503);
    assert.equal(stepDown.result.structuredContent.retryable, true);
    assert.equal(stepDown.result.structuredContent.code, 189);
  });

  it('a step-down says nothing of the member it names', async () => {
    const stepDown = await throwing(serverError(189, 'PrimarySteppedDown', `not primary; ${HOST_TEXT}`));
    assert.doesNotMatch(`${textOf(stepDown)} ${JSON.stringify(stepDown.result.structuredContent)}`, LEAK);
  });

  it('an own refusal that merely NAMES the store is not a store failure: 400, in its own words, not retryable', async () => {
    const text = '`files` references 1 file that does not exist in space \'s\': "notes/mongot-setup.md". Create the record first.';
    for (const err of [new refs.ReferenceRefusal(text), new Error(text)]) {
      const out = await throwing(err);
      assert.equal(out.status, 400, 'an own refusal that quotes a mongot path is a client error, not a retryable 503');
      assert.equal(textOf(out), `Error: ${text}`);
      assert.notEqual(out.result.structuredContent?.retryable, true);
      assert.equal(out.result.structuredContent?.storeSideFailure, undefined);
    }
  });

  it('PIN: our capability sentence stays a 503 in its own words (store-side, retryable, the instruction kept)', async () => {
    const recall = await import('../../server/dist/brain/recall.js');
    let err;
    try { await recall.recall('x', 'q', 5); } catch (e) { err = e; }
    assert.match(err?.message ?? '', /\$vectorSearch is not supported/, 'fixture check: not the capability error');
    const out = await throwing(err);
    assert.equal(out.status, 503, 'a status the release line answered changed');
    assert.equal(out.result.structuredContent.retryable, true);
    assert.equal(out.result.structuredContent.storeSideFailure, true);
    assert.match(textOf(out), /Upgrade to MongoDB 8\.2\+/);
  });

  // Every way an error travels inside another (`cause`, `underlying`, `errorResponse`), each built by its own class.
  for (const { label, wrap } of WRAPPERS) {
    it(`a driver failure carried in \`${label}\` says nothing of the driver`, async () => {
      for (const { name, make } of driverSideErrors().filter(d => ['MongoNetworkError', 'MongoServerSelectionError'].includes(d.name))) {
        const out = await throwing(wrap(make()));
        const everything = `${textOf(out)} ${JSON.stringify(out.result.structuredContent ?? {})}`;
        assert.doesNotMatch(everything, LEAK, `${name} inside a wrapper: ${everything.slice(0, 200)}`);
        assert.ok(everything.includes(SENTENCES.incomplete), `not our sentence: ${everything.slice(0, 200)}`);
      }
    });
  }

  for (const [code, codeName] of ADDRESS_CODES) {
    it(`code ${code} (${codeName}) names a member's address: the words go, the 400 stays`, async () => {
      const out = await throwing(addressError(code, codeName));
      const everything = `${textOf(out)} ${JSON.stringify(out.result.structuredContent ?? {})}`;
      assert.doesNotMatch(everything, LEAK, `the answer carries the member's address: ${everything.slice(0, 300)}`);
      assert.equal(out.status, 400, 'a status the release line answered changed');
      assert.equal(out.result.isError, true);
      assert.equal(textOf(out), `Error: ${SENTENCES.incomplete}`);
      assert.equal(out.result.structuredContent?.storeSideFailure, undefined, 'a 400 is not a store-side failure');
      assert.notEqual(out.result.structuredContent?.retryable, true);
    });
  }

  /*
   * PARITY. The same error, thrown once at each door: `sendReadFailure` (the REST read routes) and `callTool` (the
   * dispatcher, which every `POST /api/<tool>` is too). Each classifies on its own, so a parity break is one of them
   * answering differently — the text, or the status. The set spans every kind the classifier distinguishes: a driver class
   * of each sort, a store code, an address code, a server refusal, an own error, and a wrapped driver failure.
   */
  const parityCases = () => [
    ...driverSideErrors().map(({ name, make }) => [name, make()]),
    ...STORE_CODES.map(([c, n]) => [`store code ${c} (${n})`, serverError(c, n, `${n}: ${HOST_TEXT}`)]),
    ...ADDRESS_CODES.map(([c, n]) => [`address code ${c} (${n})`, addressError(c, n)]),
    ...SERVER_REFUSALS.map(([c, n, m]) => [`refusal code ${c} (${n})`, serverError(c, n, m)]),
    ['an own error', new Error('Missing required fields: name')],
    ...WRAPPERS.map(w => [`carried in ${w.label}`, w.wrap(driverSideErrors().find(d => d.name === 'MongoNetworkError').make())]),
  ];

  it('PARITY: every kind of failure gets the same status and the same text from the REST read door and the MCP door', async () => {
    const all = parityCases();
    assert.ok(all.length > driverSideErrors().length + STORE_CODES.length + ADDRESS_CODES.length + SERVER_REFUSALS.length,
      `only ${all.length} kinds built — the derivation is broken`);
    const apart = [];
    for (const [label, err] of all) {
      const rest = await sendReadFailureOf(err);
      const mcp = await throwing(err);
      const mcpStatus = mcp.status;
      const mcpText = textOf(mcp).replace(/^Error: /, '');
      if (rest.status !== mcpStatus) apart.push(`${label}: REST ${rest.status}, MCP ${mcpStatus}`);
      else if (rest.body.error !== mcpText) apart.push(`${label}: REST "${rest.body.error}", MCP "${mcpText}"`);
      else if (rest.body.retryable !== (mcp.result.structuredContent?.retryable === true)) apart.push(`${label}: retryable differs`);
    }
    assert.deepEqual(apart, [], 'the doors answer one failure differently — which client the caller picked decides what they read');
  });
});
