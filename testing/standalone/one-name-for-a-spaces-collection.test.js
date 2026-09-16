/**
 * A space's collection name is built in ONE place, and that place carries the guard that makes it safe.
 *
 * ## The question 294 call sites answer by hand
 *
 * A space's data lives in collections named `{spaceId}_{suffix}` — eleven suffixes, of which only four are
 * knowledge types. `COLLECTION_SUFFIX` and `RECORD_COLLECTION` answer *"which collection does this knowledge
 * TYPE live in"*, which is a different and narrower question: `_tombstones`, `_conflicts`,
 * `_dupe_candidates`, `_contradiction_candidates` and `_embed_jobs` are in no map at all.
 *
 * So the common question had no answer, and 294 callers answered it with a template string.
 *
 * ## What a hand-written name DROPS, and it is the line that loses data
 *
 * Three operations select a space's collections by a bare prefix match on `<spaceId>_`: `spaces/rename.ts`
 * MOVES every match, `spaces/lifecycle.ts` DROPS every match, and `spaces/_shared.ts` rewrites a field in
 * every match. All three are correct for exactly one reason — a space id is validated `^[a-z0-9-]+$`, so
 * `_` cannot occur inside an id and is an unambiguous separator. `work-archive_facts` does not carry the
 * prefix `work_`.
 *
 * Relax that charset for any good-sounding reason — readability, or an id arriving from another system —
 * and deleting the space `work` silently drops `work_archive`'s collections. Another space's data, no
 * confirmation, recoverable only from a backup.
 *
 * A template string cannot check that. The module does, and it THROWS rather than returning a name it
 * cannot vouch for: a helper that returns a plausible value where it should refuse has moved the bug rather
 * than fixed it.
 *
 * `space-id-prefix-safety.test.js` is the existing tripwire on the VALIDATION sites. This is the same rule
 * asserted where the name is BUILT, because a validated id and a trusted id are not the same thing.
 *
 * ## Derived, never listed
 *
 * The offender set is read out of the tracked sources with the same pattern that measured it, and a FLOOR is
 * asserted on what the sweep found — a regex that matches nothing passes every loop written over it, which
 * is how a gate like this reports clean about a codebase it never read.
 *
 * Run: node --test testing/standalone/one-name-for-a-spaces-collection.test.js
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { trackedSources } from './_sources.mjs';
import { stripComments } from './_strip-comments.mjs';

let spaceCollection;
let SPACE_COLLECTIONS;

before(async () => {
  ({ spaceCollection, SPACE_COLLECTIONS } = await import('../../server/dist/db/space-collection.js'));
});

const code = (f) => stripComments(readFileSync(f, 'utf8'));

/**
 * A collection name built by concatenation: `${anything}_<suffix>` inside a template literal.
 *
 * The suffixes come from the module rather than from a list here, so a twelfth one added next year is
 * swept on the day it is declared.
 */
const concatenated = (suffixes) =>
  new RegExp('\\$\\{[^}]{1,80}\\}_(?:' + suffixes.join('|') + ')\\b', 'g');

describe('the module answers the question, and refuses what it cannot vouch for', () => {
  it('names every one of a space\'s collections', () => {
    assert.ok(SPACE_COLLECTIONS, 'the module must publish the suffix set');
    const parts = Object.keys(SPACE_COLLECTIONS);
    assert.ok(parts.length >= 11,
      `only ${parts.length} suffixes declared — the sweep measured eleven, and one missing here is one `
      + 'that stays hand-written for ever because nothing can route it');
    // The five that no existing map covers, which is the reason this module exists rather than a third map.
    for (const p of ['tombstones', 'conflicts', 'dupeCandidates', 'contradictionCandidates', 'embedJobs']) {
      assert.ok(p in SPACE_COLLECTIONS, `${p} is not covered, and no other map covers it either`);
    }
  });

  it('and every RECORD_COLLECTION value is one of them, or the two vocabularies have drifted', async () => {
    /*
     * The check that lets this file DECLARE its eleven rather than spread the type map in. Spreading would
     * key the record entries by TYPE (`fact`) and the rest by collection (`tombstones`), so one object would
     * answer two different questions depending on which key you happened to reach for. Declaring them and
     * asserting the overlap keeps one vocabulary without that ambiguity — and a seventh knowledge type fails
     * HERE, where somebody has to decide what its collection is called, rather than silently having none.
     */
    const { RECORD_COLLECTION } = await import('../../server/dist/config/types-knowledge.js');
    const named = new Set(Object.values(SPACE_COLLECTIONS));
    for (const suffix of Object.values(RECORD_COLLECTION)) {
      assert.ok(named.has(suffix),
        `RECORD_COLLECTION names '${suffix}' and SPACE_COLLECTIONS does not. A record type whose collection `
        + 'this module cannot name is one whose call sites stay hand-written for ever.');
    }
  });

  it('builds the name a caller would have written by hand', () => {
    assert.equal(spaceCollection('general', 'facts'), 'general_facts');
    assert.equal(spaceCollection('work-archive', 'tombstones'), 'work-archive_tombstones');
  });

  it('REFUSES an id that could forge the separator, rather than returning a name', () => {
    /*
     * The whole reason the module exists. `work_archive` as an id makes `work_archive_facts`, which carries
     * the prefix `work_` — so dropping the space `work` would drop it too. A template string returns that
     * name happily.
     */
    assert.throws(() => spaceCollection('work_archive', 'facts'), /space id/i,
      'an underscore in the id makes one space\'s collections look like another\'s, and a DROP selects by '
      + 'that prefix');
    for (const bad of ['', 'Work', 'a b', '../x', 'a.b', 'a$b']) {
      assert.throws(() => spaceCollection(bad, 'facts'), /space id/i,
        `spaceCollection(${JSON.stringify(bad)}) returned a name instead of refusing`);
    }
  });

  it('refuses a part it does not know, rather than building a collection nothing reads', () => {
    assert.throws(() => spaceCollection('general', 'memories'), /collection/i,
      'an unknown part must refuse — a name nobody writes to reads as an empty collection, which is the '
      + 'failure this whole area keeps producing');
  });
});

describe('and nothing builds one by hand any more', () => {
  it('no source concatenates a collection name', () => {
    const suffixes = Object.values(SPACE_COLLECTIONS);
    const sources = trackedSources(['server/src'], { floor: 200 });

    const offenders = [];
    let scanned = 0;
    for (const f of sources) {
      const src = code(f);
      scanned += 1;
      // Fresh per file: a shared /g regex carries lastIndex between subjects and skips matches.
      for (const m of src.matchAll(concatenated(suffixes))) offenders.push(`${f}: ${m[0]}`);
    }

    assert.ok(scanned >= 200, `only ${scanned} sources scanned — the sweep did not read the server`);
    assert.deepEqual(offenders, [],
      `${offenders.length} collection name(s) still built by concatenation. Each one drops the space-id `
      + 'charset check that keeps a DROP on one space from taking another\'s data:\n  '
      + offenders.slice(0, 40).join('\n  '));
  });

  /**
   * Suffixes that are concatenated onto a space id and are NOT a collection. Each is classified here with
   * its reason, so the sweep below can require that EVERY suffix in the tree is one or the other.
   *
   * This is the assertion the first pass of `A-5` did not have, and not having it is why that pass counted
   * eleven collections when there are fifteen: a sweep that searches for the suffixes it already knows
   * cannot report the ones it does not. Four were found only because an unrelated gate happened to name
   * one of them.
   */
  const NOT_A_COLLECTION = new Map([
    ['embedding', 'an Atlas vector INDEX name, not a collection'],
    ['files_faceEmbedding', 'the face gallery vector index'],
    ['GIB', 'the tail of a STORAGE_<area>_<tier>_GIB env var name, built the same way and not a collection'],
  ]);

  it('every suffix concatenated onto a space id is classified — collection, or explicitly not one', () => {
    const known = new Set(Object.values(SPACE_COLLECTIONS));
    // UNBOUNDED inside the braces. A capped repetition there would be a character count standing in for
    // "an expression", and `gates-bound-their-subject-structurally.test.js` refuses those on principle —
    // correctly: the closing brace is the structural bound, so a cap adds nothing and would silently skip
    // a longer interpolation. (That gate counts on the RAW source deliberately, so this comment states the
    // rule in words rather than writing the pattern it forbids.)
    const anySuffix = /\$\{[A-Za-z_][^}]*\}_([a-zA-Z_]+)/g;
    const unknown = new Map();
    let scanned = 0;

    for (const f of trackedSources(['server/src'], { floor: 200 })) {
      scanned += 1;
      for (const m of code(f).matchAll(new RegExp(anySuffix.source, 'g'))) {
        const suffix = m[1];
        if (known.has(suffix) || NOT_A_COLLECTION.has(suffix)) continue;
        // A longer suffix that merely STARTS with a known one, e.g. `${s}_${suffix}_embedding`, is the
        // index case and is covered by its own entry — anything else is genuinely new.
        if (!unknown.has(suffix)) unknown.set(suffix, f);
      }
    }

    assert.ok(scanned >= 200, `only ${scanned} sources scanned — the sweep did not read the server`);
    assert.deepEqual([...unknown.keys()], [],
      'these suffixes are concatenated onto a space id and are neither a collection this module names nor '
      + 'a classified non-collection. Each is either a collection nobody can route, or an index name that '
      + 'belongs in NOT_A_COLLECTION with its reason:\n  '
      + [...unknown].map(([k, f]) => `${k}  (${f})`).join('\n  '));
  });

  it('and the module itself is the one place the template lives', () => {
    // Mutation-proof for the sweep above: if the pattern matched nothing, this would fail too.
    const src = code('server/src/db/space-collection.ts');
    assert.match(src, /\$\{/, 'the module must actually build the name — if this is gone, the sweep above '
      + 'is asserting over a pattern that can no longer match anything');
  });
});
