/**
 * A link record's collection joins every set it belongs to, and stays out of the one it must not.
 *
 * ## What a link record is
 *
 * Six public array fields say that a record concerns others — `fact.entityIds`, `chrono.entityIds`,
 * `chrono.memoryIds`, and `file.entityIds`/`memoryIds`/`chronoIds`. `M-2` turns them into records, so the
 * five adjacency readers that each followed a different subset of them have one place to look. The owner's
 * ruling is that those records do NOT live in `_edges`: an edge is a modelled relationship with a label
 * somebody chose, and a link asserts only that two records are connected.
 *
 * ## Why each membership is asserted separately
 *
 * A collection can be absent from any one of these lists and the product still starts, still passes every
 * other test, and is quietly missing one thing:
 *
 *   - **not created** (`SPACE_COLLECTIONS`) — no collection, no indexes, and the first write creates it
 *     un-indexed, so every read is a scan.
 *   - **not knowledge-bearing** (`BRAIN_COLLECTIONS`) — a wipe leaves links behind, `/filter` refuses the
 *     collection, the importer skips it, an MCP caller is told it does not exist.
 *   - **not hashed** (`brain/merkle.ts`) — **the loudest.** Two instances holding different links report
 *     themselves IDENTICAL. That is worse than not replicating, because it reports agreement.
 *   - **not replicated** (`SyncCounts`, `payloadKey`) — for a record type whose entire purpose is to be
 *     shared, this ships the feature and none of it.
 *   - **not governed** (`auth/space-rights.ts`) — a route with no rights row is either unreachable or
 *     ungoverned, and both fail silently.
 *   - **vector-indexed** (`VECTOR_INDEXED_COLLECTIONS`) — the one it must NOT join. A link has no content,
 *     so it would enter every ranked list as a content-free competitor at one record per link. And
 *     `suppressEmbeddings` would not save it: that removes the vector channel only, and two suppressed
 *     edges were measured appearing in a 7-record space's top 5 through the lexical channel of hybrid
 *     search.
 *
 * Run: node --test testing/standalone/a-link-collection-joins-every-set-it-must.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

const read = (f) => readFileSync(f, 'utf8');
const code = (f) => stripComments(read(f));

/** The collection suffix. `links`, plural, like every other collection and unlike the record kind. */
const LINKS = 'links';

describe('the link collection joins every set it belongs to', () => {
  it('a space CREATES it, so it and its indexes exist before the first write', () => {
    // `SPACE_COLLECTIONS` is what creates them and nothing else does. A collection Mongo makes on first
        // insert has no indexes at all, which is not an error anywhere — just a scan on every read.
    const src = code('server/src/spaces/_shared.ts');
    const at = src.indexOf('SPACE_COLLECTIONS');
    const decl = src.slice(at, src.indexOf(';', at));
    assert.match(decl, new RegExp(`['"]${LINKS}['"]`), 'links must be in SPACE_COLLECTIONS');
  });

  it('it is KNOWLEDGE-bearing, so a wipe clears it and /filter can read it', () => {
    const src = code('server/src/config/types-knowledge.ts');
    const at = src.indexOf('BRAIN_COLLECTIONS');
    const decl = src.slice(at, src.indexOf(';', at));
    assert.match(decl, new RegExp(`['"]${LINKS}['"]`), 'links must be in BRAIN_COLLECTIONS');
    // And the client's mirror, which is the other authority — the client does not import from `server/`.
    const mirror = code('client/src/app/core/api.types.ts');
    const mAt = mirror.indexOf('BRAIN_COLLECTIONS');
    assert.match(mirror.slice(mAt, mirror.indexOf(';', mAt)), new RegExp(`['"]${LINKS}['"]`),
      'the client mirror must list links too, or the query tab cannot offer the collection');
  });

  it('it is NEVER vector-indexed, and that list says so in its own words', () => {
    // The one membership that is a refusal. Asserted on the declaration rather than the file, because the
    // file's own comment names `links` while explaining why — a substring search would pass on the prose.
    const src = code('server/src/spaces/vector-index.ts');
    const at = src.indexOf('VECTOR_INDEXED_COLLECTIONS');
    const decl = src.slice(at, src.indexOf(';', at));
    assert.doesNotMatch(decl, new RegExp(`['"]${LINKS}['"]`),
      'a link has no content to embed — a vector index on this collection is the defect M-2 is written around');
    assert.match(read('server/src/spaces/vector-index.ts'), /NOT ALL BRAIN COLLECTIONS/,
      'and the subset must still declare itself, so the exemption cannot go silent');
  });

  it('it is HASHED, or two instances that differ report themselves identical', () => {
    /*
     * DERIVED, because the walk is. It used to name its five collections and this matched the literal;
     * `P-32` made a file's metadata replicate, so every brain collection is hashed and the walk reads
     * `BRAIN_COLLECTIONS` instead of listing them.
     *
     * The rule has not moved and the check is stronger for it: a link is in that tuple
     * (`one-definition-of-the-collections.test.js` holds it there), so a walk over the tuple covers links
     * by construction. What this now asserts is that the walk really does read the tuple rather than a
     * list somebody could trim.
     */
    const src = code('server/src/brain/merkle.ts');
    // Read from source, like every other case in this file — the client mirror is checked the same way, and
    // importing the tuple here would make this the one case that trusts a build.
    const tuple = code('server/src/config/types-knowledge.ts');
    const at = tuple.indexOf('BRAIN_COLLECTIONS');
    assert.match(tuple.slice(at, tuple.indexOf(';', at)), new RegExp(`['"]${LINKS}['"]`),
      `${LINKS} is not in BRAIN_COLLECTIONS, so a walk over the tuple would not cover it`);
    assert.match(src, /for \(const collType of BRAIN_COLLECTIONS\)/,
      'the merkle walk no longer derives its collections from the one tuple, so a list somebody trims can '
      + 'drop links and MERKLE_DIVERGENCE stays silent while data is missing');
  });

  it('it REPLICATES — the counts, and the push path', () => {
    // Two halves, and each is silent alone: a payload key with no counter loses the number, a counter with
    // no payload key counts a push that never happens.
    assert.match(code('server/src/sync/history.ts'), new RegExp(`\\b${LINKS}\\s*:\\s*number`),
      'SyncCounts needs a links count');
    // The engine's two enumerations became one table in `sync/replicated-families.ts` (`A-12`), so the
    // family list is where a missing collection now hides — and it is the only place, which is the point.
    assert.match(code('server/src/sync/replicated-families.ts'), new RegExp(`['"]${LINKS}['"]`),
      'the replicated-family list must carry the links collection, or neither direction moves it');
  });

  it('the ingest schema DECLARES the document, or a pushed link is silently truncated', () => {
    // `api/sync/_shared.ts` validates every pushed document with a bare `z.object({...})`, and zod STRIPS
    // keys the schema does not declare. The pull path validates nothing. So a document type with no
    // `Incoming*` twin is kept when it arrives by pull and emptied when the same record arrives by push —
    // same code, same document, one direction, no error, and a 200 on the way back.
    const src = code('server/src/api/sync/_shared.ts');
    assert.match(src, /IncomingLinkDoc|incomingLink/i,
      'a LinkDoc pushed to a peer must have an ingest schema of its own');
  });

  it('it is GOVERNED — by the knowledge rights, through the door that can already reach it', () => {
    /*
     * Owner's ruling (P-28, 2026-09-02): *"make it require the knowledge rights only."* Requiring BOTH
     * ends' rights was ruled first and then priced: a route declares ONE area, so it would have meant
     * resolving a link's two endpoints on every writing door — one rule spread across many doors, which is
     * the defect shape this repo produces most.
     *
     * **There is no `/links` route in this slice, and that is not a gap.** Joining `BRAIN_COLLECTIONS`
     * makes the collection readable through `/filter` and the `filter` MCP tool immediately — which is a
     * real new capability, on both doors, and it is why the guides change in this slice too. Both doors
     * are already governed by the same row, so what this asserts is that the row governing them is the
     * knowledge one. A dedicated route, when it lands, brings its own row with it.
     */
    const rows = code('server/src/auth/space-rights.ts').split('\n');
    const query = rows.filter(l => /route: '[^']*\/filter'/.test(l));
    assert.equal(query.length, 1, 'expected exactly one rights row for /filter');
    assert.match(query[0], /area: 'knowledge'/,
      'the door that can now read the links collection must be knowledge-governed');
    // A link route, if one exists, is knowledge too — never files or dataQuality. Matched on the route
    // SEGMENT: an earlier draft used `/links?/` and reported `/api/conflicts/link-violations`, which is a
    // data-quality report about links and not a door onto them.
    for (const r of rows.filter(l => /route: '[^']*\/links(\/|')/.test(l))) {
      assert.match(r, /area: 'knowledge'/, `a link route is knowledge-governed: ${r.trim()}`);
    }
  });
});

describe('a LinkDoc carries nothing it has no meaning for', () => {
  it('no label, no type, no weight — the endpoint kinds ARE the class', () => {
    // set-claim: the edge fields a LinkDoc must NOT have -- a design decision stated as the absence, and
    // the case's own comment says why: the endpoint kinds ARE the class, so a label would be a second
    // spelling of one fact.
    // Six classes, six distinct `(fromKind, toKind)` pairs: memory→entity, chrono→entity, chrono→memory,
    // file→entity, file→memory, file→chrono. So the label a traverse shows stays derived, exactly as
    // `LINK_CLASSES` prints it today. A stored one is a degree of freedom the arrays never had, and two
    // spellings of one fact is what this codebase gets wrong most.
    const src = code('server/src/config/types.ts');
    const at = src.indexOf('export interface LinkDoc');
    assert.ok(at > 0, 'LinkDoc must be declared');
    const decl = src.slice(at, src.indexOf('\n}', at));
    for (const forbidden of ['label', 'weight', 'properties', 'embedding', 'matchedText', 'suppressEmbeddings']) {
      assert.doesNotMatch(decl, new RegExp(`^\\s*${forbidden}\\??:`, 'm'),
        `a link record has no \`${forbidden}\` — it asserts only that two records are connected`);
    }
  });

  it('both endpoint kinds are REQUIRED, unlike an edge\'s', () => {
    // An edge's absent kind means `entity`, which is what every edge in every existing space is. A link
    // has no such default: three of the six classes have a non-entity at each end, so absent would mean
    // "unknown" — a link that cannot be resolved at all.
    const src = code('server/src/config/types.ts');
    const at = src.indexOf('export interface LinkDoc');
    const decl = src.slice(at, src.indexOf('\n}', at));
    assert.match(decl, /^\s*fromKind:\s*RefKind;/m, 'fromKind is required on a link');
    assert.match(decl, /^\s*toKind:\s*RefKind;/m, 'toKind is required on a link');
  });
});
