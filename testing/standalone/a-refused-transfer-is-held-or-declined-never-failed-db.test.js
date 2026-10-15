/**
 * A sender that is refused a space with `423` records the space as HELD or DECLINED - never as a failed transfer - and a declined space is not asked for again
 * (bundle-106, §3.3 v4 (1) W9, §2.9 v5 (1)(2) X10, R-W9, the transport half of R-X10).
 *
 * ## What was true before
 *
 * A non-2xx on any transfer counts that transfer incomplete, `runSyncForMember` throws on `incomplete`, and the member's failure counter moves: ONE held space
 * failed the whole member's cycle for EVERY space, did not write `lastSyncAt`, and after `STALE_FAILURE_THRESHOLD` such cycles logged `PEER UNREACHABLE` - an
 * alarm for a space that was merely held.
 *
 * ## What holds now
 *
 * - **R-W9 (the sender's side)** a peer answering `423 space_held` for a space on its page, manifest and file-tombstone doors: the cycle is `success`, the
 *   history row names the space under `held`, the failure counter does not move, `lastSyncAt` is written, and the space still carried is exchanged as ever.
 * - **R-X10 (transport)** a peer answering `423 space_declined`: the sender records the decline on the member (`declinedSpaces`), writes it on the row's own
 *   `declined` list (never `held`), counts no failure - and the NEXT cycle makes no request for the space to that member at all. Its positive twin: lift the
 *   decline and the very next cycle asks again. (What lifts it - a re-announce, a re-join - is the round-state slice's; this file holds only that the loop reads it.)
 *
 * ## Seen red
 *
 * At a638e702 the 423 is a failed transfer: the cycle throws (errors 1), the row is not `success`, `consecutiveFailures` moves and `lastSyncAt` is not written.
 * After the fix, by hand: classify `423` as failed -> R-W9 red; classify `space_declined` as `held` -> the `declined` and the no-request rows red. The carried space
 * exchanged in the same cycle is the control that keeps the absence meaningful.
 *
 * Run: a Mongo the harness accepts, then node --test testing/standalone/a-refused-transfer-is-held-or-declined-never-failed-db.test.js
 */
import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { mongoSkipReason } from './_mongo-harness.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { build } from './_push-door.mjs';
import { openPullDoor, PEER_AUTHOR } from './_pull-door.mjs';
import { waitFor } from '../_shared/wait-for.mjs';

const skip = (await mongoSkipReason()) || privateAddressSkipReason();

const REFUSED = 'refusedsp';
const FREE = 'refusedfree';

let door, loader, engine, asked, refusal;

/** Install the peer's behaviour: the refused space answers `refusal` on every transfer door, the other is served by the real handlers. Reset clears every hook, so each case installs them. */
function installPeer() {
  const refuse = (res) => res.status(423).json({ error: 'scripted refusal', code: refusal });
  door.state.family = async (req, res, family) => {
    asked.push(req.query.spaceId);
    if (req.query.spaceId === REFUSED && refusal) { refuse(res); return; }
    await door.serveFamily(req, res, family);
  };
  door.state.manifest = async (req, res) => {
    asked.push(req.query.spaceId);
    if (req.query.spaceId === REFUSED && refusal) { refuse(res); return; }
    res.json({ manifest: [], spaceId: req.query.spaceId });
  };
  door.state.fileTombstoneGet = async (req, res) => {
    asked.push(req.query.spaceId);
    if (req.query.spaceId === REFUSED && refusal) { refuse(res); return; }
    res.json({ items: [], nextCursor: null });
  };
}

/** One real cycle through the network runner, and the history row it wrote. */
async function cycleRow() {
  const since = new Date().toISOString();
  const out = await engine.runSyncForNetwork(door.NET);
  await door.settled();
  let row;
  await waitFor(async () => {
    row = (await door.mongo.col('_sync_history').find({ networkId: door.NET, triggeredAt: { $gte: since } }).toArray())[0];
    return row !== undefined;
  }, 10_000, 100, undefined, { what: 'the sync history row of the cycle' });
  return { out, row };
}

describe('a refused transfer is held or declined, never failed', { skip }, () => {
  before(async () => {
    door = await openPullDoor({ suite: 'refused', spaces: [REFUSED, FREE], type: 'club', direction: 'both', files: true });
    loader = await import('../../server/dist/config/loader.js');
    engine = await import('../../server/dist/sync/engine.js');
  });
  after(async () => { await door?.close(); });

  beforeEach(async () => {
    await door.reset();
    asked = [];
    refusal = undefined;
    loader.mutateConfig((cfg) => {
      const net = cfg.networks.find(n => n.id === door.NET);
      net.pendingRounds = []; net.spaces = [REFUSED, FREE];
      delete net.members[0].declinedSpaces; net.members[0].consecutiveFailures = 0; delete net.members[0].lastSyncAt;
    });
    installPeer();
    for (const space of [REFUSED, FREE]) await door.seedPeerRecords(space, 'facts', [build.fact(space, `${space}-f`, 5, { author: PEER_AUTHOR })]);
  });

  it('R-W9: a 423 space_held for one space is a held space on a successful cycle, and the other space is exchanged', async () => {
    refusal = 'space_held';
    const before = Date.now();
    const { out, row } = await cycleRow();
    const net = loader.getConfig().networks.find(n => n.id === door.NET);
    const member = net.members[0];
    assert.equal(out.errors, 0, `the cycle failed: ${JSON.stringify(out)}`);
    assert.equal(row.status, 'success', `a held space made the cycle read ${JSON.stringify(row.status)}: ${JSON.stringify(row.error ?? row)}`);
    assert.ok((row.held ?? []).some(h => h.spaceId === REFUSED), `the history row does not name the held space (held: ${JSON.stringify(row.held)})`);
    assert.ok(!(row.declined ?? []).some(d => d.spaceId === REFUSED), 'a held space was recorded as declined');
    assert.equal(member.consecutiveFailures ?? 0, 0, 'a held space moved the member\'s failure counter: ten of them read PEER UNREACHABLE');
    assert.ok(Date.parse(member.lastSyncAt ?? '') >= before, 'lastSyncAt was not written for a cycle that only met a hold');
    assert.ok(asked.includes(FREE) && (await door.coll(FREE, 'facts').findOne({ _id: `${FREE}-f` })), 'the space that is not held was not exchanged: one held space failed the whole member\'s cycle');
  });

  it('R-X10: a 423 space_declined is recorded as a decline - not held, not failed - and the next cycle makes no request for the space', async () => {
    refusal = 'space_declined';
    const first = await cycleRow();
    const member = () => loader.getConfig().networks.find(n => n.id === door.NET).members[0];
    assert.equal(first.out.errors, 0, `the cycle failed: ${JSON.stringify(first.out)}`);
    assert.equal(first.row.status, 'success');
    assert.ok((first.row.declined ?? []).some(d => d.spaceId === REFUSED), `the history row has no declined entry for the space (declined: ${JSON.stringify(first.row.declined)}, held: ${JSON.stringify(first.row.held)})`);
    assert.ok(!(first.row.held ?? []).some(h => h.spaceId === REFUSED), 'a decline was listed as a hold: its alert would never end');
    assert.ok((member().declinedSpaces ?? []).length > 0, `the member's record carries no declined space: ${JSON.stringify(member().declinedSpaces)}`);
    assert.equal(member().consecutiveFailures ?? 0, 0, 'a decline moved the failure counter');

    asked.length = 0;
    const second = await cycleRow();
    assert.equal(second.out.errors, 0);
    assert.ok(asked.includes(FREE), 'the positive twin failed: the second cycle did not exchange the carried space, so an absence for the declined one means nothing');
    assert.ok(!asked.includes(REFUSED), 'the publisher asked a member that declined the space for it again, every cycle, for ever (it should hear nothing)');
  });

  it('R-X10 twin: with the decline lifted, the very next cycle asks for the space again', async () => {
    refusal = 'space_declined';
    await cycleRow();
    loader.mutateConfig((cfg) => { delete cfg.networks.find(n => n.id === door.NET).members[0].declinedSpaces; });
    refusal = undefined;
    asked.length = 0;
    const { out } = await cycleRow();
    assert.equal(out.errors, 0);
    assert.ok(asked.includes(REFUSED), 'the space is never asked for again after its decline was lifted: the decline is read from somewhere that is never cleared');
  });
});
