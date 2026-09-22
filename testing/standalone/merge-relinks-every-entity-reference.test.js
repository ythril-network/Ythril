/**
 * An entity merge must relink EVERY record kind that can reference an entity.
 *
 * ## The defect
 *
 * `executeMerge` relinked edges, memories and chrono entries, and never touched file metadata records — which
 * carry `entityIds` exactly as memories and chrono do, and which `assertRefsResolve` validates at write time
 * so that every id in them names a real entity.
 *
 * So merging B into A left every file whose `entityIds` held B pointing at an entity that the merge's own last
 * phase then **deleted**. The merge path broke the invariant the write path enforces.
 *
 * ## Why nothing saw it
 *
 * Every direction that could have noticed was looking somewhere else:
 *
 *  - the ER model counts `linkedFrom.files` as a first-class relationship, so the number was simply wrong
 *    rather than obviously broken;
 *  - `danglingEdges` in that same model counts dangling **edges** and never looks at files;
 *  - `strictLinkage` blocks deleting an entity anything still references — and a merge deletes the
 *    absorbed entity directly, so it never passes that guard;
 *  - a traversal from the file came back empty, which reads as "nothing linked" rather than as a broken link.
 *
 * ## What this pins, and why it is DERIVED
 *
 * Listing four collection names here would be the same shape as the bug: a hand-kept second copy that agrees
 * until someone adds a fifth. So the record kinds are read out of `config/types.ts` — every interface that
 * declares an `entityIds` field — and the merge is required to relink each one's collection.
 *
 * Add a new record type with `entityIds` and forget the merge, and this fails naming it.
 *
 * Comments are stripped first: the merge now carries a long comment explaining why the file phase exists, and
 * it names the very collections being searched for.
 *
 * Run: node --test testing/standalone/merge-relinks-every-entity-reference.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { statementFrom } from './_structural-window.mjs';
import { readFileSync } from 'node:fs';

const TYPES = 'server/src/config/types.ts';
const MERGE = 'server/src/brain/merge.ts';

const withoutComments = (t) =>
  t.replace(/(^|[^:])\/\/.*$/gm, '$1').replace(/\/\*[\s\S]*?\*\//g, '');

/**
 * Every FIELD in `types.ts` that holds an entity id, with the interface it belongs to.
 *
 * ## Why this is not just `entityIds`
 *
 * It was, and that is how `faceEntityId` went unrelinked for two releases. The old matcher was
 * `/^\s*entityIds\??\s*:/` — the literal plural name — so a **singular, differently-named link was outside
 * this gate by construction**, and the one field that fits that description is the biometric one.
 *
 * The consequence was invisible in every direction: a merge left face chunks pointing at the absorbed id,
 * phase 5 deleted it, and `labelStillResolves` returns null for a label that does not resolve — so the faces
 * simply stopped counting and the surviving person's gallery went empty with nothing logged. `strictLinkage`
 * could not catch it either, because a merge deletes the absorbed entity directly rather than through the
 * guard that refuses a delete while anything still references the entity.
 *
 * So the discovery is by SHAPE — any field whose name ends in `entityId`/`entityIds`, whatever it is prefixed
 * with. A third spelling added later is covered on the commit that adds it, which is the property the previous
 * version lacked.
 */
function entityRefFields() {
  const lines = withoutComments(readFileSync(TYPES, 'utf8')).split(/\r?\n/);
  const found = [];
  let current = null;
  for (const line of lines) {
    const m = /^export interface (\w+)/.exec(line);
    if (m) current = m[1];
    // `\w*[eE]ntityIds?` — matches `entityIds` with an empty prefix and `faceEntityId` with one.
    const f = /^\s*(\w*[eE]ntityIds?)\??\s*:/.exec(line);
    if (f && current) found.push({ type: current, field: f[1] });
  }
  return found.filter((v, i, a) => a.findIndex(o => o.type === v.type && o.field === v.field) === i);
}

/** The interfaces carrying at least one such field — the unit the collection map is keyed by. */
function typesWithEntityIds() {
  return [...new Set(entityRefFields().map(f => f.type))];
}

/**
 * The collection each record type lives in.
 *
 * This mapping is the one thing that cannot be derived — a TypeScript interface does not know its collection
 * suffix. So it is asserted to be TOTAL over the discovered types: a new `entityIds`-carrying type fails here
 * first, with a message saying to add it, rather than passing silently.
 */
const COLLECTION_SUFFIX = {
  FileMetaDoc: 'files',
};

describe('the check itself works before it is trusted', () => {
  it('finds the record types that carry an entity id in a FIELD', () => {
    /*
     * One left, and that is the point of discovering by shape rather than by name. The six link arrays
     * went in 5.0 — a fact, a chrono entry and a file name entities through LINK RECORDS now, which the
     * merge re-keys in one phase rather than per collection. `faceEntityId` is what remains: a singular,
     * differently-named link that was outside this gate by construction for two releases.
     */
    const fields = entityRefFields();
    assert.ok(fields.length >= 1, `found no entity-id field at all in ${TYPES} — the matcher has broken`);
    assert.ok(fields.some(f => f.field === 'faceEntityId'),
      `expected the biometric link to be found by shape, got: ${fields.map(f => f.field).join(', ')}`);
  });

  it('knows a collection for every one of them', () => {
    const missing = typesWithEntityIds().filter(t => !COLLECTION_SUFFIX[t]);
    assert.deepEqual(missing, [],
      `these record types carry entityIds and this test does not know their collection: ${missing.join(', ')}. `
      + 'Add them to COLLECTION_SUFFIX — and check the merge relinks them, which is the point of this file.');
  });

  it('strips the comment that names the collections', () => {
    /*
     * The stripper is what makes every assertion below mean anything: `merge.ts` both EXPLAINS the file
     * phase in prose and performs it, so a gate reading the raw file could be satisfied by the explanation
     * of a phase that had been deleted.
     *
     * The spelling moved at `A-5` — the collection is opened through `spaceCollection(spaceId, 'files')`
     * rather than a template — and the property did not: the name still occurs in both, so the stripper
     * still has something to strip and the check below still has something to find.
     */
    const raw = readFileSync(MERGE, 'utf8');
    const PROSE_ONLY = 'linkedFrom.files';
    assert.ok(raw.includes(PROSE_ONLY), 'the merge should still explain the file phase in prose');
    const stripped = withoutComments(raw);
    assert.ok(!stripped.includes(PROSE_ONLY),
      'the explanation survived the stripper, so every assertion below could be satisfied by a comment '
      + 'describing a phase that had been deleted');
    assert.ok(stripped.includes("spaceCollection(spaceId, 'files')"),
      'the file collection must be opened in CODE, not only described in a comment');
  });
});

describe('executeMerge relinks every collection that can reference an entity', () => {
  const merge = withoutComments(readFileSync(MERGE, 'utf8'));

  for (const [type, suffix] of Object.entries(COLLECTION_SUFFIX)) {
    it(`relinks ${suffix} (${type})`, () => {
      // The collection must be opened...
      assert.match(merge, new RegExp(`col<[^>]*>\\(spaceCollection\\(spaceId, '${suffix}'\\)\\)`),
        `the merge never opens the ${suffix} collection — records there keep pointing at the absorbed entity, `
        + 'which phase 5 deletes');
      /*
       * ...and queried for the absorbed id — bound by the VARIABLE the open declares, not by proximity.
       *
       * TWO WINDOWS CONVERTED INTO ONE STRONGER CLAIM. This was a 600-character gap tried in both directions,
       * which asks "are these two strings near each other". The question is "is the query aimed at the
       * collection that was opened", and the code answers it by name:
       *
       *     const memoryColl = col<FactDoc>(`${spaceId}_facts`);
       *     const affected  = await memoryColl.find(asFilter({ spaceId, entityIds: absorbed._id }), …)
       *
       * So the open declares a variable and the query uses it. Following that link proves what the window
       * only approximated: a `find` on some OTHER collection 600 characters away satisfied the old check, and
       * a legitimate one pushed past 600 by an added comment would have failed it.
       */
      /*
       * The DECLARATION matched whole, with the name captured — no gap of any size.
       *
       * My first attempt anchored on the `col<…>(` call and asked `statementAround` for its statement. That
       * index sits INSIDE a template literal, and the walk skips template literals whole, so it returned a
       * span reaching forty lines further on and the captured name was a variable declared long after. The
       * failure said "opens memories as `newFrom`", which is the only reason it cost one run rather than
       * an afternoon — a window failure would have said nothing at all.
       */
      const decl = new RegExp(
        '(?:const|let)\\s+(\\w+)\\s*=\\s*col<[^>]*>\\(spaceCollection\\(spaceId, .' + suffix + '.\\)',
      ).exec(merge);
      assert.ok(decl, `${suffix}: the collection is not opened into a named variable — re-anchor this gate`);
      const varName = decl[1];

      // Every statement that uses that variable AFTER the declaration, and one must be the reference search.
      const uses = [...merge.matchAll(new RegExp(`\\b${varName}\\b`, 'g'))]
        .filter(u => u.index > decl.index + decl[0].length)
        .map(u => statementFrom(merge, u.index, `a use of ${varName}`));
      // EVERY entity-id field this record type declares, not only the plural one. A type carrying two of them
      // was relinked on one and left dangling on the other, which is the defect this gate now covers.
      for (const { field } of entityRefFields().filter(f => f.type === type)) {
        assert.ok(
          uses.some(u => new RegExp(`${field}: absorbed\\._id`).test(u)),
          `the merge opens ${suffix} as \`${varName}\` and never searches THAT collection for `
          + `\`${field}: absorbed._id\` — so records there keep pointing at the entity phase 5 deletes. `
          + `${field === 'faceEntityId'
            ? 'For faces that means the surviving person\'s gallery silently empties: the label no longer '
              + 'resolves, so every one of them stops counting and nothing says so.'
            : ''}`,
        );
      }
    });
  }

  it('re-keys the LINK rows, which is how a fact, a chrono entry and a file name an entity now', async () => {
    /*
     * THE PHASE THAT REPLACED THREE. Those three collections carried `entityIds` and were relinked one by
     * one; 5.0 made a connection a link record, so one query over the links collection covers every kind
     * that can name an entity — including any kind added later, which is what the per-collection version
     * could never say.
     *
     * Measured on a live instance before the phase existed: after the merge the link still named the
     * absorbed entity, and phase 5 had deleted it.
     */
    const { LINK_CLASSES } = await import('../../server/dist/brain/link-adjacency.js');
    const naming = LINK_CLASSES.filter(c => c.toKind === 'entity');
    assert.ok(naming.length >= 3,
      `only ${naming.length} class(es) can name an entity — the import is stale and this checks less`);

    assert.match(merge, /spaceCollection\(spaceId, 'links'\)/,
      'the merge never opens the links collection, so every link naming the absorbed entity survives it '
      + 'pointing at the record phase 5 deletes');
    assert.match(merge, /to: absorbed\._id, toKind: 'entity'/,
      'the link search is not aimed at the absorbed entity as a link TARGET — an entity is only ever a `to`');
    /*
     * RE-KEYED, not `$set`. A link's `_id` is derived from both endpoints, so moving the `to` changes the
     * identity — an update in place leaves an id that disagrees with its own contents and nothing finds it
     * again. The old id needs a tombstone, or the next pull from a peer restores the broken link.
     */
    assert.match(merge, /linkIdFor\(link\.from, link\.fromKind, survivor\._id, 'entity'\)/,
      'the link is updated in place rather than re-keyed, so its id no longer derives from its contents');
    assert.match(merge, /_id: link\._id, type: 'link'/,
      'the old link id gets no tombstone, so the next pull from a peer re-creates it pointing at the '
      + 'deleted entity and the repair undoes itself');
  });

  it('a merge RELINKS a face rather than unlabelling it', () => {
    /*
     * The distinction that makes this different from the delete path, and the one worth pinning.
     *
     * `unlabelFacesForEntities` is correct for a DELETE — the person is gone, so the labels are wrong. A merge
     * asserts the opposite: these two records were always the same person, so the absorbed one's faces ARE the
     * survivor's. Clearing them would discard correct biometric labels the operator asked to keep, and it
     * would look like a fix while being a second kind of loss.
     */
    /*
     * BOTH SPELLINGS, on one line. The `$set` here is built up conditionally, so the assignment is
     * `set['faceEntityId'] = survivor._id` rather than the object-literal `faceEntityId: survivor._id` — and
     * the first draft of this assertion looked only for the second and failed on a correct fix.
     *
     * That is this repo's recorded lesson about searching for one way of WRITING a thing instead of for the
     * thing: a dotted-only sweep reported clean twice. Bounded to a line, which is structural, rather than to
     * a character count.
     */
    assert.match(
      merge, /\bfaceEntityId\b[^\n]*survivor\._id/,
      'the merge must point face records AT THE SURVIVOR. Unlabelling them instead throws away labels the '
      + 'merge is a statement of confidence in.',
    );
    assert.doesNotMatch(
      merge, /unlabelFaces/,
      'the merge must not call the DELETE path\'s unlabel helper — a merge keeps the labels and moves them',
    );
  });

  it('bumps seq on every relinked record, so the change replicates', () => {
    // A relink that does not advance `seq` is invisible to sync: a peer would keep the old link forever, and
    // the dangling reference would come back on the next pull.
    const relinkBlocks = merge.split('nextSeq(spaceId)').length - 1;
    assert.ok(relinkBlocks >= 4,
      `only ${relinkBlocks} nextSeq calls — each relinked collection plus the survivor needs its own`);
  });

  it('dedupes after relinking, so a record linked to BOTH does not hold the survivor twice', () => {
    const dedupes = merge.split('new Set(').length - 1;
    assert.ok(dedupes >= 3,
      `only ${dedupes} dedupe(s) — a record referencing the survivor AND the absorbed entity collapses to two `
      + 'identical ids without one');
  });
});
