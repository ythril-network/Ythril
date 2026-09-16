/**
 * An edge whose identity CHANGES takes the id that identity derives.
 *
 * ## What this closes
 *
 * An edge's `_id` is `uuidv5` over `(from, to, label)`, so two peers creating the same relationship arrive at
 * the same id without talking and the sync collision becomes an idempotent no-op. Mongo's `_id` is immutable,
 * though, and two paths mutate an edge's identity in place: `merge.ts` relinks by setting `from`/`to`, and
 * `updateEdgeById` accepts a new `label`. After either, the stored id no longer equalled its derivation — so
 * the next peer to create that triplet derived the correct id, inserted, and hit the unique index instead of
 * converging. One relationship, two identities, a duplicate key on every cycle: exactly the defect the
 * derivation was for, surviving on the two paths that change what an edge IS.
 *
 * `an-edge-id-is-derived-from-its-identity.test.js` pinned that limit deliberately, so it would be visible in
 * source rather than only in a tracker. Its three assertions are inverted here rather than deleted: the same
 * two paths are still the subject, and what changed is which way they must behave.
 *
 * ## Why delete-and-insert is safe on a synced collection
 *
 * The old id and the new id are different documents, so the delete and the insert never touch the same row and
 * their order does not matter to the final state. What matters is the seq:
 *
 *  - the **tombstone** for the old id propagates through `/api/sync/tombstones`, which applies no `originalSeq`
 *    filter — that filter belongs to the tombstone STUBS appended to the docs stream, and is a dedup for that
 *    stream rather than the delete channel;
 *  - the **insert** carries a seq taken after the tombstone's, so a peer that pulls the tombstone and stops has
 *    a cursor BELOW the insert and picks the edge up on its next pull. A seq below the tombstone's would let a
 *    peer advance past the insert and keep only the delete — which is the one ordering that loses the edge.
 *
 * A peer applying the incoming edge checks `tombstone.seq >= incoming.seq` and skips. A fresh seq is always
 * above any tombstone, so a relationship that is later re-keyed BACK to a previous id is re-created rather than
 * suppressed by the tombstone left behind the first time.
 *
 * Run: node --test testing/standalone/an-edge-that-is-re-keyed-converges.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, argumentsOf } from './_structural-window.mjs';

const src = (p) => stripComments(readFileSync(p, 'utf8'));

const { edgeIdFor } = await import('../../server/dist/brain/edge-id.js');

describe('the re-key is one implementation, not one per path', () => {
  it('there is a named helper, and both paths reach it', () => {
    /*
     * Two callers changing an edge's identity two ways is precisely the shape `CLAUDE.md` calls the defect
     * this repo produces most — and a re-key written twice would be two chances to get the tombstone wrong,
     * on the one collection where getting it wrong loses a record on a peer rather than locally.
     */
    assert.match(src('server/src/brain/edge-rekey.ts'), /export async function rekeyEdge\b/,
      'the re-key must be a named function, not an inline delete-and-insert at each call site');
    assert.match(src('server/src/brain/merge.ts'), /rekeyEdge\(/,
      'merge still mutates an endpoint in place, so a relinked edge keeps an id its identity does not derive');
    assert.match(bodyOf(src('server/src/brain/edges.ts'), 'updateEdgeById'), /rekeyEdge\(/,
      'a label change still leaves the edge under its old id');
    /*
     * Its own module, and that is not tidiness. `merge.ts` is the second caller, so putting it in `edges.ts`
     * would make the two largest brain modules depend on each other at runtime for one function — and
     * `edges.ts` was at its 650-line ceiling, which is what A-4 is queued to pay down.
     */
    assert.doesNotMatch(src('server/src/brain/merge.ts'), /from '\.\/edges\.js'/,
      'merge reaches the re-key through edges.ts, a runtime dependency between the two biggest brain modules');
  });

  it('the new id is DERIVED, never composed here', () => {
    // A second spelling of the identity is how the two would drift. `edgeIdFor` is the only one.
    const body = bodyOf(src('server/src/brain/edge-rekey.ts'), 'rekeyEdge');
    assert.match(body, /edgeIdFor\(/, 'the new id must come from the derivation the unique index agrees with');
    assert.doesNotMatch(body, /uuidv4|randomUUID/, 'a re-keyed edge must not be given a fresh random id');
  });

  it('an unchanged identity is not re-keyed', () => {
    // The common case by far: an ordinary field patch. Delete-and-inserting it would write a tombstone and a
    // new seq for every description edit, and briefly remove the edge from every peer for no reason at all.
    const body = bodyOf(src('server/src/brain/edge-rekey.ts'), 'rekeyEdge');
    assert.match(body, /=== existing\._id|=== oldId|newId === /,
      'the helper must return early when the derived id is the one already stored');
  });
});

describe('the delete half leaves a tombstone a peer can act on', () => {
  const body = () => bodyOf(src('server/src/brain/edge-rekey.ts'), 'rekeyEdge');

  it('a tombstone is written, not a bare delete', () => {
    /*
     * `renameFileMeta` is named in `edge-id.ts` as the model for this, and it is NOT one: it deletes and
     * re-inserts with no tombstone and no new seq, on the stated grounds that file meta is best-effort and
     * disk is the source of truth. Copying it here would leave every peer holding the edge under its old id
     * for ever, beside the new one — two rows for one relationship, which is what the unique index exists to
     * prevent.
     */
    assert.match(body(), /spaceCollection\([A-Za-z]+, 'tombstones'\)/,
      'without a tombstone a peer keeps the old id for ever, beside the new one');
    assert.match(body(), /type: 'edge'/, 'the tombstone must name the collection it belongs to');
  });

  it('the insert takes a LATER seq than the tombstone', () => {
    /*
     * The one ordering that loses the edge. A peer that pulls the tombstone and stops has advanced its cursor
     * past the delete; if the insert sits below that cursor it is never sent, and the peer is left with
     * neither id. Above it, the peer picks the edge up on its next pull and the window is a sync cycle rather
     * than for ever.
     */
    const b = body();
    const tombAt = b.search(/const tombSeq/);
    const insAt = b.search(/const insertSeq/);
    assert.ok(tombAt > 0 && insAt > 0, 'both seqs must be taken explicitly, so their ORDER is visible here');
    assert.ok(tombAt < insAt,
      'the insert seq is taken first, so a peer can advance past the insert and keep only the delete');

    /*
     * AND each write must use the one it was given. Checking the declaration order alone pins a SPELLING:
     * swapping which variable each write consumes leaves the declarations in place and inverts the property,
     * and the gate would not notice. That is the same wrong-axis mistake this file was written to replace.
     */
    const tombWrite = b.slice(b.indexOf("'tombstones'"));
    assert.match(tombWrite.slice(0, 400), /seq: tombSeq/,
      'the tombstone is stamped with the later seq, so a peer can advance past the insert');
    const insertDoc = b.slice(b.indexOf('const stored ='));
    assert.match(insertDoc.slice(0, 300), /seq: insertSeq/,
      'the re-inserted edge carries the earlier seq, which is the ordering that loses it');
  });

  it('the embed queue is NOT touched inside the re-key', () => {
    /*
     * `enqueueEmbedJob` and `retireEmbedJob` take no session, so inside merge's `withTransaction` they commit
     * while the edge is still uncommitted — and `enqueueEmbedJob` wakes the worker synchronously. The
     * transaction then runs on through the memory, chrono and file relinking and an `await embed(...)` round
     * trip, which is ample time for the worker to claim the job, fail to see the insert, report `gone` —
     * counted as SUCCESS — and delete it. The commit then lands an edge with no vector and no job, and
     * nothing re-enqueues it.
     *
     * Retiring inside the transaction fails in the mirror direction: an abort rolls the delete back and the
     * surviving edge has already lost its job.
     */
    const b = body();
    assert.doesNotMatch(b, /enqueueEmbedJob\(|retireEmbedJob\(/,
      'the re-key touches the embed queue itself, so the worker can act on a write that has not committed');
  });

  it('and both callers drain it once their write is durable', () => {
    // The work still has to happen: a job keyed by the old id outlives its record, and the embed text is
    // built from the label and the endpoint NAMES, so every re-key changes it.
    const upd = bodyOf(src('server/src/brain/edges.ts'), 'updateEdgeById');
    const at = upd.indexOf('rekeyEdge(');
    assert.match(upd.slice(at), /retireEmbedJob\(/, 'the PATCH path never retires the job for the old id');
    assert.match(upd.slice(at), /enqueueEmbedJob\(/, 'the re-keyed edge is never queued for embedding');

    const merge = src('server/src/brain/merge.ts');
    const commitAt = merge.indexOf('await session.endSession()');
    assert.ok(commitAt > 0, 'merge no longer ends its session here — re-point this gate');
    assert.match(merge.slice(commitAt), /enqueueEmbedJob\(/,
      'merge queues the embedding before the transaction has committed, or not at all');
    assert.doesNotMatch(merge.slice(0, commitAt), /enqueueEmbedJob\(/,
      'merge still enqueues inside the transaction, which is what wakes the worker too early');
  });
});

describe('a field the caller REMOVED does not survive the move', () => {
  it('rekeyEdge takes the removals, not only the additions', () => {
    /*
     * `updateEdgeById` builds a `$set` AND a `$unset`. Passing only `$set` meant `rekeyEdge` wrote
     * `{ ...existing, ...alsoSet }` — spreading every removed field back in from the stored document — and
     * the removal was then applied to the RETURNED copy alone. The caller got a 200 saying the field was
     * gone and the database kept it.
     *
     * `$unset` carries more than `deleteFields`: `applyExpiryToUpdate` puts `_expireAt` there for
     * `ttlDays: null`, and `mirrorLegacySuppression` puts the pre-3.1 suppression key there. The TTL case is
     * the dangerous one — the owner is told with a 200 that the edge will no longer expire, and the sweep
     * deletes it on the original schedule.
     */
    const sig = bodyOf(src('server/src/brain/edge-rekey.ts'), 'rekeyEdge');
    assert.match(sig, /alsoUnset|unset/i,
      'rekeyEdge cannot honour a removal it is never told about');
    const call = bodyOf(src('server/src/brain/edges.ts'), 'updateEdgeById');
    const at = call.indexOf('rekeyEdge(');
    assert.ok(at > 0, 'the re-key branch is gone — re-point this gate');
    // The call's ARGUMENTS, not a character window past it: a fixed count spans different lines on CRLF than
    // on CI's LF, and one that falls short of the argument list is a gate that passes by looking at less.
    assert.match(argumentsOf(call, at).join(', '), /\$unset/,
      'the re-key branch still passes $set alone, so deleteFields and a TTL clear are reported and not made');
  });

  it('the removal is applied to the STORED document, not to the response copy', () => {
    // The distinction the previous shape got wrong. Deleting the keys from the object that is returned makes
    // the response and the row disagree, which a GET immediately after the PATCH contradicts.
    const body = bodyOf(src('server/src/brain/edge-rekey.ts'), 'rekeyEdge');
    const insertAt = body.indexOf('insertOne');
    assert.ok(insertAt > 0);
    const beforeInsert = body.slice(0, insertAt);
    assert.match(beforeInsert, /delete .*\[|delete stored/,
      'nothing removes the unset keys before the document is written');
  });
});

describe('the delete has to be one a PEER will actually apply', () => {
  const body = () => bodyOf(src('server/src/brain/edge-rekey.ts'), 'rekeyEdge');

  it('an edge this instance did not author is NOT re-keyed', () => {
    /*
     * The half that turns this change from a fix into a regression if it is missed.
     *
     * `applyRemoteTombstone` refuses to delete a local document whose `author.instanceId` differs from the
     * tombstone's issuer — that guard exists so a remote tombstone cannot delete locally-authored content,
     * and it fires silently. Edges replicate carrying their ORIGINAL author, so a tombstone this instance
     * issues for an edge a peer authored is dropped by that peer, while the insert half propagates normally
     * (the edges pull has no author filter). The peer would keep the old row AND gain the new one:
     * two rows for one relationship, which is worse than the limit this change removes, because the old row
     * still claims a relationship that no longer exists.
     *
     * Re-stamping the tombstone with the document's own author does not help — it clears that guard and
     * then fails the delivering-peer check below it, logged as cross-instance delete forgery.
     *
     * So the re-key is declined for an edge authored elsewhere and the caller falls through to its ordinary
     * in-place update, which is exactly what happened before this change and converges. The residual limit is
     * narrower than the one it replaces and is stated in the docblock.
     */
    const b = body();
    assert.match(b, /author\?\.instanceId|author\.instanceId/,
      'the re-key must compare the document author against this instance, or a peer silently keeps both rows');
    assert.match(b, /getConfig\(\)\.instanceId/, 'it has to know which instance it is');
    const at = b.search(/author[^\n]*instanceId/);
    assert.ok(at > 0 && at < b.indexOf('deleteOne'),
      'the authorship check runs after the delete, so the row is gone before the decision is made');
  });

  it('and declining reads as `null`, so the caller does its ordinary update', () => {
    // Not a throw and not a silent no-op: `null` already means "identity unchanged, carry on", and a
    // declined re-key needs exactly the same fallback. A second signal would be a second branch to forget.
    const b = body();
    const decline = b.slice(b.search(/author[^\n]*instanceId/));
    assert.match(decline.slice(0, 400), /return null/,
      'declining must return null, which is what both callers already handle');
  });

  it('merge falls back to relinking in place rather than dropping the edge', () => {
    // Phase 1b used to `$set` from/to. It must still do that for an edge it may not re-key, or a merge
    // would leave the endpoint pointing at the absorbed entity.
    const merge = src('server/src/brain/merge.ts');
    const body1b = merge.slice(merge.indexOf('for (const edge of edgesToRelink)'));
    assert.match(body1b.slice(0, 1400), /updateOne|\$set/,
      'a relink the re-key declines has no fallback, so the absorbed endpoint survives the merge');
  });
});

describe('the caller-facing contract of a re-key', () => {
  const body = () => bodyOf(src('server/src/brain/edges.ts'), 'updateEdgeById');

  it('If-Match is still honoured on the branch that re-keys', () => {
    /*
     * There is no `findOneAndUpdate` on this branch, so `writeFilterFor` — which is what applies the
     * precondition everywhere else — never runs. A lever that silently stops working on exactly one kind of
     * patch is the shape of defect this file's neighbours keep fixing, and it would fail open: the write
     * lands, and the caller is told their condition held.
     */
    const b = body();
    const at = b.indexOf('rekeyEdge(');
    assert.ok(at > 0, 'the re-key branch is gone — re-point this gate');
    const before = b.slice(0, at);
    assert.match(before, /ifMatchSeq !== undefined && existing\.seq !== ifMatchSeq/,
      'the precondition must be checked before the re-key, not left to a filter that does not run here');
  });

  it('the delete and the insert are ATOMIC', () => {
    /*
     * Every other patch on this route is one `findOneAndUpdate` and is atomic for free. A re-key is two
     * writes, so a crash or a dropped connection between them leaves the caller's relationship in NEITHER
     * id — gone, behind a 500 that says nothing about what happened to it. `merge.ts` already runs its
     * re-keys inside `withTransaction`; this path had nothing.
     */
    const b = body();
    const at = b.indexOf('rekeyEdge(');
    assert.ok(at > 0, 'the re-key branch is gone — re-point this gate');
    assert.match(b.slice(0, at), /withTransaction\(/,
      'the delete and the insert are not in a transaction, so a failure between them loses the edge');
    assert.match(b, /endSession\(\)/, 'the session is never ended');
  });

  it('the re-key branch counts as a write, like every other outcome', () => {
    // The metric is how a lost update is seen at all. A branch that writes without counting makes the
    // counter quietly describe a subset of writes.
    const b = body();
    const at = b.indexOf('rekeyEdge(');
    assert.match(b.slice(at), /brainWriteSeqTotal/, 'a successful re-key must be counted');
  });
});

describe('the insert half is the same relationship, not a new one', () => {
  const body = () => bodyOf(src('server/src/brain/edge-rekey.ts'), 'rekeyEdge');

  it('the stored document is carried over rather than rebuilt', () => {
    // `createdAt`, `author`, `tags`, `description` and `properties` describe the relationship, and the
    // relationship did not change — only which entities it connects, or what it is called. Rebuilding the
    // document would silently reset an edge's provenance on every entity merge.
    assert.match(body(), /\.\.\.existing/, 'the re-keyed edge must carry the stored document forward');
  });

  it('a triplet that is already taken is refused, not thrown as a duplicate key', () => {
    /*
     * `merge.ts` already resolves this upstream — `detectDuplicateEdges` finds the absorbed edges whose
     * post-relink triplet a survivor edge already holds, and deletes them rather than relinking. So this is
     * the guard for the case that upstream missed, and a raw E11000 reaching a caller says nothing about what
     * they did wrong.
     */
    const b = body();
    assert.match(b, /findOne\([\s\S]*_id: newId/,
      'the target id must be checked before the insert, or the driver reports it as an index violation');
    assert.match(b, /throw new EdgeIdentityTaken\(/,
      'the refusal must be a named error carrying which edge is in the way');
    /*
     * And it has to be CAUGHT, or a named error is only a nicer stack trace. An uncaught throw leaves REST
     * answering a bare 500 "Internal server error" while MCP shows the message — the same refusal reading as
     * a server fault on one door and a caller error on the other, which is the parity defect this repo
     * produces most, arriving through an error path rather than a parameter.
     */
    const route = src('server/src/api/brain/edges.ts');
    assert.match(route, /err instanceof EdgeIdentityTaken/,
      'REST answers 500 for a caller naming a relationship that already exists');
    assert.match(route, /status\(409\)/,
      'a taken identity is a conflict, not a server fault');
    // And it must be thrown BEFORE anything is written, or a refused re-key leaves the edge deleted.
    assert.ok(b.indexOf('EdgeIdentityTaken') < b.indexOf('deleteOne'),
      'the check runs after the delete, so a taken identity destroys the edge it refused to move');
  });
});

describe('merge computes the post-relink identity the same way the index does', () => {
  it('the duplicate check keys on the derivation, not on a joined string', () => {
    /*
     * It built `${from}|${to}|${label}`, which is ambiguous the moment any part contains the separator — the
     * exact ambiguity `edgeIdFor` length-prefixes against, and a label is operator-supplied text. Two distinct
     * relationships could collide on that key and be reported as duplicates of each other; with the merge now
     * re-keying through `edgeIdFor`, an unprefixed second spelling of the identity is also a second answer to
     * the question the unique index already settles.
     */
    const merge = src('server/src/brain/merge.ts');
    assert.doesNotMatch(merge, /\$\{[a-zA-Z.]*from\}\|\$\{/,
      'the post-relink key is a joined string, so a label containing a pipe collides two distinct edges');
  });

  it('and the derivation says those two are different edges', () => {
    // The property the joined key cannot express, asserted against the real function rather than described.
    assert.notEqual(edgeIdFor('a|b', 'c', 'd'), edgeIdFor('a', 'b|c', 'd'));
  });
});

describe('the limit is gone from where it was stated', () => {
  it('edge-id.ts no longer says an identity change keeps the old id', () => {
    // A stale limit is invisible: nobody reports being able to do the thing they were told they could not.
    const raw = readFileSync('server/src/brain/edge-id.ts', 'utf8');
    assert.doesNotMatch(raw, /keeps its old id/i,
      'the docblock still states the limit this change removed');
  });

  it('and both doors TELL a caller their id moved', () => {
    /*
     * Not the absence of a limit — this one was never written down, and asserting a phrase is missing from a
     * page that never had it passes for the wrong reason. What a caller needs is the positive statement: a
     * label patch answers with a DIFFERENT `_id`, and reusing the one they sent gets a 404.
     *
     * A response shape that changes with no surface saying so is the quietest kind of breaking change: the
     * call succeeds, and the caller's next request fails somewhere else.
     */
    /*
     * On the GRAPH page, which owns edge identity — and beside the PATCH semantics as a pointer, because a
     * contract a reader cannot reach from the route they are reading is one they will not find.
     *
     * That pointer used to be on `04-brain-api.md`, which sat exactly at the 900-line ceiling and so had to
     * take it in place of an existing line. A-5 split the page and the PATCH semantics moved with it, so the
     * pointer is read from `04f-write-semantics.md` now — the file that documents the route it warns about.
     */
    const graph = readFileSync('docs/integration-guide/04b-graph-api.md', 'utf8').replace(/\s+/g, ' ');
    assert.match(graph, /DERIVED from the relationship/, 'the graph page does not explain the derived id');
    assert.match(graph, /different `_id`/, 'it does not say a label patch moves the edge');
    assert.match(graph, /404/, 'it does not say what happens to the id the caller was holding');

    const brain = readFileSync('docs/integration-guide/04f-write-semantics.md', 'utf8').replace(/\s+/g, ' ');
    assert.match(brain, /patching an edge's `label` changes its `_id`/,
      'the page documenting the PATCH route does not warn that this one field moves the record');

    const tool = readFileSync('server/src/mcp/tools/edge.ts', 'utf8').replace(/\s+/g, ' ');
    assert.match(tool, /CHANGES THE `_id`/,
      'update_edge does not say its result carries a different id — which is what a caller reads while '
      + 'constructing the NEXT call');
  });
});
