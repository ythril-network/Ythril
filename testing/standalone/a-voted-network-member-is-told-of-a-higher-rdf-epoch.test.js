/**
 * On a voted network (closed, club, democratic) a member that missed a passed rebase is TOLD, never moved (Q-748; owner, 2026-11-19:
 * option (b), "tell it, do not move it").
 *
 * Voted networks pull no schema layer, so a member away for a rebase round's whole voting period never adopts the round and never sees the new
 * base. So every member serves each shared space's `{ base, baseEpoch }` beside its vote list (`rdfBases`, keyed by the network's id for the
 * space), and `takeServedRdfBases(net, spaces, served)` (`spaces/rdf-settle.ts`) compares:
 *
 * - a peer offering a HIGHER epoch with another base records a conflict beside that network (`NetworkConfig.rdfBaseConflicts`), naming it;
 *   the member's own base does not move;
 * - a peer offering a lower or equal epoch changes nothing, and an older build that serves no `rdfBases` causes no conflict and no error;
 * - what a peer serves is read by the setting's own validators and bounded before anything is stored: a value no door would accept is left out;
 * - a space this member does not carry, or carries with RDF off, is not touched;
 * - a recorded conflict clears once the member's own epoch reaches the offered one (an accepted base, a landed round);
 * - pub/sub and braintree are left to their layers (their conflict comes from the upstream's schema).
 *
 * Run: node --test testing/standalone/a-voted-network-member-is-told-of-a-higher-rdf-epoch.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const settle = await import('../../server/dist/spaces/rdf-settle.js');
const take = (...args) => {
  assert.equal(typeof settle.takeServedRdfBases, 'function', 'rdf-settle exports no takeServedRdfBases: a voted network has no way to tell a member');
  return settle.takeServedRdfBases(...args);
};

const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const NEW_BASE = 'https://new.example.org/ld/notes/';
const net = (type = 'closed', over = {}) => ({ id: 'net-1', type, spaces: ['notes', 'other'], members: [], pendingRounds: [], ...over });
const spaces = (rdf = OLD) => [{ id: 'notes', label: 'Notes', meta: { rdf } }, { id: 'other', label: 'Other', meta: {} }];

describe('a voted-network member compares the bases its peers serve', () => {
  for (const type of ['closed', 'club', 'democratic']) {
    it(`${type}: a higher epoch with another base records a conflict naming the network; the own base stays`, () => {
      const n = net(type);
      const s = spaces();
      assert.equal(take(n, s, { notes: { base: NEW_BASE, baseEpoch: 1 } }), true);
      assert.deepEqual(n.rdfBaseConflicts, { notes: { held: { base: OLD.base, epoch: 0 }, offered: [{ networkId: 'net-1', base: NEW_BASE, epoch: 1 }] } });
      assert.deepEqual(s[0].meta.rdf, OLD);
    });
  }
  it('a lower or equal epoch changes nothing', () => {
    const n = net();
    assert.equal(take(n, spaces({ ...OLD, baseEpoch: 2 }), { notes: { base: NEW_BASE, baseEpoch: 1 } }), false);
    assert.equal(take(n, spaces(), { notes: { base: NEW_BASE, baseEpoch: 0 } }), false);
    assert.equal(n.rdfBaseConflicts, undefined);
  });
  it('an older build that serves no rdfBases causes no conflict and no error', () => {
    const n = net();
    assert.equal(take(n, spaces(), undefined), false);
    assert.equal(take(n, spaces(), 'not an object'), false);
    assert.equal(n.rdfBaseConflicts, undefined);
  });
  it('a value no door would accept is left out, whatever else the list holds', () => {
    const n = net();
    const bad = {
      notes: { base: 'https://new.example.org/ld/notes#/', baseEpoch: 1 },
      other: { base: NEW_BASE, baseEpoch: 1e12 },
      ['x'.repeat(5000)]: { base: NEW_BASE, baseEpoch: 1 },
    };
    assert.equal(take(n, spaces(), bad), false);
    assert.equal(take(n, spaces(), { notes: { base: 'https://a.example/b c/', baseEpoch: 1 } }), false);
    assert.equal(n.rdfBaseConflicts, undefined);
  });
  it('a space not carried here, or carried with RDF off, is not touched', () => {
    const n = net('closed', { spaces: ['other'] });
    assert.equal(take(n, spaces(), { notes: { base: NEW_BASE, baseEpoch: 1 } }), false);
    const m = net();
    assert.equal(take(m, spaces({ enabled: false }), { notes: { base: NEW_BASE, baseEpoch: 1 } }), false);
    assert.equal(m.rdfBaseConflicts, undefined);
  });
  it('the conflict clears once the own epoch reaches the offered one', () => {
    const n = net();
    take(n, spaces(), { notes: { base: NEW_BASE, baseEpoch: 1 } });
    assert.ok(n.rdfBaseConflicts?.notes);
    assert.equal(take(n, spaces({ ...OLD, base: NEW_BASE, vocab: `${NEW_BASE}vocab/`, baseEpoch: 1 }), { notes: { base: NEW_BASE, baseEpoch: 1 } }), true);
    assert.equal(n.rdfBaseConflicts, undefined);
  });
  it('pub/sub and braintree are left to their layers', () => {
    for (const type of ['pubsub', 'braintree']) {
      const n = net(type);
      assert.equal(take(n, spaces(), { notes: { base: NEW_BASE, baseEpoch: 1 } }), false);
      assert.equal(n.rdfBaseConflicts, undefined);
    }
  });
  it('the network\'s own id for a space is mapped to the local one', () => {
    const n = net('closed', { spaces: ['notes'], spaceMap: { 'net-notes': 'notes' } });
    assert.equal(take(n, spaces(), { 'net-notes': { base: NEW_BASE, baseEpoch: 1 } }), true);
    assert.ok(n.rdfBaseConflicts?.notes);
  });
});
