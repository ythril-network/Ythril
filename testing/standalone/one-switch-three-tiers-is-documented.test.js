/**
 * `suppressEmbeddings` is ONE switch at three tiers, under ONE name, and both doors say so.
 *
 * ## X-1, in two halves
 *
 * Owner, 2026-08-15: *"excludefromvector does also exclude from recalls traversal? ambigous and i want
 * entries to be findable via traversal even if they are not embedded themselves."*
 *
 * The behaviour was already right — recall's `traverse` expansion walks EDGES and never consults a vector,
 * so a suppressed record is reached exactly as before. What was wrong is the vocabulary, in two ways that a
 * caller pays for:
 *
 * 1. **Two names for one mechanism.** The per-record flag was `excludeFromVectorSearch` while a type schema
 *    and the space both called it `suppressEmbeddings`; `embeddingSuppressed` resolves `record > schema >
 *    space` between them. Nothing in the record-level name hinted the other two existed, so a record with no
 *    vector and no flag set read as a bug. X-1a (#961) documented the tiers; X-1b renamed the record tier so
 *    there is one name to find, and this file gates both halves.
 * 2. **`false` is "not stated", not "do embed".** A stored `false` maps to `undefined`, so it FALLS THROUGH
 *    to the tiers below rather than overriding them. Sending `false` on a record whose type or space
 *    suppresses embedding succeeds and changes nothing — and the MCP schema said, in as many words, "or
 *    return it to it (false)".
 *
 * ## Exercised, not grepped
 *
 * `embeddingSuppressed` and `recordSuppression` are pure, so the tier rules below are real calls. The
 * description assertions are held to what those calls return rather than to a phrasing — four gates in one
 * week were found pinning a sentence instead of a rule, and two of the four were pinning one that was false.
 * The `false`-falls-through rule used to be gated by a regex over `embed-record.ts`; it is now the behaviour
 * of `recordSuppression` plus the fact that the embed path defers to it, which is what the regex was trying
 * to approximate.
 *
 * Run: node --test testing/standalone/one-switch-three-tiers-is-documented.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import { trackedSources } from './_sources.mjs';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';

let embeddingSuppressed, recordSuppression, parseRecordSuppression;
let recordNotSuppressedFilter, SUPPRESS_EMBEDDINGS_SCHEMA;
before(async () => {
  ({
    embeddingSuppressed, recordSuppression, parseRecordSuppression,
    recordNotSuppressedFilter,
  } = await import('../../server/dist/brain/suppress-embeddings.js'));
  ({ SUPPRESS_EMBEDDINGS_SCHEMA } = await import('../../server/dist/mcp/tools/shared.js'));
});

const DESC = () => SUPPRESS_EMBEDDINGS_SCHEMA.description;

describe('the resolver really is one switch at three tiers', () => {
  it('record wins over both', () => {
    assert.equal(embeddingSuppressed({ record: true, schema: { suppressEmbeddings: false }, space: false }), true);
    assert.equal(embeddingSuppressed({ record: false, schema: { suppressEmbeddings: true }, space: true }), false,
      'an explicitly stored `false` at the record tier does override — the falling-through case is a SEPARATE '
      + 'mapping in `recordSuppression`, asserted below');
  });

  it('schema wins over space', () => {
    assert.equal(embeddingSuppressed({ schema: { suppressEmbeddings: true }, space: false }), true);
    assert.equal(embeddingSuppressed({ schema: { suppressEmbeddings: false }, space: true }), false);
  });

  it('and "not stated" falls through rather than counting as false', () => {
    // Reading absent as `false` would make the space-wide switch do nothing for any type that had a schema
    // at all, which is every type worth suppressing.
    assert.equal(embeddingSuppressed({ space: true }), true, 'no record flag, no schema → the space decides');
    assert.equal(embeddingSuppressed({ schema: {}, space: true }), true, 'a schema that says nothing is not a "no"');
    assert.equal(embeddingSuppressed({}), false, 'and nothing anywhere means embed');
  });
});

describe('`false` at the record tier never reaches the resolver as `false`', () => {
  it('a stored false arrives as "not stated", under either spelling', () => {
    // This is the whole of the trap, and it now lives in one function instead of being spelled inline at
    // each reader. Asserted by calling it: a regex over the call site could only ever check one caller.
    assert.equal(recordSuppression({ suppressEmbeddings: false }), undefined,
      'if this becomes a plain read, the docs saying `false` cannot un-suppress stop being true');
    assert.equal(recordSuppression({ excludeFromVectorSearch: false }), undefined);
    assert.equal(recordSuppression({ suppressEmbeddings: true }), true);
    assert.equal(recordSuppression({}), undefined);
    assert.equal(recordSuppression(undefined), undefined);
  });

  it('and every reader of the record tier goes through it', () => {
    /*
     * The rule was written out by hand at both readers before X-1b, which is the shape this repo produces
     * most: one rule, two implementations, and the weaker one winning silently.
     *
     * **DERIVED from who CALLS the resolver, because "every reader" is the claim.** It named two files, and
     * a third written afterwards would have been outside everything this gate read while the title went on
     * covering all of them — the `Q-6` shape, 2026-09-07. Now the set is whoever calls `embeddingSuppressed`
     * with an object literal, which is the only way to be a reader of the record tier at all.
     *
     * Bounded by the call's own closing brace rather than by a character count — a count spans different
     * lines on CRLF than on LF.
     *
     * `suppress-embeddings.ts` rather than `embed-record.ts`: the resolution moved there when the creators
     * needed it too, because `embed-record.ts` imports `edges.ts` and holding the helper there put six brain
     * modules in a runtime import cycle. The invariant is unchanged and the module that owns
     * `recordSuppression` is the honest home for it.
     */
    const files = trackedSources('server/src');

    const readers = [];
    for (const file of files) {
      const src = stripComments(readFileSync(file, 'utf8'));
      let at = src.indexOf('embeddingSuppressed({');
      while (at > 0) {
        readers.push({ file, call: src.slice(at, src.indexOf('})', at)) });
        at = src.indexOf('embeddingSuppressed({', at + 1);
      }
    }
    // A FLOOR: a scanner that finds nothing passes every loop written over it, and this assertion would
    // then report "every reader is correct" about no readers at all.
    assert.ok(readers.length >= 2,
      `found ${readers.length} reader(s) of the record tier; the two known ones are the minimum, so the scan is wrong`);

    for (const { file, call } of readers) {
      assert.match(call, /record:\s*recordSuppression\(/,
        `${file} builds the record tier itself instead of asking recordSuppression, so the two readers can `
        + 'disagree about what a stored `false` means — which is the whole of the trap this helper exists for');
    }
  });

  it('so the description must NOT promise that false re-embeds unconditionally', () => {
    assert.doesNotMatch(DESC(), /or return it to it \(false\)/i,
      'the sentence that was wrong: false falls through, it does not override');
    assert.match(DESC(), /not stated/i, 'say what false actually means');
    assert.match(DESC(), /cannot/i, 'and that it cannot re-embed a suppressed type or space');
  });
});

/*
 * ── THE LEGACY-SPELLING BLOCK STOOD HERE and went with `D-6` in 4.0 ─────────────────────────────
 *
 * Five cases covered `excludeFromVectorSearch`: that the new spelling won when a record carried both,
 * that the old one was still honoured alone, that a write mirrored onto it in BOTH directions, that
 * either spelling was accepted as input, and that a sweep excluded records suppressed under either.
 *
 * All five described a pair of names, and there is one name now. They are DELETED rather than inverted:
 * `the-legacy-suppression-spelling-is-gone.test.js` asserts the removal across every server source, both
 * doors and the release gate, and restating a piece of it here would be the same rule in two places —
 * which is what this repo's most expensive defect is made of.
 *
 * The two properties that were NOT about the pair survive below, because they are about the tier itself
 * and would have been lost with the block: a non-boolean is refused identically on both doors, and the
 * not-suppressed filter is a `$ne` rather than an `$exists`.
 */
describe('the record tier, now that it has one name', () => {
  it('refuses a non-boolean identically on both doors', () => {
    /*
     * The half worth keeping from the old input-alias case. MCP used to DROP a string silently while REST
     * answered 400 — the same rule with two implementations, and the weaker one winning. One parser now,
     * so the two cannot disagree.
     */
    assert.deepEqual(parseRecordSuppression({ suppressEmbeddings: true }), { ok: true, value: true });
    assert.deepEqual(parseRecordSuppression({ suppressEmbeddings: false }), { ok: true, value: false });
    assert.deepEqual(parseRecordSuppression({}), { ok: true, value: undefined });
    assert.deepEqual(parseRecordSuppression(undefined), { ok: true, value: undefined });
    assert.equal(parseRecordSuppression({ suppressEmbeddings: 'true' }).ok, false,
      'a string must be a refusal on both doors');
  });

  it('and the old spelling is no longer an input alias', () => {
    // Not a duplicate of the removal gate: that one reads SOURCES, this one exercises the parser. A
    // caller sending the retired name must get nothing back, not a silently accepted value.
    assert.deepEqual(parseRecordSuppression({ excludeFromVectorSearch: true }),
      { ok: true, value: undefined },
      'the retired spelling is still read as input, so a caller is told 201 for a field nothing applies');
  });

  it('the not-suppressed filter is a $ne, and names one key', () => {
    /*
     * `$ne` rather than `$exists`, because a record that has never carried the field must COUNT as not
     * suppressed — an `$exists` filter would sweep only records somebody had explicitly un-suppressed.
     */
    assert.deepEqual(recordNotSuppressedFilter(), { suppressEmbeddings: { $ne: true } });
  });

  it('a stored false is not a suppression, and not a statement either', () => {
    // `recordSuppression` returns `true | undefined` and never `false`: at this tier a `false` means "not
    // stated" and must fall THROUGH to the schema and space tiers rather than overriding them.
    assert.equal(recordSuppression({ suppressEmbeddings: true }), true);
    assert.equal(recordSuppression({ suppressEmbeddings: false }), undefined);
    assert.equal(recordSuppression({}), undefined);
  });
});
describe('both doors name the one tier name', () => {
  it('the MCP schema names all three tiers and the resolution order', () => {
    const d = DESC();
    assert.match(d, /suppressEmbeddings/, 'the name every tier uses');
    assert.match(d, /record\s*>\s*schema\s*>\s*space/, 'and the resolution order');
    assert.doesNotMatch(d, /excludeFromVectorSearch/,
      'the old spelling is an input alias, not a name to offer — a description is what an agent constructs '
      + 'arguments from, so naming both there rebuilds the defect the rename removed');
  });

  it('and it still states the traversal answer the owner asked for', () => {
    // The question that started X-1. Losing this while renaming would be a straight regression.
    const d = DESC();
    assert.match(d, /traverse/i, 'both traversals reach a suppressed record');
    assert.match(d, /never consults a vector|edges out of a match/i, 'and WHY, which is what makes it believable');
  });

  it('the REST reference says the same, from the record side', () => {
    // `06a-schema-api.md` already said it from the SPACE side. One direction is not parity: a reader who
    // starts at the record flag never opens the schema page.
    // `04f-write-semantics.md` since A-5: the write-and-read rules moved off the memory page, because
    // they apply to every record type. Read from where the section IS — a gate left pointing at the old
    // page fails several assertions at once and reads as missing sentences rather than a moved file.
    const doc = readFileSync('docs/integration-guide/04f-write-semantics.md', 'utf8');
    assert.match(doc, /suppressEmbeddings/, 'the record-side page must name the tier');
    assert.match(doc, /record\s*>\s*schema\s*>\s*space/, 'and the order');
    assert.match(doc, /means \*not stated\*|means \*\*not stated\*\*|not stated/i, 'and the false trap');
  });

  it('and the space-side page still says it too', () => {
    const doc = readFileSync('docs/integration-guide/06a-schema-api.md', 'utf8');
    assert.match(doc, /LOWEST of three tiers/, 'that it is the bottom of three');
    assert.match(doc, /per-record `suppressEmbeddings`/,
      'and that the tier above it is spelled the same — this page named the old spelling until 3.1.0');
  });

  it('the rename is written down where an upgrader looks', () => {
    // A renamed request field that appears in no changelog is a caller debugging a 200 that did nothing.
    // Bounded by headings, not by an offset: `\n## ` lands on a different character on this CRLF working
    // copy than in CI's LF checkout, and a window that starts in the wrong place passes by reading less.
    // `[\s\S]` rather than `.` so the sections' own blank lines are inside the window.
    //
    // The window is `[Unreleased]` PLUS the newest released section, and that is the fix for this gate's
    // first version rather than a convenience. It pinned `[Unreleased]` alone, so cutting 3.1.0 — which
    // moved the entry into a dated heading, exactly as a release is supposed to — turned it red against a
    // CHANGELOG that had become MORE correct. The rule is that an upgrader searching the old spelling finds
    // it in the current notes; which heading it sits under is the release process's business, not this
    // gate's.
    /*
     * THE WHOLE CURRENT-MAJOR CHANGELOG, and that is the second correction this assertion has needed for the
     * same underlying reason: a window measured in RELEASES decays every time one is cut.
     *
     * Version one pinned `[Unreleased]` alone, and cutting 3.1.0 — which moved the entry into a dated heading,
     * exactly as a release is supposed to — turned it red against a CHANGELOG that had become more correct.
     * Version two widened to "[Unreleased] plus the newest released section", which survived one release and
     * broke on the next: cutting 3.2.0 pushed 3.1.0 into second place and the entry out of the window.
     *
     * A window of N sections is just a magic number wearing release clothes. The actual rule is the one the
     * comment above always stated — **an upgrader searching the old spelling finds it in the current notes** —
     * and `CHANGELOG.md` IS the current major series by construction: its own header says earlier majors are
     * archived under `changelog/`.
     *
     * So this holds while the old spelling is still ACCEPTED, which is the whole point of documenting it. When
     * 4.0 removes the field and this file is archived, the gate goes red and asks to be revisited — which is
     * correct, because that is the release where an upgrader stops needing to find it and starts needing to be
     * told it is gone.
     */
    const ch = readFileSync('CHANGELOG.md', 'utf8');
    assert.match(ch, /^## \[Unreleased\]$/m, 'the changelog has no [Unreleased] heading — this gate measures nothing');
    assert.match(ch, /excludeFromVectorSearch/,
      'the current-major changelog must name the OLD spelling — that is the word an upgrader searches for');
    assert.match(ch, /suppressEmbeddings/, 'and the new one');
  });
});
