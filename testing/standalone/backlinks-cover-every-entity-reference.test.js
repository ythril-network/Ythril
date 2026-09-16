/**
 * `findEntityReferences` must scan every collection that can reference an entity — derived, not listed.
 *
 * ## The gap this was written for
 *
 * Under `strictLinkage`, deleting an entity is supposed to 409 while ANY reference to it exists — an edge at
 * either end included, which the refusal used to describe as "inbound". The check is
 * `findEntityReferences`, and it scanned four things: `_edges`, `memories.entityIds`, `chrono.entityIds`, and
 * `files.faceEntityId`. **`files.entityIds` was not among them** — so an entity referenced only by a file's
 * `entityIds` deleted cleanly, and the file was left pointing at a record that no longer exists.
 *
 * The comment above the face scan is the tell: *"which is why the other three scans missed them"*. The same
 * collection had already been patched once, for `faceEntityId`, and its sibling field was not added alongside.
 *
 * ## Why derived rather than a list of four
 *
 * A hard-coded list is how the field was missed in the first place, and the same derivation already guards the
 * merge path (`merge-relinks-every-entity-reference.test.js`). So this reads `config/types.ts` for every record
 * type declaring `entityIds` and requires a scan of each one's collection. **A new record type that carries an
 * entity reference fails this gate on the day it is declared**, which is the only version of this check that
 * stays true.
 *
 * ## Why it asserts on source
 *
 * `findEntityReferences` is four Mongo round trips and nothing else; exercising it needs a live database, and the
 * neighbouring `strict-link-enforcement.test.js` shows what happens when that is avoided by other means — it
 * asserts against a **local reimplementation** of the backlink logic, so it passed happily for as long as the
 * real function was missing a collection. A test of a copy of the rule cannot see the rule being wrong.
 *
 * Run: node --test testing/standalone/backlinks-cover-every-entity-reference.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { bodyOf, statementAround } from './_structural-window.mjs';

const TYPES = 'server/src/config/types.ts';
const ENTITIES = 'server/src/brain/entities.ts';

/** Every record interface in `config/types.ts` that declares an `entityIds` field. */
function typesWithEntityIds() {
  const lines = stripComments(readFileSync(TYPES, 'utf8')).split(/\r?\n/);
  const found = [];
  let current = null;
  for (const line of lines) {
    const m = /^export interface (\w+)/.exec(line);
    if (m) current = m[1];
    if (/^\s*entityIds\??\s*:/.test(line) && current) found.push(current);
  }
  return [...new Set(found)];
}

/** The collection suffix each record type lives in. */
const COLLECTION_FOR = {
  FactDoc: 'facts',
  ChronoEntry: 'chrono',
  FileMetaDoc: 'files',
};

const backlinkFn = () => bodyOf(stripComments(readFileSync(ENTITIES, 'utf8')), 'findEntityReferences');

describe('backlinks cover every entity reference', () => {
  it('the derivation finds the record types before it is trusted', () => {
    // A gate that derives nothing passes vacuously and would keep passing if the interfaces moved.
    const types = typesWithEntityIds();
    assert.ok(types.length >= 3, `only found ${types.length} types with entityIds in ${TYPES}`);
    for (const t of ['FactDoc', 'ChronoEntry', 'FileMetaDoc']) {
      assert.ok(types.includes(t), `expected ${t} to declare entityIds; got: ${types.join(', ')}`);
    }
  });

  it('the scan is DERIVED from the link classes, not three hand-written blocks', () => {
    /*
     * This case used to assert that `findEntityReferences` names `_facts`, `_chrono` and `_files`
     * literally, and it was right to while the function held three near-identical query blocks. It now
     * loops `LINK_CLASSES`, so the collection names are not in it at all — and asserting the old spelling
     * would fail on the change that made the rule structural.
     *
     * **The rule it was standing in for has not moved:** an entity referenced only by a record this scan
     * cannot see deletes cleanly under `strictLinkage`, and the referring record is left pointing at a
     * tombstone. What changed is that a SEVENTH class is now covered by the commit that declares it,
     * instead of needing a fourth block that would be forgotten — the way the file one was.
     */
    /*
     * `LINK_CLASSES.filter(...)` since the per-class loop became ONE batched call. The derivation is the same
     * and the round-trip count is not: per class it was six link queries plus six document reads for a single
     * delete, which measured 3.8× slower than the arrays it replaced (`benchmarks/LINK-READERS.md`).
     *
     * Matching the `for` keyword was checking a spelling. What must hold is that the class list comes from
     * `LINK_CLASSES` and is narrowed by the kind being deleted.
     */
    const body = backlinkFn();
    assert.match(body, /LINK_CLASSES\.filter\(|for \(const cls of LINK_CLASSES\)/,
      'findEntityReferences no longer derives its scans from LINK_CLASSES. A hand-written block per class is '
      + 'how the file class came to be missing while the face scan beside it was present.');
    assert.match(body, /toKind === targetKind|toKind !== targetKind/,
      'the class list must be narrowed to the classes that point at the KIND being deleted, or an entity '
      + 'delete reports blockers of every other kind as well');
  });

  it('and the scan it delegates to opens the class\'s OWN collection and field', () => {
    /*
     * The half the loop above cannot state: a loop over six classes that queried one collection would pass
     * every assertion in this file and answer about the wrong data six times.
     *
     * Both storage shapes are checked. The array path must reach `linksToAny`, which is what carries the
     * chunk exclusion; the link-record path must narrow its results by reading the records, because a link
     * row has no `parentFileId` and a chunk link is otherwise indistinguishable from a file link.
     *
     * `referencesByClass` since the scan was batched — one query for every class rather than one per class.
     */
    const fn = bodyOf(stripComments(readFileSync(ENTITIES, 'utf8')), 'referencesByClass');
    assert.ok(fn, 'referencesByClass not found — re-anchor this gate');
    assert.match(fn, /\$\{spaceId\}_\$\{cls\.collection\}/,
      'the array path hardcodes a collection instead of taking the class\'s own');
    assert.match(fn, /linksToAny\(spaceId, cls,/,
      'the array path must go through the shared builder, which is what carries the chunk exclusion');
    assert.match(fn, /usesLinkRecords\(spaceId\)/,
      'the storage shape must be chosen by the one selector, never decided in a reader');
    assert.match(fn, /docsFromCollection[<(]/,
      'the link-record path returns ids from a collection with no `parentFileId`, so it must narrow them by '
      + 'reading the records — otherwise a forty-passage document comes back as forty blockers');
    assert.match(fn, /linksPointingAt\(/,
      'the link-record path is asking per class again, which is the 3.8× regression the benchmark caught');
  });

  it('edges are scanned on both endpoints', () => {
    const body = backlinkFn();
    assert.match(body, /kindMatches\('from'\)/, 'an edge referencing the record as `from` is a backlink');
    assert.match(body, /kindMatches\('to'\)/, 'an edge referencing the record as `to` is a backlink');
    /*
     * And the KIND is compared, which is new and is the half that would be silently wrong.
     *
     * An edge endpoint has carried its own kind since 3.7, so `{ from: id }` alone matches an edge whose
     * `from` is a MEMORY with the same id as the entity being deleted. Ids are UUIDs from one space, so that
     * is not a collision anybody would notice until it happened once.
     */
    assert.match(body, /\$\{side\}Kind/,
      'the edge scan ignores the endpoint KIND, so a delete is blocked by an edge pointing at a different '
      + 'record that happens to share the id');
  });
  it('the face reference is still scanned, and still reported as its own type', () => {
    // Both doors filter `b.type !== 'face'` to make face labels non-blocking. That distinction only works
    // while faces are reported under a type of their own, so the exemption cannot silently widen.
    const body = backlinkFn();
    assert.match(body, /faceEntityId/, 'face labels must still be found');
    assert.match(body, /type:\s*'face'/, "faces must keep their own backlink type — both doors filter on it");
  });
});
