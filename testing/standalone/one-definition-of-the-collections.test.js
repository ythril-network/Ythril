/**
 * Every collection list either DERIVES from one tuple or says why it is a different set.
 *
 * ## Three sets, nine names, and only one of them shared
 *
 * A space's documents live in collections, and the list was written out twenty times under nine names. Eight
 * of those names look like one set and are not — they were identical only because the set has had four
 * members. Measured 2026-09-03:
 *
 *   1. **every collection a space owns** — `SPACE_COLLECTIONS` in `spaces/_shared.ts`. Nine entries, the
 *      machinery included: `tombstones`, `conflicts`, `dupe_candidates`, `contradiction_candidates`. It is
 *      what CREATES them, and nothing else does.
 *   2. **the knowledge-bearing ones** — `BRAIN_COLLECTIONS`. What a wipe clears, what `/query` reads, what
 *      the importer accepts, what the TTL sweep walks, what sync counts. This is the shared one.
 *   3. **the ones with a vector index** — `VECTOR_INDEXED_COLLECTIONS`. Knowledge-bearing MINUS anything
 *      never embedded, which is why it cannot be spelled as set 2.
 *
 * The Brain's tabs are a fourth question — what the UI shows, not where documents live.
 *
 * ## Why this gate is shaped as "derive OR declare"
 *
 * The first draft required every full-list site to read one tuple. It was written and deleted the same hour,
 * because it would have forced a vector index onto a collection that must never have one — a defect
 * introduced by a check. The same mistake, one level up, as a check that could not tell `RefKind` from the
 * knowledge types.
 *
 * So a site may write the names out, as long as it says in its own comment that it is a deliberate subset
 * and why. Adding a collection is then one edit for set 2, and a decision the author has to write down for
 * the other two.
 *
 * ## Why it matters now
 *
 * `M-2` stores links in a collection of their own — the owner's ruling is that link records must not live in
 * `_edges`, so `GET /edges` cannot see them. That collection joins set 1 first (no entry, no collection, no
 * indexes), joins set 2, and must stay out of set 3.
 *
 * Every miss is silent in its own way: `/query` refusing a collection it should allow, the importer skipping
 * a record kind, a wipe leaving links behind, the TTL sweep never expiring one, an MCP caller told the
 * collection does not exist. And the loudest silence of all — a collection absent from sync replicates
 * nothing, which for a record type whose whole purpose is to be shared ships the feature and none of it.
 *
 * Run: node --test testing/standalone/one-definition-of-the-collections.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();
/**
 * The two files allowed to name the collections: the server's types LEAF, and the client's mirror of it.
 *
 * Two and not one for the reason the type lists have two — `client/src/app/core/api.types.ts` is the
 * client's deliberate mirror of the API's shapes, and the client does not import from `server/`.
 *
 * The leaf and not `brain/ttl.ts`, which is where the map used to live: `ttl.ts` sits on the delete path and
 * five of the callers that needed the map could not import it without a cycle. A vocabulary has to be
 * reachable from anywhere, which is what a leaf is for.
 */
const DECLARATIONS = ['server/src/config/types-knowledge.ts', 'client/src/app/core/api.types.ts'];

/** The marker a deliberate subset carries, in its own words, beside the list. */
const DECLARED_SUBSET = /NOT ALL BRAIN COLLECTIONS/;

/** The five knowledge collections, PLURAL — never the singular type names, which are a different list. */
const COLS = ['facts', 'entities', 'edges', 'chrono', 'files'];

/**
 * How many of the five a run must name before it counts as writing the list out. **FOUR, not five.**
 *
 * ## Five was the wrong line, and `M-2` is what proved it
 *
 * The first version of this gate fired only on a run naming all five. Every site the link migration has to
 * edit names FOUR — because those four mean *the typed knowledge collections* and each handles files by
 * another route entirely:
 *
 *   - `brain/merkle.ts` hashes four and takes files from a manifest. A collection absent from the hash means
 *     two instances holding different data report themselves IDENTICAL, which is worse than not replicating,
 *     because it reports agreement.
 *   - `sync/engine.ts`'s `payloadKey` is a four-member union; files cross the wire by another path.
 *   - `spaces/ensure-query-indexes.ts`'s `TYPE_FILTERED` is the four that have a `type` field to filter on.
 *   - `metrics/registry.ts` pre-declares gauge labels for four.
 *
 * **A gate that only sees the complete list passes exactly the sites the next member breaks.** So four.
 *
 * And three stays out on purpose. `memories | chrono | files` is the set of collections that HOLD link
 * arrays — a genuinely different question, with its own names (`LINK_SCANNED`, `LINK_CLASSES`) and three
 * separate spellings. Lowering to three would report a real concept as debt.
 */
const NEAR_COMPLETE = 4;

function sourceFiles() {
  return trackedSources(['server/src', 'client/src'])
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'));
}

/** A quoted string immediately after the run — so the run is the START of a longer list of strings. */
const STRING_FOLLOWS = /^\s*,\s*['"]/;
/** A quoted string immediately before it — so the run is the END of one. */
const STRING_PRECEDES = /['"]\s*,\s*$/;

/**
 * Every run of adjacent quoted collection names that is a LIST OF ITS OWN and names at least four of five.
 *
 * Two things make this structural rather than a count of names:
 *
 * **The plurals only.** `'entity', 'fact', 'edge', 'chrono'` is the TYPE list — a different enumeration
 * with its own gate — and a check that conflated them would report one as debt for looking like the other.
 *
 * **A run that continues into other strings is a PREFIX, not a list.** `SPACE_COLLECTIONS` writes all nine
 * of its members on one line and the first four are the knowledge collections, so a plain
 * run-of-adjacent-names sweep sees a four-member list inside a nine-member one and reports set 1 as a hidden
 * subset of set 2. It is not: it has a name, it is the thing that creates the collections, and it gains a new
 * member for the ordinary reason. So a run whose neighbour on either side is another quoted string is
 * skipped — that is a longer list of strings which happens to start or end with these.
 */
function enumerationsIn(src) {
  const clean = stripComments(src);
  const hits = [];
  const run = /(['"])(?:facts|entities|edges|chrono|files)\1(?:\s*[,|]\s*(['"])(?:facts|entities|edges|chrono|files)\2)+/g;
  for (const m of clean.matchAll(run)) {
    const named = COLS.filter(c => m[0].includes(`'${c}'`) || m[0].includes(`"${c}"`));
    if (named.length < NEAR_COMPLETE) continue;
    // UNBOUNDED slices, anchored regexes. A `slice(end, end + 40)` would be a character count deciding how
    // much of the subject this gate can see, which `gates-bound-their-subject-structurally.test.js` refuses
    // — and correctly: a count spans a different number of lines on CRLF than on CI's LF. `^` and `$` do the
    // bounding instead, so the window is exactly the neighbouring token however long the rest of the file is.
    const end = m.index + m[0].length;
    if (STRING_FOLLOWS.test(clean.slice(end))) continue;
    if (STRING_PRECEDES.test(clean.slice(0, m.index))) continue;
    hits.push(m[0].replace(/\s+/g, ' '));
  }
  return hits;
}

describe('a collection list derives from the one tuple, or declares itself a subset', () => {
  it('no file writes the collections out without saying why', () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      if (DECLARATIONS.includes(f)) continue;
      const src = readFileSync(f, 'utf8');
      const hits = enumerationsIn(src);
      if (hits.length === 0) continue;
      // The declaration is read from the FULL source, comments included: it is a comment.
      if (DECLARED_SUBSET.test(src)) continue;
      for (const h of hits) offenders.push(`${f} — ${h.slice(0, 70)}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} site(s) write the collections out and neither derive nor declare:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + '\n\n      Import `BRAIN_COLLECTIONS`, or write `NOT ALL BRAIN COLLECTIONS` beside the list with the'
      + '\n      reason. A collection added to the wrong set is one feature silently absent for one record'
      + '\n      kind, and M-2 adds one.',
    );
  });

  it('the tuple DERIVES from the type list rather than repeating it', () => {
    // A hand-written tuple here is a twenty-first copy wearing the name of the fix. The knowledge
    // collections ARE the knowledge types' suffixes plus `files`, and that mapping already exists.
    const clean = stripComments(readFileSync(DECLARATIONS[0], 'utf8'));
    assert.match(clean, /BRAIN_COLLECTIONS[^=]*=[^;]*RECORD_COLLECTION/,
      'BRAIN_COLLECTIONS must be built from the record-to-collection map, not listed again');
    /*
     * A STRUCTURAL window, not a character count.
     *
     * The first draft asked for `files` within 240 characters of `RECORD_COLLECTION` — and
     * `no-magic-windows.test.js` refuses that, correctly: a character count spans a different number of
     * LINES on CRLF than on CI's LF, so the window silently looks at less on one of the two. The subject
     * here is the DECLARATION, so the bound is the declaration's own end.
     */
    const at = clean.indexOf('RECORD_COLLECTION');
    const decl = clean.slice(at, clean.indexOf('};', at) + 2);
    // `file` is the KEY and `'files'` is the value — the record kind is singular and the collection plural,
    // which is the whole reason this map exists. The first draft asserted it the other way round.
    assert.match(decl, /\bfile\s*:\s*['"]files['"]/,
      'the record map has to add `file: "files"`, the one collection with no knowledge type above it');
  });

  it('the deliberate subsets each say so, so the exemption cannot be silent', () => {
    // set-claim: the deliberate SUBSETS, each listed with the reason it is one -- this case exists to
    // make an exemption say so, so the list is its subject rather than a copy of anything.
    // An exemption nobody has to justify is a hole. These are the ones the rule exists to protect: a vector
    // index a link must never get, the UI's tabs — which answer a different question entirely — and the four
    // four-member lists that mean "the typed knowledge collections" and route files elsewhere.
    //
    // **`merkle.ts` came OFF this list.** It hashed four collections plus links and excluded `files`, which
    // was a subset and said so. `P-32` made a file's metadata replicate, so every brain collection is now
    // hashed and the list IS the tuple — it derives from `BRAIN_COLLECTIONS` rather than declaring itself a
    // subset of it. An exemption whose reason has expired is the thing this file is about.
    for (const f of [
      'server/src/spaces/vector-index.ts',
      'client/src/app/pages/brain/brain-tabs.ts',
      'server/src/sync/engine.ts',
      'server/src/spaces/ensure-query-indexes.ts',
      'server/src/metrics/registry.ts',
    ]) {
      assert.match(readFileSync(f, 'utf8'), DECLARED_SUBSET,
        `${f} writes the collections out as a deliberate subset and must say so beside its list`);
    }
  });

  it('a run inside a LONGER list of strings is a prefix, not a subset', () => {
    // The false-positive floor, and it is a real shape: `SPACE_COLLECTIONS` opens with these four and
    // continues into `tombstones`, `conflicts` and the two candidate queues. A gate that reported it would
    // be tuned away rather than fixed, which is how a signature list starts.
    const nine = "const SPACE_COLLECTIONS = ['facts', 'entities', 'edges', 'chrono', 'tombstones', 'conflicts', 'files', 'dupe_candidates', 'contradiction_candidates'] as const;";
    assert.deepEqual(enumerationsIn(nine), [], 'a nine-member list must not read as a four-member subset');
    assert.deepEqual(enumerationsIn(readFileSync('server/src/spaces/_shared.ts', 'utf8')), [],
      'and the real file it was taken from must stay quiet for the same reason');
  });

  it('the detector actually detects', () => {
    // Mutation-proof for the threshold and the plurals both: a detector that never fires passes everything,
    // and one that cannot tell four from three would report `LINK_SCANNED` as debt.
    assert.equal(enumerationsIn("x = ['facts', 'entities', 'edges', 'chrono'];").length, 1, 'four is the line');
    assert.equal(enumerationsIn("x = ['facts', 'entities', 'edges', 'chrono', 'files'];").length, 1, 'five too');
    assert.equal(enumerationsIn("t: 'facts' | 'entities' | 'edges' | 'chrono';").length, 1, 'a union counts');
    assert.equal(enumerationsIn("x = ['facts', 'chrono', 'files'];").length, 0, 'three is a different concept');
    assert.equal(enumerationsIn("x = ['entity', 'fact', 'edge', 'chrono', 'file'];").length, 0,
      'the singular TYPE names are a different list with its own gate');
    assert.equal(enumerationsIn("// ['facts', 'entities', 'edges', 'chrono']").length, 0,
      'a comment explaining the rule must not trip it');
  });
});
