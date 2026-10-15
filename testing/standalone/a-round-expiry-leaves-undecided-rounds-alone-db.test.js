/**
 * The expiry tick does not evaluate an undecided round for passing: rounds open at the upgrade run to their deadline and expire (bundle-106 R-D39;
 * design v5 section 4.2, owner decision D-39 = C, 2026-10-15).
 *
 * ## The rule, and why it is the owner's
 *
 * Acting at open (Q-453) changes WHEN a network deletes or empties data. A round a previous release left open — quorum held, deadline not yet reached —
 * must NOT be settled by the first tick after the upgrade: that would delete data an operator proposed under rules that never promised it. The owner's
 * answer is that such rounds run to their deadline and expire, and operators propose again. So: within its deadline the tick leaves the round OPEN and
 * SAVES NOTHING (counted through the write generation, never an mtime or a spy on an ESM export); past its deadline it concludes `expired` and
 * acts on nothing.
 *
 * ## What is red at the base commit, and what is a control
 *
 * The round's own state holds at the base commit (its tick already leaves an undecided round alone). What is red there is the way a save is counted:
 * `configWriteGeneration`, a read-only export beside the loader's `_writeGeneration`, which the design names for exactly this assertion.
 *
 * Run: node --test testing/standalone/a-round-expiry-leaves-undecided-rounds-alone-db.test.js
 * (requires a prior server build and the test MongoDB: `npm run test:up`)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { removeInstanceDir } from './_vote-round-instance.mjs';
import { SELF, M1, tempInstance, networkOf, boot, seedFacts, factCount, requireExport, roundsOf, databaseTakesCollections } from './_round-open-fixtures.mjs';

const dir = tempInstance('ythril-expiry-d39-');
const skip = await mongoSkipReason();
const HOUR = 3_600_000;

describe('D-39 = C: an undecided round runs to its deadline', { skip }, () => {
  let mongo;
  before(async () => { mongo = await openTestMongo('expiry_d39'); await databaseTakesCollections(mongo); });
  after(async () => { await closeTestMongo(); removeInstanceDir(dir); });

  /** A round an OLDER release left open on a club: this instance proposed it, its own yes is in, the quorum is held, the deadline is not reached. */
  const olderRelease = (type) => ({
    roundId: 'old-1', type, spaceId: 'notes', networkSpaceId: 'notes', subjectInstanceId: SELF, subjectLabel: 'self', subjectUrl: '',
    openedAt: new Date(Date.now() - HOUR).toISOString(), deadline: new Date(Date.now() + 23 * HOUR).toISOString(),
    votes: [{ instanceId: SELF, vote: 'yes', castAt: new Date(Date.now() - HOUR).toISOString() }], concluded: false, proposedHere: true,
  });

  for (const type of ['space_wipe', 'space_deletion']) {
    it(`${type}: within its deadline the tick leaves it open, applies nothing and saves nothing; past its deadline it expires and acts on nothing`, async () => {
      const configWriteGeneration = await requireExport('../../server/dist/config/loader.js', 'configWriteGeneration', 'design v5 section 6.1: a read-only export of the write generation — a save is counted through it');
      const loader = await boot(dir, { spaces: ['notes'], networks: [networkOf('club', [M1], { spaces: ['general', 'notes'], extra: { pendingRounds: [olderRelease(type)] } })] });
      await seedFacts(mongo, 'notes', 3, type);
      const { runRoundExpiryTick } = await import('../../server/dist/networks/round-expiry.js');
      const before = configWriteGeneration();
      runRoundExpiryTick(Date.now());
      runRoundExpiryTick(Date.now() + 5 * HOUR);
      const [round] = roundsOf(loader, 'net-1', type);
      assert.deepEqual({ concluded: round.concluded === true, applied: round.appliedHere === true }, { concluded: false, applied: false },
        'the tick evaluated an undecided round for passing: it settled a vote nobody asked it to settle');
      assert.equal(configWriteGeneration() - before, 0, 'the tick saved the config though nothing changed');
      assert.equal(await factCount(mongo, 'notes'), 3);
      runRoundExpiryTick(Date.now() + 24 * HOUR);
      assert.deepEqual({ concluded: round.concluded, passed: round.passed, outcome: round.outcome }, { concluded: true, passed: false, outcome: 'expired' });
      assert.equal(await factCount(mongo, 'notes'), 3, 'an expired round acted on the data');
      assert.ok(loader.getConfig().spaces.some(s => s.id === 'notes'));
    });
  }
});
