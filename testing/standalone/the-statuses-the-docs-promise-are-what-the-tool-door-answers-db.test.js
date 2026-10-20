/**
 * The statuses the integration guide promises for a failed `write_file` and a failed tool call are what the doors answer (Q-458).
 *
 * ## The defect
 *
 * `05-files-api.md` says a file act the server's own storage refuses answers `500` with `code: "file_system_fault"` "on every door",
 * and `02b-upgrading.md` and the CHANGELOG repeat it — true only where a pre-check met the failure. A `write_file` whose own
 * write failed answered `400` with the runtime's message on the tool door. And `16-mcp.md`'s status list for `POST /api/<tool>`
 * has no `500` at all and calls every `400` "malformed", while the door answered a `TypeError` of ours as a `400`. Nothing held
 * either claim, so each read true to whoever wrote it.
 *
 * ## The rule
 *
 * Both are read OUT of the docs, never restated here (as `the-store-failure-messages-in-the-docs-are-the-constants` does):
 *
 * 1. The status and code `05-files-api.md` gives a file act the server's storage refuses are what MCP `write_file` and
 *    `POST /api/write_file` answer when the write's own rename fails (injected, counted, restored in a `finally`).
 * 2. Every status the tool door answers for a fault of ours (a `TypeError`, a file-system error, a socket error), is in
 *    `16-mcp.md`'s status list, and none of them is the status that list calls "malformed": a fault is not the caller's
 *    malformed request.
 *
 * Red against da4cafd8: `write_file` answers 400 on both tool doors where the guide says 500 `file_system_fault`; the tool door
 * answers a `TypeError` 400, the status `16-mcp.md` calls malformed.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27017 YTHRIL_TEST_MONGO_CREDS= node --test testing/standalone/the-statuses-the-docs-promise-are-what-the-tool-door-answers-db.test.js
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'docstatus';
const FILES_API = 'docs/integration-guide/05-files-api.md';
const MCP_GUIDE = 'docs/integration-guide/16-mcp.md';

/** What `05-files-api.md` promises for a file act the server's storage refuses: `{ status, code }`, read from its sentence. */
function filesApiFaultPromise() {
  const text = readFileSync(FILES_API, 'utf8').replace(/\s+/g, ' ');
  const m = /server's own storage refuses answers `(\d{3})` with `code: "([a-z_]+)"`, on every door/.exec(text);
  assert.ok(m, `${FILES_API} no longer says what a file act the server's storage refuses answers — re-anchor this test on the sentence that does`);
  return { status: Number(m[1]), code: m[2] };
}

/** `16-mcp.md`'s status list for `POST /api/<tool>`: status -> meaning, read from the paragraph that gives it. */
function toolDoorStatusList() {
  const text = readFileSync(MCP_GUIDE, 'utf8').replace(/\s+/g, ' ');
  const at = text.indexOf('because HTTP has one and JSON-RPC does not');
  assert.ok(at > 0, `${MCP_GUIDE} no longer gives the tool door's status list — re-anchor this test`);
  const para = text.slice(at, text.indexOf('Over MCP', at));
  const list = new Map([...para.matchAll(/`(\d{3})` ([^,.`]+)/g)].map(m => [Number(m[1]), m[2].trim()]));
  assert.ok(list.size >= 5, `only ${list.size} statuses read from ${MCP_GUIDE}'s list: ${[...list]} — the parse is broken`);
  return list;
}

let acts, tools;

async function whileToolThrows(name, err, fn) {
  const tool = tools.TOOLS_BY_NAME.get(name);
  const real = tool.handle;
  let fired = 0;
  tool.handle = async () => { fired += 1; throw err; };
  try { return { answer: await fn(), fired }; } finally { tool.handle = real; }
}

describe('the statuses the docs promise are what the tool door answers (Q-458)', { skip }, () => {
  before(async () => {
    acts = await openFileActDoors({ suite: 'docstatus', space: S });
    tools = await import('../../server/dist/mcp/tools/index.js');
  });
  after(async () => { await acts?.close(); });

  for (const [door, run] of [
    ['MCP write_file', () => acts.mcp('write_file', { path: 'd/f.txt', content: 'x' })],
    ['POST /api/write_file', () => acts.tool('write_file', { path: 'd/f.txt', content: 'x' })],
  ]) {
    it(`${door}: a write the storage refuses answers what ${FILES_API} promises`, async () => {
      const promise = filesApiFaultPromise();
      const real = fsp.rename;
      const root = path.resolve(acts.root());
      let fired = 0;
      fsp.rename = async function refused(src, dst, ...rest) {
        if (typeof dst === 'string' && path.resolve(dst).startsWith(root + path.sep)) {
          fired += 1;
          throw Object.assign(new Error(`EIO: i/o error, rename '${dst}'`), { code: 'EIO', errno: -5, syscall: 'rename', path: dst });
        }
        return real.call(this, src, dst, ...rest);
      };
      let a;
      try { a = acts.answerOf(await run()); } finally { fsp.rename = real; }
      assert.ok(fired >= 1, `${door}: the write never reached its rename`);
      assert.deepEqual({ status: a.status, code: a.code }, promise,
        `${door}: the guide promises ${JSON.stringify(promise)} for a write the storage refuses; the door answered ${JSON.stringify(a)}`);
    });
  }

  for (const [label, make] of [
    ['a TypeError of ours', () => new TypeError('Cannot read properties of undefined (reading \'x\')')],
    ['a file-system error', () => Object.assign(new Error('EIO: i/o error, open \'/data/x\''), { code: 'EIO', syscall: 'open', path: '/data/x' })],
    ['a socket error', () => Object.assign(new Error('connect ECONNREFUSED 10.0.0.5:443'), { code: 'ECONNREFUSED', syscall: 'connect' })],
  ]) {
    it(`POST /api/<tool>: ${label} answers a status ${MCP_GUIDE} lists, and not the one it calls malformed`, async () => {
      const list = toolDoorStatusList();
      const malformed = [...list].filter(([, meaning]) => /malformed/.test(meaning)).map(([s]) => s);
      assert.ok(malformed.length === 1, `${MCP_GUIDE} names ${malformed.length} "malformed" statuses: ${[...list]}`);
      const { answer, fired } = await whileToolThrows('space_stats', make(), () => acts.tool('space_stats', {}));
      assert.equal(fired, 1, 'the tool handler never ran');
      assert.notEqual(answer.code, malformed[0], `${label} answered ${answer.code}, which ${MCP_GUIDE} calls "${list.get(malformed[0])}" — a fault of ours is not the caller's malformed request: ${JSON.stringify(answer.body)}`);
      assert.ok(list.has(answer.code), `${label} answered ${answer.code}, which ${MCP_GUIDE}'s status list (${[...list.keys()]}) does not name: ${JSON.stringify(answer.body)}`);
    });
  }
});
