/**
 * A peer-bound token cannot call `write_file`, on either tool door (bundle-62, Q-245).
 *
 * ## The defect
 *
 * A peer-bound token (`peerInstanceId`) is a SYNC credential: a peer uses `/api/sync/*` and the byte door, never a tool. `write_file` through
 * MCP or `POST /api/write_file` stored a file as this instance's own upload (authored here, announced, its metadata the caller's) for a token
 * that was only ever meant to deliver arrivals. The binding is known at `callTool` (`peerId`, read from the config token), before any handler.
 *
 * ## The rule
 *
 * `auth/peer-bound.ts` `peerTokenToolRefusal(peerId, toolName)` is the one question "may a peer-bound token call this tool?" (Q-244 widens it
 * to every user write door; this bundle names `write_file`). A refused call:
 *
 *  - is `403` on `POST /api/write_file` and an error result on MCP, and writes nothing;
 *  - leaves an audit row that NAMES ITS SPACE (the refusal runs after the dispatch has set the audit space, before the per-space loop);
 *  - is never advertised: `tools/list` for that token does not offer `write_file`;
 *  - is not asked of an operator token, which still writes.
 *
 * ## The source gate
 *
 * `callTool` (server/src/mcp/call-tool.ts) and `toolIsVisible` (server/src/mcp/tool-visibility.ts, the predicate that builds `tools/list`)
 * each call `peerTokenToolRefusal(`: the behavioural rows above pass with the call removed from the listing only if the listing never
 * mattered, and nothing else fails when `callTool` stops asking, so the call sites are read.
 *
 * Red against 0ac12bdd: the peer token writes the file (200) and `tools/list` offers `write_file`; `peerTokenToolRefusal` does not exist.
 *
 * Run: node --test testing/standalone/a-peer-token-cannot-call-write-file-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readFileSync } from 'node:fs';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor, PEER } from './_pull-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';
import { auditRowsOf } from './_audit-rows.mjs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf } from './_structural-window.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'peerwrite';
const P = 'peer-wrote.txt';

let door, server, peerKey, adminKey, mongo;

/** One MCP request as `key`. */
async function rpc(key, method, params) {
  const r = await fetch(`${server.url}/mcp`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', Accept: 'application/json, text/event-stream' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }),
  });
  const raw = await r.text();
  const data = raw.startsWith('event:') || raw.startsWith('data:') ? raw.split('\n').find(l => l.startsWith('data:'))?.slice(5) ?? '{}' : raw;
  return JSON.parse(data);
}
const mcpWrite = async (key) => {
  const out = await rpc(key, 'tools/call', { name: 'write_file', arguments: { space: S, path: P, content: 'hello' } });
  return { isError: out.result?.isError === true, text: (out.result?.content ?? []).map(c => c.text ?? '').join('\n'), sc: out.result?.structuredContent ?? {} };
};
const restWrite = async (key) => {
  const r = await fetch(`${server.url}/api/write_file`, {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ space: S, path: P, content: 'hello' }),
  });
  return { status: r.status, body: await r.json().catch(() => ({})) };
};
const written = () => fs.existsSync(path.join(process.env['DATA_ROOT'], 'files', S, P));

/** The two tool doors, so a rule stated over doors holds for each. */
const DOORS = () => [
  { name: 'MCP write_file', call: mcpWrite, refused: (a) => a.isError && /peer/i.test(a.text), ok: (a) => !a.isError },
  { name: 'POST /api/write_file', call: restWrite, refused: (a) => a.status === 403, ok: (a) => a.status < 300 },
];

describe('a peer-bound token cannot call write_file', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'peerwrite', spaces: [S] });
    mongo = await import('../../server/dist/db/mongo.js');
    const tokens = await import('../../server/dist/auth/tokens.js');
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    const area = Object.fromEntries(SPACE_AREAS.map(a => [a, 'write']));
    peerKey = (await tokens.createToken({ name: 'peer', peerInstanceId: PEER, rights: { instanceAdmin: false, createSpaces: false, floor: null, perSpace: { [S]: area } } })).plaintext;
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    server = await listenApp();
  });
  after(async () => { await server?.close(); await door?.close(); });
  beforeEach(async () => {
    await door.reset();
    fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true });
    await mongo.getDb().collection('audit_log').deleteMany({});
  });

  for (const d of DOORS()) {
    it(`${d.name}: a peer-bound token is refused (403 on REST) and nothing is written`, async () => {
      const a = await d.call(peerKey);
      assert.ok(d.refused(a), `a peer-bound token's write_file was not refused: ${JSON.stringify(a)}`);
      assert.equal(written(), false, 'the refused call wrote the file');
    });

    it(`${d.name}: the audit row of the refused call names its space`, async () => {
      await d.call(peerKey);
      const rows = (await auditRowsOf(mongo, { spaceId: S })).filter(r => /write_file/.test(r.path ?? '') || /file/.test(r.operation ?? ''));
      assert.ok(rows.length >= 1, 'the refused call left no audit row naming the space');
      assert.ok(rows.every(r => r.status >= 400), `the row of a refused call is not a failure: ${JSON.stringify(rows.map(r => [r.operation, r.status]))}`);
    });

    it(`${d.name}: an operator token still writes`, async () => {
      const a = await d.call(adminKey);
      assert.ok(d.ok(a), `an operator's write_file was refused: ${JSON.stringify(a)}`);
      assert.equal(written(), true, 'the operator\'s write did not land');
    });
  }

  it('tools/list for the peer-bound token does not offer write_file; the operator\'s does', async () => {
    const names = async (key) => (await rpc(key, 'tools/list', {})).result?.tools?.map(t => t.name) ?? [];
    const operator = await names(adminKey);
    assert.ok(operator.includes('write_file'), 'the operator\'s listing does not offer write_file: the probe is broken');
    assert.ok(!(await names(peerKey)).includes('write_file'), 'tools/list advertises a tool the dispatcher refuses this token');
  });
});

describe('the dispatch and the listing both ask the one peer-token question (source gate)', () => {
  it('callTool and toolIsVisible each call peerTokenToolRefusal(', () => {
    // `toolIsVisible` lives in tool-visibility.ts (the predicate `tools/list` is built from), not in call-tool.ts.
    const gate = (file, fn) => {
      const body = bodyOf(stripComments(readFileSync(file, 'utf8')), fn);
      assert.match(body, /\bpeerTokenToolRefusal\(/, `${fn} (${file}) does not call peerTokenToolRefusal( — a peer-bound token's tool rule would live in one door only`);
    };
    gate('server/src/mcp/call-tool.ts', 'callTool');
    gate('server/src/mcp/tool-visibility.ts', 'toolIsVisible');
  });

  it('the one function is defined in auth/peer-bound.ts, beside peerBoundTo', () => {
    assert.match(stripComments(readFileSync('server/src/auth/peer-bound.ts', 'utf8')), /export function peerTokenToolRefusal\(/);
  });
});
