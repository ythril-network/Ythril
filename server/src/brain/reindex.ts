/**
 * Re-embedding a space: the refusals, the single-job guard, and the five collection loops.
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
 * ## Two properties of the loops that are easy to lose
 *
 *  - **A re-embed is not a write.** The embedding fields go in with a direct `$set` rather than through the record
 *    update path, so `seq` and `updatedAt` do not move. Routing them through `updateFact` would look tidier and
 *    would bump `seq` on every record in the space -- a sync-visible change on every peer, for a local re-embed that
 *    changed no content.
 *  - **Each collection embeds the text its WRITE path embeds.** These loops call the same `*EmbedText` builders the
 *    upsert paths call. Nothing stores `matchedText` here, so a vector built from the wrong argument order is
 *    indistinguishable through the API -- it keeps recall working while quietly disagreeing with every record written
 *    normally.
 *
 * Both are pinned, and both suites landed against the unmoved route: `integration/reindex-contract.test.js` for the
 * contract and the `seq` property, `standalone/reindex-embeds-the-same-text.test.js` for the builders -- the second
 * reads SOURCE because no runtime test can see which text was embedded.
 */
import { col, asFilter } from '../db/mongo.js';
import { embed } from './embedding.js';
import { embeddingSuppressedFor } from './suppress-embeddings.js';
import { factEmbedText, entityEmbedText, edgeEmbedText, chronoEmbedText, fileEmbedText } from './embed-text.js';
import { clearReindexFlag } from '../spaces/_shared.js';
import { resolveEdgeEndpointNames } from './edge-endpoint-names.js';
import { reindexInProgress } from '../metrics/registry.js';
import { log } from '../util/log.js';
import type { SpaceConfig, FactDoc, EntityDoc, EdgeDoc, ChronoEntry, FileMetaDoc } from '../config/types.js';

/**
 * One job per process, and the guard lives HERE.
 *
 * It was module state in the router, which was correct while the router was the only caller. The moment a second
 * surface can start a reindex, a guard that surface cannot see is not a guard: two concurrent jobs would re-embed the
 * same records, and `reindexInProgress` would be left at 1 by whichever finished second.
 */
let reindexJobRunning = false;

/** Whether a job is running. Both surfaces read this rather than each keeping its own flag. */
export function reindexRunning(): boolean {
  return reindexJobRunning;
}

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
 * five loops cannot wedge the process into refusing every later reindex until a restart.
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

            // Re-embed facts
            {
              let cursor: string | null = null;
              // eslint-disable-next-line no-constant-condition
              while (true) {
                const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
                const batch: FactDoc[] = await col<FactDoc>(`${mid}_facts`)
                  .find(asFilter<FactDoc>(q), { projection: { _id: 1, fact: 1, tags: 1, entityIds: 1, description: 1, properties: 1, type: 1, suppressEmbeddings: 1,} })
                  .sort({ _id: 1 })
                  .limit(BATCH)
                  .toArray() as FactDoc[];
                if (batch.length === 0) break;
                for (const doc of batch) {
                  try {
                    if (embeddingSuppressedFor(mid, 'fact', doc as unknown as Record<string, unknown>)) { suppressed++; continue; }
                    const result = await embed(factEmbedText(doc.fact, doc.tags ?? [], doc.description, doc.properties));
                    await col<FactDoc>(`${mid}_facts`).updateOne(
                      { _id: doc._id },
                      { $set: { embedding: result.vector, embeddingModel: result.model } },
                    );
                    reindexed++;
                  } catch { errors++; }
                }
                cursor = batch[batch.length - 1]?._id ?? null;
              }
            }

            // Re-embed entities (name + type + tags + description + properties)
            {
              let cursor: string | null = null;
              // eslint-disable-next-line no-constant-condition
              while (true) {
                const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
                const batch: EntityDoc[] = await col<EntityDoc>(`${mid}_entities`)
                  .find(asFilter<EntityDoc>(q), { projection: { _id: 1, name: 1, type: 1, tags: 1, description: 1, properties: 1, suppressEmbeddings: 1,} })
                  .sort({ _id: 1 })
                  .limit(BATCH)
                  .toArray() as EntityDoc[];
                if (batch.length === 0) break;
                for (const doc of batch) {
                  try {
                    if (embeddingSuppressedFor(mid, 'entity', doc as unknown as Record<string, unknown>)) { suppressed++; continue; }
                    const result = await embed(entityEmbedText(doc.name, doc.type, doc.tags ?? [], doc.description, doc.properties ?? {}));
                    await col<EntityDoc>(`${mid}_entities`).updateOne(
                      { _id: doc._id },
                      { $set: { embedding: result.vector, embeddingModel: result.model } },
                    );
                    reindexed++;
                  } catch { errors++; }
                }
                cursor = batch[batch.length - 1]?._id ?? null;
              }
            }

            // Re-embed edges (tags + from-name + label + to-name + type + description + properties)
            {
              let cursor: string | null = null;
              // eslint-disable-next-line no-constant-condition
              while (true) {
                const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
                const batch: EdgeDoc[] = await col<EdgeDoc>(`${mid}_edges`)
                  .find(asFilter<EdgeDoc>(q), { projection: { _id: 1, from: 1, label: 1, to: 1, type: 1, tags: 1, description: 1, properties: 1, suppressEmbeddings: 1,} })
                  .sort({ _id: 1 })
                  .limit(BATCH)
                  .toArray() as EdgeDoc[];
                if (batch.length === 0) break;
                for (const doc of batch) {
                  try {
                    // Resolve from/to to entity NAMES (not IDs) and include properties — matching
                    // edgeEmbedText so a reindex reproduces exactly what upsertEdge embedded.
                    const [fromName, toName] = await resolveEdgeEndpointNames(mid, doc.from, doc.to, doc.fromKind, doc.toKind);
                    if (embeddingSuppressedFor(mid, 'edge', doc as unknown as Record<string, unknown>)) { suppressed++; continue; }
                    const result = await embed(edgeEmbedText(fromName, doc.label, toName, doc.tags ?? [], doc.type, doc.description, doc.properties));
                    await col<EdgeDoc>(`${mid}_edges`).updateOne(
                      { _id: doc._id },
                      { $set: { embedding: result.vector, embeddingModel: result.model } },
                    );
                    reindexed++;
                  } catch { errors++; }
                }
                cursor = batch[batch.length - 1]?._id ?? null;
              }
            }

            // Re-embed chrono (type + status + title + tags + description + properties)
            {
              let cursor: string | null = null;
              // eslint-disable-next-line no-constant-condition
              while (true) {
                const q: Record<string, unknown> = cursor ? { _id: { $gt: cursor } } : {};
                const batch: ChronoEntry[] = await col<ChronoEntry>(`${mid}_chrono`)
                  .find(asFilter<ChronoEntry>(q), { projection: { _id: 1, title: 1, type: 1, status: 1, description: 1, tags: 1, properties: 1, suppressEmbeddings: 1,} })
                  .sort({ _id: 1 })
                  .limit(BATCH)
                  .toArray() as ChronoEntry[];
                if (batch.length === 0) break;
                for (const doc of batch) {
                  try {
                    if (embeddingSuppressedFor(mid, 'chrono', doc as unknown as Record<string, unknown>)) { suppressed++; continue; }
                    const result = await embed(chronoEmbedText(doc.title, doc.type, doc.status, doc.description, doc.tags ?? [], doc.properties));
                    await col<ChronoEntry>(`${mid}_chrono`).updateOne(
                      { _id: doc._id },
                      { $set: { embedding: result.vector, embeddingModel: result.model } },
                    );
                    reindexed++;
                  } catch { errors++; }
                }
                cursor = batch[batch.length - 1]?._id ?? null;
              }
            }

            // Re-embed files (path + entity names + tags + description + property values)
            {
              let cursor: string | null = null;
              // eslint-disable-next-line no-constant-condition
              while (true) {
                // Exclude chunk records (parentFileId set) — they have their own embedding logic
                const q: Record<string, unknown> = cursor
                  ? { _id: { $gt: cursor }, parentFileId: { $exists: false } }
                  : { parentFileId: { $exists: false } };
                const batch: FileMetaDoc[] = await col<FileMetaDoc>(`${mid}_files`)
                  .find(asFilter<FileMetaDoc>(q), { projection: { _id: 1, path: 1, tags: 1, description: 1, properties: 1, entityIds: 1, suppressEmbeddings: 1,} })
                  .sort({ _id: 1 })
                  .limit(BATCH)
                  .toArray() as FileMetaDoc[];
                if (batch.length === 0) break;
                for (const doc of batch) {
                  try {
                    // `excerpt` included, or a reindex would silently re-embed every converted document
                    // without the document's own text — dropping exactly the phrases a reader searches for.
                    if (embeddingSuppressedFor(mid, 'file', doc as unknown as Record<string, unknown>)) { suppressed++; continue; }
                    const result = await embed(fileEmbedText(doc.path, doc.tags ?? [], doc.description, doc.properties, doc.excerpt));
                    await col<FileMetaDoc>(`${mid}_files`).updateOne(
                      { _id: doc._id },
                      { $set: { embedding: result.vector, embeddingModel: result.model } },
                    );
                    reindexed++;
                  } catch { errors++; }
                }
                cursor = batch[batch.length - 1]?._id ?? null;
              }
            }

              clearReindexFlag(mid);
            }
        log.info(`Reindex completed for space '${spaceId}': reindexed=${reindexed}, suppressed=${suppressed}, errors=${errors}`);
      } catch (err) {
        log.error(`Reindex job failed for space '${spaceId}': ${String(err)}`);
      } finally {
        reindexJobRunning = false;
        reindexInProgress.set(0);
      }
    })();
  });
}
