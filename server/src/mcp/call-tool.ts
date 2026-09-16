/**
 * Invoking a tool — the whole capability layer, in one function both doors call.
 *
 * ## Why this file exists
 *
 * Owner, 2026-09-16: *"create modules that are used by both doors"*, and then *"this shared module concept
 * for both doors should be applied to each and every tool"*.
 *
 * Done one capability at a time that is forty-five modules and ninety adapters, and the forty-sixth tool is
 * written by someone who does one of the two. So it is done ONCE, here: everything between *a caller named
 * a tool* and *the tool answered* lives in this function, and each door is a translation of its own
 * envelope into these arguments and back out of this result.
 *
 * MCP hands it a JSON-RPC `tools/call`. REST hands it `POST /api/<tool-name>` with the arguments as the
 * body. They cannot drift, because there is nothing left to drift — no second gate, no second space parse,
 * no second rung check, no second error classification.
 *
 * ## What was two implementations until now, and what each one had that the other did not
 *
 * The gates below ran inside the MCP dispatcher and nowhere else, while the REST routes were guarded
 * per-route by `ROUTE_RIGHTS` middleware. Both were defensible and they answered differently:
 *
 * - the rung check ran against the FIRST named space only, so a three-space `recall` was authorised
 *   against one of the three. REST's body-scoped guard checked every one. Fixed here by looping, which
 *   is the change that made the extraction worth doing rather than a move.
 * - the destructive-call throttle was express middleware, so it existed on REST and not on MCP. It is a
 *   counter in this function now, so an agent gets the same five-a-minute a browser does.
 *
 * ## What an adapter may do
 *
 * Translate. A status code, a prose rendering, an envelope. It may NOT decide: a check that appears in an
 * adapter is a rule with two implementations again, one layer in, and the copy that gets forgotten is
 * whichever door its author was not using that day.
 */
import { getConfig } from '../config/loader.js';
import { log, currentRequestId } from '../util/log.js';
import { reachableSpaceIds } from '../auth/space-reach.js';
import { toolRightsRefusal, spaceAdminRefusal } from './tool-rights-guard.js';
import { toolIsVisible } from './tool-visibility.js';
import type { TokenRights } from '../config/rights-shape.js';
import { memberSpacesWithin } from '../spaces/proxy-scoped.js';
import { classifyReadFailure } from '../brain/store-failure.js';
import { SchemaViolationError } from '../brain/write-validation.js';
import { TOOLS_BY_NAME, type ToolResult, type ToolSchemas } from './tools/index.js';
import { makeArgsValidator } from './validate-args.js';
import { consumeHeavyToolCall } from '../rate-limit/heavy-tool.js';
import { logAuditEntry } from '../audit/audit.js';
import { mcpAuditOperation, isMcpReadOperation } from './audit-map.js';
import { toolCallsTotal } from '../metrics/registry.js';

/**
 * The `space` schemas injected into every tool's `inputSchema`.
 *
 * Built from the spaces THIS token reaches, so the enum a caller reads is the set it may actually name.
 * Exported because `tools/list` needs the same object the validator was built from — two builders would be
 * a schema advertised that the validator does not enforce.
 */
export function toolSchemasFor(accessibleSpaceIds: readonly string[]): ToolSchemas {
  const spaceEnumBase = accessibleSpaceIds.length > 0 ? { enum: [...accessibleSpaceIds] } : {};
  return {
    requiredSpace: { type: 'string' as const, ...spaceEnumBase, description: 'Space ID to operate on. Use list_spaces to discover available spaces.' },
    optionalSpace: {
      oneOf: [
        { type: 'string' as const, ...spaceEnumBase },
        { type: 'array' as const, items: { type: 'string' as const, ...spaceEnumBase }, minItems: 1 },
      ],
      description: 'Optional space. ONE name searches that space; a LIST of names searches exactly those, '
        + 'and one you cannot reach refuses the whole call rather than quietly returning less — a short '
        + 'answer and a filtered one are indistinguishable. Omit it to search every space this token can '
        + 'reach. An empty list is refused rather than read as "all".',
    },
  };
}

/** Who is calling, for the rung checks and the audit trail. Snapshotted by the door at its own edge. */
export interface ToolCaller {
  rights?: TokenRights;
  tokenId?: string;
  tokenLabel?: string;
  ip: string;
  authMethod: 'pat' | 'oidc' | null;
  oidcSubject: string | null;
  /** Which door. Recorded in the audit trail so the transport stays recoverable; changes nothing else. */
  transport: 'mcp' | 'rest';
}

export interface ToolCallOutcome {
  result: ToolResult;
  /**
   * The HTTP status the REST door answers. MCP discards it — the JSON-RPC transport answers 200 and carries
   * the failure in `isError`, which is the MCP specification's shape rather than a difference of ours.
   *
   * It lives here and not in the REST adapter because mapping it there means re-deciding, from the message
   * text, what this function already knew: a refusal that says "not found" reaching a caller as a 400 is
   * how the two doors start disagreeing about what happened.
   */
  status: number;
  /** The first space the call resolved to, for the caller's own logging. Empty for instance-level tools. */
  callSpace: string;
}

/** A refusal, with the status the REST door should use. Prose is identical on both doors, by construction. */
function refuse(status: number, text: string, callSpace = ''): ToolCallOutcome {
  return { result: { content: [{ type: 'text' as const, text }], isError: true }, status, callSpace };
}

export interface ToolCallRequest {
  name: string;
  args: Record<string, unknown>;
  caller: ToolCaller;
}

/**
 * Gate, resolve, dispatch, classify — for any tool, from any door.
 *
 * Never throws: a handler's exception is classified into a result and a status here, because a door that
 * has to catch is a door that gets to decide what the failure meant.
 */
export async function callTool(req: ToolCallRequest): Promise<ToolCallOutcome> {
  const { name, args: a, caller } = req;
  const { rights } = caller;
  const cfg = getConfig();
  const accessibleSpaceIds = reachableSpaceIds(rights, cfg.spaces.map(s => s.id));
  const accessibleSpaces = cfg.spaces.filter(s => accessibleSpaceIds.includes(s.id));

  // Unknown tools carry no flags and fall through the gates to be reported below, as they always did.
  const tool = TOOLS_BY_NAME.get(name);

  // Reachability, from the same predicate that builds `tools/list` — so a listing cannot advertise a tool
  // this refuses. Filtering the list stays advisory; this is the enforcement point.
  if (tool && !toolIsVisible(tool, rights)) {
    return refuse(403, tool.admin
      ? `Error: tool '${name}' requires a token with instance-admin rights`
      // Without its own branch a space-admin tool would be refused as "mutates, and this token holds no
      // write rung", which names the wrong missing thing — a token can hold write everywhere and still
      // administer nothing.
      : tool.spaceAdmin
        ? `Error: tool '${name}' configures a space, and this token administers none — it needs the `
          + 'spaceAdmin grant on some space, or instance-admin rights'
        : `Error: tool '${name}' mutates, and this token holds no write rung in any space`);
  }

  /*
   * The destructive-call throttle, and it counts ATTEMPTS rather than successes.
   *
   * It is IN here rather than in front of the REST route because that is where it used to be: express
   * middleware on five routes, and nothing at all on the MCP door. An agent emptying a space in a loop met
   * no limit a browser would have hit at the fifth call.
   *
   * Before the gates below, deliberately. A limiter that only counts calls which got past authorisation
   * cannot slow a caller down while they are getting it wrong, and "wrong in a loop" is most of what a
   * runaway agent does. Five a minute per token, refused or not.
   */
  if (tool?.heavy && !consumeHeavyToolCall(caller.tokenId ?? caller.ip)) {
    return refuse(429, `Error: tool '${name}' is rate limited — too many destructive calls, try again shortly`);
  }

  /*
   * Validate the space parameter, which is one name, a LIST of names (5.0, search family only), or absent.
   *
   * Parsed into one shape — `rawSpaces` — before anything is checked, so there is no branch where a check
   * applies to a single space and not to a listed one.
   */
  const spaceArg = a['space'];
  let rawSpaces: string[];
  if (Array.isArray(spaceArg)) {
    if (!tool?.spaceList) {
      return refuse(400, `Error: tool '${name}' takes one 'space', not a list`);
    }
    if (!spaceArg.every(v => typeof v === 'string')) {
      return refuse(400, `Error: every entry in 'space' must be a space name`);
    }
    if (spaceArg.length === 0) {
      // NOT read as "no space named". An empty list is what a caller's own filter produces when it matches
      // nothing, and widening that to every reachable space is the opposite of what they meant.
      return refuse(400, `Error: 'space' is an empty list. Name at least one space, or omit 'space' to search every space you can reach`);
    }
    rawSpaces = [...new Set(spaceArg.map(v => v.trim()).filter(v => v.length > 0))];
    if (rawSpaces.length === 0) {
      return refuse(400, `Error: every entry in 'space' must be a space name`);
    }
  } else if (spaceArg !== undefined && spaceArg !== null && typeof spaceArg !== 'string') {
    // An object or a number here used to reach the handler as the empty string — the cross-space case — so
    // a malformed `space` WIDENED the call instead of failing it.
    return refuse(400, `Error: 'space' must be a space name, or a list of them`);
  } else {
    const one = typeof spaceArg === 'string' ? spaceArg.trim() : '';
    rawSpaces = one ? [one] : [];
  }
  const rawSpace = rawSpaces[0] ?? '';
  if (tool?.spaceRequired && rawSpaces.length === 0) {
    return refuse(400, `Error: tool '${name}' requires a 'space' parameter`);
  }

  /*
   * EVERY named space, not the first — for existence, for reach, AND for the rung.
   *
   * The rung check used to sit outside this loop, reading the first entry. On a single-space call that is
   * the same thing, which is why it survived; on a three-space `recall` the token was authorised against
   * one of the three and read all three. The REST body-scoped guard checked every one, so this was the
   * two-doors defect in its usual form: both defensible, one weaker, and only visible from outside.
   *
   * One unreachable name refuses the whole call — owner decision, 2026-09-16 — because dropping it returns a
   * SHORTER answer, and a caller cannot tell a filtered result from a small one. The refusal names only the
   * space that failed: listing the reachable ones hands an unauthorised caller an inventory of what exists.
   */
  for (const sid of rawSpaces) {
    if (!cfg.spaces.some(s => s.id === sid)) {
      return refuse(404, `Error: Space '${sid}' not found`);
    }
    // A proxy is usable when the connection reaches AT LEAST ONE member; the tools then read only the
    // members it reaches. For a non-proxy space this returns the space itself, so it is one predicate.
    if (memberSpacesWithin(sid, accessibleSpaceIds).length === 0) {
      return refuse(403, `Error: token does not have access to '${sid}' or any of its member spaces`);
    }
    // The space is the one the CALLER named. For a proxy that is the proxy's own id, which is where an
    // operator grants access; checking a member here would let a proxy grant be bypassed by naming it.
    const rightsRefusal = toolRightsRefusal(name, rights, sid);
    if (rightsRefusal) return refuse(403, rightsRefusal);
    // And the space-admin question, for the tools that configure ONE space. `toolIsVisible` admitted anyone
    // administering *a* space, because it runs before a space is named; this is where one exists.
    const adminRefusal = spaceAdminRefusal(tool, rights, sid);
    if (adminRefusal) return refuse(403, adminRefusal);
  }
  const callSpace = rawSpace;

  try {
    toolCallsTotal.inc({ tool: name, space: callSpace || 'global', door: caller.transport });
    if (!tool) {
      return refuse(404, `Unknown tool: ${name}`, callSpace);
    }
    // Enforce the advertised inputSchema before the handler runs — except partial-success tools
    // (save_bulk), which report per-item errors in the result rather than rejecting the whole call.
    if (!tool.skipSchemaValidation) {
      const argErr = makeArgsValidator(toolSchemasFor(accessibleSpaceIds)).validate(tool, a);
      if (argErr) return refuse(400, `Error: ${argErr}`, callSpace);
    }
    const startedAt = Date.now();
    const result = await tool.handle({
      args: a,
      callSpace,
      callSpaces: rawSpaces,
      name,
      cfg,
      accessibleSpaces,
      accessibleSpaceIds,
      // Populated, not merely declared. `toolIsVisible(t, undefined)` hides every mutating and admin tool,
      // so an unpopulated `rights` here would empty `help`'s listing while `tools/list` stayed correct.
      rights,
      actor: { tokenId: caller.tokenId, tokenLabel: caller.tokenLabel },
    });
    // A tool that returns `isError` failed on its own terms, so the status has to come from the RESULT or
    // every rejected write would be logged as a success. 422: the call was well-formed and it was refused.
    const status = result?.isError ? 422 : 200;
    recordToolCall(caller, name, callSpace, status, Date.now() - startedAt);
    return { result, status, callSpace };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`tool '${name}' error in space '${callSpace || 'global'}': ${message}`);
    /*
     * Classified HERE, once, rather than in each tool — every write funnels through this catch, and the
     * alternative was editing a dozen throw sites, which is how the introduced/pre-existing split came to
     * survive on the REST routes and not on the MCP one. The prose stays the whole answer for a client that
     * reads only `content`.
     */
    if (err instanceof SchemaViolationError) {
      return {
        result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true, structuredContent: err.toStructured() },
        status: 422, callSpace,
      };
    }
    /*
     * A STORE failure says so on both doors, and carries the same `retryable` flag. Without it an agent got
     * the truncated prose that told fourteen personas nothing, while a REST caller alongside it got a 503
     * and a reason.
     */
    const readFailure = classifyReadFailure(err);
    if (readFailure.retryable) {
      return {
        result: {
          content: [{ type: 'text' as const, text: `Error: ${readFailure.error}` }],
          isError: true,
          structuredContent: { retryable: true, storeSideFailure: true, error: readFailure.error,
            ...(readFailure.code !== undefined ? { code: readFailure.code } : {}),
            ...(readFailure.codeName ? { codeName: readFailure.codeName } : {}) },
        },
        status: 503, callSpace,
      };
    }
    return { result: { content: [{ type: 'text' as const, text: `Error: ${message}` }], isError: true }, status: 400, callSpace };
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
 * that was forgotten is an unaudited mutation.
 */
function recordToolCall(caller: ToolCaller, toolName: string, spaceId: string, status: number, durationMs: number): void {
  const operation = mcpAuditOperation(toolName);
  if (!operation) return;                       // deliberately not an audited operation — see audit-map.ts
  if (isMcpReadOperation(operation) && !getConfig().audit?.logReads) return;
  logAuditEntry({
    requestId: currentRequestId() ?? null,
    tokenId: caller.tokenId ?? null,
    tokenLabel: caller.tokenLabel ?? null,
    authMethod: caller.authMethod,
    oidcSubject: caller.oidcSubject,
    ip: caller.ip,
    method: caller.transport === 'mcp' ? 'MCP' : 'POST',
    path: caller.transport === 'mcp' ? `http:${toolName}` : `/api/${toolName}`,
    spaceId: spaceId || null,
    operation,
    status,
    durationMs,
  });
}
