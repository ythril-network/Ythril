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
 */
import { col, asFilter } from '../db/mongo.js';
import { RECORD_COLLECTION as COLLECTION_SUFFIX } from '../config/types.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import type { DupeScanType } from '../config/types.js';
import { runExclusive } from '../util/single-flight.js';

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

/**
 * Prune one space's findings across both candidate collections.
 *
 * Best-effort and **fail-closed**: any error, or any inability to confirm which records exist, leaves the
 * rows alone. The dangerous failure here is not missing a prune — it is a lookup that comes back empty for
 * an unrelated reason and makes every finding look orphaned.
 */
export async function pruneSpaceCandidates(spaceId: string): Promise<PruneResult> {
  const result: PruneResult = { merged: 0, orphaned: 0 };

  for (const suffix of CANDIDATE_COLLECTIONS) {
    try {
      const coll = col<PrunableCandidate & { _id: string; type?: string }>(`${spaceId}_${suffix}`);
      const rows = await coll.find({}, { projection: { _id: 1, type: 1, status: 1, resolution: 1, aId: 1, bId: 1 } })
        .toArray() as Array<PrunableCandidate & { _id: string; type?: string }>;
      if (rows.length === 0) continue;

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
      let lookupFailed = false;
      for (const [type, ids] of idsByType) {
        const recSuffix = COLLECTION_SUFFIX[type as DupeScanType];
        if (!recSuffix) { lookupFailed = true; break; }   // unknown type ⇒ cannot judge ⇒ keep everything
        try {
          const found = await col<{ _id: string }>(`${spaceId}_${recSuffix}`)
            .find(asFilter<{ _id: string }>({ _id: { $in: [...ids] } }), { projection: { _id: 1 } })
            .toArray() as Array<{ _id: string }>;
          existing.set(type, new Set(found.map(d => d._id)));
        } catch {
          lookupFailed = true;
          break;
        }
      }
      if (lookupFailed) continue;   // fail closed: keep everything rather than mass-delete on a bad read

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
    } catch (err) {
      log.warn(`Candidate prune (${spaceId}/${suffix}): ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  return result;
}

/** Prune every real (non-proxy) space. */
export async function pruneAllSpaces(): Promise<void> {
  let cfg;
  try { cfg = getConfig(); } catch { return; }   // pre-setup
  let merged = 0, orphaned = 0;
  for (const s of cfg.spaces) {
    if (s.proxyFor) continue;
    const r = await pruneSpaceCandidates(s.id);
    merged += r.merged; orphaned += r.orphaned;
  }
  if (merged + orphaned > 0) {
    log.info(`Candidate prune: removed ${orphaned} finding(s) whose records are gone and ${merged} merged pair(s)`);
  }
}

let _timer: NodeJS.Timeout | null = null;

/**
 * Start the background prune. Always on — unlike the scanners it has no cost worth gating and no behaviour
 * an operator would want to opt out of: it only removes findings that cannot be acted on.
 */
export function startCandidatePrune(): void {
  if (_timer) return;
  _timer = setInterval(() => { void runExclusive('Candidate prune', () => pruneAllSpaces()); }, PRUNE_INTERVAL_MS);
  _timer.unref();   // never keep the process alive for housekeeping
  log.debug('Candidate prune worker started');
}

export function stopCandidatePrune(): void {
  if (_timer) { clearInterval(_timer); _timer = null; }
}

