/**
 * What a LINK is — collection, chunk rule, projection, label — is declared once and read from there.
 *
 * ## The four copies
 *
 * An edge is a record; a link says only that one record is ABOUT another. Three readers answered three
 * different questions from it — what a graph walk reaches, what blocks a delete, what the ER diagram
 * draws — each carrying its own literal knowledge of the collection, the field it read, and the predicate
 * that keeps file CHUNKS out.
 *
 * **Only `traverseGraph` had the chunk rule.** Chunks live in the same collection as the file they came
 * from and are told apart only by `parentFileId`, so a scan without `{ $exists: false }` counts a
 * forty-passage document forty times. The other two readers had no such predicate.
 *
 * ## What this gate asserts
 *
 * Not "the module exists" — a module nobody routes through is worse than no module, because it reads as
 * settled. It asserts that **no reader decides for itself what a link row is**, derived from source
 * rather than from a list of the files that read them today.
 *
 * **5.0 moved where that mistake can happen and not what it is.** The six array fields are gone, so a
 * rogue reader no longer filters a record collection on a link field — it opens the `links` collection
 * by hand. Same rule, new spelling, and the chunk exclusion is still the half that gets dropped.
 * * Run: node --test testing/standalone/one-definition-of-a-link-class.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf, statementAround, bodyOf } from './_structural-window.mjs';

const { LINK_CLASSES, linkClassFor, legacyField } =
  await import('../../server/dist/brain/link-adjacency.js');

const MODULE = 'server/src/brain/link-adjacency.ts';

function serverFiles() {
  return trackedSources('server/src', { untracked: true });
}

describe('the declaration answers for every link class', () => {
  it('names all SIX, with a collection and a label each', () => {
    /*
     * Six since 4.0, and the number is asserted as the SET rather than the count — a count of six is
     * satisfied by any six pairs, including a duplicate and a missing one.
     *
     * Three of these had no reader at all until `M-2`: `chrono.memoryIds`, `file.memoryIds` and
     * `file.chronoIds` were accepted, stored, replicated and documented while nothing walked them. That is
     * why the class is a `(fromKind, toKind)` PAIR now — keyed on the from kind alone, a caller asking
     * about `chrono.memoryIds` was silently handed the `chrono.entityIds` class and scanned the wrong
     * field.
     */
    const labels = LINK_CLASSES.map(c => c.label).sort();
    assert.deepEqual(labels, [
      'chrono.entityIds', 'chrono.memoryIds', 'fact.entityIds',
      'file.chronoIds', 'file.entityIds', 'file.memoryIds',
    ], 'the six link classes, one label each');

    /*
     * The labels still READ like the 4.x array fields, and that is deliberate rather than left over. A
     * link record's `_id` is a UUIDv5 over the pair, the kinds and the LABEL, so renaming one would
     * re-key every link record on every instance. They are frozen tokens — see `legacyField`.
     */
    for (const c of LINK_CLASSES) {
      assert.equal(c.label, `${c.kind}.${legacyField(c.toKind)}`,
        `${c.label} is not built from the frozen token, so its id would not match the one the writer computes`);
      assert.ok(c.collection, `${c.kind} has no collection`);
      assert.ok(c.toKind, `${c.label} does not say what it points AT`);
      assert.ok(Object.keys(c.projection).length > 0, `${c.kind} has no projection`);
    }
  });

  it('every projection is INCLUSION-only, so it cannot leak a vector', () => {
    /*
     * This is what lets `reads-never-return-vectors` accept `projection: FILE_LINKS.projection` in place of a
     * literal object. That gate exists because five reads once returned whole documents and sent 11.19 MB to
     * a caller who had been told it could not happen — so a named projection may only be trusted while it
     * cannot express an exclusion.
     *
     * `Record<string, 1>` says so at compile time; this says so at run time, because the type is erased and
     * the two gates are in different files. A `0` here would silently turn every one of these into an
     * exclusion projection, which returns everything else — including the vector.
     */
    for (const c of LINK_CLASSES) {
      for (const [field, value] of Object.entries(c.projection)) {
        assert.equal(
          value, 1,
          `${c.kind}'s projection sets ${field} to ${value}. Anything but 1 makes this an EXCLUSION `
          + 'projection, which returns every other field — the embedding among them.',
        );
      }
      assert.ok(!('embedding' in c.projection), `${c.kind} must never name the vector at all`);
    }
  });

  it('only the file classes exclude chunks, and ALL THREE of them do', () => {
    /*
     * The asymmetry is the whole reason this module exists, so it is asserted rather than left implicit —
     * and asserted in BOTH directions, since giving chrono a chunk predicate would silently return nothing.
     *
     * **Swept rather than named, because a file now has THREE classes.** Written out as three assertions,
     * a fourth file class added later would be the one without the predicate, and the symptom is a
     * forty-passage document arriving as forty nodes carrying passage text.
     */
    for (const c of LINK_CLASSES) {
      const expected = c.kind === 'file' ? { parentFileId: { $exists: false } } : {};
      assert.deepEqual(c.scope, expected,
        c.kind === 'file' ? `${c.label} does not exclude chunks` : `a ${c.kind} has no chunks`);
    }
  });

  it('the file scope is applied where a file is RESOLVED, because a link row cannot carry it', () => {
    /*
     * The half that moved with the storage. A link row has no `parentFileId`, so the chunk exclusion
     * cannot live in the link query at all — it has to be applied to the records the ids are read back
     * as. Every helper that turns link rows into file records must therefore consult the class scope, or
     * a forty-passage document comes back as forty nodes.
     */
    const src = stripComments(readFileSync(MODULE, 'utf8'));
    for (const fn of ['docsFromCollection', 'scopedDocs']) {
      const body = bodyOf(src, fn);
      assert.match(body, /scope/,
        `${fn} reads records named by link rows without applying the class scope, so a file's chunks `
        + 'count as links to the file');
    }
  });

  it('linkClassFor answers nothing for a kind that links by EDGE rather than by field', () => {
    assert.equal(linkClassFor('entity', 'entity'), undefined, 'an entity is the link TARGET, not a linker');
    assert.equal(linkClassFor('edge', 'entity'), undefined, 'an edge is a record, not a field-based link');
  });

  it('and nothing for a PAIR that is not a class, which is the half that needed the second argument', () => {
    /*
     * `linkClassFor` was keyed on the from kind alone, and `find` returns the FIRST match — so
     * `linkClassFor('chrono')` answered the `entityIds` class whatever the caller meant. A caller asking
     * about a chrono entry's memory links got a filter on the wrong column, with no error anywhere and a
     * plausible empty result.
     */
    assert.equal(linkClassFor('fact', 'fact'), undefined, 'a memory names entities and nothing else');
    assert.equal(linkClassFor('fact', 'chrono'), undefined);
    assert.equal(linkClassFor('chrono', 'chrono'), undefined, 'a chrono entry does not name chrono entries');
    assert.equal(linkClassFor('chrono', 'file'), undefined, 'a file names a chrono, never the other way');
    assert.equal(linkClassFor('chrono', 'fact').label, 'chrono.memoryIds', 'and the pair that IS a class resolves');
  });
});

describe('no reader re-derives a link class', () => {
  /**
   * Every statement that opens a link collection, outside the module that declares them.
   *
   * Derived from the collection names in `LINK_CLASSES` rather than from a list of the files that read them,
   * so a fourth reader added later is covered on the commit that adds it — which is the property the three
   * hand-written copies lacked.
   */
  function collectionReads() {
    const suffixes = LINK_CLASSES.map(c => c.collection);
    const out = [];
    for (const file of serverFiles()) {
      if (file === MODULE) continue;
      const src = stripComments(readFileSync(file, 'utf8'));
      for (const suffix of suffixes) {
        const re = new RegExp(`spaceCollection\\(\\w+, .${suffix}.\\)`, 'g');
        for (const m of src.matchAll(re)) {
          out.push({ file, suffix, stmt: statementAround(src, m.index, `${file} ${suffix} read`) });
        }
      }
    }
    return out;
  }

  it('finds the collection reads, so an empty sweep cannot pass', () => {
    assert.ok(
      collectionReads().length >= 6,
      `only ${collectionReads().length} link-collection reads found across the server — the scan has broken`,
    );
  });

  /**
   * Files that open the links collection for a reason that is NOT "what links does this record have".
   *
   * Each is checked to still do it, below, so an entry cannot outlive the code it excuses — a stale
   * exemption is a rule nobody can trigger, and it hides that the file was renamed rather than fixed.
   */
  const NOT_A_LINK_READER = new Map(Object.entries({
    'server/src/brain/links.ts':
      'THE WRITER. It creates and removes link records, which is where the shape is decided rather than '
      + 'read.',
    'server/src/brain/links-conversion.ts':
      'THE MIGRATION. It reads the 4.x arrays off disk and writes the records that replace them, so it is '
      + 'the one reader of a shape the types no longer declare.',
    'server/src/api/sync/docs.ts':
      'REPLICATION, which pages a COLLECTION by `seq` and does not care what a row means. It treats links '
      + 'exactly as it treats every other collection.',
    'server/src/brain/merge.ts':
      'A RE-KEY. When two entities become one, every link naming the absorbed id has to be rewritten to '
      + 'name the survivor — an update over rows, not a question about a record.',
    'server/src/spaces/lifecycle.ts':
      'CREATION. It makes the collection and its indexes when a space is made; there is nothing to read.',
  }));

  it('nobody outside the module opens the LINKS collection to ask what a record links to', () => {
    /*
     * WHERE THE RULE MOVED. It used to be about a reader filtering a record collection on a link FIELD,
     * and 5.0 removed the fields — so the same mistake now looks like a reader querying the `links`
     * collection by hand instead of through this module's helpers.
     *
     * A file deciding for itself what a link row looks like is the copy that ends up disagreeing: about
     * the chunk exclusion, about which class a pair belongs to, or about both.
     */
    const opens = (file) =>
      /spaceCollection\(\w+, .links.\)/.test(stripComments(readFileSync(file, 'utf8')));
    const rogue = serverFiles().filter(f => f !== MODULE && !NOT_A_LINK_READER.has(f) && opens(f));
    assert.deepEqual(rogue, [],
      'these open the links collection directly rather than through `link-adjacency.ts`, so each carries '
      + 'its own idea of what a link row is — including whether a file chunk counts: ' + rogue.join(', '));

    // And the exemptions are REAL, so one cannot outlive the code it excuses.
    const stale = [...NOT_A_LINK_READER.keys()].filter(f => !opens(f));
    assert.deepEqual(stale, [],
      'these are exempted from the sweep and no longer open the collection at all: ' + stale.join(', '));
  });
  it('the chunk rule is not spelled out again inside a LINK read', () => {
    /*
     * Scoped to link reads, and that scope is the correction.
     *
     * A first version asserted nobody outside the module spells `parentFileId: { $exists: false }` at all, and
     * named four files that were right to: `api/files.ts` listing files, `search.ts` counting them,
     * `reindex.ts` re-embedding them. That predicate answers "is this a file or a chunk", which is a general
     * question — it is only part of the LINK class when the question is "which files link to this entity".
     *
     * What must not happen is a link read routing through the builder AND carrying its own copy beside it,
     * which would be two rules again with the second one invisible.
     */
    const doubled = collectionReads()
      .filter(r => /linksToAny\(|hasAnyLink\(/.test(r.stmt))
      .filter(r => /parentFileId/.test(r.stmt))
      .map(r => `${r.file} (${r.suffix})`);
    assert.deepEqual(
      doubled, [],
      'a link read is using the shared builder and ALSO spelling the chunk predicate itself — the builder '
      + 'already carries it for the file class, so the second copy can only ever disagree',
    );
  });
});
