/**
 * A planned write whose bulk write the write bound ENDED is the store's failure, answered as one — never a
 * per-item "did not complete" (bundle-30, finding (b) of stage I1).
 *
 * ## The defect
 *
 * `commitPlans` (`brain/write-plan/commit.ts`) runs each stage's bulk write inside its seq hold, which the write bound
 * ends (`db/write-bound.ts`, `Q-213`). It caught EVERY bulk failure there, and one with no per-item detail was read
 * as "ambiguous": the stage was read back after the hold, and an item that had not landed was answered
 * `{ ok: false, reason: "did not complete" }`. So a write the store could not finish in time — the one failure every
 * door answers `503 retryable` (`brain/store-failure.ts`) — reached a caller as an item-level refusal of its own
 * record, through a read-back that ran after the hold's deadline, unbounded.
 *
 * ## The rule
 *
 * While nothing of the request has landed, a stage whose write the bound ended THROWS that timeout, so the door
 * classifies it like every other store timeout. (After an earlier stage landed, the module's own promise wins: a
 * stored record reported failed invites a duplicating resend, so the stage is read back as before.)
 *
 * The stall is REAL (`_write-faults.mjs holdDocumentLock`): another session's open transaction holds the record a
 * converge is about to update, so the bulk write waits on its lock until the bound (set to 2 s) ends it.
 *
 * Run: a Mongo the harness accepts (see `_mongo-harness.mjs`), then
 *      node --test testing/standalone/a-planned-write-the-bound-ended-is-a-store-timeout-db.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { holdDocumentLock, settleWithin, setWriteBoundForTest } from './_write-faults.mjs';

const skip = await mongoSkipReason();
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ythril-planned-timeout-'));
process.env['CONFIG_PATH'] = path.join(tmpDir, 'config.json');
process.env['YTHRIL_MODELS_OFFLINE'] = '1';

const S = 'plannedtimeout';
const F = 'bbbbbbbb-0000-4000-8000-0000000000f1';
const BOUND = { writeTimeoutMs: 2000, holdDeadlineMs: 2000 };

let mongo, commit, writeTimeout, storeFailure, restoreBound = () => {};

describe('a planned write the bound ended is a store timeout', { skip }, () => {
  before(async () => {
    mongo = await openTestMongo('plannedtimeout');
    fs.writeFileSync(process.env['CONFIG_PATH'], JSON.stringify({
      instanceId: 'planned-timeout-test', instanceLabel: 'test', tokens: [], networks: [],
      spaces: [{ id: S, label: 'Planned timeout', folders: [], meta: { suppressEmbeddings: true } }],
    }, null, 2), { mode: 0o600 });
    (await import('../../server/dist/config/loader.js')).loadConfig();
    commit = await import('../../server/dist/brain/write-plan/commit.js');
    writeTimeout = await import('../../server/dist/db/write-timeout.js');
    storeFailure = await import('../../server/dist/brain/store-failure.js');
    await mongo.col(`${S}_facts`).insertOne({ _id: F, spaceId: S, fact: 'stored', tags: [], seq: 1 });
    await mongo.col('ythril_counters').updateOne({ _id: S }, { $set: { seq: 1 } }, { upsert: true });
    restoreBound = await setWriteBoundForTest(BOUND);
  });
  after(async () => {
    restoreBound();
    await closeTestMongo();
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it('the commit throws the timeout, which every door classifies as a retryable store failure', { timeout: 60_000 }, async () => {
    const plan = {
      kind: 'fact', spaceId: S, id: F, op: 'converge', set: { fact: 'changed' }, expectSeq: 1,
      result: { _id: F, fact: 'changed' }, enqueue: false, minted: false, dupeRules: false,
    };
    const lock = await holdDocumentLock(mongo, `${S}_facts`, { filter: { _id: F } });
    let res;
    try {
      res = await settleWithin(commit.commitPlans(S, [plan]), BOUND.holdDeadlineMs + 8_000);
    } finally {
      await lock.release();
    }
    if (!res.settled) await res.rest;
    assert.ok(res.settled, 'the stalled commit did not end within the bound at all');
    assert.equal(res.ok, false,
      `a write the bound ended was answered as an item outcome (${JSON.stringify(res.value)}) — the caller is told its `
      + 'record did not complete, where every door answers a store timeout 503 retryable');
    assert.ok(writeTimeout.isWriteTimeout(res.error), `the commit threw something other than the timeout: ${res.error}`);
    const f = storeFailure.classifyReadFailure(res.error);
    assert.deepEqual([f.status, f.retryable], [503, true], 'the timeout the commit threw is not answered 503 retryable');
  });
});
