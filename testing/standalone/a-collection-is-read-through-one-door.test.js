/**
 * A record is read through `filter`, and there is no second `GET` beside it.
 *
 * ## What this replaces, and why a rule rather than five deletions
 *
 * `B-9` step 3a deleted the five `GET /api/brain/spaces/:spaceId/<collection>/…` routes that answered what
 * `filter` answers for ONE record — four by-id reads and `entities/by-ids`. Deleting them is a diff. What
 * keeps them deleted is this: **the sixth one nobody has written yet is refused by the same assertion**,
 * because the subject is derived from `BRAIN_COLLECTIONS` rather than named.
 *
 * That matters more than it sounds. Every one of the five was written for a good local reason — a picker
 * needed one record, a test needed to read its write back — and each was correct in isolation. What they
 * cost is paid somewhere else: a caller's request shape, its response shape, its refusals and its paging
 * all depend on which door they happened to pick, and the two doors drift without anything reporting it.
 * Six such divergences were found in the four PRs that preceded this deletion, and every one of them was
 * invisible from inside the route that had it.
 *
 * ## The exemptions, and why each is not this defect
 *
 * An exemption that does not say why is a hole, so each carries its reason and the gate asserts the reason
 * is there. **Four of them are the collection LIST routes, and they are the next step rather than a
 * decision** — they are exempt with `B-9` step 3b named, not forgiven.
 *
 * ## Seen red
 *
 * Written while all nine were still mounted: it listed all nine, by name, before a line of them was gone.
 *
 * Run: node --test testing/standalone/a-collection-is-read-through-one-door.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mountedRoutes } from './_routes.mjs';

const { BRAIN_COLLECTIONS } = await import('../../server/dist/config/types-knowledge.js');

/**
 * The `GET`s under a space that name a collection and are NOT this defect — each with its reason.
 *
 * The reason is the half that has to be written down, because a bare path here reads as "allowed" and gives
 * a reviewer nothing to disagree with. Two kinds live here and they are not the same kind:
 *
 * - **still to go** — a second door with a row behind it. `B-9` step 3b.
 * - **a different question** — a route that shares the path segment and answers something no predicate over
 *   that collection states.
 */
const NOT_A_SECOND_DOOR = new Map(Object.entries({
  'GET /api/brain/spaces/:spaceId/facts':
    'STILL TO GO — B-9 step 3b. A second door onto `filter`, kept one more step because converting its '
    + 'callers renames a result key at eighty-odd test sites and that belongs in its own diff.',
  'GET /api/brain/spaces/:spaceId/entities':
    'STILL TO GO — B-9 step 3b, for the same reason as the facts listing.',
  'GET /api/brain/spaces/:spaceId/edges':
    'STILL TO GO — B-9 step 3b, for the same reason as the facts listing.',
  'GET /api/brain/spaces/:spaceId/chrono':
    'STILL TO GO — B-9 step 3b, for the same reason as the facts listing.',
  'GET /api/brain/spaces/:spaceId/files':
    'STILL TO GO — B-9 step 3b. The file-META listing, and the tenth legacy shape: its client caller did '
    + 'not move in 2b, so deleting it is a client change rather than a deletion.',
  'GET /api/brain/spaces/:spaceId/files/extract':
    'A DIFFERENT QUESTION. Not a listing at all — it returns the extracted TEXT of one file, the bytes run '
    + 'through the extractor, which no predicate over the metadata collection can produce.',
  'GET /api/brain/spaces/:spaceId/entities/:id/cascade-preview':
    'A DIFFERENT QUESTION. It answers what DELETING this entity would take with it, walking the edges, '
    + 'facts and chrono entries that reference it. A traversal of four collections expressed as a question '
    + 'about one, and no predicate over `entities` states it.',
  'GET /api/brain/spaces/:spaceId/links/convert-preflight':
    'A DIFFERENT QUESTION. A dry run over a MIGRATION — what converting the legacy edge-shaped links would '
    + 'do before it is done. It shares the path segment with the collection and nothing else.',
}));

/** The path shape this gate is about: a `GET` under a space whose next segment is a collection name. */
function collectionReads() {
  const cols = new Set(BRAIN_COLLECTIONS);
  return mountedRoutes()
    .filter(r => r.method === 'GET')
    .filter(r => {
      const m = /^\/api\/brain\/spaces\/:\w+\/([^/]+)/.exec(r.path);
      return m !== null && cols.has(m[1]);
    });
}

describe('a collection is read through one door', () => {
  it('the derivation has a floor, so an empty sweep cannot pass this file', () => {
    // A `BRAIN_COLLECTIONS` that failed to import, or a route sweep that stopped matching, would make
    // every case below vacuous — and a vacuous gate reports clean about something it never read.
    assert.ok(BRAIN_COLLECTIONS.length >= 5,
      `expected the brain collections, got ${BRAIN_COLLECTIONS.length}`);
    assert.ok(mountedRoutes().length > 150, 'the route sweep found nothing to look at');
  });

  it('no GET reads a brain collection beside `filter`', () => {
    const offenders = collectionReads()
      .filter(r => !NOT_A_SECOND_DOOR.has(`${r.method} ${r.path}`))
      .map(r => `${r.method} ${r.path}  (${r.file})`);
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} route(s) read a brain collection with a second shape:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + '\n\n      A record is read through `filter` — one request shape, one response shape, one set of'
      + '\n      refusals. A GET beside it is a caller whose paging, conveniences and error text depend on'
      + '\n      which door they picked, and the four PRs before this one found six such divergences.'
      + '\n      If the route genuinely answers a different question, add it to NOT_A_SECOND_DOOR with the'
      + '\n      reason it is not one.',
    );
  });

  it('every exemption states why it is not a second door', () => {
    // An exemption list nobody has to justify is where this rule goes to die: the next author adds a key,
    // the gate goes green, and the divergence is now documented as approved.
    for (const [path, why] of NOT_A_SECOND_DOOR) {
      // Deliberately modest, because three of these legitimately say "same reason as the one above" and a
      // length floor tuned to the longest entry would force prose nobody reads. The two assertions that
      // follow are the ones with teeth.
      assert.ok(why.length > 50, `${path} is exempt with no reason worth reading`);
      assert.match(why, /^(STILL TO GO|A DIFFERENT QUESTION)/,
        `${path} must say which kind of exemption it is — a route on its way out, or one that answers `
        + 'something else. They are not the same claim and only one of them expires.');
    }
  });

  it('the ones on their way out each name the row that closes them', () => {
    // Without this an exemption can be written as temporary and never be. A row id is what a reader can
    // check against the tracker; "for now" is not.
    for (const [path, why] of NOT_A_SECOND_DOOR) {
      if (!why.startsWith('STILL TO GO')) continue;
      assert.match(why, /B-9 step 3b/, `${path} is exempt "for now" with no row behind it`);
    }
  });

  it('the exemptions are REAL routes, so a stale one cannot sit here forever', () => {
    /*
     * The failure this catches is the quiet one. Delete `files/extract` next year and its exemption stays,
     * looking like a live decision — and the next author reading this file learns that a listing GET is
     * fine because there is one right there. An exemption outliving its route is the same defect as a
     * comment outliving its code, and it is read more often.
     */
    const live = new Set(collectionReads().map(r => `${r.method} ${r.path}`));
    const stale = [...NOT_A_SECOND_DOOR.keys()].filter(p => !live.has(p));
    assert.deepEqual(stale, [], `exempt but not mounted: ${stale.join(', ')} — delete the exemption`);
  });

  it('the detector actually detects', () => {
    // Mutation-proof. A matcher that fires on nothing passes every list written over it, and this one is
    // a regex over a path shape — the easiest kind to break with an edit that still reads correctly.
    const shape = p => /^\/api\/brain\/spaces\/:\w+\/([^/]+)/.exec(p);
    assert.equal(shape('/api/brain/spaces/:spaceId/entities')?.[1], 'entities');
    assert.equal(shape('/api/brain/spaces/:spaceId/entities/:id')?.[1], 'entities');
    assert.equal(shape('/api/brain/spaces/:spaceId/entities/by-ids')?.[1], 'entities');
    assert.equal(shape('/api/brain/recall'), null, 'a route outside a space is a different question');
    assert.ok(new Set(BRAIN_COLLECTIONS).has('entities'), 'the collection set must contain what it names');
  });
});
