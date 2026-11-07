/**
 * A peer-bound token's upload carries no file metadata: it is refused, before anything is staged or stored (bundle-62, Q-245).
 *
 * ## The defect
 *
 * `POST /api/files/:space` took `description`, `tags`, `properties` and `ttlDays` from whoever called, and for a peer-bound token it
 * IGNORED them silently only where a later branch happened not to read them: a peer's metadata arrives by metadata sync (`GET /filemeta`),
 * authored and converged by seq, never on the byte upload. A peer token that sends them is either a bug on its side or a way to write a
 * file's record as this instance's own upload; neither is stored.
 *
 * ## The rule
 *
 * For every way bytes reach the byte door (`UPLOAD_DOORS`) and every field that door can carry (single request: description, tags,
 * properties in the JSON body and `ttlDays` in the query; chunked: `ttlDays` in the query of every range, since a chunked body is raw bytes):
 *
 *  - a PEER-bound token that sends the field is refused `400`, nothing staged, nothing stored (no record, no bytes);
 *  - the refusal comes BEFORE the malformed-bag check: a peer sending a malformed `properties` meets the peer refusal, not the bag's;
 *  - a chunked `ttlDays` is refused on the FIRST range;
 *  - an OPERATOR token (no peer identity) stores the metadata;
 *  - a peer's BARE-BYTES upload still lands as an arrival (the sync door is unchanged).
 *
 * Red against 0ac12bdd: the peer's upload answers 2xx and stores the metadata (or, for `properties`, the malformed-bag 400).
 *
 * Run: node --test testing/standalone/a-peer-token-sends-no-file-metadata-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openPullDoor } from './_pull-door.mjs';
import { UPLOAD_DOORS } from './_byte-door-uploads.mjs';
import { USER_TOKEN } from './_byte-door.mjs';
import { peerToken } from './_push-door.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'peermeta';

/** What each field is when it is sent, and where it travels: `body` (JSON, single request only) or `query` (any shape). */
const FIELDS = Object.freeze([
  { name: 'description', body: { description: 'a peer wrote this' }, stored: (r) => r.description === 'a peer wrote this' },
  { name: 'tags', body: { tags: ['from-a-peer'] }, stored: (r) => r.tags?.includes('from-a-peer') },
  { name: 'properties', body: { properties: { k: 1 } }, stored: (r) => r.properties?.k === 1 },
  { name: 'ttlDays', query: { ttlDays: '3' }, stored: (r) => r._expireAt != null },
]);

let door, handle, chunks, seq = 0;

/** One request through the byte door's own handler, with the metadata where it travels. `body` set: a JSON body; else raw bytes. */
async function send({ token, p, query = {}, json, bytes, range }) {
  const headers = json ? { 'content-type': 'application/json' } : { 'content-type': 'application/octet-stream', ...(range ? { 'content-range': range } : {}) };
  const req = { method: 'POST', params: { spaceId: S }, query: { path: p, ...query }, body: json ?? bytes, authToken: token, headers, ip: '127.0.0.1',
    get: (h) => headers[String(h).toLowerCase()], is: (t) => (json ? t.includes('json') : false) };
  const res = { code: 200, body: undefined, headersSent: false, headers: {},
    status(c) { this.code = c; return this; }, setHeader(k, v) { this.headers[k.toLowerCase()] = v; return this; },
    json(b) { this.body = b; this.headersSent = true; return this; }, end() { this.headersSent = true; return this; } };
  await handle(req, res);
  assert.ok(res.headersSent, 'the byte door settled without answering');
  return { code: res.code, body: res.body };
}

/** Whether a request left anything: a record, bytes in the tree, or staged chunks. */
async function left(p, total) {
  return {
    record: (await door.coll(S, 'files').countDocuments({})) > 0,
    bytes: fs.existsSync(path.join(process.env['DATA_ROOT'], 'files', S, p)),
    staged: total === undefined ? false
      : (await chunks.getUploadReceived(S, p, total)) > 0 || fs.existsSync(path.join(process.env['DATA_ROOT'], '.chunks', S, chunks.uploadId(S, p, total))),
  };
}

/** The rows: every door the byte door has × every field it can carry (the chunked doors carry `ttlDays` only). */
const ROWS = () => UPLOAD_DOORS.flatMap(d => FIELDS.filter(f => !d.chunked || f.query).map(f => ({ door: d, field: f })));
const tokenOf = (d) => (d.arrival ? peerToken('metadata-peer') : USER_TOKEN);

/** Send `field` over `d` to a fresh path; chunked: the FIRST range only (the verdict on a peer, the staging on a person). */
async function sendField(d, f, p, { body = f.body, query = f.query } = {}) {
  return d.chunked
    ? send({ token: tokenOf(d), p, query, bytes: Buffer.from('abcd'), range: 'bytes 0-3/8' })
    : send({ token: tokenOf(d), p, query, json: { content: 'hello', ...body } });
}

describe('a peer-bound token sends no file metadata on the upload', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'peermeta', spaces: [S] });
    chunks = await import('../../server/dist/files/chunks.js');
    const { fileStoreRouter } = await import('../../server/dist/api/files.js');
    const layer = fileStoreRouter.stack.find(l => l.route?.path === '/:spaceId' && l.route.methods['post']);
    assert.ok(layer, 'no POST /:spaceId on the file router — re-anchor this test');
    handle = layer.route.stack.at(-1).handle;
  });
  after(async () => { await door?.close(); });
  beforeEach(async () => { await door.reset(); fs.rmSync(path.join(process.env['DATA_ROOT'], 'files', S), { recursive: true, force: true }); fs.rmSync(path.join(process.env['DATA_ROOT'], '.chunks', S), { recursive: true, force: true }); });

  it('the rows are derived from the doors and the fields, with a floor (an empty table cannot pass)', () => {
    assert.ok(UPLOAD_DOORS.length >= 4 && ROWS().length >= 10, `${UPLOAD_DOORS.length} door(s), ${ROWS().length} row(s): two single doors x four fields and two chunked doors x ttlDays are the minimum`);
    assert.ok(ROWS().some(r => r.door.arrival) && ROWS().some(r => !r.door.arrival), 'both callers are rows');
  });

  for (const { door: d, field: f } of ROWS().filter(r => r.door.arrival)) {
    it(`${d.name}, sending ${f.name}: 400, nothing staged, nothing stored`, async () => {
      const p = `meta/${++seq}.txt`;
      const a = await sendField(d, f, p);
      assert.equal(a.code, 400, `a peer-bound token's ${f.name} answered ${a.code}: ${JSON.stringify(a.body)}`);
      assert.match(String(a.body?.error), /peer|metadata/i, `the refusal does not say why: ${JSON.stringify(a.body)}`);
      assert.deepEqual(await left(p, d.chunked ? 8 : undefined), { record: false, bytes: false, staged: false }, 'a refused metadata upload left something behind');
    });
  }

  for (const { door: d, field: f } of ROWS().filter(r => !r.door.arrival)) {
    it(`${d.name}, sending ${f.name}: an operator token stores it`, async () => {
      const p = `meta/${++seq}.txt`;
      const a = await sendField(d, f, p);
      assert.ok(a.code >= 200 && a.code < 300, `an operator's ${f.name} answered ${a.code}: ${JSON.stringify(a.body)}`);
      if (d.chunked) {
        assert.equal(a.code, 202, 'the first range is staged');
        return;   // the record is written by the LAST range; the first range's verdict is what the peer rows pin
      }
      const row = await door.coll(S, 'files').findOne({ _id: p });
      assert.ok(row && f.stored(row), `the operator's ${f.name} was not stored: ${JSON.stringify(row)}`);
    });
  }

  it('the refusal precedes the malformed-bag check: a peer sending a malformed bag meets the peer refusal', async () => {
    const malformed = { properties: { nested: { deep: 1 } } };
    const single = UPLOAD_DOORS.find(d => d.arrival && !d.chunked);
    const asPeer = await send({ token: tokenOf(single), p: 'meta/bad-peer.txt', json: { content: 'x', ...malformed } });
    const asPerson = await send({ token: USER_TOKEN, p: 'meta/bad-person.txt', json: { content: 'x', ...malformed } });
    assert.equal(asPerson.code, 400, 'a person sending a malformed bag is refused as the bag is');
    assert.equal(asPeer.code, 400, 'a peer sending a malformed bag is refused');
    assert.notEqual(asPeer.body?.error, asPerson.body?.error, 'the peer met the malformed-bag refusal: the peer refusal must come first');
    assert.match(String(asPeer.body?.error), /peer|metadata/i);
  });

  for (const d of UPLOAD_DOORS.filter(x => x.arrival)) {
    it(`${d.name}, sending bare bytes: still lands as an arrival`, async () => {
      const p = `meta/${++seq}.bin`;
      const a = await d.send({ post: ({ space, path: pp, bytes, token, range }) => send({ token, p: pp, bytes, range }) }, { space: S, path: p, content: 'abcdefgh', peer: 'metadata-peer' });
      assert.ok(a.code >= 200 && a.code < 300, `a peer's bare bytes answered ${a.code}: ${JSON.stringify(a.body)}`);
      const row = await door.coll(S, 'files').findOne({ _id: p });
      assert.ok(row, 'the arrival left no record');
      assert.equal(row.author?.instanceId ?? 'metadata-peer', 'metadata-peer', 'an arrival is recorded as the peer\'s');
    });
  }
});
