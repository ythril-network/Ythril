import type { Config, SpaceConfig } from '../../config/types.js';
import type { WebhookActor } from '../../webhooks/dispatcher.js';
import type { TokenRights } from '../../config/rights-shape.js';

/**
 * The space schemas injected into each tool's `inputSchema`. The `space` enum is
 * derived from the calling token's accessible spaces, so schemas are built per
 * server instance rather than being static constants.
 */
export interface ToolSchemas {
  requiredSpace: Record<string, unknown>;
  optionalSpace: Record<string, unknown>;
}

/**
 * Everything a tool handler needs. Built once per `tools/call` by the dispatcher,
 * after the read-only / admin / space gates have already passed.
 */
export interface ToolContext {
  /** Raw tool arguments. */
  args: Record<string, unknown>;
  /** Validated space id for this call ('' for instance-level tools). */
  callSpace: string;
  /**
   * Every space this call resolved to: `[]` when none was named, one entry for a single name, several for
   * a list. Only tools declaring `spaceList` can see more than one here.
   *
   * `callSpace` stays the first-or-empty string so the forty-odd single-space tools are untouched — but a
   * tool that declares `spaceList` MUST read this instead, because `callSpace` on a three-space call names
   * one of the three and looks entirely reasonable.
   */
  callSpaces: string[];
  /** The tool's own name (used in a few error messages). */
  name: string;
  /**
   * Which door took this call.
   *
   * It governs exactly one thing and must keep governing exactly one thing: the default byte budget, via
   * `defaultBudgetChars`. An answer is trimmed lower for an agent than for a script because the agent pays
   * for the bytes out of its own context — a fact about the READER, which the handler cannot otherwise see.
   *
   * **Not a licence to branch on the door.** `CLAUDE.md` sanctions two divergences between the surfaces and
   * a third needs its own argument and its own gate; a handler that reads this for anything else has made
   * one door quietly weaker than the other, which is the defect this whole module exists to prevent.
   */
  transport: 'mcp' | 'rest';
  cfg: Config;
  accessibleSpaces: SpaceConfig[];
  accessibleSpaceIds: string[];
  // `isAdmin` was REMOVED in 3.1 (D-8d), following `readOnly` out for the same reason and by the same route.
  // The dispatcher decides from the matrix — `toolIsVisible` refuses an `admin: true` tool unless
  // `rights.instanceAdmin` — so the three handlers that re-checked it were each a second copy of a rule
  // already enforced above them, reading a boolean that no longer exists.
  /** True when the calling token is read-only (mutating tools are gated out). */
  // `readOnly` was REMOVED here in 3.1 (D-8d). It was declared, threaded from the token record through
  // `createGlobalMcpServer` into every tool's context — and read by none of them. Every mutating decision
  // asks the rights matrix instead: `canWriteAnywhere` for visibility, `effectiveRung` per call.
  /**
   * The calling token's rights matrix — what tool visibility and the per-call rung check are decided from.
   *
   * Present for every connection: a PAT stores one, a boot migration backfills the rest, and an OIDC record
   * derives one per request. `isAdmin` and `readOnly` above are the legacy pair it replaces and are on their
   * way out; nothing should read them for a new decision.
   */
  rights?: TokenRights;
  /** Identity of the calling token, for webhook attribution. Passed to shared brain/file
   *  mutation functions so agent-driven writes emit attributed webhooks like REST writes. */
  actor?: WebhookActor;
  /**
   * Hand the audit entry the record as it was and as it now is (`Q-50`). The REST twin of every editing tool sets
   * `req.auditSnapshots`, and the audit middleware turns it into the entry's `changes`; without this the same edit
   * left a thinner entry on MCP. Called once, after a successful write. `callTool` supplies it on every call.
   */
  recordChanges?: (before: Record<string, unknown>, after: Record<string, unknown>) => void;
}

export type ToolResult = {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
  /**
   * Machine-readable detail alongside the prose, for a client that wants to act on a refusal rather than
   * show it. Optional in the MCP spec and unvalidated when a tool declares no `outputSchema`, so a client
   * that ignores it loses nothing — `content` remains the complete answer.
   *
   * **The opposite client is the one to design for, and that half was missing here.** A client may SURFACE
   * `structuredContent` in preference to `content`, and then whatever is not in this object does not exist.
   * `query` carried the paging facts alone on the reasoning above, and against such a client it answered
   * `{count: 25, total: 32, limit, skip}` with not one row — the answer absent while the metadata says how
   * many rows were returned, which reads as a thin page rather than a dropped payload. So: **if `content`
   * carries the ANSWER, `structuredContent` must carry it too.** It is the structured form of the same
   * result, never a sidecar to it.
   *
   * Added because a schema refusal distinguishes violations the write INTRODUCED from ones the record
   * already carried, and over MCP that distinction survived only as a sentence: the arrays were flattened
   * into the message text (the create paths appended `JSON.stringify`) or dropped entirely (the update
   * paths threw a plain `Error`, and the router turned it into one string). A caller could read it, but
   * only by parsing English or a JSON blob glued to the end of a message.
   *
   * **A spread is why several call sites read `{ ...result }` rather than `result`.** A value typed as a
   * declared interface has no index signature, so TypeScript refuses it here (`TS2322`); spreading it
   * into a fresh object literal is the assignment that compiles. It is not a defensive copy and removing
   * it does not simplify anything — it breaks the build.
   */
  structuredContent?: Record<string, unknown>;
};

/**
 * A single MCP tool: schema, authorization flags, and handler - all in one place.
 *
 * The dispatcher derives `tools/list` AND every gate from these flags, so each
 * tool has exactly one source of truth. Previously a tool was spread across three
 * separate `Set`s (MUTATING/ADMIN/SPACE_REQUIRED), a schema in a big array, and a
 * `case` in a 1,200-line switch - four places that had to be kept in sync by hand.
 */
export interface ToolHandler {
  name: string;
  description: string;
  /** Rejected for read-only tokens. */
  mutating?: boolean;
  /** Requires an admin token (instance-level, no space scoping). */
  admin?: boolean;
  /**
   * Requires administering THE SPACE this call names — or the instance.
   *
   * The MCP half of `requireAdminOrSpaceAdminMfaScoped`. `admin: true` asks an instance-level question and is
   * right for a tool with no space to scope to; this one is for a tool that configures ONE space, where
   * "administers that space" is the honest requirement and demanding the instance is simply the old flag
   * showing through.
   *
   * Checked twice, deliberately and at different widths — see `toolIsVisible` (coarse, per connection, before
   * any space is named) and `spaceAdminRefusal` (precise, per call). Setting this INSTEAD of `admin`, never
   * alongside it: two flags for one decision is how the weaker one ends up deciding.
   */
  spaceAdmin?: boolean;
  /** Requires a non-empty `space` argument. */
  spaceRequired?: boolean;
  /**
   * Accepts `space` as a LIST of names as well as one — the search family, since 5.0.
   *
   * OPT-IN PER TOOL, and refusing a list everywhere else is the point. Most tools act on exactly one space:
   * `save_fact` writes a record somewhere, `update_chrono` edits one. Handed a list, a dispatcher that
   * normalised centrally would pass them the first element, and the caller would be told their write
   * succeeded in the space they named second. A refusal that says the tool takes one space is the only
   * answer that cannot be mistaken for success.
   */
  spaceList?: boolean;
  /**
   * Destructive or expensive enough to be throttled — five calls a minute per token, both doors.
   *
   * Declared on the TOOL rather than mounted as middleware on a route, because middleware can only ever
   * guard one of the two doors: `bulkWipeRateLimit` protected the five REST wipe routes and nothing at all
   * on MCP, so the caller most likely to be looping was the one with no limit. `callTool` enforces it.
   */
  heavy?: boolean;
  /**
   * Skip the dispatcher's inputSchema arg-validation for this tool (it still appears in tools/list with
   * its full schema for discovery). For partial-success tools like `save_bulk`, whose contract is to
   * process the valid items and report per-item errors in the RESULT rather than reject the whole call —
   * enforcing the item schemas up front would wrongly abort the batch. Such tools validate each item in
   * their handler.
   */
  skipSchemaValidation?: boolean;
  inputSchema(s: ToolSchemas): Record<string, unknown>;
  handle(ctx: ToolContext): Promise<ToolResult>;
}
