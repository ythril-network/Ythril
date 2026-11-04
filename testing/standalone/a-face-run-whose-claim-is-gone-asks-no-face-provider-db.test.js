/**
 * A face run that no longer holds its claim does not call the face provider (Q-698, bundle-236; DESIGN v3 item 6, premise P7).
 *
 * ## The defect
 *
 * `embedFaces` decodes the image and asks the face provider BEFORE its first fenced write. A run whose claim was taken (a delete, a move,
 * or - since bundle-236 - a re-upload that replaces the bytes and revokes the job) therefore still pays for a decode and a detect call,
 * through the external provider's quota and its private-network round trip, to learn at the first write that nothing it makes is wanted.
 * A faces-only re-run (`facesOnly`, a deferred job's second run) skips the caption, so the detect call is the ONLY cost it has: with the
 * re-upload now revoking jobs, every replaced picture that was mid-deferral would make one for nothing.
 *
 * ## The rule
 *
 * `embedFaces` reads its claim (`holdsClaim`) after the gate that decides whether faces are analysed at all and BEFORE the decode: a run whose
 * claim is gone stops there (abandonment, `JobLeaseLostError`) and the provider is never asked. A run that holds its claim asks it once (the
 * control, which holds on the base and is what makes the count mean something).
 *
 * ## How
 *
 * The real `embedFaces` over a real Mongo, the provider's calls counted by the parked harness (`_parked-media-runs.mjs`, answering at once),
 * the claim made by `seedClaim` and taken away by `revoke`, as a delete's `cancelMediaJob` leaves it.
 *
 * Seen red on the base: the revoked run asks the provider once (the count is 1, not 0) and only then fails at its first write.
 *
 * Needs a MongoDB and a private address: `npm run test:up`.
 *
 * Run: node --test testing/standalone/a-face-run-whose-claim-is-gone-asks-no-face-provider-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { openParkedMediaRuns } from './_parked-media-runs.mjs';
import { seedClaim, revoke } from './_media-claim.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const S = 'faceclaimgone';
const T0 = '2026-09-01T00:00:00.000Z';

let runs, acts, embedFaces, isAbandonment, png, scratch;
const files = () => acts.door.coll(S, 'files');

async function seedParent(p) {
  await files().insertOne({ _id: p, spaceId: S, path: p, sizeBytes: png.length, tags: [], createdAt: T0, updatedAt: T0, seq: 1 });
}
function handleOf(name) {
  const p = path.join(scratch, name);
  fs.writeFileSync(p, png);
  return { path: p, size: png.length, copied: true, dispose: async () => { /* the suite removes its scratch */ } };
}

describe('a face run whose claim is gone asks no face provider (real embedFaces, real Mongo)', { skip }, () => {
  before(async () => {
    scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-faceclaimgone-'));
    runs = await openParkedMediaRuns({ suite: 'faceclaimgone', space: S, faces: true });
    acts = runs.acts;
    runs.face.parking(false);
    ({ embedFaces } = await import('../../server/dist/files/media/face-embedder.js'));
    ({ isAbandonment } = await import('../../server/dist/files/media/lease.js'));
    png = await createRequire(new URL('../../server/package.json', import.meta.url))('sharp')({
      create: { width: 64, height: 64, channels: 3, background: '#888888' },
    }).png().toBuffer();
  });
  after(async () => {
    await runs?.close();
    try { fs.rmSync(scratch, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('control: a run that holds its claim asks the provider once and stores its face', async () => {
    const p = 'held.png';
    await seedParent(p);
    const before = runs.face.calls.length;
    await embedFaces(S, p, handleOf('held.png'), { claim: await seedClaim(S, p), facesOnly: true });
    assert.equal(runs.face.calls.length - before, 1, 'the control run did not ask the provider exactly once: the count below says nothing');
    assert.equal(await files().countDocuments({ parentFileId: p, faceEmbedding: { $exists: true } }), 1);
  });

  it('a faces-only re-run whose claim was revoked stops before the decode and makes no detect call', async () => {
    const p = 'revoked.png';
    await seedParent(p);
    const claim = await seedClaim(S, p);
    await revoke(S, p);
    const before = runs.face.calls.length;
    await assert.rejects(() => embedFaces(S, p, handleOf('revoked.png'), { claim, facesOnly: true }),
      (err) => isAbandonment(err), 'a run without its claim must stop as an abandonment');
    assert.equal(runs.face.calls.length - before, 0,
      `the face provider was asked ${runs.face.calls.length - before} time(s) by a run whose claim was already gone: a decode and a detect call for nothing`);
    assert.equal(await files().countDocuments({ parentFileId: p, faceEmbedding: { $exists: true } }), 0, 'a face row was written without the claim');
  });
});
