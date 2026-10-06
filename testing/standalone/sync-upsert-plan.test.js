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

let planArrivals, retagToLocalSpace;

before(async () => {
  ({ planArrivals, retagToLocalSpace } = await import('../../server/dist/sync/upsert-plan.js'));
});

const doc = (id, seq, extra = {}) => ({ _id: id, seq, ...extra });
const ids = (list) => list.map(d => d._id);
/**
 * The ids a PULLED page writes, given the seq each id has locally: the accepted winners, in page order. An entity
 * never forks, so last-writer-wins by seq is the whole of its rule — the rule the pull's `planSeqUpserts` was.
 */
const writes = (docs, existing) => {
  const stored = new Map([...existing].map(([id, seq]) => [id, { seq }]));
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
    const engine = bodyOf(stripComments(readFileSync('server/src/sync/engine.ts', 'utf8')), 'pullFromPeer');
    assert.match(engine, /acceptArrivingPage\([^)]*door: 'pull'/s, 'the pull no longer hands its pages to the page accept');
    assert.doesNotMatch(engine, /writeArrivals\(/, 'the pull writes its pages without the page accept again');
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
    const { isNewerCopy } = await import('../../server/dist/sync/upsert-plan.js');
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
    assert.equal((writer.match(/isNewerCopy\(/g) ?? []).length, 2, 'the writer\'s collapse and read-back do not both ask isNewerCopy');
    // Any `x.seq > y` / `seq > z.seq` left is a second accept rule. The tombstone and counter comparisons are
    // about different things (a deletion's seq, the counter's high-water mark) and are named, not hidden.
    const ALLOWED = /tomb\s*>=\s*doc\.seq|curSeq\s*>\s*tomb|seq\s*>\s*out\.maxReceived|incoming\s*>\s*held/;
    const raw = [...plan.matchAll(/[\w.?)]+\s*>=?\s*[\w.(]+/g), ...writer.matchAll(/[\w.?)]+\s*>=?\s*[\w.(]+/g)]
      .map(m => m[0]).filter(e => /seq/i.test(e) && !ALLOWED.test(e));
    assert.deepEqual(raw, [], 'a seq comparison outside isNewerCopy decides which copy wins');
  });
});

describe('the fork caps\' index is declared once', () => {
  it('initSpace and ensureQueryIndexes both create FORK_INDEXES, and nobody spells the index', async () => {
    // Dup pass: `{ forkOf: 1 }, { sparse: true }` was written in both. Seen red by mutation, restored by hand: the
    // literal put back in ensure-query-indexes.ts.
    const { readFileSync } = await import('node:fs');
    const { stripComments } = await import('./_strip-comments.mjs');
    const { readTrackedSources } = await import('./_sources.mjs');
    // The RULE is "every FORK_INDEXES entry is created from the one list", not one loop shape: a `for (const ix of FORK_INDEXES)`
    // and a `...FORK_INDEXES.map(ix => ...)` / `.forEach` both iterate the list (bundle-53 G21 moved the second site into the
    // walk's unit list). What must hold either way: the list is iterated, and the index created is read from the entry's
    // `keys` — a site that iterates the list and then spells its own keys would still be a second declaration.
    const iterates = /\bfor \(const (\w+) of FORK_INDEXES\)|\bFORK_INDEXES\.(?:map|forEach)\(\s*\(?(\w+)\)?\s*=>/;
    for (const f of ['server/src/spaces/lifecycle.ts', 'server/src/spaces/ensure-query-indexes.ts']) {
      const src = stripComments(readFileSync(f, 'utf8'));
      const m = iterates.exec(src);
      assert.ok(m, `${f} no longer creates FORK_INDEXES`);
      const entry = m[1] ?? m[2];
      assert.match(src.slice(m.index), new RegExp(`createIndex\\(\\s*${entry}\\.keys\\b`),
        `${f} iterates FORK_INDEXES but does not create the index from the entry's keys`);
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
    assert.deepEqual([P.divergesFrom({ seq: 5, fact: 'a' }, { seq: 5, fact: 'b' }), P.divergesFrom({ seq: 5, fact: 'a' }, { seq: 5, fact: 'a' }),
      P.divergesFrom({ seq: 5, fact: 'a' }, { seq: 4, fact: 'b' }), P.divergesFrom({ seq: 5, fact: 'a' }, undefined)], [true, false, false, false]);
    const src = stripComments(readFileSync('server/src/sync/upsert-plan.ts', 'utf8'));
    for (const fn of ['forkCandidates', 'planArrivals']) assert.match(bodyOf(src, fn), /divergesFrom\(/, `${fn} no longer asks divergesFrom`);
    // Q-232: the writer's read-back asks it too, so a same-seq copy with other text is a divergence, never "landed".
    const writer = bodyOf(stripComments(readFileSync('server/src/sync/arrivals.ts', 'utf8')), 'writeArrivals');
    assert.match(writer, /divergesFrom\(d, held\)/, 'the writer\'s read-back no longer asks divergesFrom');
    const inline = [...src.matchAll(/\.fact\s*!==\s*[\w.]+\.fact/g)].length;
    assert.equal(inline, 1, 'a fact-text comparison is written outside divergesFrom');
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

  it('an equal seq: equal text is skipped, divergent text forks; an entity never forks', () => {
    assert.deepEqual(plan('facts', [doc('f', 5, { fact: 'x' }), doc('f', 5, { fact: 'x' })]).verdicts, ['inserted', 'skipped']);
    const split = plan('facts', [doc('f', 5, { fact: 'x' }), doc('f', 5, { fact: 'y' })]);
    assert.deepEqual(split.verdicts, ['inserted', 'forked']);
    assert.equal(split.forks[0].doc.forkOf, 'f');
    assert.deepEqual(plan('entities', [doc('e', 5), doc('e', 5)]).verdicts, ['upserted', 'skipped']);
  });

  it('a tombstone at or above the seq tombstones; one below is cleaned only when the record lands', () => {
    // A held tombstone is its seq and issuer (bundle-46); these carry no issuer, so they govern as they always did.
    const tombstones = new Map([['a', { seq: 7 }], ['b', { seq: 3 }]]);
    const p = plan('entities', [doc('a', 7), doc('b', 4)], { tombstones });
    assert.deepEqual(p.verdicts, ['tombstoned', 'upserted']);
    assert.deepEqual(p.tombstoneCleanups.get('b'), { below: 4, onLanding: true });
    assert.equal(p.tombstoneCleanups.has('a'), false);
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
