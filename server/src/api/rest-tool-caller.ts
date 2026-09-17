/**
 * Who is calling, as the REST door sees it — snapshotted in one place for every route that dispatches a tool.
 *
 * ## Why this is a module and not seven inlined lines
 *
 * There are two REST entry points into `callTool` now: the generic `POST /api/<tool-name>` door, and the
 * legacy `POST /api/brain/recall`, which used to hold four hundred lines of its own implementation of the
 * same capability. A third is one more collapse away — `filter` and `similar` sit beside it.
 *
 * The forgettable part is the middle of the object, not the ends. `rights` is what every rung check reads,
 * and `authMethod`/`oidcSubject` are what the audit trail records; a hand-written copy that stops at
 * `tokenId` and `ip` still compiles, still answers, still authorises correctly — and writes an audit entry
 * that cannot say how the caller proved who they were. That is the kind of omission nothing reports, which
 * is why the copy belongs here rather than at each door.
 *
 * `transport: 'rest'` is fixed rather than a parameter, because this is the REST snapshot: MCP builds its
 * own in `mcp/router.ts` from a connection rather than a request. One question per module.
 */
import { auditAuthMethod, auditOidcSubject } from '../audit/middleware.js';
import type { ToolCaller } from '../mcp/call-tool.js';
import type { TokenRights } from '../config/rights-shape.js';
import type { Request } from 'express';

export function restToolCaller(req: Request): ToolCaller {
  return {
    rights: (req.authToken as { rights?: TokenRights } | undefined)?.rights,
    tokenId: req.authToken?.id,
    tokenLabel: req.authToken?.name,
    ip: req.ip ?? '',
    authMethod: auditAuthMethod(req.authToken),
    oidcSubject: auditOidcSubject(req.authToken),
    transport: 'rest',
  };
}
