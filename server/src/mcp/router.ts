import { Router } from 'express';
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { getConfig } from '../config/loader.js';
import { log } from '../util/log.js';
import { reachableSpaceIds } from '../auth/space-reach.js';
import type { TokenRights } from '../config/rights-shape.js';
import { ALL_TOOLS, type ToolSchemas } from './tools/index.js';
import { callTool, toolSchemasFor, materialisedSchema } from './call-tool.js';
import { spaceScopeSentence } from './space-scope-sentence.js';

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
  const instructions = `Ythril knowledge graph — global mode.\nAvailable spaces: ${spacesLine}.\n${spaceScopeSentence(ALL_TOOLS.filter(t => toolIsVisible(t, rights)), toolSchemasFor(accessibleSpaceIds))} Call list_spaces for details. Tool arguments are validated against each tool's inputSchema (from tools/list) — read it before calling.`;

  const server = new Server(
    { name: 'ythril', version: '0.1.0' },
    { capabilities: { tools: {} }, instructions },
  );

  // The `space` enum depends on this token's accessible spaces, so tool schemas are built per server
  // instance. From the SAME builder `callTool` validates against — two builders is a schema advertised
  // in `tools/list` that the validator does not enforce.
  const schemas: ToolSchemas = toolSchemasFor(accessibleSpaceIds);

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
      // Through `materialisedSchema`, so what is ADVERTISED is what the validator enforces — see B-6.
      inputSchema: materialisedSchema(t, schemas, accessibleSpaceIds),
    })),
  }));

  // ── tools/call ────────────────────────────────────────────────────────────
  /*
   * tools/call — an ADAPTER, and nothing else.
   *
   * Every gate that used to live here — visibility, the space parse, existence, reach, the rung, the
   * space-admin question, arg validation, the throttle, the error classification, the audit entry — is in
   * `callTool`, which `POST /api/<tool-name>` calls with the same arguments. Owner, 2026-09-16: *"create
   * modules that are used by both doors"*, applied to every tool at once rather than one at a time.
   *
   * What is left is the JSON-RPC envelope: a name and an arguments object in, an MCP tool result out. The
   * `status` the shared function also returns is discarded here because this transport answers 200 and
   * carries the failure in `isError` — the specification's shape, not a difference of ours.
   */
  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: args } = request.params;
    const outcome = await callTool({
      name,
      args: (args ?? {}) as Record<string, unknown>,
      caller: {
        rights,
        tokenId,
        tokenLabel,
        ip: audit?.ip ?? '',
        authMethod: audit?.authMethod ?? null,
        oidcSubject: audit?.oidcSubject ?? null,
        transport: 'mcp',
      },
    });
    return outcome.result;
  });

  return server;
}

// ── Express router ───────────────────────────────────────────────────────────

import { requireMcpAuth } from '../auth/middleware.js';
import { auditAuthMethod, auditOidcSubject } from '../audit/middleware.js';
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
