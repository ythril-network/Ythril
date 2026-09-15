/**
 * `recall`'s tool schema documents its RESPONSE, not only its parameters.
 *
 * ## The standard this is the first instance of
 *
 * Owner, 2026-08-15, supplying a fully-written `recall` schema as the template: *"each endpoint should have a
 * descriptions like: … else its really hard to discover the right options."* X-2 is rolling that across ~40
 * tools; this file gates the properties that make it a standard rather than more prose, on the one tool that
 * has been done.
 *
 * ## Why the response half is the half that was missing
 *
 * Every parameter had a description already. Nothing described what came back — so `truncated` and `complete`
 * were undocumented on the surface an agent reads while writing the call, and the failure mode is silent:
 * the inline answer is capped by SIZE and it is a cliff, not a slope. Around 25 results answer in full and 30
 * can come back as three. A caller asking for topK 80 and reading only `results` is working from a handful
 * of records with no error anywhere. Three flows in the fleet were doing exactly that.
 *
 * `help()` tells callers the tool schema IS the authoritative reference, and CLAUDE.md records what a stale
 * sentence there already cost: The fleet integrator read *"filter applied after vector search"*, believed it, and built a
 * skill that avoided filtered recall.
 *
 * ## What is asserted
 *
 * Not prose quality — the specific facts a caller cannot recover by experiment without being misled. Each of
 * these was either absent or, in the `types` case, absent in a way that made a real result look like a bug.
 *
 * Run: node --test testing/standalone/search-tool-schemas-document-their-response.test.js
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const { budgetFields } = await import('../../server/dist/brain/result-budget.js');

/**
 * Every accounting field a budgeted answer carries, taken from the function that emits them.
 *
 * Called rather than parsed. A regex over the return object would be a second reading of the same thing,
 * and `truncated: true` here is what makes `nextSkip` appear — a hand-written list would have had to know
 * that, and this does not.
 */
const BUDGET_FIELDS = Object.keys(budgetFields(
  { returned: [], truncated: true, charsReturned: 0, bytesReturned: 0, remainder: [] },
  0,
  { chars: 1, bytes: null },
  0,
));

const SRC = readFileSync('server/src/mcp/tools/search.ts', 'utf8');
/** The `recall` tool object: from its name to the next tool's, so a later tool cannot satisfy these. */
const RECALL = (() => {
  const at = SRC.indexOf("name: 'recall'");
  assert.ok(at > 0, "the recall tool was not found — the scanner is wrong, not the code");
  const next = SRC.indexOf("name: '", at + 20);
  return next === -1 ? SRC.slice(at) : SRC.slice(at, next);
})();

describe('the response is documented, not just the request', () => {
  it('warns that the inline answer is capped and names the flag to read', () => {
    /*
     * The silent failure: asking for 80 and getting a handful, with no error. A caller has to know to look.
     *
     * ## Both assertions here used to pass no matter what the schema said
     *
     * `assert.match(RECALL, /complete/)` demanded a response field called `complete`. There is no such field
     * — the envelope has never had one since the record cap became a byte budget, and the spill is
     * `remainder`, written only when the caller opts in. The assertion passed anyway, on the word `complete`
     * appearing in `its complete _graph` and in `graphComplete`. It was checking English, not a contract.
     *
     * `assert.match(RECALL, /cliff|capped by SIZE|not by count/i)` asked, in its own message, for *"a size
     * cliff rather than a gentle limit"*. The schema now says **"it is a slope now rather than a cliff"** —
     * the opposite claim, and it contains the word `cliff`, so the assertion was satisfied by the text
     * contradicting it.
     *
     * A gate nobody has watched fail is a gate whose subject you have not confirmed, and these two had
     * stopped having a subject at all.
     *
     * ## So the field names are DERIVED, by calling the function that emits them
     *
     * Not a hand-written list. A list is what rotted: this file was written when `complete` was real, and
     * nothing told it when that stopped. `budgetFields` builds the envelope, so its own return value is the
     * authoritative set, and a field added or renamed there arrives here without anyone remembering to.
     */
    for (const field of BUDGET_FIELDS) {
      assert.ok(RECALL.includes(field), `\`${field}\` is in every recall response and the schema never `
        + `names it — derived from budgetFields(), so this list cannot go stale the way the last one did`);
    }
    // Conditional, and set outside `budgetFields`, so it cannot come from the same derivation.
    assert.ok(RECALL.includes('remainder'),
      'the opt-in spill file is `remainder`; a caller who does not know its name cannot ask for it');
    assert.match(RECALL, /slope/i,
      'the budget is a byte slope with a stated continuation, not the record cliff it replaced — and the '
      + 'assertion that used to be here accepted the word `cliff` from a sentence denying it');
  });

  it('says `count` excludes traversed nodes', () => {
    // ADJACENCY CLAIM, not a window: `[^.]` cannot cross a full stop, so this asserts the two words are in ONE
    // SENTENCE. The 80 is a belt on top of that bound, and the sentence is the rule — a schema that mentions
    // `count` in one paragraph and MATCHES three paragraphs later has not told the caller anything.
    assert.match(RECALL, /count[^.]{0,80}MATCHES/,
      '`count` counts matches; a caller comparing it to `graphNodes` needs to know that');
  });

  it('says `graphNodes` is a number and `_graph` is the content', () => {
    assert.match(RECALL, /graphNodes/, '`graphNodes` must be named');
    assert.match(RECALL, /no `_graph`|has no `_graph`/,
      'a result with no edges has NO `_graph` — reading results[0] and concluding the feature is missing is the trap');
  });
});

/** The `query` tool object, scoped the same way. */
const QUERY = (() => {
  const at = SRC.indexOf("name: 'filter'");
  assert.ok(at > 0, 'the filter tool was not found — the scanner is wrong, not the code');
  const next = SRC.indexOf("name: '", at + 20);
  return next === -1 ? SRC.slice(at) : SRC.slice(at, next);
})();

describe('query says what it is FOR and what comes back', () => {
  it('positions it against recall rather than describing it in isolation', () => {
    // "Run a structured read-only query" told a caller what it does and never when to choose it. The pairing
    // is the discoverable fact: a predicate versus a ranking.
    assert.match(QUERY, /counterpart to `recall`/, 'say which tool it is the opposite of');
    assert.match(QUERY, /no embedding, no ranking, no score/,
      'name what it does NOT do — that is the choice a caller is making');
  });

  it('says count is the page and total is the filter', () => {
    // The difference between them is the only signal that more rows exist. A full page is not evidence of
    // being the last one, and nothing said so.
    //
    // ADJACENCY CLAIMS, both of them: `[^.]` cannot cross a full stop, so each asserts a field and its meaning
    // sit in ONE SENTENCE. That IS the requirement — the two fields differ by one word and a caller who has to
    // assemble the distinction from separate paragraphs will not.
    assert.match(QUERY, /`count`[^.]{0,120}THIS page/, '`count` is this page');
    assert.match(QUERY, /`total`[^.]{0,120}overall/, '`total` is the whole filter');
  });

  it('warns that a count with no rows means a pre-3.1 instance', () => {
    // The defect the canary operator reported and I reproduced: rows in `content` only, so a client preferring
    // `structuredContent` saw the metadata and no results. Fixed in #911 — but an agent talking to an older
    // instance needs to recognise the shape rather than conclude the space is empty.
    assert.match(QUERY, /count with no rows is a BUG/i,
      'an empty page and a dropped payload look identical without this sentence');
    assert.match(QUERY, /structuredContent/, 'name the field, since that is what a client branches on');
  });

  it('says it reaches records recall cannot', () => {
    assert.match(QUERY, /retired from semantic ranking/,
      'a record with no vector is exactly what a structured read is for');
  });
});

/** The `similar` tool object, scoped the same way. */
const FIND_SIMILAR = (() => {
  const at = SRC.indexOf("name: 'similar'");
  assert.ok(at > 0, 'the similar tool was not found — the scanner is wrong, not the code');
  const next = SRC.indexOf("name: '", at + 20);
  return next === -1 ? SRC.slice(at) : SRC.slice(at, next);
})();

describe('similar documents the SAME envelope, because it returns the same one', () => {
  /*
   * This scanner was scoped to `recall` alone, and that is how `similar` came to promise a `complete`
   * field years after the field stopped existing: the gate for "the schema documents its response" only ever
   * looked at one of the two tools that share the response.
   *
   * A caller reading `similar` was told to wait for `complete` holding {path, download, expiresAt} for
   * the full set. Nothing emits that. They never set `remainderDump`, so no spill was written either, and
   * they never learned `nextSkip` exists — three ways to reach the rest of the answer, and the documented
   * one was the one that does not work.
   */
  it('names every accounting field it actually returns', () => {
    for (const field of BUDGET_FIELDS) {
      assert.ok(FIND_SIMILAR.includes(field),
        `\`${field}\` is in every similar response and the schema never names it`);
    }
  });

  it('and does NOT promise a `complete` field, because there is no such field', () => {
    /*
     * The CLAIM is what is forbidden, not the word — and the difference is the whole reason the old
     * assertion here was vacuous. `/complete/` matched `graphComplete` and `its complete _graph`, so it
     * passed on prose while the actual promise sat two clauses away.
     *
     * The corrected paragraph deliberately still says `complete` ONCE, to tell a caller who built against
     * the old text that the field is gone — the same service `maxBytes`'s "CHANGED MEANING IN 3.7" note
     * performs. An assertion banning the word would forbid that, so it bans the two shapes the promise took.
     */
    assert.doesNotMatch(FIND_SIMILAR, /`truncated` \+ `complete`/,
      'the schema still pairs `truncated` with a `complete` field; the pair is `truncated` and `nextSkip`');
    assert.doesNotMatch(FIND_SIMILAR, /`complete` holding/,
      'the schema still says `complete` HOLDS the full set. Nothing emits it — the spill is `remainder`, '
      + 'and only when the caller asks with `remainderDump: true`');
  });

  it('a source entry with no vector cannot be similar to anything', () => {
    // The failure that looks like a fact: an empty answer reads as "nothing resembles this", when the real
    // cause is that the SOURCE was retired from ranking and has no embedding to compare from.
    assert.match(FIND_SIMILAR, /retired from semantic ranking/,
      'an empty answer from a vector-less source must not read as "nothing is similar"');
  });

  it('says there is no includeFreshWrites here, and why', () => {
    assert.match(FIND_SIMILAR, /includeFreshWrites/,
      "a caller who knows recall's escape hatch will look for it here");
    assert.match(FIND_SIMILAR, /has to exist before this can start/,
      'say why it cannot exist rather than leaving its absence to be discovered');
  });

  it('says minScore means something DIFFERENT here than on recall', () => {
    // Same parameter name, same units, different job: on recall it gates before the reranker; here cosine is
    // the only ranking, so it is the relevance gate itself.
    assert.match(FIND_SIMILAR, /this IS the relevance gate/,
      'the same parameter behaving differently across two tools is exactly what a schema must say');
  });

  it('distinguishes the source type from the target types', () => {
    assert.match(FIND_SIMILAR, /It does not constrain what comes back/,
      '`entryType` resolves the id; `targetTypes` filters the answer, and conflating them is the obvious error');
  });
});

describe('the parameters carry their traps', () => {
  it('types: edges are searchable records and compete for topK', () => {
    assert.match(RECALL, /EDGES ARE SEARCHABLE RECORDS/,
      'a topK 20 returning 2 edges looks like a bug until you know this');
  });

  it('query: it is tokenised for BM25 as well as embedded', () => {
    assert.match(RECALL, /TOKENISED/,
      'this is why an exact identifier survives a query written as a sentence');
  });

  it('topK: it is filled from records that SATISFY the filter', () => {
    assert.match(RECALL, /SATISFY/,
      'a filtered recall cannot silently miss a match — the opposite belief is what made the fleet integrator avoid filters');
  });

  it('minScore: it gates on the vector score only, before the reranker', () => {
    assert.match(RECALL, /vector-side gate/,
      'it is not a relevance gate, and a result the reranker would promote can be cut before it is seen');
  });
});
