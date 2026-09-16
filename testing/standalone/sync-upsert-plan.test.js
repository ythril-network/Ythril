/**
 * Which pulled documents sync actually writes, and how they are scoped.
 *
 * Extracted from `batchUpsertBySeq` in `sync/engine.ts` (god-file split, slice 2). The engine keeps the
 * Mongo IO; the decisions live in `upsert-plan.ts` and are tested here with no database at all.
 *
 * Every mistake in this decision is silent:
 *
 *   - loosen `>` to `>=` and every sync cycle rewrites every document it has ever seen. Nothing fails,
 *     the data stays correct, and write volume starts scaling with the size of the space instead of
 *     with what changed;
 *   - drop the lower-seq guard and a peer that is behind — restored from a backup, or offline across
 *     several local edits — silently rolls newer local records backwards. That one is data loss, and
 *     the only evidence is records reverting;
 *   - drop the re-tag and synced documents land with the PEER's space id in our collection. Every read
 *     path filters on `spaceId`, so they are invisible to list and lookup while still being counted:
 *     the data reads as lost, and `findEntityByName` no longer matches, so `saveFact` starts creating
 *     duplicates instead of updating.
 *
 * Run: node --test testing/standalone/sync-upsert-plan.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';

let planSeqUpserts, retagToLocalSpace;

before(async () => {
  ({ planSeqUpserts, retagToLocalSpace } = await import('../../server/dist/sync/upsert-plan.js'));
});

const doc = (id, seq, extra = {}) => ({ _id: id, seq, ...extra });
const ids = (list) => list.map(d => d._id);

describe('planSeqUpserts — last-writer-wins by seq', () => {
  it('writes a document that does not exist locally', () => {
    assert.deepEqual(ids(planSeqUpserts([doc('a', 1)], new Map())), ['a']);
  });

  it('writes a document whose incoming seq is HIGHER', () => {
    assert.deepEqual(ids(planSeqUpserts([doc('a', 5)], new Map([['a', 4]]))), ['a']);
  });

  it('does NOT rewrite when the seqs are EQUAL — a re-sync must be a no-op', () => {
    // The `>=` trap. Both sides already agree, so rewriting changes nothing and costs a full
    // replaceOne per document, every cycle, forever — invisible except in write volume.
    assert.deepEqual(planSeqUpserts([doc('a', 7)], new Map([['a', 7]])), []);
  });

  it('does NOT write when the incoming seq is LOWER — the data-loss guard', () => {
    // A peer restored from a backup, or offline across several local edits, arrives with stale
    // versions. Without this the older document replaces the newer one and the only symptom is
    // records silently reverting.
    assert.deepEqual(planSeqUpserts([doc('a', 2)], new Map([['a', 9]])), []);
  });

  it('decides per document, not per batch', () => {
    // One stale document in a batch must not suppress its fresh neighbours, and one fresh document
    // must not drag stale ones in with it.
    const batch = [doc('new', 1), doc('higher', 9), doc('equal', 3), doc('lower', 1)];
    const existing = new Map([['higher', 8], ['equal', 3], ['lower', 5]]);
    assert.deepEqual(ids(planSeqUpserts(batch, existing)), ['new', 'higher']);
  });

  it('preserves input order', () => {
    const batch = [doc('c', 1), doc('a', 1), doc('b', 1)];
    assert.deepEqual(ids(planSeqUpserts(batch, new Map())), ['c', 'a', 'b']);
  });

  it('returns an empty array for an empty batch, so the caller can skip the write', () => {
    assert.deepEqual(planSeqUpserts([], new Map()), []);
  });

  it('treats seq 0 as a real value, not as absent', () => {
    // `prev === undefined` is the existence check precisely so that a legitimate seq of 0 is not
    // mistaken for "not present" by a falsy test.
    assert.deepEqual(planSeqUpserts([doc('a', 0)], new Map([['a', 0]])), [], 'equal at zero: no write');
    assert.deepEqual(ids(planSeqUpserts([doc('a', 1)], new Map([['a', 0]]))), ['a'], 'zero is beatable');
    assert.deepEqual(planSeqUpserts([doc('a', 0)], new Map([['a', 1]])), [], 'zero cannot clobber');
  });

  it('returns the caller\'s own objects, not copies', () => {
    // The caller writes these straight to Mongo. Returning copies would mean the re-tag applied to
    // one object and the write carrying another.
    const d = doc('a', 1);
    assert.equal(planSeqUpserts([d], new Map())[0], d);
  });

  it('does not mutate the batch it was given', () => {
    const batch = [doc('a', 1), doc('b', 2)];
    planSeqUpserts(batch, new Map([['a', 5]]));
    assert.deepEqual(ids(batch), ['a', 'b']);
  });
});

describe('retagToLocalSpace — synced documents belong to the local space', () => {
  it('overwrites the peer\'s space id on every document', () => {
    const docs = [doc('a', 1, { spaceId: 'their-research' }), doc('b', 1, { spaceId: 'their-ops' })];
    retagToLocalSpace(docs, 'our-space');
    assert.deepEqual(docs.map(d => d.spaceId), ['our-space', 'our-space']);
  });

  it('adds the field when the peer omitted it', () => {
    const docs = [doc('a', 1)];
    retagToLocalSpace(docs, 'our-space');
    assert.equal(docs[0].spaceId, 'our-space');
  });

  it('mutates in place rather than returning copies', () => {
    // Load-bearing: the caller writes these same objects. A copied-and-tagged result with an
    // untagged original is exactly the bug the re-tag exists to prevent.
    const original = doc('a', 1, { spaceId: 'theirs' });
    retagToLocalSpace([original], 'ours');
    assert.equal(original.spaceId, 'ours');
  });

  it('touches nothing else on the document', () => {
    const d = doc('a', 3, { spaceId: 'theirs', fact: 'keep me', tags: ['x'] });
    retagToLocalSpace([d], 'ours');
    assert.deepEqual(d, { _id: 'a', seq: 3, spaceId: 'ours', fact: 'keep me', tags: ['x'] });
  });

  it('is a no-op on an empty batch', () => {
    assert.doesNotThrow(() => retagToLocalSpace([], 'ours'));
  });
});
