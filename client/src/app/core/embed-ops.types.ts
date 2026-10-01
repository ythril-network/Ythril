/**
 * What the embedding operations on a space answer: a backfill (`reembed`) and a reindex.
 *
 * Their own module because `api.types.ts` is frozen by the size ratchet, and these three belong together: a backfill
 * and a reindex are the two ways a space's vectors are made again, and a reader comparing what each reports should
 * not have to find them six hundred lines apart.
 */

/**
 * What `POST /api/spaces/:id/reembed` reports back.
 *
 * `remaining` is counted over the whole space rather than the returned page, so `truncated` genuinely means "call
 * again" — a backfill that quietly stopped at a round number would read as a fully-indexed space.
 *
 * `skippedSuppressed` is how the UI can say "suppression is still on" instead of showing a successful no-op.
 */
export interface ReembedResult {
  spaceId: string;
  enqueued: number;
  skippedSuppressed: number;
  byKind: Record<string, number>;
  remaining: number;
  truncated: boolean;
}

/** A space's reindex run, as `GET /api/brain/spaces/:id/reindex-status` and `space_meta` report it. */
export interface ReindexRunState {
  /** A run is going: its records are queued and being rebuilt. */
  running: boolean;
  /** Records still to rebuild, including those the run has not queued yet. */
  remaining: number;
  /** Rebuild jobs that gave up; listed with the space's embed jobs. */
  failed: number;
}

/** `GET /api/brain/spaces/:id/reindex-status`. */
export interface ReindexStatus {
  spaceId: string;
  /** Recall refuses in this space until it is false. */
  needsReindex: boolean;
  reindexRun: ReindexRunState;
}
