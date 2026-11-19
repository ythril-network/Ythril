/**
 * The vocab travels with the base everywhere the base travels (Q-748, slice A-fix, review finding 3).
 *
 * A rebase round moves base AND vocab, and every type and property address of a space is built on the vocab. So a member told of a base
 * it missed must be told the vocab too, or its admin's accept leaves it at the right base with every term address wrong, and nothing tells
 * it again:
 *
 * - a voted network member serves `{ base, vocab, baseEpoch }` for each shared space with RDF on;
 * - the conflict a peer's offer records names the offered vocab, and the held one;
 * - the same base at the same epoch with ANOTHER vocab is a conflict, on the served bases and on a layer;
 * - accepting an offered base takes the offered vocab, never the default one.
 *
 * Run: node --test testing/standalone/an-offered-rdf-base-carries-its-vocab.test.js (after the server build)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

const settle = await import('../../server/dist/spaces/rdf-settle.js');

const OLD = { enabled: true, base: 'https://old.example.org/ld/notes/', vocab: 'https://old.example.org/ld/notes/vocab/', baseEpoch: 0 };
const NEW_BASE = 'https://new.example.org/ld/notes/';
const CUSTOM = 'https://v.example/terms/';
const net = (over = {}) => ({ id: 'net-1', type: 'closed', spaces: ['notes'], members: [{ instanceId: 'p1' }], pendingRounds: [], ...over });
const spaces = (rdf = OLD) => [{ id: 'notes', label: 'Notes', meta: { rdf } }];

describe('the vocab travels with the base', () => {
  it('a member serves each shared space\'s vocab beside its base and epoch', () => {
    assert.deepEqual(settle.servedRdfBasesOf(net(), spaces()), { notes: { base: OLD.base, vocab: OLD.vocab, baseEpoch: 0 } });
  });
  it('a recorded conflict names the offered vocab and the held one', () => {
    const n = net();
    settle.takeServedRdfBases(n, spaces(), { notes: { base: NEW_BASE, vocab: CUSTOM, baseEpoch: 1 } }, 'p1');
    const c = n.rdfBaseConflicts?.notes;
    assert.ok(c, 'no conflict was recorded');
    assert.equal(c.offered[0].vocab, CUSTOM, `the offered vocab was not kept: ${JSON.stringify(c)}`);
    assert.equal(c.held.vocab, OLD.vocab);
  });
  it('the same base and epoch with another vocab is a conflict on the served bases', () => {
    const n = net();
    assert.equal(settle.takeServedRdfBases(n, spaces(), { notes: { base: OLD.base, vocab: CUSTOM, baseEpoch: 0 } }, 'p1'), true,
      'two vocabs at one base and epoch went untold');
    assert.equal(n.rdfBaseConflicts?.notes?.offered?.[0]?.vocab, CUSTOM);
  });
  it('the same base and epoch with another vocab is a conflict on a layer', () => {
    const settled = settle.settleRdf(OLD, { enabled: true, base: OLD.base, vocab: CUSTOM, baseEpoch: 0 }, 'layer', { networkId: 'net-1' });
    assert.equal(settled.ok, true);
    assert.deepEqual(settled.rdf, OLD, 'a layer moved the vocab');
    assert.equal(settled.conflict?.offered?.[0]?.vocab, CUSTOM, `no conflict for another vocab: ${JSON.stringify(settled)}`);
  });
  it('accepting an offered base takes the offered vocab', () => {
    const settled = settle.settleRdf(OLD, { enabled: true, base: NEW_BASE, rebase: true }, 'local', {
      spaceId: 'notes', publicBaseUrl: 'https://old.example.org', networked: true,
      offeredBases: [{ base: NEW_BASE, vocab: CUSTOM, epoch: 1 }],
    });
    assert.equal(settled.ok, true, settled.error);
    assert.equal(settled.acceptedOffer, true);
    assert.deepEqual(settled.rdf, { enabled: true, base: NEW_BASE, vocab: CUSTOM, baseEpoch: 1 }, 'the accept took the default vocab');
  });
});
