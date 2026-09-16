/**
 * Per-space contradiction scanner (F-REVIEW slice 3c).
 *
 * Walks a space's records, pairs each with its nearest neighbours (the same vector search the duplicate
 * scanner uses — similarity finds the CANDIDATES, it never decides them), asks `judgePair`, and hands the
 * verdict to `recordContradiction`.
 *
 * ── Why there are TWO cursors ────────────────────────────────────────────────────────────────────────
 *
 * The duplicate scanner keeps one cursor per space/type and advances it **per record**: once a record has
 * been scanned the cursor moves past it, and the record is only revisited when its own `seq` changes. That
 * is sound there, because its judge is a cosine score — it always answers.
 *
 * Here the judge can decline. `judgePair` returns `unjudged` when the NLI endpoint is unconfigured,
 * unreachable, or returned nonsense. `recordContradiction` correctly writes nothing for those — but writing
 * nothing is not enough: a single shared cursor would still have moved past the record, so the pair would
 * not be looked at again until one of its records happened to change. An NLI outage during a nightly sweep
 * would silently skip everything it touched, permanently, and the Review tab would look clean.
 *
 * So the two passes keep their own cursors:
 *
 *   `{space}:{type}`       STRUCTURED — deterministic property conflicts. Always answers, so it always
 *                          advances. This pass is useful with **no NLI model configured at all**.
 *   `{space}:{type}:nli`   NLI — advances only over records the judge actually answered for. If the judge
 *                          is unavailable the cursor simply stalls where it is and resumes from exactly
 *                          there once a model is configured. Nothing is lost, nothing is falsely settled.
 *
 * A *low-confidence* verdict is NOT a stall: the judge answered, just weakly, and re-asking would give the
 * same answer — so the NLI cursor moves past it. That is the whole reason `Verdict` distinguishes
 * `low-confidence` from `judge-unavailable`.
 */
import { schedule, validate, type ScheduledTask } from 'node-cron';
import { RECORD_COLLECTION as COLLECTION_SUFFIX } from '../config/types.js';
import { col, asFilter, asUpdate, isVectorSearchAvailable } from '../db/mongo.js';
import { getConfig } from '../config/loader.js';
import { needsReindex } from '../spaces/_shared.js';
import { log } from '../util/log.js';
import { findSimilar, DEFAULT_DUPE_THRESHOLD, type RecallKnowledgeType, type RecallResult } from './recall.js';
import { judgePair, consultedModel, type JudgeableRecord } from './contradiction-judge.js';
import { extraClaimFields, fetchStructuredClaims, type ClaimMap } from './structured-claims.js';
import { recordContradiction, contradictionPairId } from './contradiction-candidates.js';
import { nliConfigured, nliIsLocal } from './nli-client.js';
import type { ContradictionScannerConfig, DupeScanStateDoc, DupeScanType } from '../config/types.js';
import { runExclusive } from '../util/single-flight.js';
import { summariseRecall } from './recall-shape.js';
import { armedSchedules } from '../util/armed-schedule.js';

const SCAN_STATE = 'ythril_dupe_scan_state';
const DEFAULT_BATCH_SIZE = 200;
const DEFAULT_MAX_PER_RUN = 5000;
/**
 * Similarity floor for candidate pairs.
 *
 * ── READ THIS BEFORE CHANGING THE NUMBER ────────────────────────────────────────────────────────────────
 *
 * These thresholds are **not raw cosine**. `$vectorSearch` with cosine returns a score NORMALISED to
 * [0, 1] as `(1 + cosine) / 2`, and that is what `findSimilar` compares against. So:
 *
 *      score 0.92  ⇒  cosine 0.84        score 0.85  ⇒  cosine 0.70        score 0.70  ⇒  cosine 0.40
 *
 * Measured, not assumed: a chrono pair with raw cosine 0.8957 came back from the search as 0.9479.
 * Reading these as cosine makes every one of them sound ~2× stricter than it is, and picking "0.7 because
 * the records should at least be related" would actually mean cosine 0.4 — where a great deal of loosely
 * related text lands, which would bury the queue in noise.
 *
 * ── Why the DEFAULT is unchanged at 0.92 ────────────────────────────────────────────────────────────────
 *
 * It is tempting to loosen this on the argument that 0.92 asks "are these the same record?" rather than
 * "do these disagree?". That argument is sound in principle, but two attempts to build a pair that
 * genuinely contradicts and falls BELOW 0.92 both failed — they scored 0.9479 and 0.9259. Records that
 * share a subject embed close together even when their descriptions diverge sharply, because the subject
 * dominates the embedded text.
 *
 * So: no demonstrated case where a lower default changes the outcome, and therefore no default change.
 * What was genuinely missing is the ability to TUNE it, which is now here. Shipping a behaviour change to
 * every instance on an argument that could not be reproduced would be a worse trade than leaving the
 * number alone and letting operators who see real misses lower it themselves.
 */
const DEFAULT_STRUCTURED_THRESHOLD = DEFAULT_DUPE_THRESHOLD;
/** Pairs a REMOTE judge may be asked per run by default. Bounds egress, not time. */
const DEFAULT_REMOTE_PAIR_BUDGET = 2000;
// Chrono is swept alongside memories and entities: a calendar is exactly where the same thing gets logged
// twice with conflicting states, and its `status` is a single-valued claim the structured pass can settle
// without a model. See structured-claims.ts for why its dates are deliberately not part of that.
export const DEFAULT_TYPES: DupeScanType[] = ['fact', 'entity', 'chrono'];
const TOPK = 5;

// The record-to-collection map is imported: it was declared here and in four other modules, all five
// byte-identical, beside a sixth in `brain/ttl.ts` whose own comment said the mapping "was open-coded in
// five places". It had been extracted once and the copies came back.

/** Which pass a cursor belongs to. The suffix keeps them in the existing scan-state collection. */
export type Pass = 'structured' | 'nli';

/** Cursor key. The structured pass keeps the unsuffixed key so it reads naturally alongside the dupe one. */
export function cursorKey(spaceId: string, type: DupeScanType, pass: Pass): string {
  return pass === 'nli' ? `${spaceId}:${type}:contradiction:nli` : `${spaceId}:${type}:contradiction`;
}

async function getCursor(spaceId: string, type: DupeScanType, pass: Pass): Promise<number> {
  const doc = await col<DupeScanStateDoc>(SCAN_STATE).findOne(
    asFilter<DupeScanStateDoc>({ _id: cursorKey(spaceId, type, pass) }));
  return doc?.cursorSeq ?? 0;
}

async function setCursor(spaceId: string, type: DupeScanType, pass: Pass, cursorSeq: number): Promise<void> {
  await col<DupeScanStateDoc>(SCAN_STATE).updateOne(
    asFilter<DupeScanStateDoc>({ _id: cursorKey(spaceId, type, pass) }),
    asUpdate<DupeScanStateDoc>({ $set: { spaceId, type, cursorSeq, updatedAt: new Date().toISOString() } }),
    { upsert: true },
  );
}

/** What one record's evaluation did — the caller needs `judgeStalled` to decide about the NLI cursor. */
export interface RecordOutcomeSummary {
  found: number;
  /** True when at least one pair could not be judged because the judge itself was unavailable. */
  judgeStalled: boolean;
  /** Pairs the judge actually answered usefully for. What the sweep SETTLED. */
  judged: number;
  /**
   * Calls the NLI endpoint actually served — what the sweep SPENT.
   *
   * Not the same number as `judged`, and the gap is the point: a low-confidence answer was paid for and then
   * discarded, and an unreachable judge still received the record text. Both cost; neither settles.
   */
  modelCalls: number;
}

/**
 * A recall hit as the judge sees it.
 *
 * The mapping is spelled out rather than cast because getting it wrong is silent and total. A `RecallResult`
 * carries `_id` (not `id`) and keeps its free text under a per-type field (`fact` / `name` / `title`) — it
 * has no `text` and no `summary` at all. Handing one straight to `JudgeableRecord` therefore yields
 * `id: undefined, text: ''`, which does not fail: `judgePair` reads the empty text as `no-text` so the NLI
 * pass silently judges nothing ever, and every structured finding is written under the pair id
 * `"undefined:undefined"`, so the whole space collapses into one row that each pair overwrites in turn.
 * Nothing throws and the sweep reports success. That is what the `as never` casts here used to hide.
 */
export function toJudgeable(r: RecallResult, claims?: ClaimMap): JudgeableRecord {
  // `summariseRecall` is the same one-liner the duplicate review list shows, so a contradiction card and a
  // duplicate card describe the same record identically. `description` is appended for the NLI pass, which
  // needs prose to entail over — a bare title rarely contradicts anything.
  const head = summariseRecall(r);
  return {
    id: r._id,
    text: r.description ? `${head}. ${r.description}` : head,
    ...(claims ? { properties: claims } : {}),
  };
}

/**
 * Neighbours whose pair with the seed this sweep has not settled yet.
 *
 * ── Why a pair gets met twice ────────────────────────────────────────────────────────────────────────────
 *
 * Similarity is symmetric. As the sweep walks records by `seq`, a mutually-near pair {A, B} is met once with
 * A as the seed and B among its neighbours, and again with B as the seed and A among its. Both judgements
 * write the SAME row — `contradictionPairId` is order-independent — so the second one only overwrote the
 * first, and for the NLI pass it did so at the cost of a second model call and a second egress of both
 * records' text. An operator measured exactly that: our report said 6 pairs where their judge's own counter
 * said 12.
 *
 * Skipping the repeat is not a loss of evidence. It also makes the stored row deterministic: the side the
 * sweep reached FIRST wins, rather than whichever seed happened to come last.
 *
 * Pure and generic over the hit shape so it can be enumerated without a database.
 */
export function unjudgedNeighbours<T extends { _id: string }>(
  seedId: string, matches: T[], alreadyJudged?: Set<string>,
): T[] {
  if (!alreadyJudged) return matches;
  return matches.filter(m => !alreadyJudged.has(contradictionPairId(seedId, m._id)));
}

/**
 * Evaluate one seed record against its nearest neighbours.
 *
 * `pass` decides what a pair is allowed to consult: the structured pass never calls the model (so it can
 * run with no NLI configured), the NLI pass is the one that may stall.
 *
 * `alreadyJudged` is the sweep's set of pair ids settled earlier in this same pass — see `scanSpace`. Passed
 * in rather than owned here because a pair spans two seeds and this function only ever sees one of them.
 */
export async function evalRecord(
  spaceId: string, type: DupeScanType, recordId: string, pass: Pass, threshold: number,
  alreadyJudged?: Set<string>,
): Promise<RecordOutcomeSummary> {
  let found = 0;
  let judgeStalled = false;
  let judged = 0;
  let modelCalls = 0;
  try {
    const { source, results } = await findSimilar(
      spaceId, recordId, type as RecallKnowledgeType, TOPK, [type as RecallKnowledgeType], threshold);
    const sameType = results.filter(m => m.type === type);

    // For a type whose claims include stored columns (chrono's `status`), read them from the COLLECTION
    // rather than from the recall result — `RecallChrono.status` is derived from the clock, so judging on
    // it would produce a candidate whose verdict changes overnight while both records sit untouched.
    // One round trip covers the seed and all its neighbours.
    const stored = extraClaimFields(type).length > 0
      ? await fetchStructuredClaims(spaceId, type, [source._id, ...sameType.map(m => m._id)])
      : null;
    const claimsOf = (r: RecallResult): ClaimMap | undefined =>
      stored ? stored.get(r._id) : r.properties;

    const a = toJudgeable(source, claimsOf(source));
    // One pair, one judgement per sweep — see `unjudgedNeighbours`.
    for (const match of unjudgedNeighbours(source._id, sameType, alreadyJudged)) {
      const b = toJudgeable(match, claimsOf(match));
      const pairId = contradictionPairId(a.id, b.id);

      // The structured pass must not reach the model — it has to stay useful (and cursor-advancing) on an
      // instance with no NLI endpoint at all. `structuredOnly` is what enforces that; an unreachable
      // `minConfidence` (what this used to pass) discards the ANSWER, long after the call was made and paid
      // for. See `judgePair`.
      const verdict = pass === 'structured'
        ? await judgePair(a, b, { schemas: undefined, structuredOnly: true })
        : await judgePair(a, b);

      // What the endpoint served, counted before any early exit — an unusable response still egressed the
      // record text and still costs. This is the number the per-run budget bounds.
      if (consultedModel(verdict)) modelCalls++;

      if (verdict.kind === 'unjudged' && verdict.reason === 'judge-unavailable') {
        judgeStalled = true;
        continue;   // leave the pair unsettled; the NLI cursor will not move past this record
      }
      // Settled from here on: a verdict exists (or the pair is deliberately unsettleable in this pass), so
      // the other side must not re-do it.
      alreadyJudged?.add(pairId);
      // Pairs the judge answered USEFULLY for. Deliberately narrower than `modelCalls`.
      if (pass === 'nli' && verdict.kind !== 'unjudged') judged++;
      const outcome = await recordContradiction(spaceId, type,
        { id: a.id, summary: summariseRecall(source), seq: source.seq ?? 0 },
        { id: b.id, summary: summariseRecall(match), seq: match.seq ?? 0 },
        verdict);
      if (outcome === 'created' || outcome === 'reopened') found++;
    }
  } catch {
    /* no stored vector, record merged away, or search failed — skip the seed, not the sweep */
  }
  return { found, judgeStalled, judged, modelCalls };
}

export interface ContradictionScanResult {
  scanned: number;
  found: number;
  /** True when the NLI pass stopped early because the judge was unavailable. Reported, not swallowed. */
  nliStalled: boolean;
  /** Unique pairs the NLI judge answered usefully for — what the sweep SETTLED. */
  judgedPairs: number;
  /**
   * Calls the NLI endpoint served — what the sweep SPENT, and what `maxJudgedPairsPerRun` bounds.
   *
   * Reported next to `judgedPairs` rather than instead of it because an operator comparing our number against
   * their judge's own request counter needs to see the same thing it counts. `judgedPairs` never could:
   * a low-confidence answer costs a call and settles nothing, so the two legitimately differ.
   */
  modelCalls: number;
  /** True when the NLI pass stopped because its per-run budget was spent. An ORDERLY stop, not a stall. */
  budgetExhausted: boolean;
}

/**
 * Effective knobs for a sweep.
 *
 * The NLI defaults key on **where the judge runs**, not on the pass alone. An MNLI encoder is one forward
 * pass whether it is loopback or across the internet — what differs is that every remote judgement is
 * record text leaving the instance, a cost no hardware makes cheaper. So a local sidecar gets the same wide
 * net as the free structured pass, and a remote endpoint stays at the strict duplicate-grade threshold with
 * a pair budget on top.
 *
 * NOTE: these defaults are reasoned, not measured — no NLI sidecar ships with the stack, so there was
 * nothing to time against. They are all configurable for exactly that reason.
 */
export function scanTuning(cfg: ContradictionScannerConfig | undefined, judgeIsLocal: boolean): {
  structuredThreshold: number; nliThreshold: number; maxJudgedPairs: number; batchSize: number; maxPerRun: number;
} {
  const clamp01 = (n: number) => Math.min(Math.max(n, 0), 1);
  return {
    structuredThreshold: typeof cfg?.structuredThreshold === 'number' ? clamp01(cfg.structuredThreshold) : DEFAULT_STRUCTURED_THRESHOLD,
    nliThreshold: typeof cfg?.nliThreshold === 'number' ? clamp01(cfg.nliThreshold)
      : (judgeIsLocal ? DEFAULT_STRUCTURED_THRESHOLD : DEFAULT_DUPE_THRESHOLD),
    // 0 means unlimited, and that is the local default: a forward pass that leaves the box is free to run.
    maxJudgedPairs: typeof cfg?.maxJudgedPairsPerRun === 'number' && cfg.maxJudgedPairsPerRun >= 0
      ? cfg.maxJudgedPairsPerRun
      : (judgeIsLocal ? 0 : DEFAULT_REMOTE_PAIR_BUDGET),
    batchSize: Math.min(Math.max(cfg?.batchSize ?? DEFAULT_BATCH_SIZE, 1), 1000),
    maxPerRun: Math.min(Math.max(cfg?.maxPerRun ?? DEFAULT_MAX_PER_RUN, 1), 1_000_000),
  };
}

/** Sweep one space. Incremental per pass; `reset` re-runs both from zero. */
export async function scanSpace(spaceId: string, opts?: { reset?: boolean }): Promise<ContradictionScanResult> {
  const cfg = getConfig();
  const empty: ContradictionScanResult = { scanned: 0, found: 0, nliStalled: false, judgedPairs: 0, modelCalls: 0, budgetExhausted: false };
  const space = cfg.spaces.find(s => s.id === spaceId);
  if (!space || space.proxyFor) return empty;
  if (!isVectorSearchAvailable() || needsReindex(spaceId)) return empty;

  const tune = scanTuning(cfg.contradictionScanner, nliIsLocal());
  let scanned = 0;
  let found = 0;
  let nliStalled = false;
  let judgedPairs = 0;
  let modelCalls = 0;
  let budgetExhausted = false;

  // The NLI pass is skipped wholesale when no model is configured — its cursor stays put, so the day one is
  // configured it starts from the beginning of what it has not seen rather than from "now".
  const passes: Pass[] = nliConfigured() ? ['structured', 'nli'] : ['structured'];

  for (const pass of passes) {
    const threshold = pass === 'nli' ? tune.nliThreshold : tune.structuredThreshold;
    for (const type of DEFAULT_TYPES) {
      if (scanned >= tune.maxPerRun || budgetExhausted) break;
      if (opts?.reset) await setCursor(spaceId, type, pass, 0);
      let cursor = opts?.reset ? 0 : await getCursor(spaceId, type, pass);
      const coll = `${spaceId}_${COLLECTION_SUFFIX[type]}`;
      let stopThisType = false;
      // Pair ids settled during THIS pass over THIS type, so a mutually-near pair is judged from one side
      // only. Scoped here on purpose: a pair never spans two types, and a structured skip is not an NLI
      // skip. Bounded by maxPerRun x TOPK ids, which at the 5000-record default is a few tens of thousands
      // of short strings — the alternative is paying a remote endpoint twice for every pair.
      const judgedThisPass = new Set<string>();

      while (scanned < tune.maxPerRun && !stopThisType) {
        const take = Math.min(tune.batchSize, tune.maxPerRun - scanned);
        const batch = await col<{ _id: string; seq?: number }>(coll)
          .find(asFilter<{ _id: string; seq?: number }>({ spaceId, seq: { $gt: cursor } }), { projection: { _id: 1, seq: 1 } })
          .sort({ seq: 1 })
          .limit(take)
          .toArray();
        if (batch.length === 0) break;

        for (const rec of batch) {
          const out = await evalRecord(spaceId, type, rec._id, pass, threshold, judgedThisPass);
          found += out.found;
          judgedPairs += out.judged;
          modelCalls += out.modelCalls;
          scanned++;
          if (out.judgeStalled) {
            // Stop this pass HERE, without advancing past the record. The pair is not settled, so the
            // cursor must not claim it is — that is the whole point of the second cursor.
            stopThisType = true;
            nliStalled = true;
            break;
          }
          // The record itself IS settled, so the cursor advances before any budget check below.
          if (typeof rec.seq === 'number' && rec.seq > cursor) cursor = rec.seq;
          // Budget spent: an ORDERLY stop. Everything judged so far is settled and the cursor has moved
          // past it, so the next run resumes here rather than re-judging (and re-paying for) the same
          // pairs. This is exactly why it is checked AFTER the cursor advance, unlike a stall.
          //
          // Gated on `modelCalls`, not on `judgedPairs`: the budget exists to bound what the endpoint is
          // asked, and a low-confidence answer is a served request that settles nothing. Counting only the
          // useful answers let a space with weak verdicts run past its budget indefinitely.
          if (pass === 'nli' && tune.maxJudgedPairs > 0 && modelCalls >= tune.maxJudgedPairs) {
            stopThisType = true;
            budgetExhausted = true;
            break;
          }
        }
        await setCursor(spaceId, type, pass, cursor);
      }
    }
  }

  if (nliStalled) log.warn(`Contradiction scan (${spaceId}): the NLI judge was unavailable — its cursor is parked and will resume where it stopped`);
  if (budgetExhausted) log.info(`Contradiction scan (${spaceId}): spent ${modelCalls} judge calls (${judgedPairs} pairs settled) and stopped at its per-run budget; the next run resumes from there`);
  return { scanned, found, nliStalled, judgedPairs, modelCalls, budgetExhausted };
}

/**
 * Scan every real (non-proxy) space once, incrementally.
 *
 * Reports what it did rather than running silently: a sweep that parked because the judge was unreachable
 * has NOT cleared anything, and that has to be distinguishable in the logs from a sweep that found nothing.
 * The whole two-cursor design exists to stop an outage looking like a clean queue; swallowing it here would
 * put the blind spot straight back.
 */
export async function runContradictionScanAllSpaces(): Promise<void> {
  let scanned = 0;
  let found = 0;
  let judgedPairs = 0;
  let modelCalls = 0;
  let stalled = false;
  let budgetOut = false;
  for (const s of getConfig().spaces) {
    if (s.proxyFor) continue;
    try {
      const r = await scanSpace(s.id);
      scanned += r.scanned; found += r.found; judgedPairs += r.judgedPairs; modelCalls += r.modelCalls;
      stalled ||= r.nliStalled; budgetOut ||= r.budgetExhausted;
    } catch (err) { log.warn(`Contradiction scan failed for ${s.id}: ${err instanceof Error ? err.message : String(err)}`); }
  }
  // Both numbers, always: the judge-call count is the one that matches an endpoint's own request log, and
  // the settled-pair count is the one that describes the review queue. Logging only the second is what left
  // an operator unable to reconcile our report with their bill.
  if (scanned > 0) log.info(`Contradiction scan: scanned ${scanned}, judge calls ${modelCalls}, pairs settled ${judgedPairs}, found ${found}`);
  // Two different incomplete endings, logged differently on purpose: one means nothing was settled, the
  // other means everything judged WAS settled and the next run picks up from there.
  if (stalled) log.warn('Contradiction scan: the NLI judge was unavailable — its cursor is parked and will resume where it stopped. This sweep did NOT clear the queue.');
  if (budgetOut) log.info('Contradiction scan: stopped at the per-run judged-pair budget. What it judged is settled; the next run continues from there.');
}

// ── Scheduler (node-cron, mirrors the duplicate scanner) ─────────────────────
//
// Off by default and deliberately its own switch: the NLI pass is a model call per candidate pair and,
// with an external endpoint, egresses record text. Enabling duplicate detection must not silently start
// paying for inference. The default time sits half an hour after the dupe sweep so the two do not contend
// for the same vector-search capacity on a small instance.

const DEFAULT_SCHEDULE = '30 3 * * *';
let _task: ScheduledTask | null = null;
/** See `util/armed-schedule.ts`. Worse here than next door: this sweep calls an NLI model per pair,
 *  so a restarted task can turn a pass that was about to finish into one that starts again. */
const _armed = armedSchedules();
const ARMED = 'the one task';

export function startContradictionScanner(): void {
  const cs = getConfig().contradictionScanner;
  const cron = cs?.enabled ? (cs.schedule ?? DEFAULT_SCHEDULE) : null;
  if (cron !== null && _task && _armed.isArmed(ARMED, cron)) return;   // already running on exactly this expression
  stopContradictionScanner();
  if (cron === null) return;
  if (!validate(cron)) {
    log.warn(`Invalid contradictionScanner.schedule '${cron}' — contradiction scanner not started`);
    return;
  }
  _task = schedule(cron, () => {
    // Guarded: this sweep calls an NLI model PER PAIR, so on a large space against a slow judge a pass
    // routinely outlives its schedule — and two overlapping passes double the model calls while both write
    // the same candidates collection.
    void runExclusive('Contradiction scan', () => runContradictionScanAllSpaces());
  });
  _armed.note(ARMED, cron);
  log.info(`Contradiction scanner scheduled (${cron})`);
}

export function stopContradictionScanner(): void {
  _armed.forget();
  _task?.stop();
  _task = null;
}
