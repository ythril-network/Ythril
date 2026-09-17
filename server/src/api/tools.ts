/**
 * The REST door onto the tools: `POST /api/<tool-name>`, body EXACTLY the tool's arguments.
 *
 * ## Why this router exists, and why it is ONE route
 *
 * Owner, 2026-09-16: *"every route with `spaces/:spaceId` should actually have space as parameter string
 * or array and almost all should be `/api/<mcp-tool-name>`"*, *"the body can be EXACTLY the mcp tool
 * (create modules that are used by both doors)"*, and then *"this shared module concept for both doors
 * should be applied to each and every tool"*.
 *
 * Written one tool at a time that is forty-five hand-written adapters, and the value of a shared module is
 * spent the moment somebody writes the forty-sixth tool and only one of its two doors. So the door is
 * generic: the tool name is the path, the body is the arguments, and `callTool` — the same function the MCP
 * dispatcher calls — does everything between.
 *
 * There is no per-tool code here to get out of step, because there is no per-tool code here.
 *
 * ## What this route does NOT do, and each absence is deliberate
 *
 * - **No authorization.** Not "less" of it: none. Visibility, reach, the per-space rung, the space-admin
 *   grant and the destructive-call throttle are all inside `callTool`, so REST and MCP are governed by one
 *   set of `TOOL_RIGHTS` rows rather than by `ROUTE_RIGHTS` on one side and `TOOL_RIGHTS` on the other.
 *   That divergence is what let a token be refused `DELETE /api/brain/spaces/general/facts/:id` and allowed
 *   the identical delete through `delete_fact`.
 * - **No space parsing.** `space` is a body field — one name or a list — parsed once, in the shared module.
 * - **No status decisions.** The status comes back with the result. Deriving it here from the message text
 *   would be this door deciding what the other door's refusal meant.
 * - **No audit row.** `callTool` writes one for both doors, from `mcpAuditOperation`. Forty-five
 *   `ROUTE_RULES` patterns would be forty-five chances to forget one, and the forgotten one is an
 *   unaudited mutation.
 *
 * ## The envelope
 *
 * One shape for every tool, so a caller writes the response handling once:
 *
 * - `200 {ok: true, text, data}` — `text` is the prose an agent would read, `data` the structured result
 *   (`null` for a tool that has none). Both carry the whole answer; neither is a summary of the other.
 * - `4xx/5xx {ok: false, error, data}` — `error` is the same sentence MCP puts in its `content`, word for
 *   word. A caller comparing the two doors should never have to work out that two wordings mean the same.
 */
import { Router, type RequestHandler } from 'express';
import { requireAuth } from '../auth/middleware.js';
import { globalRateLimit } from '../rate-limit/middleware.js';
import { restToolCaller } from './rest-tool-caller.js';
import { TOOLS_BY_NAME } from '../mcp/tools/index.js';
import { callTool } from '../mcp/call-tool.js';

export const toolsRouter = Router();

/**
 * Leave the router when the path segment is not a tool name.
 *
 * `next('router')` hands control back to `app`, so `POST /api/spaces` reaches the spaces router exactly as
 * it did before this router was mounted in front of it. Answering 404 here instead would break every
 * single-segment `/api` route on the instance, which is the failure mode of a greedy `/:param` mount.
 *
 * `no-tool-name-shadows-a-mounted-router.test.js` asserts the two name sets stay disjoint anyway: a tool
 * called `spaces` tomorrow would swallow space creation, and it would do it silently.
 */
const onlyToolNames: RequestHandler = (req, _res, next) => {
  next(TOOLS_BY_NAME.has(toolNameOf(req)) ? undefined : 'router');
};

/** The `:tool` segment as a plain string. Express types it as possibly an array; a path segment never is. */
const toolNameOf = (req: { params: Record<string, string | string[] | undefined> }): string => {
  const raw = req.params['tool'];
  return typeof raw === 'string' ? raw : '';
};

const serveTool: RequestHandler = async (req, res) => {
  // The body IS the arguments. Nothing is renamed, defaulted or injected on the way through: a door that
  // adds a field is a door whose callers cannot be told "the body is the tool's arguments" and believe it.
  const outcome = await callTool({
    name: toolNameOf(req),
    args: (req.body ?? {}) as Record<string, unknown>,
    caller: restToolCaller(req),
  });

  const text = outcome.result.content.map(c => c.text).join('\n');
  const data = outcome.result.structuredContent ?? null;
  if (outcome.result.isError) {
    res.status(outcome.status).json({ ok: false, error: text, data });
    return;
  }
  res.status(outcome.status).json({ ok: true, text, data });
};

toolsRouter.post('/:tool', onlyToolNames, globalRateLimit, requireAuth, serveTool);
