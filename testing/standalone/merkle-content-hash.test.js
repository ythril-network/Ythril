/**
 * Unit tests: Merkle leaves hash document CONTENT (M6)
 *
 * The leaf used to be SHA-256("doc:<type>:<_id>:<seq>"), so a peer could serve
 * tampered content under the same _id/seq and the roots would still agree —
 * verification detected missing / version-skewed documents, never modified ones.
 * Leaves now include a canonical content hash.
 *
 * Pure in-process logic — no MongoDB (docLeaf is exported for exactly this).
 * Run: node --test testing/standalone/merkle-content-hash.test.js
 * (build the server first: npm run build:server)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { docLeaf } from '../../server/dist/brain/merkle.js';

const base = () => ({
  _id: 'mem-1',
  seq: 7,
  fact: 'The deploy key rotates on Fridays.',
  tags: ['ops'],
  author: { instanceId: 'inst-a', instanceLabel: 'A' },
});

describe('docLeaf — content sensitivity', () => {
  it('identical documents produce identical leaves', () => {
    assert.equal(docLeaf('facts', base()), docLeaf('facts', base()));
  });

  it('TAMPERED content under the same _id and seq changes the leaf', () => {
    const tampered = { ...base(), fact: 'The deploy key rotates on Mondays.' };
    assert.notEqual(
      docLeaf('facts', base()),
      docLeaf('facts', tampered),
      'VULNERABILITY: a modified fact produced the same Merkle leaf',
    );
  });

  it('a changed nested field changes the leaf', () => {
    const tampered = { ...base(), author: { instanceId: 'attacker', instanceLabel: 'A' } };
    assert.notEqual(docLeaf('facts', base()), docLeaf('facts', tampered));
  });

  it('a changed tag changes the leaf', () => {
    assert.notEqual(
      docLeaf('facts', base()),
      docLeaf('facts', { ...base(), tags: ['ops', 'secret'] }),
    );
  });

  it('key ORDER does not change the leaf (canonicalisation)', () => {
    const reordered = {
      author: { instanceLabel: 'A', instanceId: 'inst-a' },
      tags: ['ops'],
      fact: 'The deploy key rotates on Fridays.',
      seq: 7,
      _id: 'mem-1',
    };
    assert.equal(
      docLeaf('facts', base()),
      docLeaf('facts', reordered),
      'Mongo does not guarantee field order — the hash must not depend on it',
    );
  });

  it('the embedding vector is EXCLUDED (peers may run different models)', () => {
    const withVec = { ...base(), embedding: [0.1, 0.2], embeddingModel: 'nomic-v1.5', matchedText: 'x' };
    const otherVec = { ...base(), embedding: [0.9, 0.4], embeddingModel: 'other-model', matchedText: 'y' };
    assert.equal(docLeaf('facts', base()), docLeaf('facts', withVec));
    assert.equal(docLeaf('facts', withVec), docLeaf('facts', otherVec));
  });

  it('a RETENTION STAMP is excluded, because each instance computes its own', () => {
    /*
     * W-10. `_expireAt` is when THIS instance will delete the record, derived from its own space policy at its
     * own write time. It is not on any `Incoming*` schema, so it is stripped on push — and it was hashed, so
     * the sender's copy carried the key, the receiver's did not, and the two roots differed FOR EVER on
     * identical content.
     *
     * The symptom is worse than a wrong number: on any network with `merkle: true`, every cycle logged a
     * `MERKLE_DIVERGENCE` warning for every space with a retention policy. A permanent false alarm trains an
     * operator to ignore the one signal that means data really is missing, and because the check is advisory
     * nothing else ever contradicted it.
     *
     * It cannot simply replicate instead. Two peers with different retention legitimately hold different
     * stamps, and shipping the sender's would let one instance decide when another deletes its data — which is
     * word for word the reasoning `DERIVED_FIELDS` already gives for the embedding vector.
     */
    const mine = { ...base(), _expireAt: new Date('2026-10-01T00:00:00.000Z') };
    const theirs = { ...base(), _expireAt: new Date('2027-03-01T00:00:00.000Z') };
    assert.equal(docLeaf('facts', base()), docLeaf('facts', mine),
      'a record with a retention stamp hashes differently from the same record without one, so a peer that '
      + 'strips the stamp can never agree with the peer that set it');
    assert.equal(docLeaf('facts', mine), docLeaf('facts', theirs),
      'two instances with different retention policies disagree about identical content');
  });

  it('and so is the chrono CONTENT-window stamp, for the same reason', () => {
    // `_contentExpireAt` is the same idea one level down: when this instance drops a chrono entry's detail
    // while keeping the entry. Same locality, same answer — and it was missed the first time because the rule
    // was a hand-written list rather than one derived from what the hash sees.
    const a = { ...base(), _contentExpireAt: new Date('2026-10-01T00:00:00.000Z') };
    const b = { ...base(), _contentExpireAt: new Date('2028-01-01T00:00:00.000Z') };
    assert.equal(docLeaf('chrono', base()), docLeaf('chrono', a));
    assert.equal(docLeaf('chrono', a), docLeaf('chrono', b));
  });

  it('but the MARKS a lapsed window leaves behind are still hashed', () => {
    /*
     * The other half, and the reason this is not simply "exclude anything expiry-shaped". `contentRedacted`
     * and `contentRedactedAt` are what the record SAYS ABOUT ITSELF — that it had a description and the
     * description is gone — and they replicate, as of the same release. Excluding them would make a redacted
     * entry hash identically to one that still has its detail, which is real divergence going unreported.
     */
    assert.notEqual(
      docLeaf('chrono', base()),
      docLeaf('chrono', { ...base(), contentRedacted: true }),
      'a redacted entry hashes the same as an unredacted one, so the check would miss content that is gone',
    );
  });

  it('the same content in a different collection produces a different leaf', () => {
    assert.notEqual(docLeaf('facts', base()), docLeaf('entities', base()));
  });

  it('a changed seq still changes the leaf (regression — version skew)', () => {
    assert.notEqual(docLeaf('facts', base()), docLeaf('facts', { ...base(), seq: 8 }));
  });
});
