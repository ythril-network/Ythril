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
import { getConfig } from '../../config/loader.js';
import { reembedSpace, REEMBED_KINDS, REEMBED_DEFAULT_LIMIT, REEMBED_MAX_LIMIT } from '../../brain/reembed.js';
import type { BrainEmbedRecordType } from '../../config/types.js';
import { readSpacesOfCall } from '../../spaces/read-scope.js';
import {
  retryEmbedJob, EMBED_RECORD_TYPES, isEmbedRecordType,
} from '../../brain/embed-queue.js';
import type { ToolContext, ToolHandler, ToolResult, ToolSchemas } from './types.js';
import { embedJobsPage, MAX_JOB_PAGE, DEFAULT_JOB_PAGE } from '../../brain/embed-jobs-page.js';
import { LOST_MARKER, NOT_SENT_MARKER } from '../../brain/embed-errors.js';

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
    + 'to half-hourly, and NEVER go terminal (the one exception is below). So a high `transientFailures` with `attempts` at zero is an outage waiting '
    + 'itself out and needs nothing from you; a `failed` job with `attempts` at its maximum is a record that cannot be '
    + 'embedded and needs the content fixed. `lastError` tells you which.\n\n'
    + 'A terminal `failed` job is also revived once per server VERSION at startup, so an upgrade retries everything that '
    + 'died under the old one without anybody asking.\n\n'
    + 'THE ONE EXCEPTION: a `failed` job whose `lastError` begins `' + LOST_MARKER + '` has `attempts` BELOW its maximum. '
    + 'The bundled embedding process was lost three times while that record was being embedded, which is how an input that '
    + 'crashes the model looks; retrying it for ever would loop, so it is left for you. Shorten or fix the content, or '
    + 'retry it with the per-record retry tool once the cause is understood. One lost process alone never does this, and only '
    + 'the record in flight is counted: one merely queued behind it fails `' + NOT_SENT_MARKER + '`, is retried, and is never counted.\n\n'
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
      limit: { type: 'integer', minimum: 1, maximum: MAX_JOB_PAGE, description: `Max jobs to return (default ${DEFAULT_JOB_PAGE}, ${MAX_JOB_PAGE} at most; more is refused, not served smaller).` },
      skip: { type: 'integer', minimum: 0, description: 'Jobs to skip before the page, newest first — how you reach past the first page when the counts say there are more.' },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    // The act REST calls, over the spaces a read names: the space itself, or the members of the caller's own view (Q-109, Q-531).
    const page = await embedJobsPage(readSpacesOfCall(ctx, callSpace), {
      status: a['status'], limit: a['limit'], skip: a['skip'],
    });
    if (!page.ok) throw new Error(page.error);
    const { counts, jobs, status } = page.body;

    const head = `Embed queue for '${callSpace}': ${counts.pending} pending, ${counts.processing} processing, ${counts.failed} failed.`;
    const body = jobs.length === 0
      ? status
        ? ` No ${status} jobs on this page.`
        : ' Nothing queued on this page — every record reached has its vector.'
      : '\n' + jobs.map(j =>
        `- ${j.recordType} ${j.recordId} in ${j.spaceId} — ${j.status}, attempt ${j.attempts}/${j.maxAttempts}`
        + (j.transientFailures ? `, ${j.transientFailures} transient` : '')
        + (j.lastError ? `: ${j.lastError}` : ''),
      ).join('\n');

    return {
      content: [{ type: 'text' as const, text: head + body }],
      structuredContent: page.body,
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
    + 'files use retry_embed_file instead: that re-runs the media pipeline, this only re-embeds.',
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
    },
    required: ['space', 'recordType', 'recordId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { args: a, callSpace } = ctx;
    if (!isEmbedRecordType(a['recordType'])) throw new Error(`recordType must be one of ${RECORD_TYPES.join(', ')}`);
    const recordId = String(a['recordId'] ?? '').trim();
    if (!recordId) throw new Error('recordId must not be empty');


    const result = await retryEmbedJob(callSpace, a['recordType'], recordId);
    const text = result === 'ok'
      ? `Re-queued ${a['recordType']} '${recordId}' for embedding.`
      : result === 'processing'
        ? `${a['recordType']} '${recordId}' is being embedded right now — left alone rather than reset, so the run in progress is not interrupted.`
        : `No embed job exists for ${a['recordType']} '${recordId}' in '${callSpace}'. Either it embedded successfully, or the record is gone.`;

    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { result, recordType: a['recordType'], recordId, space: callSpace },
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
 * A write: it sweeps the one space it names (a view never writes, and a write tool is never offered one).
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
    + '- `space` — the space to sweep.\n\n'
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
    const { callSpace } = ctx;
    const { retryFailedJobs } = await import('../../files/media/job-queue.js');
    // The one space the call named: the dispatcher judged reach and the files WRITE rung on it, and a view is never offered to a write tool.
    const retried = await retryFailedJobs(callSpace);

    const text = retried === 0
      ? `No failed media jobs in '${callSpace}' — nothing to retry.`
      : `Re-queued ${retried} failed media job${retried === 1 ? '' : 's'} in '${callSpace}'.`;
    return {
      content: [{ type: 'text' as const, text }],
      structuredContent: { retried, space: callSpace },
    };
  },
};

/*
 * ── The WHOLE-SPACE embedding operations, moved here from `spaces.ts` on 2026-09-17 ─────────────────────
 *
 * They lived beside `list_spaces` and `delete_space_data` because they take a space id, which is the wrong
 * reason to share a file: every tool here takes a space id. What they have in common with the three above
 * is the SUBJECT — embeddings and the queue that produces them — and `spaces.ts` crossed its god-file
 * ceiling when the second of them was written, which is the gate asking the question rather than the move
 * being cosmetic.
 *
 * They are also the pair most easily confused with each other, and putting them in one file next to each
 * other is the cheapest thing that makes the difference visible to whoever edits one.
 */

/**
 * Re-embed a space — the LAST of the five REST-only capabilities, and the one their workaround measured best.
 *
 * They reindexed 14 spaces plus 5 personal ones by curl in a shell loop, by hand, because the agent that planned their
 * embedder migration could not run it. That is the whole case: the surface that plans a migration was the surface that
 * could not execute it.
 *
 * ## Why it took three PRs
 *
 * There was nothing to wrap. The re-embedding work was inline in the route handler as five near-identical batch loops,
 * so it was pinned by characterization tests, extracted to `brain/reindex.ts`, and only then given a tool. A tool that
 * had re-implemented the loops would have been a second copy of five embed-text call sites, and the copy that drifts is
 * the one nobody watches.
 *
 * ## The one argument that differs per surface
 *
 * `memberIds`. REST narrows by request; here it comes from the token's accessible spaces via `memberSpacesWithin`.
 * Getting that wrong is how a tool would re-embed a space that the token cannot reach — so the planner
 * takes it as an argument rather than resolving it, and each surface supplies the list it is entitled to.
 */

export const space_reindexTool: ToolHandler = {
  name: 'space_reindex',
  description: 'Re-embed every record in a space with the currently configured embedding model — the recovery path '
    + 'after changing embedder, model, dimensions or prefix scheme. Requires an admin token. Every record is rebuilt, '
    + 'including the passages of converted documents and the captions and transcripts of media, even when its text is '
    + 'unchanged. Returns as soon as the run STARTS: the records are queued and rebuilt in the background, behind any '
    + 'write somebody is waiting on, so poll `space_meta` — its `reindexRun` field ({running, remaining, failed}) — '
    + 'rather than waiting on this call; `running` turns false when every record is rebuilt. A space with a run '
    + 'already going refuses a second one (409); any other space starts. A personal view is not a space: naming '
    + 'one is answered as an unknown space, before any work. Recall in a space '
    + 'whose `needsReindex` is true refuses until its run finishes.',
  mutating: true,
  admin: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: { space: s.requiredSpace },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // Authorised by `admin: true` in the dispatcher, which refuses this tool unless the token's matrix says
    // `instanceAdmin`. The `if (!isAdmin)` that stood here was a second copy of that rule, reading the legacy
    // boolean — and a second copy of an authorization rule is what this codebase pays most for.
    const { callSpace } = ctx;

    const { planReindex, startReindex } = await import('../../brain/reindex.js');
    const space = getConfig().spaces.find(s => s.id === callSpace);

    // A reindex acts on the one space the call named: the dispatcher judged reach and the tool's own rung on it, and a view id never
    // reaches here (a write tool is answered an unknown space for one, before any work).
    const decision = await planReindex({ spaceId: callSpace, space });
    if (!decision.ok) {
      // The status is reported alongside the message: 409 means "this space's run is still going". An agent that cannot tell that
      // from a refusal that can never work retries the wrong one.
      return {
        content: [{ type: 'text' as const, text: `Error (${decision.refusal.status}): ${decision.refusal.body.error}` }],
        isError: true,
      };
    }

    await startReindex(decision.plan);
    return {
      content: [{ type: 'text' as const, text:
        `Reindex STARTED for '${callSpace}'. `
        + 'It runs in the background — this reply does not mean it finished. space_meta reports its progress in '
        + '`reindexRun` ({running, remaining, failed}); `running` turns false when every record is rebuilt.' }],
      structuredContent: { status: 'started', spaceId: callSpace },
    };
  },
};

/**
 * The BACKFILL, and it is a different capability from `space_reindex` — see the description.
 *
 * It exists because `POST /api/spaces/:id/reembed` had no tool and nobody could see that: the capability
 * map paired the route with `space_reindex`, so the parity gate read a covered capability where there was
 * a REST-only one. The two touch the same vectors and do opposite things, which is the shape a map keyed on
 * DATA cannot tell apart.
 */
export const space_reembedTool: ToolHandler = {
  name: 'space_reembed',
  description: 'Queue embeddings for records in a space that have NONE, and for records whose stored text is not their '
    + 'current text — the way back from `suppressEmbeddings`, and the repair after an embedding run stopped partway '
    + 'or an update\'s embedding job was lost.\n\n'
    + 'STALE RECORDS ARE QUEUED TOO, and `stale` counts them: a record that keeps the vector and the lexical text of its '
    + 'previous content because its job was never queued, and a suppressed record whose lexical text is missing or old '
    + '(its job writes the text without calling the model). FINDING THEM READS EVERY RECORD OF THE SPACE ONCE PER CALL '
    + '(`limit` bounds what is queued, never what is read), so a large space pays for a pass over its records each time. '
    + 'Calling again re-reads from the start: what you queued stays stale until the worker has drained it, so '
    + '`enqueued` and `remaining` do not move before then.\n\n'
    // NAMING THE OTHER TOOL WOULD BE THE DEFECT HERE. Rebuilding every vector is instance-admin, this is
    // not, so a standard token sees this description and cannot see that tool — and a description that
    // sends a caller to something they will be refused is worse than one that describes the boundary.
    // `readonly-tool-descriptions-cannot-name-mutating-tools` is the same rule one rung down.
    + 'IT DOES NOT REBUILD VECTORS THAT ARE CURRENT, and that is the distinction to get right: a record that holds a '
    + 'vector made from its current text is left alone, and one whose text has changed is the stale case above. '
    + 'Rebuilding every vector in a space — the recovery path after changing embedder or model — is a separate and '
    + 'more privileged operation; `help()` lists it if your token can reach it. This one touches only '
    + 'records with no vector at all and the stale ones above, is AWAITED, and the counts it returns are the '
    + 'answer rather than a receipt.\n\n'
    + 'SUPPRESSION IS EXCLUDED IN THE QUERY, not filtered afterwards, so a suppressed record whose lexical text is '
    + 'current is reported under `skippedSuppressed` rather than queued again on every call. A suppressed record whose '
    + 'text is stale is NOT skipped: it is queued, counted in `stale` and `enqueued` (and in `remaining` when past the '
    + 'cap), never under `skippedSuppressed`. A record suppressed at any tier — '
    + 'record, type schema or space — stays suppressed; releasing it is a separate act, and this is what you '
    + 'run AFTER releasing it because nothing backfills on its own.\n\n'
    + 'BOUNDED, AND `truncated: true` MEANS CALL AGAIN. `limit` defaults to '
    + `${REEMBED_DEFAULT_LIMIT} and cannot exceed ${REEMBED_MAX_LIMIT}, so one call can never enqueue `
    + 'unbounded work. `remaining` is what is left after this page.\n\n'
    + 'QUEUED BEHIND LOCAL WRITES. The jobs wait in the background lane: a write somebody is waiting to search '
    + 'for is embedded first, while the backfill still gets a share of the worker. A derived record with no text '
    + 'of its own (a face crop, a converted copy of a document) is never a candidate, so a second call after the '
    + 'queue has drained reports `enqueued: 0`.\n\n'
    + 'RESPONSE: `enqueued`, `skippedSuppressed`, `stale` (of `enqueued`, the records queued because their text '
    + 'changed), `byKind`, `remaining`, `truncated`. A run that enqueues nothing and skips nothing means every '
    + 'record already has a vector made from its current text — not that it failed.',
  mutating: true,
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      kinds: {
        type: 'array',
        maxItems: REEMBED_KINDS.length,
        items: { type: 'string', enum: [...REEMBED_KINDS] },
        minItems: 1,
        description: 'Record types to sweep. Omit to sweep all of them.',
      },
      limit: {
        type: 'integer', minimum: 1, maximum: REEMBED_MAX_LIMIT, default: REEMBED_DEFAULT_LIMIT,
        description: 'Most records to enqueue in this call. `remaining` reports what is left.',
      },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    // An ADAPTER over `reembedSpace`, which the REST route calls. The sweep, the suppression exclusion and
    // the bounding all live there, because they are rules the write path has to agree with too.
    const { args: a, callSpace } = ctx;
    const out = await reembedSpace(callSpace, {
      ...(Array.isArray(a['kinds']) ? { kinds: a['kinds'] as BrainEmbedRecordType[] } : {}),
      ...(typeof a['limit'] === 'number' ? { limit: a['limit'] } : {}),
    });
    const per = Object.entries(out.byKind).map(([k, n]) => `${k}: ${n}`).join(', ') || 'nothing';
    return {
      content: [{ type: 'text' as const, text:
        `Queued ${out.enqueued} embedding job(s) in '${callSpace}' (${per}; ${out.stale} of them for a changed text). `
        + `${out.skippedSuppressed} record(s) skipped as suppressed. `
        + (out.truncated ? `${out.remaining} left — call again to continue.` : 'Nothing left to sweep.') }],
      structuredContent: out as unknown as Record<string, unknown>,
    };
  },
};
