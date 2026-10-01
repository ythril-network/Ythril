/**
 * The two background job queues' documents: file and media embedding (`MediaJobDoc`) and brain-record embedding
 * (`BrainEmbedJobDoc`).
 *
 * Split out of `types.ts` (`Q-166`) when it passed its size limit, the way `types-networks.ts` was: one question per
 * file — what a queued job looks like — and re-exported from `types.ts`, so no importer changes. `RecordType` is
 * imported from the `types-knowledge.ts` LEAF, never from `types.ts`: importing it back would be a module cycle, the
 * failure that degraded `NetworkConfig` to `any` when that split was first tried.
 */
import type { RecordType } from './types-knowledge.js';

/**
 * Background job record for asynchronous media embedding (caption/STT + chunking)
 * and text document embedding (chunking + vector embedding).
 * Stored in the per-space `<spaceId>_media_jobs` collection and claimed by the
 * MediaEmbeddingWorker. The corresponding filemeta record's `embeddingStatus`
 * mirrors `status` (pending/processing/complete/failed).
 */
export interface MediaJobDoc {
  _id: string;                // file _id (normalised path) — one job per file
  spaceId: string;
  filePath: string;           // normalised path on disk
  mimeType: string;           // raw upload MIME type
  mediaType: 'image' | 'audio' | 'video' | 'text';
  /** For text jobs: the resolved document format (md, txt, html, pdf, docx, epub). */
  resolvedFormat?: string;
  status: 'pending' | 'processing' | 'complete' | 'failed';
  attempts: number;
  maxAttempts: number;
  lastError: string | null;
  claimedAt: string | null;   // ISO8601 — set when a worker claims this job
  /**
   * ISO8601 — last time this job did something. Set when claimed, then advanced by the worker every
   * time a unit of work completes (a page rendered, a page transcribed, a stage finished).
   *
   * Stall detection reads THIS, not `claimedAt`. A wall-clock deadline measured from the claim
   * cannot tell "wedged" from "slow", so a genuinely long job — a 400-page PDF being transcribed a
   * page at a time — was requeued mid-flight for the crime of taking a while, then re-claimed and
   * killed again at the same point: an infinite loop that burns the model budget and never finishes.
   * Measuring from the last sign of life means the timeout fires only when nothing is happening.
   */
  progressAt?: string | null;
  /**
   * The last step report from the worker: which stage is running, the full route this document
   * takes, and how far through the current stage it is. Written in the same update as the
   * heartbeat, so surfacing progress costs no extra writes.
   */
  progress?: { step: string; steps: string[]; done?: number; total?: number };
  /**
   * Identifies the RUN that holds this job, not the job. Set on claim, cleared by stall recovery.
   *
   * Every heartbeat matches on it, so a run whose job was recovered while it was still working discovers
   * that on its next tick and abandons — instead of embedding the same file alongside the new claimant,
   * writing the same chunk ids, and possibly reporting `complete` on a job the queue has re-queued.
   * Absent on jobs claimed by a build that predates the field; the heartbeat then behaves as it used to.
   */
  claimToken?: string | null;
  /**
   * ISO8601 — when set on a `pending` job, the worker MUST NOT claim it
   * until this timestamp has passed. Used for exponential retry backoff so
   * a fast-failing "poison pill" job can’t monopolise the queue and starve
   * sibling jobs that would otherwise succeed. Cleared on success/manual retry.
   */
  claimableAfter?: string | null;
  /**
   * How many times a run has committed its results under this job's claim (`writeUnderClaim`). Its value is never
   * read: the increment exists because a fence has to WRITE the job document for the database to order it against a
   * concurrent revocation — a matching read, or a `$set` of a value already stored, conflicts with nothing.
   */
  fencedWrites?: number;
  createdAt: string;          // ISO8601
  updatedAt: string;          // ISO8601
}


/**
 * The brain record types that carry their own embedding and therefore their own embedding job.
 *
 * `file` is deliberately absent: file and media embedding already has its own queue
 * (`files/media/job-queue.ts`) with a richer job shape — per-page progress, chunking, a provider
 * signature. Folding it in here would replace a working, more capable mechanism with a simpler one.
 */
/**
 * `file` joined the four brain types on 2026-08-07, and for a correctness reason rather than tidiness.
 *
 * `updateFileMeta` used to compute the vector itself from the record as it had READ it, while every content
 * field it wrote was guarded by `opts.X !== undefined` and the embedding was not. Two concurrent writes to
 * different fields therefore both landed, lost no field, and left the stored vector describing a record that
 * existed nowhere. The four brain updates had the identical defect and were fixed by handing the work to this
 * queue, whose `embedStoredRecord` re-reads the document after the write; files needed to be IN the queue
 * before the same fix could apply to them.
 *
 * The alternative — a second re-embed mechanism just for files — is what produced the bug in the first place:
 * the update path had its own copy of the embed-text builder while the queue had `buildEmbedText`.
 */
/** One of the five names this repo had for {@link RecordType}. Kept as an alias so call sites read well. */
export type BrainEmbedRecordType = RecordType;

/**
 * One queued embedding job. `_id` is `<recordType>:<recordId>`, so a record rewritten five times has
 * ONE job holding its latest content rather than five queued deep.
 *
 * A completed job is deleted rather than kept — the record itself carries `embeddingStatus`, so a
 * retained job would be a second copy of one fact, and brain records outnumber files by orders of
 * magnitude.
 */
export interface BrainEmbedJobDoc {
  /** `<recordType>:<recordId>` — see `embedJobId`. */
  _id: string;
  spaceId: string;
  recordType: BrainEmbedRecordType;
  recordId: string;
  status: 'pending' | 'processing' | 'failed';
  /**
   * The PERMANENT-failure budget. Spent only on errors that a retry cannot fix — a malformed input, a 400
   * from a reachable embedder. See `transientFailures` for the other kind.
   */
  attempts: number;
  maxAttempts: number;
  /**
   * How many times this job has failed for a reason that is not its own: the embedder unreachable, a 503, a
   * rate limit. Absent on every job written before this existed, which reads as 0.
   *
   * It is separate from `attempts` because the two answer different questions and one counter cannot do
   * both. `attempts` decides when to give up; this decides how long to wait. Counting an outage against the
   * budget is what took every queued job in every space terminal at once during an upgrade — five attempts
   * over twelve and a half minutes, spent on a sidecar that was restarting.
   */
  transientFailures?: number;
  /**
   * How many times this job was in flight when the local inference process was lost. Absent reads as 0. Counted
   * separately from `transientFailures` because it is the one transient failure that ends a job: an input that
   * kills the runtime looks like an embedder outage for ever, so after `MAX_LOST_CHILD_FAILURES` the job is left
   * `failed`, naming the crash in `lastError`. Reset by a retry, a rewrite and a new server version.
   */
  lostChildFailures?: number;
  lastError: string | null;
  /** ISO8601 — set when a worker claims this job. */
  claimedAt: string | null;
  /**
   * ISO8601 — last sign of life. Stall detection reads THIS, not `claimedAt`: a deadline measured from
   * the claim cannot tell "wedged" from "slow", and a cold model load is slow.
   */
  progressAt?: string | null;
  /** ISO8601 — retry backoff; the job is `pending` but not claimable until this passes. */
  claimableAfter?: string | null;
  /** Identifies THIS run of THIS job, so a recovered job's old holder learns it was replaced. */
  claimToken?: string | null;
  /**
   * The server version this job was last revived FOR — see `reviveFailedEmbedJobs`.
   *
   * A terminal `failed` job is never claimed again, so a systemic outage during an upgrade could take every
   * job in every space terminal and nothing would ever run them. This field is what makes the repair
   * bounded: one clean attempt per version, absent meaning "never revived", so a restart on the same
   * version cannot churn a genuinely-bad record.
   */
  revivedForVersion?: string | null;
  /**
   * Which lane the job is claimed in: 0 a local write somebody may be waiting to search for, 1 work that arrived on
   * its own (a peer's record, a backfill), 2 a reindex rebuild. Absent on a job written before lanes existed, which
   * claims as 0. Only ever lowered (`$min`), so a write into a queued rebuild makes it urgent and never the reverse.
   */
  priority?: 0 | 1 | 2;
  /** Set by a reindex: rebuild the vector even when its text and model name are unchanged. */
  rebuild?: boolean;
  createdAt: string;
  updatedAt: string;
}
