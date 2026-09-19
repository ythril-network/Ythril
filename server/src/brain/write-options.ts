/**
 * The options every brain CREATE takes, in the object that spared them a twelfth positional argument.
 *
 * ## Why this is its own module
 *
 * It lived in `recall.ts`, which is one of the largest files in the repo — and it is a WRITE type: five
 * writers and the write routes' shared helper import it, and `recall.ts` itself only declared it. So every
 * addition to what a create accepts landed in the recall module because that is where the type already was,
 * which is the exact failure `no-new-god-files.test.js` exists to name. Adding `suppressEmbeddings` was the
 * one line that pushed that file past its frozen size, and moving the type out took it back under.
 *
 * Nothing about the fields changed in the move.
 */
export interface DupeCheckOpts {
  /**
   * Retire this record from meaning-ranked search AT CREATION, rather than embedding it and then removing the
   * vector with a second write.
   *
   * The top of three tiers — `record > schema > space` — and it was the one tier a create could not state.
   * Every create path handed `embeddingSuppressedFor` a type-only object, so the flag had nowhere to be read
   * from and the schema tier answered instead, silently. Reported from outside on 2026-08-30: a marker written
   * on every inbound message needed two writes, an embedding computed only to be discarded, and a window
   * between them where the record WAS searchable.
   *
   * `undefined` means "not stated" and falls through to the tiers below; `false` states that this record does
   * not suppress, which still does not override a type or space that does.
   */
  suppressEmbeddings?: boolean;
  checkDuplicates?: boolean;
  /**
   * Also report near-neighbours that structurally CONTRADICT the incoming record (same single-valued
   * property, different value). Its own flag rather than a rider on `checkDuplicates`: "is this redundant?"
   * and "does this conflict with what we already believe?" are different questions, and a caller may well
   * want the second without the first.
   *
   * Only the deterministic judge runs on the write path — no model call, so no added latency or egress per
   * insert. The nightly scanner still runs the NLI pass. The warning NEVER blocks the write: an agent
   * correcting an outdated fact should be able to contradict the record it supersedes.
   */
  checkContradictions?: boolean;
  dupeThreshold?: number;
  dupeTopK?: number;
  /**
   * Block the write until this record is embedded, so it is searchable the moment the call returns.
   *
   * Default false: the vector is computed by the embedding queue moments later, and the write no longer
   * pays the model's latency. Set true when the caller will search for what it just wrote, or when a
   * failure to embed should fail the write rather than be repaired in the background.
   *
   * Two consequences worth stating rather than discovering. With this true, a write **fails** when the
   * embedder is unavailable — that was `saveFact`'s unconditional behaviour before the queue, now named
   * and opt-in. With it false, the write **succeeds** and the record is briefly unrecallable: a vectorless
   * record is invisible to BOTH recall channels, since the lexical one needs an embedding to compute a
   * real similarity and skips what it cannot score.
   *
   * `checkDuplicates` and `checkContradictions` IMPLY this — they need the vector before the insert so the
   * new record cannot self-match, and that is a question which cannot be answered later.
   *
   * It lives here, in the options object the write paths already take, rather than as another positional
   * parameter: `saveFact` carries a note saying its twelfth was one too many.
   */
  waitForEmbedding?: boolean;
  /**
   * Store this record already marked as no longer true.
   *
   * The create half of the mark, for the same reason `suppressEmbeddings` has one: an agent that learns a
   * correction and the history it replaces in the same turn would otherwise need two writes and a window
   * between them where the retired claim reads as current.
   *
   * It does NOT affect embedding — see `RECORD_SUPERSEDED_FIELD` in `brain/record-flag.ts` for why a
   * retired record keeps its vector and keeps ranking.
   */
  superseded?: boolean;
}
