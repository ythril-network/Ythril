/**
 * Prune review findings that can never resurface.
 *
 * `{space}_dupe_candidates` and `{space}_contradiction_candidates` had no retention at all: the only
 * deletes anywhere were the space wipe and space delete. A finding outlives the records it is about, so
 * deleting a record individually stranded its findings forever — the Review tab listing a pair where
 * clicking through leads nowhere.
 *
 * ── Why this is NOT "delete settled findings older than N days" ──────────────────────────────────────────
 *
 * The obvious retention policy would undo human decisions:
 *
 *   open                     the queue. Obviously kept.
 *   dismissed                deleting it FORGETS the dismissal, and the next sweep re-flags the pair. That
 *                            is precisely what the sticky-dismissal machinery (`decideDismissed`,
 *                            `dismissedContentHash`) exists to prevent — a time-based prune would silently
 *                            re-open every dismissal that aged out.
 *   resolved edited/linked   the two records still exist and still look contradictory on the surface;
 *                            forgetting how it was settled invites a re-flag.
 *   resolved merged          SAFE — the absorbed record is gone, so the pair can never be detected again.
 *
 * So the rule is not age, it is **can this ever come back?** Dismissals are a few hundred bytes each and
 * encode a decision somebody made; unbounded growth of those is a better trade than re-asking a settled
 * question. What actually grows without bound — and loses nothing when removed — is findings whose records
 * are gone.
 *
 * ── Why it runs on its own timer ─────────────────────────────────────────────────────────────────────────
 *
 * Not hung off the duplicate or contradiction scanner: both are **off by default**, so pruning would never
 * run on most instances while the orphans accumulated anyway. Not folded into the TTL sweep either — that
 * deletes through the normal record paths, which emit tombstones and webhooks. These are internal review
 * state and were never user records; publishing `*.deleted` events for them would be wrong.
 *
 * ── What one space's trouble costs the others (`Q-274`, `Q-358`) ─────────────────────────────────────────
 *
 * The prune is a walk over the spaces (`eachSpace`, `util/housekeeping-walk.ts`) and, inside a space, over its two candidate
 * collections (`eachUnit`). A failure of either — the read of the findings, the lookup of the records they name, the delete —
 * is said ONCE per window under the step, with the collection named, and the next collection and the next space are still
 * pruned; an operation that hangs ends at the housekeeping bound and the space is passed over for a while. Nothing here swallows:
 * the old per-collection `catch` logged on every pass, and the lookup's `catch` said nothing at all, so a space that never
 * pruned looked the same as a space with nothing to prune.
 *
 * It stays **fail closed**, and for the same reason as before: a failure of the lookup throws, so nothing is deleted on the
 * strength of a read that did not happen.
 */
import { col, asFilter } from '../db/mongo.js';
import { readStoredById } from '../db/read-by-id.js';
import { NOT_A_FLAGGED_ROW } from '../files/live-file-row.js';
import { RECORD_COLLECTION as COLLECTION_SUFFIX } from '../config/types.js';
import { concreteSpaces } from '../spaces/proxy.js';
import { eachSpace, eachUnit, type WalkResult } from '../util/housekeeping-walk.js';
import { declareStep } from '../util/housekeeping-signals.js';
import { intervalJob } from '../util/interval-job.js';
import { log } from '../util/log.js';
import type { DupeScanType } from '../config/types.js';

const STEP = declareStep('Candidate prune');

/** Both collections key their rows by the same singular vocabulary. */
// The record-to-collection map is imported. The copy here was typed `Record<string, string>`, which is a
// map with no keys: a typo for a record kind read as `undefined` and built a collection name ending in
// "undefined". Two of the five copies were spelled that way.

const CANDIDATE_COLLECTIONS = ['dupe_candidates', 'contradiction_candidates'] as const;

/** How often to sweep. Orphans are not urgent — this is housekeeping, not correctness. */
const PRUNE_INTERVAL_MS = 6 * 60 * 60 * 1000;   // 6h

/** The subset of a candidate row this decision needs. */
export interface PrunableCandidate {
  status?: string;
  resolution?: string;
  aId?: string;
  bId?: string;
}

export type PruneVerdict = 'keep' | 'prune-merged' | 'prune-orphan';

/**
 * Whether a finding can be dropped. Pure, so every branch is checkable without a database — and this is
 * the branch that matters, because getting it wrong deletes a human decision rather than erroring.
 *
 * `aExists` / `bExists` must be the caller's POSITIVE knowledge that each record was found. A caller that
 * could not check must not call this (see `pruneSpaceCandidates`, which keeps everything on a failed
 * lookup): "I did not find it" and "I could not look" are the same value here and only one of them is safe.
 */
export function decideCandidatePrune(
  row: PrunableCandidate, aExists: boolean, bExists: boolean,
): PruneVerdict {
  // A merged pair is unresurfacable by construction: one of the two records no longer exists, so the
  // similarity search can never pair them again.
  if (row.status === 'resolved' && row.resolution === 'merged') return 'prune-merged';

  // Either record gone ⇒ the finding is unopenable. True for open, dismissed and resolved alike: a
  // dismissal of a pair that no longer exists protects nothing, because the pair cannot be re-detected.
  if (!aExists || !bExists) return 'prune-orphan';

  return 'keep';
}

export interface PruneResult { merged: number; orphaned: number }

/** Prune one candidate collection of one space. THROWS on any failure: nothing is deleted on a read that did not happen. */
async function pruneCandidateCollection(spaceId: string, suffix: (typeof CANDIDATE_COLLECTIONS)[number]): Promise<PruneResult> {
  const result: PruneResult = { merged: 0, orphaned: 0 };
  const coll = col<PrunableCandidate & { _id: string; type?: string }>(`${spaceId}_${suffix}`);
  const rows = await coll.find({}, { projection: { _id: 1, type: 1, status: 1, resolution: 1, aId: 1, bId: 1 } })
    .toArray() as Array<PrunableCandidate & { _id: string; type?: string }>;
  if (rows.length === 0) return result;

  // Resolve existence per record type, one query each rather than one per finding.
  const idsByType = new Map<string, Set<string>>();
  for (const r of rows) {
    if (!r.type) continue;
    const set = idsByType.get(r.type) ?? new Set<string>();
    if (r.aId) set.add(r.aId);
    if (r.bId) set.add(r.bId);
    idsByType.set(r.type, set);
  }

  const existing = new Map<string, Set<string>>();
  for (const [type, ids] of idsByType) {
    const recSuffix = COLLECTION_SUFFIX[type as DupeScanType];
    if (!recSuffix) return result;   // unknown type ⇒ cannot judge ⇒ keep everything (a shape this code does not know, not a failure)
    // A lookup that fails THROWS: fail closed, and the failure is said by the walk rather than lost here.
    // The any-tier predicate, and not `LIVE_FILE_ROW`: a file finding can name a chunk row, and reading a chunk as
    // "gone" would delete a human dismissal. A flagged top-level row read as gone is the point — the finding it leaves
    // behind is the stranded one this module exists to remove.
    const found = await readStoredById(`${spaceId}_${recSuffix}`, [...ids], {},
      { filter: recSuffix === 'files' ? NOT_A_FLAGGED_ROW : undefined });
    existing.set(type, new Set(found.keys()));
  }

  const toDelete: string[] = [];
  for (const r of rows) {
    const present = r.type ? existing.get(r.type) : undefined;
    if (!present) continue;     // no knowledge for this type ⇒ keep
    const verdict = decideCandidatePrune(r, !!r.aId && present.has(r.aId), !!r.bId && present.has(r.bId));
    if (verdict === 'keep') continue;
    toDelete.push(r._id);
    if (verdict === 'prune-merged') result.merged++; else result.orphaned++;
  }

  if (toDelete.length > 0) {
    await coll.deleteMany(asFilter<{ _id: string }>({ _id: { $in: toDelete } }));
  }
  return result;
}

/**
 * Prune one space's findings across both candidate collections, adding what each collection removed to `into` as it finishes
 * (so a space whose second collection hung still reports what the first removed).
 *
 * **Fail-closed**: any error, or any inability to confirm which records exist, leaves that collection's rows alone. The
 * dangerous failure here is not missing a prune — it is a lookup that comes back empty for an unrelated reason and makes every
 * finding look orphaned. A collection that fails is said and the other is still pruned (`eachUnit`).
 *
 * Runs inside a walk (`eachSpace`): `eachUnit` reports against the space being walked, and THROWS when there is none.
 */
export async function pruneSpaceCandidates(spaceId: string, into: PruneResult = { merged: 0, orphaned: 0 }): Promise<PruneResult> {
  await eachUnit(CANDIDATE_COLLECTIONS, async (suffix) => {
    const r = await pruneCandidateCollection(spaceId, suffix);
    into.merged += r.merged;
    into.orphaned += r.orphaned;
  });
  return into;
}

/** Prune every real (non-proxy) space. Returns what it removed and what the walk concluded (who failed, a stop). */
export async function pruneAllSpaces(): Promise<PruneResult & { walk: WalkResult<void> }> {
  const total: PruneResult = { merged: 0, orphaned: 0 };
  const walk = await eachSpace(STEP, concreteSpaces(), space => pruneSpaceCandidates(space.id, total));
  if (total.merged + total.orphaned > 0) {
    log.info(`Candidate prune: removed ${total.orphaned} finding(s) whose records are gone and ${total.merged} merged pair(s)`);
  }
  return { ...total, walk };
}

const pruneJob = intervalJob('Candidate prune', PRUNE_INTERVAL_MS, () => pruneAllSpaces());

/**
 * Start the background prune. Always on — unlike the scanners it has no cost worth gating and no behaviour
 * an operator would want to opt out of: it only removes findings that cannot be acted on.
 */
export function startCandidatePrune(): void {
  if (pruneJob.armed) return;
  pruneJob.start();
  log.debug('Candidate prune worker started');
}

export function stopCandidatePrune(): void {
  pruneJob.stop();
}

