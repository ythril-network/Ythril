/**
 * A voted network's member records a peer's higher RDF base from the real wire and clears it when its admin accepts it (Q-748; owner,
 * 2026-11-19: "tell it, do not move it").
 *
 * Two configs' worth of state in one instance, as the gossip tests do it: the network `served` is the PEER's copy, whose vote list the REAL
 * route answers (`GET /api/sync/networks/:id/votes`, now with `rdfBases`); the network `receiver` is this member's, which the engine's own
 * gossip pass (`runSyncForPeer`) reads it into. Then:
 *
 * - the served list carries each shared space's `{ base, baseEpoch }` under the network's id for it, and nothing for a space with RDF off;
 * - after the pass the member holds its old base and a conflict beside `receiver` naming the offered base and epoch;
 * - the admin accepts the offered base (`PATCH` with that base and `rebase: true`): it lands here alone, at the offered epoch, with no round,
 *   and the conflict is gone; an accept of a base nobody offered is still a `space_rebase` vote.
 *
 * Run: node --test testing/standalone/a-voted-network-records-and-clears-a-higher-rdf-base-db.test.js (server build and the test MongoDB)
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { openTestMongo, closeTestMongo, mongoSkipReason } from './_mongo-harness.mjs';
import { tempInstanceDir, callRoute, startFakePeer, allowEngineToDialPrivatePeers, settled } from './_vote-round-instance.mjs';
import { privateAddressSkipReason } from './_private-address.mjs';
import { bootSchemaInstance } from './_schema-doors.mjs';
import { P1, P2 } from './_vote-round-sites.mjs';

const dir = tempInstanceDir('ythril-voted-rdf-base-');
const skip = (await mongoSkipReason()) || privateAddressSkipReason();
const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const NEW = { enabled: true, base: 'https://new.example.org/ld/notes/', vocab: 'https://new.example.org/ld/notes/vocab/', baseEpoch: 1 };
const HOUR = 3_600_000;
const member = (instanceId, extra = {}) => ({ instanceId, label: `m${instanceId.slice(-2)}`, url: `https://${instanceId.slice(-2)}.example`, tokenHash: 'h', direction: 'both', ...extra });

describe('a voted network records and clears a higher RDF base', { skip }, () => {
  let inst, peer, served;
  before(async () => {
    await openTestMongo('voted_rdf_base');
    allowEngineToDialPrivatePeers();
    let body = { rounds: [] };
    peer = await startFakePeer((method, url) => {
      if (method === 'GET' && /\/votes$/.test(url)) return { status: 200, body };
      if (method === 'POST') return { status: 200, body: { status: 'ok' } };
      return undefined;
    });
    inst = await bootSchemaInstance(dir, {
      spaces: [
        { id: 'notes', label: 'Notes', folders: [], meta: { rdf: OLD } },
        { id: 'peer-notes', label: 'Peer notes', folders: [], meta: { rdf: NEW } },
        { id: 'peer-plain', label: 'Peer plain', folders: [], meta: {} },
      ],
      networks: [
        {
          id: 'receiver', label: 'Receiver', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['notes'], votingDeadlineHours: 24,
          createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [],
          // Below the version floor, so the cycle ends once governance has been exchanged and never reaches the data plane.
          members: [member(P1, { url: peer.url, version: '1.0.0', versionCheckedAt: new Date(Date.now() - HOUR).toISOString() })],
        },
        {
          id: 'served', label: 'Served', type: 'closed', origin: 'created', syncSchedule: '', spaces: ['peer-notes', 'peer-plain'], votingDeadlineHours: 24,
          createdAt: '2026-01-01T00:00:00.000Z', pendingRounds: [], members: [member(P2)],
          // The peer calls its space by the network's id `notes`, as the receiver does.
          spaceMap: { notes: 'peer-notes', plain: 'peer-plain' },
        },
      ],
    });
    inst.loader.saveSecrets({ peerTokens: { [P1]: 'token-p1' } });
    const { syncVotesRouter } = await import('../../server/dist/api/sync/votes.js');
    served = await callRoute(syncVotesRouter, 'get', '/networks/:networkId/votes', { params: { networkId: 'served' }, authToken: { peerInstanceId: P2 } });
    body = served.body;
  });
  after(async () => {
    await peer?.close();
    inst?.close();
    await closeTestMongo();
  });

  const receiver = () => inst.loader.getConfig().networks.find(n => n.id === 'receiver');
  const rdfOf = () => inst.loader.getConfig().spaces.find(s => s.id === 'notes').meta.rdf;

  it('the served vote list carries each shared space\'s base and epoch under the network\'s id, and none for RDF off', () => {
    assert.equal(served.code, 200, JSON.stringify(served.body));
    assert.deepEqual(served.body.rdfBases, { notes: { base: NEW.base, vocab: NEW.vocab, baseEpoch: 1 } });
  });

  it('after a gossip pass the member keeps its base and records the conflict beside the network', async () => {
    const { runSyncForPeer } = await import('../../server/dist/sync/engine.js');
    await runSyncForPeer(P1);
    const conflict = await settled(() => receiver().rdfBaseConflicts ?? null);
    assert.deepEqual(conflict, { notes: { held: { base: OLD.base, vocab: OLD.vocab, epoch: 0 }, offered: [{ networkId: 'receiver', memberId: P1, base: NEW.base, vocab: NEW.vocab, epoch: 1 }] } });
    assert.deepEqual(rdfOf(), OLD, 'nothing lands by itself');
  });

  it('a base nobody offered is still a space_rebase vote', async () => {
    const other = await inst.doors['space-patch']('notes', { rdf: { enabled: true, base: 'https://third.example.org/ld/notes/', rebase: true } });
    assert.equal(other.refused, false, other.text.slice(0, 300));
    assert.ok(receiver().pendingRounds.some(r => r.type === 'space_rebase'), 'no round was opened');
    assert.deepEqual(rdfOf(), OLD);
    receiver().pendingRounds = [];
  });

  it('the admin accepts the offered base: it lands here alone at the offered epoch, and the conflict is gone', async () => {
    // The peer's copy lives in this instance too, and an instance refuses a base another of its spaces holds with RDF on
    // (`409 rdf_base_shared`, slice F): the copy has served its list, so its RDF goes off before the accept. Set on the live config, as the
    // peer's own state is planted: a door's write to a space of the voted network `served` is a vote there, and a reload from the file
    // would drop the conflict the gossip pass recorded in memory.
    inst.loader.getConfig().spaces.find(s => s.id === 'peer-notes').meta.rdf.enabled = false;
    const accepted = await inst.doors['space-patch']('notes', { rdf: { enabled: true, base: NEW.base, rebase: true } });
    assert.equal(accepted.refused, false, accepted.text.slice(0, 300));
    assert.deepEqual(rdfOf(), { enabled: true, base: NEW.base, vocab: NEW.vocab, baseEpoch: 1 });
    assert.equal(receiver().rdfBaseConflicts, undefined);
    assert.equal(receiver().pendingRounds.filter(r => r.type === 'space_rebase').length, 0, 'an accept opened a round');
  });
});
