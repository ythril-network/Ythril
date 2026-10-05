/**
 * Re-embedding a space: the refusals, the single-job guard, and the walk that rebuilds every record.
 *
 * ## Why this is a module and not a route
 *
 * `reindex` was the last row of `REST_ONLY_CAPABILITIES` -- five capabilities a token could HOLD and not exercise
 * over MCP -- and the only one that could not be closed by wrapping something, because there was nothing to wrap.
 * The work lived inline in the route handler: five near-identical batch loops, each with its own projection, its own
 * `*EmbedText` builder and its own per-record error tolerance. Their workaround measured the gap: 14 spaces plus 5
 * personal ones reindexed by curl in a shell loop, because the agent that planned their embedder migration could not
 * run it.
 *
 * ## The split, and the two things that had to move WITH the work
 *
 * `planReindex` decides -- 404, the proxy refusal, the single-job 409 -- and `startReindex` runs. What is easy to get
 * wrong is that the **guard and the metric belong to the work, not to the route**: `reindexJobRunning` was module
 * state in the router, so a second surface calling the loop directly would have run a concurrent job the guard could
 * not see, and `reindexInProgress` would have been left at 1 by whichever job finished second.
 *
 * `startReindex` returns as soon as the job is SCHEDULED, which is the contract the route already had: the response
 * carries `status: 'started'` with zeroed counters, and the work runs on the next turn so headers flush immediately.
 * Awaiting the work would turn a multi-minute job into a request timeout while still answering 200.
 *
 * ## Two properties of the walk that are easy to lose
 *
 *  - **A re-embed is not a write.** `embedStoredRecord` stores the embedding fields with a direct `$set` rather than
 *    through the record update path, so `seq` and `updatedAt` do not move. Routing them through `updateFact` would
 *    look tidier and would bump `seq` on every record in the space -- a sync-visible change on every peer, for a
 *    local re-embed that changed no content.
 *  - **Each record embeds the text its WRITE embedded, because this module builds none.** It was five hand-written
 *    loops, one per collection, each with its own projection and its own `*EmbedText` call, and they had drifted from
 *    the writers in three ways at once (Q-99 part 2): the edge loop projected no `fromKind`/`toKind`, so an edge with
 *    a fact or file end embedded that end's raw id; the file loop projected no `excerpt` though it passed one, so every
 *    converted document re-embedded without its own text; and the loop skipped every derived record (`parentFileId`),
 *    so passages, captions and transcripts kept the OLD model's vectors after a model change, for ever. Every record
 *    is now rebuilt through `embedStoredRecord(..., { rebuild: true })`, which reads the whole stored document and
 *    builds its text in `buildEmbedText`, the one derivation the queue, a sync arrival and a backfill use too.
 *    `rebuild` forces past the "unchanged" skip (a model change keeps the text and still needs a new vector), and
 *    a transient embedder failure leaves the old vector in place rather than stripping a space during an outage.
 *
 * Both are pinned: `integration/reindex-contract.test.js` for the contract and the `seq` property,
 * `standalone/reindex-embeds-the-same-text.test.js` for the structure (this module builds no text), and
 * `standalone/a-rebuild-embeds-what-the-producer-embedded-db.test.js` for the text itself, per kind.
 */
import { col, asFilter } from '../db/mongo.js';
import { COLLECTION, embedStoredRecord } from './embed-record.js';
import { clearReindexFlag } from '../spaces/_shared.js';
import { reindexInProgress } from '../metrics/registry.js';
import { log, peerText } from '../util/log.js';
import type { SpaceConfig, BrainEmbedRecordType } from '../config/types.js';
import { spaceCollection, type SpacePart } from '../db/space-collection.js';

/** Every record kind that carries a vector, derived from `COLLECTION` so a new kind is reindexed the day it exists. */
const REINDEX_KINDS = Object.keys(COLLECTION) as BrainEmbedRecordType[];

/**
 * One job per process, and the guard lives HERE.
 *
 * It was module state in the router, which was correct while the router was the only caller. The moment a second
 * surface can start a reindex, a guard that surface cannot see is not a guard: two concurrent jobs would re-embed the
 * same records, and `reindexInProgress` would be left at 1 by whichever finished second.
 */
let reindexJobRunning = false;

/** A refusal, carrying the status the contract suite pins. */
export type ReindexRefusal = {
  status: 400 | 404 | 409;
  body: { error: string; proxyFor?: string[] };
};

export type ReindexPlan = {
  spaceId: string;
  /** The member spaces to walk -- for a normal space, itself. Resolved by the caller, which knows the token scope. */
  memberIds: string[];
};

export type ReindexDecision =
  | { ok: false; refusal: ReindexRefusal }
  | { ok: true; plan: ReindexPlan };

/**
 * Decide a reindex: refuse it, or return the job to start.
 *
 * `memberIds` is passed in rather than resolved here because scope resolution differs per surface -- REST narrows by
 * request, MCP by the token's accessible spaces -- and re-deriving it here would be a second place for the two to
 * disagree about which spaces a token may touch.
 */
export function planReindex(input: {
  spaceId: string;
  space: SpaceConfig | undefined;
  memberIds: string[];
}): ReindexDecision {
  const { spaceId, space, memberIds } = input;

  if (!space) {
    return { ok: false, refusal: { status: 404, body: { error: `Space '${spaceId}' not found` } } };
  }

  /**
   * A PROXY is refused, by name, with its members listed.
   *
   * It used to answer `200 {"status":"started"}` and then re-embed the member spaces -- which the caller was also
   * reindexing individually, because they are in the same space list. Everything under the proxy got embedded twice.
   * It is idempotent, so nothing broke: on the reporting operator's largest instance it was simply the longest job of
   * the run, and all of it was waste.
   *
   * The caller could not avoid it either. `GET /api/spaces` returns ids with no indication of which are proxies, so
   * there was nothing to branch on -- which is why this is a refusal rather than a note in the docs. It is also what
   * the rest of the model already does: a WRITE to a proxy requires an explicit `targetSpace`, because a proxy is not
   * a place records live.
   *
   * The members are named in the message so the remedy is the response rather than a second lookup.
   */
  if (space.proxyFor && space.proxyFor.length > 0) {
    return {
      ok: false,
      refusal: {
        status: 400,
        body: {
          error: `'${spaceId}' is a proxy space and has no index of its own. `
            + `Reindex its members instead: ${space.proxyFor.join(', ')}.`,
          proxyFor: space.proxyFor,
        },
      },
    };
  }

  if (reindexJobRunning) {
    return { ok: false, refusal: { status: 409, body: { error: 'Reindex already in progress' } } };
  }

  return { ok: true, plan: { spaceId, memberIds } };
}

/**
 * Take the guard and SCHEDULE the work, then return.
 *
 * Never awaits the job. Both surfaces answer immediately with zeroed counters, and progress is read from
 * `reindex-status` or the log. The guard is released in a `finally` around the whole job, so a throw anywhere in the
 * walk cannot wedge the process into refusing every later reindex until a restart.
 */
export function startReindex(plan: ReindexPlan): void {
  const { spaceId, memberIds } = plan;
  reindexJobRunning = true;
  reindexInProgress.set(1);

  // Start heavy work on the next turn so HTTP headers flush immediately.
  setImmediate(() => {
    void (async () => {
      let reindexed = 0;
      // Counted separately from `errors`: a suppressed record is not a failure, it is the flag working.
      // Reported because a reindex that says `reindexed=0` over a suppressed space would otherwise read
      // as broken, and an operator would go looking for a fault that is a setting.
      let suppressed = 0;
      let errors = 0;
      try {
        for (const mid of memberIds) {
          const BATCH = 50;
          for (const kind of REINDEX_KINDS) {
            // Ids only: `embedStoredRecord` reads the whole stored document itself, which is what keeps this walk
            // from choosing a projection — the projections are where the five loops it replaced had drifted.
            // Derived records (passages, captions, transcripts, face crops) are walked too: one with text is
            // rebuilt from it, one without loses any path-vector a backfill gave it (`textless`).
            let cursor: string | null = null;
            while (true) {
              const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
              const batch = await col(spaceCollection(mid, COLLECTION[kind] as SpacePart))
                .find(asFilter(q), { projection: { _id: 1 } })
                .sort({ _id: 1 })
                .limit(BATCH)
                .toArray() as Array<{ _id: unknown }>;
              if (batch.length === 0) break;
              for (const doc of batch) {
                if (typeof doc._id !== 'string') continue;
                try {
                  const outcome = await embedStoredRecord(mid, kind, doc._id, { rebuild: true });
                  if (outcome === 'embedded') reindexed++;
                  else if (outcome === 'excluded') suppressed++;
                } catch { errors++; }
              }
              const last = batch[batch.length - 1]?._id;
              cursor = typeof last === 'string' ? last : null;
              if (cursor === null) break;
            }
          }

          clearReindexFlag(mid);
        }
        log.info(`Reindex completed for space '${peerText(spaceId)}': reindexed=${reindexed}, suppressed=${suppressed}, errors=${errors}`);
      } catch (err) {
        log.error(`Reindex job failed for space '${peerText(spaceId)}': ${peerText(err)}`);
      } finally {
        reindexJobRunning = false;
        reindexInProgress.set(0);
      }
    })();
  });
}
