/**
 * Does this extraction describe the conversation it names?
 *
 * ## The one question neither of the other two checks can answer
 *
 * `validateExtraction` reads the extraction alone — types declared, keys resolving, dates parsing, edge
 * endpoints matching their label. `mergeExtractionParts` refuses a run with a part missing. Between them
 * they catch everything except records that came from a **different conversation**, because neither one
 * holds the evidence: the file is the only thing they look at, and a spliced file is internally perfect.
 *
 * It is not hypothetical. `B-4` extracts the ten conversations in ten separate contexts, and the scratch
 * directory those contexts write their parts into turned out to be shared — one run's working file was
 * overwritten by another run's, mid-extraction, on 2026-09-20. What that produces validates, merges, writes,
 * and reports full turn coverage, because the foreign part brought its own `sessions` block along with its
 * claims. The graph is consistent and it is about somebody else.
 *
 * **A turn id is the witness.** `D7:3` belongs to one conversation and is simply absent from the next, so
 * checking the ids against the corpus costs one set lookup.
 *
 * **What it can and cannot see, because a turn id is POSITIONAL.** Two conversations share most of their
 * id spellings — swapping `conv-30`'s whole extraction in under `conv-47`'s name leaves only 23 of 369 ids
 * foreign, all of them past the shorter conversation's end. So the id test alone is a partial detector, and
 * the coverage test below is the other half: whatever the splice did not bring, the real conversation's own
 * turns go unaccounted for. A splice caught by neither would have to replace a part with another
 * conversation's part of exactly the same session and turn shape — possible, and nothing here would know.
 *
 * ## Why coverage is re-asked here, when `check` already counts it
 *
 * `check` counts declared turns that no claim names — the extraction against its own `sessions` block. A
 * part that declares only the sessions it covered scores 100% on that while accounting for a third of the
 * conversation. Measured against the corpus the question becomes the one that matters: how much of the
 * conversation is in here. That is the reading that catches a lost part when the merge cannot, because a
 * single part carrying no `part` block is a whole extraction by definition.
 *
 * ## It refuses an empty conversation rather than passing
 *
 * Every assertion here is *"this id is not in that set"*, and every one of them is vacuously true against an
 * empty set: no id is foreign when none is real, and coverage of nothing is total. An empty conversation is
 * what a failed or mis-pathed load produces, so it throws instead — the guard a hand-written copy of this
 * loop would leave out, which is why the loop lives in here.
 */

/** Every turn id a record in this extraction names as its provenance, from every kind that may carry them. */
function citedTurns(extraction) {
  const records = [
    ...(extraction.claims ?? []),
    ...(extraction.entities ?? []),
    ...(extraction.chrono ?? []),
  ];
  return new Set(records.flatMap(r => r.sourceTurns ?? []));
}

/**
 * @param {object} extraction one extraction file, merged — not a part
 * @param {object} conversation the same conversation as `loadConversations` returns it
 * @returns {string[]} every problem at once, empty when the file is sound
 */
export function extractionMatchesConversation(extraction, conversation) {
  const real = new Set((conversation?.sessions ?? []).flatMap(s => (s.turns ?? []).map(t => t.id)));
  if (real.size === 0) {
    throw new Error(`conversation '${conversation?.id}' has no turns to check against. Every check below is `
      + 'an absence test, so an empty conversation would pass an extraction of anything at all — this is a '
      + 'failed load, not a clean result.');
  }

  const problems = [];
  const id = conversation.id;
  if (extraction.conversationId !== id) {
    problems.push(`the file says conversationId '${extraction.conversationId}' and it is being checked `
      + `against '${id}'. One of the two is wrong, and a graph written from it would be filed under the `
      + 'wrong conversation.');
  }

  const declared = new Set((extraction.sessions ?? []).flatMap(s => s.turns ?? []));
  const cited = citedTurns(extraction);
  const foreign = [...new Set([...declared, ...cited])].filter(t => !real.has(t)).sort();
  if (foreign.length > 0) {
    problems.push(`${foreign.length} turn id(s) do not exist in ${id}: ${foreign.slice(0, 12).join(', ')}`
      + `${foreign.length > 12 ? ', …' : ''}. These records came from another conversation — the file is `
      + 'internally consistent and describes the wrong thing, which nothing downstream can see.');
  }

  /*
   * AND THE OTHER DIRECTION — every turn the conversation has must be DECLARED by a session here, not
   * merely cited by a claim.
   *
   * The check below asks `real ⊆ cited` and the foreign-id check above asks `declared ⊆ real`. Neither asks
   * `real ⊆ declared`, and on 2026-09-21 that gap shipped a broken extraction straight through `check`: an
   * extractor killed while writing its last part wrote that part's claims without the `sessions` block that
   * belonged with them. Every turn was cited, so coverage read 100%, and the merged file declared 20
   * sessions of a 29-session conversation while `check` printed `valid`.
   *
   * A session is not bookkeeping. `write-space.mjs` creates one transcript per declared session and files
   * every claim under one, so nine undeclared sessions are nine transcripts that never exist and a claim
   * layer whose provenance points at nothing.
   */
  const undeclared = [...real].filter(t => !declared.has(t));
  if (undeclared.length > 0) {
    problems.push(`${undeclared.length} of ${real.size} turns in ${id} are in no declared session: `
      + `${undeclared.slice(0, 12).join(', ')}${undeclared.length > 12 ? ', …' : ''}. A claim may still name `
      + 'them, which is why coverage can read complete — but the writer makes one transcript per declared '
      + 'session and files every claim under one, so a session nothing declares is a session that never '
      + 'reaches the space. This is the shape a part truncated mid-write leaves behind.');
  }

  /*
   * Against the CORPUS, deliberately. The same count against the file's own `sessions` block is what
   * `check` already prints, and it is the reading a truncated extraction passes.
   */
  const accounted = [...real].filter(t => cited.has(t));
  if (accounted.length < real.size) {
    const missing = [...real].filter(t => !cited.has(t));
    problems.push(`only ${accounted.length} of ${real.size} turns in ${id} are named by any record. `
      + `Unaccounted: ${missing.slice(0, 12).join(', ')}${missing.length > 12 ? ', …' : ''}`);
  }
  return problems;
}
