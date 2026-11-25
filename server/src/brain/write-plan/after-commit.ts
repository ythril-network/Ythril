/**
 * What follows a planned write once its records are COMMITTED — the one runner of it for both commits (`Q-760`).
 *
 * ## The question it answers
 *
 * *"These records landed: take back what names an entity removed meanwhile, queue their embed jobs, run their duplicate rules, and say what
 * did not happen."* `commitPlans` (`commit.ts`) asks it per stage, as it always did; the group commit (`write-group.ts`) asks it once, after
 * its transaction committed.
 *
 * ## What it prevents
 *
 * **An effect of a write that never landed.** Inside a group's transaction nothing is visible until the commit, and an aborted group leaves
 * nothing: an embed job queued, a duplicate rule run or a take-back made from inside the callback would act on records that may never exist,
 * or miss the rows it is meant to check (the take-back's two-sided handshake needs the write visible, `gone-entity-references.ts`). So these
 * effects take a list of LANDED records and run here, never inside a transaction.
 *
 * **A failure that is said nowhere.** An effect that fails after a commit is not the write's failure (the records are stored, and saying
 * otherwise invites a duplicating resend), and it is not nothing either: each failed effect is logged once AND returned, so the caller can
 * report it (`failed`). Nothing here throws.
 *
 * ## What it does not do
 *
 * It writes no record and no link row of its own: a take-back removes, through the one remover (`removeRecords`, `removeWithTombstones`),
 * rows that a write landed against an entity that was deleted or merged away meanwhile. Webhooks are the door's.
 */
import { log, peerText } from '../../util/log.js';
import { mapLimit } from '../../util/map-limit.js';
import { enqueueWriteEmbedJobs, EMBED_PRIORITY } from '../embed-queue.js';
import { takeBackEdgesToGoneEntities, takeBackLinksToGoneEntities } from '../gone-entity-references.js';
import type { RefKind } from '../../config/types-knowledge.js';
import type { PlanKind } from './types.js';

/** Insert-time duplicate rules run at most this many at once — each is a vector search. */
const DUPE_RULE_CONCURRENCY = 4;

/** A landed edge whose entity ends are checked against entities removed meanwhile. */
export interface LandedEdge { readonly _id: string; readonly from: string; readonly to: string; readonly fromKind?: RefKind; readonly toKind?: RefKind }
/** A landed link row, checked likewise; `seq` is the version it landed at (its tombstone carries it). */
export interface LandedLinkRow { readonly _id: string; readonly to: string; readonly toKind: string; readonly seq: number }

/** The effects owed to records that landed. Every list is optional; an absent or empty one costs nothing. */
export interface AfterCommitEffects {
  /** Edges to take back when an entity end was removed while they were written. */
  readonly edges?: readonly LandedEdge[];
  /** Link rows to take back when the entity they point at was removed while they were written. */
  readonly linkRows?: readonly LandedLinkRow[];
  /** Records to queue for embedding. A record whose edge was taken back above is not queued. */
  readonly embed?: ReadonlyArray<{ readonly recordType: PlanKind; readonly recordId: string }>;
  /** Records whose insert-time duplicate rules run (never awaited). */
  readonly dupeRules?: ReadonlyArray<{ readonly kind: PlanKind; readonly id: string }>;
}

/** One effect that did not complete after its records landed: what it was, how many records it was for, and why. */
export interface FailedEffect {
  readonly effect: 'edge-take-back' | 'link-take-back' | 'embed';
  readonly count: number;
  readonly error: unknown;
}

/** What the effects did: what was taken back (a LANDED row removed again), and what failed. */
export interface AfterCommitReport {
  /** Edge id to the entity end that was gone. */
  readonly edgesTakenBack: ReadonlyMap<string, { readonly id: string; readonly side: 'from' | 'to' }>;
  /** Link id to the id of the entity it pointed at. */
  readonly linksTakenBack: ReadonlyMap<string, string>;
  readonly failed: readonly FailedEffect[];
}

/**
 * Run the effects owed to records that landed in `spaceId` — see the module docblock. `what` names the writer in the log (`write commit`,
 * `write group`). Never throws.
 */
export async function runAfterCommit(spaceId: string, effects: AfterCommitEffects, what: string): Promise<AfterCommitReport> {
  const failed: FailedEffect[] = [];
  let edgesTakenBack: ReadonlyMap<string, { id: string; side: 'from' | 'to' }> = new Map();
  let linksTakenBack: ReadonlyMap<string, string> = new Map();
  const edges = effects.edges ?? [];
  if (edges.length > 0) {
    try {
      edgesTakenBack = await takeBackEdgesToGoneEntities(spaceId, edges);
    } catch (error) {
      failed.push({ effect: 'edge-take-back', count: edges.length, error });
      log.warn(`${what}: ${edges.length} edge(s) written to '${peerText(spaceId)}' could not be checked against entities removed meanwhile: ${peerText(error)}`);
    }
  }
  const linkRows = effects.linkRows ?? [];
  if (linkRows.length > 0) {
    try {
      linksTakenBack = await takeBackLinksToGoneEntities(spaceId, linkRows);
    } catch (error) {
      failed.push({ effect: 'link-take-back', count: linkRows.length, error });
      log.warn(`${what}: ${linkRows.length} link row(s) written to '${peerText(spaceId)}' could not be checked against entities removed meanwhile: ${peerText(error)}`);
    }
  }
  // An edge taken back has nothing to embed.
  const toQueue = (effects.embed ?? []).filter(r => !(r.recordType === 'edge' && edgesTakenBack.has(r.recordId)));
  if (toQueue.length > 0) {
    // The write lane never throws by contract (it answers how many it could not queue); the catch holds this module to its own promise whatever the lane does.
    const queued = await enqueueWriteEmbedJobs(spaceId, toQueue, { priority: EMBED_PRIORITY.write })
      .catch((error: unknown) => ({ queued: 0, failed: toQueue.length, error }));
    if (queued.failed > 0) {
      // The lane says its own failure in the log; one it threw (it never should) is said here.
      const thrown = 'error' in queued;
      const error = thrown ? queued.error : new Error(`${queued.failed} embed job(s) were not queued`);
      failed.push({ effect: 'embed', count: queued.failed, error });
      if (thrown) log.warn(`${what}: ${queued.failed} record(s) in '${peerText(spaceId)}' were written but not queued for embedding: ${peerText(String(error))}`);
    }
  }
  runDupeRules(spaceId, effects.dupeRules ?? []);
  return { edgesTakenBack, linksTakenBack, failed };
}

/** Insert-time duplicate rules for the landed records that asked for them — bounded, and never awaited by the write. */
function runDupeRules(spaceId: string, records: ReadonlyArray<{ kind: PlanKind; id: string }>): void {
  if (records.length === 0) return;
  // The dynamic import avoids a static cycle with dupe-scanner.js.
  void import('../dupe-scanner.js').then(m => mapLimit(records, DUPE_RULE_CONCURRENCY, async (p) => {
    try { await m.evaluateRecordForDuplicates(spaceId, p.kind as Parameters<typeof m.evaluateRecordForDuplicates>[1], p.id); }
    catch { /* best-effort: a duplicate rule never fails the write it follows */ }
  })).catch(() => { /* best-effort */ });
}
