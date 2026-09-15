/**
 * Embed-queue tools: the brain-record half of the queue, readable and retryable over MCP.
 *
 * ## Both surfaces from the first commit
 *
 * The five capabilities the canary operator reported were all REST-only, each for the same reason: a route was written
 * first and a tool was going to follow. It never did, five times. So this pair ships WITH `embedding-queue/records`
 * rather than after it, and `REST_ONLY_CAPABILITIES` never gains a sixth row.
 *
 * ## Wrappers, deliberately
 *
 * `listEmbedJobs` / `retryEmbedJob` are the same functions the REST routes call. The retry reset (status, attempts,
 * lastError, claim fields) is a state machine, and a second copy of a state machine is the copy nobody watches when it
 * drifts. What these handlers own is the MCP-shaped part: argument validation and text a model can act on.
 */
import { resolveWriteTarget } from '../../spaces/proxy.js';
import { memberSpacesWithin } from '../../spaces/proxy-scoped.js';
import {
  listEmbedJobs, getEmbedJobCounts, retryEmbedJob, EMBED_RECORD_TYPES, isEmbedRecordType,
} from '../../brain/embed-queue.js';
import type { ToolContext, ToolHandler, ToolResult, ToolSchemas } from './types.js';

const RECORD_TYPES = [...EMBED_RECORD_TYPES];

/**
 * Answers *"which of my records have no vector"* — the question that had no answer from outside, on either surface.
 *
 * Read-only, so it stays visible to a read-only token: an operator who cannot fix the queue still has every reason to
 * be able to see it, and hiding the diagnosis behind write rights is how a failure becomes a mystery.
 */
export const list_embed_jobsTool: ToolHandler = {
  name: 'list_embed_jobs',
  description: 'List brain records whose embedding is pending, in progress, or has failed, with the attempt count and '
    + 'last error for each. A record with an unfinished job is STORED but not yet findable by recall or query — this is '
    + 'how you tell "the record is missing" from "the record has no vector yet". Filter with `status`; omit it for the '
    + 'whole backlog. Counts are returned either way.\n\n'
    + 'READING `attempts` AND `transientFailures`: they answer different questions and a job can climb one without the '
    + 'other. `attempts` is the PERMANENT-failure budget and is spent only on errors a retry cannot fix — a malformed '
    + 'input, a rejection from a reachable embedder. `transientFailures` counts the times the embedder simply did not '
    + 'answer (connection refused, DNS, a timeout, a 429 or 5xx); those hand the attempt back and back off instead, up '
    + 'to half-hourly, and NEVER go terminal. So a high `transientFailures` with `attempts` at zero is an outage waiting '
    + 'itself out and needs nothing from you; a `failed` job with `attempts` at its maximum is a record that cannot be '
    + 'embedded and needs the content fixed. `lastError` tells you which.\n\n'
    + 'A terminal `failed` job is also revived once per server VERSION at startup, so an upgrade retries everything that '
    + 'died under the old one without anybody asking.\n\n'
    + 'This tool only REPORTS. The per-record retry lives on its own mutating tool, and a read-only token is '
    + 'deliberately not shown one — `help()` lists what your token can actually reach, so if no retry appears there, '
    + 'the answer is that this token cannot retry rather than that no such tool exists.',
  mutating: false,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      status: {
        type: 'string',
        enum: ['pending', 'processing', 'failed'],
        description: 'Only jobs in this state. Omit for all three. `failed` means it is done retrying and needs you.',
      },
      limit: { type: 'number', minimum: 1, maximum: 200, description: 'Max jobs to return (default 50, cap 200).' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    const status = a['status'] as 'pending' | 'processing' | 'failed' | undefined;
    const limit = a['limit'] === undefined ? undefined : Number(a['limit']);
    if (limit !== undefined && (!Number.isFinite(limit) || limit < 1)) throw new Error('limit must be a positive number');

    const counts = await getEmbedJobCounts(callSpace);
    const jobs = (await listEmbedJobs(callSpace, {
      ...(status ? { status } : {}),
      ...(limit ? { limit } : {}),
    })).map(j => ({
      recordType: j.recordType,
      recordId: j.recordId,
      status: j.status,
      attempts: j.attempts,
      maxAttempts: j.maxAttempts,
      lastError: j.lastError,
      updatedAt: j.updatedAt,
    }));

    const head = `Embed queue for '${callSpace}': ${counts.pending} pending, ${counts.processing} processing, ${counts.failed} failed.`;
    const body = jobs.length === 0
      ? status
        ? ` No ${status} jobs.`
        : ' Nothing queued — every record in this space has its vector.'
      : '\n' + jobs.map(j =>
        `- ${j.recordType} ${j.recordId} — ${j.status}, attempt ${j.attempts}/${j.maxAttempts}`
        + (j.lastError ? `: ${j.lastError}` : ''),
      ).join('\n');

    return {
      content: [{ type: 'text' as const, text: head + body }],
      structuredContent: { counts, jobs, ...(status ? { status } : {}) },
    };
  },
};

/**
 * The brain counterpart of `retry_embed_file`, which does files. Same three outcomes, reported verbatim for the same
 * reason: `processing` means a worker already holds the job, which is not an error and must not be reset out from under
 * a run in progress.
 */
export const retry_embed_recordTool: ToolHandler = {
  name: 'retry_embed_record',
  description: 'Re-queue one brain record whose embedding failed, so the worker picks it up again. Resets the job to '
    + 'pending and clears its attempt count and last error. Returns `processing` unchanged if the worker already holds '
    + 'it — not a failure, and retrying would interrupt a run. Get `recordType`/`recordId` from list_embed_jobs. For '
    + 'files use retry_embedding instead: that re-runs the media pipeline, this only re-embeds.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      recordType: {
        type: 'string', enum: RECORD_TYPES,
        description: 'Which collection the record lives in. Required alongside `recordId` because ids are '
          + 'only unique within a collection, so the pair is what names one record — a wrong `recordType` '
          + 'finds nothing rather than finding the wrong thing.',
      },
      recordId: { type: 'string', minLength: 1, description: 'The record\'s _id, as list_embed_jobs reports it.' },
      targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space holding the record.' },
    },
    required: ['space', 'recordType', 'recordId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    if (!isEmbedRecordType(a['recordType'])) throw new Error(`recordType must be one of ${RECORD_TYPES.join(', ')}`);
    const recordId = String(a['recordId'] ?? '').trim();
    if (!recordId) throw new Error('recordId must not be empty');

    const wt = resolveWriteTarget(callSpace, a['targetSpace'] as string | undefined);
    if (!wt.ok) throw new Error(wt.error);

    const result = await retryEmbedJob(wt.target, a['recordType'], recordId);
    const text = result === 'ok'
      ? `Re-queued ${a['recordType']} '${recordId}' for embedding.`
      : result === 'processing'
        ? `${a['recordType']} '${recordId}' is being embedded right now — left alone rather than reset, so the run in progress is not interrupted.`
        : `No embed job exists for ${a['recordType']} '${recordId}' in '${wt.target}'. Either it embedded successfully, or the record is gone.`;

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { result, recordType: a['recordType'], recordId, space: wt.target },
    };
  },
};

/**
 * Re-queue EVERY failed media job in a space — the bulk counterpart to `retry_embed_file`.
 *
 * `POST /api/brain/spaces/:spaceId/embedding-queue/media/retry-failed` was REST-only, so an agent recovering a space
 * after an embedder outage had to enumerate the failures and call the single-file tool once per file. That is the
 * shape of the reindex-by-curl-loop that motivated the `reindex` tool in the first place: a customer did fourteen
 * spaces by hand because the agent that planned their work could not do it.
 *
 * Found by the capability matrix (`scripts/surface-matrix.mjs`). Filed as B-22.
 *
 * **Sums across member spaces**, exactly as the route does: on a proxy the failures live in the members, and a
 * caller who asked the proxy to retry means all of them.
 */
export const retry_embed_mediaTool: ToolHandler = {
  name: 'retry_embed_media',
  description: 'Re-queue EVERY failed MEDIA job in a space at once — image captioning, audio and video '
    + 'transcription, document extraction — so the worker picks them all up again. The recovery path after an '
    + 'extractor or model outage.\n\n'
    + 'MEDIA, NOT THE BRAIN QUEUE, and the name now says so. It was `retry_failed_embeddings` until 3.1, which '
    + 'sat beside `list_embed_jobs` and read as its remedy while acting on a different queue entirely. It does '
    + 'NOT touch the brain embed jobs that `list_embed_jobs` reports; for one of those use '
    + '`retry_embed_record`. And usually you need neither: a brain job that failed against an unreachable '
    + 'embedder is retried on its own, backing off, and needs no intervention at all.\n\n'
    + 'ONE FILE OR ALL OF THEM. Use `retry_embed_file` for one specific file; use this instead of calling it in '
    + 'a loop. Jobs the worker currently holds are left alone rather than interrupted, so a retry during a run '
    + 'cannot take work away from it.\n\n'
    + 'PARAMETERS:\n'
    + '- `space` — the space to sweep. On a PROXY every member is retried, because that is what asking the '
    + 'proxy means; the count returned is the total across them.\n\n'
    + 'RESPONSE: how many jobs were reset. Zero means nothing was failed — not that the call did nothing '
    + 'wrong. Check `list_embed_jobs` for the brain queue, which this does not touch.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { callSpace, accessibleSpaceIds } = ctx;
    const { retryFailedJobs } = await import('../../files/media/job-queue.js');
    // `memberSpacesWithin` is the MCP half of the narrowing the route states with `memberSpacesForRequest`.
    const memberIds = memberSpacesWithin(callSpace, accessibleSpaceIds);
    let retried = 0;
    for (const mid of memberIds) retried += await retryFailedJobs(mid);

    const text = retried === 0
      ? `No failed media jobs in '${callSpace}' — nothing to retry.`
      : `Re-queued ${retried} failed media job${retried === 1 ? '' : 's'} in '${callSpace}'.`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { retried, space: callSpace },
    };
  },
};
