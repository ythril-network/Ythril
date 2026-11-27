/**
 * A file write that misses the file row's version on every attempt answers `409 write_race_lost` on EVERY door that writes a file, and says
 * truthfully what it left (bundle-378, Q-976 S2, adversarial review R1, lens finding L3.3).
 *
 * ## The defect this holds
 *
 * `writeAtReadVersion` (`brain/write-at-read-version.ts`) throws `RecordWriteRaceLost` for the file row too (`files/file-meta.ts`). The record
 * routes answer it `409`; the REST upload (one request and chunked) answered `500 internal "Failed to write file"` because `sendCaughtFailure` mapped
 * only three stamp refusals, while MCP `write_file` answered `409 write_race_lost`. One failure, two answers by door. And for an upload the
 * 409's sentence "nothing was written" is false: the bytes are stored BEFORE the row, the stored-bytes door replaced the old bytes in place, and
 * no copy of them exists to take back, so an overwrite whose row write is refused keeps the new bytes (`files/unrecorded-bytes.ts`).
 *
 * ## The rule
 *
 * - REST whole upload, REST chunked upload and MCP `write_file`: `409`, `{ error, code: 'write_race_lost', id }`, and the sentence says the new
 *   bytes of the file were stored and the record was not changed, so the caller uploads the file again. The row is as it was; the bytes are the upload's.
 * - The file-meta `PATCH` (no bytes involved): `409` with the same code, and "nothing was written" is true.
 * - Both REST uploads and MCP give the SAME sentence.
 *
 * Fork-keep (`brain/fork-keep.ts`) is not a case: it always writes with the listed `ifMatchSeq`, and a miss at a named version is the precondition
 * refusal, never this one (`writeAtReadVersion`: "with `If-Match`: a miss is that refusal at once").
 *
 * ## The case
 *
 * A file row whose `seq` is stored as text is one no version filter can match: every attempt misses while the row is there (the race, made deterministic).
 *
 * ## Seen red
 *
 * On f91569511 both REST uploads answer `500 {"code":"internal","error":"Failed to write file"}`; MCP says "nothing was written" with the new bytes on disk.
 *
 * Run: node --test testing/standalone/a-file-write-that-loses-its-race-answers-409-on-every-door-db.test.js  (a server build and the test MongoDB)
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { openPushDoor } from './_push-door.mjs';
import { listenApp } from '../_shared/in-process-app.mjs';

const skip = await mongoSkipReason();
const S = 'b378frace';
const CODE = 'write_race_lost';
const OLD = 'old bytes';
const NEW = 'new bytes!';
const P = 'p.txt';

describe('a file write that loses its race answers 409 on every door', { skip }, () => {
  let door; let server; let adminKey; let callTool; let rights; let diskPath;

  before(async () => {
    door = await openPushDoor({ suite: 'b378_frace', spaces: [{ id: S, label: 'FRace', folders: [], meta: { suppressEmbeddings: true } }] });
    server = await listenApp();
    const tokens = await import('../../server/dist/auth/tokens.js');
    adminKey = (await tokens.createToken({ name: 'admin', admin: true })).plaintext;
    ({ callTool } = await import('../../server/dist/mcp/call-tool.js'));
    const { SPACE_AREAS } = await import('../../server/dist/config/rights-shape.js');
    rights = { instanceAdmin: true, createSpaces: true, perSpace: {}, floor: Object.fromEntries(SPACE_AREAS.map(a => [a, 'admin'])) };
    const { spaceRoot } = await import('../../server/dist/files/sandbox.js');
    diskPath = path.join(spaceRoot(S), P);
  });
  after(async () => { await server?.close?.(); await door?.close(); });

  /** A file row no version filter matches (its `seq` stored as text), with the old bytes under it. */
  beforeEach(async () => {
    await door.coll(S, 'files').deleteMany({});
    const now = new Date().toISOString();
    await door.coll(S, 'files').insertOne({ _id: P, spaceId: S, path: P, tags: ['kept'], description: 'kept', createdAt: now, updatedAt: now,
      sizeBytes: OLD.length, seq: '5', pos: 5, posAtSeq: 5, author: { instanceId: 'x' } });
    fs.mkdirSync(path.dirname(diskPath), { recursive: true });
    fs.writeFileSync(diskPath, OLD);
  });

  const row = () => door.coll(S, 'files').findOne({ _id: P });
  const rest = async (method, url, { body, headers } = {}) => {
    const res = await fetch(`${server.url}${url}`, { method, headers: { Authorization: `Bearer ${adminKey}`, ...headers }, ...(body !== undefined ? { body } : {}),
      signal: AbortSignal.timeout(20_000) });
    const text = await res.text();
    let json; try { json = JSON.parse(text); } catch { json = null; }
    return { status: res.status, body: json, text };
  };
  const octet = { 'Content-Type': 'application/octet-stream' };
  const upload = () => rest('POST', `/api/files/${S}?path=${P}`, { body: Buffer.from(NEW), headers: octet });
  const chunked = async () => {
    const bytes = Buffer.from(NEW); const mid = bytes.length / 2;
    const first = await rest('POST', `/api/files/${S}?path=${P}`, { body: bytes.subarray(0, mid), headers: { ...octet, 'Content-Range': `bytes 0-${mid - 1}/${bytes.length}` } });
    assert.equal(first.status, 202, `the first range was not staged: ${first.status} ${first.text}`);
    return rest('POST', `/api/files/${S}?path=${P}`, { body: bytes.subarray(mid), headers: { ...octet, 'Content-Range': `bytes ${mid}-${bytes.length - 1}/${bytes.length}` } });
  };
  const mcpWrite = async () => {
    const out = await callTool({ name: 'write_file', args: { space: S, path: P, content: NEW },
      caller: { rights, ip: '127.0.0.1', authMethod: 'pat', oidcSubject: null, transport: 'mcp', tokenId: 'b378frace', tokenLabel: 'b378frace' } });
    return { status: out.status, error: out.result.isError === true, body: out.result.structuredContent ?? null,
      text: (out.result.content ?? []).map(c => c.text ?? '').join('') };
  };

  const STORED = /new bytes of the file were stored/;

  it('REST whole upload: 409 write_race_lost, the row as it was, and the sentence says the bytes were stored', async () => {
    const before = await row();
    const out = await upload();
    assert.equal(out.status, 409, `a lost race answered ${out.status} ${out.text}`);
    assert.equal(out.body?.code, CODE, `the 409 names its reason: ${out.text}`);
    assert.match(out.body?.error ?? '', STORED, `the sentence says what was left: ${out.text}`);
    assert.doesNotMatch(out.body?.error ?? '', /nothing was written/);
    assert.deepEqual(await row(), before, 'the file row changed');
    assert.equal(fs.readFileSync(diskPath, 'utf8'), NEW, 'the sentence says the new bytes were stored, and they must be what is on disk');
  });

  it('REST chunked upload: the same 409 and the same sentence as the whole upload', async () => {
    const before = await row();
    const whole = await upload();
    fs.writeFileSync(diskPath, OLD);
    const out = await chunked();
    assert.equal(out.status, 409, `a lost race answered ${out.status} ${out.text}`);
    assert.equal(out.body?.code, CODE, out.text);
    assert.equal(out.body?.error, whole.body?.error, 'the chunked door gives the whole upload\'s sentence');
    assert.deepEqual(await row(), before, 'the file row changed');
    assert.equal(fs.readFileSync(diskPath, 'utf8'), NEW);
  });

  it('MCP write_file: the same 409, the same code and the same sentence', async () => {
    const before = await row();
    const whole = await upload();
    fs.writeFileSync(diskPath, OLD);
    const out = await mcpWrite();
    assert.equal(out.error, true);
    assert.equal(out.status, 409, `write_file answered ${out.status}: ${out.text}`);
    assert.equal(out.body?.code, CODE, out.text);
    assert.equal(out.body?.error, whole.body?.error, 'both doors give one sentence');
    assert.deepEqual(await row(), before, 'the file row changed');
  });

  it('the file-meta PATCH: 409 write_race_lost, and nothing was written, which is true', async () => {
    const before = await row();
    const out = await rest('PATCH', `/api/brain/spaces/${S}/files?path=${P}`, { body: JSON.stringify({ tags: ['changed'] }), headers: { 'Content-Type': 'application/json' } });
    assert.equal(out.status, 409, `a lost race answered ${out.status} ${out.text}`);
    assert.equal(out.body?.code, CODE, out.text);
    assert.match(out.body?.error ?? '', /nothing was written/);
    assert.deepEqual(await row(), before, 'a lost race writes nothing');
    assert.equal(fs.readFileSync(diskPath, 'utf8'), OLD, 'a metadata write touches no bytes');
  });

  it('control: a path with no row stores its bytes and answers 201', async () => {
    await door.coll(S, 'files').deleteMany({});
    fs.rmSync(diskPath, { force: true });
    const out = await upload();
    assert.ok(out.status === 201 || out.status === 202, `${out.status} ${out.text}`);
    assert.equal(fs.readFileSync(diskPath, 'utf8'), NEW);
  });
});
