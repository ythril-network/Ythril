/**
 * The knowledge types are enumerated ONCE per side of the wire.
 *
 * ## The rule, and where it was written twenty times
 *
 * A space's knowledge is four kinds of record — entity, memory, edge, chrono — and that list decides more
 * than a type union. It decides which kinds a space can hold a type schema for, which kinds the schema
 * library will accept, which kinds appear in an audit summary, which kinds have a retention bucket, and
 * which collections a redaction sweep walks.
 *
 * Measured 2026-09-03: **twenty sites across `server/src` and `client/src` write the four names out as a
 * literal list.** Five in the schema-library route alone, four in the spaces route, plus the audit summary,
 * the redaction sweep, both TTL maps, and the client's own mirror and its three consumers.
 *
 * ## Why this is a gate rather than a tidy-up
 *
 * `M-2` adds a FIFTH: one link knowledge type, so a relationship between records becomes a record. With the
 * list written out twenty times, adding it means finding twenty sites — and every one missed is silent in
 * its own way. A schema library that refuses link schemas. An audit summary with a kind missing. A retention
 * bucket that never expires anything, because nothing maps the kind to a collection.
 *
 * None of those throw. Each is a feature quietly absent for one kind of record, which is the same shape as
 * the five capabilities that shipped REST-only because a route was written and its tool "would follow".
 *
 * So the enumeration is extracted BEFORE the fifth member is added, and this gate is what stops the
 * twenty-first copy: with one tuple per side, adding a kind is one edit, and adding one with its own list is
 * what fails.
 *
 * ## Why per SIDE and not once overall
 *
 * `client/src/app/core/api.types.ts` is the client's deliberate mirror of the API's shapes — its own
 * docblock says its consumers import one module on purpose, and the client does not import from `server/`.
 * So two definitions, one per side, and the mirror is the client's single source.
 *
 * Run: node --test testing/standalone/one-definition-of-the-knowledge-types.test.js
 */
import { describe, it } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { stripComments } from './_strip-comments.mjs';

const ROOT = process.cwd();

/** The two files allowed to name the kinds: one per side of the wire. */
const DECLARATIONS = [
  'server/src/config/types-knowledge.ts',
  'client/src/app/core/api.types.ts',
];

function sourceFiles() {
  return trackedSources(['server/src', 'client/src'])
    .filter(f => f.endsWith('.ts') && !f.endsWith('.spec.ts') && !f.endsWith('.d.ts'));
}

/**
 * Every run naming ALL FOUR kinds as adjacent quoted literals or union members — a copy of the enumeration.
 *
 * ## Why all four and not three, which the first draft required
 *
 * Three-of-four looked like the worse case: a partial list looks deliberate and the missing kind is
 * invisible. Run that way it reported 48 sites and it was WRONG about several of them, because this repo has
 * three different unions over these names and only one of them is the enumeration:
 *
 *   - `KnowledgeType` — the four kinds a space holds. This is the one being extracted.
 *   - `RefKind` — what a reference can point AT: entity, memory, chrono, and `file`. Its own docblock says
 *     *"Deliberately not KnowledgeType, and the difference is not cosmetic"*, so a site naming those three
 *     is a different set on purpose.
 *   - Per-feature subsets: the duplicate and contradiction scanners cover memory, entity and chrono, and
 *     leaving edges out is a decision each of them documents.
 *
 * A gate that cannot tell a copy from a deliberately different set makes the different sets look like debt,
 * and the way to shut it up is to widen them — which would be a real defect introduced by a check. So it
 * asks the unambiguous question: does this site write out the WHOLE list? Nothing but a copy does that.
 */
function enumerationsIn(src) {
  const clean = stripComments(src);
  const KINDS = ['entity', 'fact', 'edge', 'chrono'];
  const hits = [];
  // A run of quoted kind names — `file` included, so a five-member run is recognised and then excluded.
  const run = /(['"])(?:entity|memory|edge|chrono|file)\1(?:\s*[,|]\s*(['"])(?:entity|memory|edge|chrono|file)\2)+/g;
  for (const m of clean.matchAll(run)) {
    const has = n => m[0].includes(`'${n}'`) || m[0].includes(`"${n}"`);
    const named = KINDS.filter(has);
    // All four kinds, `file` present or not: BOTH enumerations are one tuple each now, and a run naming the
    // whole of either is a copy of it. The `file` half landed one change later than the rest — see below.
    if (named.length === KINDS.length) hits.push({ text: m[0].replace(/\s+/g, ' '), named });
  }
  return hits;
}

/**
 * THE SECOND ENUMERATION — the four kinds PLUS `file` — and what its extraction had to establish first.
 *
 * Sixteen sites wrote it out, under five aliases for one set: `RecallKnowledgeType`, `BrainEmbedRecordType`,
 * `DupeScanType`, `TtlBucket` and `EMBED_RECORD_TYPES`. Only the last of those was already derived.
 *
 * **It landed one change after the four-member one, because its ORDER was not consistent and deriving it
 * changes that.** Most sites wrote `memory` first; the retention buckets wrote `entity` first and their
 * comment said the order was the one the UI shows. Deriving makes every site entity-first, which touches
 * three surfaces — so each was checked rather than assumed:
 *
 *   - **recall's default type list**: does NOT affect results. The fan-out maps over the types and flattens,
 *     then every consumer sorts by score with `byIdAsc` as a deterministic tiebreak, and the lexical
 *     introduction caps PER TYPE against a pool a record can only belong to one type of.
 *   - **the MCP tool schemas**: a JSON-Schema `enum` is a set. The published text changes; nothing a caller
 *     does with it can.
 *   - **the Brain query tab's type chips**: genuinely visible, and it now matches the order every other list
 *     in the product already used. Read on a screenshot rather than argued.
 *
 * One of the three turned out not to be a surface at all: `recallKnowledgeTypes` in the query tab was
 * declared, never read, and not in the template either. Deleted rather than converted.
 */


describe('the knowledge types are named in one place per side', () => {
  it('no file re-enumerates them', () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      if (DECLARATIONS.includes(f)) continue;
      const hits = enumerationsIn(readFileSync(f, 'utf8'));
      for (const h of hits) offenders.push(`${f} — ${h.text.slice(0, 72)}`);
    }
    assert.deepEqual(
      offenders,
      [],
      `${offenders.length} site(s) write the knowledge types out instead of importing the one tuple:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + `\n\nM-2 adds a fifth kind. Every list here is a site that has to be found, and each one missed is a`
      + `\nfeature silently absent for one kind of record rather than an error.`,
    );
  });

  /**
   * The same enumeration written as PROPERTY NAMES, which the sweep above cannot see.
   *
   * It matches the four kinds as quoted literals. `TypeSchemasZ` wrote them as object keys —
   * `entity:`, `memory:`, `edge:`, `chrono:` — and was invisible to it for a year.
   *
   * **That site was the worst possible one to miss.** It is `.strict()`, which makes it the only thing in
   * the product that can REFUSE a key there: a fifth knowledge type would have been rejected by that door
   * while every other site accepted it, and the refusal would have named a body that was correct
   * everywhere else. The authority on the answer was a hand-written copy of it.
   *
   * Four keys and not three, for the same reason the literal sweep asks for four: this repo has several
   * deliberately-different subsets over these names, and a check that cannot tell a copy from a different
   * set makes the different sets look like debt.
   */
  function propertyEnumerationsIn(src) {
    const KINDS = ['entity', 'fact', 'edge', 'chrono'];
    // Strings blanked as well as comments: a sentence containing `entity:` is prose, not a key, and the
    // first version of this counted one.
    const clean = stripComments(src).replace(/(['"`])(?:\\.|(?!\1)[^\\])*\1/g, '""');

    /*
     * BRACE-MATCHED, never a character window.
     *
     * The first attempt matched a run of `key: value` pairs with a regex, and its value pattern stopped at
     * the first comma — which in `z.record(k, T).optional()` is INSIDE the call. It saw one key and moved
     * on, so it reported nothing about the exact site it was written for. Its own self-test is what said so.
     *
     * `gate-windows-must-be-structural-not-character-counts` is the rule this obeys: an object literal has
     * a beginning and an end, and those are what bound the question.
     */
    const hits = [];
    for (let i = 0; i < clean.length; i++) {
      if (clean[i] !== '{') continue;
      let depth = 0, j = i;
      for (; j < clean.length; j++) {
        if (clean[j] === '{') depth++;
        else if (clean[j] === '}' && --depth === 0) break;
      }
      if (j >= clean.length) continue;
      // Blank everything nested one level down, so a key of an INNER object is not read as this one's.
      let d = 0;
      const top = [...clean.slice(i + 1, j)].map(ch => {
        if (ch === '{') { d++; return ' '; }
        if (ch === '}') { d--; return ' '; }
        return d > 0 ? ' ' : ch;
      }).join('');
      const named = KINDS.filter(k => new RegExp(`(?:^|[,;])\\s*${k}\\s*:`).test(top));
      /*
       * A `Record<SomeType, X>` annotation is EXEMPT, and that exemption is the rule rather than a hole in it.
       *
       * The four names being present there is the TYPE SYSTEM forcing them: add a fifth kind to the tuple and
       * every one of those objects stops compiling, by name, with the missing key in the message. That is a
       * better gate than this one, and it already exists.
       *
       * What is left — an object keyed by these four with nothing requiring it to stay complete — is the case
       * that goes silent. `TypeSchemasZ` was one: a zod shape, `.strict()`, no link to the tuple, and the only
       * thing in the product that could REFUSE one of these names.
       */
      const decl = clean.slice(Math.max(0, clean.lastIndexOf(';', i) + 1), i);
      const forcedComplete = /Record<\s*\w+/.test(decl);
      if (named.length === KINDS.length && !forcedComplete) hits.push(top.replace(/\s+/g, ' ').trim());
      i = j; // an object already reported is not re-scanned from the inside
    }
    return hits;
  }

  it('DETECTS a property-name copy, which is how TypeSchemasZ hid', () => {
    // A gate that has never failed is indistinguishable from one that cannot. This is the exact shape the
    // schema had before it derived its keys.
    const before = [
      'export const TypeSchemasZ = z.object({',
      '  entity: z.record(k, T).optional(),',
      '  fact: z.record(k, T).optional(),',
      '  edge:   z.record(k, T).optional(),',
      '  chrono: z.record(k, T).optional(),',
      '}).strict();',
    ].join('\n');
    assert.equal(propertyEnumerationsIn(before).length, 1, 'the detector does not see the shape it exists for');
  });

  it('and does NOT flag a deliberately different set', () => {
    // `RefKind` is entity/memory/chrono/file — four names, three of them shared, and a different set on
    // purpose. Flagging it would make the way to quieten this gate be to widen a set that is correct.
    const refKindShaped = 'const COLLECTION_FOR = { entity: \'entities\', fact: \'memories\', chrono: \'chrono\', file: \'files\' };';
    assert.deepEqual(propertyEnumerationsIn(refKindShaped), []);
  });

  it('no file re-enumerates them as property names either', () => {
    const offenders = [];
    for (const f of sourceFiles()) {
      if (DECLARATIONS.includes(f)) continue;
      for (const h of propertyEnumerationsIn(readFileSync(f, 'utf8'))) {
        offenders.push(`${f} — ${h.slice(0, 72)}`);
      }
    }
    assert.deepEqual(offenders, [],
      `${offenders.length} site(s) write the knowledge types out as OBJECT KEYS:\n`
      + offenders.map(o => `  ${o}`).join('\n')
      + '\n\nBuild the shape from KNOWLEDGE_TYPES instead. A `.strict()` schema keyed this way is the only'
      + '\nthing that can refuse one of these names, which makes a copy there the authority on the answer.');
  });
  it('and each declaration file actually declares it, so the exemption is not a hole', () => {
    // An exemption that names a file which no longer declares anything would quietly let that whole file
    // re-enumerate. The point of the list is one definition, not two blessed files.
    for (const f of DECLARATIONS) {
      const clean = stripComments(readFileSync(f, 'utf8'));
      assert.match(
        clean,
        /KNOWLEDGE_TYPES\s*=/,
        `${f} is exempt from the rule above because it is meant to be the declaration — so it has to hold a `
        + '`KNOWLEDGE_TYPES` tuple. Without one, the exemption is just a file where copies are allowed.',
      );
    }
  });
});
