/**
 * Database-level test: the audit change-retention sweep says its first pass once, and says it again once it has been stopped
 * (`Q-317`, bundle-53 G23).
 *
 * ## What it pins
 *
 * The first sweep of a process reports even when it redacted nothing, and names the collection it swept: a sweep that speaks only
 * on success is indistinguishable from one pointed at a collection that does not exist (`audit-retention-targets-the-audit-log`).
 * That "once per process" was a hand-written boolean (`_announced`) that `stopAuditChangeRetention` reset by hand. It is a
 * `warnOnce` now, forgotten in `stop`. The behaviour is the same, and that is the point of this file: the module a latch moved
 * into must keep saying it exactly once, and again after a stop, which a test that restarts the sweep in one process relies on.
 *
 * Run: `npm run test:up` first, then  node --test testing/standalone/audit-change-retention-announces-its-first-sweep-once-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { eventually } from './_write-faults.mjs';

const skip = await mongoSkipReason();

let retention;
const lines = [];
let unsubscribe = () => {};

const announcements = () => lines.filter(l => l.includes('Audit change-retention: sweeping'));

describe('the audit change-retention sweep announces its first pass once (real MongoDB)', { skip }, () => {
  before(async () => {
    await openTestMongo('g23retention');
    retention = await import('../../server/dist/audit/change-retention.js');
    const { subscribeLogLines } = await import('../../server/dist/util/log.js');
    unsubscribe = subscribeLogLines(l => lines.push(l));
  });

  after(async () => {
    unsubscribe();
    retention?.stopAuditChangeRetention();
    await closeTestMongo();
  });

  beforeEach(() => { lines.length = 0; });

  it('names the collection on the first sweep even when nothing was redacted, and not again on the next', async () => {
    retention.stopAuditChangeRetention();           // a clean latch, whichever case ran before
    assert.equal(await retention.redactExpiredChanges(), 0);
    assert.ok(await eventually(() => announcements().length === 1, 3000), `no announcement: ${lines.join(' | ')}`);
    assert.match(announcements()[0], /audit_log/);

    assert.equal(await retention.redactExpiredChanges(), 0);
    assert.equal(await retention.redactExpiredChanges(), 0);
    await new Promise(r => setTimeout(r, 200));      // an announcement that was going to arrive late has had its chance
    assert.equal(announcements().length, 1, `a later sweep announced again: ${announcements().join(' | ')}`);
  });

  it('says it again after the sweep was stopped', async () => {
    retention.stopAuditChangeRetention();
    assert.equal(await retention.redactExpiredChanges(), 0);
    assert.ok(await eventually(() => announcements().length === 1, 3000), `no announcement after stop: ${lines.join(' | ')}`);
  });
});
