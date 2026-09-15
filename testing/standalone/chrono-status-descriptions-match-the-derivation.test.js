/**
 * What the chrono tools SAY about `status` agrees with what `deriveChronoStatus` DOES.
 *
 * ## The defect this pins
 *
 * Four MCP tool descriptions carried a capitalised warning that was the opposite of the code:
 *
 * > "NOTHING RECOMPUTES `status` FROM THE CLOCK. An entry stays `upcoming` after its date has passed until
 * > something sets it otherwise, so `status: "upcoming"` means "nobody has updated this", not "still in the
 * > future", and `status: "overdue"` only finds entries somebody marked overdue. Filter on the dates if you
 * > want the truth about time."
 *
 * Every clause is false. `overdue` is DERIVED on read (`brain/chrono-status.ts`, C5) and applied on every
 * chrono read path; `listChrono` translates the filter, so `status: "overdue"` finds exactly the derived ones
 * and `status: "upcoming"` EXCLUDES them. The paragraph therefore steered a caller away from the one filter
 * that answers the question, toward a date predicate it did not need.
 *
 * `docs/integration-guide/04c-chrono-api.md` described it CORRECTLY the whole time. Two surfaces, one
 * behaviour, two contradictory descriptions — and the wrong one was the one an agent reads while
 * constructing arguments. That is the exact cost CLAUDE.md records for a stale schema sentence.
 *
 * ## Why this asserts against the function, not against the docs
 *
 * A gate that only refuses the old wording is a spelling check: it goes green the moment somebody rephrases
 * the same wrong claim. So the derivation is EXERCISED here — it is a pure function with no database — and
 * the sentences are held to what it returns.
 *
 * Run: node --test testing/standalone/chrono-status-descriptions-match-the-derivation.test.js
 * (requires a prior `npm run build` in server/)
 */
import { describe, it, before } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { stripComments } from './_strip-comments.mjs';
import { statementAround, bodyOf } from './_structural-window.mjs';
import { blockAfter } from './_structural-window.mjs';

let deriveChronoStatus, ALL_TOOLS;
before(async () => {
  ({ deriveChronoStatus } = await import('../../server/dist/brain/chrono-status.js'));
  ({ ALL_TOOLS } = await import('../../server/dist/mcp/tools/index.js'));
});

/** The space fragments the router injects; only their presence matters here. */
const STUB = {
  requiredSpace: { type: 'string', description: 'Space ID to operate on.' },
  optionalSpace: { type: 'string', description: 'Optional space ID.' },
};

const NOW = new Date('2026-08-16T12:00:00Z');
const PAST = '2026-01-01T00:00:00Z';
const FUTURE = '2027-01-01T00:00:00Z';

describe('what the code actually does', () => {
  it('a past-due upcoming entry reads back as overdue — nobody marks it', () => {
    assert.equal(deriveChronoStatus({ status: 'upcoming', startsAt: PAST }, NOW), 'overdue');
    assert.equal(deriveChronoStatus({ status: 'active', startsAt: PAST }, NOW), 'overdue');
  });

  it('the due moment is endsAt when there is one, startsAt otherwise', () => {
    // An event that started last month and runs until next year is NOT overdue. Reading only `startsAt`
    // would call every in-progress entry late, which is the opposite error.
    assert.equal(deriveChronoStatus({ status: 'active', startsAt: PAST, endsAt: FUTURE }, NOW), 'active');
    assert.equal(deriveChronoStatus({ status: 'upcoming', startsAt: FUTURE }, NOW), 'upcoming');
  });

  it('completed and cancelled are never re-derived', () => {
    assert.equal(deriveChronoStatus({ status: 'completed', startsAt: PAST }, NOW), 'completed');
    assert.equal(deriveChronoStatus({ status: 'cancelled', startsAt: PAST }, NOW), 'cancelled');
  });

  it('and a hand-stored `overdue` is passed straight through', () => {
    // Which is why storing it is a bad idea: the `listChrono` filter looks for stored `upcoming`/`active`,
    // so this record is invisible to `status: "overdue"`. The descriptions now say so by name.
    assert.equal(deriveChronoStatus({ status: 'overdue', startsAt: FUTURE }, NOW), 'overdue');
  });
});

describe('every chrono read path applies it, which is what makes the sentences true', () => {
  const src = () => stripComments(readFileSync('server/src/brain/chrono.ts', 'utf8'));

  it('a single-entry get derives', () => {
    // A WINDOW, converted: the subject is the function, and 300 characters was a guess at how much of it fits.
    assert.match(bodyOf(src(), 'getChronoById'), /withDerivedStatus/,
      'the tools say a get reads back overdue');
  });

  it('a list derives its OUTPUT as well as translating its filter', () => {
    // The filter's own construction is exercised in `chrono-list-filter-composes.test.js` against
    // `buildChronoQuery`, which is why the source reads here are only about the parts that function does not
    // return: that the OUTPUT is derived too, and that the translation lives in `listChrono` at all.
    //
    // The `{0,200}` bounds below were written as character counts before that lesson landed. They are
    // POSITIVE assertions, so a window that spans fewer lines fails loudly rather than passing quietly —
    // but the statement bound is right either way and costs nothing.
    const s = src();
    assert.match(s, /entries\.map\(e => withDerivedStatus\(e, now\)\)/,
      'translating the filter alone would return rows whose status contradicts the filter that found them');

    const at = s.indexOf("filter.status === 'overdue'");
    assert.ok(at > 0, 'the overdue branch was not found — the scanner is wrong, not the code');
    const branch = s.slice(at, s.indexOf('} else if', at));
    assert.match(branch, /\$in: \['upcoming', 'active'\]/,
      '`status: "overdue"` must be TRANSLATED — the derivable entries are found by comparing the clock');
    assert.match(branch, /status: 'overdue'/,
      'and it must ALSO match a stored `overdue` (CH-1) — the tools now promise both kinds');

    const upAt = s.indexOf("filter.status === 'upcoming' || filter.status === 'active'");
    assert.ok(upAt > 0, 'the upcoming/active branch was not found');
    /*
     * `blockAfter`, not "up to the next `} else`". That literal was the bound, and `F-26` nested an `if`
     * inside this branch — so the window closed on the INNER `} else` and stopped containing the `$gte` it
     * exists to find, failing on code that does exactly what it asks. A window bounded by a token that can
     * appear inside its own subject is a character count wearing structure's clothes.
     */
    assert.match(blockAfter(s, upAt, 'the upcoming/active branch'), /\$gte/,
      '`upcoming`/`active` must EXCLUDE the now-overdue ones — the tools promise both directions');
  });

  it('recall derives too', () => {
    assert.match(stripComments(readFileSync('server/src/brain/recall.ts', 'utf8')), /status: deriveChronoStatus\(/,
      'recall presents a chrono hit\'s status, and `update_chrono` names it as one of the deriving paths');
  });

  it('but `query` does NOT — which the tools now state as a difference', () => {
    // If query ever starts deriving, "the same records, two answers" becomes false and the sentence
    // pointing a caller at `list_chrono` for status stops being advice.
    assert.doesNotMatch(stripComments(readFileSync('server/src/brain/query.ts', 'utf8')), /deriveChronoStatus/,
      'query reads documents as stored; that contrast is now written into three tool descriptions');
  });
});

describe('no tool repeats the claim that was false', () => {
  it('nothing says the clock is ignored', () => {
    // CASE-INSENSITIVE, and that is not a detail: the sentence being refused was CAPITALISED in three of the
    // four tools, and the first draft of this pattern was `/[Nn]othing recomputes/`. Restoring the exact
    // paragraph this gate exists to refuse left it green. Its own mutation check is what said so.
    // Whole-body, not description-only, for the same reason — on `save_chrono` the claim lived in the
    // parameter schema rather than in the prose.
    /*
     * EVERY `{0,N}` in this list is an ADJACENCY CLAIM, and they stay.
     *
     * These patterns refuse a SENTENCE that was written and was false. The gap exists because the sentence
     * appeared with small variations — "nothing recomputes `status`" and "nothing recomputes the status" — and
     * the number is how many characters of variation are tolerated between two fixed words. Widen it and the
     * pattern starts matching prose that merely contains both words far apart, which is how a refusal turns
     * into a false positive on a description that is now correct.
     *
     * The one WINDOW in this file — a function body behind `{0,300}` — is converted above. These are not that.
     */
    const BAD = [
      [/nothing recomputes[\s\S]{0,20}status/i, 'nothing recomputes'],
      [/only finds entries somebody marked overdue/i, 'somebody marked overdue'],
      [/stays `upcoming` after its date (has )?passed/i, 'stays upcoming'],
    ];
    const offenders = [];
    for (const t of ALL_TOOLS) {
      const text = (t.description ?? '') + JSON.stringify(t.inputSchema(STUB));
      for (const [re, label] of BAD) if (re.test(text)) offenders.push(`${t.name}: "${label}"`);
    }
    assert.deepEqual(offenders, [],
      'these describe the opposite of `deriveChronoStatus`:\n  ' + offenders.join('\n  '));
  });

  it('and the pattern really matches the paragraph it exists to refuse', () => {
    // Mutation-proof for the regex. A gate that misses its own subject reports clean, which is worse than
    // having no gate: the wrong sentence then looks reviewed.
    const ORIGINAL = 'NOTHING RECOMPUTES `status` FROM THE CLOCK. An entry stays `upcoming` after its date '
      + 'has passed until something sets it otherwise, so `status: "upcoming"` means "nobody has updated '
      + 'this", and `status: "overdue"` only finds entries somebody marked overdue.';
    assert.match(ORIGINAL, /nothing recomputes[\s\S]{0,20}status/i);
    assert.match(ORIGINAL, /only finds entries somebody marked overdue/i);
    assert.match(ORIGINAL, /stays `upcoming` after its date (has )?passed/i);
    // And not the corrected wording, or the gate can never go green.
    const CORRECTED = '`overdue` IS DERIVED FROM THE CLOCK, AND IS NEVER STORED. An entry whose due moment '
      + 'has passed and that is still `upcoming`/`active` is RETURNED as `overdue`.';
    for (const [re] of [[/nothing recomputes[\s\S]{0,20}status/i], [/only finds entries somebody marked overdue/i], [/stays `upcoming` after its date (has )?passed/i]]) {
      assert.doesNotMatch(CORRECTED, re);
    }
  });

  it('nor that a stored `overdue` is invisible — CH-1 is fixed, so that sentence would be the next stale one', () => {
    // These descriptions NAMED the defect while it stood, which was right. Leaving them naming it after the
    // filter was fixed is the same failure the whole suite is about, one release later — and the sentence
    // reads as authoritative either way. The filter's own behaviour is proved in
    // `chrono-list-filter-composes.test.js`; this only holds the prose to it.
    const BAD = [
      [/stored as `overdue`[\s\S]{0,40}(invisible|not matched|missed)/i, 'stored overdue is invisible'],
      [/looks for the derivable ones/i, 'only the derivable ones'],
    ];
    const offenders = [];
    for (const t of ALL_TOOLS) {
      const text = (t.description ?? '') + JSON.stringify(t.inputSchema(STUB));
      for (const [re, label] of BAD) if (re.test(text)) offenders.push(`${t.name}: "${label}"`);
    }
    assert.deepEqual(offenders, [], 'these still describe CH-1 as open:\n  ' + offenders.join('\n  '));
  });

  it('nor that an out-of-order endsAt is refused, because nothing checks it', () => {
    // `update_chrono` said "`endsAt` before `startsAt` is refused". Nothing anywhere implements that: the
    // REST route validates `startsAt`'s presence and type, `validateChrono` never looks at either field,
    // and no test pinned a refusal. So a caller relying on it stored an entry whose `endsAt` precedes its
    // `startsAt` — which then reads as `overdue` at once, because `endsAt` becomes the due moment.
    //
    // Third false claim found in this one area, and the pattern in all three is the same: a confident
    // sentence about a check that does not exist.
    const offenders = [];
    for (const t of ALL_TOOLS) {
      const text = (t.description ?? '') + JSON.stringify(t.inputSchema(STUB));
      if (/endsAt[^.]{0,40}(is )?refused/i.test(text)) offenders.push(t.name);
    }
    assert.deepEqual(offenders, [],
      'these promise an ordering check the code does not perform:\n  ' + offenders.join('\n  '));

    // And the code really does not perform one — asserted rather than assumed, so this gate flips the day
    // somebody adds the validation instead of quietly forbidding the truthful sentence for ever.
    const routes = stripComments(readFileSync('server/src/api/brain/chrono.ts', 'utf8'));
    const validation = stripComments(readFileSync('server/src/spaces/schema-validation.ts', 'utf8'));
    for (const [name, src] of [['the REST route', routes], ['schema validation', validation]]) {
      /*
       * Per STATEMENT, with no cap at all.
       *
       * A comparison and both its operands live in one statement, so the statement is the bound. The `{0,60}` /
       * `{0,20}` gaps this replaces were trying to say "close together" as a proxy for exactly that, and a
       * formatted multi-line condition already exceeded them — so the absence they asserted would have been
       * satisfied by a comparison written across three lines.
       *
       * Getting here found two real bugs in the helper, both of which only a caller could have surfaced. The
       * enclosing BLOCK was tried first and over-reported — a whole route handler contains both names and some
       * unrelated `<`. Narrowing to the statement then failed, because `statementFrom` demanded a terminator at
       * relative depth exactly 0 and so refused every anchor mid-expression. And once that was fixed it failed
       * again, on `'endsAt'` as a quoted FIELD NAME in a list: a walk that starts inside a string reads the string's
       * own closing quote as an opening one. `statementAround` resolves the statement's start from the top of the
       * file, where quote parity is known.
       */
      const compared = [...src.matchAll(/\bendsAt\b/g)]
        .map(m => statementAround(src, m.index, name))
        /*
         * `=>` is not a comparison, and the naive `[<>]=?` says it is.
         *
         * A callback anywhere in the statement — `onValidation: c => { … }`, added when the schema check moved
         * inside the writer — put a `>` in a statement that also names both fields, and this reported the
         * route as comparing them. Stripping arrows first is the narrow fix; widening the window or dropping
         * the operator test would have been the appeasing one.
         */
        .filter(stmt => /\bstartsAt\b/.test(stmt) && /[<>]=?/.test(stmt.replace(/=>/g, '')));
      assert.deepEqual(compared, [],
        `${name} now compares the two — the descriptions may say it is refused, and should`);
    }
  });

  it('and `list_chrono` says the filter returns BOTH kinds', () => {
    const t = ALL_TOOLS.find(x => x.name === 'list_chrono');
    const text = (t.description ?? '') + JSON.stringify(t.inputSchema(STUB));
    assert.match(text, /BOTH kinds|ALSO RETURNS AN ENTRY SOMEBODY STORED/,
      'a caller who reads only "derived from the clock" would still not know a marked entry comes back');
  });

  it('and the four tools that discuss status say it is derived', () => {
    // Presence, not spelling: each of these had a wrong paragraph, so each must now carry the right one.
    // Checked across the description AND the schema, because on `save_chrono` the correction lives in the
    // parameter rather than in the prose.
    for (const name of ['save_chrono', 'update_chrono', 'list_chrono', 'delete_chrono']) {
      const t = ALL_TOOLS.find(x => x.name === name);
      const text = (t.description ?? '') + JSON.stringify(t.inputSchema(STUB));
      assert.match(text, /derive[ds]?/i, `${name} must tell a caller that overdue is derived`);
    }
  });
});
