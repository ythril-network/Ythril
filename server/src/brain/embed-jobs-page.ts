/**
 * One page of a space's brain embed queue — counts summed over its members, jobs merged in one total order — for
 * both doors (`Q-109`).
 *
 * REST `GET …/embedding-queue/records` paged across a proxy's members with `skip` and summed their counts; MCP
 * `list_embed_jobs` read only the named space and took no `skip`, so it could report `failed: 500` beside a list that
 * never reaches failure #201. They also disagreed on the ceiling: MCP refused a `limit` over 200, REST echoed the 500
 * it was sent and `listEmbedJobs` quietly served 200. The caps live here now, stated once, and a value past them is
 * refused rather than served smaller.
 */
import { listEmbedJobs, getEmbedJobCounts } from './embed-queue.js';
import { pageAcrossMembers } from '../spaces/page-across-members.js';
import { PROXY_PAGE_CEILING } from './query.js';
import type { BrainEmbedJobDoc } from '../config/types.js';

/** The page size when the caller names none. */
export const DEFAULT_JOB_PAGE = 50;
/** The largest page — the one `listEmbedJobs` itself will read. */
export const MAX_JOB_PAGE = 200;
export const JOB_STATUSES = ['pending', 'processing', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/**
 * A job as it is listed. `claimToken` never leaves the server — it is a lease secret, and a caller that could read it
 * could steal a job from the worker holding it. `spaceId` is the MEMBER it lives in: without it a proxy caller sees a `recordId` and cannot
 * tell which member to retry it in, which would make the listing unactionable through the surface it is meant for.
 */
export function jobOnTheWire(job: BrainEmbedJobDoc, spaceId: string) {
  return {
    recordType: job.recordType,
    recordId: job.recordId,
    spaceId,
    status: job.status,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    // Named in `list_embed_jobs`'s description as the field that tells an outage from a record that cannot be
    // embedded, and returned by neither door until Q-109 — a reading instruction for a number nobody was sent.
    transientFailures: job.transientFailures ?? 0,
    lastError: job.lastError,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  };
}
export type ListedJob = ReturnType<typeof jobOnTheWire>;

export type EmbedJobsPage =
  | { ok: false; error: string }
  | { ok: true; body: { counts: { pending: number; processing: number; failed: number }; jobs: ListedJob[]; limit: number; skip: number; status?: JobStatus } };

export async function embedJobsPage(
  members: readonly string[],
  opts: { status?: unknown; limit?: unknown; skip?: unknown },
): Promise<EmbedJobsPage> {
  const { status, limit, skip } = opts;
  if (status !== undefined && !JOB_STATUSES.includes(status as JobStatus)) {
    return { ok: false, error: `status must be one of ${JOB_STATUSES.join(', ')}` };
  }
  if (limit !== undefined && (!Number.isInteger(limit) || (limit as number) < 1 || (limit as number) > MAX_JOB_PAGE)) {
    return { ok: false, error: `limit must be an integer from 1 to ${MAX_JOB_PAGE}` };
  }
  if (skip !== undefined && (!Number.isInteger(skip) || (skip as number) < 0)) {
    return { ok: false, error: 'skip must be a non-negative integer' };
  }
  const effectiveLimit = (limit as number | undefined) ?? DEFAULT_JOB_PAGE;
  const effectiveSkip = (skip as number | undefined) ?? 0;

  const counts = { pending: 0, processing: 0, failed: 0 };
  for (const mid of members) {
    const c = await getEmbedJobCounts(mid);
    counts.pending += c.pending; counts.processing += c.processing; counts.failed += c.failed;
  }
  const page = await pageAcrossMembers<ListedJob>({
    members: [...members],
    limit: effectiveLimit,
    skip: effectiveSkip,
    ceiling: PROXY_PAGE_CEILING,
    // Newest-first by `updatedAt`, with the record id breaking every tie so the order is TOTAL and pages cannot overlap.
    compare: (a, b) => (a.updatedAt === b.updatedAt
      ? (a.recordId < b.recordId ? 1 : a.recordId > b.recordId ? -1 : 0)
      : (a.updatedAt < b.updatedAt ? 1 : -1)),
    readMember: async (mid, lim, sk) =>
      (await listEmbedJobs(mid, { ...(status ? { status: status as JobStatus } : {}), limit: lim, skip: sk })).map(j => jobOnTheWire(j, mid)),
  });
  if (!page.ok) return { ok: false, error: page.error };
  return {
    ok: true,
    body: { counts, jobs: page.rows, limit: effectiveLimit, skip: effectiveSkip, ...(status ? { status: status as JobStatus } : {}) },
  };
}
