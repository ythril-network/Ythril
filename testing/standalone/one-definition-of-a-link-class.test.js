/**
 * What a LINK is — collection, field, chunk rule, projection — is declared once and read from there.
 *
 * ## The four copies
 *
 * An edge is a record; a **link** is a field. A chrono entry, memory or file names the entities it concerns in
 * `entityIds`, and three readers scanned those collections to answer three different questions — what a graph
 * walk reaches, what blocks a delete, what the ER diagram draws — each carrying its own literal knowledge of
 * the collection name, the field, and the predicate that keeps file CHUNKS out.
 *
 * **Only `traverseGraph` had the chunk rule.** Chunks live in the same collection as the file they came from
 * and are told apart only by `parentFileId`, so a scan without `{ $exists: false }` counts a forty-passage
 * document forty times. The other two readers had no such predicate.
 *
 * That was latent rather than live, and the distinction is worth keeping straight: the conversion pipeline
 * never writes `entityIds` onto a chunk, so nothing was actually double-counted — but `updateFileMeta` sets
 * `entityIds` on any filemeta record by id, chunk included, so it was reachable deliberately. One rule, three
 * implementations, and the weakest of them silently in charge of whether an entity can be deleted.
 *
 * ## What this gate asserts
 *
 * Not "the module exists" — that a module nobody routes through is worse than no module, because it reads as
 * settled. It asserts that **no reader pairs a link collection with the link field on its own**, derived from
 * source rather than from a list of the three files that do it today.
 *
 * Run: node --test testing/standalone/one-definition-of-a-link-class.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { trackedSources } from './_sources.mjs';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { argumentsOf, statementAround } from './_structural-window.mjs';

const { LINK_CLASSES, linkClassFor, linksToAny, hasAnyLink } =
  await import('../../server/dist/brain/link-adjacency.js');

const MODULE = 'server/src/brain/link-adjacency.ts';

function serverFiles() {
  return trackedSources('server/src', { untracked: true });
}

describe('the declaration answers for every link class', () => {
  it('names all SIX, with a collection and a field each', () => {
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
    const pairs = LINK_CLASSES.map(c => `${c.kind}.${c.field}`).sort();
    assert.deepEqual(pairs, [
      'chrono.entityIds', 'chrono.memoryIds', 'fact.entityIds',
      'file.chronoIds', 'file.entityIds', 'file.memoryIds',
    ], 'the six link classes are the six public array fields, one class each');

    for (const c of LINK_CLASSES) {
      assert.ok(c.collection, `${c.kind} has no collection`);
      assert.ok(c.field, `${c.kind} has no link field`);
      assert.ok(c.toKind, `${c.kind}.${c.field} does not say what it points AT`);
      assert.ok(Object.keys(c.projection).length > 0, `${c.kind} has no projection`);
      assert.ok(c.projection[c.field] === 1,
        `${c.label} does not project its own link field, so a walk cannot tell which frontier node a `
        + 'record hangs off and every synthetic edge it emits starts from the wrong end');
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

  it('the file scope reaches both query builders, for every file class', () => {
    for (const cls of LINK_CLASSES.filter(c => c.kind === 'file')) {
      assert.match(JSON.stringify(linksToAny('s', cls, ['e1'])), /parentFileId/, `${cls.label} in linksToAny`);
      assert.match(JSON.stringify(hasAnyLink(cls)), /parentFileId/, `${cls.label} in hasAnyLink`);
    }
  });

  it('linksToAny takes an array even for one id, so both callers share one shape', () => {
    // A frontier scan passes many, a backlink scan passes one. Two query shapes is how the chunk predicate
    // ended up on one of them and not the other in the first place.
    assert.deepEqual(
      linksToAny('sp', linkClassFor('chrono', 'entity'), ['a']),
      { spaceId: 'sp', entityIds: { $in: ['a'] } },
    );
    // And it filters on the class's OWN field. Hardcoded `entityIds` here is the bug that would leave the
    // three new classes looking implemented and answering about the wrong column.
    assert.deepEqual(
      linksToAny('sp', linkClassFor('chrono', 'fact'), ['a']),
      { spaceId: 'sp', memoryIds: { $in: ['a'] } },
    );
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
    assert.equal(linkClassFor('chrono', 'fact').field, 'memoryIds', 'and the pair that IS a class resolves');
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

  it('any read that FILTERS on the link field goes through the shared builders', () => {
    /*
     * The FILTER argument, not the whole statement.
     *
     * A first version tested the statement text and reported three files that were entirely correct:
     * `reindex.ts` and `face-embedder.ts` name `entityIds` in a PROJECTION, and one of them also as a local
     * variable. Reading the field is not re-deriving what a link is — deciding which records carry one is,
     * and that decision lives in the filter.
     */
    // EVERY link field, not one. Six classes name three distinct fields, and a sweep for `entityIds` alone
    // would report a reader that filters on `memoryIds` as clean — which is exactly the kind of reader this
    // gate exists to catch, arriving through the fields that only just gained readers.
    const fields = [...new Set(LINK_CLASSES.map(c => c.field))];
    const rogue = collectionReads()
      .filter(r => {
        const at = r.stmt.indexOf('.find(');
        if (at === -1) return false;
        const filterArg = argumentsOf(r.stmt, at + '.find'.length, 'the find filter')[0] ?? '';
        return fields.some(f => new RegExp(`\\b${f}\\b`).test(filterArg))
          && !/linksToAny\(|hasAnyLink\(/.test(filterArg);
      })
      .map(r => `${r.file} (${r.suffix})`);
    assert.deepEqual(
      rogue, [],
      'A reader deciding for itself which records in a link collection carry a link keeps its own copy of what '
      + 'a link IS — including whether file chunks count. That is how the chunk exclusion came to exist in the '
      + 'graph walk and in neither the delete guard nor the ER diagram.',
    );
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
