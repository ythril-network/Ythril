/**
 * The audit row of a tool call, written at the ONE exit of the dispatch — whichever door, whatever the answer.
 *
 * ## What it prevents (`Q-444`, bundle-98)
 *
 * REST's rule is `audit/middleware.ts`: every response of a path that matches a `ROUTE_RULES` row is a row at the status it
 * was answered, 2xx, 4xx or 5xx, and the one filter is `audit.logReads`, which drops READ operations. The tool door wrote
 * its rows at four call sites, each with its own condition, and every refusal branch had to remember to be one of them:
 *
 *  - the success path recorded every tool;
 *  - `refuseAudited` recorded a refused call only when the tool was `mutating` and not an act;
 *  - the catch recorded a thrown call only when it was an act (and not a `ToolRefusal`) or a `mutating` tool;
 *  - the `ConnectionsNotWritten` branch recorded itself;
 *  - and the refusals made before the space resolved (arguments that are not an object, a retired id, a view named on a
 *    write, a bad or missing `space`, an unknown space) recorded nothing at all.
 *
 * So a refused or failed READ left no row on a tool door while its REST route did, and a refused write left a row or not by
 * which branch refused it. A fifth refusal branch added next year would have been the sixth way to forget.
 *
 * **Here the row is written in a `finally` of one wrapper, so no branch inside the dispatch can record or skip on its own.**
 * A call that reaches a named audited operation (`mcpActOperation ?? mcpAuditOperation` non-null) leaves exactly one row at
 * the status it was answered. An unknown tool, and a tool deliberately mapped to `null`, name no operation and write nothing,
 * as an unmatched REST path writes nothing.
 *
 * ## What the dispatch tells it, and nothing else
 *
 * The facts only the dispatch knows: the space the call named (`auditSpace`, set only for a space that EXISTS, so a caller's
 * spelling of one that does not is never written to the trail), the members a personal view read (`viewSpaces`), the record a
 * create stored when its connections failed (`writtenId`), and the change list a tool handed over (`snapshots`). It does not
 * tell it whether to record.
 */
import { getConfig } from '../config/loader.js';
import { currentRequestId } from '../util/log.js';
import { logAuditEntry } from '../audit/audit.js';
import { auditChanges, type AuditChange } from '../audit/audit-changes.js';
import { mcpAuditOperation, mcpActOperation, isMcpReadOperation } from './audit-map.js';
import type { ToolCaller } from './call-tool.js';

/** What a tool hands the audit entry through `recordChanges` (Q-50) — the pair a REST route sets as `req.auditSnapshots`. */
export type AuditSnapshots = { before: Record<string, unknown>; after: Record<string, unknown> } | { explicit: AuditChange[] };

/** What the dispatch learns on the way that the row must say; it fills what it knows and leaves the rest. */
export interface ToolAuditFacts {
  /** The change list a tool handed over. Written to the row only for a call answered below 400. */
  snapshots?: AuditSnapshots;
  /** A create whose record landed and whose connections failed names the record it stored (`Q-170`): its arguments carry no id to name it by. */
  writtenId?: string;
  /** The members a read through a personal view read: the row then names them, and no space. */
  viewSpaces?: readonly string[];
  /** The space the REST path would name, and only a space that exists; empty until the call has named one. */
  auditSpace?: string;
}

/**
 * The status the caller is answered when the dispatch itself throws, which it is documented never to do. The REST door's global
 * error handler answers a thrown error's own HTTP status when it carries one and `500` for everything else, and the MCP door
 * answers a JSON-RPC internal error: both are a failure of ours, so the row says `500` unless the error names an HTTP status.
 */
function statusAnsweredForThrow(err: unknown): number {
  const status = err && typeof err === 'object' && 'status' in err ? (err as { status: unknown }).status : undefined;
  return typeof status === 'number' && status >= 400 && status < 600 ? status : 500;
}

/**
 * Run a tool call and write its audit row once, at the status it was answered, whatever the call did.
 *
 * `run` is the dispatch; it is handed the facts to fill. A call that throws is recorded at the status the caller is answered
 * (`statusAnsweredForThrow`) and rethrown, so a door that catches sees what it always saw.
 */
export async function auditedToolCall<T extends { status: number }>(
  name: string, caller: ToolCaller, args: unknown, run: (facts: ToolAuditFacts) => Promise<T>,
): Promise<T> {
  const startedAt = Date.now();
  const facts: ToolAuditFacts = {};
  let status = 500;
  try {
    const outcome = await run(facts);
    status = outcome.status;
    return outcome;
  } catch (err) {
    status = statusAnsweredForThrow(err);
    throw err;
  } finally {
    recordToolCall(caller, name, status, Date.now() - startedAt, args, facts);
  }
}

/**
 * Write one audit entry per tool call, whichever door it came through.
 *
 * Under the operation the capability records, not `mcp.<tool>` — a compliance reader asks who created a
 * fact, not who invoked a tool, and two names for one act makes every query have to know both. `path`
 * carries the transport and the tool name, so which door is still recoverable.
 *
 * The REST door is audited from here rather than by `audit/middleware.ts`: a `ROUTE_RULES` row per tool
 * would be forty-five hand-written copies of a mapping `mcpAuditOperation` already derives, and the row
 * that was forgotten is an unaudited mutation. A REST route that runs a tool AND has a route rule of its own
 * (`POST /api/brain/recall`, `/similar`, `/:space/traverse`) is recorded here too, under its own path
 * (`caller.routePath`), and tells the middleware so (`caller.onAudited`): this row knows the space the body
 * named and a view's members, which the route rule cannot see, and one call is one row (Q-444).
 */
/** The longest `entryId` a row keeps: a record id is a UUID or a short path, and an id the call never resolved is the caller's text. */
const MAX_AUDIT_ENTRY_ID = 512;

function recordToolCall(caller: ToolCaller, toolName: string, status: number, durationMs: number, args: unknown, facts: ToolAuditFacts): void {
  // The ARGUMENTS, because a capability with two subjects is audited under the subject of the call:
  // `network_sync` with a `peerId` records what the per-peer route records (`Q-37`).
  const act = mcpActOperation(toolName);
  const operation = act ?? mcpAuditOperation(toolName, args);
  if (!operation) return;                       // deliberately not an audited operation — see audit-map.ts
  // Decided here, so the route rule of the request this call serves writes no second row; said BEFORE the logReads filter,
  // which both writers apply alike, so a read the log does not record is recorded by neither.
  caller.onAudited?.();
  // The one filter, as REST's: a READ is a row only when the log records reads, at every status. An act is never a read.
  if (!act && isMcpReadOperation(operation) && !getConfig().audit?.logReads) return;
  const { snapshots, writtenId, viewSpaces, auditSpace } = facts;
  logAuditEntry({
    requestId: currentRequestId() ?? null,
    tokenId: caller.tokenId ?? null,
    tokenLabel: caller.tokenLabel ?? null,
    authMethod: caller.authMethod,
    oidcSubject: caller.oidcSubject,
    ip: caller.ip,
    method: caller.transport === 'mcp' ? 'MCP' : 'POST',
    path: caller.transport === 'mcp' ? `http:${toolName}` : (caller.routePath ?? `/api/${toolName}`),
    // A read through a personal view is ONE row with no space and the members read: nothing in it names the view.
    spaceId: viewSpaces ? null : (auditSpace || null),
    ...(viewSpaces ? { spaces: [...viewSpaces] } : {}),
    // Q-50: the record the call acted on, as the REST entry names it from the path. A tool's `id` argument is always
    // its subject's id, so an operator filtering the log by record finds the MCP edit beside the REST one.
    // `writtenId`: a create whose record landed and whose connections failed names the record it stored (`Q-170`) —
    // its arguments carry no id to name it by.
    // Held to MAX_AUDIT_ENTRY_ID: a refused call's `id` is whatever the caller sent, and the body may be megabytes.
    entryId: writtenId ?? (typeof (args as Record<string, unknown> | null)?.['id'] === 'string'
      && ((args as Record<string, string>)['id']!).length <= MAX_AUDIT_ENTRY_ID ? (args as Record<string, string>)['id']! : null),
    operation,
    status,
    durationMs,
    // Q-50: the same `changes` the REST twin's entry carries, and on the same condition — only a call that
    // succeeded, because a refused edit changed nothing and its intended values would claim one.
    ...(status < 400 && snapshots
      ? { changes: 'explicit' in snapshots ? snapshots.explicit : auditChanges(operation, snapshots.before, snapshots.after) } : {}),
  });
}
