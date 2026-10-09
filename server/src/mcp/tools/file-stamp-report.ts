/**
 * MCP `file_stamp_report` (`Q-433`) — the tool half of `POST /api/spaces/:id/file-stamp-report`. Both run
 * `beginFileStampReport`, the module that also holds the rail and the single flight, so the two doors accept the same body,
 * refuse for the same reasons in the same words and cost the caller the same.
 *
 * Dispatcher validation is skipped on purpose: the ONE parser both doors share does the refusing, so a malformed call is
 * answered with the same sentence, naming the same parameter, here as over REST.
 *
 * Not `heavy`, for the reason `ingest` is not: the rail is inside the module, and declared here as well the dispatcher
 * would count every call twice and refuse in the word "destructive".
 */
import type { ToolHandler, ToolContext, ToolResult, ToolSchemas } from './types.js';
import { beginFileStampReport } from '../../spaces/file-stamp-report-door.js';
import { FILE_STAMP_REPORT_MAX_LIMIT, FILE_STAMP_REPORT_DEFAULT_LIMIT, FILE_STAMP_REPORT_CURSOR_MAX } from '../../files/file-stamp-report.js';
import { HEAVY_CALLS_PER_WINDOW } from '../../rate-limit/heavy-tool.js';
import { ToolRefusal } from '../../util/errors.js';

export const file_stamp_reportTool: ToolHandler = {
  name: 'file_stamp_report',
  description: 'Report which files of one space this instance holds under its OWN authorship although another instance '
    + 'created them first — the signature of a stamp a receiver wrote on a file whose bytes it pulled from a peer, which '
    + 'keeps the real author\'s later edits from replacing it and makes a merkle network report a divergence every cycle. '
    + 'Requires instance-admin rights.\n\n'
    + 'IT ONLY REPORTS. It repairs nothing: what to do about a row is for the operator, on the instance that really '
    + 'authored the file. On this instance it writes no file row, counter or collection; it records one audit entry '
    + '(`file.stamps.reported`).\n\n'
    + 'IT CONTACTS THE PEERS that hold this space, with this instance\'s credentials for them, and reads their file feeds. '
    + 'No path is sent to a peer. Each row says which peer reported what, by instance id.\n\n'
    + 'EVERY ROW IT NAMES HAS A VERDICT. `likely-stamped-here` is evidence and not proof: a peer is the only witness, and '
    + 'it may itself hold the same stamp. `cannot-tell` carries a fixed `reason` — a peer that did not answer, refused, or '
    + 'was not reached before the deadline is a `cannot-tell` row and never a missing one. The answer states the rules '
    + 'that decide which rows are examined, and carries the counts (`candidates`, `checked`, `likely`, `cannotTell`).\n\n'
    + `AT MOST ${HEAVY_CALLS_PER_WINDOW} RUNS A MINUTE PER TOKEN, counted with the REST route. ONE RUN AT A TIME PER SPACE: `
    + 'a second call while one runs is a 409. A proxy space holds no files and is refused: report on its members.\n\n'
    + 'PAGING: `limit` rows per call, from the row after `after`. When `truncated` is true, pass `nextAfter` as `after` '
    + 'for the next page.',
  admin: true,
  spaceRequired: true,
  skipSchemaValidation: true,
  inputSchema: (s: ToolSchemas) => ({
    type: 'object',
    properties: {
      space: s.requiredSpace,
      limit: {
        type: 'integer', minimum: 1, maximum: FILE_STAMP_REPORT_MAX_LIMIT, default: FILE_STAMP_REPORT_DEFAULT_LIMIT,
        description: `How many candidate rows one call examines: 1 to ${FILE_STAMP_REPORT_MAX_LIMIT}, default ${FILE_STAMP_REPORT_DEFAULT_LIMIT}.`,
      },
      after: {
        type: 'string', maxLength: FILE_STAMP_REPORT_CURSOR_MAX,
        description: 'The `nextAfter` of the previous page, to continue after it. Omit it to start from the beginning.',
      },
    },
    required: ['space'],
    additionalProperties: false,
  }),
  async handle(ctx: ToolContext): Promise<ToolResult> {
    const { space: _space, ...body } = ctx.args;
    const r = await beginFileStampReport(ctx.callSpace, body, ctx.rateKey);
    if (r.status !== 200) throw new ToolRefusal(r.status, r.error);
    // The answer in `content` as well as `structuredContent`: a client may read either one alone.
    return { content: [{ type: 'text' as const, text: JSON.stringify(r.answer) }], structuredContent: { ...r.answer } };
  },
};
