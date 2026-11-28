/**
 * The embed queue's vocabulary: its lanes, the statuses a job stands in, the lane a stored priority is claimed in, and the count shapes built
 * from them (Q-182).
 *
 * ## The question it answers
 *
 * "Which names does the embed queue use for its lanes and its job statuses?" The queue (which counts and claims), the jobs page (which filters by
 * status and sums counts), the `ythril_embed_jobs{lane,status}` gauge and the claim-age histogram (which label by them) each read the answer
 * here, so a lane or a status cannot be named two ways and a fourth status added to the list reaches every reader at once.
 *
 * ## What it prevents
 *
 * The statuses were written out three times (the page's filter, the queue's count, the metric) and the count shape `{ pending, processing,
 * failed }` four times more; the lane names stood in a file named for how long a claim waited. A hand-written copy agrees with the list only
 * until somebody edits one of them.
 *
 * It is a LEAF: it imports nothing, so no import cycle can run through it (the registry imports the modules that import the queue, so the
 * queue cannot import the registry, and either can import this). `EMBED_PRIORITY` (`brain/embed-queue.ts`, `write: 0, background: 1,
 * rebuild: 2`) is the same set keyed by priority; `the-embed-queues-names-are-written-in-the-leaf-that-answers-for-them` holds that
 * `EMBED_PRIORITY[EMBED_LANE_NAMES[i]] === i` for every lane.
 */

/** The queue's lanes by priority (`EMBED_PRIORITY`): the index is the priority. */
export const EMBED_LANE_NAMES = ['write', 'background', 'rebuild'] as const;
export type EmbedLaneName = typeof EMBED_LANE_NAMES[number];

/** The statuses an embed job stands in: the one list the queue's count, the jobs page's filter and the `ythril_embed_jobs` gauge read. */
export const EMBED_JOB_STATUSES = ['pending', 'processing', 'failed'] as const;
export type EmbedJobStatus = typeof EMBED_JOB_STATUSES[number];

/** A number of jobs per status. */
export type EmbedJobCounts = Record<EmbedJobStatus, number>;
/** A number of jobs per lane and status. */
export type EmbedLaneCounts = Record<EmbedLaneName, EmbedJobCounts>;

/** A count of nothing per status, a fresh object each call (a caller adds to it). */
export function zeroEmbedJobCounts(): EmbedJobCounts {
  return Object.fromEntries(EMBED_JOB_STATUSES.map(status => [status, 0])) as EmbedJobCounts;
}

/**
 * The lane a job's stored priority is claimed in. A job with no priority, or one outside the lanes, is claimed as `write` (the claim's
 * `laneMatch` takes a missing priority in the write lane), so no series is ever labelled `undefined`.
 */
export function embedLaneOf(priority: unknown): EmbedLaneName {
  return (typeof priority === 'number' && EMBED_LANE_NAMES[priority]) || 'write';
}
