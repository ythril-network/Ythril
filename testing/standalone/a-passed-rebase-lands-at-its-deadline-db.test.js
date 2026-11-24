/**
 * A passed `space_rebase` round lands at its deadline, never at its pass (Q-748, slice A, design r4 §4.1 rule 4; owner, 2026-11-18).
 *
 * The deadline is the members' time to leave: a member that leaves before it keeps its base (`leaveNetworkAct` removes the network and
 * its rounds, so nothing is applied there). So on a club network, where the proposer's yes passes a round at once:
 *
 * - the round passes at open and the base is unchanged before the deadline, however many expiry ticks run;
 * - the first tick past the deadline sets base, vocab and epoch, marks the round `appliedHere`, and writes ONE `space.rdf_rebase` audit
 *   row naming the round; a second tick changes nothing and writes no second row;
 * - a restart between the pass and the deadline (the config read back from disk) still applies it, once: the owed application is the
 *   round in the network config, not something held in memory;
 * - the prune keeps a passed, unapplied rebase round past its deadline (`rebaseRoundUnapplied`), and lets it go once applied;
 * - a round whose space this instance no longer carries is marked applied and moves nothing.
 *
 * Run: node --test testing/standalone/a-passed-rebase-lands-at-its-deadline-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { auditRowsOf, untilAuditWritesLanded } from './_audit-rows.mjs';
import { tempInstanceDir } from './_vote-round-instance.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { NET_ID, P1 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-rdf-rebase-deadline-');
const skip = await mongoSkipReason();
const SPACE = 'shared';
const OLD = { enabled: true, base: 'https://old.example.org/ld/shared/', vocab: 'https://old.example.org/ld/shared/vocab/', baseEpoch: 0 };
const NEW_BASE = 'https://new.example.org/ld/shared/';
const HOUR = 3_600_000;

const network = () => ({
  id: NET_ID, label: 'Net', type: 'club', origin: 'created', syncSchedule: '', spaces: [SPACE], votingDeadlineHours: 24,
  createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
  members: [{ instanceId: P1, label: 'Peer', url: 'https://a1.example', tokenHash: 'h', direction: 'both' }],
});

describe('a passed rebase lands at its deadline', { skip }, () => {
  let inst, mongo, expiry, retention, roundState;
  before(async () => {
    mongo = await openTestMongo('rdf_rebase_deadline');
    inst = await bootSchemaInstance(dir, {
      spaces: [{ id: SPACE, label: 'Shared', folders: [], meta: { rdf: OLD } }],
      networks: [network()],
    });
    expiry = await import('../../server/dist/networks/round-expiry.js');
    retention = await import('../../server/dist/sync/vote-round-retention.js');
    roundState = await import('../../server/dist/networks/round-state.js');
  });
  after(async () => {
    inst?.close();
    await closeTestMongo();
  });

  const netOf = () => inst.loader.getConfig().networks.find(n => n.id === NET_ID);
  const rdfOf = () => inst.loader.getConfig().spaces.find(s => s.id === SPACE)?.meta?.rdf;
  const rebaseRound = () => netOf().pendingRounds.find(r => r.type === 'space_rebase');
  const auditRows = () => auditRowsOf(mongo, { operation: 'space.rdf_rebase' });
  async function propose() {
    inst.reset();
    netOf().pendingRounds = [];
    await untilAuditWritesLanded();
    await mongo.getDb().collection('audit_log').deleteMany({});
    const answer = await inst.doors['space-patch'](SPACE, { rdf: { enabled: true, base: NEW_BASE, rebase: true } });
    assert.equal(answer.refused, false, answer.text.slice(0, 300));
    const round = rebaseRound();
    assert.ok(round, `no space_rebase round was opened: ${JSON.stringify(netOf().pendingRounds).slice(0, 300)}`);
    assert.equal(round.passed, true, 'a club round passes on the proposer\'s yes at open');
    return round;
  }

  it('the predicates exist: unapplied, and owed once the deadline has come', () => {
    assert.equal(typeof roundState.rebaseRoundUnapplied, 'function', 'round-state exports no rebaseRoundUnapplied');
    assert.equal(typeof roundState.rebaseRoundOwed, 'function', 'round-state exports no rebaseRoundOwed');
  });

  it('nothing moves before the deadline; the first tick after it applies, marks and audits once', async () => {
    const round = await propose();
    const deadline = Date.parse(round.deadline);
    expiry.runRoundExpiryTick(deadline - HOUR);
    assert.deepEqual(rdfOf(), OLD, 'the base moved before the deadline');
    assert.equal(roundState.rebaseRoundOwed(round, deadline - HOUR), false);
    assert.equal(roundState.rebaseRoundOwed(round, deadline + 1), true);
    expiry.runRoundExpiryTick(deadline + 1);
    assert.deepEqual(rdfOf(), { enabled: true, base: NEW_BASE, vocab: `${NEW_BASE}vocab/`, baseEpoch: 1 });
    const rows = await auditRows();
    assert.equal(rows.length, 1, `one space.rdf_rebase row: ${JSON.stringify(rows)}`);
    assert.equal(rows[0].spaceId, SPACE);
    assert.ok(String(rows[0].path).includes(round.roundId), rows[0].path);
    expiry.runRoundExpiryTick(deadline + 2);
    assert.equal((await auditRows()).length, 1, 'a second tick wrote a second row');
    assert.equal(rdfOf().baseEpoch, 1);
  });

  it('a restart between the pass and the deadline still applies it once', async () => {
    const round = await propose();
    const deadline = Date.parse(round.deadline);
    await inst.loader.flushConfig();
    inst.loader.loadConfig();
    assert.equal(rebaseRound()?.roundId, round.roundId, 'the round is in the config read back');
    expiry.runRoundExpiryTick(deadline + 1);
    assert.equal(rdfOf().base, NEW_BASE);
    assert.equal((await auditRows()).length, 1);
  });

  it('the prune keeps a passed, unapplied rebase round past its deadline and lets it go once applied', async () => {
    const round = await propose();
    const deadline = Date.parse(round.deadline);
    const net = netOf();
    assert.equal(retention.pruneExpiredRounds(net, deadline + 1), 0, 'the owed round was pruned before it was applied');
    assert.ok(rebaseRound(), 'the round is still held');
    expiry.runRoundExpiryTick(deadline + 1);
    assert.equal(rebaseRound(), undefined, 'the applied round was pruned by the same tick, its outcome recorded');
    assert.equal(rdfOf().base, NEW_BASE);
  });

  // Review finding 13 (slice A-fix): the round was marked landed BEFORE its store, so a store that failed left the base unmoved for good.
  it('a store that fails leaves the round owed, and the next tick lands it', async () => {
    const round = await propose();
    const deadline = Date.parse(round.deadline);
    const space = inst.loader.getConfig().spaces.find(s => s.id === SPACE);
    space.ownMeta = { rdf: OLD };
    let real = space.meta;
    let faults = 1;
    Object.defineProperty(space, 'meta', {
      configurable: true, enumerable: true,
      get() { if (faults > 0) { faults -= 1; throw new Error('a store fault'); } return real; },
      set(v) { real = v; },
    });
    expiry.runRoundExpiryTick(deadline + 1);
    assert.notEqual(rebaseRound()?.appliedHere, true, 'a failed store marked the round landed');
    assert.equal(rdfOf().base, OLD.base);
    expiry.runRoundExpiryTick(deadline + 2);
    Object.defineProperty(space, 'meta', { configurable: true, enumerable: true, writable: true, value: real });
    assert.equal(rdfOf().base, NEW_BASE, 'the owed round was not landed by the next tick');
    assert.equal((await auditRows()).length, 1);
  });

  it('a store that can never succeed concludes the round as failed, audited, never as landed', async () => {
    const round = await propose();
    const deadline = Date.parse(round.deadline);
    // A base no stored meta can hold (a space in it): the parse of the moved setting fails, now and on every later tick.
    round.rebase = { ...round.rebase, base: 'https://new.example.org/ld/sh ared/' };
    expiry.runRoundExpiryTick(deadline + 1);
    assert.deepEqual(rdfOf(), OLD);
    assert.equal((await auditRows()).length, 0, 'a failed landing was audited as a landing');
    const failed = await auditRowsOf(mongo, { operation: 'space.rdf_rebase_failed' });
    assert.equal(failed.length, 1, `the failed landing was not audited: ${JSON.stringify(failed)}`);
    assert.ok(String(failed[0].path).includes(round.roundId), failed[0].path);
  });

  it('a round for a space this instance no longer carries is marked applied and moves nothing', async () => {
    const round = await propose();
    const deadline = Date.parse(round.deadline);
    round.spaceId = 'a-space-not-carried-here';
    expiry.runRoundExpiryTick(deadline - HOUR);
    const net = netOf();
    assert.equal(retention.pruneExpiredRounds(net, deadline - HOUR), 0);
    expiry.runRoundExpiryTick(deadline + 1);
    assert.deepEqual(rdfOf(), OLD);
    assert.equal((await auditRows()).length, 0);
  });
});
