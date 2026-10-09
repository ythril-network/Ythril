/**
 * The `file_stamp_report` sequence both doors run, from a request to an answer — so the REST route and the MCP tool cannot
 * differ in which space they check, which body they accept, what they cost the caller or when they refuse. Each door only
 * shapes the answer: REST as a status code, MCP as a tool result (`Q-433`).
 *
 * ## What it prevents
 *
 * The report walks a peer's file feed per call and spends this instance's peer credentials, so it is priced like the ingest
 * and not like a read: the heavy-call rail and a single flight per space. A limit that each door mounts for itself is one
 * door away from missing (`extractor/ingest-door.ts` is the precedent), so both sit HERE, and the tool does not also declare
 * `heavy` — the dispatcher would count every tool call twice, and refuse in the word "destructive", which a report is not.
 *
 * **One count per token across the doors**: the rail is the same counter `callTool` keeps for every heavy tool, keyed the
 * same way (the token's id, or its address when it has none).
 *
 * **A refusal costs no slot.** The order is the space, the parameters, the single flight, the rail — so a malformed call or
 * one that finds the space busy is not counted, and a call that is counted is one that runs.
 *
 * **The single flight is released in a `finally`**, so a report that fails frees its space as well as one that succeeds.
 */
import { z } from 'zod';
import { getConfig } from '../config/loader.js';
import { isProxy } from './proxy.js';
import { consumeHeavyToolCall, HEAVY_CALLS_PER_WINDOW } from '../rate-limit/heavy-tool.js';
import {
  fileStampReport, FILE_STAMP_REPORT_MAX_LIMIT, FILE_STAMP_REPORT_DEFAULT_LIMIT, FILE_STAMP_REPORT_CURSOR_MAX, type FileStampAnswer,
} from '../files/file-stamp-report.js';

/**
 * The body, and the tool's arguments once `space` is taken off. `.strict()` so a misspelt `limit` is a 400 and not a
 * report at the default size: a caller who meant to narrow and got everything must be told. The bounds are the report's
 * own (`files/file-stamp-report.ts`), which refuses a value outside them as well.
 */
export const FileStampReportBody = z.object({
  limit: z.number().int().min(1).max(FILE_STAMP_REPORT_MAX_LIMIT).optional(),
  after: z.string().max(FILE_STAMP_REPORT_CURSOR_MAX).optional(),
}).strict();

export type FileStampReportOutcome =
  | { status: 200; answer: FileStampAnswer }
  | { status: 400 | 404 | 409 | 429; error: string };

/** The refusal a caller over the rail gets, the same words on both doors. */
export const FILE_STAMP_REPORT_RATE_LIMITED = `file_stamp_report is rate limited — at most ${HEAVY_CALLS_PER_WINDOW} runs a minute per token, `
  + 'counted across the REST route and the tool; try again shortly';

/** The spaces a report is running for. Module state, so a second door finds the first one's run. */
const running = new Set<string>();

/** Why a body was refused, naming the parameter — the sentence both doors send. */
function bodyRefusal(error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) return 'Invalid body';
  const where = issue.path.join('.');
  return where ? `${where}: ${issue.message}` : issue.message;
}

/**
 * Run a report for `spaceId`.
 *
 * @param body       the caller's arguments (`limit`, `after`) — any value; refused here when it is not that shape
 * @param callerKey  who the rail counts against: the calling token's id, or its address when it has none
 */
export async function beginFileStampReport(spaceId: string, body: unknown, callerKey: string): Promise<FileStampReportOutcome> {
  const space = getConfig().spaces.find(s => s.id === spaceId);
  if (!space) return { status: 404, error: `Space '${spaceId}' not found` };
  if (isProxy(space)) {
    return { status: 400, error: `'${spaceId}' is a proxy space and holds no files of its own. Report on its members instead: ${(space.proxyFor ?? []).join(', ')}.` };
  }
  const parsed = FileStampReportBody.safeParse(body ?? {});
  if (!parsed.success) return { status: 400, error: bodyRefusal(parsed.error) };
  // Before the rail, so a call that finds the space busy costs the caller no slot. No `await` between this check, the
  // rail and the claim: two calls cannot both pass it.
  if (running.has(spaceId)) return { status: 409, error: `A file stamp report for '${spaceId}' is already running — try again when it ends` };
  if (!consumeHeavyToolCall(callerKey)) return { status: 429, error: FILE_STAMP_REPORT_RATE_LIMITED };
  running.add(spaceId);
  try {
    const answer = await fileStampReport(spaceId, {
      limit: parsed.data.limit ?? FILE_STAMP_REPORT_DEFAULT_LIMIT,
      ...(parsed.data.after !== undefined ? { after: parsed.data.after } : {}),
    });
    return { status: 200, answer };
  } finally {
    running.delete(spaceId);
  }
}
