/**
 * What the background duplicate and contradiction scanners are configured with, and what they store: the two scanner
 * configs, the duplicate action rule, the candidate documents each scanner records, the resolve vocabulary of a
 * contradiction, and the per-(space, type) scan cursor.
 *
 * Split out of `types.ts` (`Q-390`) when it passed its size limit, the way `types-jobs.ts` (`Q-166`) was: one question per
 * file, records moved WHOLE with every field and docblock they carried, and re-exported from `types.ts`, so no importer
 * changes. `RecordType` is imported from the `types-knowledge.ts` LEAF, never from `types.ts`: importing it back would
 * be a module cycle, the failure that degraded `NetworkConfig` to `any` when that split was first tried.
 */
import type { RecordType } from './types-knowledge.js';

/** Knowledge types the background duplicate scanner can sweep (same values as RecallKnowledgeType). */
/** One of the five names this repo had for {@link RecordType}. Kept as an alias so call sites read well. */
export type DupeScanType = RecordType;

/**
 * Optional background semantic-duplicate scanner. Off by default (opt-in). When
 * enabled, a cron-scheduled sweep walks each space by `seq` (so it covers every
 * record — including those inserted with the interactive checkDuplicates turned
 * off — and re-scans edited records, since updates advance `seq`), finds
 * near-duplicate pairs via stored embeddings, and records them as reviewable
 * candidates. It never modifies data — consolidation is a separate manual action.
 */
export interface DupeScannerConfig {
  /** Master switch. Default: false. */
  enabled?: boolean;
  /** Cron schedule for the nightly sweep. Default: '0 3 * * *' (03:00 daily). */
  schedule?: string;
  /** Cosine-similarity threshold at/above which a pair is recorded. Default: 0.92. */
  threshold?: number;
  /** Records fetched per DB batch during a sweep. Default: 200. */
  batchSize?: number;
  /** Max records scanned per space per run (bounds resource use; the rest is picked up next run). Default: 5000. */
  maxPerRun?: number;
  /** Knowledge types to scan. Default: ['fact', 'entity', 'chrono']. */
  types?: DupeScanType[];
}

/**
 * Background contradiction scanner (F-REVIEW).
 *
 * Separate from `dupeScanner` rather than a flag on it, because the two answer different questions and
 * cost differently: a duplicate is a cosine score that always answers and costs nothing, while a
 * contradiction may need an entailment (NLI) model — a call per candidate pair, and with an external
 * endpoint that means record text leaving the instance. Sharing one switch would make enabling duplicate
 * detection silently start paying for model inference.
 *
 * **Off by default**, like the duplicate scanner. Until it is enabled, contradictions are only found when
 * an admin runs `POST /api/contradictions/scan` by hand.
 */
export interface ContradictionScannerConfig {
  /** Master switch. Default: false. */
  enabled?: boolean;
  /** Cron schedule for the sweep. Default: '30 3 * * *' (03:30 daily). */
  schedule?: string;
  /**
   * Similarity floor for the STRUCTURED pass. Default: 0.85.
   *
   * **NOT raw cosine.** `$vectorSearch` normalises cosine to `(1 + cos) / 2`, so 0.85 here means cosine
   * ≈ 0.70, and the previous 0.92 meant cosine ≈ 0.84. Reading these as cosine makes them sound roughly
   * twice as strict as they are — and setting 0.7 "so the records are at least related" would really mean
   * cosine 0.4, where plenty of unrelated text lands.
   *
   * Loosened from the inherited duplicate threshold because 0.92 asks "are these the same record?", which
   * is the right question for de-duplication and the wrong one here: two records can contradict without
   * being near-identical. The structured judge is deterministic and free per pair, so a somewhat wider net
   * costs nothing but review attention.
   */
  structuredThreshold?: number;
  /**
   * Similarity floor for the NLI pass. Default: **0.85 when the judge is local, 0.92 when it is remote**.
   *
   * Same normalised scale as `structuredThreshold`. The gap is not about speed — an MNLI encoder is one
   * forward pass either way — but about egress: every pair judged remotely is record text leaving the
   * instance, and no amount of hardware makes that cheaper. A local sidecar can afford the same net as the
   * free pass.
   */
  nliThreshold?: number;
  /**
   * Cap on how many pairs the NLI pass may judge in one run. Default: **unlimited when local, 2000 when
   * remote**. 0 means unlimited.
   *
   * Hitting the cap is an ORDERLY stop, not a stall: the pairs it did judge are settled and the cursor
   * advances past them, so the next run resumes where it left off. Only an unavailable judge parks the
   * cursor. Conflating the two would either re-judge the same pairs forever or silently skip them.
   */
  maxJudgedPairsPerRun?: number;
  /** Records fetched per DB batch during a sweep. Default: 200. */
  batchSize?: number;
  /** Max records scanned per space per run. Default: 5000. */
  maxPerRun?: number;
}

/**
 * A per-space duplicate-action rule. When the scanner finds a pair whose score
 * is at or above `minScore` (and whose type is in `types`, if set), the rule's
 * `action` decides what happens. Rules are evaluated highest-`minScore` first;
 * the first match wins; no match falls back to `flag`.
 */
export interface DupeActionRule {
  /** Apply this rule when the pair's cosine score is ≥ this. */
  minScore: number;
  /**
   * - `flag`     — record a reviewable candidate (default, non-destructive).
   * - `automerge`— entities only: merge losslessly when there is no value
   *                conflict, else fall back to `flag`. Uses the existing entity merge.
   * - `notify`   — emit a `duplicate.detected` webhook (both records + score).
   */
  action: 'flag' | 'automerge' | 'notify';
  /** Restrict this rule to these knowledge types (default: any scanned type). */
  types?: DupeScanType[];
  /**
   * `notify` only: POST directly to this URL (SSRF-validated) instead of the
   * webhook-subscription system. Omit to use subscriptions (the default).
   */
  webhookUrl?: string;
}

/**
 * A semantically-duplicate pair recorded by the background scanner, stored in
 * `${spaceId}_dupe_candidates`. The `_id` is a canonical pair key so the same
 * pair is only ever recorded once regardless of which member is scanned first.
 */
/**
 * One contradiction candidate — a pair of records in a space that appear to DISAGREE (F-REVIEW).
 *
 * Shaped after `DupeCandidateDoc` on purpose: same identity scheme, same sticky-dismissal contract, so the
 * Review tab's two sub-views share one vocabulary and `decideDismissed` serves both.
 *
 * The difference that matters is `basis`. A duplicate has a similarity SCORE; a contradiction has a REASON,
 * and the two reasons are not equally strong. `structured-field` is deterministic — the records literally
 * set the same single-valued property to different values. `nli` is a model's opinion, so it carries a
 * confidence and deserves to be labelled as such in the UI: a reviewer should be able to tell "these two
 * disagree on `port`" from "a model thinks these disagree".
 *
 * There is deliberately NO record for an *unjudged* pair. When the judge cannot answer (no endpoint,
 * outage, low confidence), nothing is written and the scan cursor does not treat the pair as settled — so
 * it is re-examined later. Writing an "unjudged" row would be worse than useless: it would look like a
 * reviewed-and-clean pair to every query that filters on status.
 */
/** How a reviewer settles a contradiction: the resolution, and for `superseded` the side kept. */
export interface ContradictionChoice {
  resolution: 'edited' | 'linked' | 'superseded';
  winner?: 'a' | 'b';
}

/**
 * A choice a resolve has claimed, and WHEN (ISO). The time is what lets a claim nobody finished (a crash, a `503` never
 * retried) be taken over once it is older than `RESOLVE_CLAIM_STALE_MS`, instead of pinning its choice for ever.
 */
export interface ContradictionClaim extends ContradictionChoice {
  at: string;
  /**
   * What this claim's resolve wrote, each entry set under the claim just BEFORE its effect: the `supersedes` edge it drew and
   * the record it marked. A takeover, dismiss or reopen undoes exactly these, and nothing a claim did not record.
   */
  wrote?: { edgeId?: string; markedId?: string };
}

/**
 * One outcome of a contradiction resolve that a reviewer must not be left to assume (`Q-442`). Flat, so a client renders
 * it in its own words by `code`, with `label` and `rule` as placeholders, and shows `detail`, the server's sentence, only
 * as a disclosure.
 *
 *   `linkRefused`         the space's own rules refused the `supersedes` edge (a functional label, an endpoint rule); the
 *                         judgement is kept anyway (D-25): the loser is marked and the candidate closed
 *   `winnerGone`          the record the reviewer kept no longer exists, so no edge was drawn from it
 *   `loserGone`           the record the reviewer judged stale no longer exists: nothing to mark and no edge
 *   `edgePairUnlinkable`  the pair are edges, and an edge cannot be the endpoint of an edge
 *   `oppositeChoiceUndone` an unfinished resolve of the pair (taken over as stale, or released by a dismiss or reopen) had
 *                         something it wrote taken back — its edge deleted, its mark lifted; `detail` names which
 *   `markKept`            a mark that unfinished resolve set was KEPT, because another resolved pair relies on it
 */
export interface ContradictionResolveNote {
  code: 'linkRefused' | 'winnerGone' | 'loserGone' | 'edgePairUnlinkable' | 'oppositeChoiceUndone' | 'markKept';
  detail: string;
  /** The edge label the refused link carried. */
  label?: string;
  /** The rule(s) of the space's edge schema that refused it, as the validator names them (`functional`, `fromType`, ...). */
  rule?: string;
}

export interface ContradictionCandidateDoc {
  _id: string;            // canonical `${aId}:${bId}` with aId < bId
  spaceId: string;
  /** Which collection the pair lives in — contradictions are judged within one kind of record. */
  type: DupeScanType;
  aId: string;
  aSummary: string;
  aSeq: number;
  bId: string;
  bSummary: string;
  bSeq: number;
  /** How the disagreement was established. */
  basis: 'structured-field' | 'nli';
  /** 1 for a deterministic structured conflict; the model's confidence for an `nli` verdict. */
  confidence: number;
  /** The disagreeing single-valued properties — present only when `basis` is `structured-field`. */
  fields?: { key: string; aValue: string | number | boolean; bValue: string | number | boolean }[];
  /**
   * The judged text was long enough that the model's window probably cut it — so this verdict may describe
   * the OPENING of a record rather than the record. A proxy, never a measurement: we do not truncate, the
   * encoder does, invisibly and without changing the confidence. Absent means "not long enough to worry
   * about", not "the whole text was read". See `NLI_LIKELY_TRUNCATED_CHARS`.
   */
  truncated?: true;
  status: 'open' | 'dismissed' | 'resolved';
  /**
   * How a resolved candidate was actioned.
   *
   *   `edited`      a record was corrected.
   *   `linked`      a contradicts/supersedes edge was drawn by hand instead of changing either record.
   *   `superseded`  the reviewer picked a winner. Distinct from `linked` because the SYSTEM acted on it:
   *                 `supersededId` names the loser, and a `supersedes` edge is drawn when the space's rules let it
   *                 be (`notes` says when they did not).
   *                 Not a merge — neither record is deleted or absorbed; both are still real, and one is now
   *                 marked as having been overtaken by the other.
   */
  resolution?: 'edited' | 'linked' | 'superseded';
  /** The record the reviewer decided is out of date. Present only for `superseded`. */
  supersededId?: string;
  /**
   * Who decided, as the token's NAME — never the token itself.
   *
   * A resolution is a judgement call between two real records, so "someone settled this" is not enough for
   * the next reviewer to act on: they need to know whether to ask, and whom. The audit log records the actor
   * too, but a reviewer reading the Review tab is not reading the audit log.
   */
  resolvedBy?: string;
  /**
   * The choice a resolve in flight has taken (`Q-442`), written before its first effect and removed when it closes the
   * candidate. It is what makes a second resolve with a DIFFERENT choice a `409` rather than a second, opposite
   * `supersedes` edge, and what a retry of the same choice after a failure part-way converges on.
   */
  resolving?: ContradictionClaim;
  /** What the resolve that closed this candidate could not do as asked, by code: kept, so the resolved list says it too. */
  notes?: ContradictionResolveNote[];
  /** Same sticky-dismissal contract as duplicates — see `decideDismissed`. */
  dismissedContentHash?: string;
  detectedAt: string;
  updatedAt: string;
}

export interface DupeCandidateDoc {
  _id: string;            // canonical `${type}:${aId}:${bId}` with aId < bId
  spaceId: string;
  type: DupeScanType;
  aId: string;            // lexicographically smaller record id
  aSummary: string;       // short human summary of record a
  aSeq: number;           // record a's seq at last detection (change → re-detect)
  bId: string;            // lexicographically larger record id
  bSummary: string;       // short human summary of record b
  bSeq: number;           // record b's seq at last detection
  score: number;          // cosine similarity at last detection
  /** open = awaiting review; dismissed = reviewed/not-a-dup; resolved = auto-actioned (merged/notified). */
  status: 'open' | 'dismissed' | 'resolved';
  /** How a resolved candidate was actioned (present only when status = 'resolved'). */
  resolution?: 'merged' | 'notified';
  /**
   * Content fingerprint of the pair (both records' embedded text) captured when it was dismissed.
   * A dismissed pair is sticky against seq bumps that DON'T change content — a re-embed, a peer
   * re-sync, an index rebuild — but re-opens automatically when the content materially changes
   * (this hash no longer matches). Present only while `status = 'dismissed'`; undefined on a legacy
   * dismissal (pre-this-feature), which is treated as sticky and back-filled on the next scan.
   */
  dismissedContentHash?: string;
  detectedAt: string;     // ISO8601 — first detection
  updatedAt: string;      // ISO8601 — last re-detection
}

/**
 * Per-(space, type) scan cursor for the duplicate and contradiction scanners, stored in the global
 * `ythril_dupe_scan_state` collection. `cursorSeq` is the highest POSITION already swept (a number, which an
 * older build reads and moves; the name is 5.6's, and a legacy row's position is its seq) and `cursorPos` is the last record scanned within the run at
 * that position: the next run reads what comes AFTER the pair (what landed since). `cursorPos` is trusted only while
 * `cursorPos.seq === cursorSeq` — see `brain/scan-cursor.ts`.
 */
export interface DupeScanStateDoc {
  _id: string;            // `${spaceId}:${type}`
  spaceId: string;
  type: DupeScanType;
  cursorSeq: number;
  cursorPos?: { seq: number; id: string };
  updatedAt: string;      // ISO8601
}
