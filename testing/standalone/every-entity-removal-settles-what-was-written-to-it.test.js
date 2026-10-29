/**
 * Every removal of an entity settles what was written to it meanwhile, and every edge or link writer checks its entity ends after it wrote (Q-305).
 *
 * ## What it holds, and why it derives
 *
 * An edge or link written while its entity is deleted or merged touches a document the remover's transaction does not, so the store reports no conflict
 * and the row survives naming a gone entity. The cure is a check on BOTH sides after each side's own write (`brain/gone-entity-references.ts`). A door
 * that removes an entity by another route, or a writer that skips the check, brings the defect back with no error anywhere, so the sets are READ from the
 * source:
 *
 *  1. **Every place that deletes rows of the entities collection, or removes an entity through `removeRecords`, settles.** Derived: a delete on a handle
 *     bound to `spaceCollection(.., 'entities')`, a `removeWithTombstones(.., 'entities'`, and a `removeRecords(.., 'entity'`. `record-removal.ts` settles in
 *     the `entity` row of `AFTER_REMOVAL`, `merge.ts` after the transaction of `executeMerge`; any other site fails until it settles or is exempted here with its
 *     reason. Not derivable by this shape, and each says why it needs no settle: `wipeSpace` (`spaces/lifecycle.ts`) removes every edge and link of the space
 *     in the same act, the fork remover (`brain/forks.ts`) removes an unchosen version that is not a link target (edges to a fork follow `remintForks`), and
 *     an arrival (`sync/arrivals.ts`) is a peer's delete, judged by the receiver's own rules.
 *  2. **Every door that deletes or merges an entity reaches one of the two.** Derived: every call of `deleteEntity(`, `deleteEntityCascade(` and
 *     `mergeEntities(` in the server, and none of those files deletes or merges an entity by another function. The chain below them is asserted link by
 *     link: `deleteEntity` removes through `removeRecords(.., 'entity'`, `mergeEntities` through `executeMerge`.
 *  3. **The writers check their ends.** The one commit (`afterStage`), the one link-row writer (`reconcileLinkRows`) and the kind patch (`updateEdgeById`).
 *
 * Seen red by deleting the `settleReferencesToRemovedEntity` call in `executeMerge` and in the `entity` row of `AFTER_REMOVAL`, each by hand.
 *
 * Run: node --test testing/standalone/every-entity-removal-settles-what-was-written-to-it.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { callSitesOf, serverSources } from './_call-sites.mjs';
import { bodyOf } from './_structural-window.mjs';

const SETTLE = 'settleReferencesToRemovedEntity';
const REMOVAL = 'server/src/brain/record-removal.ts';
const MERGE = 'server/src/brain/merge.ts';
const ENTITIES = 'server/src/brain/entities.ts';

/** Files that remove an entity here and need no settle of their own, each with the reason it is safe. */
const EXEMPT = new Map([
  // (none today: wipeSpace, the fork remover and the arrival writer are not found by the derivation below, see the docblock)
]);

/** Every place a server file removes rows of the entities collection, or an entity through the one remover: `{ file, how }`. */
function entityRemovalSites() {
  const { blanked } = serverSources();
  const sites = [];
  for (const [file, text] of blanked) {
    // A delete on a handle bound to the entities collection: `const c = col<..>(spaceCollection(x, 'entities'))` then `c.deleteOne(` / `c.deleteMany(`.
    for (const m of text.matchAll(/(?:const|let)\s+(\w+)\s*=\s*col<[^>]*>\(\s*spaceCollection\([^()]*,\s*'entities'\s*\)\s*\)/g)) {
      if (new RegExp(`\\b${m[1]}\\.(?:deleteOne|deleteMany)\\(`).test(text)) sites.push({ file, how: `${m[1]}.delete*` });
    }
    if (/spaceCollection\([^()]*'entities'\s*\)\)?\s*\.(?:deleteOne|deleteMany)\(/.test(text)) sites.push({ file, how: 'inline delete*' });
    if (/removeWithTombstones\(\s*[^,()]+,\s*'entities'/.test(text)) sites.push({ file, how: "removeWithTombstones(.., 'entities'" });
    if (/removeRecords\(\s*[^,()]+,\s*'entity'/.test(text)) sites.push({ file, how: "removeRecords(.., 'entity'" });
    // The remover itself: the file that holds the per-kind table has the `entity` row.
    if (/export const AFTER_REMOVAL\b/.test(text)) sites.push({ file, how: 'AFTER_REMOVAL' });
  }
  return sites;
}

describe('every entity removal settles what was written to the entity meanwhile', () => {
  it('the scan found the removal sites, and the pieces it points at exist', () => {
    const sites = entityRemovalSites();
    assert.ok(sites.length >= 3, `only ${sites.length} entity removal site(s) found (${JSON.stringify(sites)}): the derivation is broken`);
    const files = new Set(sites.map(s => s.file));
    for (const f of [REMOVAL, MERGE, ENTITIES]) assert.ok(files.has(f), `${f} is no longer found as an entity removal site: re-anchor this gate`);
  });

  it('every removal site settles, or is exempt with its reason', () => {
    const { raw } = serverSources();
    const unsettled = [];
    for (const { file, how } of entityRemovalSites()) {
      if (EXEMPT.has(file)) continue;
      // `removeRecords(.., 'entity'` delegates to the remover, whose `entity` row settles (asserted below); every other kind of site settles in its own text.
      if (how === "removeRecords(.., 'entity'") continue;
      if (!raw.get(file).includes(`${SETTLE}(`)) unsettled.push(`${file} (${how})`);
    }
    assert.deepEqual(unsettled, [],
      'a place that removes an entity does not settle what was written to it: an edge or link written to the entity meanwhile survives naming a gone entity');
  });

  it('the remover\'s entity row settles, and executeMerge settles after its transaction commits', () => {
    const { raw } = serverSources();
    const row = bodyOf(raw.get(REMOVAL), 'AFTER_REMOVAL');
    const entityRow = row.slice(row.indexOf('entity:'), row.indexOf('edge:'));
    assert.ok(entityRow.includes(`${SETTLE}(`), 'the entity row of AFTER_REMOVAL does not settle references written to a deleted entity');
    const merge = bodyOf(raw.get(MERGE), 'executeMerge');
    const tx = merge.indexOf("inHeldTransaction(spaceId, 'entity.merge'");
    const settle = merge.indexOf(`${SETTLE}(`);
    assert.ok(tx > 0, 'executeMerge no longer runs its merge in a held transaction under that name: re-anchor this gate');
    assert.ok(settle > tx, 'executeMerge does not settle after its transaction: an edge written to the absorbed entity meanwhile survives naming it');
    assert.match(merge, new RegExp(`${SETTLE}\\(spaceId,[^)]*\\{[^}]*survivorId`), 'the merge settle is not handed the survivor: it would delete instead of moving');
  });

  it('every door that deletes or merges an entity reaches the settle, and none removes an entity another way', () => {
    const names = ['deleteEntity', 'deleteEntityCascade', 'mergeEntities'];
    const callers = names.flatMap(n => callSitesOf(n).map(s => ({ ...s, name: n })));
    assert.ok(new Set(callers.map(c => c.file)).size >= 5, `only ${new Set(callers.map(c => c.file)).size} file(s) call ${names.join('/')}: the derivation is broken`);
    assert.ok(callers.length >= 8, `only ${callers.length} call(s) of ${names.join('/')} found: the derivation is broken`);
    const { raw, blanked } = serverSources();
    const own = new Set(entityRemovalSites().filter(s => s.how !== "removeRecords(.., 'entity'").map(s => s.file));
    const offenders = [...new Set(callers.map(c => c.file))].filter(f => own.has(f) && f !== MERGE && f !== REMOVAL);
    assert.deepEqual(offenders, [], 'a door that calls the entity delete or merge also removes an entity by another route');
    for (const f of new Set(callers.map(c => c.file))) {
      assert.ok(!/\bexecuteMerge\(/.test(blanked.get(f)) || f === MERGE, `${f} merges by calling executeMerge directly, not through mergeEntities`);
    }
    // The chain below the doors: deleteEntity removes through the one remover, mergeEntities through executeMerge.
    assert.match(bodyOf(raw.get(ENTITIES), 'deleteEntity'), /removeRecords\(\s*spaceId,\s*'entity'/, 'deleteEntity no longer removes through removeRecords');
    assert.match(bodyOf(raw.get(MERGE), 'mergeEntities'), /\bexecuteMerge\(/, 'mergeEntities no longer merges through executeMerge');
  });

  it('the writers check their entity ends after they wrote', () => {
    const { raw } = serverSources();
    assert.match(bodyOf(raw.get('server/src/brain/write-plan/commit.ts'), 'afterStage'), /refuseEdgesToGoneEntities\(/, 'the commit does not check the entity ends of the edges it wrote');
    assert.match(bodyOf(raw.get('server/src/brain/write-plan/commit.ts'), 'refuseEdgesToGoneEntities'), /takeBackEdgesToGoneEntities\(/, 'the commit\'s edge check does not take back an edge');
    assert.match(bodyOf(raw.get('server/src/brain/write-plan/commit.ts'), 'reconcileLinkRows'), /takeBackLinksToGoneEntities\(/, 'the link-row writer does not check the entities its rows point at');
    assert.match(bodyOf(raw.get('server/src/brain/edges.ts'), 'updateEdgeById'), /refuseEdgeToGoneEntity\(/, 'the edge kind patch does not check its entity ends');
  });
});
