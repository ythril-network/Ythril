/**
 * Which arriving documents sync actually writes, and how they are scoped.
 *
 * Extracted from `batchUpsertBySeq` in `sync/engine.ts` (god-file split, slice 2). Since `Q-107` part 1 the IO
 * is the arrival writer's (`sync/arrivals.ts`). Re-anchored for bundle-30 `Q-204`: the pull's own by-seq accept
 * (`planSeqUpserts`, then `batchUpsertBySeq`) is gone — a pulled page is planned by `planArrivals` exactly as a
 * pushed one (`sync/accept-page.ts`), and the writer applies the accept only AT the write (`seqGuard`). So the
 * last-writer-wins cases below run against `planArrivals` for a family that never forks, and the writer is
 * asserted to plan nothing of its own.
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
import { base, ALTERNATE, MAIN_FIELD, REDACTION_MARKS, AUTHOR, OTHER_AUTHOR, T0, T1 } from './_fork-body-fixtures.mjs';

let planArrivals, retagToLocalSpace, authored, linkIdFor;

before(async () => {
  ({ planArrivals, retagToLocalSpace } = await import('../../server/dist/sync/upsert-plan.js'));
  ({ linkIdFor } = await import('../../server/dist/brain/link-id.js'));
  // Q-624: the hash leaf the door reads a stored copy's body through. Absent before it is written, which these cases then do not need; once
  // it is written, a stored copy at an equal seq must carry it (see `writes`), and the cases below that need it say so.
  try { authored = await import('../../server/dist/sync/authored-content.js'); } catch { authored = undefined; }
});

const doc = (id, seq, extra = {}) => ({ _id: id, seq, ...extra });
const ids = (list) => list.map(d => d._id);
/**
 * The ids a PULLED page writes, given the seq each id has locally: the accepted winners, in page order. These cases
 * hold the last-writer-wins half of the rule — the rule the pull's `planSeqUpserts` was — for a copy that says what the
 * stored one says; what an equal seq with another body does is the Q-624 block at the end of this file.
 */
const writes = (docs, existing) => {
  // Re-anchored for Q-624 (not in the design's re-anchor table, and it must be): a stored copy at an EQUAL seq carries the hash of its body, because the
  // planner throws `BodyNotRead` for one that does not (decision D8) — the door reads the body at an equal seq. This fixture is a copy that says what the
  // arriving document says (`doc(id, seq)` against itself), which the raw fallback of the hash makes equal by construction.
  const stored = new Map([...existing].map(([id, seq]) => [id, { seq, ...(authored ? { bodyHash: authored.authoredContentHash('entities', doc(id, seq)) } : {}) }]));
  const p = planArrivals(docs, { kind: 'entities', door: 'pull', stored, tombstones: new Map(), deliveredBy: undefined });
  return [...p.accepts.values()].map(list => list.at(-1).doc);
};

describe('planArrivals — last-writer-wins by seq, as a pulled page is decided', () => {
  it('writes a document that does not exist locally', () => {
    assert.deepEqual(ids(writes([doc('a', 1)], new Map())), ['a']);
  });

  it('writes a document whose incoming seq is HIGHER', () => {
    assert.deepEqual(ids(writes([doc('a', 5)], new Map([['a', 4]]))), ['a']);
  });

  it('does NOT rewrite when the seqs are EQUAL — a re-sync must be a no-op', () => {
    // The `>=` trap. Both sides already agree, so rewriting changes nothing and costs a full
    // replaceOne per document, every cycle, forever — invisible except in write volume.
    assert.deepEqual(writes([doc('a', 7)], new Map([['a', 7]])), []);
  });

  it('does NOT write when the incoming seq is LOWER — the data-loss guard', () => {
    // A peer restored from a backup, or offline across several local edits, arrives with stale
    // versions. Without this the older document replaces the newer one and the only symptom is
    // records silently reverting.
    assert.deepEqual(writes([doc('a', 2)], new Map([['a', 9]])), []);
  });

  it('decides per document, not per batch', () => {
    // One stale document in a batch must not suppress its fresh neighbours, and one fresh document
    // must not drag stale ones in with it.
    const batch = [doc('new', 1), doc('higher', 9), doc('equal', 3), doc('lower', 1)];
    const existing = new Map([['higher', 8], ['equal', 3], ['lower', 5]]);
    assert.deepEqual(ids(writes(batch, existing)), ['new', 'higher']);
  });

  it('preserves input order', () => {
    const batch = [doc('c', 1), doc('a', 1), doc('b', 1)];
    assert.deepEqual(ids(writes(batch, new Map())), ['c', 'a', 'b']);
  });

  it('writes nothing for an empty batch, so the caller can skip the write', () => {
    assert.deepEqual(writes([], new Map()), []);
  });

  it('treats seq 0 as a real value, not as absent', () => {
    // `held === undefined` is the existence check precisely so that a legitimate seq of 0 is not
    // mistaken for "not present" by a falsy test.
    assert.deepEqual(writes([doc('a', 0)], new Map([['a', 0]])), [], 'equal at zero: no write');
    assert.deepEqual(ids(writes([doc('a', 1)], new Map([['a', 0]]))), ['a'], 'zero is beatable');
    assert.deepEqual(writes([doc('a', 0)], new Map([['a', 1]])), [], 'zero cannot clobber');
  });

  it('returns the caller\'s own objects, not copies', () => {
    // The caller writes these straight to Mongo. Returning copies would mean the re-tag applied to
    // one object and the write carrying another.
    const d = doc('a', 1);
    assert.equal(writes([d], new Map())[0], d);
  });

  it('does not mutate the batch it was given', () => {
    const batch = [doc('a', 1), doc('b', 2)];
    writes(batch, new Map([['a', 5]]));
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

describe('every door plans by this accept, and the writer applies it only at the write', () => {
  it('the page accept plans with planArrivals for push and pull; the pull hands it its pages; the writer guards with seqGuard', async () => {
    /*
     * Re-anchored for `Q-204`: the writer's own accept read (`batchUpsertBySeq` over `planSeqUpserts`) was the
     * pull's whole rule, and a second one beside the push planner. Seen red by mutation, restored by hand: the
     * engine's pull handing its page to `writeArrivals` directly again.
     */
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const accept = bodyOf(stripComments(readFileSync('server/src/sync/accept-page.ts', 'utf8')), 'acceptArrivingPage');
    assert.match(accept, /planArrivals\(docs, \{/, 'the page accept no longer plans with planArrivals');
    // Re-anchored for bundle-52: the pull's page hand-over is `pullFamily` (`sync/pull-family.ts`), out of `pullFromPeer`.
    const pull = bodyOf(stripComments(readFileSync('server/src/sync/pull-family.ts', 'utf8')), 'pullFamily');
    assert.match(pull, /acceptArrivingPage\([^)]*door: 'pull'/s, 'the pull no longer hands its pages to the page accept');
    assert.doesNotMatch(pull, /writeArrivals\(/, 'the pull writes its pages without the page accept again');
    const engine = bodyOf(stripComments(readFileSync('server/src/sync/space-exchange.ts', 'utf8')), 'pullFromPeer'); // moved out of engine.ts (bundle-106 §3.4)
    assert.match(engine, /await pullFamily\(/, 'the engine\'s pull no longer goes through the per-family pull');
    assert.doesNotMatch(engine, /writeArrivals\(|acceptArrivingPage\(/, 'the engine writes pulled pages itself again');
    const writer = bodyOf(stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8')), 'writeArrivals');
    assert.match(writer, /seqGuard\(d\._id, d\.seq\)/, 'the writer no longer guards its write with seqGuard');
    assert.doesNotMatch(writer, /planArrivals\(|planSeqUpserts\(/, 'the writer plans a page of its own again');
  });

  it('seqGuard: below the incoming seq or no seq at all; a seq-less arrival by _id alone', async () => {
    const { seqGuard } = await import('../../server/dist/sync/upsert-plan.js');
    assert.deepEqual(seqGuard('a', 5), { _id: 'a', $or: [{ seq: { $lt: 5 } }, { seq: { $exists: false } }] });
    assert.deepEqual(seqGuard('a', 0), { _id: 'a', $or: [{ seq: { $lt: 0 } }, { seq: { $exists: false } }] });
    assert.deepEqual(seqGuard('a', undefined), { _id: 'a' });
  });
});

describe('one accept rule: isNewerCopy', () => {
  it('strictly newer; nothing held is beaten by anything; a seq-less copy beats nothing held at a seq', async () => {
    const { isNewerCopy } = await import('../../server/dist/sync/held-tombstone-rules.js');
    assert.deepEqual([isNewerCopy(5, 4), isNewerCopy(5, 5), isNewerCopy(4, 5)], [true, false, false]);
    assert.deepEqual([isNewerCopy(0, undefined), isNewerCopy(undefined, undefined), isNewerCopy(undefined, 0)], [true, true, false]);
  });

  it('the pull accept, the push planner and the writer\'s collapse and read-back all ask it, and nothing else compares', async () => {
    /*
     * Dup pass: the accept was written four times (`doc.seq > prev`, the planner's `doc.seq > curSeq`, the
     * writer's `(prev.seq ?? -1) > (doc.seq ?? -1)` — with the OPPOSITE tie-break — and its read-back `s > d.seq`).
     * Seen red by mutation, restored by hand: the writer's collapse written back as a raw comparison.
     */
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const plan = stripComments(readFileSync('server/src/sync/upsert-plan.ts', 'utf8'));
    const writer = bodyOf(stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8')), 'writeArrivals');
    for (const [where, body] of [['planArrivals', bodyOf(plan, 'planArrivals')]]) {
      assert.match(body, /isNewerCopy\(/, `${where} no longer asks isNewerCopy`);
    }
    // bundle-81 (decision 55): the read-back of a duplicate key is `sync/duplicate-readback.ts`, which the tombstone apply asks too; it asks isNewerCopy once.
    assert.equal((writer.match(/isNewerCopy\(/g) ?? []).length, 1, 'the writer\'s collapse does not ask isNewerCopy');
    assert.match(writer, /readBackDuplicates</, 'the writer\'s read-back of a duplicate is not the shared one');
    assert.equal((stripComments(readFileSync('server/src/sync/duplicate-readback.ts', 'utf8')).match(/isNewerCopy\(/g) ?? []).length, 1, 'the shared read-back does not ask isNewerCopy');
    // Any `x.seq > y` / `seq > z.seq` left is a second accept rule. The tombstone and counter comparisons are
    // about different things (a deletion's seq, the counter's high-water mark) and are named, not hidden.
    const ALLOWED = /tomb\s*>=\s*doc\.seq|curSeq\s*>\s*tomb|seq\s*>\s*out\.maxReceived|incoming\s*>\s*held/;
    const raw = [...plan.matchAll(/[\w.?)]+\s*>=?\s*[\w.(]+/g), ...writer.matchAll(/[\w.?)]+\s*>=?\s*[\w.(]+/g)]
      .map(m => m[0]).filter(e => /seq/i.test(e) && !ALLOWED.test(e));
    assert.deepEqual(raw, [], 'a seq comparison outside isNewerCopy decides which copy wins');
  });
});

describe('the fork caps\' index is declared once', () => {
  // Restated by Q-445 (bundle-101): this read `lifecycle.ts` and `ensure-query-indexes.ts` for a loop over FORK_INDEXES and a
  // `createIndex(ix.keys…)` each, which held only while each build site named its indexes by hand. Both now run the ONE per-space
  // declaration (`spaces/space-indexes.ts`, gate `every-per-space-index-build-reads-the-declaration`), so the rule is that every
  // FORK_INDEXES entry is declared there, on facts, with its keys and its sparseness read from the entry, and boot-safe so
  // `initSpace` builds it at every boot (the background pass builds every declared entry).
  it('initSpace and ensureQueryIndexes both create FORK_INDEXES, and nobody spells the index', async () => {
    // Dup pass: `{ forkOf: 1 }, { sparse: true }` was written in both. Seen red by mutation, restored by hand: the
    // literal put back in ensure-query-indexes.ts.
    const { stripComments } = await import('./_strip-comments.mjs');
    const { readTrackedSources } = await import('./_sources.mjs');
    const { requireSpaceIndexDeclaration } = await import('./_space-index-declaration.mjs');
    const { FORK_INDEXES, FORKING_FAMILIES } = await import('../../server/dist/sync/upsert-plan.js');
    assert.ok(FORK_INDEXES.length >= 1, 'FORK_INDEXES read as empty');
    // Re-anchored for Q-624 (design rev 4 section 5.5, section 16 re-anchor table): one declaration per FORKING_FAMILIES member, not facts alone.
    assert.ok(Array.isArray(FORKING_FAMILIES) && FORKING_FAMILIES.length >= 4, 'FORKING_FAMILIES is not exported by sync/upsert-plan.ts: the families that fork are not declared once');
    const declared = await requireSpaceIndexDeclaration(assert);
    for (const family of FORKING_FAMILIES) {
      for (const ix of FORK_INDEXES) {
        const e = declared.find(d => d.part === family && JSON.stringify(d.raw.keys) === JSON.stringify(ix.keys));
        assert.ok(e, `${JSON.stringify(ix.keys)} of FORK_INDEXES is not declared on ${family}`);
        assert.equal(e.spec.sparse, ix.sparse === true, `${family}: ${JSON.stringify(ix.keys)} is declared with another sparseness than FORK_INDEXES says`);
        assert.equal(typeof e.bootSafe, 'boolean', `${family}: ${JSON.stringify(ix.keys)} leaves bootSafe to the default`);
        // Facts keeps what it did at df2e7534 (built at every boot, held by every-pre-existing-space-index-says-whether-it-is-boot-safe); the others are new.
        if (family === 'facts') assert.equal(e.bootSafe, true, `${JSON.stringify(ix.keys)} is not built at every boot on facts`);
      }
    }
    const spelled = readTrackedSources('server/src', { ext: ['.ts'], floor: 200, specs: false, untracked: true })
      .filter(s => /createIndex\(\s*\{\s*forkOf\b/.test(stripComments(s.text))).map(s => s.file);
    assert.deepEqual(spelled, [], 'the forkOf index is spelled out again instead of read from FORK_INDEXES');
  });
});

describe('one fork rule: divergesFrom', () => {
  it('the candidate read and the planner both ask it, and no fact-text comparison is written beside it', async () => {
    // Dup pass: `seq === … && fact !== …` was written in forkCandidates twice and in the planner once. Seen red
    // by mutation, restored by hand: the planner's test written back inline.
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const P = await import('../../server/dist/sync/upsert-plan.js');
    // Re-anchored for Q-624 (design rev 4 section 2, re-anchor table :215-217): the rule takes the family (`divergesFrom(kind, d, held)`) and compares the
    // BODY of two copies, so it is asked of a document that says something, with the hash of the stored copy's body beside its seq.
    const H = await import('../../server/dist/sync/authored-content.js');
    const held = (kind, d) => ({ seq: d.seq, bodyHash: H.authoredContentHash(kind, d) });
    const a = base('facts', { fact: 'a' });
    assert.deepEqual([
      P.divergesFrom('facts', a, held('facts', base('facts', { fact: 'b' }))),
      P.divergesFrom('facts', a, held('facts', base('facts', { fact: 'a' }))),
      P.divergesFrom('facts', a, held('facts', base('facts', { fact: 'b', seq: 4 }))),
      P.divergesFrom('facts', a, undefined),
    ], [true, false, false, false]);
    const src = stripComments(readFileSync('server/src/sync/upsert-plan.ts', 'utf8'));
    for (const fn of ['forkCandidates', 'planArrivals']) assert.match(bodyOf(src, fn), /divergesFrom\(/, `${fn} no longer asks divergesFrom`);
    // Q-232: the writer's read-back asks it too, so a same-seq copy with other text is a divergence, never "landed".
    const writer = bodyOf(stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8')), 'writeArrivals');
    assert.match(writer, /divergesFrom\(\s*[\w.]+\s*,\s*d\s*,\s*held\s*\)/, 'the writer\'s read-back no longer asks divergesFrom with the family');
    // Re-anchored (:250-251): the text comparison is gone, replaced by the body-hash comparison, which lives in the hash leaf and is asked here.
    const inline = [...src.matchAll(/\.fact\s*!==\s*[\w.]+\.fact/g)].length;
    assert.equal(inline, 0, 'a fact-text comparison is written in upsert-plan.ts: the one fork rule compares the whole body through the hash leaf');
    assert.match(bodyOf(src, 'divergesFrom'), /\bauthoredContentHash\b|\bbodyHash\b/, 'divergesFrom does not compare the body hash');
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

describe('planArrivals — the page accept, decided as sequential processing decided it', () => {
  let P;
  before(async () => { P = await import('../../server/dist/sync/upsert-plan.js'); });
  const plan = (kind, docs, over = {}) => P.planArrivals(docs, { kind, door: 'push', stored: new Map(), tombstones: new Map(), ...over });

  it('the one door difference: a chrono type outside the vocabulary is unknownType on push and planned on pull', () => {
    const allowedTypes = new Set(['event']);
    const odd = [doc('c', 5, { type: 'not-a-type' })];
    assert.deepEqual(plan('chrono', odd, { allowedTypes }).verdicts, ['unknownType']);
    assert.deepEqual(plan('chrono', odd, { allowedTypes, door: 'pull' }).verdicts, ['upserted']);
    // Every other verdict is the same on both doors.
    const tombstones = new Map([['a', { seq: 7 }]]);
    for (const door of ['push', 'pull']) {
      assert.deepEqual(plan('entities', [doc('a', 7), doc('b', 4)], { tombstones, door }).verdicts, ['tombstoned', 'upserted']);
    }
  });

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

  it('an equal seq: equal body is skipped, a different body forks, for every forking kind; a family that never forks is still skipped', async () => {
    // Inverted for Q-624 (design rev 4 section 4, re-anchor table :298-303): it read "an entity never forks".
    // Re-anchored for Q-324: within a page the LOWER-hash copy is the one that is written, and the other is the fork, whichever came first.
    const H = await import('../../server/dist/sync/authored-content.js');
    for (const kind of P.FORKING_FAMILIES) {
      const field = MAIN_FIELD[kind];
      const x = base(kind), y = base(kind, { [field]: 'something else' });
      assert.deepEqual(plan(kind, [x, { ...x }]).verdicts, [kind === 'facts' ? 'inserted' : 'upserted', 'skipped'], `${kind}: an equal copy is not skipped`);
      const first = kind === 'facts' ? 'inserted' : 'upserted';
      const [yHash, xHash] = H.tieHashes(H.authoredContentHash(kind, y), H.authoredContentHash(kind, x));
      const yWins = P.arrivingWinsTie(yHash, xHash);
      const split = plan(kind, [x, y]);
      assert.deepEqual(split.verdicts, yWins ? ['forked', first] : [first, 'forked'], `${kind}: a different body at an equal seq does not fork`);
      assert.equal(split.forks.length, 1, `${kind}: one of the two is the fork`);
      assert.equal(split.forks[0].doc.forkOf, 'p');
      assert.equal(split.accepts.get('p').length, 1, `${kind}: one copy is written as the parent`);
      assert.equal(split.accepts.get('p')[0].doc[field], (yWins ? y : x)[field], `${kind}: the written parent is not the lower-hash copy`);
    }
    // Links and file metadata carry no body of their own to disagree about (a link's body is its identity), so an equal seq is a skip.
    // Under the id its endpoints derive: any other id is refused before an equal seq is asked (`underivedId`, Q-222).
    const link = { _id: linkIdFor('a', 'fact', 'b', 'entity'), seq: 5, from: 'a', fromKind: 'fact', to: 'b', toKind: 'entity', author: AUTHOR, createdAt: T0, spaceId: 's' };
    assert.deepEqual(plan('links', [link, { ...link, createdAt: T1 }]).verdicts, ['upserted', 'skipped']);
    assert.deepEqual(plan('links', [{ ...link, _id: 'l' }]).verdicts, ['underivedId'],
      'a link whose id does not derive from its endpoints was planned for a write');
  });

  it('a tombstone at or above the seq tombstones; one below is cleaned only when the record lands', () => {
    // A held tombstone is its seq and issuer (bundle-46); these carry no issuer, so they govern as they always did.
    const tombstones = new Map([['a', { seq: 7 }], ['b', { seq: 3 }]]);
    const p = plan('entities', [doc('a', 7), doc('b', 4)], { tombstones });
    assert.deepEqual(p.verdicts, ['tombstoned', 'upserted']);
    assert.deepEqual(p.tombstoneCleanups.get('b'), { below: 4, onLanding: true });
    assert.equal(p.tombstoneCleanups.has('a'), false);
  });

  it('a tombstone stored for the delivering upstream is cleaned up whatever its seq when that upstream\'s version lands', () => {
    // Held as a relayed deletion: issued by X with a seq of X's clock, stored for the upstream U (`storedVia`).
    const tombstones = new Map([['a', { seq: 90, issuer: 'X', storedVia: 'U' }], ['b', { seq: 90, issuer: 'X', storedVia: 'U' }]]);
    const p = plan('entities', [doc('a', 4), doc('b', 4)], { tombstones, deliveredBy: 'U' });
    assert.deepEqual(p.verdicts, ['upserted', 'upserted']);
    assert.deepEqual(p.tombstoneCleanups.get('a'), { below: 4, onLanding: true, via: 'U' });
    // Delivered by anybody else it is refused and kept, exactly as before.
    const other = plan('entities', [doc('a', 4)], { tombstones, deliveredBy: 'L' });
    assert.deepEqual(other.verdicts, ['tombstoned']);
    assert.equal(other.tombstoneCleanups.has('a'), false);
  });

  it('another issuer\'s tombstone does not refuse a record its PROVEN author pushes; unproven, it still does', () => {
    const tombstones = new Map([['a', { seq: 9, issuer: 'X' }], ['b', { seq: 9, issuer: 'X' }], ['c', { seq: 9, issuer: 'X' }]]);
    const docs = [doc('a', 4, { author: { instanceId: 'Y' } }), doc('b', 4, { author: { instanceId: 'X' } }), doc('c', 4)];
    const proven = plan('entities', docs, { tombstones, deliveredBy: 'Y' });
    assert.deepEqual(proven.verdicts, ['upserted', 'tombstoned', 'tombstoned']);
    assert.equal(proven.tombstoneCleanups.has('a'), false, 'another issuer\'s tombstone is not cleaned up by this author\'s record');
    // The author field is the sender's text: claimed by an admin token, or by a peer that is not the author, it is
    // no proof, and the deleted id stays deleted.
    assert.deepEqual(plan('entities', docs, { tombstones }).verdicts, ['tombstoned', 'tombstoned', 'tombstoned']);
    assert.deepEqual(plan('entities', docs, { tombstones, deliveredBy: 'Z' }).verdicts, ['tombstoned', 'tombstoned', 'tombstoned']);
  });

  it('two ids on one edge triplet in a page: the first is written, the second is a duplicate', () => {
    const t = { from: 'A', to: 'B', label: 'knows' };
    assert.deepEqual(plan('edges', [doc('g1', 5, t), doc('g2', 6, t)]).verdicts, ['upserted', 'duplicate']);
  });

  it('the fan-out cap counts stored and in-page siblings together; an existing fork is the same fork', async () => {
    // Re-anchored for Q-624 (not in the design's re-anchor table, and it must be): a stored copy at an EQUAL seq now carries the hash of its body, because
    // `divergesFrom` throws `BodyNotRead` for one that does not (decision D8), so the fixture reads the body the way the door does.
    const H = await import('../../server/dist/sync/authored-content.js');
    // Re-anchored for Q-324: the stored copy is the LOWEST-hash one here (its text found by search, never assumed), so every arriving variant loses the
    // tie and forks, as before; the copy that wins the tie is the rule's own case (`an arriving copy that wins the tie`, below).
    const lowest = (() => { for (let i = 0; ; i++) { const t = `root ${i}`; if ([...Array(4).keys()].every(k => H.authoredContentHash('facts', { _id: 'f', seq: 5, fact: `v${k}` }).hash > H.authoredContentHash('facts', { _id: 'f', seq: 5, fact: t }).hash)) return t; } })();
    const rootDoc = { _id: 'f', seq: 5, fact: lowest };
    const stored = new Map([['f', { seq: 5, fact: lowest, bodyHash: H.authoredContentHash('facts', rootDoc), row: rootDoc }]]);
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

/*
 * Q-624 (design rev 4 sections 2 to 4, section 16 test 1): every forking kind forks on a difference of BODY at an equal seq, and skips a copy that says
 * the same thing. Facts forked on `fact` text alone and an entity, edge or chrono entry never forked, so two instances that edited one record at one
 * version each kept their own edit for ever and the space hash called them different for ever. The rule is the body hash (`sync/authored-content.ts`):
 * the family's body fields, normalised through its `Incoming*` schema, with the version metadata removed at the top level only.
 *
 * What a stored copy is, to the planner: its seq, whether it is a fork, and (at an equal seq) the hash of its body, read by the door (`StoredCopy.bodyHash`).
 * The fixture builds it the way the door does, from the hash leaf.
 */
describe('an equal-seq copy that says something different forks, for every forking kind; one that says the same thing is skipped', () => {
  let P, H;
  before(async () => {
    P = await import('../../server/dist/sync/upsert-plan.js');
    try { H = await import('../../server/dist/sync/authored-content.js'); } catch (err) { H = { __missing: String(err?.code ?? err?.message) }; }
  });
  const leaf = () => {
    assert.ok(!H.__missing, `dist/sync/authored-content.js is not built (${H.__missing}): there is no body hash for the planner to decide a fork by`);
    assert.ok(Array.isArray(P.FORKING_FAMILIES) && P.FORKING_FAMILIES.length >= 4, 'FORKING_FAMILIES is not exported by sync/upsert-plan.ts');
    return H;
  };
  // `row` is the stored row the door reads with the hash (Q-324): what the fork a parent swap makes is made of.
  const held = (kind, d) => ({ seq: d.seq, ...(d.forkOf ? { forkOf: d.forkOf } : {}), bodyHash: H.authoredContentHash(kind, d), row: d });
  const plan = (kind, docs, over = {}) => P.planArrivals(docs, { kind, door: 'push', stored: new Map(), tombstones: new Map(), deliveredBy: undefined, ...over });
  /** Does `arriving` win the tie against `stored`, by the server's own rule. */
  const wins = (kind, arriving, stored) => P.arrivingWinsTie(...H.tieHashes(H.authoredContentHash(kind, arriving), H.authoredContentHash(kind, stored)));
  /** A body for `kind`'s main field that sorts BELOW every one of `others` under the tie rule: the stored copy that every variant then loses to, found by search, never assumed. */
  const lowestAgainst = (kind, others) => {
    for (let i = 0; i < 10000; i++) {
      const candidate = base(kind, { [MAIN_FIELD[kind]]: `stored ${i}` });
      if (others.every(o => wins(kind, candidate, o))) return candidate;
    }
    throw new Error(`${kind}: no stored body found that beats every variant`);
  };
  const against = (kind, stored, arriving, over = {}) => plan(kind, [arriving], { stored: new Map([['p', held(kind, stored)]]), ...over });
  const FIRST = (kind) => (kind === 'facts' ? 'inserted' : 'upserted');
  /** A fork row of `kind` under the subject `p`, its id derived the way a sender derives it. */
  const forkRow = (kind, over) => {
    // `forkAt` is the shared version the copies diverged at, and what the id derives from; the row's own `seq` is a local stamp (parent decision, 2026-10-25).
    const row = base(kind, { forkOf: 'p', forkAt: 5, ...over });
    return { ...row, _id: P.forkIdFor('p', row.forkAt, H.authoredContentHash(kind, row).text) };
  };

  it('a body field that differs: forked, with the derived fork id and the shared seq, for every body field of every kind', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      const fields = [...H.BODY_FIELDS_OF[kind]];
      assert.ok(fields.length >= 7, `${kind}: only ${fields.length} body field(s): the field table did not derive`);
      const unknown = fields.filter(f => !(f in ALTERNATE[kind]) && !REDACTION_MARKS.includes(f));
      assert.deepEqual(unknown, [], `${kind}: body field(s) the cases here know no alternate value for: add one, or the field escapes the divergence test`);
      for (const field of fields.filter(f => f in ALTERNATE[kind])) {
        const arriving = base(kind, { [field]: ALTERNATE[kind][field] });
        const p = against(kind, base(kind), arriving);
        assert.deepEqual(p.verdicts, ['forked'], `${kind}.${field}: a different value at an equal seq does not fork`);
        assert.equal(p.forks.length, 1);
        assert.equal(p.forks[0].doc.forkOf, 'p');
        assert.equal(p.forks[0].doc.seq, 5, 'the planned fork carries the shared seq of the copy, which the writer then stamps locally');
        assert.equal(p.forks[0].doc.forkAt, 5, 'the fork records the shared version its id is derived from');
        // Q-324: the LOWER-hash copy is the parent. The fork is the arriving copy when it loses, and the stored copy when it wins (and the arriving copy swaps in).
        const forked = wins(kind, arriving, base(kind)) ? base(kind) : arriving;
        assert.equal(p.swaps.length, wins(kind, arriving, base(kind)) ? 1 : 0, `${kind}.${field}: the parent swap is not what the tie says`);
        assert.equal(p.forks[0].doc._id, P.forkIdFor('p', 5, H.authoredContentHash(kind, forked).text), `${kind}.${field}: the fork id is not derived from the body of the copy that lost the tie`);
        assert.equal(p.forkIds[0], p.forks[0].doc._id);
      }
    }
  });

  it('the same body with another updatedAt, createdAt, author, space, position, vector or local stamp is skipped', () => {
    leaf();
    const local = { pos: 9, posAtSeq: 5, embedding: [0.1, 0.2], embeddingModel: 'm', matchedText: 't', _expireAt: new Date(0), syncBase: { seq: 1 }, deliveredBy: 'i9' };
    for (const kind of P.FORKING_FAMILIES) {
      const stored = base(kind);
      for (const [what, over] of [['updatedAt', { updatedAt: T1 }], ['createdAt', { createdAt: T1 }], ['author', { author: { ...OTHER_AUTHOR } }],
        ['spaceId', { spaceId: 'elsewhere' }], ['position, vector and local stamps', local]]) {
        assert.deepEqual(against(kind, stored, base(kind, over)).verdicts, ['skipped'], `${kind}: a copy that differs only in ${what} is not skipped`);
      }
    }
  });

  it('a property spelled author, seq or pos is body: a difference in one forks', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      for (const key of ['author', 'seq', 'pos']) {
        const p = against(kind, base(kind, { properties: { [key]: 'a' } }), base(kind, { properties: { [key]: 'b' } }));
        assert.deepEqual(p.verdicts, ['forked'], `${kind}: a property named '${key}' that differs is read as version metadata and the copies are skipped`);
      }
    }
  });

  it('a copy without tags is the copy with [], and an entity without properties is the entity with {}: skipped, both ways round', () => {
    leaf();
    const without = (d, key) => Object.fromEntries(Object.entries(d).filter(([k]) => k !== key));
    for (const kind of ['chrono', 'facts', 'edges']) {
      assert.deepEqual(against(kind, base(kind, { tags: [] }), without(base(kind, { tags: [] }), 'tags')).verdicts, ['skipped'], `${kind}: no tags against []`);
      assert.deepEqual(against(kind, without(base(kind, { tags: [] }), 'tags'), base(kind, { tags: [] })).verdicts, ['skipped'], `${kind}: [] against no tags`);
    }
    assert.deepEqual(against('entities', base('entities', { properties: {} }), without(base('entities', { properties: {} }), 'properties')).verdicts, ['skipped'], 'no properties against {}');
    assert.deepEqual(against('entities', without(base('entities', { properties: {} }), 'properties'), base('entities', { properties: {} })).verdicts, ['skipped'], '{} against no properties');
  });

  it('the 11th is refused: the cap counts stored and in-page siblings together, for every kind', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      const variants = Array.from({ length: 4 }, (_, i) => base(kind, { [MAIN_FIELD[kind]]: `variant ${i}` }));
      // The stored copy is chosen to beat every variant under the tie rule (Q-324), so each variant is a plain fork and the cap is what is asked.
      const p = plan(kind, variants, { stored: new Map([['p', held(kind, lowestAgainst(kind, variants))]]), siblings: new Map([['p', P.MAX_FORKS_PER_RECORD - 2]]) });
      assert.deepEqual(p.verdicts, ['forked', 'forked', 'forkRefused', 'forkRefused'], `${kind}: the cap is not applied`);
      assert.equal(p.forks.length, 2);
    }
  });

  it('an arriving copy that wins the tie swaps in: the stored copy becomes the fork under the id its body derives, nothing is written but the swap and that fork (Q-324)', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      const mainField = MAIN_FIELD[kind];
      const arriving = base(kind, { [mainField]: 'the arriving body' });
      // A stored body that LOSES to the arriving one, found by search: the lower hash is the arriving copy's.
      let storedDoc;
      for (let i = 0; !storedDoc; i++) { const c = base(kind, { [mainField]: `stored ${i}` }); if (wins(kind, arriving, c)) storedDoc = c; }
      const p = against(kind, storedDoc, arriving);
      const loserId = P.forkIdFor('p', 5, H.authoredContentHash(kind, storedDoc).text);
      assert.deepEqual([p.verdicts, p.forkIds], [['forked'], [loserId]], `${kind}: the arriving copy won the tie, so what became a fork is the stored one`);
      assert.deepEqual(p.swaps.map(s => [s.index, s.doc, s.loserForkId]), [[0, arriving, loserId]], `${kind}: the arriving copy is not the swap`);
      assert.deepEqual([...p.accepts.keys()], [], `${kind}: a swap is written after its fork, so it is no accept`);
      assert.deepEqual(p.forks.map(f => [f.doc._id, f.doc.forkOf, f.doc.forkAt, f.doc[mainField]]), [[loserId, 'p', 5, storedDoc[mainField]]], `${kind}: the fork is not made of the stored row`);
      // A fork already stored under that id (a divergence from before the rule): only the parent changes.
      const known = against(kind, storedDoc, arriving, { existingForks: new Set([loserId]), siblings: new Map([['p', P.MAX_FORKS_PER_RECORD]]) });
      assert.deepEqual([known.verdicts, known.forks.length, known.swaps.length], [['forked'], 0, 1], `${kind}: a known loser fork must swap without minting another or consulting the cap`);
      // The loser would exceed the cap: the arriving copy is refused and the stored one stays, so no text is lost.
      const capped = against(kind, storedDoc, arriving, { siblings: new Map([['p', P.MAX_FORKS_PER_RECORD]]) });
      assert.deepEqual([capped.verdicts, capped.forks.length, capped.swaps.length], [['forkRefused'], 0, 0], `${kind}: a swap whose loser fork exceeds the cap must not swap`);
      // A stored copy handed over without its row is a door's defect, never a silent fork of the wrong side.
      assert.throws(() => plan(kind, [arriving], { stored: new Map([['p', { seq: 5, bodyHash: H.authoredContentHash(kind, storedDoc) }]]) }), /body/i, `${kind}: a swap without the stored row must throw`);
      // Equal and different copies of a STORED FORK take no part in the tie: no fork of a fork.
      const guard = P.equalSeqSwapGuard(kind, 'p', 5, storedDoc);
      assert.deepEqual([guard._id, guard.seq], ['p', 5]);
      for (const f of H.BODY_FIELDS_OF[kind]) assert.ok(f in guard, `${kind}: the swap guard leaves the body field '${f}' unnamed`);
    }
  });

  it('a later copy that wins over an earlier swap takes the stored-loser fork with it: a failed write of that fork is the later item\'s verdict, not the earlier one\'s (bundle-45 review, #8)', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      const field = MAIN_FIELD[kind];
      // Three bodies in tie order, found by sorting under the server's own rule: `lowest` beats `middle`, which beats the stored `highest`.
      const [lowest, middle, highest] = ['one', 'two', 'three'].map(t => base(kind, { [field]: `body ${t}` })).sort((a, b) => (wins(kind, a, b) ? -1 : 1));
      const p = plan(kind, [middle, lowest], { stored: new Map([['p', held(kind, highest)]]) });
      const storedForkId = P.forkIdFor('p', 5, H.authoredContentHash(kind, highest).text);
      const middleForkId = P.forkIdFor('p', 5, H.authoredContentHash(kind, middle).text);
      assert.deepEqual(p.swaps.map(s => [s.index, s.doc, s.loserForkId]), [[1, lowest, storedForkId]], `${kind}: the later copy did not take the swap over`);
      assert.deepEqual(p.forks.map(f => [f.doc._id, f.index]).sort(), [[middleForkId, 0], [storedForkId, 1]].sort(),
        `${kind}: the stored-loser fork keeps the earlier item's index, so a failed write of it marks the wrong item rejected`);
      assert.deepEqual(p.forkIds, [middleForkId, storedForkId], `${kind}: the items do not name their own forks`);
    }
  });

  it('two divergent copies of one id in one page decide as two pages would: the lower hash is written, the other is the fork, whichever came first (Q-324)', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      const field = MAIN_FIELD[kind];
      // Both orders of the same two copies.
      for (const order of [0, 1]) {
        const first = base(kind, { [field]: 'first copy' }), second = base(kind, { [field]: 'second copy' });
        const page = order === 0 ? [first, second] : [second, first];
        const lower = wins(kind, second, first) ? second : first;
        const higher = lower === first ? second : first;
        const p = plan(kind, page);
        assert.deepEqual(p.accepts.get('p').map(a => a.doc[field]), [lower[field]], `${kind}/${order}: the written parent is not the lower-hash copy`);
        assert.deepEqual(p.forks.map(f => f.doc[field]), [higher[field]], `${kind}/${order}: the higher-hash copy is not the one fork: it would be stored nowhere`);
        assert.equal(p.verdicts.filter(v => v === 'forked').length, 1, `${kind}/${order}: one of the two answers forked`);
        assert.equal(p.swaps.length, 0, `${kind}/${order}: nothing stored is displaced`);
      }
    }
  });

  it('a fork row and its subject in one page are both accepted: a fork edge shares its subject\'s five identity fields and is no duplicate', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      const subject = base(kind);
      const fork = forkRow(kind, { [MAIN_FIELD[kind]]: 'the other side' });
      const p = plan(kind, [subject, fork]);
      assert.deepEqual(p.verdicts, [FIRST(kind), FIRST(kind)], `${kind}: a fork row beside its subject is refused (an edge: as a duplicate of the identity it shares)`);
    }
  });

  it('a fork row whose parent is tombstoned is tombstoned: the deletion wins, whatever the seq', () => {
    leaf();
    for (const kind of P.FORKING_FAMILIES) {
      const p = plan(kind, [forkRow(kind, { [MAIN_FIELD[kind]]: 'the other side' })], { tombstones: new Map([['p', { seq: 3 }]]) });
      assert.deepEqual(p.verdicts, ['tombstoned'], `${kind}: a fork row of a deleted record is stored: an orphan that nothing will ever remove`);
      assert.equal(p.accepts.size + p.forks.length, 0);
    }
  });
});
