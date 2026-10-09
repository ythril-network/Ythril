/**
 * Red-team tests: the equal-seq converge on a file row's `updatedAt` is a NEW write power, and a peer's text reaches it
 * (bundle-89, Q-419, plan rev 3 §E3 item 3).
 *
 * ## The attack surface
 *
 * `IncomingFileMetaDoc.updatedAt` is a bare `z.string()`: no ISO check, no length bound (`api/sync/_shared.ts`). Until now an
 * equal-seq arrival of a file's row was skipped, so that string was never adopted over a stored one. The heal lets a receiver
 * adopt the arriving `updatedAt` at an equal seq when the DELIVERER is the author. So what a deliverer sends as `updatedAt`
 * — text, a very long string, a date years ahead — and what it claims as `author` reach a write that did not exist, and an
 * `updatedAt` is a field the Merkle hash and every cursor read as an instant.
 *
 * Attack vectors, each asserted as "the stored row is exactly what it was, and the server did not fall over":
 *
 *  1. `updatedAt` that is not an instant at all (text, an object-shaped string, the empty string);
 *  2. `updatedAt` of 200 000 characters;
 *  3. `updatedAt` an instant years in the future;
 *  4. a forged `author`: a document naming another instance as its author, delivered by a token that proves no such peer;
 *  5. a deliverer that is not the author (this suite's token is an admin token, whose delivery proves NO peer, so it is never
 *     the author of anything — the strongest "not the author" there is).
 *
 * The first two matter even when the deliverer IS the author, and are asserted at the unit level in
 * `a-file-row-at-an-equal-seq-converges-on-its-authors-updatedat-db`; here the deliverer is a token that never is, so every
 * row below must leave the stored row alone whatever the validation says.
 *
 * ## What this file can and cannot show
 *
 * It needs the running test stack (`npm run test:up`) and attacks only instance A over HTTP. It was WRITTEN against the base
 * and NOT RUN: no test stack was up while it was written. On the base every row passes, since an equal-seq arrival is skipped —
 * it is a guard for the branch the plan adds, held red there by the database-level twin
 * (`a-file-row-at-an-equal-seq-converges-on-its-authors-updatedat-db`, whose hostile rows were seen red under a wrong branch).
 *
 * Run: node --test testing/red-team-tests/file-row-converge-hostile-updatedat.test.js
 * Needs: instance A and its token (`testing/sync/configs/a/token.txt`, from `npm run test:up`).
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { INSTANCES, post, get } from '../sync/helpers.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TOKEN_FILE = path.join(__dirname, '..', 'sync', 'configs', 'a', 'token.txt');

const SPACE = 'general';
const RUN = `${Date.now()}`;
/** An instant in the past, the one the stored row holds. */
const HELD_AT = '2026-09-01T00:00:00.000Z';
const OWNER = { instanceId: `rt-owner-${RUN}`, instanceLabel: 'The recorded author' };
const SEQ = Math.floor(Date.now() / 1000);

let token;

const fileDoc = (id, extra = {}) => ({
  _id: id, spaceId: SPACE, path: id, tags: [], description: 'held', author: OWNER,
  createdAt: HELD_AT, updatedAt: HELD_AT, seq: SEQ, ...extra,
});

/** The stored row's `updatedAt` as the sync read serves it, or undefined when it is not served. */
async function storedUpdatedAt(id) {
  const r = await get(INSTANCES.a, token, `/api/sync/filemeta?spaceId=${SPACE}&sinceSeq=${SEQ - 1}&limit=500&full=true`);
  assert.equal(r.status, 200, `the sync read of file rows answered ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  return (r.body?.items ?? []).find(d => d._id === id)?.updatedAt;
}

async function seed(id) {
  const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=' + SPACE, { filemeta: [fileDoc(id)] });
  assert.equal(r.status, 200, `fixture: the seed was refused: ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  assert.equal(await storedUpdatedAt(id), HELD_AT, 'fixture: the seeded row is not served at the instant it was sent, so the checks below prove nothing');
}

async function send(id, extra) {
  const r = await post(INSTANCES.a, token, '/api/sync/batch-upsert?spaceId=' + SPACE, { filemeta: [fileDoc(id, extra)] });
  assert.ok(r.status < 500, `a hostile updatedAt made the server answer ${r.status} ${JSON.stringify(r.body)?.slice(0, 200)}`);
  return r;
}

describe('file-row converge — hostile updatedAt and forged authors (a deliverer that is not the author)', () => {
  before(() => { token = fs.readFileSync(TOKEN_FILE, 'utf8').trim(); });

  const HOSTILE = [
    ['text that is not an instant', 'next tuesday-ish'],
    ['an object-shaped string', '{"$gt":""}'],
    ['the empty string', ''],
    ['a spelling that is not the fixed-width instant', '2026-09-01T00:00:00+02:00'],
    ['200 000 characters', '2026-09-01T00:00:00.000Z'.padEnd(200_000, '0')],
    ['an instant years in the future', '2999-01-01T00:00:00.000Z'],
  ];
  for (const [what, value] of HOSTILE) {
    it(`updatedAt: ${what} leaves the stored row alone`, async () => {
      const id = `rt-converge/hostile-${RUN}-${what.replace(/\W+/g, '-').slice(0, 20)}.md`;
      await seed(id);
      await send(id, { updatedAt: value });
      assert.equal(await storedUpdatedAt(id), HELD_AT,
        `the stored updatedAt became ${String(await storedUpdatedAt(id)).slice(0, 40)} from "${what}": a deliverer that is not the author reached the equal-seq write`);
    });
  }

  it('a forged author: a document naming the recorded author, delivered by a token that proves no such peer, converges nothing', async () => {
    const id = `rt-converge/forged-${RUN}.md`;
    await seed(id);
    await send(id, { updatedAt: '2026-09-02T00:00:00.000Z', author: OWNER });
    assert.equal(await storedUpdatedAt(id), HELD_AT, 'naming the author on the document made the deliverer the author: the field is the sender\'s own text');
  });

  it('an admin token is not the author of a row some instance wrote: it converges nothing', async () => {
    const id = `rt-converge/admin-${RUN}.md`;
    await seed(id);
    await send(id, { updatedAt: '2026-09-03T00:00:00.000Z' });
    assert.equal(await storedUpdatedAt(id), HELD_AT, 'a delivery that proves no peer adopted a different updatedAt at an equal seq');
  });

  it('after every hostile attempt the instance still answers (it was not wedged by a long string)', async () => {
    const r = await get(INSTANCES.a, token, '/api/spaces');
    assert.equal(r.status, 200, `the instance answered ${r.status} after the hostile updatedAt rows`);
  });
});
