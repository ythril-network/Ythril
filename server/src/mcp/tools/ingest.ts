/**
 * MCP `ingest` and `ingest_status` (`F-31`) — the tool half of `POST /api/brain/spaces/:spaceId/ingest` and
 * `GET …/ingest/:runId`. Both run `beginIngest` / `ingestStatus`, the module the REST route calls, so the two doors
 * accept the same body and refuse for the same reasons in the same words.
 *
 * Dispatcher validation is skipped on purpose: the ONE parser both doors share does the refusing, so a malformed
 * call is answered with the same sentence here as over REST rather than with the dispatcher's own.
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { beginIngest, ingestStatus } from '../../extractor/ingest-door.js';
import { INGEST_KINDS } from '../../extractor/ingest.js';
import { HEAVY_CALLS_PER_WINDOW } from '../../rate-limit/heavy-tool.js';

const text = (t: string, isError = false): ToolResult => ({ content: [{ type: 'text' as const, text: t }], isError });

export const ingestTool: ToolHandler = {
  name: 'ingest',
  description: 'Turn a conversation into records: entities, claims (facts), dated events (chrono), the relationships '
    + 'between them, and one transcript file per session. Send EXACTLY ONE of `sessions` or `extraction`.\n\n'
    + '`sessions` is a raw conversation — `[{ date: "YYYY-MM-DD", time?, key?, turns: [{ speaker, text, role? }] }]` — '
    + 'and runs every phase: minutes of model calls. `extraction` is one already made, in the committed extraction '
    + 'format, and is only validated and written: no model is asked.\n\n'
    + `AT MOST ${HEAVY_CALLS_PER_WINDOW} RUNS A MINUTE PER TOKEN, counted with the REST route: a start over the limit is refused, `
    + 'and a start refused for its space or its models (below) costs no slot.\n\n'
    + 'IT RETURNS AT ONCE WITH A `runId`; the work runs in the background. Read it with `ingest_status` until `phase` '
    + 'is `done` or `failed`. Runs are held in memory, so a restart forgets the run — never the records it wrote.\n\n'
    + 'REFUSED BEFORE ANYTHING IS PAID FOR, naming what to change: a space that does not declare every type of the '
    + '`conversation` Schema Library group (add it with the group apply — ingest never changes a space\'s schema), '
    + 'or, for `sessions`, no decision model, no assist model, or no doc-nlp sidecar.\n\n'
    + 'Every record goes through the same validation as `save_bulk`. Transcripts are FILES, so they are written only '
    + 'when the token also holds `files: write`; otherwise the run records that it skipped them. `targetSpace` is '
    + 'required when `space` is a proxy.',
  mutating: true,
  spaceRequired: true,
  // Not `heavy`: the rail is inside `beginIngest`, which both doors call (S-8). Declared here as well, the dispatcher
  // would count every MCP start twice and a refused start once.
  skipSchemaValidation: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      targetSpace: { type: 'string', description: 'Required for proxy spaces: the member space to write to.' },
      kind: { type: 'string', enum: [...INGEST_KINDS], description: 'What the source is. `conversation` is the one kind there is.' },
      conversationId: {
        type: 'string',
        description: 'Names the conversation and its transcripts\' folder (`transcripts/<conversationId>/`). 1–100 letters, '
          + 'digits, dots, dashes or underscores. Derived from the content when omitted, so the same conversation names the '
          + 'same folder.',
      },
      sessions: {
        type: 'array',
        description: 'A raw conversation: sessions with a `date` each, and their turns in order.',
        items: { type: 'object' },
      },
      extraction: { type: 'object', description: 'An extraction already made, in the committed format. Validated, then written.' },
    },
    required: ['space', 'kind'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { space: _space, targetSpace, ...body } = ctx.args;
    const r = await beginIngest(ctx.callSpace, targetSpace as string | undefined, body, ctx.rights, ctx.rateKey);
    if (r.status !== 202) return text(r.error, true);
    return {
      ...text(`ingest started — runId: ${r.run.runId}, conversationId: ${r.run.conversationId}. Read it with ingest_status.`),
      structuredContent: { runId: r.run.runId, conversationId: r.run.conversationId, phase: r.run.phase },
    };
  },
};

export const ingest_statusTool: ToolHandler = {
  name: 'ingest_status',
  // Names no mutating tool: a read-only token sees this description, and must not be pointed at a tool it lacks.
  description: 'Read a conversation run started earlier (see `help()`): its `phase` (queued, extracting, writing, done, '
    + 'failed), what it wrote, the claims it dropped and why, the turns no claim covers, which backends answered, and any '
    + 'write errors. A run is found only under the space it was started in, and is held in memory — a restart forgets '
    + 'it, not the records.',
  spaceRequired: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      targetSpace: { type: 'string', description: 'For a proxy space: the member the run wrote into.' },
      runId: { type: 'string', description: 'The run id the start call answered with. Only valid in the space it was started in.' },
    },
    required: ['space', 'runId'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const run = ingestStatus(ctx.callSpace, ctx.args['targetSpace'] as string | undefined, String(ctx.args['runId'] ?? ''));
    if (!run) return text(`No ingest run '${ctx.args['runId']}' in this space. Runs are held in memory, so a restart forgets them — not the records a finished run wrote.`, true);
    return { ...text(`ingest ${run.runId}: ${run.phase}${run.error ? ` — ${run.error}` : ''}`), structuredContent: { ...run } };
  },
};
