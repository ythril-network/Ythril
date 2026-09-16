import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig } from '../config/loader.js';
import { log, currentRequestId } from '../util/log.js';
import { reachableSpaceIds } from '../auth/space-reach.js';
import { toolRightsRefusal, spaceAdminRefusal } from './tool-rights-guard.js';
import type { TokenRights } from '../config/rights-shape.js';
import { memberSpacesWithin } from '../spaces/proxy-scoped.js';
import { classifyReadFailure } from '../brain/store-failure.js';
import { ALL_TOOLS, TOOLS_BY_NAME, type ToolSchemas } from './tools/index.js';
import { SchemaViolationError } from '../brain/write-validation.js';
import { makeArgsValidator } from './validate-args.js';

/** Create an MCP Server instance with tools operating across all accessible spaces.
 *
 *  Tool schemas, authorization gates and handlers all come from the registry in
 *  ./tools — there is one source of truth per tool. */
/**
 * @param audit  Caller identity for the audit trail, snapshotted at construction.
 *
 *   The reason used to be the SSE transport: it built one server per CONNECTION and then served many tool
 *   calls over it, so there was no `req` in scope at dispatch time — only the one that had opened the stream.
 *   SSE is gone in 4.0 and streamable HTTP builds a server per REQUEST, so a request IS in scope now.
 *
 *   It stays a parameter anyway, because the tool handlers below close over what they are given and never
 *   reach for a request. That is what makes them exercisable without a transport at all, and it is the reason
 *   the identity in an audit entry cannot drift from the identity that was authorized.
 */
/**
 * The rights off a token record, or `undefined` for one that has none.
 *
 * A cast because the record is a UNION and the narrowing cannot be expressed on it. Both arms now carry a
 * matrix: a PAT stores one (`createToken` always writes it, and a boot migration backfills the rest), and as
 * of 3.0 an OIDC record derives one per request from the same `migrateToken` the migration uses.
 *
 * That second half was a hole rather than a gap. The rights guard skips a token with no matrix, so every OIDC
 * connection was governed by the old `readOnly`/`admin` booleans while PATs were enforced per space and per
 * area — one policy with two implementations, which is what S-1 was about, on the surface nobody checked.
 *
 * `undefined` therefore now means a record shape that predates both, not "the OIDC path".
 *
 * The same cast appears at every other rights call site (`middleware.ts`, the three `accessibleSpaces` helpers). It is
 * a narrowing the union cannot express, and writing it once here keeps this file from repeating it per transport.
 */
function tokenRights(record: unknown): TokenRights | undefined {
  return (record as { rights?: TokenRights } | undefined)?.rights;
}

/**
 * `readOnly` is gone from this parameter list (D-8d).
 *
 * It was threaded from the token record through here into `ToolContext.readOnly` — four layers — and READ
 * BY NO TOOL. Every mutating decision asks the rights matrix instead: `canWriteAnywhere` for visibility,
 * `effectiveRung` per call. Deleting the field is what makes that provable rather than merely true today.
 */
function createGlobalMcpServer(tokenId?: string, tokenLabel?: string,
  audit?: { ip: string; authMethod: 'pat' | 'oidc' | null; oidcSubject: string | null; transport: 'http' },
  rights?: TokenRights): Server {
  const cfg = getConfig();
  // The rights matrix decides this, with `tokenSpaces` as the fallback for records that carry no rights.
  //
  // Until now MCP answered from `tokenSpaces` ALONE while the HTTP guard used `reachesSpace`. Two surfaces, one rule,
  // one of them weaker — the shape of the four defects fixed on 2026-08-05. It was not exploitable, because the
  // migration derives `rights` FROM `spaces` and a test proves they agree across 50 comparisons. The problem was that
  // they can now DIVERGE: a token edited through the rights-matrix editor has a `spaces` array that no longer
  // describes it, and MCP was still reading the array. The error had no fixed direction either — the matrix can be
  // narrower than the legacy list as well as wider, so this was not "MCP is more permissive", it was "MCP is
  // answering from stale data".
  //
  // A `&&` of the two would be worse than either: the matrix can be wider, so combining them would silently refuse
  // access the matrix grants.
  //
  // NOTE the parameter count. Seven positionals is past the point where a caller can get the order right by reading
  // the call, and this change made it worse rather than better; it wants to be one `caller` object. Filed rather than
  // done here, because rewriting the signature and every use of the five it replaces is a bigger diff than the
  // correctness fix it would be hiding inside.
  // Through the shared helper rather than the same filter written here: a body-scoped REST route asks the
  // identical question, and the last time this rule had two implementations MCP answered from `tokenSpaces`
  // while HTTP used `reachesSpace`.
  const accessibleSpaceIds = reachableSpaceIds(rights, cfg.spaces.map(s => s.id));
  const accessibleSpaces = cfg.spaces.filter(s => accessibleSpaceIds.includes(s.id));
  const spacesLine = accessibleSpaces.length > 0
    ? accessibleSpaces.map(s => s.id + (s.label ? ` ("${s.label.replace(/[\x00-\x1f]/g, '').slice(0, 200)}")` : '')).join(', ')
    : '(none accessible)';
  const instructions = `Ythril knowledge graph — global mode.\nAvailable spaces: ${spacesLine}.\nEach tool requires a "space" parameter (except recall, list_chrono, and find_similar, where it is optional and enables cross-space results when omitted; and list_peers/sync_now which are global). Call list_spaces for details. Tool arguments are validated against each tool's inputSchema (from tools/list) — read it before calling.`;

  const server = new Server(
    { name: 'ythril', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions },
  );

  const spaceEnumBase = accessibleSpaceIds.length > 0 ? { enum: accessibleSpaceIds } : {};

  // The `space` enum depends on this token's accessible spaces, so tool schemas
  // are built per server instance rather than being static.
  const schemas: ToolSchemas = {
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

  // Enforce each tool's advertised inputSchema on incoming args (not just the JSON-RPC envelope), so the
  // schema tools/list publishes is the real contract. Built per connection because the `space` enum is
  // token-scoped; handlers keep their semantic checks on top.
  const argsValidator = makeArgsValidator(schemas);

  // Tools this token may see: read-only tokens lose mutating tools, non-admin
  // tokens lose instance-level tools. Both gates are re-enforced on dispatch.
  // One predicate, shared with `help` and with the two dispatcher gates below. It used to be this
  // expression written out four times, twice under a comment claiming they were one source of truth.
  const visibleTools = ALL_TOOLS.filter(t => toolIsVisible(t, rights));

  // ── tools/list ────────────────────────────────────────────────────────────
  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: visibleTools.map(t => ({
      name: t.name,
      description: t.description,
      inputSchema: t.inputSchema(schemas),
    })),
  }));

  /**
   * Write one audit entry per tool call.
   *
   * Under the operation the tool's REST counterpart records, not `mcp.<tool>` — a compliance reader
   * asks who created a fact, not who invoked a tool, and two names for one act makes every query
   * have to know both. `path` carries the tool name so the transport is still recoverable.
   *
   * Reads follow the REST convention: recorded only when `logReads` is on. Fire-and-forget, like
   * every other audit write — a failing log must never fail the operation it is describing.
   */
  function recordToolCall(toolName: string, spaceId: string, status: number, durationMs: number): void {
    const operation = mcpAuditOperation(toolName);
    if (!operation) return;                       // deliberately not an audited operation — see audit-map.ts
    if (isMcpReadOperation(operation) && !getConfig().audit?.logReads) return;
    logAuditEntry({
      /*
       * The id of the HTTP request carrying this tool call — which is the right one even over SSE, where the
       * response leaves on a long-lived stream: the call arrived on a POST, and that POST is the request whose
       * log lines describe this work.
       *
       * Read directly rather than captured, because this runs inside the dispatch that the request awaits.
       */
      requestId: currentRequestId() ?? null,
      tokenId: tokenId ?? null,
      tokenLabel: tokenLabel ?? null,
      authMethod: audit?.authMethod ?? null,
      oidcSubject: audit?.oidcSubject ?? null,
      ip: audit?.ip ?? '',
      method: 'MCP',
      path: `${audit?.transport ?? 'http'}:${toolName}`,
      spaceId: spaceId || null,
      operation,
      status,
      durationMs,
    });
  }

  // ── tools/call ────────────────────────────────────────────────────────────
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const a = (args ?? {}) as Record<string, unknown>;

    // Unknown tools fall through the gates below (they carry no flags) and are
    // reported inside the try block, preserving the original dispatch behaviour.
    const tool = TOOLS_BY_NAME.get(name);

    // Reachability, from the same predicate that built `tools/list` — so the listing cannot advertise a
    // tool this refuses, which is what two hand-copied expressions could not guarantee. Filtering the list
    // stays advisory; the dispatcher is still the enforcement point.
    //
    // An unknown tool carries no flags and falls through, as it always did, to be reported inside the try
    // block below.
    if (tool && !toolIsVisible(tool, rights)) {
      return {
        content: [{
          type: 'text' as const,
          text: tool.admin
            ? `Error: tool '${name}' requires a token with instance-admin rights`
            // Without its own branch a space-admin tool would be refused as "mutates, and this token holds no
            // write rung", which names the wrong missing thing — a token can hold write everywhere and still
            // administer nothing.
            : tool.spaceAdmin
              ? `Error: tool '${name}' configures a space, and this token administers none — it needs the admin `
                + 'rung on all four areas (knowledge, files, schema, dataQuality) of some space, or instance-admin rights'
              : `Error: tool '${name}' mutates, and this token holds no write rung in any space`,
        }],
        isError: true,
      };
    }

    /*
     * Validate the space parameter, which is one name, a LIST of names (5.0, search family only), or absent.
     *
     * Parsed into one shape — `rawSpaces` — before anything is checked. The existence check, the proxy
     * expansion and the rung check then run over a list of one in the common case, so there is no branch
     * where a check applies to a single space and not to a listed one.
     */
    const spaceArg = a['space'];
    let rawSpaces: string[];
    if (Array.isArray(spaceArg)) {
      if (!tool?.spaceList) {
        return { content: [{ type: 'text' as const, text: `Error: tool '${name}' takes one 'space', not a list` }], isError: true };
      }
      if (!spaceArg.every(v => typeof v === 'string')) {
        return { content: [{ type: 'text' as const, text: `Error: every entry in 'space' must be a space name` }], isError: true };
      }
      if (spaceArg.length === 0) {
        // NOT read as "no space named". An empty list is what a caller's own filter produces when it
        // matches nothing, and widening that to every reachable space is the opposite of what they meant.
        return { content: [{ type: 'text' as const, text: `Error: 'space' is an empty list. Name at least one space, or omit 'space' to search every space you can reach` }], isError: true };
      }
      rawSpaces = [...new Set(spaceArg.map(v => v.trim()).filter(v => v.length > 0))];
      if (rawSpaces.length === 0) {
        return { content: [{ type: 'text' as const, text: `Error: every entry in 'space' must be a space name` }], isError: true };
      }
    } else {
      const one = typeof spaceArg === 'string' ? spaceArg.trim() : '';
      rawSpaces = one ? [one] : [];
    }
    const rawSpace = rawSpaces[0] ?? '';
    if (tool?.spaceRequired && rawSpaces.length === 0) {
      return { content: [{ type: 'text' as const, text: `Error: tool '${name}' requires a 'space' parameter` }], isError: true };
    }
    /*
     * EVERY named space, not the first. One unreachable name refuses the whole call — owner decision,
     * 2026-09-16 — because dropping it would return a SHORTER answer, and a caller cannot tell a filtered
     * result from a small one. The refusal names only the space that failed: listing the ones that WERE
     * reachable hands an unauthorised caller an inventory of what exists.
     */
    for (const sid of rawSpaces) {
      if (!cfg.spaces.some(s => s.id === sid)) {
        return { content: [{ type: 'text' as const, text: `Error: Space '${sid}' not found` }], isError: true };
      }
      if (memberSpacesWithin(sid, accessibleSpaceIds).length === 0) {
        return { content: [{ type: 'text' as const, text: `Error: token does not have access to '${sid}' or any of its member spaces` }], isError: true };
      }
    }
    if (rawSpace) {
      // Proxy scope check, mirroring `enforceSpaceScope` on the REST layer — and it has to keep mirroring it, or the
      // two surfaces answer one question differently, which is the defect #786 fixed one layer up.
      //
      // A proxy is usable when the connection reaches AT LEAST ONE member; the tools then read only the members it
      // reaches, via `memberSpacesWithin`. It used to require EVERY member, which is why a scoped token could not be
      // given a proxy at all (Q-6).
      //
      // Safe now only because every MCP fan-out was narrowed first. With the wide fan-outs still in place, a token
      // reaching one member of a `proxyFor: ['*']` wildcard would have read every space on the instance.
      //
      // For a non-proxy space `resolveMemberSpaces` returns `[rawSpace]`, so "at least one of one" is the same
      // predicate as "all of one" and nothing changes there.
      // The reach check moved into the loop above so it covers every named space. Kept here as a
      // binding for the rights check below, which reads the members of the FIRST named space.
      const members = memberSpacesWithin(rawSpace, accessibleSpaceIds);
      // The rights matrix, enforced on MCP. Until 3.0 this dispatcher gated on two BOOLEANS — `readOnly`
      // above, and the tool's `admin` flag — while REST enforced a per-space, per-area RUNG. One policy,
      // two implementations, and the weaker one was reachable. The decision lives in a pure function so it
      // can be exercised without a transport: a guard testable only by reading it is one whose test cannot
      // tell live code from dead, and the first version of this check passed against `if (false && ...)`.
      const rightsRefusal = toolRightsRefusal(name, rights, rawSpace);
      if (rightsRefusal) {
        return { content: [{ type: 'text' as const, text: rightsRefusal }], isError: true };
      }
      // And the space-admin question, for the tools that configure ONE space. `toolIsVisible` admitted anyone
      // administering *a* space, because `tools/list` runs before a space is named; this is where the space
      // exists, so this is where "administers THIS one" can be asked. Same two-width split as the REST guard,
      // and for the same reason: the wider one alone would let the administrator of Research reconfigure
      // Finance.
      const adminRefusal = spaceAdminRefusal(tool, rights, rawSpace);
      if (adminRefusal) {
        return { content: [{ type: 'text' as const, text: adminRefusal }], isError: true };
      }
    }
    const callSpace = rawSpace;

    try {
      mcpToolCallsTotal.inc({ tool: name, space: callSpace || 'global' });
      if (!tool) {
        return {
          content: [{ type: 'text' as const, text: `Unknown tool: ${name}` }],
          isError: true,
        };
      }
      // Enforce the advertised inputSchema before the handler runs — except partial-success tools
      // (bulk_write), which report per-item errors in the result rather than rejecting the whole call.
      if (!tool.skipSchemaValidation) {
        const argErr = argsValidator.validate(tool, a);
        if (argErr) {
          return { content: [{ type: 'text' as const, text: `Error: ${argErr}` }], isError: true };
        }
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
        // Populated, not merely declared. `toolIsVisible(t, undefined)` hides every mutating and admin
        // tool, so an unpopulated `rights` here would empty `help`'s listing while `tools/list` stayed
        // correct — the two disagreeing again, in the one mechanism built to stop that.
        rights,
        actor: { tokenId, tokenLabel },
      });
      // A tool that returns `isError` failed on its own terms — the transport still answered 200, so
      // the audit status has to come from the RESULT or the log would record every rejected write as
      // a success. 422 rather than 400: the call was well-formed and the handler refused it.
      recordToolCall(name, callSpace, result?.isError ? 422 : 200, Date.now() - startedAt);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.warn(`MCP global tool '${name}' error in space '${callSpace || 'global'}': ${message}`);
      // A refusal that carries its own classification keeps it. Attached HERE, once, rather than in each
      // tool: every write tool funnels through this catch, and the alternative was editing a dozen throw
      // sites — which is how the `introduced` / `preExisting` split came to survive on the REST routes and
      // not on this one. The prose stays the whole answer for a client that reads only `content`.
      const structuredContent = err instanceof SchemaViolationError ? err.toStructured() : undefined;
      /**
       * A STORE failure says so here too, and carries the same `retryable` the REST doors put in their body.
       *
       * This door has no status code to correct — the transport answers 200 with `isError: true` — so the
       * parity is in the CONTENT, which is the rule in `CLAUDE.md`: when the doors must differ, the difference
       * is the transport's shape and never what a caller is told. Without this, an agent on MCP would have got
       * the truncated `caused by ::` prose that told fourteen personas nothing, while a REST caller alongside
       * it got a 503 and a reason.
       *
       * Attached in this catch for the same reason `SchemaViolationError` is: every tool funnels through here,
       * so a tool added tomorrow inherits it rather than needing to remember.
       */
      const readFailure = classifyReadFailure(err);
      const failureContent = readFailure.retryable
        ? { retryable: true, storeSideFailure: true, error: readFailure.error,
            ...(readFailure.code !== undefined ? { code: readFailure.code } : {}),
            ...(readFailure.codeName ? { codeName: readFailure.codeName } : {}) }
        : undefined;
      return {
        content: [{ type: 'text' as const, text: `Error: ${readFailure.retryable ? readFailure.error : message}` }],
        isError: true,
        ...(structuredContent ? { structuredContent } : failureContent ? { structuredContent: failureContent } : {}),
      };
    }
  });

  return server;
}

// ── Express router ───────────────────────────────────────────────────────────

import { requireMcpAuth } from '../auth/middleware.js';
import { logAuditEntry } from '../audit/audit.js';
import { auditAuthMethod, auditOidcSubject } from '../audit/middleware.js';
import { mcpAuditOperation, isMcpReadOperation } from './audit-map.js';
import { mcpToolCallsTotal } from '../metrics/registry.js';
import { toolIsVisible } from './tool-visibility.js';

export const mcpRouter = Router();

// All MCP routes require authentication — unauthenticated requests must not
// fall through to the SPA and return 200. On a 401 this also emits the RFC 9728
// WWW-Authenticate header so OAuth browser connectors can discover the
// authorization server and begin the OAuth flow.
mcpRouter.use(requireMcpAuth);

/*
 * The SSE transport is REMOVED (4.0), and both of its endpoints say so rather than 404.
 *
 * `GET /mcp` opened a stream that handed back a `sessionId`, and `POST /mcp/messages?sessionId=…` carried the
 * tool calls. That pair is the MCP SDK's own legacy transport — its deprecation, not ours — and streamable
 * HTTP has been the recommended one in every guide throughout 3.x.
 *
 * A removed endpoint that falls through to the generic `Not found` leaves the client's author guessing, which
 * is the same silent-misconfiguration failure the removed env vars were given a boot refusal for. So each
 * answers with the status that is true of it and names the transport to use.
 *
 * `GET` gets **405 with `Allow: POST`**, not 410: the resource `/mcp` still exists and still speaks MCP — it
 * is the METHOD that is gone. That is also what the MCP specification asks of a server with no
 * server-initiated stream, so a spec-following client reads it correctly without reading the message.
 *
 * `POST /mcp/messages` gets **410 Gone**: that path is not coming back under any method.
 *
 * Both sit behind `requireMcpAuth` (mounted above), so an unauthenticated probe still gets the 401 carrying
 * the RFC 9728 `WWW-Authenticate` header — OAuth discovery is unchanged by this removal.
 */
const USE_STREAMABLE_HTTP = 'The MCP SSE transport was removed in 4.0. Use the Streamable HTTP transport: '
  + 'POST /mcp with a JSON-RPC body and an Authorization: Bearer header.';

mcpRouter.get('/', globalRateLimit, (_req, res) => {
  res.setHeader('Allow', 'POST');
  res.status(405).json({ error: USE_STREAMABLE_HTTP });
});

mcpRouter.post('/messages', globalRateLimit, (_req, res) => {
  res.status(410).json({ error: USE_STREAMABLE_HTTP });
});

// POST /mcp  — Streamable HTTP transport (stateless, per-request)
// Supports both application/json (synchronous response) and text/event-stream (SSE upgrade).
// This transport requires no persistent connection and works through standard HTTP proxies.
mcpRouter.post('/', globalRateLimit, async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  const server = createGlobalMcpServer(req.authToken?.id, req.authToken?.name,
    { ip: req.ip ?? '', authMethod: auditAuthMethod(req.authToken), oidcSubject: auditOidcSubject(req.authToken), transport: 'http' }, tokenRights(req.authToken));
  // Register cleanup before handling the request so it fires regardless of outcome.
  res.on('close', () => {
    transport.close();
    server.close();
  });
  try {
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  } catch (err) {
    log.error('MCP Streamable HTTP error', err);
    if (!res.headersSent) {
      res.status(500).json({
        jsonrpc: '2.0',
        error: { code: -32603, message: 'Internal server error' },
        id: (req.body as Record<string, unknown>)?.id ?? null,
      });
    }
  }
});

// Catch-all for unrecognised MCP paths — must not fall through to SPA
mcpRouter.use((_req, res) => {
  res.status(404).json({ error: 'Not found' });
});
