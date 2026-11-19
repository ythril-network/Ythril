/**
 * The RDF bases peers of a voted network offer are kept per offering member, dropped when that member stops offering or leaves, and
 * bounded, so no single peer can plant a conflict that never clears or an epoch that makes rebasing impossible (Q-748, slice A-fix,
 * review finding 8).
 *
 * - Two members offering two bases are both recorded, each under its member; taking the same answers again changes nothing, so the
 *   config is not saved on every sync.
 * - A member's offer is dropped when that member serves an equal or lower epoch with the held names (it corrected itself, or the member
 *   moved), or leaves the network; the conflict stands while any offer stands.
 * - The conflict the doors read lists only offers a current member still makes, so an admin can accept only such an offer.
 * - An offered epoch above `RDF_OFFERED_EPOCH_MAX`, a bound derived from the schema's maximum and well below it (a rebase after an accept
 *   stays possible), is refused as invalid.
 *
 * Run: node --test testing/standalone/an-offered-rdf-base-is-kept-per-member-and-bounded.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const settle = await import('../../server/dist/spaces/rdf-settle.js');
const { RDF_BASE_EPOCH_MAX } = await import('../../schema/dist/index.js');

const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const B1 = 'https://one.example.org/ld/notes/';
const B2 = 'https://two.example.org/ld/notes/';
const net = () => ({ id: 'net-1', type: 'closed', spaces: ['notes'], members: [{ instanceId: 'p1' }, { instanceId: 'p2' }], pendingRounds: [] });
const spaces = [{ id: 'notes', label: 'Notes', meta: { rdf: OLD } }];
const offer = (base, baseEpoch = 1) => ({ notes: { base, vocab: `${base}vocab/`, baseEpoch } });
const offeredBases = (n) => (n.rdfBaseConflicts?.notes?.offered ?? []).map(o => `${o.memberId}:${o.base}`).sort();

describe('offers are kept per member', () => {
  it('two members offering two bases are both recorded; the same answers again change nothing', () => {
    const n = net();
    assert.equal(settle.takeServedRdfBases(n, spaces, offer(B1), 'p1'), true);
    assert.equal(settle.takeServedRdfBases(n, spaces, offer(B2), 'p2'), true);
    assert.deepEqual(offeredBases(n), [`p1:${B1}`, `p2:${B2}`], `the second peer's offer replaced the first: ${JSON.stringify(n.rdfBaseConflicts)}`);
    assert.equal(settle.takeServedRdfBases(n, spaces, offer(B1), 'p1'), false, 'an unchanged offer reads as a change (a save per sync)');
    assert.equal(settle.takeServedRdfBases(n, spaces, offer(B2), 'p2'), false);
  });
  it('a member serving the held names drops its offer; the conflict stands while another stands', () => {
    const n = net();
    settle.takeServedRdfBases(n, spaces, offer(B1), 'p1');
    settle.takeServedRdfBases(n, spaces, offer(B2), 'p2');
    assert.equal(settle.takeServedRdfBases(n, spaces, { notes: { base: OLD.base, vocab: OLD.vocab, baseEpoch: 0 } }, 'p1'), true);
    assert.deepEqual(offeredBases(n), [`p2:${B2}`]);
    settle.takeServedRdfBases(n, spaces, { notes: { base: OLD.base, vocab: OLD.vocab, baseEpoch: 0 } }, 'p2');
    assert.equal(n.rdfBaseConflicts, undefined, 'the conflict outlived every offer');
  });
  it('a member that leaves takes its offer with it', () => {
    const n = net();
    settle.takeServedRdfBases(n, spaces, offer(B1), 'p1');
    n.members = n.members.filter(m => m.instanceId !== 'p1');
    assert.equal(settle.rdfBaseConflictOf({ networks: [n] }, 'notes'), undefined, 'the doors still read an offer of a member that left');
    settle.takeServedRdfBases(n, spaces, {}, 'p2');
    assert.equal(n.rdfBaseConflicts, undefined, 'the left member\'s offer is still stored');
  });
});

describe('an offered epoch is bounded', () => {
  it('the bound is derived from the schema maximum and lies well below it', () => {
    assert.equal(typeof settle.RDF_OFFERED_EPOCH_MAX, 'number', 'rdf-settle exports no RDF_OFFERED_EPOCH_MAX');
    assert.ok(settle.RDF_OFFERED_EPOCH_MAX <= RDF_BASE_EPOCH_MAX / 2, `${settle.RDF_OFFERED_EPOCH_MAX} leaves no room to rebase after an accept`);
  });
  it('an offer above the bound is refused as invalid: no conflict', () => {
    const n = net();
    assert.equal(settle.takeServedRdfBases(n, spaces, offer(B1, RDF_BASE_EPOCH_MAX), 'p1'), false);
    assert.equal(n.rdfBaseConflicts, undefined, 'a peer planted a conflict at the schema maximum');
  });
});
