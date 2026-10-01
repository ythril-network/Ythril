/**
 * Which pulled documents sync actually writes, and how they are scoped.
 *
 * Extracted from `batchUpsertBySeq` in `sync/engine.ts` (god-file split, slice 2). Since `Q-107` part 1 the IO
 * is the arrival writer's (`sync/arrivals.ts`, where `batchUpsertBySeq` moved as the writer's by-seq accept); the
 * decisions still live in `upsert-plan.ts` — the pull's `planSeqUpserts` and the push's `planPushArrivals` — and
 * are tested here with no database at all. Re-anchored: the writer is asserted to apply THIS `planSeqUpserts`,
 * so the rule tested below is the one every door's write runs (seen red by mutation, restored by hand: the
 * writer's accept replaced by a hand-written `>=`).
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

describe('the arrival writer applies this accept, and no copy of it', () => {
  it('batchUpsertBySeq in sync/arrivals.ts calls planSeqUpserts for every write but a restore', async () => {
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const body = bodyOf(stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8')), 'batchUpsertBySeq');
    assert.match(body, /if \(restore\) return \{ toWrite: docs, stored \};/, 'a restore no longer bypasses the accept');
    assert.match(body, /toWrite: planSeqUpserts\(/, 'the writer accepts by a rule of its own instead of planSeqUpserts');
    assert.doesNotMatch(body, /\.seq\s*>=?\s*\w+\.seq|seq\s*>=\s*prev/, 'a hand-written seq comparison is back beside planSeqUpserts');
  });
});

describe('the planner keys a unique index by the family\'s own derived identity', () => {
  it('uniqueKey is edgeIdFor for an edge and linkIdFor for a link, with no endpoint-kind coalescer of its own', async () => {
    // Dup pass: a local `k === 'entity' ? '' : k` was a second spelling of `edgeEndpointKind`/`storedEdgeKind`.
    // Seen red by mutation, restored by hand: the local coalescer and part-joined key written back.
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const src = stripComments(readFileSync('server/src/sync/upsert-plan.ts', 'utf8'));
    const body = bodyOf(src, 'uniqueKey');
    assert.match(body, /kind === 'edges'\) return edgeIdFor\(/, 'an edge is keyed by something other than its derived id');
    assert.match(body, /return linkIdFor\(/, 'a link is keyed by something other than its derived id');
    assert.doesNotMatch(src, /=== 'entity'/, 'upsert-plan.ts coalesces an endpoint kind itself — use the shared one');
  });
});

describe('planPushArrivals — the push accept, decided as sequential processing decided it', () => {
  let P;
  before(async () => { P = await import('../../server/dist/sync/upsert-plan.js'); });
  const plan = (kind, docs, over = {}) => P.planPushArrivals(docs, { kind, stored: new Map(), tombstones: new Map(), ...over });

  it('facts [9, 3] for one id: inserted then skipped, and the 9 is the one write', () => {
    const p = plan('facts', [doc('f', 9, { fact: 'nine' }), doc('f', 3, { fact: 'three' })]);
    assert.deepEqual(p.verdicts, ['inserted', 'skipped']);
    assert.deepEqual(p.accepts.get('f').map(a => a.doc.seq), [9]);
  });

  it('facts 5 then 6: inserted then updated, the 6 written last', () => {
    const p = plan('facts', [doc('f', 5, { fact: 'a' }), doc('f', 6, { fact: 'b' })]);
    assert.deepEqual(p.verdicts, ['inserted', 'updated']);
    assert.equal(p.accepts.get('f').at(-1).doc.seq, 6);
  });

  it('an equal seq: equal text is skipped, divergent text forks; an entity never forks', () => {
    assert.deepEqual(plan('facts', [doc('f', 5, { fact: 'x' }), doc('f', 5, { fact: 'x' })]).verdicts, ['inserted', 'skipped']);
    const split = plan('facts', [doc('f', 5, { fact: 'x' }), doc('f', 5, { fact: 'y' })]);
    assert.deepEqual(split.verdicts, ['inserted', 'forked']);
    assert.equal(split.forks[0].doc.forkOf, 'f');
    assert.deepEqual(plan('entities', [doc('e', 5), doc('e', 5)]).verdicts, ['upserted', 'skipped']);
  });

  it('a tombstone at or above the seq tombstones; one below is cleaned only when the record lands', () => {
    const tombstones = new Map([['a', 7], ['b', 3]]);
    const p = plan('entities', [doc('a', 7), doc('b', 4)], { tombstones });
    assert.deepEqual(p.verdicts, ['tombstoned', 'upserted']);
    assert.deepEqual(p.tombstoneCleanups.get('b'), { below: 4, onLanding: true });
    assert.equal(p.tombstoneCleanups.has('a'), false);
  });

  it('two ids on one edge triplet in a page: the first is written, the second is a duplicate', () => {
    const t = { from: 'A', to: 'B', label: 'knows' };
    assert.deepEqual(plan('edges', [doc('g1', 5, t), doc('g2', 6, t)]).verdicts, ['upserted', 'duplicate']);
  });

  it('the fan-out cap counts stored and in-page siblings together; an existing fork is the same fork', () => {
    const stored = new Map([['f', { seq: 5, fact: 'root' }]]);
    const variants = Array.from({ length: 4 }, (_, i) => doc('f', 5, { fact: `v${i}` }));
    const p = plan('facts', variants, { stored, siblings: new Map([['f', P.MAX_FORK_DEPTH - 2]]) });
    assert.deepEqual(p.verdicts, ['forked', 'forked', 'forkRefused', 'forkRefused']);
    const again = plan('facts', [variants[0]], { stored, siblings: new Map([['f', P.MAX_FORK_DEPTH]]),
      existingForks: new Set([p.forkIds[0]]) });
    assert.deepEqual([again.verdicts[0], again.forkIds[0], again.forks.length], ['forked', p.forkIds[0], 0]);
  });

  it('a fork id is derived: the same divergence gives the same id, a different text another, v4-shaped', () => {
    const a = P.forkIdFor('f', 5, 'x');
    assert.equal(a, P.forkIdFor('f', 5, 'x'));
    assert.notEqual(a, P.forkIdFor('f', 5, 'y'));
    assert.notEqual(a, P.forkIdFor('f', 6, 'x'));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('the chain walk stops at a cycle and one past the cap', () => {
    const ring = new Map([['a', 'b'], ['b', 'a']]);
    assert.equal(P.forkDepth('a', id => ring.get(id)), 2);
    const long = (id) => (Number(id) < 100 ? String(Number(id) + 1) : undefined);
    assert.equal(P.forkDepth('0', long), P.MAX_FORK_DEPTH + 1);
  });
});
