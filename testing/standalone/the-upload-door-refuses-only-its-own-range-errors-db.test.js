/**
 * The upload door answers OUR refusals 400 and a runtime `RangeError` as the server fault it is (Q-541).
 *
 * ## The defect
 *
 * `api/files-upload.ts` answers `err instanceof RangeError` with `400` and `err.message` on every upload branch. Our own refusals
 * throw `RangeError` on purpose (a chunk coverage error, a chunk whose length disagrees with its name, a bad encoding), but Node
 * and V8 throw it too: an invalid `Buffer` length, an out-of-range offset, a stack overflow. A sync sender reads `400` as
 * "refused about the bytes" and does not offer them again (ADR 09), so a server fault on the upload path silently drops the file
 * for that peer, and the answer carries the runtime's own sentence.
 *
 * ## The rule
 *
 * A `RangeError` the runtime raised while an upload ran is the server's fault: `500`, in our words, never its message. One of our
 * chunk refusals stays `400` with its own sentence. Held on the single-request branch and on the chunked branch's last range.
 *
 * The runtime error is injected into the act's own landing call (`rename` under the space's files root) as Node raises one
 * (`RangeError`, `code: 'ERR_OUT_OF_RANGE'`), with a poison marker in its message; the stub counts that it fired and is restored in
 * a `finally`. The refusal is a real one: two ranges that overlap, so the assembly finds no clean coverage.
 *
 * Red against da4cafd8: the runtime `RangeError` answers 400 with its message on both branches.
 *
 * Run: YTHRIL_TEST_MONGO_PORT=27017 YTHRIL_TEST_MONGO_CREDS= node --test testing/standalone/the-upload-door-refuses-only-its-own-range-errors-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openFileActDoors } from './_file-act-doors.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'uploadrange';
const POISON = 'poison-q541-91aa';

let acts;

/** Make `fsp.rename` onto the space's files tree throw a runtime RangeError; returns `{ state, restore }`. */
function runtimeRangeErrorOnLanding() {
  const real = fsp.rename;
  const state = { fired: 0 };
  const root = path.resolve(acts.root());
  fsp.rename = async function injected(src, dst, ...rest) {
    if (typeof dst === 'string' && path.resolve(dst).startsWith(root + path.sep)) {
      state.fired += 1;
      throw Object.assign(new RangeError(`The value of "offset" is out of range. It must be >= 0 && <= 8. Received ${POISON}`), { code: 'ERR_OUT_OF_RANGE' });
    }
    return real.call(this, src, dst, ...rest);
  };
  return { state, restore: () => { fsp.rename = real; } };
}

const send = (p, range, bytes) => acts.post('upload', { query: { path: p }, body: Buffer.from(bytes),
  headers: { 'content-type': 'application/octet-stream', 'content-range': range } });

describe('the upload door refuses only its own RangeErrors (Q-541)', { skip }, () => {
  before(async () => { acts = await openFileActDoors({ suite: 'uploadrange', space: S }); });
  after(async () => { await acts?.close(); });
  beforeEach(async () => {
    await acts.reset();
    fs.rmSync(path.join(process.env['DATA_ROOT'], '.chunks', S), { recursive: true, force: true });
  });

  const BRANCHES = [
    ['single request', () => acts.post('upload', { query: { path: 'u/one.txt' }, body: { content: 'hello' }, headers: { 'content-type': 'application/json' } })],
    ['chunked, last range', async () => {
      const first = await send('u/two.bin', 'bytes 0-3/8', 'abcd');
      assert.equal(first.code, 202, `the first range, with nothing in the way: ${JSON.stringify(first.body)}`);
      return send('u/two.bin', 'bytes 4-7/8', 'efgh');
    }],
  ];

  for (const [branch, run] of BRANCHES) {
    it(`${branch}: a runtime RangeError is the server's fault — 500, not its message`, async () => {
      const stub = runtimeRangeErrorOnLanding();
      let a;
      try { a = await run(); } finally { stub.restore(); }
      const wire = JSON.stringify({ body: a.body, headers: a.headers });
      assert.ok(stub.state.fired >= 1, `${branch}: the runtime RangeError never fired, so the door was not asked — ${wire}`);
      assert.equal(a.code, 500, `${branch}: a runtime RangeError answered ${a.code}, not 500 (a sync sender reads 400 as refused about the bytes) — ${wire}`);
      assert.ok(!wire.includes(POISON), `${branch}: the answer carries the runtime's own message — ${wire}`);
    });
  }

  it('one of our chunk refusals (ranges that overlap) stays 400 with its own sentence', async () => {
    const a1 = await send('u/three.bin', 'bytes 0-3/8', 'abcd');
    assert.equal(a1.code, 202, JSON.stringify(a1.body));
    const a2 = await send('u/three.bin', 'bytes 2-5/8', 'cdef');
    const a3 = a2.code === 202 ? await send('u/three.bin', 'bytes 6-7/8', 'gh') : a2;
    const wire = JSON.stringify(a3.body);
    assert.equal(a3.code, 400, `an overlapping range answered ${a3.code}, not our refusal's 400 — ${wire}`);
    assert.match(String(a3.body?.error), /^Chunk coverage error /, `the refusal is not the chunk coverage refusal (files/chunks.ts): ${wire}`);
  });
});
