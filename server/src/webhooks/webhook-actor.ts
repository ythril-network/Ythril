/**
 * Who caused a mutation, for webhook attribution: the one type every writer, door and tool context names (moved out of `dispatcher.ts`,
 * bundle-269 slice D).
 *
 * ## What it prevents
 *
 * The type lived in `webhooks/dispatcher.ts`, which sits in the server's largest import cycle, so every module that only NAMED the type
 * (the MCP tool context `mcp/tools/types.ts` first, and with it every tool module) was pulled into that cycle by a type alone. A leaf
 * holding nothing but the type keeps a module that names an actor out of the cycle; a module that emits still imports the dispatcher.
 *
 * Threaded from the request/MCP surface down into the shared writer functions, which own the emit: a shared mutating function emits when
 * (and only when) it is given an actor (`if (actor) emitWebhookEvent(...)`), so user-facing surfaces (REST, MCP) pass one and emit, while
 * internal callers (sync, import, bulk, a file's byte arrival) pass none and stay silent. That is ONE rule for the brain records and the
 * file family alike, and it governs both halves of `emitWebhookEvent`: no actor means no webhook delivery AND no live-view (SSE) event,
 * because the one function does both. An actor may carry no fields at all (`{}`, an unauthenticated session): it is still an actor, and
 * the act is still a user's. A leaf: it imports nothing.
 */
export interface WebhookActor {
  tokenId?: string;
  tokenLabel?: string;
}
