/**
 * Which pulled documents sync actually writes, and how they are scoped.
 *
 * Extracted from `batchUpsertBySeq` in `sync/engine.ts` (god-file split, slice 2). Since 5.6.2 the IO is the
 * arrival writer's (`sync/arrivals.ts`, where `batchUpsertBySeq` moved as `planArrivalWrites`); the decisions live in `upsert-plan.ts`
 * and are tested here with no database at all.
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

/*
 * Ported to 5.6.x with the arrival writer (`Q-218`): the IO moved from `sync/engine.ts` into `sync/arrivals.ts`,
 * where `planArrivalWrites` (once `batchUpsertBySeq`) is the writer's by-seq accept. These hold that the writer applies THIS
 * `planSeqUpserts`, that one tie-break rule decides every copy, and the derived fork id.
 */
describe('the arrival writer applies this accept, and no copy of it', () => {
  it('planArrivalWrites in sync/arrivals.ts calls planSeqUpserts for every write but a restore', async () => {
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const body = bodyOf(stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8')), 'planArrivalWrites');
    assert.match(body, /if \(restore\) return \{ toWrite: docs, stored \};/, 'a restore no longer bypasses the accept');
    assert.match(body, /toWrite: planSeqUpserts\(/, 'the writer accepts by a rule of its own instead of planSeqUpserts');
    assert.doesNotMatch(body, /\.seq\s*>=?\s*\w+\.seq|seq\s*>=\s*prev/, 'a hand-written seq comparison is back beside planSeqUpserts');
  });
});

describe('one accept rule: isNewerCopy', () => {
  it('strictly newer; nothing held is beaten by anything; a seq-less copy beats nothing held at a seq', async () => {
    const { isNewerCopy } = await import('../../server/dist/sync/upsert-plan.js');
    assert.deepEqual([isNewerCopy(5, 4), isNewerCopy(5, 5), isNewerCopy(4, 5)], [true, false, false]);
    assert.deepEqual([isNewerCopy(0, undefined), isNewerCopy(undefined, undefined), isNewerCopy(undefined, 0)], [true, true, false]);
  });

  it('the pull accept and the writer\'s collapse and read-back all ask it, and nothing else compares', async () => {
    /*
     * The accept was written three times (`doc.seq > prev` in `planSeqUpserts`, and the writer's collapse and its
     * read-back of a guarded write). Seen red by mutation, restored by hand: the writer's collapse written back as
     * a raw comparison.
     */
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { bodyOf } = await import('./_structural-window.mjs');
    const plan = stripComments(readFileSync('server/src/sync/upsert-plan.ts', 'utf8'));
    const writer = bodyOf(stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8')), 'writeArrivals');
    assert.match(bodyOf(plan, 'planSeqUpserts'), /isNewerCopy\(/, 'planSeqUpserts no longer asks isNewerCopy');
    assert.equal((writer.match(/isNewerCopy\(/g) ?? []).length, 2, 'the writer\'s collapse and read-back do not both ask isNewerCopy');
    // Any `x.seq > y` / `seq > z.seq` left is a second accept rule. The counter's high-water comparison is about a
    // different thing and is named, not hidden.
    const ALLOWED = /seq\s*>\s*out\.maxReceived|incoming\s*>\s*held/;
    const raw = [...plan.matchAll(/[\w.?)]+\s*>=?\s*[\w.(]+/g), ...writer.matchAll(/[\w.?)]+\s*>=?\s*[\w.(]+/g)]
      .map(m => m[0]).filter(e => /seq/i.test(e) && !ALLOWED.test(e));
    assert.deepEqual(raw, [], 'a seq comparison outside isNewerCopy decides which copy wins');
  });

  it('every DOOR that hands the writer an arrival asks isNewerCopy too, and compares no seqs of its own (R8)', async () => {
    /*
     * `Q-218` round R, item R8. The case above reads `upsert-plan.ts` and the writer's body, and its title says
     * "nothing else compares" — but the doors decide which documents reach the writer (the push routes read the
     * stored copy and choose insert, skip or fork before the writer re-checks), so a door that compares seqs itself
     * is a second accept rule the case above never looks at. The doors are DERIVED: every source file that calls
     * `writeArrivals(` outside the writer, with a floor. Seen red by mutation, restored by hand: one `isNewerCopy`
     * site in `api/sync/docs.ts` reverted to `!existing || incoming.seq > existing.seq`.
     *
     * What a door may still compare, each a different question from "which copy wins", named rather than hidden:
     *  - a TOMBSTONE against the arrival (`tomb.seq >= incoming.seq`): the deletion rule, not the accept;
     *  - a WATERMARK or high-water mark this side keeps, on the right of `>` (`maxSeq`, `highSeq`,
     *    `deliveredThrough`, a `since…` position, a `lastSeq…` pushed mark, zero): a position, not a stored copy.
     */
    const { readFileSync } = await import('node:fs');
    const { join } = await import('node:path');
    const { blankComments } = await import('./_strip-comments.mjs');
    const { trackedSources, REPO_ROOT } = await import('./_sources.mjs');
    const read = (f) => blankComments(readFileSync(join(REPO_ROOT, f), 'utf8'));
    const doors = trackedSources('server/src', { specs: false })
      .filter(f => f !== 'server/src/sync/arrivals.ts' && /\bwriteArrivals\s*\(/.test(read(f)));
    assert.ok(doors.length >= 3, `only ${doors.length} door(s) call writeArrivals: ${doors}`);
    const NOT_THE_ACCEPT = /^(?:tomb(?:stone)?\??\.seq\s*>=?\s*incoming\.seq|[\w.]*\s*>\s*(?:0|\w*maxSeq|highSeq|deliveredThrough|since\w*|lastSeq\w*))$/i;
    const raw = [];
    for (const f of doors) {
      const src = read(f);
      for (const m of src.matchAll(/[\w.?)\]!]+\s*>=?\s*[\w.(?]+/g)) {
        if (!/seq/i.test(m[0]) || NOT_THE_ACCEPT.test(m[0].trim())) continue;
        raw.push(`${f}:${src.slice(0, m.index).split('\n').length}: ${m[0]}`);
      }
    }
    assert.deepEqual(raw, [], 'a door compares seqs to decide which copy wins, beside isNewerCopy: a second accept rule '
      + 'that drifts from the writer\'s');
    const asking = doors.filter(f => /\bisNewerCopy\(/.test(read(f)));
    assert.ok(asking.length >= 1, 'no door asks isNewerCopy — the push doors decide which copy wins some other way');
  });
});

describe('a fork id is derived (`FK`)', () => {
  it('the same divergence gives the same id, a different text or seq another, v4-shaped', async () => {
    const { forkIdFor } = await import('../../server/dist/sync/upsert-plan.js');
    const a = forkIdFor('f', 5, 'x');
    assert.equal(a, forkIdFor('f', 5, 'x'));
    assert.notEqual(a, forkIdFor('f', 5, 'y'));
    assert.notEqual(a, forkIdFor('f', 6, 'x'));
    assert.match(a, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });
});

describe('divergesFrom and seqGuard — the fork rule and the write guard are each ONE function (Q-361 items 7, 9)', () => {
  it('divergesFrom: the same seq with other text, and nothing else, is a divergence', async () => {
    const { divergesFrom } = await import('../../server/dist/sync/upsert-plan.js');
    assert.equal(divergesFrom({ seq: 5, fact: 'a' }, { seq: 5, fact: 'b' }), true);
    assert.equal(divergesFrom({ seq: 5, fact: 'a' }, { seq: 5, fact: 'a' }), false, 'the same text is one version, not a divergence');
    assert.equal(divergesFrom({ seq: 5, fact: 'a' }, { seq: 6, fact: 'b' }), false, 'a different seq is newer or older, not a fork');
    assert.equal(divergesFrom(null, { seq: 5, fact: 'b' }), false, 'nothing stored: nothing to diverge from');
    assert.equal(divergesFrom(undefined, { seq: 5, fact: 'b' }), false);
    assert.equal(divergesFrom({ seq: 5 }, { seq: 5 }), false, 'a record with no text (an entity) never diverges');
  });

  it('seqGuard: a stored copy below the seq, or with none, or none at all — and by id alone for a copy with no seq', async () => {
    const { seqGuard } = await import('../../server/dist/sync/upsert-plan.js');
    assert.deepEqual(seqGuard('x', 7), { _id: 'x', $or: [{ seq: { $lt: 7 } }, { seq: { $exists: false } }] });
    assert.deepEqual(seqGuard('x', 0), { _id: 'x', $or: [{ seq: { $lt: 0 } }, { seq: { $exists: false } }] }, 'seq 0 is a seq');
    assert.deepEqual(seqGuard('x', undefined), { _id: 'x' });
    assert.deepEqual(seqGuard('x', 'not a number'), { _id: 'x' });
  });
});
