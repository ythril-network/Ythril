/**
 * A space's recorded RDF base conflict leaves with the space (bundle-269, review finding 1).
 *
 * ## What it holds
 *
 * `NetworkConfig.rdfBaseConflicts` is keyed by the LOCAL id of a space, like the network's schema layers and membership origins, so it has
 * the same life as they have:
 *
 * - **Leaving the network removes it.** A space taken out of its network (a passed `space_deletion` round, a subscriber deleting its own
 *   copy) keeps no conflict of that network: the export of a space that is no longer carried is served, and nothing is left to clear (an
 *   accept needs a networked space). A space created later under the same id starts without a conflict.
 * - **The reading asks the network that carries the space.** An entry a network keeps for a space it does not carry (a config an older
 *   build wrote, a hand edit) is no conflict.
 *
 * The rename's half is `a-rename-moves-the-recorded-rdf-base-conflict.test.js`.
 *
 * Run: node --test testing/standalone/a-recorded-rdf-base-conflict-leaves-with-its-space.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const settle = await import('../../server/dist/spaces/rdf-settle.js');
const { takeSpaceOutOfNetwork } = await import('../../server/dist/networks/take-space-out-of-network.js');

const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const OFFERED = 'https://one.example.org/ld/notes/';
const netOf = (id, spaces) => ({ id, label: id, type: 'closed', spaces: [...spaces], members: [{ instanceId: 'p1' }], pendingRounds: [] });
const spacesOf = (...ids) => ids.map(id => ({ id, label: id, meta: { rdf: OLD } }));
const offer = (space) => ({ [space]: { base: OFFERED, vocab: `${OFFERED}vocab/`, baseEpoch: 1 } });

/** A network carrying `space`, with the conflict a member's higher base made. */
function conflicted(space = 'notes', id = 'net-1') {
  const net = netOf(id, [space]);
  assert.equal(settle.takeServedRdfBases(net, spacesOf(space), offer(space), 'p1'), true, 'the fixture recorded no conflict');
  assert.ok(settle.rdfBaseConflictOf({ networks: [net] }, space), 'the fixture\'s conflict is not read');
  return net;
}

describe('leaving the network removes the recorded conflict', () => {
  it('a space taken out of its network is no longer in conflict', () => {
    const net = conflicted();
    assert.equal(takeSpaceOutOfNetwork(net, 'notes').carried, true);
    assert.equal(net.rdfBaseConflicts, undefined, `the network kept the conflict of a space it no longer carries: ${JSON.stringify(net.rdfBaseConflicts)}`);
    assert.equal(settle.rdfBaseConflictOf({ networks: [net] }, 'notes'), undefined, 'the export of a space that left its network still answers rdf_base_conflict');
  });

  it('only the conflict of that space goes, and only on that network', () => {
    const net = conflicted('notes', 'net-1');
    const other = conflicted('notes', 'net-2');
    net.spaces.push('plain');
    net.rdfBaseConflicts = { ...net.rdfBaseConflicts, plain: { held: { base: OLD.base, vocab: OLD.vocab, epoch: 0 }, offered: [{ networkId: 'net-1', memberId: 'p1', base: OFFERED, vocab: `${OFFERED}vocab/`, epoch: 1 }] } };
    takeSpaceOutOfNetwork(net, 'notes');
    assert.deepEqual(Object.keys(net.rdfBaseConflicts ?? {}), ['plain'], 'the leave took another space\'s conflict, or none');
    assert.ok(other.rdfBaseConflicts?.notes, 'the leave reached into another network');
    assert.ok(settle.rdfBaseConflictOf({ networks: [net, other] }, 'notes'), 'a conflict of another network that still carries the space was lost');
  });

  it('a space created later under the same id starts without a conflict', () => {
    const net = conflicted();
    takeSpaceOutOfNetwork(net, 'notes');
    net.spaces.push('notes');
    assert.equal(settle.rdfBaseConflictOf({ networks: [net] }, 'notes'), undefined, 'a recreated id inherited the old refusal');
  });
});

describe('the reading asks a network that carries the space', () => {
  it('an entry of a network that does not carry the space is no conflict', () => {
    const net = conflicted();
    net.spaces = [];
    assert.equal(settle.rdfBaseConflictOf({ networks: [net] }, 'notes'), undefined, 'the reading answered for a network that carries no such space');
  });

  it('the network that does carry it still answers while another holds a stale entry', () => {
    const carrying = conflicted('notes', 'net-1');
    const stale = conflicted('notes', 'net-2');
    stale.spaces = [];
    const read = settle.rdfBaseConflictOf({ networks: [stale, carrying] }, 'notes');
    assert.deepEqual(read?.offered.map(o => o.networkId), ['net-1']);
  });
});
